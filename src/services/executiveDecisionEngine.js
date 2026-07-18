/**
 * Executive Decision Engine — Phase 45 (AI Executive Decision Layer)
 *
 * Pure logic, no DB access. Sits ONE layer above everything Phase 42-44
 * already built (advisorEngine.js's panel/priorities/root-cause/benchmark,
 * the Rule Engine's fired findings, fatigue/health) and arbitrates them
 * into a SINGLE canonical decision -- the one thing this phase adds that
 * didn't exist before. Never recomputes a score, never re-implements
 * fatigue/health/rule-engine logic; every input here is already-computed
 * data the caller (creativeLibrary.js) passes in.
 *
 * House rule (same as every prior phase): every field must trace to a real,
 * already-computed number or signal. Where there truly isn't enough
 * evidence, say so -- never fabricate a percentage or a business-impact
 * number that isn't derived from something real.
 */

const { computeConfidence } = require('./executiveReasoningEngine');

// ─────────────────────────────────────────────
// TASK 1 — The one allowed vocabulary. Every module's own internal verdict
// (advisor panel's current_status, the Rule Engine's fired actions, fatigue
// status) still exists and is still computed exactly as before -- this
// engine only ARBITRATES them into one of these six for the user-facing
// "Executive Decision", so two modules can never show contradicting labels.
// ─────────────────────────────────────────────
const ALLOWED_DECISIONS = ['STOP', 'PAUSE', 'TEST', 'OPTIMIZE', 'MONITOR', 'SCALE'];

// Conservatism rank -- LOWER is more conservative/urgent. When two real
// signals disagree about what to do, the more conservative one always wins
// (never let an optimistic "Scale" verdict override a real critical
// warning elsewhere in the system). This single rule is the entire
// conflict-resolution policy, documented once, applied everywhere below.
const CONSERVATISM_RANK = { STOP: 0, PAUSE: 1, TEST: 2, OPTIMIZE: 3, MONITOR: 4, SCALE: 5 };

function moreConservative(a, b) {
  return CONSERVATISM_RANK[a] <= CONSERVATISM_RANK[b] ? a : b;
}

/** Maps the advisor panel's already-vetted current_status onto the canonical enum, adding one severity split (STOP vs PAUSE) the panel itself doesn't distinguish. */
function baseDecisionFromPanel(panelStatus, { healthStatus, fatigue, scores } = {}) {
  if (panelStatus === 'Pause') {
    const compounding = healthStatus === 'critical' || (fatigue?.status === 'severe' && scores?.score_overall != null && scores.score_overall < 30);
    return compounding ? 'STOP' : 'PAUSE';
  }
  if (panelStatus === 'Scale') return 'SCALE';
  if (panelStatus === 'Refresh') return 'OPTIMIZE';
  if (panelStatus === 'Rewrite') return 'TEST';
  if (panelStatus === 'Leave Unchanged' || panelStatus === 'Monitor') return 'MONITOR';
  return 'MONITOR';
}

/**
 * Real Rule Engine firings (already scope-filtered to this entity grain by
 * ruleEngine.js's own executeRules()) can imply a MORE conservative
 * decision than the advisor synthesis alone would reach -- e.g. a critical
 * tracking-integrity finding should never be silently outvoted by an
 * optimistic creative score. Each mapping below is a real Rule Engine
 * severity + action.type combination already in this codebase's registry
 * (ruleRegistrySeed.js) -- never an invented rule.
 */
function ruleEngineCandidateDecisions(ruleEngineFindings) {
  const candidates = [];
  for (const f of ruleEngineFindings || []) {
    const actionType = f.action?.type;
    const meta = { module: 'Rule Engine', id: f.rule_id, name: f.rule_name, reason: f.reason };
    if (f.severity === 'critical' && actionType === 'FIX_TRACKING') {
      candidates.push({ decision: 'STOP', ...meta });
    } else if (f.severity === 'critical' && (actionType === 'REALLOCATE_BUDGET' || actionType === 'REVIEW_PERFORMANCE')) {
      candidates.push({ decision: 'PAUSE', ...meta });
    } else if (f.severity === 'critical' && actionType === 'REFRESH_CREATIVE') {
      candidates.push({ decision: 'TEST', ...meta });
    } else if (f.severity === 'warning' && actionType === 'REFRESH_CREATIVE') {
      candidates.push({ decision: 'OPTIMIZE', ...meta });
    } else if (f.severity === 'warning') {
      candidates.push({ decision: 'OPTIMIZE', ...meta });
    }
    // severity 'info' findings never move the decision -- they're context, not a verdict.
  }
  return candidates;
}

