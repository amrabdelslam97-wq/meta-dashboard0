/**
 * Rule Engine — Phase 11 (Framework Rule-Based Intelligence)
 *
 * A centralized registry + executor for Framework-sourced rules (Meta
 * Frameworks 2-8, per docs/META_ADS_INTELLIGENCE_FRAMEWORK_SERIES.md).
 * Pure logic, no DB access -- takes already-fetched metrics/deltas as
 * input, mirroring diagnosisEngine.js's and recommendationResolver.js's
 * "presentation/logic layer only" style.
 *
 * This does NOT duplicate business logic that already runs elsewhere:
 * six rules (LOW_ROAS, LOW_CTR, HIGH_FREQUENCY, CPM_SPIKE, CTR_DROP,
 * ROAS_BELOW_ONE) are already executed by recommendationEngine.js/
 * alertEngine.js against DB rows in recommendation_rules/alert_rules --
 * those are registered here as sourceType:'existing_db_rule' metadata
 * entries (for a complete, honest inventory of every Framework rule and
 * its implementation status) but are never re-evaluated by this engine.
 * Only genuinely NEW rules -- not already covered by an existing engine --
 * are registered as sourceType:'rule_engine_native' and executed here.
 *
 * Every rule carries the full metadata set required for traceability:
 * id, framework, name, version, category, severity, conditions,
 * thresholdSource, action, dependencies (suppresses/requires), provenance.
 */

const { getFramework } = require('./frameworkRegistry');
const { compare } = require('./conditionComparator');

const REGISTRY_VERSION = '1.0.0';

// ─────────────────────────────────────────────
// Condition evaluator. Two condition shapes:
//   { metric, operator: 'gt'|'gte'|'lt'|'lte'|'eq', value }
//     -- absolute check against current[metric]
//   { metric, operator: 'delta_gt'|'delta_lt', value }
//     -- relative check against deltas[metric].delta_pct
//   { metric, operator: 'flat', band }
//     -- |deltas[metric].delta_pct| < band (saturation/fatigue proxy,
//        matching diagnosisEngine.js's own FLAT_BAND_PCT convention)
//   { metric, operator: 'in_set'|'not_in_set', value: [...] }
//     -- categorical membership check against current[metric] (e.g.
//        cta_type against a known weak/strong CTA vocabulary) -- the one
//        non-numeric condition shape; deliberately not routed through
//        conditionComparator.compare(), which is numeric-only.
// All conditions on a rule must match (AND) for the rule to fire.
// ─────────────────────────────────────────────
function evaluateCondition(condition, current, deltas) {
  const { metric, operator, value, band, metricA, metricB } = condition;

  if (operator === 'in_set' || operator === 'not_in_set') {
    const actual = current?.[metric];
    if (actual == null) return { matched: false, evidence: null };
    const set = value instanceof Set ? value : new Set(value);
    const isIn = set.has(actual);
    return { matched: operator === 'in_set' ? isIn : !isIn, evidence: actual };
  }

  if (operator === 'ratio_lt' || operator === 'ratio_gt') {
    const a = current?.[metricA];
    const b = current?.[metricB];
    if (a == null || b == null || parseFloat(b) === 0) return { matched: false, evidence: null };
    const ratio = parseFloat(a) / parseFloat(b);
    const matched = operator === 'ratio_lt' ? ratio < value : ratio > value;
    return { matched, evidence: Math.round(ratio * 1000) / 1000 };
  }

  if (operator === 'delta_gt' || operator === 'delta_lt') {
    const d = deltas?.[metric];
    if (!d || d.delta_pct == null) return { matched: false, evidence: null };
    const matched = operator === 'delta_gt' ? d.delta_pct > value : d.delta_pct < value;
    return { matched, evidence: d.delta_pct };
  }

  if (operator === 'flat') {
    const d = deltas?.[metric];
    if (!d || d.delta_pct == null) return { matched: false, evidence: null };
    const matched = Math.abs(d.delta_pct) < (band ?? 5);
    return { matched, evidence: d.delta_pct };
  }

  const actual = current?.[metric];
  if (actual == null) return { matched: false, evidence: null };
  const v = parseFloat(actual);
  return { matched: compare(v, operator, value), evidence: v };
}

function evaluateRule(rule, current, deltas, objective, entityType = 'campaign') {
  if (rule.sourceType !== 'rule_engine_native') {
    return { fired: false, skippedReason: `sourceType:${rule.sourceType} -- not evaluated by ruleEngine (see rule.provenance)` };
  }
  if (!rule.implementable) {
    return { fired: false, skippedReason: rule.notImplementableReason || 'not implementable' };
  }
  if (Array.isArray(rule.appliesToObjectives) && objective && !rule.appliesToObjectives.includes(objective)) {
    return { fired: false, skippedReason: `does not apply to objective "${objective}"` };
  }
  // Grain filtering (Phase X.1 — Runtime Unification): every native rule
  // declares a scope ({campaign, ad_set, ad}), but until now nothing
  // checked it -- executeRules() would happily evaluate a campaign-shaped
  // rule against ad-set/ad metrics. Mirrors the appliesToObjectives gate
  // above exactly. Rules with no scope field default to campaign-only
  // (matches every currently-registered native rule's own declared scope).
  const scope = rule.scope || { campaign: true, ad_set: false, ad: false };
  if (scope[entityType] === false) {
    return { fired: false, skippedReason: `scope excludes entityType "${entityType}"` };
  }

  const conditionResults = (rule.conditions || []).map(c => ({ condition: c, ...evaluateCondition(c, current, deltas) }));
  const fired = conditionResults.length > 0 && conditionResults.every(r => r.matched);

  return {
    fired,
    conditionResults,
    skippedReason: fired ? null : 'conditions not met',
  };
}

