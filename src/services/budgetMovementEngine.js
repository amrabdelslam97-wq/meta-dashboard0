/**
 * Budget Movement Engine — Phase 24
 *
 * Generate specific, actionable budget reallocation recommendations.
 * Suggests: Move $X from A to B, Reduce C by Y%, Increase D by Z%
 * Every recommendation includes: reason, confidence, expected impact, risk level.
 */

const db = require('../db/database');
const { defaultRange } = require('./dateRangeHelper');
const budgetIntel = require('./budgetIntelligenceEngine');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Generate budget movement recommendations for an account.
 */
function generateBudgetMovementRecommendations(adAccountId, dateRange = defaultRange()) {
  const recommendations = [];

  // Get all campaigns for analysis
  const campaigns = db.all(
    `SELECT * FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = 'campaign'
     AND date_since = ? AND date_until = ?`,
    [adAccountId, dateRange.since, dateRange.until]
  );

  if (campaigns.length === 0) {
    return { recommendations: [], total_recommendations: 0 };
  }

  const totalSpend = campaigns.reduce((s, c) => s + (c.spend_amount || 0), 0);
  const avgRoas = campaigns.reduce((s, c) => s + (c.roas || 0), 0) / campaigns.length;

  // STRATEGY 1: Move from underperformers to outperformers
  const underperformers = campaigns.filter(c => c.roas && c.roas < avgRoas * 0.7 && c.spend_amount > 100);
  const outperformers = campaigns.filter(c => c.roas && c.roas > avgRoas * 1.3);

  if (underperformers.length > 0 && outperformers.length > 0) {
    for (const under of underperformers) {
      const moveAmount = Math.round(under.spend_amount * 0.3); // Move 30%
      const bestPerformer = outperformers[0];

      recommendations.push({
        priority: 'high',
        type: 'budget_shift',
        action: `Move $${moveAmount} from ${under.entity_label} (ROAS: ${round(under.roas, 1)}x) to ${bestPerformer.entity_label} (ROAS: ${round(bestPerformer.roas, 1)}x)`,
        from_entity: {
          id: under.entity_meta_id,
          label: under.entity_label,
          current_spend: under.spend_amount,
          current_roas: under.roas,
        },
        to_entity: {
          id: bestPerformer.entity_meta_id,
          label: bestPerformer.entity_label,
          current_spend: bestPerformer.spend_amount,
          current_roas: bestPerformer.roas,
        },
        move_amount: moveAmount,
        reason: `${under.entity_label} ROAS is 30%+ below average; ${bestPerformer.entity_label} is 30%+ above average`,
        confidence: 0.85,
        expected_impact: {
          account_roas_improvement_pct: round((moveAmount / totalSpend) * (bestPerformer.roas - under.roas) * 10, 1),
          spending_efficiency_gain: 'Improve overall ROAS by 5-10%',
        },
        risk_level: 'low',
        risk_notes: 'Assumes performance continues; monitor closely for first week',
      });

      if (recommendations.length >= 5) break; // Limit recommendations
    }
  }

  // STRATEGY 2: Scale high performers with low spend
  const scalingCandidates = campaigns.filter(c =>
    c.roas > avgRoas * 1.2 &&
    c.spend_amount < totalSpend / campaigns.length * 0.8 &&
    c.results > 15
  );

  for (const candidate of scalingCandidates.slice(0, 3)) {
    const increaseBy = Math.round(candidate.spend_amount * 0.5); // +50%

    recommendations.push({
      priority: 'high',
      type: 'scale_up',
      action: `Increase ${candidate.entity_label} budget by 50% ($${increaseBy})`,
      entity: {
        id: candidate.entity_meta_id,
        label: candidate.entity_label,
        current_spend: candidate.spend_amount,
        current_roas: candidate.roas,
      },
      increase_amount: increaseBy,
      increase_pct: 50,
      reason: `High ROAS (${round(candidate.roas, 1)}x) with headroom to scale`,
      confidence: 0.80,
      expected_impact: {
        additional_revenue: `${round((increaseBy / candidate.spend_amount) * candidate.results)} additional conversions`,
        account_roas_impact: 'Potential +3-5% account ROAS',
      },
      risk_level: 'medium',
      risk_notes: 'Risk: Diminishing returns as spend scales; test incrementally',
    });
  }

  // STRATEGY 3: Pause or reduce severe waste
  const severe_waste = campaigns.filter(c =>
    c.spend_amount > 200 &&
    (!c.results || c.results < 5) &&
    c.roas < 0.5
  );

  for (const waste of severe_waste.slice(0, 2)) {
    recommendations.push({
      priority: 'critical',
      type: 'pause_or_reduce',
      action: `Pause ${waste.entity_label} immediately (or reduce by 80%)`,
      entity: {
        id: waste.entity_meta_id,
        label: waste.entity_label,
        current_spend: waste.spend_amount,
        current_results: waste.results,
      },
      reduce_by_pct: 80,
      reason: 'Poor ROAS with minimal results; significant budget waste',
      confidence: 0.95,
      expected_impact: {
        budget_saved: waste.spend_amount,
        account_roas_improvement_pct: round((waste.spend_amount / totalSpend) * 100, 1),
      },
      risk_level: 'low',
      risk_notes: 'None; this is clearly underperforming',
    });
  }

  return {
    account_id: adAccountId,
    date_range: dateRange,
    total_spend: round(totalSpend),
    total_recommendations: recommendations.length,
    recommendations: recommendations.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }),
  };
}

