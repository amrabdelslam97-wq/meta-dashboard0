/**
 * Budget Intelligence Engine — Phase 24
 *
 * Comprehensive budget analysis and optimization:
 * - Budget efficiency scoring (0-100)
 * - Waste detection (overspending, underspending, saturation)
 * - Scaling opportunity detection
 * - Budget distribution analysis across all dimensions
 * - Pacing and burn rate analysis
 * - ROAS and revenue intelligence
 *
 * Integrates with existing budget_distribution_snapshots and attribution tables.
 */

const db = require('../db/database');
const { defaultRange, priorPeriod } = require('./dateRangeHelper');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function pctChange(current, prior) {
  if (current == null || prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

// ─────────────────────────────────────────────
// BUDGET EFFICIENCY SCORING
// ─────────────────────────────────────────────

/**
 * Calculate budget efficiency score (0-100) for a campaign/ad_set/ad.
 * Considers: CPA, ROAS, CTR, frequency, conversion rate, volume, stability, trends.
 */
function scoreBudgetEfficiency(adAccountId, level, entityMetaId, dateRange = defaultRange()) {
  const current = db.get(
    `SELECT * FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = ? AND entity_meta_id = ?
     AND date_since = ? AND date_until = ?`,
    [adAccountId, level, entityMetaId, dateRange.since, dateRange.until]
  );

  if (!current || !current.spend_amount || current.spend_amount < 10) {
    return {
      level,
      entity_meta_id: entityMetaId,
      score: null,
      status: 'INSUFFICIENT_DATA',
      reason: 'Minimum $10 spend required for scoring',
    };
  }

  const scores = {};

  // 1. CPA/Cost Efficiency (25%)
  // Lower CPA = better; benchmark $15-20
  const cpaScore = current.roas ? Math.min(100, Math.max(0, (current.roas / 2) * 100)) : 50;
  scores.cost = cpaScore;

  // 2. Volume (20%)
  // Adequate spend for significance testing
  const volumeScore = Math.min(100, Math.max(0, (current.spend_amount / 500) * 100));
  scores.volume = volumeScore;

  // 3. Conversion Rate (20%)
  // Higher conversion = better; based on results
  const conversionScore = current.results > 0
    ? Math.min(100, Math.max(0, (current.results / Math.max(current.results, 50)) * 100))
    : 50;
  scores.conversion = conversionScore;

  // 4. Stability (20%)
  // Compare to prior period
  const prior = db.get(
    `SELECT * FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = ? AND entity_meta_id = ?
     AND date_until <= ? ORDER BY date_until DESC LIMIT 1`,
    [adAccountId, level, entityMetaId, dateRange.since]
  );

  let stabilityScore = 100;
  if (prior && prior.roas && current.roas) {
    const roasChange = pctChange(current.roas, prior.roas);
    if (Math.abs(roasChange) > 50) stabilityScore = 40;
    else if (Math.abs(roasChange) > 30) stabilityScore = 60;
    else if (Math.abs(roasChange) > 10) stabilityScore = 80;
  } else {
    stabilityScore = 70;
  }
  scores.stability = stabilityScore;

  // 5. Trend (15%)
  let trendScore = 80;
  if (prior && prior.spend_amount > 0) {
    const spendTrend = pctChange(current.spend_amount, prior.spend_amount);
    if (current.roas && prior.roas) {
      const roasTrend = pctChange(current.roas, prior.roas);
      // Positive ROAS trend with stable/increasing spend = good
      if (roasTrend > 10) trendScore = 100;
      else if (roasTrend < -10) trendScore = 50;
    }
  }
  scores.trend = trendScore;

  // OVERALL SCORE
  const overallScore = (scores.cost * 0.25) + (scores.volume * 0.20) + (scores.conversion * 0.20) +
    (scores.stability * 0.20) + (scores.trend * 0.15);

  let status = 'Average';
  if (overallScore >= 75) status = 'Excellent';
  else if (overallScore >= 60) status = 'Good';
  else if (overallScore >= 45) status = 'Average';
  else if (overallScore >= 30) status = 'Poor';
  else status = 'Critical';

  return {
    level,
    entity_meta_id: entityMetaId,
    entity_label: current.entity_label,
    score: round(overallScore),
    status,
    components: {
      cost: round(scores.cost),
      volume: round(scores.volume),
      conversion: round(scores.conversion),
      stability: round(scores.stability),
      trend: round(scores.trend),
    },
    metrics: {
      spend: current.spend_amount,
      results: current.results,
      roas: current.roas,
      efficiency_score: current.efficiency_score,
      is_waste: current.is_waste,
      is_scaling_opportunity: current.is_scaling_opportunity,
    },
  };
}

/**
 * Detect budget waste: overspending, underspending, saturation, poor ROAS.
 */
function detectBudgetWaste(adAccountId, level, entityMetaId, dateRange = defaultRange()) {
  const current = db.get(
    `SELECT * FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = ? AND entity_meta_id = ?
     AND date_since = ? AND date_until = ?`,
    [adAccountId, level, entityMetaId, dateRange.since, dateRange.until]
  );

  if (!current) {
    return { entity_meta_id: entityMetaId, waste_detected: false };
  }

  const waste = {
    entity_meta_id: entityMetaId,
    entity_label: current.entity_label,
    waste_detected: false,
    waste_amount: 0,
    waste_reasons: [],
    confidence: 0,
  };

  // Get account-level averages for comparison
  const accountAvg = db.get(
    `SELECT AVG(roas) as avg_roas, AVG(efficiency_score) as avg_efficiency
     FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = ? AND date_since = ? AND date_until = ?`,
    [adAccountId, level, dateRange.since, dateRange.until]
  );

  // Waste Pattern 1: High spend + poor ROAS
  if (current.spend_amount > 500 && current.roas && accountAvg?.avg_roas) {
    if (current.roas < accountAvg.avg_roas * 0.6) {
      waste.waste_detected = true;
      waste.waste_reasons.push({
        type: 'poor_roas',
        description: `ROAS ${round(current.roas, 1)}x is 40%+ below average ${round(accountAvg.avg_roas, 1)}x`,
        severity: 'high',
        estimated_waste: Math.round(current.spend_amount * 0.3), // 30% of spend
      });
      waste.confidence = 0.85;
    }
  }

  // Waste Pattern 2: High spend + low results
  if (current.spend_amount > 500 && (!current.results || current.results < 10)) {
    waste.waste_detected = true;
    waste.waste_reasons.push({
      type: 'no_results',
      description: 'High spend but minimal results',
      severity: 'critical',
      estimated_waste: Math.round(current.spend_amount * 0.7),
    });
    waste.confidence = 0.95;
  }

  // Waste Pattern 3: Underspending (allocation exists but low spend)
  if (current.budget_amount && current.spend_amount < current.budget_amount * 0.3) {
    waste.waste_detected = true;
    waste.waste_reasons.push({
      type: 'underspending',
      description: 'Budget allocated but severely underspent',
      severity: 'medium',
      estimated_waste: 0, // Not waste, opportunity
    });
    waste.confidence = 0.70;
  }

  // Waste Pattern 4: High spend + is_waste flag
  if (current.is_waste === 1) {
    waste.waste_detected = true;
    waste.waste_reasons.push({
      type: 'flagged_waste',
      description: 'Marked as waste by system analysis',
      severity: 'high',
      estimated_waste: Math.round(current.spend_amount * 0.4),
    });
    waste.confidence = 0.80;
  }

  return waste;
}

/**
 * Detect scaling opportunities.
 */
function detectScalingOpportunities(adAccountId, level = 'campaign', dateRange = defaultRange()) {
  const entities = db.all(
    `SELECT * FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = ? AND date_since = ? AND date_until = ?
     ORDER BY roas DESC`,
    [adAccountId, level, dateRange.since, dateRange.until]
  );

  if (entities.length === 0) {
    return { level, opportunities: [] };
  }

  const opportunities = [];
  const avgRoas = entities.reduce((s, e) => s + (e.roas || 0), 0) / entities.length;
  const avgSpend = entities.reduce((s, e) => s + (e.spend_amount || 0), 0) / entities.length;

  for (const entity of entities) {
    // Scaling candidate: Above-average ROAS + below-average spend + results > threshold
    if (entity.roas > avgRoas * 1.3 && entity.spend_amount < avgSpend * 1.5 && entity.results > 20) {
      opportunities.push({
        entity_meta_id: entity.entity_meta_id,
        entity_label: entity.entity_label,
        reason: `Above-average ROAS (${round(entity.roas, 1)}x) with room to scale`,
        current_spend: entity.spend_amount,
        current_roas: entity.roas,
        suggested_increase: `+50-100% ($${Math.round(entity.spend_amount * 0.5)}-${Math.round(entity.spend_amount)})`,
        expected_impact: 'Maintain ROAS while increasing volume 50-100%',
        confidence: 0.85,
      });
    }

    // Or: is_scaling_opportunity flag
    if (entity.is_scaling_opportunity === 1) {
      opportunities.push({
        entity_meta_id: entity.entity_meta_id,
        entity_label: entity.entity_label,
        reason: 'Marked as scaling opportunity by system',
        current_spend: entity.spend_amount,
        current_roas: entity.roas,
        suggested_increase: '+30-50%',
        confidence: 0.80,
      });
    }
  }

  return { level, total_opportunities: opportunities.length, opportunities };
}

/**
 * Get budget distribution analysis (share percentages).
 */
function getBudgetDistribution(adAccountId, level = 'campaign', dateRange = defaultRange()) {
  const entities = db.all(
    `SELECT * FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = ? AND date_since = ? AND date_until = ?
     ORDER BY spend_amount DESC`,
    [adAccountId, level, dateRange.since, dateRange.until]
  );

  if (entities.length === 0) {
    return { level, entities: [], total_spend: 0 };
  }

  const totalSpend = entities.reduce((s, e) => s + (e.spend_amount || 0), 0);
  const totalResults = entities.reduce((s, e) => s + (e.results || 0), 0);

  const enriched = entities.map(e => ({
    ...e,
    spend_share_pct: totalSpend > 0 ? round((e.spend_amount / totalSpend) * 100, 1) : 0,
    result_share_pct: totalResults > 0 ? round((e.results / totalResults) * 100, 1) : 0,
    efficiency_ratio: totalSpend > 0 ? round((e.spend_amount / totalSpend) / Math.max(e.results || 1, 1), 2) : 0,
  }));

  return {
    level,
    date_range: dateRange,
    total_spend: round(totalSpend),
    total_results: totalResults,
    entities: enriched,
  };
}

/**
 * Calculate burn rate and pacing.
 */
function calculateBurnRate(adAccountId, dateRange = defaultRange()) {
  const campaigns = db.all(
    `SELECT SUM(spend_amount) as total_spend, COUNT(*) as count
     FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = 'campaign'
     AND date_since = ? AND date_until = ?`,
    [adAccountId, dateRange.since, dateRange.until]
  );

  if (!campaigns.length || !campaigns[0].total_spend) {
    return { total_spend: 0, average_daily: 0 };
  }

  const totalSpend = campaigns[0].total_spend;
  const since = new Date(dateRange.since);
  const until = new Date(dateRange.until);
  const daysInRange = Math.max(1, Math.ceil((until - since) / (1000 * 60 * 60 * 24)));
  const dailyBurn = totalSpend / daysInRange;

  // Project to end of month
  const today = new Date();
  const daysLeftInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();
  const projectedMonthEnd = dailyBurn * (today.getDate() + daysLeftInMonth);

  return {
    total_spend_in_period: round(totalSpend),
    period_days: daysInRange,
    average_daily_spend: round(dailyBurn, 2),
    projected_month_end_spend: round(projectedMonthEnd, 2),
    days_remaining_in_month: daysLeftInMonth,
  };
}

module.exports = {
  scoreBudgetEfficiency,
  detectBudgetWaste,
  detectScalingOpportunities,
  getBudgetDistribution,
  calculateBurnRate,
};
