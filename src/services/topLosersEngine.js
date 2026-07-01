/**
 * Top Losers Engine — Phase 5
 *
 * Identifies campaigns with poor performance across:
 *   - Low / Critical Health Score
 *   - Declining trend
 *   - Critical active alerts
 *   - Missed goal achievement
 *   - High cost metrics (above thresholds)
 *
 * Returns ranked list for the Decision Center's "Needs Attention" section.
 */

const db = require('../db/database');
const {
  detectTrend,
  loadLatestScoresMap,
  loadScoreHistoryMap,
  loadAlertCountsMap,
  loadRecommendationCountsMap,
  extractFrequency,
} = require('./topWinnersEngine');

/**
 * Compute a "loser score" — higher = worse performer = more urgent attention.
 */
function computeLoserScore(data) {
  let score = 0;

  // Poor health score contributes most (0–40 points, inverted)
  if (data.health_score !== null) {
    score += ((100 - data.health_score) / 100) * 40;
  }

  // Critical alerts (10 points each, max 20)
  score += Math.min(data.critical_alerts * 10, 20);

  // Warning alerts (3 points each, max 9)
  score += Math.min(data.warning_alerts * 3, 9);

  // Declining trend (10 points)
  if (data.trend_direction === 'declining') score += 10;

  // Missed goals (8 points)
  if (data.goal_status === 'Missed') score += 8;
  else if (data.goal_status === 'At Risk') score += 4;

  // High frequency (saturation penalty, up to 8 points)
  if (data.frequency !== null && data.frequency !== undefined) {
    const freq = parseFloat(data.frequency);
    if (freq >= 6.0)      score += 8;
    else if (freq >= 5.0) score += 5;
    else if (freq >= 4.0) score += 2;
  }

  // Active recommendation count (minor signal)
  score += Math.min(data.recommendation_count * 1.5, 6);

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Build a list of specific problems for this campaign.
 */
function buildProblems(score, trend, alerts, frequency, recCount) {
  const problems = [];
  if (score.health_status === 'critical') problems.push('Critical health score');
  else if (score.health_status === 'warning') problems.push('Warning health score');
  if (trend === 'declining') problems.push('Performance declining over time');
  if (alerts?.critical > 0) problems.push(`${alerts.critical} critical alert${alerts.critical > 1 ? 's' : ''} active`);
  if (alerts?.warning  > 0) problems.push(`${alerts.warning} warning alert${alerts.warning > 1 ? 's' : ''} active`);
  if (frequency !== null && parseFloat(frequency) >= 5.0) problems.push(`High frequency (${parseFloat(frequency).toFixed(1)}) — audience fatigue`);
  if (recCount > 0) problems.push(`${recCount} unresolved recommendation${recCount > 1 ? 's' : ''}`);
  return problems;
}

/**
 * Main function: returns top N loser campaigns (most problematic first).
 *
 * Uses the same bulk-loaded Maps as topWinnersEngine (one query per signal
 * for every campaign, instead of 3-4 queries PER campaign) -- see the
 * loaders' own comments in topWinnersEngine.js for why.
 */
function getTopLosers(limit = 5) {
  const campaigns = db.all(`
    SELECT c.id, c.meta_campaign_id, c.name, c.objective, c.status,
           c.ad_account_id, a.account_name, a.currency
    FROM campaigns c
    JOIN ad_accounts a ON c.ad_account_id = a.id
    WHERE c.status IN ('active','paused')
  `);

  const latestScores = loadLatestScoresMap('campaign');
  const scoreHistories = loadScoreHistoryMap('campaign', 10);
  const alertCountsByEntity = loadAlertCountsMap();
  // Losers additionally exclude recommendations already marked action_taken.
  const recCountsByEntity = loadRecommendationCountsMap({ excludeActionTaken: true });

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
      health_score:        latestScore.health_score,
      goal_status:         null,
      frequency,
      trend_direction:     trendDirection,
      critical_alerts:     alertCounts?.critical || 0,
      warning_alerts:      alertCounts?.warning  || 0,
      recommendation_count: recCount,
    };

    const loserScore = computeLoserScore(data);

    // Only include campaigns that have at least one signal of poor performance
    const hasProblem = latestScore.health_score < 70
      || (alertCounts?.critical || 0) > 0
      || (alertCounts?.warning  || 0) > 0
      || trendDirection === 'declining'
      || recCount > 0;

    if (!hasProblem) continue;

    results.push({
      meta_campaign_id: camp.meta_campaign_id,
      campaign_name:    camp.name,
      objective:        camp.objective,
      status:           camp.status,
      account_name:     camp.account_name,
      health_score:     latestScore.health_score,
      health_status:    latestScore.health_status,
      loser_score:      loserScore,
      trend_direction:  trendDirection,
      frequency,
      critical_alerts:  alertCounts?.critical || 0,
      warning_alerts:   alertCounts?.warning  || 0,
      recommendation_count: recCount,
      last_scored_at:   latestScore.calculated_at,
      problems: buildProblems(latestScore, trendDirection, alertCounts, frequency, recCount),
    });
  }

  results.sort((a, b) => b.loser_score - a.loser_score);
  return results.slice(0, limit);
}

module.exports = { getTopLosers, computeLoserScore };
