/**
 * Phase 33 Schema Migration — Sync Execution Observability
 *
 * Purpose: give `syncService.syncAccount()` a way to durably record WHY an
 * invocation finished as `last_sync_status = 'partial'` (a new valid value
 * added alongside the existing 'running'/'success'/'failed') instead of
 * only ever collapsing that outcome into 'success' or 'failed' — the exact
 * gap that made a real 60-second Vercel timeout (PHASE_2_SYNC_EXECUTION_
 * OBSERVABILITY_REPORT.md) indistinguishable from any other outcome once
 * the process was killed and the dashboard was left showing stale/
 * misleading state on the next load.
 *
 *   last_sync_partial_reason — nullable TEXT, one of 'timed_out' |
 *     'rate_limited' | 'batch_limit' (see syncService.js's `partialReason`
 *     derivation), or NULL whenever last_sync_status isn't 'partial'.
 *     Purely observational (API responses, dashboard, sync history) — the
 *     actual resume mechanism is still ad_accounts.sync_batch_cursor
 *     (schema.phase32.js), unchanged by this column's presence or absence.
 *
 * Method: ALTER TABLE ADD COLUMN, idempotent via PRAGMA table_info check --
 * same pattern as schema.phase31.js/32.js.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase33_sync_execution_observability';

async function runPhase33Migrations() {
  await ensureMigrationsTable();
  const existingCols = (await db.all("PRAGMA table_info(ad_accounts)")).map(c => c.name);

  let added = 0;
  if (!existingCols.includes('last_sync_partial_reason')) {
    try {
      await db.run(`ALTER TABLE ad_accounts ADD COLUMN last_sync_partial_reason TEXT`);
      added++;
    } catch (err) {
      console.warn('[DB] Phase 33: could not add last_sync_partial_reason column:', err.message);
    }
  }

  await markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    await db.persist();
    console.log(`[DB] Phase 33 migration complete — ${added} column(s) added to ad_accounts.`);
  } else {
    console.log('[DB] Phase 33 schema: already present, skipping.');
  }
}

module.exports = { runPhase33Migrations };