// ─────────────────────────────────────────────
// Rule Registry
// ─────────────────────────────────────────────
const RULES = [];

function registerRule(rule) {
  RULES.push(rule);
}

function getRule(id) {
  return RULES.find(r => r.id === id) || null;
}

function listRules({ framework, sourceType, implementable } = {}) {
  return RULES.filter(r =>
    (framework === undefined || r.framework === framework) &&
    (sourceType === undefined || r.sourceType === sourceType) &&
    (implementable === undefined || r.implementable === implementable)
  );
}

// Strictly `=== false` -- `null`/`undefined` means "attributed to another
// engine, not evaluated by ruleEngine" (see registerRule's `attributed()`
// convention in ruleRegistrySeed.js), which is NOT the same as "not yet
// implementable." Only rules explicitly marked implementable:false belong
// in this inventory.
function listUnimplementedRules() {
  return RULES.filter(r => r.implementable === false);
}

// ─────────────────────────────────────────────
// Conflict resolution -- when more than one fired rule maps to mutually
// exclusive actions on the same entity (e.g. SCALE_CAMPAIGN vs
// PAUSE_CAMPAIGN), only the higher-severity rule's action is kept; the
// suppressed rule is reported in `conflicts`, never silently dropped.
// ─────────────────────────────────────────────
const MUTUALLY_EXCLUSIVE_ACTIONS = [
  ['SCALE_CAMPAIGN', 'PAUSE_CAMPAIGN'],
  ['SCALE_CAMPAIGN', 'REALLOCATE_BUDGET'],
];
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

function resolveConflicts(firedResults) {
  const conflicts = [];
  const kept = [...firedResults];

  for (const [typeA, typeB] of MUTUALLY_EXCLUSIVE_ACTIONS) {
    const a = kept.filter(r => r.rule.action?.type === typeA);
    const b = kept.filter(r => r.rule.action?.type === typeB);
    if (!a.length || !b.length) continue;

    for (const ra of a) {
      for (const rb of b) {
        const rankA = SEVERITY_RANK[ra.rule.severity] || 0;
        const rankB = SEVERITY_RANK[rb.rule.severity] || 0;
        const loser = rankA >= rankB ? rb : ra;
        const winner = loser === ra ? rb : ra;
        conflicts.push({
          suppressed_rule_id: loser.rule.id,
          suppressed_action: loser.rule.action.type,
          kept_rule_id: winner.rule.id,
          kept_action: winner.rule.action.type,
          reason: `${loser.rule.action.type} and ${winner.rule.action.type} are mutually exclusive; ${winner.rule.severity} outranks ${loser.rule.severity}`,
        });
        const idx = kept.indexOf(loser);
        if (idx !== -1) kept.splice(idx, 1);
      }
    }
  }

  return { kept, conflicts };
}

// Explicit suppression -- a fired rule may list other rule_codes it
// suppresses (mirrors recommendation_rules.suppresses_rule_codes' existing
// DB-driven convention, ported to the native rule engine).
function applySuppression(firedResults) {
  const suppressedIds = new Set();
  for (const r of firedResults) {
    for (const code of r.rule.dependencies?.suppresses || []) suppressedIds.add(code);
  }
  return firedResults.filter(r => !suppressedIds.has(r.rule.id));
}

// ─────────────────────────────────────────────
// MAIN: execute every native, implementable rule (optionally scoped to one
// framework) against a campaign's current metrics/deltas, and return a full
// trace: which rules fired, which were suppressed/conflicted, and which
// were skipped and why.
// ─────────────────────────────────────────────
function executeRules({ current, deltas, objective, framework = null, entityType = 'campaign' } = {}) {
  const candidates = listRules({
    sourceType: 'rule_engine_native',
    implementable: true,
    ...(framework ? { framework } : {}),
  });

  const evaluated = candidates.map(rule => ({ rule, result: evaluateRule(rule, current, deltas, objective, entityType) }));
  const firedRaw = evaluated
    .filter(e => e.result.fired)
    .map(e => ({ rule: e.rule, conditionResults: e.result.conditionResults }));

  const afterSuppression = applySuppression(firedRaw);
  const { kept, conflicts } = resolveConflicts(afterSuppression);

  const fired = kept.map(({ rule, conditionResults }) => ({
    rule_id: rule.id,
    framework: rule.framework,
    framework_name: getFramework(rule.framework)?.name || null,
    rule_name: rule.name,
    version: rule.version,
    category: rule.category,
    severity: rule.severity,
    evidence: conditionResults.map(cr => ({
      metric: cr.condition.metric || `${cr.condition.metricA}/${cr.condition.metricB}`,
      operator: cr.condition.operator,
      threshold: cr.condition.value ?? cr.condition.band,
      actual: cr.evidence,
    })),
    reason: rule.reason,
    action: rule.action,
    provenance: rule.provenance,
    scope: rule.scope || { campaign: true, ad_set: false, ad: false },
  }));

  const skipped = evaluated
    .filter(e => !e.result.fired)
    .map(e => ({ rule_id: e.rule.id, framework: e.rule.framework, reason: e.result.skippedReason }));

  return {
    registry_version: REGISTRY_VERSION,
    fired,
    conflicts,
    skipped,
    total_native_rules: candidates.length,
    total_registered_rules: RULES.length,
  };
}

module.exports = {
  REGISTRY_VERSION,
  registerRule,
  getRule,
  listRules,
  listUnimplementedRules,
  evaluateRule,
  evaluateCondition,
  executeRules,
  resolveConflicts,
};
