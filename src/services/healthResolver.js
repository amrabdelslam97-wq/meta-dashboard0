/**
 * Health Resolver
 *
 * Orchestrates kpiProfileResolver.js (which objective/profile applies) and
 * benchmarkResolver.js (the existing 3-tier account -> global -> platform
 * threshold resolution, unchanged) to produce a health score. This is
 * where the actual weighted-blend scoring math now lives -- moved out of
 * healthScoreEngine.js's calculateHealthScore(), which becomes a thin,
 * backward-compatible wrapper around resolveHealthScore() here (see that
 * file's header comment for why the math moved rather than being
 * duplicated).
 *
 * The math itself is 100% unchanged from the original calculateHealthScore
 * -- this is a structural move (introducing the Resolver layer the
 * project's engines are meant to consume, per the approved plan), not a
 * scoring behavior change. It still reads objective_scoring_configs keyed
 * by the entity's real campaign.objective (not a synthetic
 * profile-plus-optimization_goal key) -- the Video Views sub-profile
 * remains a display/benchmark-level distinction only, not a separately
 * weighted health score, per the approved plan's Decisions Made section.
 */

const db = require('../db/database');
const { resolveProfile } = require('./kpiProfileResolver');
const { resolveThresholds } = require('./benchmarkResolver');

// ─────────────────────────────────────────────────────────────
// Status thresholds
// ─────────────────────────────────────────────────────────────
function scoreToStatus(score) {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'warning';
  return 'critical';
}

// ─────────────────────────────────────────────────────────────
// Normalize a single metric value to 0–100
// ─────────────────────────────────────────────────────────────
function normalizeMetric(value, config) {
  if (value === null || value === undefined || isNaN(value)) return null;

  const { comparison_direction, excellent_threshold,
          optimal_low, optimal_high } = config;

  // Optimal range (e.g. Frequency — not too low, not too high)
  if (comparison_direction === 'optimal_range') {
    const low  = optimal_low  ?? 1.5;
    const high = optimal_high ?? 3.5;

    if (value < low) {
      // Below optimal: score rises linearly from 0 to 100 as value approaches low
      return Math.round(Math.min(100, (value / low) * 100));
    }
    if (value <= high) {
      return 100; // inside optimal band
    }
    // Above optimal: score falls linearly
    const overshoot = value - high;
    const maxOvershoot = high; // decay over a range equal to the optimal high
    return Math.round(Math.max(0, 100 - (overshoot / maxOvershoot) * 100));
  }

  const critical_threshold = config.critical_threshold;

  // Lower is better (CPR, CPL, CPA, CPM, CPC, Frequency-above-threshold)
  if (comparison_direction === 'lower_is_better') {
    if (value <= excellent_threshold) return 100;
    if (value >= critical_threshold)  return 0;
    return Math.round(
      100 * (critical_threshold - value) / (critical_threshold - excellent_threshold)
    );
  }

  // Higher is better (CTR, ROAS, Reach, Volume)
  if (value >= excellent_threshold) return 100;
  if (value <= critical_threshold)  return 0;
  return Math.round(
    100 * (value - critical_threshold) / (excellent_threshold - critical_threshold)
  );
}

// ─────────────────────────────────────────────────────────────
// Load scoring configs for an objective
// ─────────────────────────────────────────────────────────────
function loadScoringConfigs(objective) {
  return db.all(
    `SELECT * FROM objective_scoring_configs WHERE objective = ?`,
    [objective]
  );
}

// ─────────────────────────────────────────────────────────────
// Extract the relevant metric value from a metrics object. metricsFetcher
// .js's normalizeRow() (real Meta data) and every mock generator already
// produce the canonical metric_key names used by objective_scoring_configs
// directly, so no aliasing is needed here.
// ─────────────────────────────────────────────────────────────
function extractMetric(metrics, key) {
  if (metrics[key] !== undefined && metrics[key] !== null) {
    return parseFloat(metrics[key]);
  }
  return null;
}

/**
 * MAIN: resolve a health score for one entity.
 *
 * @param {object} campaign - must have .objective and .meta_campaign_id/.name
 *   (the entity being scored -- campaign, ad set, or ad, matching the
 *   existing convention where ad-set/ad callers pass a synthetic
 *   campaign-shaped object)
 * @param {object} metrics - normalized metrics (metricsFetcher.normalizeRow() output)
 * @param {string} adAccountId
 * @param {string|null} optimizationGoal - an ad set's optimization_goal,
 *   if known. Resolved into the KPI profile for context (e.g. so a caller
 *   can tell whether this score was computed against the Video Views
 *   sub-profile), but does NOT change which objective_scoring_configs
 *   rows are loaded -- see the file header for why.
 */
function resolveHealthScore(campaign, metrics, adAccountId, optimizationGoal = null) {
  const { objective } = campaign;
  const profile = resolveProfile(objective, optimizationGoal);

  const scoringConfigs = loadScoringConfigs(objective);

  if (!scoringConfigs.length) {
    return {
      health_score: 50,
      health_status: 'warning',
      score_reference: 'platform_default',
      breakdown: {},
      note: `No scoring config found for objective: ${objective}`,
      profile_key: profile.isVideoViewsVariant ? `${objective}.videoViews` : objective,
    };
  }

  const totalWeight = scoringConfigs.reduce((sum, c) => sum + c.weight, 0);

  let weightedTotal = 0;
  let weightUsed    = 0;
  const breakdown   = {};
  let scoreReference = 'platform_default';

  for (const config of scoringConfigs) {
    const value = extractMetric(metrics, config.metric_key);

    if (value === null) {
      // Metric not available — skip it, redistribute weight
      breakdown[config.metric_key] = { value: null, normalized: null, weight: config.weight };
      continue;
    }

    // Resolve thresholds (existing 3-tier account -> global -> platform system, unchanged)
    const thresholds = resolveThresholds(objective, config.metric_key, adAccountId, config);
    if (thresholds.source !== 'platform_default') {
      scoreReference = 'benchmark';
    }

    const normalized = normalizeMetric(value, thresholds);

    if (normalized !== null) {
      weightedTotal += normalized * config.weight;
      weightUsed    += config.weight;
    }

    breakdown[config.metric_key] = {
      value:      Math.round(value * 100) / 100,
      normalized,
      weight:     config.weight,
      source:     thresholds.source,
    };
  }

  // Blend the weighted average of available metrics with a neutral 50,
  // proportional to how much of the objective's total scoring weight was
  // actually available (see healthScoreEngine.js's original comment /
  // the T4-01 regression test for the full rationale -- unchanged here).
  let finalScore = 50;
  if (weightUsed > 0 && totalWeight > 0) {
    const coverage = weightUsed / totalWeight;
    finalScore = Math.round((weightedTotal / totalWeight) + 50 * (1 - coverage));
  }

  finalScore = Math.max(0, Math.min(100, finalScore));

  return {
    health_score:    finalScore,
    health_status:   scoreToStatus(finalScore),
    score_reference: scoreReference,
    breakdown,
    profile_key: profile.isVideoViewsVariant ? `${objective}.videoViews` : objective,
  };
}

module.exports = {
  resolveHealthScore,
  normalizeMetric,
  scoreToStatus,
  extractMetric,
};
