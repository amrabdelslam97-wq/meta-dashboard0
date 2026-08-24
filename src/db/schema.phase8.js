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
 * Idempotency: tracked via schema_migrations (see migrationTracker.js).
 *
 * Driver-agnostic (Wave 7 Blocker 2): two driver-specific paths, selected on
 * the same process.env.DATABASE_URL signal database.js's own driver
 * selector uses (not a new signal). No dbRaw/getDb() usage remains in this
 * file.
 *
 *   - SQLite (no DATABASE_URL): unchanged table-replace logic (SQLite has no
 *     ALTER TABLE ... DROP/ADD CONSTRAINT support at all -- the actual
 *     reason this migration ever needed a rebuild), now run inside
 *     db.transaction() instead of a raw dbRaw BEGIN/COMMIT/ROLLBACK
 *     sequence. `campaigns` IS an active foreign-key target under SQLite
 *     (ad_sets.campaign_id, ads.campaign_id both REFERENCE campaigns(id)),
 *     so PRAGMA foreign_keys=OFF is still required immediately before the
 *     transaction begins (SQLite forbids toggling it mid-transaction) and
 *     back ON immediately after, followed by PRAGMA foreign_key_check to
 *     confirm no dangling references were introduced by the rebuild -- this
 *     PRAGMA pair is SQLite-only validation (category A) with no PostgreSQL
 *     analog, kept exactly as before, on the SQLite path only.
 *   - PostgreSQL (DATABASE_URL set): PostgreSQL DOES support
 *     ALTER TABLE ... DROP/ADD CONSTRAINT directly, so this migration needs
 *     no table rebuild, no DROP TABLE (which would fail outright against an
 *     FK-referenced parent table under Postgres without CASCADE -- and
 *     CASCADE would permanently drop, not just suspend, ad_sets/ads' FK
 *     constraints), no rename, and therefore no FK-toggle/FK-recheck step at
 *     all. PRAGMA foreign_keys/foreign_key_check are category C here --
 *     unnecessary, not weakened -- Postgres enforces FK constraints
 *     continuously, so a transaction that COMMITs has already proven no FK
 *     violation exists; a post-hoc batch check would be structurally
 *     redundant, not a stronger guarantee.
 */

