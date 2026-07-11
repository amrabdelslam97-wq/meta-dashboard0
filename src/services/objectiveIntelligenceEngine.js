/**
 * Objective Intelligence Engine — Product Completion Mode, Milestone 2
 *
 * Assembles ONE per-objective KPI table from data the existing engines
 * already compute -- benchmarkEngine.js's evaluateBenchmarks() (value,
 * status, target), kpiProfileResolver.js's PROFILES (which metrics belong
 * to this objective, and their formula), benchmarkResolver.js's threshold
 * tiers, objectiveKPIMap.js's display labels, frameworkRegistry.js's rule
 * provenance, diagnosisEngine.js's root cause, and executiveSummaryEngine.js's
 * summary. This file computes NOTHING new: every number shown was already
 * produced elsewhere; this only joins and relabels.
 *
 * Presentation/read-model layer only -- no DB access, no side effects,
 * matching comparisonEngine.js's/executiveSummaryEngine.js's existing style.
 */

const { resolveProfile } = require('./kpiProfileResolver');
const { resolveBenchmark } = require('./benchmarkEngine');
const { formatMetricLabel } = require('./objectiveKPIMap');
const { getRuleProvenance } = require('./frameworkRegistry');

// benchmarkEngine.evaluateMetric()'s own status vocabulary (above/optimal/
// below/critical/no_data/no_benchmark) relabeled to the requested
// Success/Warning/Failure vocabulary -- a rename of statuses that engine
// already computed, not a new classification rule.
function mapStatusToVerdict(status) {
  if (status === 'above' || status === 'optimal') return 'success';
  if (status === 'below') return 'warning';
  if (status === 'critical') return 'failure';
  return 'unknown'; // no_data / no_benchmark
}

// profile.aggregation[metricKey] describes how to roll this metric up
// across many rows for portfolio reporting (e.g. 'sum', 'spend_weighted_avg')
// -- for cost-per-X metrics that roll-up formula ('spend/purchases', etc.)
// is algebraically identical to the single-entity formula, so it's shown
// as-is. For metrics whose aggregation rule is a plain keyword (sum/
// spend_weighted_avg/revenue-less ratios with no arithmetic), there is no
// single-entity formula to show -- Meta already returns the value computed
// -- so that's stated honestly instead of mislabeling an aggregation rule
// as a "formula."
function resolveFormulaUsed(aggregationRule) {
  if (!aggregationRule) return 'Direct metric (from Meta Insights API)';
  const isArithmetic = /[/*]/.test(aggregationRule);
  return isArithmetic ? aggregationRule : 'Direct metric (from Meta Insights API)';
}

function findRelatedRules(metricKey, { ruleEngineFired = [], recommendations = [], alerts = [] }) {
  const related = [];

  for (const f of ruleEngineFired) {
    const touches = (f.evidence || []).some(e => (e.metric || '').split('/').includes(metricKey));
    if (touches) {
      related.push({ rule_id: f.rule_id, framework: f.framework, governance_state: f.governance_state || null, source: 'rule_engine' });
    }
  }
  for (const r of recommendations) {
    if (r.metric_key === metricKey) {
      const prov = getRuleProvenance(r.rule_code);
      related.push({ rule_id: r.rule_code, framework: prov?.framework || null, governance_state: r.governance_state || null, source: 'recommendation' });
    }
  }
  for (const a of alerts) {
    if (a.metric_key === metricKey) {
      const prov = getRuleProvenance(a.alert_code);
      related.push({ rule_id: a.alert_code, framework: prov?.framework || null, governance_state: a.governance_state || null, source: 'alert' });
    }
  }
  return related;
}

function resolveReason(metricKey, benchmarkEntry, diagnosis) {
  if (diagnosis && diagnosis.status === 'diagnosed' && diagnosis.primaryKey === metricKey) {
    return diagnosis.summary || null;
  }
  if (!benchmarkEntry || benchmarkEntry.status === 'no_data') return 'No data available for this metric in the selected period.';
  if (benchmarkEntry.status === 'no_benchmark') return 'No benchmark configured for this objective/metric yet.';
  if (benchmarkEntry.deviation == null) return null;
  const direction = benchmarkEntry.deviation >= 0 ? 'above' : 'below';
  return `${Math.abs(benchmarkEntry.deviation)}% ${direction} the benchmark target.`;
}

/**
 * @param {object} params
 *   objective, adAccountId, currentMetrics
 *   healthScore, healthStatus
 *   benchmark          - intelligenceOrchestrator's benchmarkResult (already computed): { metrics, summary }
 *   diagnosis          - diagnosisEngine.diagnoseCampaign() output, or null
 *   ruleEngineFired    - ruleEngine.executeRules().fired, or []
 *   recommendations    - intelligence.recommendations, or []
 *   alerts             - intelligence.alerts, or []
 *   executiveSummary   - executiveSummaryEngine.buildExecutiveSummary() output, already computed by the caller
 */
function buildObjectiveIntelligence({
  objective = null, adAccountId = null, currentMetrics = {},
  healthScore = null, healthStatus = null,
  benchmark = { metrics: {}, summary: {} },
  diagnosis = null,
  ruleEngineFired = [], recommendations = [], alerts = [],
  executiveSummary = null,
} = {}) {
  const profile = resolveProfile(objective);
  const requiredMetrics = profile.benchmarkMetrics || [];

  const kpis = requiredMetrics.map(metricKey => {
    const benchmarkEntry = benchmark.metrics?.[metricKey] || null;
    const thresholds = resolveBenchmark(objective, metricKey, adAccountId);
    const aggregationRule = profile.aggregation?.[metricKey] || null;

    return {
      metric_key: metricKey,
      metric_name: formatMetricLabel(metricKey),
      current_value: currentMetrics[metricKey] ?? null,
      formula_used: resolveFormulaUsed(aggregationRule),
      calculated_result: benchmarkEntry?.value ?? (currentMetrics[metricKey] ?? null),
      benchmark: thresholds?.good_threshold ?? thresholds?.optimal_low ?? null,
      success_threshold: thresholds?.excellent_threshold ?? thresholds?.optimal_low ?? null,
      warning_threshold: thresholds?.warning_threshold ?? null,
      failure_threshold: thresholds?.critical_threshold ?? null,
      status: mapStatusToVerdict(benchmarkEntry?.status),
      reason: resolveReason(metricKey, benchmarkEntry, diagnosis),
      related_rules: findRelatedRules(metricKey, { ruleEngineFired, recommendations, alerts }),
      framework_reference: [...new Set(findRelatedRules(metricKey, { ruleEngineFired, recommendations, alerts }).map(r => r.framework).filter(Boolean))],
      maifs_governance_status: (findRelatedRules(metricKey, { ruleEngineFired, recommendations, alerts })[0] || {}).governance_state || 'not_applicable',
    };
  });

  return {
    detected_objective: objective,
    objective_health: healthStatus,
    objective_health_score: healthScore,
    kpis,
    root_cause: diagnosis ? {
      status: diagnosis.status,
      category: diagnosis.category || null,
      primary_key: diagnosis.primaryKey || null,
      primary_label: diagnosis.primaryLabel || null,
      summary: diagnosis.summary || null,
    } : null,
    executive_interpretation: executiveSummary,
  };
}

module.exports = { buildObjectiveIntelligence, mapStatusToVerdict, resolveFormulaUsed };
