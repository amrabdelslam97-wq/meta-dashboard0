/**
 * Objective Diagnosis Engine — Product Completion Mode, Milestone 3
 *
 * Extends each KPI row already built by objectiveIntelligenceEngine.js
 * (Milestone 2, untouched) with KPI-specific Root Cause, Business Impact,
 * Executive Recommendation, Severity, Confidence, and Evidence. Computes
 * NOTHING new about metric values/thresholds/status -- it only reuses:
 *   - diagnosisEngine.js's already-computed factors[]/category/confidence/
 *     priority (its own classifyMetric() export, added in Phase X.6)
 *   - decisionEngine.js's findingShapeForCard() (Phase X.5) to read a
 *     matched decision/recommendation/alert's suggested_action/confidence
 *   - the KPI row's own already-computed benchmark status/deviation
 *
 * Template-based, deterministic, no LLM -- same discipline as
 * executiveSummaryEngine.js. Where no specific rule/diagnosis match exists
 * for a KPI, an honest, metric-type-based fallback template is used
 * (labeled generically, never presented as a specific finding).
 */

const { classifyMetric } = require('./diagnosisEngine');
const { findingShapeForCard } = require('./decisionEngine');

// diagnosisEngine.js's own cascade factor keys (decomposeCost/decomposeRoas/
// decomposeVolume/decomposeRate), mapped to the raw metric_key they concern
// -- reused verbatim as this KPI's root cause when a match exists.
// 'conversion_rate_falling' and 'creative_fatigue_proxy' are intentionally
// omitted: they describe a derived ratio / a multi-metric pattern with no
// single corresponding benchmarkMetrics entry -- mapping them to one metric
// would be a guess, not a reuse.
const FACTOR_KEY_TO_METRIC = {
  cpm_rising: 'cpm',
  ctr_falling: 'ctr',
  frequency_rising: 'frequency',
  spend_falling: 'spend',
  purchase_value_drop_with_stable_count: 'purchase_value',
};

// Per-objective recommendation focus, exactly as specified by the product
// directive -- a presentation-layer category label, not a new Rule (no
// trigger condition, no independent execution, never registered with
// ruleEngine.js). Used only as a fallback when no specific decision/
// recommendation/alert already covers this KPI.
const OBJECTIVE_RECOMMENDATION_FOCUS = {
  awareness:     'frequency optimization',
  traffic:       'landing page optimization',
  engagement:    'creative optimization',
  leads:         'form optimization',
  app_promotion: 'activation optimization',
  sales:         'checkout / ROAS optimization',
};

// Fallback templates keyed by diagnosisEngine.classifyMetric()'s own type
// vocabulary (roas/cost/volume/rate) plus 'optimal_range' for metrics like
// frequency -- reused type classification, new (but honest, generic) prose
// only for the case no specific engine finding already explains this KPI.
const TYPE_ROOT_CAUSE = {
  cost:     (name) => `${name} is worse than expected, indicating rising cost per outcome.`,
  volume:   (name) => `${name} is lower than expected, reducing overall campaign output.`,
  rate:     (name) => `${name} is underperforming relative to target, indicating reduced efficiency.`,
  roas:     (name) => `${name} is below target, indicating spend is not converting efficiently.`,
  optimal_range: (name) => `${name} is outside the optimal range, which can indicate audience fatigue or under-delivery.`,
};
const TYPE_BUSINESS_IMPACT = {
  cost:     'Increases cost per outcome, reducing profitability and budget efficiency.',
  volume:   'Reduces total campaign output, lowering overall return on ad spend.',
  rate:     'Lowers efficiency, requiring more spend to achieve the same results.',
  roas:     'Directly reduces return on ad spend and overall profitability.',
  optimal_range: 'May reduce delivery efficiency due to audience fatigue or under-exposure.',
};

function resolveMetricType(metricKey) {
  if (metricKey === 'frequency') return 'optimal_range'; // not covered by classifyMetric(), see diagnosisEngine.js
  return classifyMetric(metricKey); // 'roas' | 'cost' | 'volume' | 'rate' | null
}

// Look up the fired rule / recommendation / alert already summarized in
// kpi.related_rules (objectiveIntelligenceEngine.js's own attribution,
// unmodified) against the raw source arrays, to read its real
// suggested_action/confidence via the existing findingShapeForCard()
// adapter -- a join on already-computed data, not a second matching pass.
function resolveMatchedFinding(kpi, { ruleEngineDecisions = [], recommendations = [], alerts = [] }) {
  for (const related of kpi.related_rules || []) {
    if (related.source === 'rule_engine') {
      const row = ruleEngineDecisions.find(d => d.rule_id === related.rule_id);
      if (row) return findingShapeForCard('rule_engine', row);
    } else if (related.source === 'recommendation') {
      const row = recommendations.find(r => r.rule_code === related.rule_id);
      if (row) return findingShapeForCard('recommendation', row);
    } else if (related.source === 'alert') {
      const row = alerts.find(a => a.alert_code === related.rule_id);
      if (row) return findingShapeForCard('alert', row);
    }
  }
  return null;
}

