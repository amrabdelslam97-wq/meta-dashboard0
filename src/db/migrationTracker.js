/**
 * Migration Tracker
 *
 * Single source of truth for "has migration X already been applied?".
 * Replaces per-migration ad hoc idempotency checks (e.g. Phase 6's old
 * probe-INSERT approach, which always failed on the ad_account_id foreign
 * key regardless of whether the migration had already run, causing it to
 * both re-run destructively on every boot and crash outright on a fresh
 * database with zero ad_accounts rows).
 *
 * Every phase migration should call ensureMigrationsTable() first, then
 * guard its body with isMigrationApplied()/markMigrationApplied().
 */

const db = require('./database');

function ensureMigrationsTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function isMigrationApplied(name) {
  const row = db.get('SELECT name FROM schema_migrations WHERE name = ?', [name]);
  return !!row;
}

function markMigrationApplied(name) {
  db.run(
    'INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    [name, new Date().toISOString()]
  );
}

module.exports = { ensureMigrationsTable, isMigrationApplied, markMigrationApplied };
