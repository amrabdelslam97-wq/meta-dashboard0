/**
 * Health Score Engine
 *
 * Calculates a 0–100 health score per campaign/ad set/ad, persists it to
 * history, and exposes trend lookups.
 *
 * The actual scoring math (loading objective_scoring_configs, resolving
 * thresholds, the weighted-blend formula) now lives in healthResolver.js
 * -- calculateHealthScore() here is a thin, backward-compatible wrapper
 * around healthResolver.resolveHealthScore() so intelligenceOrchestrator.js
 * (its only caller) needs no changes. scoreToStatus()/normalizeMetric()
 * are re-exported from healthResolver.js (not duplicated) so existing
 * importers of this module (portfolioEngine.js imports scoreToStatus;
 * tests import both) keep working unchanged. See healthResolver.js's
 * header comment for the full rationale.
 *
 * Output:
 *   health_score  : 0–100
 *   health_status : excellent | good | warning | critical
 *   breakdown     : per-metric normalized scores
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { resolveHealthScore, normalizeMetric, scoreToStatus } = require('./healthResolver');

/**
 * MAIN: Calculate health score for one entity (campaign, ad set, or ad).
 * @param {object} campaign - entity being scored (or a synthetic
 *   campaign-shaped object for ad sets/ads, matching the existing convention)
 * @param {object} metrics - normalized metrics
 * @param {string} adAccountId
 * @param {string|null} optimizationGoal - optional, an ad set's
 *   optimization_goal, threaded through to the KPI Profile Resolver for
 *   context (e.g. Video Views sub-profile detection) -- does not change
 *   which objective_scoring_configs rows are used to compute the score.
 */
function calculateHealthScore(campaign, metrics, adAccountId, optimizationGoal = null) {
  return resolveHealthScore(campaign, metrics, adAccountId, optimizationGoal);
}

// ─────────────────────────────────────────────────────────────
// Persist health score to history table
// ─────────────────────────────────────────────────────────────
// A new row is skipped when the score is identical to the last recorded
// one AND that last row is still recent (10 minutes -- matching the
// 'current' metrics cache TTL in cacheService.js, since the underlying
// Meta data can't meaningfully have changed within that window anyway).
// Previously this wrote unconditionally on every single call, meaning
// health_score_history (and, via database.js's full-export-per-write
// persist(), the cost of every write in the whole system) grew
// proportional to how often a campaign's insights were *viewed*, not to
// how often the score actually changed.
// ─────────────────────────────────────────────────────────────
const UNCHANGED_SCORE_SKIP_WINDOW_MS = 10 * 60 * 1000;

function saveHealthScore(campaign, adAccountId, scoreResult, entityType = 'campaign') {
  const now = new Date().toISOString();

  const last = db.get(
    `SELECT health_score, calculated_at FROM health_score_history
     WHERE entity_meta_id = ? AND entity_type = ?
     ORDER BY calculated_at DESC LIMIT 1`,
    [campaign.meta_campaign_id, entityType]
  );

  if (last && last.health_score === scoreResult.health_score) {
    const ageMs = Date.now() - new Date(last.calculated_at).getTime();
    if (ageMs < UNCHANGED_SCORE_SKIP_WINDOW_MS) {
      return; // unchanged and recent -- nothing new to record
    }
  }

  db.run(
    `INSERT INTO health_score_history
       (id, ad_account_id, entity_type, entity_meta_id, entity_label,
        objective, health_score, health_status, score_reference,
        score_breakdown, calculated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      uuidv4(),
      adAccountId,
      entityType,
      campaign.meta_campaign_id,
      campaign.name,
      campaign.objective,
      scoreResult.health_score,
      scoreResult.health_status,
      scoreResult.score_reference,
      JSON.stringify(scoreResult.breakdown),
      now,
    ]
  );
}

// ─────────────────────────────────────────────────────────────
// Get health score trend for a campaign (last N records)
// ─────────────────────────────────────────────────────────────
function getHealthScoreTrend(metaCampaignId, limit = 30, entityType = 'campaign') {
  return db.all(
    `SELECT health_score, health_status, calculated_at
     FROM health_score_history
     WHERE entity_meta_id = ? AND entity_type = ?
     ORDER BY calculated_at DESC
     LIMIT ?`,
    [metaCampaignId, entityType, limit]
  ).reverse(); // chronological order
}

module.exports = {
  calculateHealthScore,
  saveHealthScore,
  getHealthScoreTrend,
  scoreToStatus,
  normalizeMetric,
};
