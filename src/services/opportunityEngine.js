/**
 * Opportunity Engine — Phase 5
 *
 * Detects four categories of opportunity per campaign:
 *   1. Ready To Scale     — strong performance, low frequency saturation
 *   2. Audience Expansion — good performance but audience showing saturation signs
 *   3. Creative Testing   — CTR declining with otherwise healthy metrics
 *   4. Budget Reallocation— strong performance but constrained by low budget
 *
 * Each opportunity includes:
 *   - type, campaign info, reason, expected_impact, confidence, supporting_metrics
 *
 * Reuses: health_score_history, recommendation_log, active_alerts (DB only)
 */

const db = require('../db/database');
const { detectTrend, loadLatestScoresMap, loadScoreHistoryMap, loadAlertCountsMap } = require('./topWinnersEngine');
const { resolveProfile, DEFAULT_OPPORTUNITY_THRESHOLDS } = require('./kpiProfileResolver');

// ─────────────────────────────────────────────
// Resolve the gating thresholds for one objective. These four opportunity
// types' thresholds used to be universal literals with no objective
// awareness at all -- now sourced from the KPI Profile Resolver (a
// profile's own `opportunityThresholds` overrides the shared default, none
// currently define one, so behavior is unchanged until a profile is
// deliberately tuned).
// ─────────────────────────────────────────────
function resolveOpportunityThresholds(objective) {
  const profile = resolveProfile(objective);
  return { ...DEFAULT_OPPORTUNITY_THRESHOLDS, ...(profile.opportunityThresholds || {}) };
}

// ─────────────────────────────────────────────
// Opportunity type definitions
// ─────────────────────────────────────────────
const OPPORTUNITY_TYPES = {
  READY_TO_SCALE:        'Ready To Scale',
  AUDIENCE_EXPANSION:    'Audience Expansion',
  CREATIVE_TESTING:      'Creative Testing',
  BUDGET_REALLOCATION:   'Budget Reallocation',
};

// ─────────────────────────────────────────────
// Confidence level based on data strength
// ─────────────────────────────────────────────
function computeConfidence(healthScore, historyCount, alertCount) {
  let pts = 0;
  if (healthScore >= 80) pts += 3;
  else if (healthScore >= 60) pts += 2;
  else pts += 1;
  if (historyCount >= 5) pts += 2;
  else if (historyCount >= 2) pts += 1;
  if (alertCount === 0) pts += 1;
  if (pts >= 5) return 'high';
  if (pts >= 3) return 'medium';
  return 'low';
}

