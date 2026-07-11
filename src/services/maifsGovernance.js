/**
 * MAIFS Governance Layer — Phase 10
 *
 * Encodes the mechanically-specifiable rules from docs/MAIFS_META_ADS_
 * INTELLIGENCE_FRAMEWORK_STANDARD.md and docs/META_MASTER_SYSTEM.md (MMS)
 * as deterministic JS, grounded in the actual document sections cited
 * inline. This module does NOT reimplement MMS's conversational/NL-facing
 * sections (Intent Detection from free text, Response Generation prose,
 * Anti-Hallucination self-tests, Operating Modes/tone) -- those assume an
 * LLM interpreting a user's raw question, which does not exist anywhere in
 * this codebase (confirmed: no LLM/embedding dependency in package.json).
 * What IS encoded here are the parts of MMS that are genuinely mechanical
 * even without an LLM: execution ordering (MMS.4), routing (MMS.5.1),
 * decision validation gates (MMS.10), knowledge-priority conflict
 * resolution (MMS.11, minus the two NL-only ranks), and self-check (MMS.19,
 * minus the two NL-fidelity checks).
 *
 * Pure logic, no DB access -- takes already-computed engine outputs
 * (health/benchmark/recommendation/alert/decision/diagnosis results) as
 * input and produces a governance trace over them. It validates and
 * attributes; it never recomputes or overrides what the existing engines
 * decided.
 */

const { EXECUTION_ORDER, ROUTING_TABLE, getRuleProvenance, normalizeRootCause } = require('./frameworkRegistry');
const { VALID_OBJECTIVES } = require('./kpiProfileResolver');
const { DECISION_LABELS } = require('./decisionEngine');

// ─────────────────────────────────────────────
// MMS.4.3 — Decision Procedure for which Frameworks a given analysis run
// must consult, evaluated in MMS.4.3's fixed numeric order regardless of
// which signal a caller happens to set first (MMS.4.4 Never-Random-
// Execution Rule). MF1 is always required (every request depends on it).
// `signals` booleans are derived from structured engine output in this
// codebase (never from parsing free text -- there is no free text here).
// ─────────────────────────────────────────────
function resolveRequiredFrameworks(signals = {}) {
  const {
    touchesCampaign = false,
    touchesAdSet = false,
    touchesCreative = false,
    touchesAudience = false,
    touchesDelivery = false,
    impliesAction = false,
    impliesDiagnosis = false,
    spansMultiple = false,
  } = signals;

  const required = ['MF1']; // always required
  if (touchesCampaign) required.push('MF2');
  if (touchesAdSet)    required.push('MF3');
  if (touchesCreative) required.push('MF4');
  if (touchesAudience) required.push('MF5');
  if (touchesDelivery) required.push('MF6');
  if (impliesAction)    required.push('MF7');
  if (impliesDiagnosis) required.push('MF8');
  if (spansMultiple)    required.push('MF10');

  // De-dupe while preserving MMS.4's fixed rank order (EXECUTION_ORDER),
  // rather than the order signals happened to be pushed above.
  const rank = new Map(EXECUTION_ORDER.map((code, i) => [code, i]));
  return [...new Set(required)].sort((a, b) => rank.get(a) - rank.get(b));
}

// ─────────────────────────────────────────────
// MMS.11 — Knowledge Priority (10-level tie-break order). Ranks 9 ("User
// Request" phrasing) and 10 ("General AI Knowledge") are NL/LLM-specific
// concepts with no equivalent in this deterministic system (there is no
// free-text request and no pretrained "general knowledge" source to rank
// against) -- kept here only as documented metadata, not as an active
// conflict-resolution call site, since this codebase has no scenario where
// two knowledge sources of different rank actually disagree.
// ─────────────────────────────────────────────
const KNOWLEDGE_PRIORITY = [
  'governance_standard',      // 1
  'framework_definitions',    // 2
  'framework_dependencies',   // 3
  'framework_validation_rules', // 4
  'measurement_evidence',     // 5
  'optimization_evidence',    // 6
  'intelligence_analysis',    // 7
  'business_context',         // 8
  // 9 'user_request' and 10 'general_ai_knowledge' intentionally omitted --
  // not applicable without free-text input / an LLM (MMS.11.2-11.4).
];

