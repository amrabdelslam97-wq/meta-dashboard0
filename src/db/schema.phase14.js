/**
 * Phase 14 Schema Migration — Multi Account Management
 *
 * Purpose: extend `ad_accounts` with the fields the Accounts management
 * panel needs that no existing column covers -- business identity (business
 * name / notes), per-account sync tracking (status/timestamps/progress), and
 * per-account automatic sync configuration.
 *
 * Method: ALTER TABLE ADD COLUMN -- safe, additive, no data loss. Same
 * idempotent guard pattern as schema.phase7b.js (PRAGMA table_info check
 * before each ADD COLUMN, try/catch per column).
 *
 * Existing tables modified: ad_accounts (10 new nullable/defaulted columns)
 * New tables: NONE
 * Existing data: fully preserved -- new columns default to NULL/0, every
 * currently-connected account keeps working unchanged.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase14_multi_account_management';

const NEW_COLUMNS = [
  { name: 'business_name',              type: 'TEXT' },
  { name: 'notes',                       type: 'TEXT' },
  { name: 'last_sync_started_at',        type: 'TEXT' },
  { name: 'last_sync_completed_at',      type: 'TEXT' },
  { name: 'last_successful_sync_at',     type: 'TEXT' },
  { name: 'last_failed_sync_at',         type: 'TEXT' },
  { name: 'last_sync_status',            type: "TEXT DEFAULT 'idle'" },
  { name: 'last_sync_error',             type: 'TEXT' },
  { name: 'sync_progress_phase',         type: 'TEXT' },
  { name: 'auto_sync_enabled',           type: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'auto_sync_interval_minutes',  type: 'INTEGER NOT NULL DEFAULT 60' },
];

function runPhase14Migrations() {
  ensureMigrationsTable();
  const existingCols = db.all("PRAGMA table_info(ad_accounts)").map(c => c.name);

  let added = 0;
  for (const col of NEW_COLUMNS) {
    if (existingCols.includes(col.name)) continue; // idempotent guard
    try {
      db.run(`ALTER TABLE ad_accounts ADD COLUMN ${col.name} ${col.type}`);
      added++;
    } catch (err) {
      console.warn(`[DB] Phase 14: could not add column ${col.name}:`, err.message);
    }
  }

  markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    db.persist();
    console.log(`[DB] Phase 14 migration complete — added ${added} column(s) to ad_accounts.`);
  } else {
    console.log('[DB] Phase 14 schema: multi-account columns already present, skipping.');
  }
}

module.exports = { runPhase14Migrations };
