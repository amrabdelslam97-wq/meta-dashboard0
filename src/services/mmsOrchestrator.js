/**
 * MMS Orchestrator — Phase 10
 *
 * Composes (never replaces) the existing intelligence/diagnosis/decision
 * outputs into a single governance trace, per docs/META_MASTER_SYSTEM.md's
 * mechanically-specifiable rules (execution order, routing, decision
 * validation gates, self-check) as implemented in maifsGovernance.js.
 *
 * This module takes already-computed results from
 * intelligenceOrchestrator.runIntelligencePipeline(), diagnosisEngine.
 * diagnoseCampaign(), decisionEngine, and (Phase 11) ruleEngine.
 * executeRules() as input -- it does not call the Meta API, does not touch
 * the DB, and does not change any of their outputs. It only adds a
 * `_governance` attribution object alongside them.
 */

const { v4: uuidv4 } = require('uuid');
const frameworkRegistry = require('./frameworkRegistry');
const maifs = require('./maifsGovernance');
const { resolveProfile } = require('./kpiProfileResolver');
const { diagnoseCampaign } = require('./diagnosisEngine');
const { executeRules } = require('./ruleEngine');
const {
  decisionsFromRuleEngine, persistRuleEngineFirings,
  decisionShapeForGovernance, persistGovernanceState,
} = require('./decisionEngine');
const { measureOutcomes, applyHistoricalLearning } = require('./executiveMemory');
const db = require('../db/database');
const { runIntelligencePipeline, runScoringPipeline } = require('./intelligenceOrchestrator');
const metaLifecycle = require('./metaLifecycle');
require('./ruleRegistrySeed'); // side-effect: registers every Framework rule, in case no earlier require already did

// ─────────────────────────────────────────────
// Lifecycle short-circuit (root cause fix: the AI pipeline used to run its
// full performance analysis -- Health Score, Diagnosis, Recommendations,
// Rule Engine, Decisions -- for entities that are not actually delivering,
// because none of those engines knew Meta's real effective_status. This is
// the ONE gate every entity grain (campaign/ad_set/ad) passes through
// before any of that runs (see orchestrateIntelligence() below), so no
// individual engine needed its own special-casing.
// ─────────────────────────────────────────────

/**
 * Build the correctly-shaped `intelligence` bundle for a non-delivering
 * entity, matching whichever shape the caller expects for this entityType
 * (see intelligenceOrchestrator.js: runIntelligencePipeline()'s
 * campaign-shape vs runScoringPipeline()'s ad_set/ad-shape -- both are
 * mirrored here so insights.js/adSetIntelligence.js/adIntelligence.js need
 * no branching of their own).
 */
function buildLifecycleIntelligence({ entityType, campaign, lifecycle, recommendation }) {
  const emptyBenchmark = { summary: {}, metrics: {} };

  if (entityType === 'campaign') {
    return {
      campaign_id:   campaign.meta_campaign_id,
      campaign_name: campaign.name,
      objective:     campaign.objective,
      health: {
        score: null, status: 'not_delivering', reference: null, breakdown: null,
        note: lifecycle.message, trend: [],
      },
      benchmark: emptyBenchmark,
      goal_achievement: null,
      recommendations: [recommendation],
      alerts: [],
      meta: {
        fetched_at: new Date().toISOString(), duration_ms: 0,
        new_recommendations_fired: 0, new_alerts_fired: 0,
      },
    };
  }

  // ad_set / ad shape
  return {
    healthResult: {
      health_score: null, health_status: 'not_delivering', score_reference: null,
      breakdown: null, note: lifecycle.message,
    },
    benchmarkResult: emptyBenchmark,
    recommendations: [recommendation],
    alerts: [],
    trend: [],
    newRecommendationsCount: 0,
    newAlertsCount: 0,
  };
}