/**
 * TASK 13 — real, already-persisted Budget Intelligence (budget_analysis_
 * history.waste_detected) and Audience Intelligence (audience_score_history
 * .saturation_score) signals for this ad's campaign, when the caller has
 * fetched them (creativeLibrary.js does one cheap indexed lookup per
 * table -- see getCrossModuleSignals()). Both are OPTIONAL: absent data
 * never fabricates a candidate, it's simply not included in arbitration.
 */
function crossModuleCandidateDecisions(crossModuleSignals) {
  const candidates = [];
  const budget = crossModuleSignals?.budget;
  const audience = crossModuleSignals?.audience;

  if (budget && budget.waste_detected) {
    candidates.push({
      decision: 'OPTIMIZE', module: 'Budget Intelligence', id: 'waste_detected',
      name: 'Budget waste detected', reason: `Budget Intelligence flagged wasted spend in this ad's campaign (efficiency: ${budget.efficiency_status || 'unknown'}${budget.waste_amount != null ? `, ~$${budget.waste_amount} wasted` : ''}).`,
    });
  }
  if (audience && audience.saturation_score != null && audience.saturation_score >= 70) {
    candidates.push({
      decision: 'OPTIMIZE', module: 'Audience Intelligence', id: 'saturation_score',
      name: 'Audience saturation', reason: `Audience Intelligence shows high saturation (score ${audience.saturation_score}) for this campaign's audience.`,
    });
  }
  return candidates;
}

/**
 * Dashboard Normalization (Phase 46) — real, currently-active DB-rule-driven
 * recommendations (recommendationEngine.js's recommendation_rules ->
 * recommendation_log, campaign-grain -- e.g. LOW_ROAS/LOW_CTR/HIGH_FREQUENCY)
 * were always computed by this system but never fed into the single
 * arbitrated decision, so this ad's Executive Decision could disagree with
 * a real, currently-firing rule on its own campaign with no reconciliation.
 * Same severity-based candidate shape as ruleEngineCandidateDecisions()
 * above -- critical severity is conservative enough to warrant pausing,
 * warning severity warrants a general optimization pass. Never invents a
 * new rule, never changes what recommendationEngine.js itself computes;
 * this only makes the arbitration aware of an already-real signal.
 */
function recommendationLogCandidateDecisions(recommendationLogRows) {
  const candidates = [];
  for (const r of recommendationLogRows || []) {
    const meta = { module: 'Recommendation Rules', id: r.rule_code, name: r.recommendation_title, reason: r.recommendation_body };
    if (r.severity === 'critical') {
      candidates.push({ decision: 'PAUSE', ...meta });
    } else if (r.severity === 'warning') {
      candidates.push({ decision: 'OPTIMIZE', ...meta });
    }
    // 'info'-severity rows never move the decision -- matches the native Rule Engine's own convention (info is context, not a verdict).
  }
  return candidates;
}

/**
 * TASK 1 + TASK 13 — the single arbitration point across every module this
 * platform has a real, already-computed verdict from (the Advisor panel,
 * the Rule Engine, and -- when the caller supplies them -- Budget/Audience
 * Intelligence). Returns the final decision plus a `consistency_audit`:
 * empty when every signal already agreed, or a real trail naming which
 * MODULE disagreed and why the more conservative signal won, whenever an
 * override actually happened (Task 13's "automatically determine the root
 * cause" requirement).
 */
