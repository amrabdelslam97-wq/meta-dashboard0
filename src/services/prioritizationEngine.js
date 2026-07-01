/**
 * Prioritization Engine — Phase 5
 *
 * Computes a single priority score (0–100) for any decision item.
 * Considers: Health Score, Alert Severity, Spend Weight, Goal Achievement, Trend.
 *
 * Output priority labels:
 *   critical (80–100)
 *   high     (60–79)
 *   medium   (40–59)
 *   low      (0–39)
 */

// ─────────────────────────────────────────────
// Priority thresholds
// ─────────────────────────────────────────────
const PRIORITY_THRESHOLDS = {
  critical: 80,
  high:     60,
  medium:   40,
  // below 40 = low
};

function scoreToLabel(score) {
  if (score >= PRIORITY_THRESHOLDS.critical) return 'critical';
  if (score >= PRIORITY_THRESHOLDS.high)     return 'high';
  if (score >= PRIORITY_THRESHOLDS.medium)   return 'medium';
  return 'low';
}

/**
 * Compute priority score for a decision item.
 *
 * @param {object} params
 *   healthScore       0–100 (required)
 *   alertSeverity     'critical'|'warning'|'info'|null
 *   alertCount        number of active alerts
 *   trendDirection    'declining'|'stable'|'improving'
 *   goalStatus        'Missed'|'At Risk'|'On Track'|'Exceeded'|null
 *   spendAmount       raw spend value (used for relative weight)
 *   accountMaxSpend   highest spend in account (for normalization)
 *   objectiveWeight   multiplier based on campaign objective priority (optional)
 */
function computePriorityScore(params) {
  const {
    healthScore       = 50,
    alertSeverity     = null,
    alertCount        = 0,
    trendDirection    = 'stable',
    goalStatus        = null,
    spendAmount       = 0,
    accountMaxSpend   = 1,
    objectiveWeight   = 1.0,
  } = params;

  let score = 0;

  // ── 1. Health Score component (35 points max) ──
  // Poor health = higher urgency
  const healthUrgency = ((100 - healthScore) / 100) * 35;
  score += healthUrgency;

  // ── 2. Alert severity component (30 points max) ──
  const alertPoints = {
    critical: 30,
    warning:  18,
    info:     8,
    null:     0,
  };
  score += alertPoints[alertSeverity] || 0;
  // Additional alerts compound
  if (alertCount > 1) score += Math.min((alertCount - 1) * 3, 9);

  // ── 3. Trend direction component (15 points max) ──
  if (trendDirection === 'declining')  score += 15;
  else if (trendDirection === 'stable') score += 5;
  // improving: 0 points (not urgent)

  // ── 4. Goal status component (12 points max) ──
  const goalPoints = { Missed: 12, 'At Risk': 7, 'On Track': 2, Exceeded: 0 };
  score += goalPoints[goalStatus] || 4; // 4 = no targets (neutral)

  // ── 5. Spend weight component (8 points max) ──
  // Campaigns spending more are more impactful — prioritize their issues
  const spendRatio = accountMaxSpend > 0 ? Math.min(spendAmount / accountMaxSpend, 1) : 0;
  score += spendRatio * 8;

  // Apply objective weight multiplier
  score *= objectiveWeight;

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    priority_score: finalScore,
    priority:       scoreToLabel(finalScore),
    breakdown: {
      health_urgency:    Math.round(healthUrgency),
      alert_component:   alertPoints[alertSeverity] || 0,
      trend_component:   trendDirection === 'declining' ? 15 : trendDirection === 'stable' ? 5 : 0,
      goal_component:    goalPoints[goalStatus] || 4,
      spend_component:   Math.round(spendRatio * 8),
    },
  };
}

/**
 * Batch-rank a list of decision items.
 * Each item must have the fields expected by computePriorityScore.
 * Returns items sorted by priority_score descending.
 */
function rankDecisions(items) {
  return items
    .map(item => ({
      ...item,
      ...computePriorityScore({
        healthScore:     item.health_score,
        alertSeverity:   item.alert_severity || null,
        alertCount:      item.alert_count || 0,
        trendDirection:  item.trend_direction || 'stable',
        goalStatus:      item.goal_status || null,
        spendAmount:     item.spend || 0,
        accountMaxSpend: item._account_max_spend || 1,
      }),
    }))
    .sort((a, b) => b.priority_score - a.priority_score);
}

module.exports = {
  computePriorityScore,
  rankDecisions,
  scoreToLabel,
  PRIORITY_THRESHOLDS,
};
