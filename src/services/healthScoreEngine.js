/**
 * Health Score Engine
 *
 * Calculates a 0–100 health score per campaign.
 * Uses objective-specific weighted metrics from objective_scoring_configs.
 * Reference: benchmark_metrics (if exists) → platform default thresholds.
 *
 * Output:
 *   health_score  : 0–100
 *   health_status : excellent | good | warning | critical
 *   breakdown     : per-metric normalized scores
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
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

  const { comparison_direction, excellent_threshold, critical_threshold,
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
// Returns array of config rows ordered by metric_key
// ─────────────────────────────────────────────────────────────
function loadScoringConfigs(objective) {
  return db.all(
    `SELECT * FROM objective_scoring_configs WHERE objective = ?`,
    [objective]
  );
}

// ─────────────────────────────────────────────────────────────
// Extract the relevant metric value from a metrics object
// Handles aliasing (e.g. "cpr" might come in as "cost_per_result")
// ─────────────────────────────────────────────────────────────
function extractMetric(metrics, key) {
  // Direct match
  if (metrics[key] !== undefined && metrics[key] !== null) {
    return parseFloat(metrics[key]);
  }

  // Aliases
  const aliases = {
    cpr:               ['cost_per_result', 'cost_per_message', 'cost_per_action'],
    cpl:               ['cost_per_lead'],
    cpa:               ['cost_per_purchase', 'cost_per_conversion'],
    roas:              ['purchase_roas', 'website_purchase_roas'],
    purchases:         ['actions_purchase', 'website_purchases'],
    leads:             ['actions_lead', 'onsite_conversion_lead_grouped'],
    landing_page_views:['landing_page_view'],
    impressions:       ['impressions'],
    reach:             ['reach'],
    spend:             ['spend'],
    clicks:            ['clicks', 'link_clicks'],
    ctr:               ['ctr', 'link_ctr'],
    cpm:               ['cpm'],
    cpc:               ['cpc', 'cost_per_link_click'],
    frequency:         ['frequency'],
  };

  const aliasList = aliases[key] || [];
  for (const alias of aliasList) {
    if (metrics[alias] !== undefined && metrics[alias] !== null) {
      return parseFloat(metrics[alias]);
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// MAIN: Calculate health score for one campaign
// ─────────────────────────────────────────────────────────────
function calculateHealthScore(campaign, metrics, adAccountId) {
  const { objective } = campaign;

  // Load per-objective weights
  const scoringConfigs = loadScoringConfigs(objective);

  if (!scoringConfigs.length) {
    // Unknown objective — return neutral score
    return {
      health_score: 50,
      health_status: 'warning',
      score_reference: 'platform_default',
      breakdown: {},
      note: `No scoring config found for objective: ${objective}`,
    };
  }

  // Validate weights sum to ~1.0
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

    // Resolve thresholds
    const thresholds = resolveThresholds(objective, config.metric_key, adAccountId, config);
    if (thresholds.source !== 'platform_default') {
      scoreReference = 'benchmark';
    }

    const normalized = normalizeMetric(value, thresholds);

    if (normalized !== null) {
      // Normalize weight relative to available metrics
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
  // actually available. A campaign with only one of four metrics present
  // (e.g. CTR alone, weight 0.10 of 1.0) should land close to neutral, not
  // swing to that one metric's extreme — this is what redistributes trust
  // away from single-metric noise when data is genuinely incomplete.
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
  };
}

// ─────────────────────────────────────────────────────────────
// Persist health score to history table
// ─────────────────────────────────────────────────────────────
function saveHealthScore(campaign, adAccountId, scoreResult, entityType = 'campaign') {
  const now = new Date().toISOString();

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