function resolveExecutiveDecision({ panelStatus, healthStatus, fatigue, scores, ruleEngineFindings, crossModuleSignals, recommendationLogRows }) {
  const base = baseDecisionFromPanel(panelStatus, { healthStatus, fatigue, scores });
  const candidates = [
    ...ruleEngineCandidateDecisions(ruleEngineFindings).map(c => ({ ...c, source: 'advisor_vs_rule_engine' })),
    ...crossModuleCandidateDecisions(crossModuleSignals).map(c => ({ ...c, source: 'advisor_vs_cross_module' })),
    ...recommendationLogCandidateDecisions(recommendationLogRows).map(c => ({ ...c, source: 'advisor_vs_recommendation_rules' })),
  ];

  let final = base;
  const overrides = [];
  for (const c of candidates) {
    const winner = moreConservative(final, c.decision);
    if (winner !== final) {
      overrides.push({
        from: final, to: winner, module: c.module, root_cause: c.name,
        because: `${c.module} finding "${c.name}"${c.id ? ` (${c.id})` : ''} is more conservative than the current ${final} verdict -- ${c.reason}`,
      });
      final = winner;
    } else if (c.decision !== final && CONSERVATISM_RANK[c.decision] > CONSERVATISM_RANK[final]) {
      // A less-conservative signal existed but didn't win -- still worth
      // recording as a real disagreement that was resolved, not silently
      // dropped (Task 13: every module disagreement gets a root cause).
      overrides.push({
        from: final, to: final, module: c.module, root_cause: c.name,
        because: `${c.module} finding "${c.name}" suggested ${c.decision}, but the Advisor's ${final} is already more conservative and takes precedence.`,
      });
    }
  }

  const consistency_audit = overrides.length
    ? { agreement: 'resolved', signals_disagreed: true, resolution_rule: 'The more conservative (halt-leaning) signal always wins.', overrides }
    : { agreement: 'unanimous', signals_disagreed: false, resolution_rule: null, overrides: [] };

  return { decision: final, base_from_advisor: base, consistency_audit };
}

// ─────────────────────────────────────────────
// TASK 3 — Decision Explanation ("why not the other decisions?"). Every
// reason below is grounded in a real field the caller already computed
// (score vs. the same STRONG_SCORE/WEAK_SCORE thresholds advisorEngine.js
// uses, real health/fatigue status, real benchmark verdict).
// ─────────────────────────────────────────────
const STRONG_SCORE = 65;
const WEAK_SCORE = 40;

function buildWhyNot(decision, { scores, fatigue, healthStatus, benchmarkVerdict, priorities, crossModuleSignals, recommendationLogRows } = {}) {
  const score = scores?.score_overall;
  const reasons = {};

  if (decision !== 'SCALE') {
    reasons.SCALE = score == null
      ? 'Not enough creative-score data yet to justify scaling.'
      : score < STRONG_SCORE
        ? `Creative score (${score}) is below the scaling threshold (${STRONG_SCORE}).`
        : fatigue?.status && fatigue.status !== 'none'
          ? `Fatigue status is "${fatigue.status}" -- scaling a fatiguing creative would accelerate the decline.`
          : benchmarkVerdict?.verdict === 'below_average'
            ? 'Performance is currently below its peer average, not above it.'
            : 'A more conservative signal elsewhere in the system currently outranks scaling.';
  }
  if (decision !== 'PAUSE' && decision !== 'STOP') {
    // Honest about the real health status either way -- never asserts
    // "not critical" when it might in fact be critical; only states what
    // health actually is and that no signal currently escalates it to Pause.
    reasons.PAUSE = healthStatus
      ? `Health status is "${healthStatus}" -- no fatigue or health signal currently escalates this to a Pause.`
      : 'No fatigue or health signal currently justifies pausing.';
  }
  if (decision !== 'STOP') {
    reasons.STOP = 'No compounding failure (critical health AND severe fatigue/very low score together) is present.';
  }
  if (decision !== 'TEST') {
    reasons.TEST = (priorities && priorities[0])
      ? `The top-priority fix (${priorities[0].action}) is already the current decision or a lower-conservatism one is a better fit right now.`
      : 'No single weak dimension stands out enough yet to justify a dedicated test.';
  }
  if (decision !== 'OPTIMIZE') {
    const budgetWaste = crossModuleSignals?.budget?.waste_detected;
    const audienceSaturation = crossModuleSignals?.audience?.saturation_score;
    const activeRule = (recommendationLogRows || [])[0];
    reasons.OPTIMIZE = budgetWaste
      ? 'Budget waste was flagged, but a more conservative action already takes priority over a general optimization pass.'
      : (audienceSaturation != null && audienceSaturation >= 70)
        ? `Audience saturation was flagged (score ${audienceSaturation}), but a more conservative action already takes priority.`
        : activeRule
          ? `"${activeRule.recommendation_title}" was flagged, but a more conservative action already takes priority over a general optimization pass.`
          : (fatigue?.status === 'none' || fatigue?.status == null)
            ? 'No moderate fatigue, budget-waste, audience-saturation, or rule-based signal is currently active.'
            : 'A more urgent or more conservative action already takes priority over a general optimization pass.';
  }
  if (decision !== 'MONITOR') {
    reasons.MONITOR = 'A real signal (fatigue, health, score, or a Rule Engine finding) already justifies a more specific action than simply watching.';
  }

  return reasons;
}

