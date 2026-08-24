/**
 * Phase 34 Schema Migration — Durable Sync Execution Observability
 *
 * Purpose: prior sync progress (Phase 2/33) only became visible through
 * console.log and a handful of ad_accounts columns written AFTER whole
 * phases of work completed. A hard Vercel platform timeout (SIGKILL-style,
 * see FORCE_SYNC live-verification missions) can terminate the process
 * before any of that ever gets written or before buffered stdout is
 * flushed to the log store -- leaving a run's actual progress completely
 * unknowable from outside. sync_live_executions/sync_live_events exist so
 * every meaningful step is committed to the database the instant it
 * happens, not batched up for a final write that a hard kill can erase.
 *
 * sync_live_executions -- one row per runDueForAccount() invocation
 *   (created immediately, before decryptToken() or any tier runs), updated
 *   in place as the run progresses.
 * sync_live_events -- append-only fine-grained timeline (one row per
 *   lifecycle event: TOKEN_DECRYPT_SUCCESS, META_REQUEST_START,
 *   META_RESPONSE, BATCH_START, DB_WRITE, etc), safe metadata only, never
 *   secrets.
 *
 * Method: idempotent CREATE TABLE IF NOT EXISTS, guarded by the shared
 * migrationTracker, same pattern as every other phaseN schema file.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied, isMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase34_sync_live_execution_observability';

async function runPhase34Migrations() {
  await ensureMigrationsTable();

  await db.run(`
    CREATE TABLE IF NOT EXISTS sync_live_executions (
      id                            TEXT PRIMARY KEY,
      ad_account_id                 TEXT NOT NULL,
      source                        TEXT NOT NULL,
      status                        TEXT NOT NULL DEFAULT 'queued',
      current_stage                 TEXT,
      current_operation             TEXT,
      campaigns_discovered          INTEGER NOT NULL DEFAULT 0,
      campaigns_processed           INTEGER NOT NULL DEFAULT 0,
      ad_sets_processed             INTEGER NOT NULL DEFAULT 0,
      ads_processed                 INTEGER NOT NULL DEFAULT 0,
      pages_fetched                 INTEGER NOT NULL DEFAULT 0,
      batches_completed             INTEGER NOT NULL DEFAULT 0,
      meta_requests_started         INTEGER NOT NULL DEFAULT 0,
      meta_requests_completed       INTEGER NOT NULL DEFAULT 0,
      last_meta_request_at          TEXT,
      last_successful_meta_request_at TEXT,
      last_db_write_at              TEXT,
      cursor_before                 TEXT,
      cursor_after                  TEXT,
      partial_reason                TEXT,
      error_code                    TEXT,
      error_message                 TEXT,
      started_at                    TEXT NOT NULL,
      updated_at                    TEXT NOT NULL,
      finished_at                   TEXT
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_sync_live_executions_account ON sync_live_executions(ad_account_id, started_at)`);

  await db.run(`
    CREATE TABLE IF NOT EXISTS sync_live_events (
      id            TEXT PRIMARY KEY,
      execution_id  TEXT NOT NULL,
      ts            TEXT NOT NULL,
      stage         TEXT NOT NULL,
      message       TEXT,
      metadata      TEXT
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_sync_live_events_execution ON sync_live_events(execution_id, ts)`);

  if (!await isMigrationApplied(MIGRATION_NAME)) {
    await markMigrationApplied(MIGRATION_NAME);
    await db.persist();
    console.log('[DB] Phase 34 migration complete — sync_live_executions/sync_live_events created.');
  } else {
    console.log('[DB] Phase 34 schema: already present, skipping.');
  }
}

module.exports = { runPhase34Migrations };
