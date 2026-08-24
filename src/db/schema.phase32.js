/**
 * Phase 32 Schema Migration — Bounded/Resumable Initial Sync
 *
 * Purpose: give the sync engine durable state for two things the AP-POS Sync
 * Architecture Audit found missing (see SYNC_ARCHITECTURE_AUDIT_REPORT.md):
 *
 *   initial_sync_completed_at — NULL until this account's first FULL
 *     (non-active-only) campaign/ad-set/ad hierarchy sweep has completed end
 *     to end. While NULL, the automatic triggers (autoSyncScheduler.js's
 *     'scheduler' source and cron.js's 'cron' source) run a full sweep
 *     instead of their normal active-only incremental one — see
 *     smartSyncEngine.runDueForAccount()'s activeOnly derivation. Once set,
 *     those two triggers stay active-only forever after, exactly like they
 *     already did for every trigger before this migration. Manual triggers
 *     ('force', 'force_active') are unaffected by this column either way —
 *     see SYNC_BEHAVIOR_SPECIFICATION.md.
 *
 *   sync_batch_cursor — the meta_campaign_id of the last campaign fully
 *     fetched-and-written during an in-progress FULL sweep (activeOnly ===
 *     false only -- see syncService.syncAccount()). NULL when no full sweep
 *     is currently in progress (either none has started, or the last one
 *     ran to completion). A non-NULL cursor is what lets the next
 *     syncAccount() call for this account resume from where the previous
 *     invocation left off instead of restarting the whole sweep from
 *     campaign #1 -- required because a single invocation is now
 *     time/count-bounded (SYNC_CAMPAIGN_BATCH_SIZE / SYNC_TIME_BUDGET_MS)
 *     rather than attempting the entire due-campaign list in one pass, which
 *     could never finish within Vercel's 60s function ceiling for a
 *     large/growing account (see SYNC_REQUEST_BUDGET.md).
 *
 * Method: ALTER TABLE ADD COLUMN, idempotent via PRAGMA table_info check --
 * same pattern as schema.phase14.js/17.js/18.js/31.js.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase32_bounded_resumable_initial_sync';

async function runPhase32Migrations() {
  await ensureMigrationsTable();
  const existingCols = (await db.all("PRAGMA table_info(ad_accounts)")).map(c => c.name);

  const columns = [
    ['initial_sync_completed_at', 'TEXT'],
    ['sync_batch_cursor', 'TEXT'],
  ];

  let added = 0;
  for (const [name, ddl] of columns) {
    if (!existingCols.includes(name)) {
      try {
        await db.run(`ALTER TABLE ad_accounts ADD COLUMN ${name} ${ddl}`);
        added++;
      } catch (err) {
        console.warn(`[DB] Phase 32: could not add ${name} column:`, err.message);
      }
    }
  }

  await markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    await db.persist();
    console.log(`[DB] Phase 32 migration complete — ${added} column(s) added to ad_accounts.`);
  } else {
    console.log('[DB] Phase 32 schema: already present, skipping.');
  }
}

module.exports = { runPhase32Migrations };
