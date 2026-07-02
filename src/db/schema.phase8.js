/**
 * Phase 8 Schema Migration
 *
 * Purpose: widen the `campaigns.objective` CHECK constraint from the old
 * 5-value taxonomy (messaging,leads,sales,traffic,awareness,unknown) to
 * Meta's real 6-objective taxonomy (awareness,traffic,engagement,leads,
 * app_promotion,sales,unknown) -- 'messaging' is renamed to 'engagement'
 * (Meta's OUTCOME_ENGAGEMENT/MESSAGES objectives), and 'app_promotion' is
 * split out of the old catch-all 'unknown' bucket (Meta's
 * OUTCOME_APP_PROMOTION/APP_INSTALLS objectives). See
 * src/services/objectiveMapper.js for the corresponding raw-Meta-string
 * mapping fix, applied in lockstep with this migration.
 *
 * Also adds `ad_sets.optimization_goal` (nullable, no CHECK -- Meta's
 * optimization_goal list is large and account-specific, and a sync must
 * never fail because Meta adds a new goal string). This powers the
 * "Video Views" KPI sub-profile (detected via an ad set's optimization_goal
 * within an Awareness campaign) and the Optimization Goal filter.
 *
 * Method: SQLite table-replace migration inside a transaction (atomic),
 * following the exact same pattern already used and proven in
 * schema.phase6.js for widening a different table's CHECK constraint.
 *
 * Difference from phase6: `campaigns` IS an active foreign-key target
 * (ad_sets.campaign_id, ads.campaign_id both REFERENCE campaigns(id)),
 * unlike health_score_history in phase6 which had no FK dependents. SQLite's
 * documented safe procedure for rebuilding an FK-referenced parent table
 * requires PRAGMA foreign_keys=OFF *before* the transaction begins (it
 * cannot be toggled mid-transaction) and back ON after commit, followed by
 * PRAGMA foreign_key_check to confirm no dangling references were
 * introduced by the rebuild.
 *
 * Existing data: fully preserved via INSERT...SELECT, with any existing
 * `objective='messaging'` rows remapped to 'engagement' in the same
 * statement -- required, not optional, since the new CHECK constraint on
 * campaigns_v8 would reject a bare 'messaging' insert.
 *
 * Idempotency: tracked via schema_migrations (see migrationTracker.js).
 */