// ─────────────────────────────────────────────
// TASK 2 — Executive Priority Card ("If you do only one thing today").
// Exactly one recommendation, reshaped -- never a second competing card.
// ─────────────────────────────────────────────
function buildExecutivePriorityCard(priorities) {
  if (!priorities || priorities.length === 0) {
    return { available: false, reason: 'No specific action is currently prioritized above the others.' };
  }
  const top = priorities[0];
  const businessImpactLabel = priorities.length > 1 && top.confidence_pct >= (priorities[1].confidence_pct || 0)
    ? 'Highest'
    : 'High';
  return {
    available: true,
    action: top.action,
    business_impact: businessImpactLabel,
    confidence_pct: top.confidence_pct,
    reason: top.why,
    estimated_gain: priorities.length > 1
      ? `Highest expected impact among the ${priorities.length} available actions right now.`
      : 'The only concrete action currently available for this creative.',
  };
}

// ─────────────────────────────────────────────
// TASK 4 — Marketing Director Mode. A real 4-step sequence built from the
// already-resolved decision + top priorities + real benchmark verdict --
// never a generic template unrelated to this ad's actual data.
// ─────────────────────────────────────────────
function buildMarketingDirectorPlan({ decision, priorities, latestRow, benchmarkVerdict }) {
  const today = {
    STOP: 'Pause this creative and review the account/tracking issue flagged below before spending further.',
    PAUSE: 'Pause this creative -- it is actively fatiguing or underperforming.',
    TEST: `Keep it running, but treat "${priorities?.[0]?.action || 'the top fix'}" as today's test hypothesis.`,
    OPTIMIZE: `Keep it running while you apply "${priorities?.[0]?.action || 'the top recommendation'}".`,
    MONITOR: 'Keep the campaign running as-is -- no action needed today.',
    SCALE: 'Keep the campaign running -- it is currently healthy and outperforming.',
  }[decision] || 'Keep monitoring.';

  const tomorrow = priorities?.[0]
    ? `Implement: ${priorities[0].action}.`
    : 'Re-check performance once more data has accumulated.';

  const thisWeek = priorities?.[1]
    ? `Implement: ${priorities[1].action}, and evaluate the results of yesterday's change.`
    : 'Monitor the results of this week\'s change before making another one.';

  const ctrHint = latestRow?.ctr != null ? ` (current CTR ${latestRow.ctr}%)` : '';
  const nextWeek = decision === 'SCALE'
    ? `Increase budget if CTR remains stable${ctrHint}.`
    : decision === 'TEST' || decision === 'OPTIMIZE'
      ? `Re-evaluate the creative score once this week's change has had time to register${ctrHint}.`
      : benchmarkVerdict?.verdict === 'below_average'
        ? 'Re-assess against peer average once the current fix has had a full week to take effect.'
        : 'Reassess whether this creative is ready to scale.';

  // Next Month -- a real, longer-horizon statement grounded in the same
  // decision + priorities, never a generic template unrelated to this ad.
  const nextMonth = (decision === 'STOP' || decision === 'PAUSE')
    ? 'Only revisit this creative once the underlying fatigue/health/tracking issue has been resolved elsewhere in the account.'
    : (decision === 'TEST' || decision === 'OPTIMIZE')
      ? `Confirm whether ${priorities?.[0]?.action || 'this week’s fix'} actually resolved the bottleneck; if not, plan a fuller creative refresh rather than repeating the same fix.`
      : decision === 'SCALE'
        ? 'If performance holds through the month, apply this creative’s real winning formula (see below) to a new variant or an adjacent audience.'
        : 'Re-benchmark against the account average to decide whether it is time to scale or intervene.';

  return { today, tomorrow, this_week: thisWeek, next_week: nextWeek, next_month: nextMonth };
}