// ─────────────────────────────────────────────
// Extract metric from score_breakdown JSONB
// ─────────────────────────────────────────────
function extractFromBreakdown(breakdownJson, metricKey) {
  try {
    const bd = breakdownJson ? JSON.parse(breakdownJson) : {};
    return bd[metricKey]?.value ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Detect opportunities for one campaign
// ─────────────────────────────────────────────
function detectOpportunitiesForCampaign(camp, latestScore, scoreHistory, alertCounts, activeRecs) {
  const opportunities = [];
  const hs    = latestScore.health_score;
  const freq  = extractFromBreakdown(latestScore.score_breakdown, 'frequency');
  const trend = detectTrend(scoreHistory);
  const criticalAlerts = alertCounts?.critical || 0;
  const warningAlerts  = alertCounts?.warning  || 0;
  const thresholds = resolveOpportunityThresholds(camp.objective);

  const histCount = scoreHistory.length;
  const confidence = computeConfidence(hs, histCount, criticalAlerts + warningAlerts);

  // ── 1. Ready To Scale ─────────────────────
  // Criteria: health >= 70, frequency < 3.5, no critical alerts, not declining
  if (
    hs >= thresholds.readyToScaleHealthMin &&
    (freq === null || parseFloat(freq) < thresholds.readyToScaleFrequencyMax) &&
    criticalAlerts === 0 &&
    trend !== 'declining'
  ) {
    const scalePct = hs >= 85 ? 50 : hs >= 75 ? 30 : 20;
    opportunities.push({
      type:         OPPORTUNITY_TYPES.READY_TO_SCALE,
      priority:     hs >= 80 ? 'high' : 'medium',
      reason:       `Health score ${hs}/100 with low frequency saturation${freq ? ` (${parseFloat(freq).toFixed(1)})` : ''} and ${trend} trend. Budget increase is justified.`,
      suggested_action: `Increase budget by +${scalePct}% and monitor frequency daily.`,
      expected_impact:  `Estimated +${scalePct}% result volume with controlled cost increase.`,
      confidence,
      supporting_metrics: {
        health_score: hs,
        frequency:    freq ? parseFloat(freq).toFixed(1) : 'N/A',
        trend_direction: trend,
        critical_alerts: criticalAlerts,
      },
    });
  }

  // ── 2. Audience Expansion ─────────────────
  // Criteria: health >= 65, frequency >= 3.5, performance still decent
  if (
    hs >= thresholds.audienceExpansionHealthMin &&
    freq !== null && parseFloat(freq) >= thresholds.audienceExpansionFrequencyMin && parseFloat(freq) < thresholds.audienceExpansionFrequencyMax &&
    criticalAlerts === 0
  ) {
    opportunities.push({
      type:         OPPORTUNITY_TYPES.AUDIENCE_EXPANSION,
      priority:     parseFloat(freq) >= 5.0 ? 'high' : 'medium',
      reason:       `Frequency ${parseFloat(freq).toFixed(1)} indicates current audience is approaching saturation while performance is still strong.`,
      suggested_action: 'Duplicate this ad set with a lookalike or expanded interest audience to reach fresh users.',
      expected_impact:  'Maintain current performance levels while reaching new potential customers.',
      confidence,
      supporting_metrics: {
        health_score: hs,
        frequency:    parseFloat(freq).toFixed(1),
        health_status: latestScore.health_status,
      },
    });
  }

  // ── 3. Creative Testing ───────────────────
  // Criteria: check if a HIGH_FREQUENCY or LOW_CTR rec exists without
  // ROAS/CPL being critical. ('AD_FATIGUE' was removed from this list --
  // it is not a seeded recommendation_rules code and recommendationEngine
  // never produces it, so it could never match a real row.)
  const hasFatigueRec = activeRecs.some(r =>
    r.entity_meta_id === camp.meta_campaign_id &&
    ['HIGH_FREQUENCY', 'LOW_CTR'].includes(r.rule_code)
  );
  const hasROASCritical = activeRecs.some(r =>
    r.entity_meta_id === camp.meta_campaign_id && r.rule_code === 'LOW_ROAS'
  );

  if (hasFatigueRec && !hasROASCritical && hs >= thresholds.creativeTestingHealthMin) {
    opportunities.push({
      type:         OPPORTUNITY_TYPES.CREATIVE_TESTING,
      priority:     'medium',
      reason:       'CTR signals and/or frequency indicate creative fatigue. Core metrics are still viable — a creative refresh can extend campaign life.',
      suggested_action: 'Launch 2–3 new creative variations (new hook, different format, or fresh visual) within this ad set.',
      expected_impact:  'Restore CTR to previous levels and reduce CPR/CPL by 15–25%.',
      confidence:   'medium',
      supporting_metrics: {
        health_score: hs,
        frequency:    freq ? parseFloat(freq).toFixed(1) : 'N/A',
        fatigue_signals: activeRecs.filter(r => r.entity_meta_id === camp.meta_campaign_id).map(r => r.rule_code),
      },
    });
  }

  // ── 4. Budget Reallocation ────────────────
  // Criteria: top-scoring campaign (winner) — flag that budget could shift here from losers
  if (hs >= thresholds.budgetReallocationHealthMin && trend !== 'declining' && criticalAlerts === 0) {
    opportunities.push({
      type:         OPPORTUNITY_TYPES.BUDGET_REALLOCATION,
      priority:     'low',
      reason:       `This campaign shows strong results (score ${hs}/100). Reallocating budget from underperforming campaigns could amplify returns.`,
      suggested_action: 'Review budget distribution across all campaigns. Consider moving 10–20% of budget from Critical-score campaigns here.',
      expected_impact:  'Improved overall account ROAS by concentrating spend on proven performers.',
      confidence:   'medium',
      supporting_metrics: {
        health_score: hs,
        trend_direction: trend,
      },
    });
  }

  return opportunities;
}

// ─────────────────────────────────────────────
// MAIN: Run opportunity engine across all campaigns
// ─────────────────────────────────────────────
function detectAllOpportunities(limit = 10) {
  const campaigns = db.all(`
    SELECT c.id, c.meta_campaign_id, c.name, c.objective, c.status,
           a.account_name, a.currency
    FROM campaigns c
    JOIN ad_accounts a ON c.ad_account_id = a.id
    WHERE c.status IN ('active','paused')
  `);

  const activeRecs = db.all(`
    SELECT rule_code, entity_meta_id, severity FROM recommendation_log
    WHERE dismissed_at IS NULL AND action_taken IS NOT 1
  `);

  // Bulk-loaded once for every campaign instead of 3 queries PER campaign
  // (latest score, 10-row history, alert counts) -- same fix and same
  // shared loaders as topWinnersEngine.js/topLosersEngine.js.
  const latestScores = loadLatestScoresMap('campaign');
  const scoreHistories = loadScoreHistoryMap('campaign', 10);
  const alertCountsByEntity = loadAlertCountsMap();

  const allOpportunities = [];

  for (const camp of campaigns) {
    const latestScore = latestScores.get(camp.meta_campaign_id);
    if (!latestScore) continue;

    const scoreHistory = scoreHistories.get(camp.meta_campaign_id) || [];
    const alertCounts = alertCountsByEntity.get(camp.meta_campaign_id);

    const opportunities = detectOpportunitiesForCampaign(
      camp, latestScore, scoreHistory, alertCounts, activeRecs
    );

    for (const opp of opportunities) {
      allOpportunities.push({
        ...opp,
        meta_campaign_id: camp.meta_campaign_id,
        campaign_name:    camp.name,
        objective:        camp.objective,
        account_name:     camp.account_name,
        health_score:     latestScore.health_score,
      });
    }
  }

  // Sort: high priority first, then by health score
  const priorityRank = { high: 3, medium: 2, low: 1 };
  allOpportunities.sort((a, b) =>
    (priorityRank[b.priority] || 0) - (priorityRank[a.priority] || 0) ||
    b.health_score - a.health_score
  );

  return allOpportunities.slice(0, limit);
}

module.exports = { detectAllOpportunities, OPPORTUNITY_TYPES, resolveOpportunityThresholds };
