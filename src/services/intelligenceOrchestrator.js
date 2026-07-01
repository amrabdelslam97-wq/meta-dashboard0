/**
 * Intelligence Orchestrator
 *
 * Coordinates the full intelligence pipeline for one campaign:
 *   1. Health Score Engine
 *   2. Benchmark Evaluation
 *   3. Goal Achievement Engine
 *   4. Recommendation Engine
 *   5. Alert Engine
 *
 * Returns a complete enriched intelligence object ready for API response.
 * Does NOT call Meta API — receives metrics as input.
 */

const { calculateHealthScore, saveHealthScore, getHealthScoreTrend } = require('./healthScoreEngine');
const { evaluateBenchmarks }      = require('./benchmarkEngine');
const { evaluateGoalAchievement } = require('./goalAchievementEngine');
const { runRecommendationEngine, loadActiveRecommendations } = require('./recommendationEngine');
const { runAlertEngine, loadActiveAlerts }                   = require('./alertEngine');

/**
 * Run the full intelligence pipeline for a single campaign.
 *
 * @param {object} campaign       - Campaign row from DB (id, meta_campaign_id, name, objective, ad_account_id)
 * @param {object} currentMetrics - Metrics for the current period (from Meta API or mock)
 * @param {object} priorMetrics   - Metrics for the prior period (optional — for alert comparison)
 * @param {string} adAccountId    - Internal ad_account_id (UUID)
 * @returns {object}              - Full intelligence result
 */
function runIntelligencePipeline(campaign, currentMetrics, priorMetrics, adAccountId) {
  const startedAt = Date.now();

  // ── 1. Health Score ──────────────────────────────────────────
  const healthResult = calculateHealthScore(campaign, currentMetrics, adAccountId);

  // Persist to history
  saveHealthScore(campaign, adAccountId, healthResult);

  // ── 2. Benchmark Evaluation ──────────────────────────────────
  const benchmarkResult = evaluateBenchmarks(campaign, currentMetrics, adAccountId);

  // ── 3. Goal Achievement ──────────────────────────────────────
  const goalResult = evaluateGoalAchievement(campaign, currentMetrics, adAccountId);

  // ── 4. Recommendations ──────────────────────────────────────
  // Run engine (writes to DB, deduplicates)
  const newRecommendations = runRecommendationEngine(
    campaign,
    currentMetrics,
    adAccountId,
    healthResult.health_score
  );

  // Load all active (non-dismissed) recommendations from DB
  const allRecommendations = loadActiveRecommendations(campaign.meta_campaign_id);

  // ── 5. Alerts ────────────────────────────────────────────────
  // Run engine (writes to DB, resolves cleared alerts)
  const newAlerts = runAlertEngine(
    campaign,
    currentMetrics,
    priorMetrics || null,
    adAccountId
  );

  // Load all active alerts from DB
  const allAlerts = loadActiveAlerts(campaign.meta_campaign_id);

  // ── 6. Health Score Trend ────────────────────────────────────
  const trend = getHealthScoreTrend(campaign.meta_campaign_id, 30);

  const durationMs = Date.now() - startedAt;

  return {
    campaign_id:    campaign.meta_campaign_id,
    campaign_name:  campaign.name,
    objective:      campaign.objective,

    health: {
      score:     healthResult.health_score,
      status:    healthResult.health_status,
      reference: healthResult.score_reference,
      breakdown: healthResult.breakdown,
      note:      healthResult.note ?? null,
      trend:     trend.map(t => ({
        score:        t.health_score,
        status:       t.health_status,
        calculated_at: t.calculated_at,
      })),
    },

    benchmark: {
      summary: benchmarkResult.summary,
      metrics: benchmarkResult.metrics,
    },

    goal_achievement: goalResult,

    recommendations: allRecommendations,

    alerts: allAlerts,

    meta: {
      fetched_at:   new Date().toISOString(),
      duration_ms:  durationMs,
      new_recommendations_fired: newRecommendations.length,
      new_alerts_fired:          newAlerts.length,
    },
  };
}

module.exports = { runIntelligencePipeline };