/**
 * The one lifecycle recommendation for a non-delivering entity -- shaped
 * like a normal recommendation_log row so every existing consumer
 * (Recommendations page, Decision Center, executive summary/objective
 * intelligence) can render it without a special case, but never one of
 * "Increase Budget"/"Scale"/"Creative Refresh"/"Audience Expansion" --
 * those all assume active delivery, which this entity does not have.
 */
function buildLifecycleRecommendation({ campaign, adAccountId, entityType, lifecycle }) {
  const ruleCode = 'LIFECYCLE_' + lifecycle.recommendationAction.toUpperCase().replace(/\s+/g, '_');
  return {
    id: null,
    rule_code: ruleCode,
    ad_account_id: adAccountId,
    entity_type: entityType,
    entity_meta_id: campaign.meta_campaign_id,
    entity_label: campaign.name,
    objective: campaign.objective,
    severity: 'info',
    recommendation_title: `${lifecycle.recommendationAction} (${lifecycle.label})`,
    recommendation_body: lifecycle.message,
    metric_snapshot: null,
    health_score_at_generation: null,
    governance_state: null,
    action_taken: false,
    action_notes: null,
    dismissed_at: null,
    generated_at: new Date().toISOString(),
    last_generated_at: new Date().toISOString(),
  };
}

/**
 * Persist the lifecycle recommendation and retire any stale performance-
 * based recommendations/alerts this entity accrued while it was still
 * delivering -- otherwise an old "Increase Budget"/"Low CTR" finding would
 * keep showing on the Recommendations page and Decision Center for an
 * entity that Meta itself says is no longer delivering (this IS the "do
 * not hide the issue" requirement: leaving stale findings in place would be
 * hiding the real, current state behind out-of-date ones).
 */
function persistLifecycleState({ campaign, adAccountId, entityType, recommendation }) {
  const now = new Date().toISOString();

  db.run(
    `UPDATE recommendation_log SET dismissed_at = ?
     WHERE entity_meta_id = ? AND dismissed_at IS NULL AND rule_code NOT LIKE 'LIFECYCLE_%'`,
    [now, campaign.meta_campaign_id]
  );
  db.run(
    `UPDATE active_alerts SET status = 'resolved', resolved_at = ?
     WHERE entity_meta_id = ? AND status = 'active'`,
    [now, campaign.meta_campaign_id]
  );

  const existing = db.get(
    `SELECT id FROM recommendation_log WHERE rule_code = ? AND entity_meta_id = ? AND dismissed_at IS NULL`,
    [recommendation.rule_code, campaign.meta_campaign_id]
  );
  if (existing) {
    db.run(`UPDATE recommendation_log SET last_generated_at = ? WHERE id = ?`, [now, existing.id]);
  } else {
    db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          objective, severity, recommendation_title, recommendation_body,
          reference_type, generated_at, last_generated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uuidv4(), recommendation.rule_code, adAccountId, entityType, campaign.meta_campaign_id,
        campaign.name, campaign.objective, recommendation.severity,
        recommendation.recommendation_title, recommendation.recommendation_body,
        'platform_default', now, now,
      ]
    );
  }
}

// ─────────────────────────────────────────────
// Shared by buildGovernanceTrace() (per-entity, MF1-MF8) and
// buildPortfolioTrace() (cross-account, MF10 -- Phase X.4). Both trace
// builders derive their own `signals` object from differently-shaped input
// (one from live recs/alerts/diagnosis, the other from already-persisted
// Decision-shaped rows), but the signals->frameworks resolution itself is
// identical -- extracted here so it's defined once, not duplicated.
// ─────────────────────────────────────────────
function resolveFrameworksFromSignals(signals) {
  const executionOrder = maifs.resolveRequiredFrameworks(signals);
  const frameworks = executionOrder.map(code => {
    const fw = frameworkRegistry.getFramework(code);
    return { code, name: fw?.name || null, status: fw?.status || null };
  });
  return { executionOrder, frameworks };
}

