/**
 * Phase 6A Schema Migration
 *
 * Purpose: Add 'ad' to entity_type CHECK constraint in health_score_history.
 * Method: SQLite table-replace migration inside a transaction (atomic).
 *
 * Existing tables modified: health_score_history (CHECK constraint only)
 * New tables: NONE
 * Existing data: fully preserved via INSERT SELECT
 *
 * Idempotency: tracked via schema_migrations (see migrationTracker.js).
 * The previous approach probed idempotency by inserting a dummy row with
 * ad_account_id = '__probe__' — but ad_accounts.id is a foreign-key target
 * enforced via PRAGMA foreign_keys = ON, so that probe insert ALWAYS failed
 * (on the FK constraint, independent of whether the CHECK constraint was
 * already fixed). That made the migration re-run its destructive table
 * rebuild on every single boot, and made the post-migration verification
 * step crash the whole process on any database with zero ad_accounts rows
 * (since its verify-insert also violated the same FK constraint). Tracking
 * applied migrations in a real table removes both failure modes.
 */

const db = require('./database');
const { ensureMigrationsTable, isMigrationApplied, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase6a_health_score_history_entity_type_ad';

function runPhase6Migrations() {
  ensureMigrationsTable();

  if (isMigrationApplied(MIGRATION_NAME)) {
    console.log('[DB] Phase 6 schema: already applied, skipping.');
    return;
  }

  console.log('[DB] Running Phase 6A schema migration (health_score_history entity_type patch)...');

  // Wrap entirely in a transaction — atomic: either all succeeds or nothing changes
  const dbRaw = db.getDb();
  dbRaw.run('BEGIN TRANSACTION;');

  try {
    // Step 1: Create new table with corrected CHECK constraint
    dbRaw.run(`
      CREATE TABLE health_score_history_v6 (
        id                    TEXT PRIMARY KEY,
        ad_account_id         TEXT NOT NULL REFERENCES ad_accounts(id),
        entity_type           TEXT NOT NULL DEFAULT 'campaign'
                                CHECK(entity_type IN ('account','campaign','ad_set','ad')),
        entity_meta_id        TEXT NOT NULL,
        entity_label          TEXT NOT NULL,
        objective             TEXT,
        health_score          INTEGER NOT NULL,
        health_status         TEXT NOT NULL
                                CHECK(health_status IN ('excellent','good','warning','critical')),
        score_reference       TEXT NOT NULL DEFAULT 'platform_default'
                                CHECK(score_reference IN ('benchmark','platform_default')),
        benchmark_industry    TEXT,
        score_breakdown       TEXT,
        calculated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Step 2: Copy all existing rows (safe even if this table has never
    // existed before / is empty — INSERT...SELECT from an existing table
    // with zero rows is a no-op, not an error)
    dbRaw.run(`
      INSERT INTO health_score_history_v6
        (id, ad_account_id, entity_type, entity_meta_id, entity_label,
         objective, health_score, health_status, score_reference,
         benchmark_industry, score_breakdown, calculated_at)
      SELECT
        id, ad_account_id, entity_type, entity_meta_id, entity_label,
        objective, health_score, health_status, score_reference,
        benchmark_industry, score_breakdown, calculated_at
      FROM health_score_history
    `);

    // Step 3: Drop old table
    dbRaw.run('DROP TABLE health_score_history');

    // Step 4: Rename new table
    dbRaw.run('ALTER TABLE health_score_history_v6 RENAME TO health_score_history');

    // Step 5: Recreate index (was dropped with old table)
    dbRaw.run(`
      CREATE INDEX IF NOT EXISTS idx_health_score_history_entity
        ON health_score_history(ad_account_id, entity_meta_id, calculated_at)
    `);

    dbRaw.run('COMMIT;');
    markMigrationApplied(MIGRATION_NAME);
    db.persist();

    console.log('[DB] Phase 6A migration complete — entity_type now supports: account, campaign, ad_set, ad');
  } catch (err) {
    dbRaw.run('ROLLBACK;');
    console.error('[DB] Phase 6A migration FAILED — rolled back:', err.message);
    throw err;
  }
}

module.exports = { runPhase6Migrations };