const db = require('./database');
const { ensureMigrationsTable, isMigrationApplied, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase8_campaigns_objective_enum_widen';
const NEW_OBJECTIVES = ['awareness', 'traffic', 'engagement', 'leads', 'app_promotion', 'sales', 'unknown'];

async function runPhase8MigrationsPostgres() {
  await db.transaction(async (tx) => {
    // Remap FIRST, before the new (stricter) CHECK is added -- the old CHECK
    // still permits 'messaging' at this point, but the new one won't.
    await tx.run(`UPDATE campaigns SET objective = 'engagement' WHERE objective = 'messaging'`);

    // Postgres's default auto-generated name for an unnamed inline CHECK on
    // column `objective` of table `campaigns` is `campaigns_objective_check`
    // (Postgres's documented `<table>_<column>_check` convention) -- the
    // exact constraint the original CREATE TABLE IF NOT EXISTS text
    // (schema.js, run verbatim against Postgres via translateSql()) would
    // have created. IF EXISTS makes the drop itself idempotent/safe even if
    // that assumption is ever wrong -- the subsequent ADD CONSTRAINT would
    // then fail loudly with a clear Postgres error rather than silently
    // leaving the old, narrower CHECK in place.
    await tx.run(`ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_objective_check`);
    await tx.run(
      `ALTER TABLE campaigns ADD CONSTRAINT campaigns_objective_check CHECK (objective IN (${NEW_OBJECTIVES.map(o => `'${o}'`).join(',')}))`
    );

    await tx.run(`ALTER TABLE ad_sets ADD COLUMN IF NOT EXISTS optimization_goal TEXT`);
  });

  // Structurally guaranteed by the UPDATE above having run inside the same
  // committed transaction, but re-verified directly rather than assumed --
  // consistent with this migration's existing "verify, don't just assume"
  // standard for its SQLite path.
  const stillMessaging = await db.get(`SELECT COUNT(*) as c FROM campaigns WHERE objective = 'messaging'`);
  const messagingCount = Number(stillMessaging?.c ?? 0);
  if (messagingCount > 0) {
    throw new Error(`Phase 8 migration left ${messagingCount} campaign(s) with objective='messaging' — remap failed.`);
  }
}

async function runPhase8MigrationsSqlite() {
  // Must happen BEFORE the transaction starts -- SQLite forbids toggling
  // this pragma mid-transaction, and campaigns is an active FK target
  // (ad_sets.campaign_id, ads.campaign_id) so the rebuild-and-rename below
  // would otherwise be at risk under strict FK enforcement. Goes through the
  // ordinary db.run() (not a raw handle) -- translateSql() would no-op this
  // safely under Postgres too, but this whole function only ever runs on
  // the SQLite path.
  await db.run('PRAGMA foreign_keys = OFF;');

  // Row counts before, for a hard before/after integrity check after commit.
  const before = {
    campaigns: (await db.get('SELECT COUNT(*) as c FROM campaigns'))?.c ?? 0,
    ad_sets: (await db.get('SELECT COUNT(*) as c FROM ad_sets'))?.c ?? 0,
    ads: (await db.get('SELECT COUNT(*) as c FROM ads'))?.c ?? 0,
  };

  try {
    // db.transaction() wraps this callback in a real BEGIN/COMMIT, rolling
    // back automatically on any thrown error — same atomicity guarantee the
    // old manual dbRaw BEGIN/COMMIT/ROLLBACK sequence intended, now backed
    // by db.transaction()'s driver-correct implementation.
    await db.transaction(async (tx) => {
      // Step 1: create the new campaigns table with the widened CHECK
      await tx.run(`
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
      await tx.run(`
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
      await tx.run('DROP TABLE campaigns');
      await tx.run('ALTER TABLE campaigns_v8 RENAME TO campaigns');

      // Step 4: recreate all indexes that existed on the old table
      await tx.run('CREATE INDEX IF NOT EXISTS idx_campaigns_ad_account_id ON campaigns(ad_account_id)');
      await tx.run('CREATE INDEX IF NOT EXISTS idx_campaigns_meta_id ON campaigns(meta_campaign_id)');
      await tx.run('CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)');
      await tx.run('CREATE INDEX IF NOT EXISTS idx_campaigns_objective ON campaigns(objective)');

      // Step 5: additive column for ad_sets -- nullable, no CHECK, no data loss
      await tx.run('ALTER TABLE ad_sets ADD COLUMN optimization_goal TEXT');
    });
  } catch (err) {
    await db.run('PRAGMA foreign_keys = ON;');
    console.error('[DB] Phase 8 migration FAILED — rolled back:', err.message);
    throw err;
  }

  await db.run('PRAGMA foreign_keys = ON;');

  // Post-migration integrity checks -- this touches real production data
  // with FK-dependent child tables, so verify rather than assume.
  const fkViolations = await db.all('PRAGMA foreign_key_check');
  if (fkViolations.length > 0) {
    const msg = `Phase 8 migration introduced ${fkViolations.length} foreign key violation(s): ${JSON.stringify(fkViolations)}`;
    console.error('[DB]', msg);
    throw new Error(msg);
  }

  const after = {
    campaigns: (await db.get('SELECT COUNT(*) as c FROM campaigns'))?.c ?? 0,
    ad_sets: (await db.get('SELECT COUNT(*) as c FROM ad_sets'))?.c ?? 0,
    ads: (await db.get('SELECT COUNT(*) as c FROM ads'))?.c ?? 0,
  };
  if (after.campaigns !== before.campaigns || after.ad_sets !== before.ad_sets || after.ads !== before.ads) {
    const msg = `Phase 8 migration row count mismatch! Before: ${JSON.stringify(before)}, After: ${JSON.stringify(after)}`;
    console.error('[DB]', msg);
    throw new Error(msg);
  }

  const stillMessaging = await db.get(`SELECT COUNT(*) as c FROM campaigns WHERE objective = 'messaging'`);
  const messagingCount = stillMessaging?.c ?? 0;
  if (messagingCount > 0) {
    throw new Error(`Phase 8 migration left ${messagingCount} campaign(s) with objective='messaging' — remap failed.`);
  }

  console.log(
    `[DB] Phase 8 migration complete — campaigns.objective now supports: ` +
    `awareness, traffic, engagement, leads, app_promotion, sales, unknown. ` +
    `ad_sets.optimization_goal added. Row counts verified unchanged ` +
    `(campaigns=${after.campaigns}, ad_sets=${after.ad_sets}, ads=${after.ads}).`
  );
}

async function runPhase8Migrations() {
  await ensureMigrationsTable();

  if (await isMigrationApplied(MIGRATION_NAME)) {
    console.log('[DB] Phase 8 schema: already applied, skipping.');
    return;
  }

  console.log('[DB] Running Phase 8 schema migration (campaigns.objective enum widen + ad_sets.optimization_goal)...');

  if (process.env.DATABASE_URL) {
    await runPhase8MigrationsPostgres();
    console.log(
      '[DB] Phase 8 migration complete — campaigns.objective now supports: ' +
      'awareness, traffic, engagement, leads, app_promotion, sales, unknown. ' +
      'ad_sets.optimization_goal added.'
    );
  } else {
    await runPhase8MigrationsSqlite();
  }

  await markMigrationApplied(MIGRATION_NAME);
  await db.persist();
}

module.exports = { runPhase8Migrations };