/**
 * @param {object} campaign - { objective }
 * @param {string} entityType - 'campaign' | 'ad_set' | 'ad' (Phase X.1 — Runtime Unification)
 * @param {object} currentMetrics - normalized metrics (for Data Sufficiency)
 * @param {object} intelligence - runIntelligencePipeline()/runScoringPipeline() output (may be partial/absent)
 * @param {object|null} diagnosis - diagnosisEngine.diagnoseCampaign() output, or null
 * @param {object[]} relatedDecisions - decision_history rows related to this campaign, or []
 * @param {object[]} ruleEngineFired - ruleEngine.executeRules().fired, or []
 */
// Bug fix (governance contradiction): validate ALL decisions produced by
// THIS orchestrateIntelligence() execution, never historical decision_history
// rows. Single-decision (the common case) keeps the exact prior shape --
// { order, results, overall } -- untouched. Multiple decisions get a
// { order, per_decision, overall } shape (there is no single valid `results`
// to represent >1 decision); `overall` is 'passed' only if every decision's
// own validation passed, so the top-level badge can never show "passed"
// while any real decision shows "failed"/"warning" -- the exact contradiction
// this fixes. Zero decisions preserves the original vacuous-pass behavior.
function aggregateDecisionValidations(currentDecisions, ctx) {
  if (currentDecisions.length === 0) {
    return maifs.runDecisionValidations({ ...ctx, decision: null });
  }
  if (currentDecisions.length === 1) {
    return maifs.runDecisionValidations({ ...ctx, decision: currentDecisions[0] });
  }
  const perDecision = currentDecisions.map(decision => ({
    decision_type: decision.decision_type || null,
    rule_id: decision.rule_id || decision.source_id || null,
    ...maifs.runDecisionValidations({ ...ctx, decision }),
  }));
  return {
    order: perDecision[0].order,
    per_decision: perDecision,
    overall: perDecision.every(p => p.overall === 'passed') ? 'passed' : 'failed',
  };
}

// The decision whose own validation is used for runSelfCheck()'s
// decision-specific checks (e.g. "is decision_type a known type") -- the
// first FAILING decision if any exist, so a real problem is never masked by
// picking a clean decision when a dirty one also fired this run.
function pickRepresentativeDecision(currentDecisions, validations) {
  if (currentDecisions.length === 0) return null;
  if (currentDecisions.length === 1) return currentDecisions[0];
  const failingIndex = validations.per_decision.findIndex(v => v.overall !== 'passed');
  return currentDecisions[failingIndex !== -1 ? failingIndex : 0];
}