// ─────────────────────────────────────────────
// TASK 5 / 6 — Winning Formula / Loss Formula. Normalizes the REAL, already
// -computed root_cause positive/negative factor impacts into percentage
// contributions that sum to 100 -- never invents a dimension (like "Audience
// Quality" or "Creative Timing") this system has no real signal for.
// ─────────────────────────────────────────────
function buildContributionFormula(factors, limit = 5) {
  const real = (factors || []).filter(f => f.impact > 0).slice(0, limit);
  if (real.length === 0) {
    return { available: false, reason: 'No single factor stands out enough yet to build a reliable formula.' };
  }
  const total = real.reduce((s, f) => s + f.impact, 0);
  const items = real.map(f => ({ factor: f.factor, contribution_pct: Math.round((f.impact / total) * 100), evidence: f.evidence }));
  // Rounding can leave the total a point or two off 100 -- correct the
  // largest contributor rather than silently reporting e.g. 99% or 101%,
  // since the whole point of this section is that it sums to a real 100%.
  const drift = 100 - items.reduce((s, i) => s + i.contribution_pct, 0);
  if (drift !== 0 && items.length) items[0].contribution_pct += drift;
  return { available: true, items };
}

function buildWinningFormula(rootCause) {
  return buildContributionFormula(rootCause?.positive_factors);
}
function buildLossFormula(rootCause) {
  const result = buildContributionFormula(rootCause?.negative_factors, 3);
  if (!result.available) return result;
  return {
    available: true,
    largest_weakness: result.items[0] || null,
    second_weakness: result.items[1] || null,
    third_weakness: result.items[2] || null,
  };
}

// ─────────────────────────────────────────────
// TASK 9 — Recommendation Conflict Detection. A small, explicit
// compatibility table -- growth actions vs. actions that only make sense
// on a creative that ISN'T being scaled yet. When a conflict exists, the
// higher-priority (earlier) action wins and the conflicting one is dropped
// (never silently shown side-by-side as contradictory advice).
// ─────────────────────────────────────────────
const GROWTH_ACTIONS = new Set(['Scale', 'Increase Budget', 'Duplicate Winner', 'Duplicate']);
const CREATIVE_FIX_ACTIONS = new Set(['Rewrite Hook', 'Shorten Copy', 'Improve CTA', 'Add Social Proof', 'Use Better Offer', 'Replace Thumbnail', 'Reduce Text', 'Refresh']);
const HALT_ACTIONS = new Set(['Pause', 'Pause Loser']);

function actionsConflict(a, b) {
  if (a === b) return false;
  if (GROWTH_ACTIONS.has(a) && CREATIVE_FIX_ACTIONS.has(b)) return true;
  if (GROWTH_ACTIONS.has(b) && CREATIVE_FIX_ACTIONS.has(a)) return true;
  if (HALT_ACTIONS.has(a) && (GROWTH_ACTIONS.has(b) || CREATIVE_FIX_ACTIONS.has(b))) return true;
  if (HALT_ACTIONS.has(b) && (GROWTH_ACTIONS.has(a) || CREATIVE_FIX_ACTIONS.has(a))) return true;
  return false;
}

function resolveRecommendationConflicts(priorities) {
  const kept = [];
  const dropped = [];
  for (const p of priorities || []) {
    const conflict = kept.find(k => actionsConflict(k.action, p.action));
    if (conflict) {
      dropped.push({ action: p.action, conflicts_with: conflict.action, reason: `"${p.action}" and "${conflict.action}" should not be recommended together -- keeping the higher-priority action.` });
    } else {
      kept.push(p);
    }
  }
  return { kept, dropped };
}

