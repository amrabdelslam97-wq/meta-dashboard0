/**
 * Phase 19 Schema Migration — Executive Marketing Analytics Layer
 *
 * Purpose: durable, historical storage for the new Analytics module
 * (analyticsEngine.js / creativeAnalytics.js / budgetDistributionAnalytics.js)
 * so every analytics dataset supports historical trend + period-over-period
 * comparison, not just a live/cached snapshot. All three new tables are
 * additive; no existing table is touched.
 *
 * Scheduling for these datasets deliberately does NOT introduce a new
 * scheduler or a new sync_entity_state-like table -- it reuses the exact
 * `sync_schedule_config`/`sync_entity_state`/`sync_execution_log` tables
 * Phase 16 already built, via one new entity_type value ('analytics') that
 * smartSyncEngine.js's existing tiered due-check/checkpoint/logging/
 * rate-limit machinery treats identically to every other tier. This
 * migration only seeds that one new config row (idempotent, same pattern
 * schema.phase16.js used for its own initial seed).
 *
 * New tables:
 *   analytics_breakdown_history   — Audience/Geographic/Placement/Device
 *     analytics (age, gender, age_gender, country, region, dma,
 *     publisher_platform, platform_position, placement, impression_device,
 *     device_platform). One row per (account, campaign, breakdown_type,
 *     breakdown_value, date range).
 *   creative_analytics            — per-ad creative detail + video/engagement
 *     performance snapshot, one row per (ad, date range).
 *   budget_distribution_snapshots — budget/spend/results allocation across
 *     account/campaign/ad_set/ad grain, one row per (account, level, entity,
 *     date range).
 *
 * Existing tables modified: NONE.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied, isMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase19_executive_analytics_layer';

// Matches smartSyncEngine.js's own default-interval convention (Phase 16) --
// 6 hours: analytics breakdowns/creative/budget data doesn't need
// insights-tier freshness, but should still refresh several times a day.
const ANALYTICS_DEFAULT_INTERVAL_MINUTES = 360;

function runPhase19Migrations() {
  ensureMigrationsTable();

  db.run(`
    CREATE TABLE IF NOT EXISTS analytics_breakdown_history (
      id               TEXT PRIMARY KEY,
      ad_account_id    TEXT NOT NULL,
      entity_type      TEXT NOT NULL DEFAULT 'campaign',
      entity_meta_id   TEXT NOT NULL,
      breakdown_type   TEXT NOT NULL,
      breakdown_value  TEXT NOT NULL,
      date_since       TEXT NOT NULL,
      date_until       TEXT NOT NULL,
      spend            REAL,
      impressions      INTEGER,
      reach            INTEGER,
      clicks           INTEGER,
      ctr              REAL,
      cpm              REAL,
      cpc              REAL,
      frequency        REAL,
      results          REAL,
      cost_per_result  REAL,
      actions_json     TEXT,
      calculated_at    TEXT NOT NULL,
      UNIQUE(ad_account_id, entity_meta_id, breakdown_type, breakdown_value, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_analytics_breakdown_lookup ON analytics_breakdown_history(ad_account_id, entity_meta_id, breakdown_type, date_since)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS creative_analytics (
      id                 TEXT PRIMARY KEY,
      ad_account_id      TEXT NOT NULL,
      meta_ad_id         TEXT NOT NULL,
      meta_adset_id      TEXT,
      meta_campaign_id   TEXT,
      creative_id        TEXT,
      creative_name      TEXT,
      creative_type      TEXT,
      image_url          TEXT,
      video_id           TEXT,
      thumbnail_url      TEXT,
      headline           TEXT,
      primary_text       TEXT,
      description        TEXT,
      cta_type           TEXT,
      video_length_sec   REAL,
      video_ratio        TEXT,
      image_ratio        TEXT,
      date_since         TEXT NOT NULL,
      date_until         TEXT NOT NULL,
      spend              REAL,
      results            REAL,
      ctr                REAL,
      cpm                REAL,
      cpa                REAL,
      video_p25_pct      REAL,
      video_p50_pct      REAL,
      video_p75_pct      REAL,
      video_p95_pct      REAL,
      video_p100_pct     REAL,
      thruplay_count     INTEGER,
      avg_watch_time_sec REAL,
      hold_rate          REAL,
      drop_off_pct       REAL,
      calculated_at      TEXT NOT NULL,
      UNIQUE(meta_ad_id, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_creative_analytics_lookup ON creative_analytics(ad_account_id, meta_campaign_id, date_since)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS budget_distribution_snapshots (
      id                       TEXT PRIMARY KEY,
      ad_account_id            TEXT NOT NULL,
      level                    TEXT NOT NULL,
      entity_meta_id           TEXT NOT NULL,
      entity_label             TEXT,
      date_since               TEXT NOT NULL,
      date_until               TEXT NOT NULL,
      budget_amount            REAL,
      spend_amount             REAL,
      results                  REAL,
      budget_pct               REAL,
      spend_pct                REAL,
      results_pct              REAL,
      efficiency_score         REAL,
      is_waste                 INTEGER NOT NULL DEFAULT 0,
      is_scaling_opportunity   INTEGER NOT NULL DEFAULT 0,
      calculated_at            TEXT NOT NULL,
      UNIQUE(ad_account_id, level, entity_meta_id, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_budget_distribution_lookup ON budget_distribution_snapshots(ad_account_id, level, date_since)`);

  // Reuse Phase 16's sync_schedule_config table -- one new entity_type row,
  // same seed-once pattern schema.phase16.js used for its own six rows.
  if (!isMigrationApplied(MIGRATION_NAME)) {
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO sync_schedule_config (entity_type, interval_minutes, updated_at) VALUES (?, ?, ?)`,
      ['analytics', ANALYTICS_DEFAULT_INTERVAL_MINUTES, now]
    );
    markMigrationApplied(MIGRATION_NAME);
    db.persist();
    console.log('[DB] Phase 19 migration complete — analytics tables created and scheduler tier seeded.');
  } else {
    console.log('[DB] Phase 19 schema: analytics tables already present, skipping seed.');
  }
}

module.exports = { runPhase19Migrations, ANALYTICS_DEFAULT_INTERVAL_MINUTES };