function buildGovernanceTrace({ campaign, entityType = 'campaign', currentMetrics, intelligence = {}, diagnosis = null, currentDecisions = [], ruleEngineFired = [] } = {}) {
  const recommendations = intelligence?.recommendations || [];
  const alerts = intelligence?.alerts || [];
  const ruleCategories = new Set(ruleEngineFired.map(r => r.category));

  const signals = {
    // Phase X.1 fix: these two used to be hardcoded true/false regardless
    // of what entity this trace was actually built for -- confirmed dead
    // code path since nothing below campaign grain ever called this
    // function before Phase X.1 wired ad_set/ad grain into the same
    // pipeline. Now genuinely reflects the entity being analyzed.
    touchesCampaign: entityType === 'campaign',
    touchesAdSet: entityType === 'ad_set' || entityType === 'ad',
    touchesCreative: recommendations.some(r => r.rule_code === 'LOW_CTR') || diagnosis?.category === 'creative' || ruleCategories.has('creative'),
    touchesAudience: recommendations.some(r => r.rule_code === 'HIGH_FREQUENCY') || diagnosis?.category === 'audience' || ruleCategories.has('audience'),
    touchesDelivery: alerts.some(a => a.alert_code === 'CPM_SPIKE') || diagnosis?.category === 'competition' || ruleCategories.has('competition'),
    impliesAction: recommendations.length > 0 || currentDecisions.length > 0 || ruleEngineFired.length > 0,
    impliesDiagnosis: !!diagnosis,
    spansMultiple: false, // set true only when this trace is consumed at a cross-account/portfolio grain
  };

  const { executionOrder, frameworks } = resolveFrameworksFromSignals(signals);

  const recommendationProvenance = recommendations.map(r => ({
    rule_code: r.rule_code,
    provenance: maifs.getRuleProvenance(r.rule_code),
  }));
  const alertProvenance = alerts.map(a => ({
    alert_code: a.alert_code,
    provenance: maifs.getRuleProvenance(a.alert_code),
  }));

  const rootCauseCategory = diagnosis ? maifs.normalizeRootCause(diagnosis.category) : null;

  const validations = aggregateDecisionValidations(currentDecisions, {
    objective: campaign?.objective,
    currentMetrics,
    diagnosis,
  });
  const representativeDecision = pickRepresentativeDecision(currentDecisions, validations);

  const selfCheck = maifs.runSelfCheck({
    frameworksApplied: executionOrder,
    objective: campaign?.objective,
    decision: representativeDecision,
    validations,
  });

  return {
    maifs_version: 'MAIFS/MMS execution-order + validation rules (docs/META_MASTER_SYSTEM.md MMS.4, MMS.5.1, MMS.10, MMS.19)',
    execution_order: executionOrder,
    frameworks,
    root_cause_category: rootCauseCategory,
    recommendation_provenance: recommendationProvenance,
    alert_provenance: alertProvenance,
    rule_engine_fired_count: ruleEngineFired.length,
    decision_validations: validations,
    self_check: selfCheck,
  };
}

/**
 * MMS Runtime Orchestrator (Phase 5 — Framework Runtime Completion;
 * expanded in Phase X.1 — Runtime Unification).
 *
 * THE single per-entity pipeline: Objective Resolver -> KPI Resolver ->
 * [health/benchmark/recommendation/alert] -> Rule Engine -> Diagnosis
 * Engine -> Decision Engine -> MAIFS Enforcement -> Persistence ->
 * Governance trace. Every route/service analyzing one entity (campaign,
 * ad set, or ad) calls this one function instead of each independently
 * deciding which subset of the intelligence stack to run -- before Phase
 * X.1, `insights.js` called `runIntelligencePipeline()` separately from
 * this function, and `adSetIntelligence.js`/`adIntelligence.js` called
 * `runScoringPipeline()` directly and never reached Diagnosis/Rule Engine/
 * MAIFS at all. This function absorbs that call as its own internal first
 * step so there is one definition of "what runs, in what order" for any
 * entity grain, not three.
 *
 * Rule Engine now runs before Diagnosis Engine (per the target execution
 * order) -- confirmed safe: neither function reads the other's output;
 * they only meet later, inside MAIFS enforcement and the governance trace,
 * both of which already run after both are complete regardless of order.
 *
 * `entityType` ('campaign' | 'ad_set' | 'ad', default 'campaign') drives:
 *   - which absorbed pipeline runs (`runIntelligencePipeline` includes
 *     Goal Achievement, campaign-only; `runScoringPipeline` is the shared
 *     ad_set/ad path, identical to what adSetIntelligence.js/
 *     adIntelligence.js already called directly before this change)
 *   - Rule Engine grain filtering (ruleEngine.js's own `scope` gate)
 *   - the governance trace's touchesCampaign/touchesAdSet signals
 *
 * @param {object} campaign - { id, meta_campaign_id, name, objective }
 * @param {string} entityType - 'campaign' | 'ad_set' | 'ad'
 * @param {string} adAccountId
 * @param {object} currentMetrics
 * @param {object|null} priorMetrics
 * @param {object} deltas
 * @param {object|null} intelligence - PRE-COMPUTED runIntelligencePipeline()/
 *   runScoringPipeline() output, if the caller already has one. Transitional
 *   parameter for staged migration (Phase X.1 step 2): when omitted, this
 *   function computes it internally (step 0) instead -- once every caller
 *   stops passing this in, it can be removed.
 * @param {object[]} relatedDecisions - decision_history rows for this campaign, or [].
 *   Historical only -- purely passed through to the caller's own response
 *   (e.g. insights.js's `related_decisions` field) for display. Never fed
 *   into the Governance Trace/Self-Check below: that must only ever
 *   validate the decision(s) THIS execution just produced (bug fix -- see
 *   buildGovernanceTrace()'s `currentDecisions` param).
 * @param {number|null} budgetUtilizationPct - precomputed spend/budget %, or null if not available
 * @param {object|null} creativeContext - non-Insights per-creative fields the caller has
 *   already fetched from creative_analytics (e.g. { cta_type }), injected into the Rule
 *   Engine's `current` alongside currentMetrics -- same pattern as budgetUtilizationPct
 *   above (MF6.14.2), used by MF4.13.12 (Weak CTA), which needs a field
 *   fetchAdMetrics()/Insights never returns.
 * @param {boolean} persist - whether to write Rule Engine firings to rule_engine_log (default true)
 * @param {string|null} effectiveStatus - the entity's real Meta effective_status
 *   (e.g. "ACTIVE", "CAMPAIGN_PAUSED", "DISAPPROVED"). When this resolves to
 *   "not delivering" (anything other than ACTIVE), the ENTIRE performance
 *   pipeline below (health score, benchmark, recommendations, alerts, rule
 *   engine, diagnosis, decisions) is skipped -- generating any of those for
 *   an entity that isn't delivering is exactly the bug this param exists to
 *   prevent. A lifecycle-only bundle is returned instead (see
 *   buildLifecycleIntelligence()/buildLifecycleRecommendation() above).
 */
