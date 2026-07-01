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
 * Run the shared health/benchmark/recommendation/alert/trend sequence for
 * any entity type (campaign, ad_set, or ad). This is the sequence that
 * used to be duplicated inline (with only entityType threaded through
 * differently) across intelligenceOrchestrator.js, adIntelligence.js, and
 * adSetIntelligence.js. Goal achievement is intentionally NOT part of this
 * shared sequence -- it only applies at the campaign level, since
 * account_targets has no ad-set/ad-level granularity.
 *
 * @param {object} entity - Must have meta_campaign_id (used as the
 *   entity_meta_id key in every table this touches -- for ads/ad sets this
 *   is a synthetic entity object with meta_campaign_id repurposed to hold
 *   the ad's/ad set's own meta ID, matching the existing convention in
 *   adIntelligence.js/adSetIntelligence.js) and objective/name.
 * @param {object} currentMetrics
 * @param {object} priorMetrics
 * @param {string} adAccountId
 * @param {string} entityType - 'campaign' | 'ad_set' | 'ad'
 */
function runScoringPipeline(entity, currentMetrics, priorMetrics, adAccountId, entityType = 'campaign') {
  const entityMetaId = entity.meta_campaign_id;

  const healthResult = calculateHealthScore(entity, currentMetrics, adAccountId);
  saveHealthScore(entity, adAccountId, healthResult, entityType);

  const benchmarkResult = evaluateBenchmarks(entity, currentMetrics, adAccountId);

  const newRecommendations = runRecommendationEngine(
    entity, currentMetrics, adAccountId, healthResult.health_score, entityType
  );
  const recommendations = loadActiveRecommendations(entityMetaId, entityType);

  const newAlerts = runAlertEngine(
    entity, currentMetrics, priorMetrics || null, adAccountId, entityType
  );
  const alerts = loadActiveAlerts(entityMetaId, entityType);

  const trend = getHealthScoreTrend(entityMetaId, 30, entityType);

  return {
    healthResult,
    benchmarkResult,
    recommendations,
    alerts,
    trend,
    newRecommendationsCount: newRecommendations.length,
    newAlertsCount: newAlerts.length,
  };
}

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

  const {
    healthResult, benchmarkResult, recommendations, alerts, trend,
    newRecommendationsCount, newAlertsCount,
  } = runScoringPipeline(campaign, currentMetrics, priorMetrics, adAccountId, 'campaign');

  // Goal Achievement is campaign-only — not part of the shared sequence.
  const goalResult = evaluateGoalAchievement(campaign, currentMetrics, adAccountId);

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

    recommendations,

    alerts,

    meta: {
      fetched_at:   new Date().toISOString(),
      duration_ms:  durationMs,
      new_recommendations_fired: newRecommendationsCount,
      new_alerts_fired:          newAlertsCount,
    },
  };
}

module.exports = { runIntelligencePipeline, runScoringPipeline };
