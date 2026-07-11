/**
 * Phase 21 Schema Migration — Creative Intelligence Engine
 *
 * Purpose: extend the existing `creative_analytics` table (schema.phase19.js)
 * with the additional real metrics, real creative-content fields, computed
 * AI-analysis/score columns, and fatigue verdict the Creative Intelligence
 * Engine needs -- no new table. creative_analytics already has one row per
 * (ad, date range); every new column here is additive and computed from
 * data already fetched/synced by creativeAnalytics.js (metrics) or newly
 * fetched by the SAME existing fetchAdCreativeDetail() call (destination_url/
 * image_hash -- Phase 21 adds these fields to that one call, not a new call).
 *
 * Method: ALTER TABLE ADD COLUMN -- safe, additive, no data loss. Same
 * idempotent guard pattern as every other phaseN schema file.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase21_creative_intelligence_engine';

const NEW_COLUMNS = [
  // ── Additional real metrics (Step 2) ──
  { name: 'cpc',                 type: 'REAL' },
  { name: 'frequency',           type: 'REAL' },
  { name: 'reach',               type: 'REAL' },
  { name: 'impressions',         type: 'REAL' },
  { name: 'roas',                type: 'REAL' },
  { name: 'conversion_rate',     type: 'REAL' },
  { name: 'engagement_rate',     type: 'REAL' },
  { name: 'comments',            type: 'REAL' },
  { name: 'shares',              type: 'REAL' },
  { name: 'likes',               type: 'REAL' },
  { name: 'saves',               type: 'REAL' },
  { name: 'link_clicks',         type: 'REAL' },
  { name: 'outbound_ctr',        type: 'REAL' },
  { name: 'landing_page_views',  type: 'REAL' },
  { name: 'unique_ctr',          type: 'REAL' },
  { name: 'video_3sec_plays',    type: 'REAL' },
  { name: 'thumb_stop_rate',     type: 'REAL' },
  // ── Additional real creative-content fields (Step 1) ──
  { name: 'destination_url',     type: 'TEXT' },
  { name: 'media_hash',          type: 'TEXT' },
  { name: 'aspect_ratio',        type: 'TEXT' },
  { name: 'media_type',          type: 'TEXT' },
  { name: 'is_dynamic_creative', type: 'INTEGER NOT NULL DEFAULT 0' },
  // ── AI Analysis (Step 3) — structured qualitative output, one JSON blob
  //    (many small text/label fields; matches this codebase's existing
  //    pattern of storing structured-but-variable detail as JSON, e.g.
  //    diagnosis_history.factors, analytics_breakdown_history.actions_json) ──
  { name: 'ai_analysis_json',    type: 'TEXT' },
  // ── Creative Score (Step 4) — 0-100 per dimension + overall ──
  { name: 'score_hook',                  type: 'REAL' },
  { name: 'score_headline',              type: 'REAL' },
  { name: 'score_copy',                  type: 'REAL' },
  { name: 'score_visual',                type: 'REAL' },
  { name: 'score_cta',                   type: 'REAL' },
  { name: 'score_offer',                 type: 'REAL' },
  { name: 'score_trust',                 type: 'REAL' },
  { name: 'score_psychology',            type: 'REAL' },
  { name: 'score_conversion_potential',  type: 'REAL' },
  { name: 'score_scroll_stop',           type: 'REAL' },
  { name: 'score_retention',             type: 'REAL' },
  { name: 'score_brand',                 type: 'REAL' },
  { name: 'score_fatigue',               type: 'REAL' },
  { name: 'score_overall',               type: 'REAL' },
  // ── Creative Fatigue Detection (Step 5) ──
  { name: 'fatigue_status',          type: 'TEXT' }, // 'none'|'early'|'moderate'|'severe'
  { name: 'fatigue_recommendation',  type: 'TEXT' }, // 'scale'|'monitor'|'refresh'|'duplicate'|'pause'
];

function runPhase21Migrations() {
  ensureMigrationsTable();
  const existingCols = db.all("PRAGMA table_info(creative_analytics)").map(c => c.name);

  let added = 0;
  for (const col of NEW_COLUMNS) {
    if (existingCols.includes(col.name)) continue; // idempotent guard
    try {
      db.run(`ALTER TABLE creative_analytics ADD COLUMN ${col.name} ${col.type}`);
      added++;
    } catch (err) {
      console.warn(`[DB] Phase 21: could not add column ${col.name}:`, err.message);
    }
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_creative_analytics_score ON creative_analytics(meta_campaign_id, score_overall)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_creative_analytics_fatigue ON creative_analytics(fatigue_status)`);

  markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    db.persist();
    console.log(`[DB] Phase 21 migration complete — added ${added} column(s) to creative_analytics.`);
  } else {
    console.log('[DB] Phase 21 schema: Creative Intelligence columns already present, skipping.');
  }
}

module.exports = { runPhase21Migrations };