function orchestrateIntelligence({
  campaign, entityType = 'campaign', adAccountId, currentMetrics, priorMetrics, deltas,
  intelligence: precomputedIntelligence = null,
  relatedDecisions = [], budgetUtilizationPct = null, creativeContext = null, persist = true,
  effectiveStatus = null,
} = {}) {
  const lifecycle = metaLifecycle.resolveLifecycle(effectiveStatus);

  if (effectiveStatus && !lifecycle.isDelivering) {
    const recommendation = buildLifecycleRecommendation({ campaign, adAccountId, entityType, lifecycle });
    const intelligence = buildLifecycleIntelligence({ entityType, campaign, lifecycle, recommendation });
    const diagnosis = {
      status: 'not_delivering',
      objective: campaign.objective || null,
      primaryKey: null,
      primaryLabel: null,
      primaryDelta: null,
      category: 'lifecycle',
      confidence: 'high',
      priority: 'lifecycle_action',
      factors: [],
      summary: 'This entity is currently not delivering.',
      lifecycle_status: lifecycle.code,
      lifecycle_label: lifecycle.label,
    };

    if (persist) {
      persistLifecycleState({ campaign, adAccountId, entityType, recommendation });
    }

    // No decisions are produced on the lifecycle short-circuit path (empty
    // ruleEngineDecisions below) -- currentDecisions is correctly []
    // (its default), never the caller's historical relatedDecisions.
    const governance = buildGovernanceTrace({
      campaign, entityType, currentMetrics, intelligence, diagnosis, ruleEngineFired: [],
    });

    return {
      intelligence,
      diagnosis,
      ruleEngineResult: { fired: [], conflicts: [] },
      ruleEngineDecisions: [],
      governance,
    };
  }

  const profile = resolveProfile(campaign.objective);

  // Step 0 — absorbed health/benchmark/recommendation/alert pipeline.
  // Business logic unchanged (intelligenceOrchestrator.js itself was not
  // touched); only WHO calls it moved. Campaign grain gets the full
  // pipeline (adds Goal Achievement); ad_set/ad grain get the shared
  // scoring pipeline, identical to what adSetIntelligence.js/
  // adIntelligence.js already called directly before this change.
  const intelligence = precomputedIntelligence || (
    entityType === 'campaign'
      ? runIntelligencePipeline(campaign, currentMetrics, priorMetrics, adAccountId)
      : runScoringPipeline(campaign, currentMetrics, priorMetrics, adAccountId, entityType)
  );

  // Step 0.5 — Executive Memory: measure outcomes of past completed
  // decisions for this campaign (Phase X.6). Pure side-effect (writes
  // decision_outcomes for anything old enough and not yet measured); uses
  // the currentMetrics this call already fetched, no new Meta API call.
  // Gated by `persist` for the same write-amplification reason Step 5's
  // other writes are (see Phase X.1's ad_set/ad list-view rationale).
  if (persist) {
    measureOutcomes(campaign, currentMetrics);
  }

  // Step 1 — Rule Engine (runs before Diagnosis Engine per the target
  // order). budget_utilization_pct (if the caller computed it from
  // ad_sets.daily_budget) and creativeContext (e.g. cta_type, if the caller
  // fetched it from creative_analytics) are injected as synthetic fields so
  // MF6.14.2/MF4.13.12 can evaluate them via the same generic condition
  // evaluator as every other rule, without fetchAdMetrics()/Insights itself
  // needing to know about non-Insights fields.
  const ruleEngineCurrent = (budgetUtilizationPct != null || creativeContext)
    ? { ...currentMetrics, ...(budgetUtilizationPct != null ? { budget_utilization_pct: budgetUtilizationPct } : {}), ...(creativeContext || {}) }
    : currentMetrics;
  const ruleEngineResult = executeRules({ current: ruleEngineCurrent, deltas, objective: campaign.objective, entityType });

  // Step 2 — Diagnosis Engine.
  const diagnosis = priorMetrics
    ? diagnoseCampaign(campaign, profile, currentMetrics, priorMetrics, deltas)
    : null;

  // Step 2b — Executive Memory: persist this diagnosis (Phase X.6).
  // diagnosisEngine.js itself is unchanged (still pure logic, no DB access,
  // per its own header) -- persistence is a caller-side concern here, same
  // separation already used for health scores (healthScoreEngine.saveHealthScore()
  // is called from intelligenceOrchestrator.js, not from inside the scoring
  // logic itself).
  if (persist && diagnosis) {
    db.run(
      `INSERT INTO diagnosis_history
         (id, ad_account_id, entity_type, entity_meta_id, objective, status,
          primary_key, primary_label, delta_pct, category, confidence, priority,
          factors, summary, calculated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uuidv4(), adAccountId, entityType, campaign.meta_campaign_id, diagnosis.objective, diagnosis.status,
        diagnosis.primaryKey || null, diagnosis.primaryLabel || null, diagnosis.primaryDelta?.delta_pct ?? null,
        diagnosis.category || null, diagnosis.confidence || null, diagnosis.priority || null,
        JSON.stringify(diagnosis.factors || []), diagnosis.summary || null, new Date().toISOString(),
      ]
    );
  }

  // Step 3 — Decision Engine: Rule Engine firings become Decision-shaped objects.
  let ruleEngineDecisions = decisionsFromRuleEngine(campaign, adAccountId, ruleEngineResult.fired);

  // Step 3.5 — Executive Memory: apply historical learning BEFORE MAIFS sees
  // these decisions (Phase X.6), so a confidence downgrade from repeated
  // ineffectiveness can legitimately then fail MAIFS's own, unmodified
  // Confidence gate -- not a new gate, a correct interaction with the
  // existing one. Applied uniformly to all three governed sources
  // (rule_engine, recommendation, alert); opportunity-sourced decisions
  // stay excluded, same reasoning as Phase X.3/X.4 (no live metrics context
  // at that grain).
  ruleEngineDecisions = applyHistoricalLearning(ruleEngineDecisions);
  const recommendationShapes = applyHistoricalLearning(
    (intelligence.recommendations || []).map(r => ({
      ...decisionShapeForGovernance('recommendation', r),
      meta_campaign_id: campaign.meta_campaign_id,
    }))
  );
  const alertShapes = applyHistoricalLearning(
    (intelligence.alerts || []).map(a => ({
      ...decisionShapeForGovernance('alert', a),
      meta_campaign_id: campaign.meta_campaign_id,
    }))
  );

  // Step 4 — MAIFS Enforcement: validation now changes the decision's
  // priority, it does not merely get reported alongside it.
  ruleEngineDecisions = maifs.enforceGovernance(ruleEngineDecisions, {
    objective: campaign.objective, currentMetrics, diagnosis,
  });

  // Reflect each decision's enforced governance_state (and Executive
  // Memory's historical fields) back onto its source rule firing, so
  // persistence and the API's `framework_recommendations` field agree with
  // what the Decision Center will show.
  const governanceByRuleId = new Map(ruleEngineDecisions.map(d => [d.rule_id, d.governance_state]));
  const historyByRuleId = new Map(ruleEngineDecisions.map(d => [d.rule_id, { historical_note: d.historical_note || null, historical_effectiveness: d.historical_effectiveness || null }]));
  const firedWithGovernance = ruleEngineResult.fired.map(f => ({
    ...f,
    governance_state: governanceByRuleId.get(f.rule_id) || null,
    ...(historyByRuleId.get(f.rule_id) || { historical_note: null, historical_effectiveness: null }),
  }));

  // Step 4b — MAIFS Enforcement for recommendation-/alert-sourced findings
  // (Phase X.3 -- MAIFS Enforcement). Same enforceGovernance() call as Step
  // 4 above, applied to the recommendations/alerts this same pipeline just
  // computed in Step 0 -- full currentMetrics/diagnosis context is
  // available here, which is why this is the one point in the codebase
  // this can be computed correctly (see the Phase X.3 design doc for why
  // the Decision Center's cross-campaign reads never recompute this).
  const recGovernance = maifs.enforceGovernance(recommendationShapes, { objective: campaign.objective, currentMetrics, diagnosis });
  const alertGovernance = maifs.enforceGovernance(alertShapes, { objective: campaign.objective, currentMetrics, diagnosis });
  intelligence.recommendations = (intelligence.recommendations || []).map((r, i) => ({
    ...r,
    governance_state: recGovernance[i].governance_state,
    historical_note: recommendationShapes[i].historical_note || null,
    historical_effectiveness: recommendationShapes[i].historical_effectiveness || null,
  }));
  intelligence.alerts = (intelligence.alerts || []).map((a, i) => ({
    ...a,
    governance_state: alertGovernance[i].governance_state,
    historical_note: alertShapes[i].historical_note || null,
    historical_effectiveness: alertShapes[i].historical_effectiveness || null,
  }));

  // Step 5 — Persist. Closes the Decision Engine/Rule Engine disconnect:
  // these firings become visible to generateTodaysDecisions() (Decision
  // Center) via decisionsFromRuleEngineLog(), not just this request's
  // response. entityType is threaded through so ad_set/ad firings are
  // never mislabeled 'campaign' in rule_engine_log.
  if (persist) {
    persistRuleEngineFirings(adAccountId, campaign, firedWithGovernance, entityType);

    db.transaction(tx => {
      intelligence.recommendations.forEach(r => {
        persistGovernanceState('recommendation_log', 'rule_code', r.rule_code, campaign.meta_campaign_id, r.governance_state, tx);
      });
      intelligence.alerts.forEach(a => {
        persistGovernanceState('active_alerts', 'alert_code', a.alert_code, campaign.meta_campaign_id, a.governance_state, tx);
      });
    });
  }

  // Step 6 — Governance trace. Bug fix: validate the decisions THIS
  // execution just produced and enforced above (Steps 3-4b) -- rule-engine-,
  // recommendation-, and alert-sourced alike -- never `relatedDecisions`
  // (historical decision_history rows the caller fetched before this run
  // even started). Historical decisions are still returned to the caller
  // separately (insights.js's own `related_decisions` field) for display;
  // they must never again influence this Governance Self Check.
  const governance = buildGovernanceTrace({
    campaign, entityType, currentMetrics, intelligence, diagnosis,
    currentDecisions: [...ruleEngineDecisions, ...recGovernance, ...alertGovernance],
    ruleEngineFired: firedWithGovernance,
  });

  return {
    intelligence,
    diagnosis,
    ruleEngineResult: { ...ruleEngineResult, fired: firedWithGovernance },
    ruleEngineDecisions,
    governance,
  };
}

// ─────────────────────────────────────────────
// MMS cross-account trace (Phase X.4 — MMS Runtime Kernel). Wraps the
// ALREADY-COMPUTED output of a cross-account/portfolio-grain operation
// (decisionEngine.generateTodaysDecisions(), portfolioEngine.js's exports,
// topWinnersEngine/topLosersEngine) with the same signals->frameworks
// resolution buildGovernanceTrace() uses at the per-entity grain -- it does
// NOT re-execute or duplicate the caller's aggregation logic, and it does
// NOT call maifs.enforceGovernance()/runDecisionValidations(): those gates
// need currentMetrics.impressions and diagnosis.category, neither of which
// exists for a row read back from already-persisted tables days after it
// was (or wasn't) governed at the per-entity grain. Reporting
// `governance: 'not_applicable'` here is a deliberate, honest choice over
// faking a check that would fail for every row regardless of content (see
// the Phase X.4 design doc's "why cross-account governance is
// 'not_applicable', not faked").
//
// @param {object[]} decisions - Decision-shaped objects (any source: rule_engine,
//   recommendation, alert, opportunity) or portfolio/ranking rows exposing
//   `decision_type`/`category` fields where available.
// ─────────────────────────────────────────────
function buildPortfolioTrace({ decisions = [] } = {}) {
  const categories = new Set(decisions.map(d => d.category).filter(Boolean));
  const decisionTypes = new Set(decisions.map(d => d.decision_type).filter(Boolean));

  const signals = {
    touchesCampaign: true, // cross-account reads always aggregate campaign-grain rows
    touchesAdSet: false,
    touchesCreative: categories.has('creative') || decisionTypes.has('REFRESH_CREATIVE'),
    touchesAudience: categories.has('audience') || decisionTypes.has('EXPAND_AUDIENCE'),
    touchesDelivery: categories.has('competition') || decisionTypes.has('REVIEW_PERFORMANCE'),
    impliesAction: decisions.length > 0,
    impliesDiagnosis: false, // no diagnosis exists at this grain
    spansMultiple: true,
  };

  const { executionOrder, frameworks } = resolveFrameworksFromSignals(signals);

  return {
    execution_order: executionOrder,
    frameworks,
    evidence_count: decisions.length,
    governance: 'not_applicable',
    governance_reason: 'Cross-account aggregation reads already-persisted rows with no live ' +
      'currentMetrics/diagnosis for this exact moment -- MAIFS Metric/Framework validation ' +
      'gates cannot be meaningfully evaluated at this grain. Any governance_state present on ' +
      'individual rows was computed earlier, at the per-entity grain (Phase X.3), and is not ' +
      're-validated here.',
  };
}

module.exports = {
  buildGovernanceTrace, buildPortfolioTrace, orchestrateIntelligence,
  buildLifecycleIntelligence, buildLifecycleRecommendation,
};
