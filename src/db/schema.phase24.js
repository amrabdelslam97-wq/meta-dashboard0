/**
 * Phase 24 Schema Migration — Budget Intelligence & Attribution Analysis
 *
 * Purpose: persistent storage for budget analysis, waste detection, scaling
 * opportunities, and attribution window comparisons.
 *
 * New tables:
 *   budget_analysis_history — Budget scores, waste flags, scaling signals
 *   attribution_analysis — Aggregated attribution by window + dimension
 *   budget_movements — Recommended budget reallocations
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied, isMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase24_budget_intelligence_attribution';

function runPhase24Migrations() {
  ensureMigrationsTable();
  const alreadyApplied = isMigrationApplied(MIGRATION_NAME);

  db.run(`
    CREATE TABLE IF NOT EXISTS budget_analysis_history (
      id                   TEXT PRIMARY KEY,
      ad_account_id        TEXT NOT NULL,
      level                TEXT NOT NULL,
      entity_meta_id       TEXT NOT NULL,
      entity_label         TEXT,
      date_since           TEXT NOT NULL,
      date_until           TEXT NOT NULL,
      budget_efficiency_score REAL,
      efficiency_status    TEXT,
      waste_detected       INTEGER DEFAULT 0,
      waste_amount         REAL,
      waste_reasons_json   TEXT,
      is_scaling_candidate INTEGER DEFAULT 0,
      scaling_potential    REAL,
      spend_amount         REAL,
      results              REAL,
      roas                 REAL,
      calculated_at        TEXT NOT NULL,
      UNIQUE(ad_account_id, level, entity_meta_id, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_budget_analysis_lookup ON budget_analysis_history(ad_account_id, level, date_since)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_budget_waste_detection ON budget_analysis_history(ad_account_id, waste_detected, date_since)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS attribution_window_analysis (
      id                       TEXT PRIMARY KEY,
      ad_account_id            TEXT NOT NULL,
      meta_campaign_id         TEXT NOT NULL,
      attribution_window       TEXT NOT NULL,
      breakdown_dimension      TEXT,
      breakdown_value          TEXT,
      date_since               TEXT NOT NULL,
      date_until               TEXT NOT NULL,
      impressions              REAL,
      clicks                   REAL,
      conversions              REAL,
      conversion_value         REAL,
      cost_per_conversion      REAL,
      roas                     REAL,
      calculated_at            TEXT NOT NULL,
      UNIQUE(ad_account_id, meta_campaign_id, attribution_window, breakdown_dimension, breakdown_value, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_attribution_window_lookup ON attribution_window_analysis(ad_account_id, meta_campaign_id, attribution_window, date_since)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS budget_movement_recommendations (
      id                   TEXT PRIMARY KEY,
      ad_account_id        TEXT NOT NULL,
      date_generated       TEXT NOT NULL,
      from_entity_id       TEXT,
      from_entity_label    TEXT,
      to_entity_id         TEXT,
      to_entity_label      TEXT,
      movement_type        TEXT,
      movement_amount      REAL,
      movement_pct         REAL,
      reason               TEXT,
      confidence           REAL,
      expected_impact_json TEXT,
      risk_level           TEXT,
      status               TEXT DEFAULT 'pending',
      applied_at           TEXT,
      UNIQUE(ad_account_id, from_entity_id, to_entity_id, movement_type, date_generated)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_budget_movements_lookup ON budget_movement_recommendations(ad_account_id, date_generated)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_budget_movements_status ON budget_movement_recommendations(ad_account_id, status)`);

  markMigrationApplied(MIGRATION_NAME);

  if (!alreadyApplied) {
    db.persist();
    console.log('[DB] Phase 24 migration complete — budget intelligence and attribution tables created.');
  } else {
    console.log('[DB] Phase 24 schema: budget tables already present, skipping.');
  }
}

module.exports = { runPhase24Migrations };