/**
 * Simulate budget reallocation impact.
 */
function simulateBudgetReallocation(adAccountId, movements, dateRange = defaultRange()) {
  const campaigns = db.all(
    `SELECT * FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = 'campaign'
     AND date_since = ? AND date_until = ?`,
    [adAccountId, dateRange.since, dateRange.until]
  );

  if (campaigns.length === 0) {
    return { error: 'No campaign data' };
  }

  // Apply movements to campaign data
  let simulation = JSON.parse(JSON.stringify(campaigns));
  let totalMovedSpend = 0;

  for (const movement of movements) {
    const source = simulation.find(c => c.entity_meta_id === movement.from_id);
    const target = simulation.find(c => c.entity_meta_id === movement.to_id);

    if (source && target) {
      source.spend_amount -= movement.amount;
      target.spend_amount += movement.amount;
      totalMovedSpend += movement.amount;
    }
  }

  // Recalculate metrics
  const currentTotalRoas = campaigns.reduce((s, c) => s + (c.roas || 0) * (c.spend_amount || 1), 0) /
    campaigns.reduce((s, c) => s + (c.spend_amount || 1), 0);

  const simulatedTotalRoas = simulation.reduce((s, c) => s + (c.roas || 0) * (c.spend_amount || 1), 0) /
    simulation.reduce((s, c) => s + (c.spend_amount || 1), 0);

  return {
    simulation: {
      total_campaigns: simulation.length,
      movements_applied: movements.length,
      total_moved_spend: round(totalMovedSpend),
    },
    current_state: {
      average_roas: round(currentTotalRoas, 2),
      total_spend: round(campaigns.reduce((s, c) => s + (c.spend_amount || 0), 0)),
    },
    simulated_state: {
      average_roas: round(simulatedTotalRoas, 2),
      total_spend: round(simulation.reduce((s, c) => s + (c.spend_amount || 0), 0)),
      roas_improvement_pct: round(((simulatedTotalRoas - currentTotalRoas) / currentTotalRoas) * 100, 1),
      estimated_impact: `Account ROAS could improve by ${round(((simulatedTotalRoas - currentTotalRoas) / currentTotalRoas) * 100, 1)}%`,
    },
  };
}

module.exports = {
  generateBudgetMovementRecommendations,
  simulateBudgetReallocation,
};
