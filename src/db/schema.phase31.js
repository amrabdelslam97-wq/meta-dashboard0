/**
 * Phase 31 Schema Migration — Enterprise Smart Sync Optimization
 *
 * Purpose: give the rate-limit backoff strategy a durable home. Before this,
 * autoSyncScheduler.js tracked "which account is cooling down until when"
 * purely in an in-memory Map (cooldownUntil/cooldownFailCount) -- lost on
 * every process restart, so a Railway redeploy (or crash) immediately forgot
 * that an account had just been throttled and would hammer it again on the
 * very next tick. These three columns move that state onto ad_accounts
 * itself so it survives restarts:
 *
 *   rate_limit_backoff_until — ISO timestamp; this account must not be
 *     auto-synced again before this time ("next_allowed_sync").
 *   rate_limit_fail_count    — consecutive rate-limit hits, drives the
 *     exponential backoff growth (same formula as before: 1m,2m,4m,...
 *     capped at 60m), reset to 0 on the next successful sync.
 *   last_full_sync_at        — when this account's data was last reloaded
 *     via explicit Full Sync/Full Rebuild (as opposed to the routine
 *     active-only incremental sync) -- lets the dashboard show "last full
 *     rebuild" distinctly from "last sync".
 *
 * Method: ALTER TABLE ADD COLUMN, idempotent via PRAGMA table_info check --
 * same pattern as schema.phase14.js/17.js/18.js.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase31_enterprise_smart_sync';

function runPhase31Migrations() {
  ensureMigrationsTable();
  const existingCols = db.all("PRAGMA table_info(ad_accounts)").map(c => c.name);

  const columns = [
    ['rate_limit_backoff_until', 'TEXT'],
    ['rate_limit_fail_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_full_sync_at', 'TEXT'],
  ];

  let added = 0;
  for (const [name, ddl] of columns) {
    if (!existingCols.includes(name)) {
      try {
        db.run(`ALTER TABLE ad_accounts ADD COLUMN ${name} ${ddl}`);
        added++;
      } catch (err) {
        console.warn(`[DB] Phase 31: could not add ${name} column:`, err.message);
      }
    }
  }

  markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    db.persist();
    console.log(`[DB] Phase 31 migration complete — ${added} column(s) added to ad_accounts.`);
  } else {
    console.log('[DB] Phase 31 schema: already present, skipping.');
  }
}

module.exports = { runPhase31Migrations };
