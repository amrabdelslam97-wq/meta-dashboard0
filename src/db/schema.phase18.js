/**
 * Phase 18 Schema Migration — Auto Sync Enabled By Default
 *
 * Purpose: a newly connected Meta Ad Account should be managed by the Smart
 * Scheduler immediately (auto_sync_enabled=1), not require the user to
 * manually opt in every time (see accounts.js POST /). This migration adds
 * the one new column that makes that safe: `auto_sync_user_configured_at`
 * records the moment (if ever) a user explicitly changed auto_sync_enabled
 * via PATCH /accounts/:id -- so a future default-enabling pass (or this one)
 * can always tell "never configured" apart from "user deliberately chose
 * this" and never override the latter.
 *
 * One-time data pass (defensive, not a behavior change for real rows):
 * `auto_sync_enabled` has been `NOT NULL DEFAULT 0` since schema.phase14.js,
 * so no existing row can actually be NULL today -- but per the spec ("if an
 * account has auto_sync_enabled IS NULL ... initialize using default
 * behavior"), the pass below still runs literally, as a safety net for any
 * row that somehow does have a NULL value (e.g. a hand-edited DB), without
 * ever touching a row that already holds a real 0/1. It never flips an
 * existing account's current value from 0 to 1 -- pre-existing accounts keep
 * exactly whatever auto_sync_enabled they already had (Task 2: don't
 * override existing user choice, and we have no reliable way to tell
 * "never configured" apart from "user deliberately turned it off" for data
 * that predates auto_sync_user_configured_at existing at all). Only
 * genuinely new accounts (created after this ships, via POST /accounts)
 * get the new "on by default" behavior.
 *
 * Method: ALTER TABLE ADD COLUMN -- safe, additive, no data loss. Same
 * idempotent guard pattern as schema.phase14.js/15.js/16.js/17.js.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase18_auto_sync_default_enabled';

function runPhase18Migrations() {
  ensureMigrationsTable();
  const existingCols = db.all("PRAGMA table_info(ad_accounts)").map(c => c.name);

  let added = 0;
  if (!existingCols.includes('auto_sync_user_configured_at')) {
    try {
      db.run(`ALTER TABLE ad_accounts ADD COLUMN auto_sync_user_configured_at TEXT`);
      added++;
    } catch (err) {
      console.warn('[DB] Phase 18: could not add auto_sync_user_configured_at column:', err.message);
    }
  }

  // Task 3 — one-time defensive initialization, literal to the spec: only
  // touches rows genuinely NULL, never a row that already holds 0 or 1.
  // db.run() (database.js) returns no row-count, so count first.
  const nullCount = db.get(
    `SELECT COUNT(*) as c FROM ad_accounts WHERE auto_sync_enabled IS NULL`
  )?.c || 0;
  if (nullCount > 0) {
    db.run(`UPDATE ad_accounts SET auto_sync_enabled = 1 WHERE auto_sync_enabled IS NULL`);
  }

  markMigrationApplied(MIGRATION_NAME);

  if (added > 0 || nullCount > 0) {
    db.persist();
    console.log(`[DB] Phase 18 migration complete — column added: ${added > 0}, NULL auto_sync_enabled rows initialized: ${nullCount}.`);
  } else {
    console.log('[DB] Phase 18 schema: already present / nothing to initialize, skipping.');
  }
}

module.exports = { runPhase18Migrations };
