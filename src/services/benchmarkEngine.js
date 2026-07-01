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

const db = require('../db/database');

// ─────────────────────────────────────────────
// Resolve benchmark for one metric
// ─────────────────────────────────────────────
function resolveBenchmark(objective, metricKey, adAccountId) {
  // 1. Account-specific
  const acct = db.get(
    `SELECT * FROM benchmark_metrics
     WHERE objective = ? AND metric_key = ? AND ad_account_id = ?`,
    [objective, metricKey, adAccountId]
  );
  if (acct) return { ...acct, source: 'account_benchmark' };

  // 2. Global (industry-level, no account)
  const global = db.get(
    `SELECT * FROM benchmark_metrics
     WHERE objective = ? AND metric_key = ? AND ad_account_id IS NULL`,
    [objective, metricKey]
  );
  if (global) return { ...global, source: 'global_benchmark' };

  // 3. Platform default from scoring configs
  const platform = db.get(
    `SELECT * FROM objective_scoring_configs
     WHERE objective = ? AND metric_key = ?`,
    [objective, metricKey]
  );
  if (platform) return { ...platform, source: 'platform_default' };

  return null;
}

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

  const { comparison_direction, excellent_threshold, good_threshold,
          warning_threshold, critical_threshold,
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

  // Which metrics to evaluate per objective
  const metricsByObjective = {
    messaging: ['ctr', 'cpr', 'frequency', 'cpm', 'reach'],
    leads:     ['ctr', 'cpl', 'frequency', 'cpm'],
    sales:     ['ctr', 'roas', 'cpa', 'cpm'],
    traffic:   ['ctr', 'cpc', 'cpm', 'frequency'],
    awareness: ['cpm', 'frequency', 'reach', 'impressions'],
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
