/**
 * Phase 6A Schema Migration
 *
 * Purpose: Add 'ad' to entity_type CHECK constraint in health_score_history.
 * Method: SQLite table-replace migration inside a transaction (atomic).
 *
 * Existing tables modified: health_score_history (CHECK constraint only)
 * New tables: NONE
 * Existing data: fully preserved via INSERT SELECT
 */

const db = require('./database');

function runPhase6Migrations() {
  // Check if 'ad' is already accepted — idempotent guard
  try {
    db.run(`
      INSERT INTO health_score_history
        (id, ad_account_id, entity_type, entity_meta_id, entity_label,
         health_score, health_status, score_reference, calculated_at)
      VALUES
        ('__phase6_probe__','__probe__','ad','__probe__','__probe__',
         50,'good','platform_default',datetime('now'))
    `);
    // If we get here, 'ad' already works — clean up probe and skip migration
    db.run("DELETE FROM health_score_history WHERE id = '__phase6_probe__'");
    console.log('[DB] Phase 6 schema: entity_type=ad already supported, skipping migration.');
    return;
  } catch {
    // Expected on first run — proceed with migration
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

    // Step 2: Copy all existing rows
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
    db.persist();

    console.log('[DB] Phase 6A migration complete — entity_type now supports: account, campaign, ad_set, ad');

    // Verify: confirm 'ad' now works
    db.run(`
      INSERT INTO health_score_history
        (id, ad_account_id, entity_type, entity_meta_id, entity_label,
         health_score, health_status, score_reference, calculated_at)
      VALUES
        ('__phase6_verify__','${getFirstAccountId()}','ad','__verify__','Verify',
         50,'good','platform_default',datetime('now'))
    `);
    db.run("DELETE FROM health_score_history WHERE id = '__phase6_verify__'");
    console.log('[DB] Phase 6A verification passed.');

  } catch (err) {
    dbRaw.run('ROLLBACK;');
    console.error('[DB] Phase 6A migration FAILED — rolled back:', err.message);
    throw err;
  }
}

function getFirstAccountId() {
  try {
    const row = db.get('SELECT id FROM ad_accounts LIMIT 1');
    return row ? row.id : '__noaccount__';
  } catch {
    return '__noaccount__';
  }
}

module.exports = { runPhase6Migrations };
