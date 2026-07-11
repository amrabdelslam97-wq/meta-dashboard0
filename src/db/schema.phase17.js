/**
 * Phase 17 Schema Migration — Lifecycle Effective-Status Backfill Tracking
 *
 * Purpose: one new column so the one-time effective_status backfill
 * (smartSyncEngine.js) can mark an account "done" and never re-check it
 * again, instead of re-querying for NULL effective_status rows on every
 * sync cycle forever.
 *
 * Method: ALTER TABLE ADD COLUMN -- safe, additive, no data loss. Same
 * idempotent guard pattern as schema.phase14.js/phase15.js/phase16.js.
 *
 * Existing tables modified: ad_accounts (1 new nullable column)
 * New tables: NONE
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase17_lifecycle_backfill_tracking';

function runPhase17Migrations() {
  ensureMigrationsTable();
  const existingCols = db.all("PRAGMA table_info(ad_accounts)").map(c => c.name);

  let added = 0;
  if (!existingCols.includes('lifecycle_backfill_completed_at')) {
    try {
      db.run(`ALTER TABLE ad_accounts ADD COLUMN lifecycle_backfill_completed_at TEXT`);
      added++;
    } catch (err) {
      console.warn('[DB] Phase 17: could not add lifecycle_backfill_completed_at column:', err.message);
    }
  }

  markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    db.persist();
    console.log('[DB] Phase 17 migration complete — added lifecycle_backfill_completed_at to ad_accounts.');
  } else {
    console.log('[DB] Phase 17 schema: lifecycle_backfill_completed_at already present, skipping.');
  }
}

module.exports = { runPhase17Migrations };
