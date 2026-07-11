/**
 * Rule Inventory — Phase X.2 (Rule Engine Authority)
 *
 * `ruleEngine.js` executes only the 118 hardcoded Framework rules -- it does
 * NOT execute alert_rules, recommendation_rules, diagnosisEngine's cascade,
 * or opportunityEngine's checks (those stay exactly where they are; see the
 * Phase X.2 design doc for why forcing them into ruleEngine's flat model
 * would risk regressing tested behavior). What this module adds is a single
 * queryable REGISTRY of every business rule/threshold/formula in the
 * system, regardless of which engine executes it -- so "what business logic
 * exists and where" has one authoritative answer, even though "who runs it"
 * still varies. Every entry is tagged with `owner`: the engine that actually
 * evaluates it. Read-only, computed fresh on every call (no boot-time
 * caching, so DB-driven rules edited at runtime are always current).
 */

const db = require('../db/database');
const { listRules } = require('./ruleEngine');
const { resolveOpportunityThresholds, OPPORTUNITY_TYPES } = require('./opportunityEngine');

// Static attribution for diagnosisEngine.js's hardcoded constants -- this
// file has zero imports/DB access of its own (by design, see its header
// comment), so its thresholds can only be listed here as metadata, not
// queried live.
const DIAGNOSIS_ENGINE_THRESHOLDS = [
  { key: 'MIN_IMPRESSIONS_FOR_DIAGNOSIS', value: 100, description: 'Minimum impressions (both periods) required to attempt a diagnosis at all.' },
  { key: 'MIN_IMPRESSIONS_FOR_HIGH_CONFIDENCE', value: 1000, description: 'Minimum impressions (both periods) required for "high" confidence.' },
  { key: 'SIGNAL_THRESHOLD_PCT', value: 10, description: 'Minimum |delta_pct| for a metric move to count as a cascade factor.' },
  { key: 'FLAT_BAND_PCT', value: 5, description: 'Band around zero delta treated as "flat" for saturation/fatigue checks.' },
  { key: 'TRACKING_ANOMALY_DROP_PCT', value: -20, description: 'purchase_value drop threshold (with stable purchase count) flagged as a tracking anomaly for ROAS diagnoses.' },
];

function buildNativeEntries() {
  return listRules().map(rule => ({
    id: rule.id,
    name: rule.name,
    owner: rule.sourceType === 'rule_engine_native' ? 'ruleEngine' : 'attributed',
    sourceType: rule.sourceType,
    implementable: rule.implementable !== false,
    category: rule.category || null,
    severity: rule.severity || null,
    scope: rule.scope || null,
    editableAtRuntime: false,
  }));
}

function buildAlertRuleEntries() {
  const rows = db.all(
    `SELECT id, alert_code, alert_name, metric_key, trigger_type, trigger_value, severity, is_active
     FROM alert_rules`
  );
  return rows.map(row => ({
    id: row.alert_code,
    name: row.alert_name,
    owner: 'alertEngine',
    sourceType: 'db_alert_rule',
    implementable: true,
    metric: row.metric_key,
    operator: row.trigger_type,
    threshold: row.trigger_value,
    severity: row.severity,
    isActive: !!row.is_active,
    editableAtRuntime: true,
  }));
}

function buildRecommendationRuleEntries() {
  const rows = db.all(
    `SELECT id, rule_code, rule_name, objective, priority, condition_logic, severity, is_active
     FROM recommendation_rules`
  );
  return rows.map(row => {
    let condition = null;
    try { condition = JSON.parse(row.condition_logic); } catch { /* left null, matches recommendationEngine.js's own tolerant parsing */ }
    return {
      id: row.rule_code,
      name: row.rule_name,
      owner: 'recommendationEngine',
      sourceType: 'db_recommendation_rule',
      implementable: true,
      objective: row.objective,
      priority: row.priority,
      metric: condition?.metric ?? null,
      operator: condition?.operator ?? null,
      threshold: condition?.value ?? null,
      severity: row.severity,
      isActive: !!row.is_active,
      editableAtRuntime: true,
    };
  });
}

function buildDiagnosisEngineEntries() {
  return DIAGNOSIS_ENGINE_THRESHOLDS.map(t => ({
    id: `diagnosisEngine.${t.key}`,
    name: t.key,
    owner: 'diagnosisEngine',
    sourceType: 'hardcoded_constant',
    implementable: true,
    threshold: t.value,
    description: t.description,
    editableAtRuntime: false,
  }));
}

function buildOpportunityEngineEntries() {
  const thresholds = resolveOpportunityThresholds(null);
  return Object.entries(OPPORTUNITY_TYPES).map(([code, name]) => ({
    id: `opportunityEngine.${code}`,
    name,
    owner: 'opportunityEngine',
    sourceType: 'hardcoded_cross_campaign_check',
    implementable: true,
    thresholds,
    editableAtRuntime: false,
  }));
}

/**
 * The full-system business-logic registry. Not an execution path -- purely
 * a read model over every engine's rules/thresholds, so "what rules exist"
 * has one place to look regardless of which engine evaluates them.
 */
function getBusinessLogicInventory() {
  const native = buildNativeEntries();
  const alertRules = buildAlertRuleEntries();
  const recommendationRules = buildRecommendationRuleEntries();
  const diagnosisThresholds = buildDiagnosisEngineEntries();
  const opportunityChecks = buildOpportunityEngineEntries();

  const all = [...native, ...alertRules, ...recommendationRules, ...diagnosisThresholds, ...opportunityChecks];

  const byOwner = all.reduce((acc, entry) => {
    acc[entry.owner] = (acc[entry.owner] || 0) + 1;
    return acc;
  }, {});

  return {
    total: all.length,
    byOwner,
    entries: all,
  };
}

module.exports = { getBusinessLogicInventory };