// ─────────────────────────────────────────────
// TASK 10 — Confidence Engine. Extends (never replaces) executiveReasoningEngine
// .computeConfidence() with real, additional agreement signals this phase
// has access to: whether the Rule Engine agrees with the advisor,
// historical-trend consistency (from Phase 43's own historical comparison),
// and benchmark sample size (a real confidence signal already computed by
// Phase 42's benchmark averages, previously only implicit).
// ─────────────────────────────────────────────
function computeExecutiveConfidence({ consistencyAudit, historicalComparison, benchmarkComparison, fatigue, latestRow }) {
  let supporting = 0;
  let conflicting = 0;

  // Signal agreement -- Task 1/13's own arbitration result IS a real
  // agreement signal: unanimous input is worth more confidence than an
  // override that had to happen.
  if (consistencyAudit?.agreement === 'unanimous') supporting += 2;
  else conflicting += consistencyAudit?.overrides?.length || 1;

  // Historical consistency -- do multiple real metrics agree on direction?
  if (historicalComparison?.status === 'ok') {
    const directions = Object.values(historicalComparison.trend || {}).map(t => t.direction).filter(d => d && d !== 'stable');
    const improving = directions.filter(d => d === 'improving').length;
    const declining = directions.filter(d => d === 'declining').length;
    if (improving > 0 && declining === 0) supporting += 1;
    else if (declining > 0 && improving === 0) supporting += 1; // consistent decline is still a real, agreeing signal
    else if (improving > 0 && declining > 0) conflicting += 1; // metrics genuinely disagree with each other
  }

  // Benchmark confidence -- a peer-average grain backed by more real
  // creatives is a more trustworthy comparison than one backed by few.
  const bestGrain = ['ad_set', 'campaign', 'account'].map(g => benchmarkComparison?.[g]).find(g => g?.status === 'ok');
  if (bestGrain) {
    if (bestGrain.sample_size >= 5) supporting += 1;
  } else {
    conflicting += 0; // absence of a benchmark isn't a conflict, just less support -- handled by dataSufficient below
  }

  const dataSufficient = latestRow?.spend != null && fatigue?.status !== 'insufficient_data';
  return computeConfidence({ supportingSignals: supporting, conflictingSignals: conflicting, dataSufficient });
}

// ─────────────────────────────────────────────
// TASK 11 — Business Impact Ranking. Reshapes Phase 44's per-action
// business_impact estimate (reach/CPA/CTR ranges) into 5 named categories
// plus one overall qualitative label -- Revenue Impact is derived (never
// invented) from combining the real reach/CTR/CPA direction with real ROAS
// when available; Learning Impact reuses the real learning_phase_risk
// already computed per action.
// ─────────────────────────────────────────────
function rangeToScore(range) {
  if (!range) return 0;
  const nums = String(range).match(/-?\d+(\.\d+)?/g);
  if (!nums) return 0;
  return Math.max(...nums.map(Number).map(Math.abs));
}

function buildBusinessImpactRanking(priority, latestRow) {
  const bi = priority?.business_impact;
  const ra = priority?.risk_assessment;
  if (!bi) return null;

  const reachScore = rangeToScore(bi.reach_increase?.range);
  const cpaScore = rangeToScore(bi.cpa_change?.range);
  const ctrScore = rangeToScore(bi.ctr_improvement?.range);
  const roas = latestRow?.roas;

  const revenueImpact = (reachScore === 0 && ctrScore === 0)
    ? { level: 'Not applicable', reason: 'This action does not target reach, CTR, or CPA.' }
    : {
        level: (reachScore + ctrScore) >= 15 ? 'High' : (reachScore + ctrScore) >= 5 ? 'Medium' : 'Low',
        reason: roas != null
          ? `Derived from expected reach/CTR movement combined with current ROAS (${roas}).`
          : 'Derived from expected reach/CTR movement (no ROAS available to weight it further).',
      };

  const dims = {
    revenue_impact: revenueImpact,
    reach_impact: bi.reach_increase?.range ? { level: bi.reach_increase.probability || 'Low', range: bi.reach_increase.range } : { level: 'Not applicable' },
    cpa_impact: bi.cpa_change?.range ? { level: bi.cpa_change.probability || 'Low', range: bi.cpa_change.range } : { level: 'Not applicable' },
    ctr_impact: bi.ctr_improvement?.range ? { level: bi.ctr_improvement.probability || 'Low', range: bi.ctr_improvement.range } : { level: 'Not applicable' },
    learning_impact: ra?.learning_phase_risk ? { level: ra.learning_phase_risk.level, reason: ra.learning_phase_risk.reason } : { level: 'Not applicable' },
  };

  const levelScore = { 'Not applicable': 0, Low: 1, Medium: 2, High: 3, Highest: 4 };
  const overallScore = Object.values(dims).reduce((s, d) => s + (levelScore[d.level] || 0), 0);
  const overall = overallScore >= 9 ? 'Highest' : overallScore >= 6 ? 'High' : overallScore >= 3 ? 'Medium' : 'Low';

  return { ...dims, overall_business_impact: overall };
}

