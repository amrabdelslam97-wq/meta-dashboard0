'use strict';

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const database = require('../../src/db/database');
const { runMigrations } = require('../../src/db/schema');
const { runPhase2Migrations } = require('../../src/db/schema.phase2');
const { runPhase5Migrations } = require('../../src/db/schema.phase5');
const { runPhase6Migrations } = require('../../src/db/schema.phase6');
const { runPhase7BMigrations } = require('../../src/db/schema.phase7b');
const { runPhase8Migrations } = require('../../src/db/schema.phase8');
const { runUniqueConstraintsMigration } = require('../../src/db/schema.uniqueConstraints');
const { runPhase11Migrations } = require('../../src/db/schema.phase11');
const { runPhase12Migrations } = require('../../src/db/schema.phase12');
const { runPhase13Migrations } = require('../../src/db/schema.phase13');

function runFullMigrationSet() {
  runMigrations();
  runPhase2Migrations();
  runPhase5Migrations();
  runPhase6Migrations();
  runPhase7BMigrations();
  runPhase8Migrations();
  runUniqueConstraintsMigration();
  runPhase11Migrations();
  runPhase12Migrations();
  runPhase13Migrations();
}

describe('database migrations', () => {
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `meta-ads-migtest-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
    await database.initializeDatabase(dbPath);
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('running the full migration set creates every expected core and intelligence table', () => {
    runFullMigrationSet();
    const tables = database.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).map(r => r.name);

    for (const t of [
      'users', 'ad_accounts', 'campaigns', 'ad_sets', 'ads',
      'benchmark_industries', 'benchmark_metrics', 'account_targets',
      'health_score_history', 'recommendation_rules', 'recommendation_log',
      'alert_rules', 'active_alerts', 'schema_migrations', 'rule_engine_log',
      'diagnosis_history', 'decision_outcomes',
    ]) {
      expect(tables).toContain(t);
    }
  });

  test('running the full migration set twice is idempotent (no errors, no duplicate rows)', () => {
    expect(() => {
      runFullMigrationSet();
      runFullMigrationSet();
    }).not.toThrow();

    const migrationRows = database.all('SELECT name, COUNT(*) as c FROM schema_migrations GROUP BY name');
    for (const row of migrationRows) {
      expect(row.c).toBe(1); // each migration name recorded exactly once, not twice
    }
  });

  test('schema_migrations records every migration by name after a full run', () => {
    runFullMigrationSet();
    const names = database.all('SELECT name FROM schema_migrations').map(r => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'phase1_core_tables',
      'phase2_intelligence_tables',
      'phase5_decision_history',
      'phase6a_health_score_history_entity_type_ad',
      'unique_constraints_benchmark_metrics_account_targets',
      'phase11_rule_engine_log',
      'phase12_governance_state_columns',
      'phase13_executive_memory',
    ]));
  });

  test('diagnosis_history and decision_outcomes have the expected Phase 13 columns', () => {
    runFullMigrationSet();
    const diagCols = database.all("PRAGMA table_info(diagnosis_history)").map(c => c.name);
    const outcomeCols = database.all("PRAGMA table_info(decision_outcomes)").map(c => c.name);
    expect(diagCols).toEqual(expect.arrayContaining([
      'id', 'ad_account_id', 'entity_type', 'entity_meta_id', 'objective',
      'status', 'primary_key', 'primary_label', 'delta_pct', 'category',
      'confidence', 'priority', 'factors', 'summary', 'calculated_at',
    ]));
    expect(outcomeCols).toEqual(expect.arrayContaining([
      'id', 'decision_history_id', 'meta_campaign_id', 'decision_type',
      'metric_key', 'metric_before', 'metric_after', 'delta_pct', 'outcome', 'measured_at',
    ]));
  });

  test('recommendation_log and active_alerts have the Phase 12 governance_state column', () => {
    runFullMigrationSet();
    const recCols = database.all("PRAGMA table_info(recommendation_log)").map(c => c.name);
    const alertCols = database.all("PRAGMA table_info(active_alerts)").map(c => c.name);
    expect(recCols).toContain('governance_state');
    expect(alertCols).toContain('governance_state');
  });

  test('ads table has the Phase 7B creative preview columns', () => {
    runFullMigrationSet();
    const columns = database.all("PRAGMA table_info(ads)").map(c => c.name);
    expect(columns).toEqual(expect.arrayContaining([
      'creative_id', 'thumbnail_url', 'image_url', 'preview_url',
    ]));
  });

  test('account_targets rejects a duplicate (ad_account_id, objective, effective_from) row', () => {
    runFullMigrationSet();
    const accountId = uuidv4();
    database.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [accountId, 'act_migration_test', 'Migration Test Account', 'enc:v1:placeholder']
    );

    const insert = () => database.run(
      `INSERT INTO account_targets (id, ad_account_id, objective, effective_from)
       VALUES (?, ?, ?, '2026-01-01')`,
      [uuidv4(), accountId, 'sales']
    );

    insert();
    expect(insert).toThrow();
  });

  test('benchmark_metrics rejects a duplicate global benchmark even with NULL ad_account_id/industry_id (COALESCE fix)', () => {
    runFullMigrationSet();

    const insertGlobalBenchmark = () => database.run(
      `INSERT INTO benchmark_metrics
         (id, industry_id, ad_account_id, objective, metric_key,
          excellent_threshold, good_threshold, warning_threshold, critical_threshold,
          comparison_direction)
       VALUES (?, NULL, NULL, 'messaging', 'cpr', 5, 15, 30, 60, 'lower_is_better')`,
      [uuidv4()]
    );

    insertGlobalBenchmark();
    expect(insertGlobalBenchmark).toThrow();
  });

  // ── Phase 8: campaigns.objective enum widen + ad_sets.optimization_goal ──

  test('campaigns accepts every new objective value and rejects the old "messaging" value', () => {
    runFullMigrationSet();
    const accountId = uuidv4();
    database.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_phase8_test', 'Phase8 Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );

    const insertCampaign = (objective) => database.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Test Campaign', ?, 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId, `camp_${objective}`, objective]
    );

    for (const obj of ['awareness', 'traffic', 'engagement', 'leads', 'app_promotion', 'sales', 'unknown']) {
      expect(() => insertCampaign(obj)).not.toThrow();
    }
    expect(() => insertCampaign('messaging')).toThrow();
  });

  test('ad_sets has the optimization_goal column after migration, nullable with no CHECK', () => {
    runFullMigrationSet();
    const columns = database.all('PRAGMA table_info(ad_sets)');
    const optGoalCol = columns.find(c => c.name === 'optimization_goal');
    expect(optGoalCol).toBeDefined();
    expect(optGoalCol.notnull).toBe(0);
  });

  test('phase8 remaps pre-existing objective="messaging" campaign rows to "engagement"', () => {
    // Run migrations UP TO (not including) phase8.
    runMigrations();
    runPhase2Migrations();
    runPhase5Migrations();
    runPhase6Migrations();
    runPhase7BMigrations();

    // schema.js's own CHECK constraint was corrected to match the post-phase8
    // 7-value shape, so it no longer permits inserting a legacy 'messaging'
    // row directly. To genuinely simulate a pre-existing database created
    // BEFORE that fix -- the real scenario phase8's remap logic exists to
    // handle -- rebuild campaigns here with the old 5-value constraint,
    // mirroring the exact table-swap pattern schema.phase8.js itself uses.
    database.run('PRAGMA foreign_keys = OFF;');
    database.run(`
      CREATE TABLE campaigns_old_shape (
        id                      TEXT PRIMARY KEY,
        ad_account_id           TEXT NOT NULL REFERENCES ad_accounts(id),
        meta_campaign_id        TEXT NOT NULL UNIQUE,
        name                    TEXT NOT NULL,
        objective               TEXT NOT NULL
                                  CHECK(objective IN ('messaging','leads','sales','traffic','awareness','unknown')),
        objective_effective_from TEXT,
        status                  TEXT NOT NULL
                                  CHECK(status IN ('active','paused','archived','deleted')),
        meta_created_time       TEXT,
        meta_updated_time       TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    database.run('DROP TABLE campaigns;');
    database.run('ALTER TABLE campaigns_old_shape RENAME TO campaigns;');
    database.run('PRAGMA foreign_keys = ON;');

    const accountId = uuidv4();
    database.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_remap_test', 'Remap Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
    const campaignId = uuidv4();
    database.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_remap', 'Pre-existing Messaging Campaign', 'messaging', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId]
    );

    runPhase8Migrations();
    runUniqueConstraintsMigration();

    const row = database.get('SELECT objective FROM campaigns WHERE id = ?', [campaignId]);
    expect(row.objective).toBe('engagement');
  });

  test('benchmark_metrics still allows distinct account-specific rows for the same objective/metric', () => {
    runFullMigrationSet();
    const accountA = uuidv4();
    const accountB = uuidv4();
    database.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_a', 'A', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountA]
    );
    database.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_b', 'B', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountB]
    );

    const insertFor = (acctId) => database.run(
      `INSERT INTO benchmark_metrics
         (id, ad_account_id, objective, metric_key,
          excellent_threshold, good_threshold, warning_threshold, critical_threshold,
          comparison_direction)
       VALUES (?, ?, 'messaging', 'cpr', 5, 15, 30, 60, 'lower_is_better')`,
      [uuidv4(), acctId]
    );

    expect(() => { insertFor(accountA); insertFor(accountB); }).not.toThrow();
  });
});