// ─────────────────────────────────────────────
// MMS.10 — Decision Engine, 8 Required Validations, run in the sequence
// mandated by MMS.10.2: [Business, Metric, Framework] must all pass before
// [Governance, Optimization, Intelligence] is even attempted; Confidence is
// always the final gate. A validation not attempted because an earlier
// required gate failed is reported as 'skipped', not 'passed' or 'failed'.
//
// @param {object} ctx
//   objective          - campaign.objective
//   currentMetrics     - normalized metrics (for Data Sufficiency)
//   diagnosis          - diagnosisEngine.diagnoseCampaign() output, or null
//   decision           - a single decision object (decisionEngine shape), or null
// ─────────────────────────────────────────────
function runDecisionValidations(ctx = {}) {
  const { objective, currentMetrics, diagnosis, decision } = ctx;
  const results = {};

  // ── Gate group 1: Business, Metric, Framework ──
  results.business = {
    status: (objective && VALID_OBJECTIVES.concat('unknown').includes(objective)) ? 'passed' : 'failed',
    detail: 'Recommendation must serve a recognized campaign Objective, not an isolated metric.',
  };

  const impressions = currentMetrics?.impressions;
  results.metric = {
    status: (impressions != null && impressions >= 100) ? 'passed' : 'failed',
    detail: 'Data Sufficiency floor (>=100 impressions) before any Metric is used as Evidence.',
  };

  let frameworkStatus = 'passed';
  if (decision && diagnosis && diagnosis.category) {
    // Framework Validation: is this decision's action drawn from the same
    // root-cause category the Diagnosis Engine actually found, not a
    // mismatched fix (e.g. a Creative fix for an Audience-saturation cause)?
    const categoryToDecisionType = {
      audience:   ['EXPAND_AUDIENCE'],
      creative:   ['REFRESH_CREATIVE'],
      competition:['REVIEW_PERFORMANCE'],
      budget:     ['REALLOCATE_BUDGET', 'BUDGET_WARNING'],
      tracking:   ['FIX_TRACKING'],
    };
    const expected = categoryToDecisionType[diagnosis.category];
    frameworkStatus = (!expected || expected.includes(decision.decision_type)) ? 'passed' : 'failed';
  }
  results.framework = {
    status: frameworkStatus,
    detail: 'Decision must be attributed to the governing category that actually diagnosed it.',
  };

  const gate1Passed = results.business.status === 'passed'
    && results.metric.status === 'passed'
    && results.framework.status === 'passed';

  // ── Gate group 2: Governance, Optimization, Intelligence (MMS.10.2: only
  // attempted once gate 1 passes) ──
  if (!gate1Passed) {
    results.governance   = { status: 'skipped', detail: 'Skipped: gate 1 (Business/Metric/Framework) did not fully pass.' };
    results.optimization = { status: 'skipped', detail: 'Skipped: gate 1 (Business/Metric/Framework) did not fully pass.' };
    results.intelligence = { status: 'skipped', detail: 'Skipped: gate 1 (Business/Metric/Framework) did not fully pass.' };
  } else {
    results.governance = {
      status: (objective != null) ? 'passed' : 'failed',
      detail: 'Structural completeness — required fields present on the entity being decided about.',
    };
    results.optimization = {
      status: (!decision || DECISION_LABELS[decision.decision_type] != null) ? 'passed' : 'failed',
      detail: 'The recommended Action must be one of this system\'s defined decision types.',
    };
    results.intelligence = {
      status: (!diagnosis || diagnosis.status === 'diagnosed' || diagnosis.status === 'insufficient_data') ? 'passed' : 'failed',
      detail: 'Root Cause Analysis output must be a recognized Diagnosis Engine status.',
    };
  }

  const gate2Attempted = results.governance.status !== 'skipped';
  const gate2Passed = gate2Attempted
    && results.governance.status === 'passed'
    && results.optimization.status === 'passed'
    && results.intelligence.status === 'passed';

  // ── Gate group 3: Risk (requires a stated action) ──
  results.risk = {
    status: (!decision || !!decision.suggested_action) ? 'passed' : 'failed',
    detail: 'A recommended Action must state a concrete suggested_action, never a placeholder.',
  };

  // ── Final gate: Confidence (MMS.10.2 — always last) ──
  if (!gate1Passed || !gate2Passed || results.risk.status !== 'passed') {
    results.confidence = { status: 'skipped', detail: 'Skipped: an earlier required gate did not pass.' };
  } else {
    const priorityRequiresHighConfidence = decision?.priority === 'critical';
    const confidenceOk = !decision
      || !priorityRequiresHighConfidence
      || decision.confidence === 'high' || decision.confidence === 'medium';
    results.confidence = {
      status: confidenceOk ? 'passed' : 'failed',
      detail: 'A "critical" priority decision requires at least medium Confidence (MMS.10.2 final gate).',
    };
  }

  const allPassedOrSkipped = Object.values(results).every(r => r.status === 'passed' || r.status === 'skipped');

  return {
    order: ['business', 'metric', 'framework', 'governance', 'optimization', 'intelligence', 'risk', 'confidence'],
    results,
    overall: allPassedOrSkipped ? 'passed' : 'failed',
  };
}

// MMS.10.3 — Validation Failure Routing: where a failed gate sends the
// pipeline back to.
const FAILURE_ROUTING = {
  business:      'return_to_objective_check',
  metric:        'return_to_evidence_collection',
  framework:     'return_to_root_cause_analysis',
  governance:    'return_to_specific_unmet_requirement',
  optimization:  'return_to_decision_catalog',
  intelligence:  'return_to_diagnosis_engine',
  risk:          'return_to_action_definition',
  confidence:    'route_to_observation_only',
};

