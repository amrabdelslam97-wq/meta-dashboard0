/**
 * Top Winners Engine — Phase 5
 *
 * Identifies campaigns with strong performance across:
 *   - Health Score (primary signal)
 *   - Goal Achievement status
 *   - Frequency saturation (low = room to grow)
 *   - Trend direction (improving vs declining)
 *   - Active alert severity (fewer = better)
 *
 * Reuses: health_score_history, recommendation_log, active_alerts from DB.
 * Does NOT call Meta API directly.
 */

const db = require('../db/database');

/**
 * Score a campaign for "winner" ranking.
 * Higher = better winner candidate.
 */
function computeWinnerScore(data) {
  let score = 0;

  // Health score contributes 40 points max
  if (data.health_score !== null) {
    score += (data.health_score / 100) * 40;
  }

  // Goal achievement contributes 25 points
  const goalPoints = { 'Exceeded': 25, 'On Track': 18, 'At Risk': 8, 'Missed': 0 };
  score += goalPoints[data.goal_status] || 12; // 12 = no targets set (neutral)

  // Frequency safety contributes 15 points (lower frequency = safer to scale)
  // We approximate from health score breakdown if available
  if (data.frequency !== null && data.frequency !== undefined) {
    const freq = parseFloat(data.frequency);
    if (freq < 2.0)      score += 15;
    else if (freq < 3.0) score += 12;
    else if (freq < 4.0) score += 7;
    else if (freq < 5.0) score += 3;
    // freq >= 5.0 → 0 points (saturated)
  } else {
    score += 8; // neutral when unknown
  }

  // Trend direction contributes 10 points
  const trendPoints = { improving: 10, stable: 6, declining: 0 };
  score += trendPoints[data.trend_direction] || 6;

  // Alert penalty: deduct up to 10 points
  if (data.critical_alerts > 0) score -= 10;
  else if (data.warning_alerts > 0) score -= data.warning_alerts * 3;

  // Active campaign bonus
  if (data.status === 'active') score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determine trend direction from last N health scores.
 */
function detectTrend(scores) {
  if (!scores || scores.length < 2) return 'stable';
  const recent = scores.slice(0, 3).map(s => s.health_score);
  const older  = scores.slice(3, 6).map(s => s.health_score);
  if (older.length === 0) return 'stable';
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg  = older.reduce((a, b) => a + b, 0) / older.length;
  const diff = recentAvg - olderAvg;
  if (diff > 5)  return 'improving';
  if (diff < -5) return 'declining';
  return 'stable';
}

// ─────────────────────────────────────────────
// Bulk data loaders, shared with topLosersEngine.js/opportunityEngine.js.
//
// The original design issued 1 query to list campaigns, then 3-4 MORE
// queries PER CAMPAIGN (latest score, 10-row history, alert counts, rec
// count) -- O(4n) queries to return a top-5 list. These loaders instead
// fetch each signal for every relevant campaign in a single query and
// return a Map keyed by entity_meta_id, turning the per-campaign lookups
// below into O(1) in-memory Map.get() calls. The scoring logic itself
// (computeWinnerScore, detectTrend, etc.) is unchanged -- only how the
// underlying data is fetched.
// ─────────────────────────────────────────────

/**
 * Latest health score (with score_breakdown) per entity, one query.
 */
function loadLatestScoresMap(entityType = 'campaign') {
  const rows = db.all(`
    SELECT h.entity_meta_id, h.health_score, h.health_status, h.score_breakdown, h.calculated_at
    FROM health_score_history h
    INNER JOIN (
      SELECT entity_meta_id, MAX(calculated_at) as latest
      FROM health_score_history WHERE entity_type = ?
      GROUP BY entity_meta_id
    ) m ON h.entity_meta_id = m.entity_meta_id AND h.calculated_at = m.latest
    WHERE h.entity_type = ?
  `, [entityType, entityType]);

  const map = new Map();
  for (const row of rows) map.set(row.entity_meta_id, row);
  return map;
}

/**
 * Up to `limitPerEntity` most recent (health_score, calculated_at) rows
 * per entity, one query total. SQLite has no portable "LIMIT N per group",
 * so this loads every row ordered per-entity and trims to N in JS -- still
 * one query regardless of campaign count, trading some extra rows fetched
 * for eliminating the N+1 round trips.
 */
function loadScoreHistoryMap(entityType = 'campaign', limitPerEntity = 10) {
  const rows = db.all(`
    SELECT entity_meta_id, health_score, calculated_at
    FROM health_score_history
    WHERE entity_type = ?
    ORDER BY entity_meta_id, calculated_at DESC
  `, [entityType]);

  const map = new Map();
  for (const row of rows) {
    let arr = map.get(row.entity_meta_id);
    if (!arr) { arr = []; map.set(row.entity_meta_id, arr); }
    if (arr.length < limitPerEntity) arr.push(row);
  }
  return map;
}

/**
 * Active critical/warning alert counts per entity, one query.
 */
function loadAlertCountsMap() {
  const rows = db.all(`
    SELECT entity_meta_id,
      SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN severity='warning'  THEN 1 ELSE 0 END) as warning
    FROM active_alerts
    WHERE status = 'active'
    GROUP BY entity_meta_id
  `);
  const map = new Map();
  for (const row of rows) map.set(row.entity_meta_id, row);
  return map;
}

/**
 * Non-dismissed recommendation counts per entity, one query.
 * `dismissedFilter` also excludes action_taken rows when requested (used
 * by topLosersEngine's "unresolved recommendations" signal).
 */
function loadRecommendationCountsMap({ excludeActionTaken = false } = {}) {
  const rows = db.all(`
    SELECT entity_meta_id, COUNT(*) as count
    FROM recommendation_log
    WHERE dismissed_at IS NULL ${excludeActionTaken ? 'AND action_taken IS NOT 1' : ''}
    GROUP BY entity_meta_id
  `);
  const map = new Map();
  for (const row of rows) map.set(row.entity_meta_id, row.count);
  return map;
}

/**
 * Extract the frequency value from a stored score_breakdown JSON blob.
 */
function extractFrequency(scoreBreakdownJson) {
  try {
    const breakdown = scoreBreakdownJson ? JSON.parse(scoreBreakdownJson) : {};
    return breakdown.frequency?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Main function: returns top N winner campaigns.
 */
function getTopWinners(limit = 5) {
  const campaigns = db.all(`
    SELECT c.id, c.meta_campaign_id, c.name, c.objective, c.status,
           c.ad_account_id,
           a.account_name, a.currency
    FROM campaigns c
    JOIN ad_accounts a ON c.ad_account_id = a.id
    WHERE c.status IN ('active','paused')
  `);

  const latestScores = loadLatestScoresMap('campaign');
  const scoreHistories = loadScoreHistoryMap('campaign', 10);
  const alertCountsByEntity = loadAlertCountsMap();
  const recCountsByEntity = loadRecommendationCountsMap();

  const results = [];

  for (const camp of campaigns) {
    const latestScore = latestScores.get(camp.meta_campaign_id);
    if (!latestScore) continue;

    const scoreHistory = scoreHistories.get(camp.meta_campaign_id) || [];
    const alertCounts = alertCountsByEntity.get(camp.meta_campaign_id);
    const recCount = recCountsByEntity.get(camp.meta_campaign_id) || 0;

    const frequency = extractFrequency(latestScore.score_breakdown);
    const trendDirection = detectTrend(scoreHistory);

    const data = {
      health_score:    latestScore.health_score,
      goal_status:     null, // Phase 5: simplified — could hook goal engine here
      frequency,
      trend_direction: trendDirection,
      critical_alerts: alertCounts?.critical || 0,
      warning_alerts:  alertCounts?.warning  || 0,
      status:          camp.status,
    };

    const winnerScore = computeWinnerScore(data);

    results.push({
      meta_campaign_id: camp.meta_campaign_id,
      campaign_name:    camp.name,
      objective:        camp.objective,
      status:           camp.status,
      account_name:     camp.account_name,
      health_score:     latestScore.health_score,
      health_status:    latestScore.health_status,
      winner_score:     winnerScore,
      trend_direction:  trendDirection,
      frequency,
      critical_alerts:  alertCounts?.critical || 0,
      warning_alerts:   alertCounts?.warning  || 0,
      recommendation_count: recCount,
      last_scored_at:   latestScore.calculated_at,
      strengths: buildStrengths(latestScore, trendDirection, alertCounts),
    });
  }

  // Sort by winner_score descending, then health_score
  results.sort((a, b) => b.winner_score - a.winner_score || b.health_score - a.health_score);

  return results.slice(0, limit);
}

function buildStrengths(score, trend, alerts) {
  const s = [];
  if (score.health_score >= 80) s.push('Excellent health score');
  else if (score.health_score >= 60) s.push('Good health score');
  if (trend === 'improving') s.push('Improving trend');
  if (trend === 'stable') s.push('Stable performance');
  if (!alerts?.critical && !alerts?.warning) s.push('No active alerts');
  return s;
}

module.exports = {
  getTopWinners,
  computeWinnerScore,
  detectTrend,
  loadLatestScoresMap,
  loadScoreHistoryMap,
  loadAlertCountsMap,
  loadRecommendationCountsMap,
  extractFrequency,
};
