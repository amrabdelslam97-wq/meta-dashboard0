/**
 * Phase 35.8 — Temporary, single-purpose maintenance route.
 *
 * Permanently removes exactly three specific, pre-authorized accounts (and
 * their account-scoped data) from whichever database this deployment is
 * actually running against (Postgres on Vercel, via the existing
 * src/db/database.js driver abstraction -- this route never reads
 * DATABASE_URL itself, it only uses the already-initialized `db` module the
 * rest of the app already uses).
 *
 * Safety:
 *   - Reached only under /api/v1, already gated by requireAuth (app.js) --
 *     same session cookie as the rest of the dashboard.
 *   - meta_account_ids in the request body must be EXACTLY the three
 *     authorized targets (as a set) -- any other id, more ids, or fewer ids
 *     is rejected outright.
 *   - Defaults to dryRun (no writes) unless the caller explicitly passes
 *     `dryRun: false` AND the exact confirm token.
 *   - The real delete runs inside one db.transaction() -- protected-account
 *     rows are re-verified byte-for-byte INSIDE that same transaction before
 *     it commits; any unexpected change throws, which rolls back the entire
 *     transaction (nothing partial is ever left committed).
 *   - Account-scoped tables are discovered fresh from information_schema on
 *     every call, not hardcoded.
 *
 * DELETE THIS FILE (and its one-line mount in router.js) once Phase 35.8 is
 * verified complete on every target environment -- it is not meant to be
 * part of the shipped application.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { asyncHandler } = require('../../middleware/errorHandler');

const TARGET_META_IDS = ['act_665699145095366', 'act_297166953213478', 'act_111111111'];
const PROTECTED_META_IDS = [
  'act_890745576979474', 'act_1663612791680959', 'act_1628761418218807',
  'act_657222240097090', 'act_997599826172617', 'act_1952082009012642',
];
const CONFIRM_TOKEN = 'PHASE_35_8_PERMANENT_DELETE_CONFIRMED';

router.post('/phase35-8-cleanup', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(400).json({ error: 'This route only operates against a Postgres-backed deployment (DATABASE_URL not set here).' });
  }

  const { confirm, meta_account_ids, dryRun } = req.body || {};
  const isDryRun = dryRun !== false; // default: safe, no writes

  const requested = new Set(meta_account_ids || []);
  const expected = new Set(TARGET_META_IDS);
  const exactMatch = requested.size === expected.size && [...requested].every((id) => expected.has(id));
  if (!exactMatch) {
    return res.status(400).json({
      error: 'meta_account_ids must exactly equal the three pre-authorized targets, no more, no fewer',
      expected: TARGET_META_IDS,
    });
  }
  if (!isDryRun && confirm !== CONFIRM_TOKEN) {
    return res.status(400).json({ error: 'Executing (dryRun:false) requires the exact confirm token.' });
  }

  // Fresh schema discovery -- not reused from any earlier phase.
  const cols = await db.all(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name IN ('ad_account_id', 'account_id') AND table_name != 'ad_accounts'`
  );
  const scopedTables = cols.map((c) => ({ table: c.table_name, column: c.column_name }));

  const targetAccounts = await db.all(
    `SELECT * FROM ad_accounts WHERE meta_account_id = ANY(?)`,
    [TARGET_META_IDS]
  );

  for (const acc of targetAccounts) {
    if (!TARGET_META_IDS.includes(acc.meta_account_id)) {
      return res.status(500).json({ error: 'Identity verification failed -- aborting.', account: acc });
    }
  }

  if (targetAccounts.length === 0) {
    return res.json({ step: 'no_targets_found', message: 'None of the three target accounts exist in this database. Nothing to do.' });
  }

  const targetIds = targetAccounts.map((a) => a.id);

  const protectedBefore = await db.all(
    `SELECT * FROM ad_accounts WHERE meta_account_id = ANY(?)`,
    [PROTECTED_META_IDS]
  );

  const preCounts = {};
  for (const { table, column } of scopedTables) {
    const r = await db.get(`SELECT COUNT(*) as c FROM ${table} WHERE ${column} = ANY(?)`, [targetIds]);
    preCounts[table] = parseInt(r.c, 10) || 0;
  }

  // Full row backup -- returned in the response for the caller to persist
  // locally before trusting the delete. No filesystem persistence exists on
  // this deployment target, so the HTTP response IS the backup mechanism.
  const backup = { captured_at: new Date().toISOString(), ad_accounts: targetAccounts, children: {} };
  for (const { table, column } of scopedTables) {
    if (preCounts[table] > 0) {
      backup.children[table] = await db.all(`SELECT * FROM ${table} WHERE ${column} = ANY(?)`, [targetIds]);
    }
  }

  if (isDryRun) {
    return res.json({
      step: 'dry_run',
      database_env_present: true,
      target_accounts: targetAccounts,
      pre_delete_counts: preCounts,
      protected_accounts_found: protectedBefore.length,
      discovered_scoped_tables: scopedTables.map((t) => t.table),
      backup,
    });
  }

  const deletionCounts = {};
  await db.transaction(async (tx) => {
    for (const { table, column } of scopedTables) {
      if (preCounts[table] > 0) {
        await tx.run(`DELETE FROM ${table} WHERE ${column} = ANY(?)`, [targetIds]);
        deletionCounts[table] = preCounts[table];
      }
    }
    await tx.run(`DELETE FROM ad_accounts WHERE id = ANY(?)`, [targetIds]);
    deletionCounts.ad_accounts = targetIds.length;

    const protectedAfter = await tx.all(`SELECT * FROM ad_accounts WHERE meta_account_id = ANY(?)`, [PROTECTED_META_IDS]);
    for (const before of protectedBefore) {
      const after = protectedAfter.find((a) => a.id === before.id);
      if (!after) throw new Error(`Protected account ${before.meta_account_id} missing after delete -- rolling back.`);
      for (const k of Object.keys(before)) {
        if (String(before[k]) !== String(after[k])) {
          throw new Error(`Protected account ${before.meta_account_id} field "${k}" changed -- rolling back.`);
        }
      }
    }
  });

  const remaining = await db.all(`SELECT id FROM ad_accounts WHERE meta_account_id = ANY(?)`, [TARGET_META_IDS]);
  const protectedAfterCommit = await db.all(`SELECT * FROM ad_accounts WHERE meta_account_id = ANY(?)`, [PROTECTED_META_IDS]);

  const remainingChildRows = {};
  for (const { table, column } of scopedTables) {
    const r = await db.get(`SELECT COUNT(*) as c FROM ${table} WHERE ${column} = ANY(?)`, [targetIds]);
    const c = parseInt(r.c, 10) || 0;
    if (c > 0) remainingChildRows[table] = c;
  }

  return res.json({
    step: 'deleted',
    target_accounts_deleted: targetAccounts,
    deletion_counts: deletionCounts,
    remaining_target_accounts: remaining,
    remaining_target_child_rows: remainingChildRows,
    protected_accounts_after: protectedAfterCommit.length,
    backup,
  });
}));

module.exports = router;
