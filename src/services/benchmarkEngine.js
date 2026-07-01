/**
 * Benchmark Evaluation Layer
 *
 * Compares campaign metrics against benchmark thresholds.
 * Resolution: account-specific benchmark → global benchmark → platform default
 *
 * Output per metric:
 *   status   : above | below | optimal | no_benchmark
 *   deviation: percentage deviation from the target threshold
 *   value    : actual metric value
 *   target   : benchmark target used
 *   source   : account_benchmark | global_benchmark | platform_default
 */

const { resolveThresholds } = require('./benchmarkResolver');

// resolveBenchmark(objective, metricKey, adAccountId) === resolveThresholds
// with no pre-loaded platform config, which already returns null when
// nothing is found at any of the 3 tiers -- exactly this function's
// previous contract.
const resolveBenchmark = resolveThresholds;

// ─────────────────────────────────────────────
// Evaluate one metric against its benchmark
// ─────────────────────────────────────────────
function evaluateMetric(value, benchmark) {
  if (value === null || value === undefined) {
    return { status: 'no_data', deviation: null, target: null, source: benchmark?.source ?? 'none' };
  }

  if (!benchmark) {
    return { status: 'no_benchmark', deviation: null, target: null, source: 'none' };
  }

  // critical_threshold is stored per-benchmark but not used as a status
  // boundary here: with 4 statuses (above/optimal/below/critical) only 3
  // boundaries are needed (excellent, good, warning) -- anything worse
  // than warning_threshold is already 'critical'.
  const { comparison_direction, excellent_threshold, good_threshold,
          warning_threshold,
          optimal_low, optimal_high, source } = benchmark;

  // Optimal range (e.g. frequency)
  if (comparison_direction === 'optimal_range') {
    const low  = optimal_low  ?? 1.5;
    const high = optimal_high ?? 3.5;
    const mid  = (low + high) / 2;

    let status;
    if (value >= low && value <= high) {
      status = 'optimal';
    } else if (value < low) {
      status = 'below';
    } else {
      status = 'above';
    }

    const deviation = mid > 0
      ? Math.round(((value - mid) / mid) * 100)
      : null;

    return { status, deviation, target: mid, source };
  }

  // Lower is better
  if (comparison_direction === 'lower_is_better') {
    const target = good_threshold; // "good" is the reference target
    const deviation = target > 0
      ? Math.round(((value - target) / target) * 100)
      : null;

    let status;
    if (value <= excellent_threshold) status = 'above';       // performing better than excellent
    else if (value <= good_threshold)  status = 'optimal';    // within good range
    else if (value <= warning_threshold) status = 'below';    // worse than good
    else status = 'critical';

    return { status, deviation, target, source };
  }

  // Higher is better
  const target = good_threshold;
  const deviation = target > 0
    ? Math.round(((value - target) / target) * 100)
    : null;

  let status;
  if (value >= excellent_threshold) status = 'above';
  else if (value >= good_threshold)  status = 'optimal';
  else if (value >= warning_threshold) status = 'below';
  else status = 'critical';

  return { status, deviation, target, source };
}

// ─────────────────────────────────────────────
// MAIN: Evaluate all relevant metrics for a campaign
// ─────────────────────────────────────────────
function evaluateBenchmarks(campaign, metrics, adAccountId) {
  const { objective } = campaign;

  // Which metrics to evaluate per objective. Kept in sync with the metric
  // sets actually seeded in objective_scoring_configs (seedIntelligence.js)
  // -- this list had drifted from that source of truth, silently dropping
  // each objective's primary volume KPI (leads, purchases,
  // landing_page_views) from benchmark evaluation and substituting a
  // generic 'cpm' that isn't part of that objective's scoring weights at
  // all. 'unknown' has no seeded scoring config, so it keeps a reasonable
  // universal fallback.
  const metricsByObjective = {
    messaging: ['cpr', 'ctr', 'frequency', 'reach'],
    leads:     ['cpl', 'leads', 'ctr', 'frequency'],
    sales:     ['roas', 'cpa', 'purchases', 'ctr'],
    traffic:   ['cpc', 'ctr', 'landing_page_views', 'frequency'],
    awareness: ['reach', 'cpm', 'frequency', 'impressions'],
    unknown:   ['ctr', 'cpm', 'frequency'],
  };

  const relevantMetrics = metricsByObjective[objective] || metricsByObjective.unknown;

  const results = {};

  for (const metricKey of relevantMetrics) {
    const rawValue = metrics[metricKey] !== undefined
      ? parseFloat(metrics[metricKey])
      : null;

    const benchmark = resolveBenchmark(objective, metricKey, adAccountId);
    const evaluation = evaluateMetric(rawValue, benchmark);

    results[metricKey] = {
      value:     rawValue !== null ? Math.round(rawValue * 100) / 100 : null,
      ...evaluation,
    };
  }

  // Summary: how many metrics are above / optimal / below
  const statuses = Object.values(results).map(r => r.status);
  const summary = {
    above:        statuses.filter(s => s === 'above').length,
    optimal:      statuses.filter(s => s === 'optimal').length,
    below:        statuses.filter(s => s === 'below').length,
    critical:     statuses.filter(s => s === 'critical').length,
    no_data:      statuses.filter(s => s === 'no_data').length,
    no_benchmark: statuses.filter(s => s === 'no_benchmark').length,
    total:        statuses.length,
  };

  return { metrics: results, summary };
}

module.exports = { evaluateBenchmarks, resolveBenchmark, evaluateMetric };
