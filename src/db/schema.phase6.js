/**
 * Phase 6A Schema Migration
 *
 * Purpose: Add 'ad' to entity_type CHECK constraint in health_score_history.
 * Method: table-replace migration inside a transaction (atomic).
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
 *
 * Driver-agnostic (Wave 7 Blocker 2): previously used db.getDb()'s raw
 * handle to manually sequence BEGIN/CREATE/COPY/DROP/RENAME/COMMIT/ROLLBACK
 * itself. That bypassed db.transaction() and relied on a single persistent
 * connection/session, which the PostgreSQL driver's getDb() shim does not
 * provide (each raw call there is an independent pool.query(), not bound to
 * one session — see VERCEL_WAVE7_DBRAW_AUDIT.md §3b). No dbRaw/getDb() usage
 * remains in this file.
 *
 * Two driver-specific paths, selected on the same process.env.DATABASE_URL
 * signal database.js's own driver selector uses (not a new signal):
 *
 *   - SQLite (no DATABASE_URL): unchanged table-replace logic (SQLite has no
 *     ALTER TABLE ... DROP/ADD CONSTRAINT support at all, which is the whole
 *     reason this migration ever needed a rebuild), now run inside
 *     db.transaction() instead of a raw dbRaw BEGIN/COMMIT/ROLLBACK sequence.
 *   - PostgreSQL (DATABASE_URL set): PostgreSQL DOES support
 *     ALTER TABLE ... DROP/ADD CONSTRAINT directly, and health_score_history
 *     is not referenced by any other table's foreign key (confirmed: no
 *     `REFERENCES health_score_history` anywhere in src/db/schema*.js) — so
 *     under Postgres this migration needs no table rebuild, no rename, and
 *     no cross-table FK handling at all. This is the real PostgreSQL-native
 *     equivalent of the SQLite rebuild, not a shortcut: the end schema state
 *     (same CHECK constraint values, same data, same index) is identical.
 */

const db = require('./database');
const { ensureMigrationsTable, isMigrationApplied, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase6a_health_score_history_entity_type_ad';

async function runPhase6MigrationsPostgres() {
  await db.transaction(async (tx) => {
    // Postgres's default auto-generated name for an unnamed inline CHECK on
    // column `entity_type` of table `health_score_history` is
    // `health_score_history_entity_type_check` (Postgres's documented
    // `<table>_<column>_check` convention) -- the exact constraint the
    // original CREATE TABLE IF NOT EXISTS text (schema.phase2.js, run
    // verbatim against Postgres via translateSql()) would have created.
    // IF EXISTS makes the drop itself idempotent/safe even if that
    // assumption is ever wrong -- the subsequent ADD CONSTRAINT would then
    // fail loudly with a clear Postgres error rather than silently
    // leaving the old, narrower CHECK in place.
    await tx.run(`ALTER TABLE health_score_history DROP CONSTRAINT IF EXISTS health_score_history_entity_type_check`);
    await tx.run(`ALTER TABLE health_score_history ADD CONSTRAINT health_score_history_entity_type_check CHECK (entity_type IN ('account','campaign','ad_set','ad'))`);
  });
}

async function runPhase6MigrationsSqlite() {
  // db.transaction() wraps this callback in a real BEGIN/COMMIT, rolling
  // back automatically on any thrown error — same atomicity guarantee the
  // old manual dbRaw BEGIN/COMMIT/ROLLBACK sequence intended, now backed by
  // db.transaction()'s driver-correct implementation.
  await db.transaction(async (tx) => {
    // Step 1: Create new table with corrected CHECK constraint
    await tx.run(`
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
    await tx.run(`
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
    await tx.run('DROP TABLE health_score_history');

    // Step 4: Rename new table
    await tx.run('ALTER TABLE health_score_history_v6 RENAME TO health_score_history');

    // Step 5: Recreate index (was dropped with old table)
    await tx.run(`
      CREATE INDEX IF NOT EXISTS idx_health_score_history_entity
        ON health_score_history(ad_account_id, entity_meta_id, calculated_at)
    `);
  });
}

async function runPhase6Migrations() {
  await ensureMigrationsTable();

  if (await isMigrationApplied(MIGRATION_NAME)) {
    console.log('[DB] Phase 6 schema: already applied, skipping.');
    return;
  }

  console.log('[DB] Running Phase 6A schema migration (health_score_history entity_type patch)...');

  try {
    if (process.env.DATABASE_URL) {
      await runPhase6MigrationsPostgres();
    } else {
      await runPhase6MigrationsSqlite();
    }
  } catch (err) {
    console.error('[DB] Phase 6A migration FAILED — rolled back:', err.message);
    throw err;
  }

  await markMigrationApplied(MIGRATION_NAME);
  await db.persist();

  console.log('[DB] Phase 6A migration complete — entity_type now supports: account, campaign, ad_set, ad');
}

module.exports = { runPhase6Migrations };
