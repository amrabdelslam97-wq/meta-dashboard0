/**
 * Migration Tracker — Robust Migration Registry
 *
 * Handles all phase migrations from Phase 1 through latest.
 * Automatically creates the migration registry on first startup.
 * All migrations are idempotent and never fail startup.
 *
 * Architecture:
 * - Single schema_migrations table stores applied migration names
 * - Created automatically if missing (handles legacy databases)
 * - Every migration phase calls ensureMigrationsTable() first
 * - isMigrationApplied() checks before running migration
 * - markMigrationApplied() records after successful execution
 * - Never crashes on missing table - creates it immediately
 */

const db = require('./database');

/**
 * Ensure the migration registry table exists.
 * This is called by EVERY migration before attempting to run.
 * Creates the table if it doesn't exist (idempotent).
 * Always succeeds - never throws, logs errors only.
 */
function ensureMigrationsTable() {
  try {
    // Create the migration registry table if it doesn't exist
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    return true;
  } catch (e) {
    // Log error but don't throw - let the migration handle it
    console.warn(`[Migration] Warning creating schema_migrations: ${e.message}`);
    return false;
  }
}

/**
 * Check if a migration has already been applied.
 * Uses the migration registry table.
 * Safe to call even if table is missing (returns false).
 */
function isMigrationApplied(name) {
  try {
    // First ensure table exists
    ensureMigrationsTable();

    // Then check if migration is applied
    const row = db.get(
      'SELECT name FROM schema_migrations WHERE name = ?',
      [name]
    );

    return !!row;
  } catch (e) {
    console.warn(`[Migration] Warning checking if ${name} applied: ${e.message}`);
    // If we can't check, assume it hasn't been applied (safer)
    return false;
  }
}

/**
 * Mark a migration as applied.
 * Records the migration name and timestamp in the registry.
 * Safe to call multiple times (INSERT OR IGNORE).
 */
function markMigrationApplied(name) {
  try {
    // First ensure table exists
    ensureMigrationsTable();

    // Then record the migration
    db.run(
      'INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)',
      [name, new Date().toISOString()]
    );

    return true;
  } catch (e) {
    console.warn(`[Migration] Warning marking ${name} applied: ${e.message}`);
    return false;
  }
}

/**
 * Get list of all applied migrations.
 * Useful for debugging and verification.
 */
function getAppliedMigrations() {
  try {
    ensureMigrationsTable();

    return db.all(
      'SELECT name, applied_at FROM schema_migrations ORDER BY applied_at ASC'
    );
  } catch (e) {
    console.warn(`[Migration] Warning getting applied migrations: ${e.message}`);
    return [];
  }
}

/**
 * Clear all migration records.
 * ONLY for testing - never use in production.
 */
function clearMigrationRegistry() {
  try {
    db.run('DELETE FROM schema_migrations');
    return true;
  } catch (e) {
    console.warn(`[Migration] Warning clearing registry: ${e.message}`);
    return false;
  }
}

module.exports = {
  ensureMigrationsTable,
  isMigrationApplied,
  markMigrationApplied,
  getAppliedMigrations,
  clearMigrationRegistry,
};
