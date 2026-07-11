/**
 * Analytics Insight — Executive Marketing Analytics Layer (Phase 17)
 *
 * Shared "AI Preparation" summarizer: every analytics domain (audience,
 * geographic, placement, device, creative, budget) attaches the same
 * shaped summary object to its rows so MAIFS/MMS have one consistent
 * contract to consume later, instead of each domain inventing its own.
 *
 * Deliberately NOT a new AI/LLM system -- this applies the same kind of
 * deterministic, evidence-based rules already established by
 * diagnosisEngine.js/ruleEngine.js (explicit thresholds, real computed
 * deltas, no fabricated language). "AI Preparation" means the data is
 * SHAPED for a future recommendation/governance layer to consume, not that
 * one runs here.
 *
 * Pure logic, no DB access, no Meta API calls -- takes already-fetched rows
 * (each row: { dimension_value, spend, ...metric, cost_per_result|cpr, ... })
 * for a single metric dimension and returns the summary block.
 */

// A row needs at least this much spend to be considered statistically
// meaningful for "best"/"worst" ranking -- mirrors diagnosisEngine.js's own
// "don't diagnose on noise" floor (MIN_IMPRESSIONS_FOR_DIAGNOSIS), scaled to
// a spend-based signal since breakdown rows are ranked by efficiency, not a
// single volume metric.
const MIN_SPEND_FOR_RANKING = 1;

// A performer needs to be this much better/worse than the group's spend-
// weighted average cost-per-result to be called out as a real outlier
// rather than ordinary variance.
const OUTLIER_THRESHOLD_PCT = 20;

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Spend-weighted average cost-per-result across a set of rows (lower-is-better cost metric). */
function weightedAverageCost(rows, costKey) {
  const eligible = rows.filter(r => r.spend > 0 && r[costKey] != null && r[costKey] > 0);
  const totalSpend = eligible.reduce((s, r) => s + r.spend, 0);
  if (totalSpend === 0) return null;
  const weighted = eligible.reduce((s, r) => s + r[costKey] * r.spend, 0);
  return weighted / totalSpend;
}

/**
 * @param {object[]} rows - normalized breakdown/creative rows for ONE metric
 *   dimension (e.g. all age-band rows for one campaign), each already
 *   carrying spend + a cost metric (cost_per_result preferred, cpr/cpa
 *   fallback) and results/roas where available.
 * @param {object} [options]
 * @param {string} [options.costKey] - which field is "cost per result" on
 *   these rows (default tries cost_per_result, then cpr, then cpa)
 * @param {string} [options.labelKey] - which field is the display label
 *   (default 'dimension_value')
 */