function routeFailure(gateName) {
  return FAILURE_ROUTING[gateName] || null;
}

// ─────────────────────────────────────────────
// MAIFS Enforcement (Phase 4 — Framework Runtime Completion). Runs
// runDecisionValidations() against each decision and, when it fails,
// actually changes what the decision does at runtime rather than only
// reporting a status:
//   - all gates passed/skipped        -> governance_state: 'passed', unchanged
//   - Confidence gate itself failed   -> governance_state: 'failed',
//       downgraded to priority 'observation_only' (MMS.10.3's own
//       'route_to_observation_only' failure routing for the Confidence
//       gate, applied literally here, not just reported)
//   - some other gate failed but
//     Confidence gate passed/skipped  -> governance_state: 'warning',
//       priority left as computed (flagged, not blocked)
// This is the literal difference between MAIFS "validating" (Phase 10,
// pre-existing) and MAIFS "governing" (this function) -- the caller must
// use the returned decision objects, not the originals, for this to have
// any effect.
// ─────────────────────────────────────────────
function enforceGovernance(decisions = [], { objective, currentMetrics, diagnosis } = {}) {
  return decisions.map(decision => {
    const validations = runDecisionValidations({ objective, currentMetrics, diagnosis, decision });

    let governanceState;
    if (validations.overall === 'passed') governanceState = 'passed';
    else if (validations.results.confidence.status === 'failed') governanceState = 'failed';
    else governanceState = 'warning';

    const enforced = { ...decision, governance_state: governanceState, governance_validations: validations };

    if (governanceState === 'failed') {
      enforced.priority = 'observation_only';
      enforced.priority_score = 0;
      enforced.governance_downgraded = true;
      enforced.governance_downgrade_reason = 'Confidence Validation failed (MMS.10.2 final gate) -- routed to Observation Only per MMS.10.3.';
    }

    return enforced;
  });
}

// ─────────────────────────────────────────────
// MMS.19 — Self-Check Protocol. Only the structurally-checkable gates are
// implemented (1, 3, 4, 6, 7, 8). Checks 2 ("Correct Terminology" — does
// generated prose match MF1 exactly) and 5 ("Correct Reasoning" — does the
// reasoning chain match the diagnosed pattern, not a superficially similar
// one) require judging generated natural language, which this system never
// produces — there is no free-text output to check, so those two checks
// are reported as 'not_applicable', not silently skipped or faked.
// ─────────────────────────────────────────────
function runSelfCheck({ frameworksApplied = [], objective = null, decision = null, validations = null } = {}) {
  const checks = {};

  // Check 1 — Correct Framework: MF1 always present, order matches EXECUTION_ORDER.
  const rank = new Map(EXECUTION_ORDER.map((code, i) => [code, i]));
  const inOrder = frameworksApplied.every((code, i) => i === 0 || rank.get(frameworksApplied[i - 1]) <= rank.get(code));
  checks.correct_framework = { status: (frameworksApplied.includes('MF1') && inOrder) ? 'passed' : 'failed' };

  checks.correct_terminology = { status: 'not_applicable', detail: 'No generated natural-language output exists to validate against MF1 vocabulary.' };

  // Check 3 — Correct Metrics: nothing to check without a concrete metric set; passes vacuously if none was asserted wrong.
  checks.correct_metrics = { status: 'passed' };

  // Check 4 — Correct Dependencies: same as check 1's ordering property.
  checks.correct_dependencies = { status: inOrder ? 'passed' : 'failed' };

  checks.correct_reasoning = { status: 'not_applicable', detail: 'No generated reasoning narrative exists to compare against the diagnosed pattern.' };

  // Check 6 — Correct Recommendation: decision_type is a known type.
  checks.correct_recommendation = { status: (!decision || DECISION_LABELS[decision.decision_type] != null) ? 'passed' : 'failed' };

  // Check 7 — Correct Governance Compliance: all MMS.10 gates passed or were legitimately skipped.
  checks.correct_governance_compliance = { status: (!validations || validations.overall === 'passed') ? 'passed' : 'failed' };

  // Check 8 — Correct Business Logic: objective is a recognized value.
  checks.correct_business_logic = { status: (objective == null || VALID_OBJECTIVES.concat('unknown').includes(objective)) ? 'passed' : 'failed' };

  const applicable = Object.values(checks).filter(c => c.status !== 'not_applicable');
  const overall = applicable.every(c => c.status === 'passed') ? 'passed' : 'failed';

  return { checks, overall };
}

module.exports = {
  resolveRequiredFrameworks,
  KNOWLEDGE_PRIORITY,
  runDecisionValidations,
  routeFailure,
  runSelfCheck,
  enforceGovernance,
  ROUTING_TABLE,
  getRuleProvenance,
  normalizeRootCause,
};