function resolveDiagnosisFactor(kpi, diagnosis) {
  if (!diagnosis || diagnosis.status !== 'diagnosed') return null;
  return (diagnosis.factors || []).find(f => FACTOR_KEY_TO_METRIC[f.key] === kpi.metric_key) || null;
}

const SEVERITY_BY_STATUS = { failure: 'critical', warning: 'medium', success: 'none', unknown: 'none' };

/**
 * Enrich one KPI row (from objectiveIntelligenceEngine.buildObjectiveIntelligence())
 * with KPI-specific root_cause/business_impact/executive_recommendation/
 * severity/confidence/evidence. Returns a NEW object (does not mutate kpi).
 */
function enrichKpiWithDiagnosis(kpi, { objective, diagnosis = null, ruleEngineDecisions = [], recommendations = [], alerts = [] } = {}) {
  if (kpi.status === 'success') {
    return {
      ...kpi,
      root_cause: null,
      business_impact: 'Contributing positively to campaign performance.',
      executive_recommendation: 'No action needed — maintain current strategy.',
      severity: SEVERITY_BY_STATUS.success,
      confidence: 'high',
      evidence: { current_value: kpi.current_value, benchmark: kpi.benchmark, deviation_note: kpi.reason },
    };
  }

  const isPrimary = diagnosis && diagnosis.status === 'diagnosed' && diagnosis.primaryKey === kpi.metric_key;
  const matchedFactor = !isPrimary ? resolveDiagnosisFactor(kpi, diagnosis) : null;
  const matchedFinding = resolveMatchedFinding(kpi, { ruleEngineDecisions, recommendations, alerts });
  const metricType = resolveMetricType(kpi.metric_key);

  let rootCause, confidence, severity, evidence;

  if (isPrimary) {
    rootCause = diagnosis.summary || (matchedFactor ? matchedFactor.detail : null);
    confidence = diagnosis.confidence;
    severity = diagnosis.priority;
    evidence = { factors: diagnosis.factors || [], primary_delta: diagnosis.primaryDelta || null };
  } else if (matchedFactor) {
    rootCause = matchedFactor.detail;
    confidence = diagnosis.confidence;
    severity = diagnosis.priority;
    evidence = { factor: matchedFactor };
  } else if (matchedFinding) {
    rootCause = TYPE_ROOT_CAUSE[metricType] ? TYPE_ROOT_CAUSE[metricType](kpi.metric_name) : kpi.reason;
    confidence = matchedFinding.confidence;
    severity = matchedFinding.priority;
    evidence = matchedFinding.evidence || { current_value: kpi.current_value, benchmark: kpi.benchmark };
  } else {
    rootCause = TYPE_ROOT_CAUSE[metricType] ? TYPE_ROOT_CAUSE[metricType](kpi.metric_name) : kpi.reason;
    confidence = 'medium'; // benchmark comparison alone, not corroborated by a specific rule/diagnosis match
    severity = SEVERITY_BY_STATUS[kpi.status] || 'none';
    evidence = { current_value: kpi.current_value, benchmark: kpi.benchmark, deviation_note: kpi.reason };
  }

  const businessImpact = TYPE_BUSINESS_IMPACT[metricType] || 'May affect overall campaign efficiency.';

  const focus = OBJECTIVE_RECOMMENDATION_FOCUS[objective] || 'performance optimization';
  const executiveRecommendation = matchedFinding?.suggested_action
    || `Recommend ${focus} to address ${kpi.metric_name}.`;

  return {
    ...kpi,
    root_cause: rootCause,
    business_impact: businessImpact,
    executive_recommendation: executiveRecommendation,
    severity,
    confidence,
    evidence,
  };
}

/**
 * Enrich every KPI in an objectiveIntelligenceEngine result. Does not
 * modify objectiveIntelligence's own top-level fields (detected_objective,
 * objective_health, root_cause, executive_interpretation) -- only replaces
 * `.kpis` with the enriched array.
 */
function enrichObjectiveIntelligence(objectiveIntelligence, context) {
  if (!objectiveIntelligence) return objectiveIntelligence;
  return {
    ...objectiveIntelligence,
    kpis: objectiveIntelligence.kpis.map(kpi => enrichKpiWithDiagnosis(kpi, context)),
  };
}

module.exports = { enrichKpiWithDiagnosis, enrichObjectiveIntelligence, OBJECTIVE_RECOMMENDATION_FOCUS };
