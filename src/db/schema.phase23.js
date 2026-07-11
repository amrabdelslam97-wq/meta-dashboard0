/**
 * Phase 23 Schema Migration — Audience Intelligence & Scoring
 *
 * Purpose: persistent storage for audience segment scores and diagnostics
 * from the new Audience Intelligence Engine (audienceScoringEngine.js).
 *
 * New tables:
 *   audience_score_history — per-segment health scores (0-100), status,
 *     component breakdowns (volume, efficiency, conversion, return,
 *     saturation, stability), and snapshot metrics.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied, isMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase23_audience_intelligence_scoring';

function runPhase23Migrations() {
  ensureMigrationsTable();
  const alreadyApplied = isMigrationApplied(MIGRATION_NAME);

  db.run(`
    CREATE TABLE IF NOT EXISTS audience_score_history (
      id                   TEXT PRIMARY KEY,
      ad_account_id        TEXT NOT NULL,
      meta_campaign_id     TEXT NOT NULL,
      dimension            TEXT NOT NULL,
      segment_value        TEXT NOT NULL,
      date_since           TEXT NOT NULL,
      date_until           TEXT NOT NULL,
      overall_score        REAL,
      status               TEXT,
      volume_score         REAL,
      efficiency_score     REAL,
      conversion_score     REAL,
      return_score         REAL,
      saturation_score     REAL,
      stability_score      REAL,
      spend                REAL,
      contribution_pct     REAL,
      cpm                  REAL,
      cpa                  REAL,
      ctr                  REAL,
      roas                 REAL,
      frequency            REAL,
      calculated_at        TEXT NOT NULL,
      UNIQUE(ad_account_id, meta_campaign_id, dimension, segment_value, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audience_score_lookup ON audience_score_history(ad_account_id, meta_campaign_id, dimension, date_since)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audience_score_ranking ON audience_score_history(meta_campaign_id, dimension, overall_score DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS audience_diagnostics (
      id                   TEXT PRIMARY KEY,
      ad_account_id        TEXT NOT NULL,
      meta_campaign_id     TEXT NOT NULL,
      dimension            TEXT NOT NULL,
      date_since           TEXT NOT NULL,
      date_until           TEXT NOT NULL,
      strengths_json       TEXT,
      weaknesses_json      TEXT,
      anomalies_json       TEXT,
      calculated_at        TEXT NOT NULL,
      UNIQUE(ad_account_id, meta_campaign_id, dimension, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audience_diagnostics_lookup ON audience_diagnostics(ad_account_id, meta_campaign_id, date_since)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS audience_opportunities (
      id                   TEXT PRIMARY KEY,
      ad_account_id        TEXT NOT NULL,
      meta_campaign_id     TEXT NOT NULL,
      date_since           TEXT NOT NULL,
      date_until           TEXT NOT NULL,
      hidden_winners_json  TEXT,
      budget_shifts_json   TEXT,
      expansion_json       TEXT,
      narrowing_json       TEXT,
      warnings_json        TEXT,
      calculated_at        TEXT NOT NULL,
      UNIQUE(ad_account_id, meta_campaign_id, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audience_opportunities_lookup ON audience_opportunities(ad_account_id, meta_campaign_id, date_since)`);

  markMigrationApplied(MIGRATION_NAME);

  if (!alreadyApplied) {
    db.persist();
    console.log('[DB] Phase 23 migration complete — audience scoring and diagnostics tables created.');
  } else {
    console.log('[DB] Phase 23 schema: audience tables already present, skipping.');
  }
}

module.exports = { runPhase23Migrations };
