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
const { runUniqueConstraintsMigration } = require('../../src/db/schema.uniqueConstraints');

function runFullMigrationSet() {
  runMigrations();
  runPhase2Migrations();
  runPhase5Migrations();
  runPhase6Migrations();
  runPhase7BMigrations();
  runUniqueConstraintsMigration();
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
      'alert_rules', 'active_alerts', 'schema_migrations',
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
    ]));
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