// ─────────────────────────────────────────────
// TASK 7 — Recommendation Quality enrichment. Adds Problem/Business Reason/
// Estimated Time To Observe Results/Implementation Difficulty to a
// priority WITHOUT modifying advisorEngine.buildPriorityEngine() itself --
// a pure additive wrapper over its already-real fields.
// ─────────────────────────────────────────────
const DIFFICULTY = {
  'Rewrite Hook': 'Easy', 'Shorten Copy': 'Easy', 'Improve CTA': 'Easy', 'Add Social Proof': 'Easy',
  'Use Better Offer': 'Medium', 'Replace Thumbnail': 'Medium', 'Reduce Text': 'Easy',
  Pause: 'Easy', Refresh: 'Medium', Scale: 'Medium', 'Duplicate Winner': 'Easy', Duplicate: 'Easy',
  'Reallocate Budget': 'Medium', 'Pause Loser': 'Easy', 'Split Test': 'Hard',
};
const TIME_TO_OBSERVE = {
  'Rewrite Hook': '3-5 days', 'Shorten Copy': '3-5 days', 'Improve CTA': '3-5 days', 'Add Social Proof': '3-5 days',
  'Use Better Offer': '5-7 days', 'Replace Thumbnail': '3-5 days', 'Reduce Text': '3-5 days',
  Pause: 'Immediate', Refresh: '5-7 days', Scale: '5-7 days', 'Duplicate Winner': '3-5 days', Duplicate: '3-5 days',
  'Reallocate Budget': '5-7 days', 'Pause Loser': 'Immediate', 'Split Test': '7-14 days',
};

function enrichRecommendationQuality(priority, rootCause, latestRow) {
  const negativeFactor = (rootCause?.negative_factors || [])[0];
  return {
    ...priority,
    problem: negativeFactor ? `${negativeFactor.factor}: ${negativeFactor.evidence}` : 'No single dominant weakness identified -- this is a proactive, not reactive, recommendation.',
    business_reason: `${priority.expected_impact} Prioritized ${priority.tier || priority.priority_label} based on real evidence, not a fixed rule.`,
    estimated_time_to_observe: TIME_TO_OBSERVE[priority.action] || '5-7 days',
    implementation_difficulty: DIFFICULTY[priority.action] || 'Medium',
    business_impact_ranking: buildBusinessImpactRanking(priority, latestRow),
  };
}

// ─────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────
function buildExecutiveDecisionLayer({
  panel, priorities, fatigue, scores, healthStatus, ruleEngineFindings,
  benchmarkVerdict, benchmarkComparison, historicalComparison, rootCause, latestRow,
  crossModuleSignals = null, recommendationLogRows = null,
}) {
  const { decision, base_from_advisor, consistency_audit } = resolveExecutiveDecision({
    panelStatus: panel?.current_status, healthStatus, fatigue, scores, ruleEngineFindings, crossModuleSignals, recommendationLogRows,
  });

  const { kept: conflictFreePriorities, dropped: droppedRecommendations } = resolveRecommendationConflicts(priorities);
  const enrichedPriorities = conflictFreePriorities.map(p => enrichRecommendationQuality(p, rootCause, latestRow));

  const confidence = computeExecutiveConfidence({ consistencyAudit: consistency_audit, historicalComparison, benchmarkComparison, fatigue, latestRow });

  return {
    decision,
    allowed_decisions: ALLOWED_DECISIONS,
    base_from_advisor,
    confidence: confidence.confidence_pct,
    confidence_reason: confidence.reason,
    why_not: buildWhyNot(decision, { scores, fatigue, healthStatus, benchmarkVerdict, priorities: conflictFreePriorities, crossModuleSignals, recommendationLogRows }),
    consistency_audit,
    priority_card: buildExecutivePriorityCard(enrichedPriorities),
    marketing_director_plan: buildMarketingDirectorPlan({ decision, priorities: enrichedPriorities, latestRow, benchmarkVerdict }),
    winning_formula: buildWinningFormula(rootCause),
    loss_formula: buildLossFormula(rootCause),
    recommendations: enrichedPriorities,
    dropped_recommendations: droppedRecommendations,
  };
}

module.exports = {
  ALLOWED_DECISIONS,
  CONSERVATISM_RANK,
  resolveExecutiveDecision,
  crossModuleCandidateDecisions,
  recommendationLogCandidateDecisions,
  buildWhyNot,
  buildExecutivePriorityCard,
  buildMarketingDirectorPlan,
  buildWinningFormula,
  buildLossFormula,
  resolveRecommendationConflicts,
  computeExecutiveConfidence,
  buildBusinessImpactRanking,
  enrichRecommendationQuality,
  buildExecutiveDecisionLayer,
};
