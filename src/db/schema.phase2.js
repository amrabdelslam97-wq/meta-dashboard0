/**
 * Phase 2 Schema Extension
 *
 * Adds intelligence layer tables to the existing database.
 * Phase 1 tables are NEVER touched here.
 *
 * New tables:
 *   - benchmark_industries
 *   - benchmark_metrics
 *   - objective_scoring_configs
 *   - account_targets
 *   - health_score_history
 *   - recommendation_rules
 *   - recommendation_log
 *   - alert_rules
 *   - active_alerts
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase2_intelligence_tables';

const PHASE2_SCHEMA = `

-- ─────────────────────────────────────────────
-- Benchmark industries catalog
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS benchmark_industries (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────
-- Benchmark metric thresholds
-- Two-level resolution:
--   ad_account_id IS NOT NULL → account-specific
--   ad_account_id IS NULL     → global default
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS benchmark_metrics (
  id                   TEXT PRIMARY KEY,
  industry_id          TEXT REFERENCES benchmark_industries(id),
  ad_account_id        TEXT REFERENCES ad_accounts(id),
  objective            TEXT NOT NULL,
  metric_key           TEXT NOT NULL,
  excellent_threshold  REAL NOT NULL,
  good_threshold       REAL NOT NULL,
  warning_threshold    REAL NOT NULL,
  critical_threshold   REAL NOT NULL,
  comparison_direction TEXT NOT NULL DEFAULT 'lower_is_better'
                         CHECK(comparison_direction IN
                           ('lower_is_better','higher_is_better','optimal_range')),
  optimal_low          REAL,
  optimal_high         REAL,
  last_reviewed_at     TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_benchmark_metrics_lookup
  ON benchmark_metrics(industry_id, ad_account_id, objective, metric_key);

-- ─────────────────────────────────────────────
-- Per-objective metric scoring weights
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS objective_scoring_configs (
  id                   TEXT PRIMARY KEY,
  objective            TEXT NOT NULL,
  metric_key           TEXT NOT NULL,
  weight               REAL NOT NULL,
  comparison_direction TEXT NOT NULL DEFAULT 'lower_is_better',
  excellent_threshold  REAL,
  good_threshold       REAL,
  warning_threshold    REAL,
  critical_threshold   REAL,
  optimal_low          REAL,
  optimal_high         REAL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(objective, metric_key)
);

-- ─────────────────────────────────────────────
-- Account-level business targets
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_targets (
  id                     TEXT PRIMARY KEY,
  ad_account_id          TEXT NOT NULL REFERENCES ad_accounts(id),
  objective              TEXT NOT NULL,
  target_cpr             REAL,
  target_cpl             REAL,
  target_cpa             REAL,
  target_roas            REAL,
  target_ctr             REAL,
  target_cpm             REAL,
  target_frequency_max   REAL,
  monthly_budget_target  REAL,
  monthly_revenue_target REAL,
  monthly_sales_target   INTEGER,
  monthly_leads_target   INTEGER,
  effective_from         TEXT NOT NULL,
  effective_to           TEXT,
  notes                  TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_account_targets_account
  ON account_targets(ad_account_id, objective);

-- ─────────────────────────────────────────────
-- Health score history (written on each analysis)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_score_history (
  id                    TEXT PRIMARY KEY,
  ad_account_id         TEXT NOT NULL REFERENCES ad_accounts(id),
  entity_type           TEXT NOT NULL DEFAULT 'campaign'
                          CHECK(entity_type IN ('account','campaign','ad_set')),
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
);

CREATE INDEX IF NOT EXISTS idx_health_score_history_entity
  ON health_score_history(ad_account_id, entity_meta_id, calculated_at);

-- ─────────────────────────────────────────────
-- Recommendation rule definitions
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendation_rules (
  id                    TEXT PRIMARY KEY,
  rule_code             TEXT NOT NULL UNIQUE,
  objective             TEXT,
  rule_name             TEXT NOT NULL,
  priority              INTEGER NOT NULL DEFAULT 10,
  condition_logic       TEXT NOT NULL,
  recommendation_title  TEXT NOT NULL,
  recommendation_body   TEXT NOT NULL,
  recommendation_type   TEXT NOT NULL
                          CHECK(recommendation_type IN
                            ('creative','audience','budget','fatigue','scaling','tracking')),
  severity              TEXT NOT NULL
                          CHECK(severity IN ('critical','warning','info')),
  suppresses_rule_codes TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────
-- Recommendation log (per campaign, per run)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendation_log (
  id                         TEXT PRIMARY KEY,
  rule_id                    TEXT REFERENCES recommendation_rules(id),
  rule_code                  TEXT NOT NULL,
  ad_account_id              TEXT NOT NULL REFERENCES ad_accounts(id),
  entity_type                TEXT NOT NULL DEFAULT 'campaign',
  entity_meta_id             TEXT NOT NULL,
  entity_label               TEXT NOT NULL,
  objective                  TEXT,
  severity                   TEXT NOT NULL,
  recommendation_title       TEXT NOT NULL,
  recommendation_body        TEXT NOT NULL,
  metric_snapshot            TEXT,
  health_score_at_generation INTEGER,
  reference_type             TEXT NOT NULL DEFAULT 'platform_default',
  reference_label            TEXT,
  generated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  last_generated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed_at               TEXT,
  action_taken               INTEGER,
  action_notes               TEXT,
  action_taken_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_recommendation_log_entity
  ON recommendation_log(ad_account_id, entity_meta_id, generated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendation_log_dedup
  ON recommendation_log(rule_code, entity_meta_id, date(generated_at));

-- ─────────────────────────────────────────────
-- Alert rule definitions
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
  id               TEXT PRIMARY KEY,
  alert_code       TEXT NOT NULL UNIQUE,
  alert_name       TEXT NOT NULL,
  description      TEXT,
  metric_key       TEXT NOT NULL,
  trigger_type     TEXT NOT NULL
                     CHECK(trigger_type IN
                       ('threshold_absolute','threshold_pct_change','status_match')),
  trigger_value    REAL NOT NULL,
  comparison_period TEXT,
  severity         TEXT NOT NULL
                     CHECK(severity IN ('critical','warning','info')),
  objective_scope  TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────
-- Active alerts state
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS active_alerts (
  id               TEXT PRIMARY KEY,
  ad_account_id    TEXT NOT NULL REFERENCES ad_accounts(id),
  alert_rule_id    TEXT REFERENCES alert_rules(id),
  alert_code       TEXT NOT NULL,
  entity_type      TEXT NOT NULL DEFAULT 'campaign',
  entity_meta_id   TEXT NOT NULL,
  entity_label     TEXT NOT NULL,
  severity         TEXT NOT NULL
                     CHECK(severity IN ('critical','warning','info')),
  detected_value   REAL,
  threshold_value  REAL,
  alert_message    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active','snoozed','dismissed','resolved')),
  first_detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
  occurrence_count  INTEGER NOT NULL DEFAULT 1,
  snoozed_until    TEXT,
  resolved_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_active_alerts_entity
  ON active_alerts(ad_account_id, entity_meta_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_alerts_dedup
  ON active_alerts(alert_code, entity_meta_id)
  WHERE status IN ('active','snoozed');

`;

function runPhase2Migrations() {
  ensureMigrationsTable();
  console.log('[DB] Running Phase 2 schema migrations...');

  const statements = PHASE2_SCHEMA
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    db.run(statement + ';');
  }

  markMigrationApplied(MIGRATION_NAME);
  console.log('[DB] Phase 2 schema complete.');
}

module.exports = { runPhase2Migrations };
