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

  const results = [];

  for (const camp of campaigns) {
    // Latest health score
    const latestScore = db.get(`
      SELECT health_score, health_status, score_breakdown, calculated_at
      FROM health_score_history
      WHERE entity_meta_id = ? AND entity_type = 'campaign'
      ORDER BY calculated_at DESC LIMIT 1
    `, [camp.meta_campaign_id]);

    if (!latestScore) continue; // skip unscored campaigns

    // Recent score history for trend
    const scoreHistory = db.all(`
      SELECT health_score, calculated_at
      FROM health_score_history
      WHERE entity_meta_id = ? AND entity_type = 'campaign'
      ORDER BY calculated_at DESC LIMIT 10
    `, [camp.meta_campaign_id]);

    // Alert counts
    const alertCounts = db.get(`
      SELECT
        SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN severity='warning'  THEN 1 ELSE 0 END) as warning
      FROM active_alerts
      WHERE entity_meta_id = ? AND status = 'active'
    `, [camp.meta_campaign_id]);

    // Active recommendation count
    const recCount = db.get(`
      SELECT COUNT(*) as count FROM recommendation_log
      WHERE entity_meta_id = ? AND dismissed_at IS NULL
    `, [camp.meta_campaign_id]);

    // Extract frequency from score_breakdown if stored
    let frequency = null;
    try {
      const breakdown = latestScore.score_breakdown
        ? JSON.parse(latestScore.score_breakdown)
        : {};
      frequency = breakdown.frequency?.value ?? null;
    } catch {}

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
      recommendation_count: recCount?.count || 0,
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

module.exports = { getTopWinners, computeWinnerScore, detectTrend };
