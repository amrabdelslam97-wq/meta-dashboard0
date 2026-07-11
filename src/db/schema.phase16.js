/**
 * Phase 16 Schema Migration — Smart Auto Sync System
 *
 * Purpose: give the scheduler durable, per-account/per-entity-type freshness
 * tracking and a configurable cadence, on top of the account-level sync
 * columns Phase 14 already added (last_sync_status/last_sync_completed_at/
 * auto_sync_enabled/auto_sync_interval_minutes on ad_accounts, still owned
 * exclusively by syncService.syncAccount() -- untouched).
 *
 * New tables:
 *   sync_schedule_config — one row per entity type, holds the configurable
 *     interval (minutes) used to decide when that entity type is next due.
 *     Seeded with the spec's defaults on first migration.
 *   sync_entity_state — one row per (ad_account_id, entity_type), the
 *     durable checkpoint the scheduler reads on every tick (and after a
 *     restart) to know what's already fresh vs. overdue. This is what makes
 *     "resume from last checkpoint, don't start from zero" work for free --
 *     no separate resume/journal mechanism needed.
 *   sync_execution_log — append-only history of every sync attempt (scheduler
 *     or Force Sync) for the Logging requirement.
 *
 * Method: idempotent CREATE TABLE IF NOT EXISTS, guarded by the shared
 * migrationTracker, same pattern as every other phaseN schema file.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied, isMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase16_smart_auto_sync';

// Spec defaults — also the fallback smartSyncEngine uses in-memory if a row
// is ever missing, so these are never load-bearing on their own.
const DEFAULT_INTERVALS = {
  insights:  15,
  campaigns: 60,
  adsets:    60,
  ads:       60,
  creatives: 24 * 60,
  metadata:  24 * 60,
};

function runPhase16Migrations() {
  ensureMigrationsTable();

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_schedule_config (
      entity_type      TEXT PRIMARY KEY,
      interval_minutes INTEGER NOT NULL,
      updated_at       TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_entity_state (
      id                     TEXT PRIMARY KEY,
      ad_account_id          TEXT NOT NULL,
      entity_type            TEXT NOT NULL,
      last_sync_started_at   TEXT,
      last_sync_completed_at TEXT,
      last_success_at        TEXT,
      last_failed_at         TEXT,
      last_error             TEXT,
      sync_source            TEXT,
      duration_ms            INTEGER,
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      UNIQUE(ad_account_id, entity_type)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_execution_log (
      id               TEXT PRIMARY KEY,
      ad_account_id    TEXT NOT NULL,
      entity_type      TEXT NOT NULL,
      source           TEXT NOT NULL,
      started_at       TEXT NOT NULL,
      finished_at      TEXT,
      duration_ms      INTEGER,
      records_created  INTEGER NOT NULL DEFAULT 0,
      records_updated  INTEGER NOT NULL DEFAULT 0,
      records_failed   INTEGER NOT NULL DEFAULT 0,
      api_calls        INTEGER NOT NULL DEFAULT 0,
      retries          INTEGER NOT NULL DEFAULT 0,
      rate_limited     INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL,
      error_message    TEXT
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_execution_log_account ON sync_execution_log(ad_account_id, started_at)`);

  if (!isMigrationApplied(MIGRATION_NAME)) {
    const now = new Date().toISOString();
    for (const [entityType, minutes] of Object.entries(DEFAULT_INTERVALS)) {
      db.run(
        `INSERT OR IGNORE INTO sync_schedule_config (entity_type, interval_minutes, updated_at) VALUES (?, ?, ?)`,
        [entityType, minutes, now]
      );
    }
    markMigrationApplied(MIGRATION_NAME);
    db.persist();
    console.log('[DB] Phase 16 migration complete — smart auto sync tables created and seeded.');
  } else {
    console.log('[DB] Phase 16 schema: smart auto sync tables already present, skipping seed.');
  }
}

module.exports = { runPhase16Migrations, DEFAULT_INTERVALS };