const db = require('./database');
const { ensureMigrationsTable, isMigrationApplied, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase8_campaigns_objective_enum_widen';

function runPhase8Migrations() {
  ensureMigrationsTable();

  if (isMigrationApplied(MIGRATION_NAME)) {
    console.log('[DB] Phase 8 schema: already applied, skipping.');
    return;
  }

  console.log('[DB] Running Phase 8 schema migration (campaigns.objective enum widen + ad_sets.optimization_goal)...');

  const dbRaw = db.getDb();

  // Must happen BEFORE the transaction starts -- SQLite forbids toggling
  // this pragma mid-transaction, and campaigns is an active FK target
  // (ad_sets.campaign_id, ads.campaign_id) so the rebuild-and-rename below
  // would otherwise be at risk under strict FK enforcement.
  dbRaw.run('PRAGMA foreign_keys = OFF;');

  // Row counts before, for a hard before/after integrity check after commit.
  const before = {
    campaigns: dbRaw.exec('SELECT COUNT(*) as c FROM campaigns')[0]?.values?.[0]?.[0] ?? 0,
    ad_sets:   dbRaw.exec('SELECT COUNT(*) as c FROM ad_sets')[0]?.values?.[0]?.[0] ?? 0,
    ads:       dbRaw.exec('SELECT COUNT(*) as c FROM ads')[0]?.values?.[0]?.[0] ?? 0,
  };

  dbRaw.run('BEGIN TRANSACTION;');

  try {
    // Step 1: create the new campaigns table with the widened CHECK
    dbRaw.run(`
      CREATE TABLE campaigns_v8 (
        id                      TEXT PRIMARY KEY,
        ad_account_id           TEXT NOT NULL REFERENCES ad_accounts(id),
        meta_campaign_id        TEXT NOT NULL UNIQUE,
        name                    TEXT NOT NULL,
        objective               TEXT NOT NULL
                                  CHECK(objective IN (
                                    'awareness','traffic','engagement','leads','app_promotion','sales','unknown'
                                  )),
        objective_effective_from TEXT,
        status                  TEXT NOT NULL
                                  CHECK(status IN ('active','paused','archived','deleted')),
        meta_created_time       TEXT,
        meta_updated_time       TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Step 2: copy all existing rows, remapping the one now-invalid value.
    // Any other value not in the new list would also violate the new CHECK
    // and correctly abort this migration (surfacing a real data problem
    // rather than silently coercing an unexpected objective string).
    dbRaw.run(`
      INSERT INTO campaigns_v8
        (id, ad_account_id, meta_campaign_id, name, objective,
         objective_effective_from, status, meta_created_time, meta_updated_time,
         created_at, updated_at)
      SELECT
        id, ad_account_id, meta_campaign_id, name,
        CASE WHEN objective = 'messaging' THEN 'engagement' ELSE objective END,
        objective_effective_from, status, meta_created_time, meta_updated_time,
        created_at, updated_at
      FROM campaigns
    `);

    // Step 3: drop old table, rename new one into place
    dbRaw.run('DROP TABLE campaigns');
    dbRaw.run('ALTER TABLE campaigns_v8 RENAME TO campaigns');

    // Step 4: recreate all indexes that existed on the old table
    dbRaw.run('CREATE INDEX IF NOT EXISTS idx_campaigns_ad_account_id ON campaigns(ad_account_id)');
    dbRaw.run('CREATE INDEX IF NOT EXISTS idx_campaigns_meta_id ON campaigns(meta_campaign_id)');
    dbRaw.run('CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)');
    dbRaw.run('CREATE INDEX IF NOT EXISTS idx_campaigns_objective ON campaigns(objective)');

    // Step 5: additive column for ad_sets -- nullable, no CHECK, no data loss
    dbRaw.run('ALTER TABLE ad_sets ADD COLUMN optimization_goal TEXT');

    dbRaw.run('COMMIT;');
  } catch (err) {
    dbRaw.run('ROLLBACK;');
    dbRaw.run('PRAGMA foreign_keys = ON;');
    console.error('[DB] Phase 8 migration FAILED — rolled back:', err.message);
    throw err;
  }

  dbRaw.run('PRAGMA foreign_keys = ON;');

  // Post-migration integrity checks -- this touches real production data
  // with FK-dependent child tables, so verify rather than assume.
  const fkViolations = dbRaw.exec('PRAGMA foreign_key_check');
  if (fkViolations.length > 0 && fkViolations[0].values.length > 0) {
    const msg = `Phase 8 migration introduced ${fkViolations[0].values.length} foreign key violation(s): ${JSON.stringify(fkViolations[0].values)}`;
    console.error('[DB]', msg);
    throw new Error(msg);
  }

  const after = {
    campaigns: dbRaw.exec('SELECT COUNT(*) as c FROM campaigns')[0]?.values?.[0]?.[0] ?? 0,
    ad_sets:   dbRaw.exec('SELECT COUNT(*) as c FROM ad_sets')[0]?.values?.[0]?.[0] ?? 0,
    ads:       dbRaw.exec('SELECT COUNT(*) as c FROM ads')[0]?.values?.[0]?.[0] ?? 0,
  };
  if (after.campaigns !== before.campaigns || after.ad_sets !== before.ad_sets || after.ads !== before.ads) {
    const msg = `Phase 8 migration row count mismatch! Before: ${JSON.stringify(before)}, After: ${JSON.stringify(after)}`;
    console.error('[DB]', msg);
    throw new Error(msg);
  }

  const stillMessaging = dbRaw.exec("SELECT COUNT(*) as c FROM campaigns WHERE objective = 'messaging'");
  const messagingCount = stillMessaging[0]?.values?.[0]?.[0] ?? 0;
  if (messagingCount > 0) {
    throw new Error(`Phase 8 migration left ${messagingCount} campaign(s) with objective='messaging' — remap failed.`);
  }

  markMigrationApplied(MIGRATION_NAME);
  db.persist();

  console.log(
    `[DB] Phase 8 migration complete — campaigns.objective now supports: ` +
    `awareness, traffic, engagement, leads, app_promotion, sales, unknown. ` +
    `ad_sets.optimization_goal added. Row counts verified unchanged ` +
    `(campaigns=${after.campaigns}, ad_sets=${after.ad_sets}, ads=${after.ads}).`
  );
}

module.exports = { runPhase8Migrations };
