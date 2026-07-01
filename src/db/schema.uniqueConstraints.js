/**
 * Unique Constraints Migration
 *
 * Adds DB-level uniqueness that was previously only enforced (partially,
 * non-atomically) at the application layer:
 *
 *  - benchmark_metrics: the app already does a SELECT-then-INSERT/UPDATE
 *    "upsert" in POST /settings/benchmarks to avoid duplicate
 *    (objective, metric_key, ad_account_id, industry_id) combos, but
 *    nothing in the schema actually prevented a duplicate row from being
 *    created another way, and the check-then-write pattern isn't atomic.
 *
 *  - account_targets: no constraint prevented two rows for the same
 *    (ad_account_id, objective, effective_from).
 *
 * Note: SQLite treats NULL as distinct from every other NULL in a UNIQUE
 * index by default, which would silently fail to catch duplicates in
 * exactly the most common case here -- global benchmarks/targets with
 * ad_account_id/industry_id left NULL. COALESCE(...,'') normalizes NULL to
 * a real sentinel value for uniqueness comparison (safe since no real id
 * in this schema is ever an empty string).
 */

const db = require('./database');
const { ensureMigrationsTable, isMigrationApplied, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'unique_constraints_benchmark_metrics_account_targets';

function runUniqueConstraintsMigration() {
  ensureMigrationsTable();
  if (isMigrationApplied(MIGRATION_NAME)) {
    console.log('[DB] Unique constraints migration: already applied, skipping.');
    return;
  }

  console.log('[DB] Running unique constraints migration...');

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_metrics_unique
      ON benchmark_metrics(objective, metric_key, COALESCE(ad_account_id, ''), COALESCE(industry_id, ''))
  `);

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_targets_unique
      ON account_targets(ad_account_id, objective, effective_from)
  `);

  markMigrationApplied(MIGRATION_NAME);
  db.persist();
  console.log('[DB] Unique constraints migration complete.');
}

module.exports = { runUniqueConstraintsMigration };