function buildInsight(rows, options = {}) {
  const labelKey = options.labelKey || 'dimension_value';
  const costKey = options.costKey || (
    rows.some(r => r.cost_per_result != null) ? 'cost_per_result'
    : rows.some(r => r.cpr != null) ? 'cpr'
    : 'cpa'
  );

  const ranked = rows.filter(r => (r.spend || 0) >= MIN_SPEND_FOR_RANKING && r[costKey] != null && r[costKey] > 0);

  if (ranked.length === 0) {
    return {
      top_performer: null,
      bottom_performer: null,
      trend: 'insufficient_data',
      recommendation: 'Not enough spend yet to identify a top or bottom performer -- revisit once more data accrues.',
      warning: null,
      opportunity: null,
      risk: null,
      confidence: 'low',
      business_impact: 'None yet -- insufficient data.',
      executive_summary: 'Insufficient spend/results to generate a reliable breakdown insight for this period.',
    };
  }

  // Lower cost-per-result is better -- sort ascending.
  const sorted = [...ranked].sort((a, b) => a[costKey] - b[costKey]);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const avgCost = weightedAverageCost(ranked, costKey);

  const bestDeviationPct = avgCost ? round(((avgCost - best[costKey]) / avgCost) * 100, 1) : null;
  const worstDeviationPct = avgCost ? round(((worst[costKey] - avgCost) / avgCost) * 100, 1) : null;

  const hasRealOutlierBest = bestDeviationPct !== null && bestDeviationPct >= OUTLIER_THRESHOLD_PCT && sorted.length > 1;
  const hasRealOutlierWorst = worstDeviationPct !== null && worstDeviationPct >= OUTLIER_THRESHOLD_PCT && sorted.length > 1;

  const totalSpend = ranked.reduce((s, r) => s + r.spend, 0);
  const bestSpendShare = totalSpend > 0 ? round((best.spend / totalSpend) * 100, 1) : 0;
  const worstSpendShare = totalSpend > 0 ? round((worst.spend / totalSpend) * 100, 1) : 0;

  let opportunity = null;
  let risk = null;
  let warning = null;
  let recommendation;
  let businessImpact;

  if (hasRealOutlierBest) {
    opportunity = `${best[labelKey]} is ${bestDeviationPct}% more cost-efficient than the group average -- a strong reallocation/scaling candidate.`;
  }
  if (hasRealOutlierWorst && worst.spend > 0) {
    risk = `${worst[labelKey]} is ${worstDeviationPct}% less cost-efficient than the group average while still receiving ${worstSpendShare}% of spend.`;
    if (worstSpendShare >= 20) {
      warning = `A large share of spend (${worstSpendShare}%) is going to the weakest-performing segment (${worst[labelKey]}).`;
    }
  }

  if (hasRealOutlierBest && hasRealOutlierWorst) {
    recommendation = `Shift budget from ${worst[labelKey]} toward ${best[labelKey]} -- the efficiency gap (${worstDeviationPct}% vs. ${bestDeviationPct}%) is large enough to be a real reallocation opportunity, not noise.`;
    businessImpact = `Reallocating spend toward ${best[labelKey]} could materially improve overall cost-per-result without increasing total budget.`;
  } else if (hasRealOutlierBest) {
    recommendation = `Consider increasing investment in ${best[labelKey]} -- it is outperforming the group average with no comparably weak segment to offset it.`;
    businessImpact = `Scaling the top performer is likely to improve blended efficiency.`;
  } else if (hasRealOutlierWorst) {
    recommendation = `Review or reduce spend on ${worst[labelKey]} -- it is meaningfully underperforming the group average.`;
    businessImpact = `Trimming the weakest segment reduces wasted spend without materially affecting total results.`;
  } else {
    recommendation = 'Performance is evenly distributed across this dimension -- no single segment stands out enough to act on yet.';
    businessImpact = 'Low -- current allocation appears balanced.';
  }

  const confidence = ranked.length >= 4 && totalSpend > 0
    ? 'high'
    : ranked.length >= 2 ? 'medium' : 'low';

  const trend = hasRealOutlierBest || hasRealOutlierWorst ? 'divergent' : 'stable';

  return {
    top_performer: {
      label: best[labelKey],
      [costKey]: round(best[costKey]),
      spend: round(best.spend),
      spend_share_pct: bestSpendShare,
      deviation_from_avg_pct: bestDeviationPct,
    },
    bottom_performer: {
      label: worst[labelKey],
      [costKey]: round(worst[costKey]),
      spend: round(worst.spend),
      spend_share_pct: worstSpendShare,
      deviation_from_avg_pct: worstDeviationPct,
    },
    trend,
    recommendation,
    warning,
    opportunity,
    risk,
    confidence,
    business_impact: businessImpact,
    executive_summary: `${best[labelKey]} leads on cost efficiency` +
      (hasRealOutlierWorst ? `, while ${worst[labelKey]} lags ${worstDeviationPct}% behind average.` : '.') +
      ` ${recommendation}`,
  };
}

module.exports = { buildInsight, weightedAverageCost, MIN_SPEND_FOR_RANKING, OUTLIER_THRESHOLD_PCT };
