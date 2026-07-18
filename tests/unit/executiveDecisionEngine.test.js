'use strict';

const {
  resolveExecutiveDecision,
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
  crossModuleCandidateDecisions,
  recommendationLogCandidateDecisions,
  ALLOWED_DECISIONS,
} = require('../../src/services/executiveDecisionEngine');

describe('executiveDecisionEngine', () => {
  // Task 1
  describe('resolveExecutiveDecision', () => {
    test('maps each panel status onto exactly one of the six allowed decisions', () => {
      const cases = [
        ['Scale', 'SCALE'], ['Refresh', 'OPTIMIZE'], ['Rewrite', 'TEST'],
        ['Leave Unchanged', 'MONITOR'], ['Monitor', 'MONITOR'],
      ];
      for (const [panelStatus, expected] of cases) {
        const { decision } = resolveExecutiveDecision({ panelStatus, healthStatus: 'good', fatigue: { status: 'none' }, scores: { score_overall: 50 }, ruleEngineFindings: [] });
        expect(ALLOWED_DECISIONS).toContain(decision);
        expect(decision).toBe(expected);
      }
    });

    test('escalates Pause to STOP only when health is critical or fatigue is severe with a very low score', () => {
      const stop = resolveExecutiveDecision({ panelStatus: 'Pause', healthStatus: 'critical', fatigue: { status: 'severe' }, scores: { score_overall: 20 }, ruleEngineFindings: [] });
      expect(stop.decision).toBe('STOP');

      const pause = resolveExecutiveDecision({ panelStatus: 'Pause', healthStatus: 'good', fatigue: { status: 'severe' }, scores: { score_overall: 60 }, ruleEngineFindings: [] });
      expect(pause.decision).toBe('PAUSE');
    });

    test('a critical Rule Engine tracking finding overrides an optimistic Scale verdict, and records why (Task 13)', () => {
      const result = resolveExecutiveDecision({
        panelStatus: 'Scale', healthStatus: 'excellent', fatigue: { status: 'none' }, scores: { score_overall: 80 },
        ruleEngineFindings: [{ rule_id: 'MF1', rule_name: 'Tracking Broken', severity: 'critical', action: { type: 'FIX_TRACKING' }, reason: 'Pixel events stopped firing.' }],
      });
      expect(result.decision).toBe('STOP');
      expect(result.base_from_advisor).toBe('SCALE');
      expect(result.consistency_audit.signals_disagreed).toBe(true);
      expect(result.consistency_audit.overrides[0].because).toMatch(/Tracking Broken/);
    });

    test('an info-severity rule finding never moves the decision', () => {
      const result = resolveExecutiveDecision({
        panelStatus: 'Monitor', healthStatus: 'good', fatigue: { status: 'none' }, scores: { score_overall: 50 },
        ruleEngineFindings: [{ rule_id: 'MF9', rule_name: 'Info Note', severity: 'info', action: { type: 'REVIEW_PERFORMANCE' }, reason: 'x' }],
      });
      expect(result.decision).toBe('MONITOR');
      expect(result.consistency_audit.agreement).toBe('unanimous');
    });

    test('unanimous agreement is reported honestly with no overrides', () => {
      const result = resolveExecutiveDecision({ panelStatus: 'Monitor', healthStatus: 'good', fatigue: { status: 'none' }, scores: { score_overall: 50 }, ruleEngineFindings: [] });
      expect(result.consistency_audit.agreement).toBe('unanimous');
      expect(result.consistency_audit.overrides).toEqual([]);
    });
  });

  // Task 3
  describe('buildWhyNot', () => {
    test('explains why not SCALE using the real score vs. threshold', () => {
      const reasons = buildWhyNot('MONITOR', { scores: { score_overall: 57 }, fatigue: { status: 'none' }, healthStatus: 'excellent', benchmarkVerdict: { verdict: 'average' }, priorities: [] });
      expect(reasons.SCALE).toMatch(/57/);
      expect(reasons.PAUSE).toMatch(/excellent/);
      expect(reasons.STOP).toBeTruthy();
    });

    test('never explains why not the chosen decision itself', () => {
      const reasons = buildWhyNot('SCALE', { scores: { score_overall: 80 }, fatigue: { status: 'none' }, healthStatus: 'excellent', benchmarkVerdict: {}, priorities: [] });
      expect(reasons.SCALE).toBeUndefined();
    });
  });

  // Task 2
  describe('buildExecutivePriorityCard', () => {
    test('picks exactly one recommendation, never a second competing one', () => {
      const card = buildExecutivePriorityCard([
        { action: 'Rewrite Hook', why: 'Weak hook.', confidence_pct: 88 },
        { action: 'Shorten Copy', why: 'Long copy.', confidence_pct: 60 },
      ]);
      expect(card.available).toBe(true);
      expect(card.action).toBe('Rewrite Hook');
      expect(card.business_impact).toBe('Highest');
      expect(card.confidence_pct).toBe(88);
    });

    test('reports honestly when nothing is prioritized', () => {
      expect(buildExecutivePriorityCard([]).available).toBe(false);
    });
  });

  // Task 4
  describe('buildMarketingDirectorPlan', () => {
    test('produces a real 4-step plan grounded in the actual decision and top priorities', () => {
      const plan = buildMarketingDirectorPlan({
        decision: 'SCALE', priorities: [{ action: 'Duplicate Winner' }, { action: 'Increase Budget' }],
        latestRow: { ctr: 3.2 }, benchmarkVerdict: { verdict: 'above_average' },
      });
      expect(plan.today).toMatch(/healthy/i);
      expect(plan.tomorrow).toMatch(/Duplicate Winner/);
      expect(plan.this_week).toMatch(/Increase Budget/);
      expect(plan.next_week).toMatch(/budget/i);
      expect(plan.next_week).toMatch(/3.2/);
    });
  });

  // Task 5/6
  describe('buildWinningFormula / buildLossFormula', () => {
    test('normalizes real positive factors into percentages that sum to 100, never a fabricated dimension', () => {
      const result = buildWinningFormula({ positive_factors: [{ factor: 'Trust & social proof', evidence: 'x', impact: 35 }, { factor: 'Offer clarity', evidence: 'x', impact: 25 }] });
      expect(result.available).toBe(true);
      const total = result.items.reduce((s, i) => s + i.contribution_pct, 0);
      expect(total).toBe(100);
      expect(result.items.map(i => i.factor)).toEqual(['Trust & social proof', 'Offer clarity']);
    });

    test('reports honestly when no positive factor exists (never invents a winning formula)', () => {
      expect(buildWinningFormula({ positive_factors: [] }).available).toBe(false);
    });

    test('loss formula names largest/second/third weakness from real negative factors', () => {
      const result = buildLossFormula({ negative_factors: [{ factor: 'Hook', evidence: 'x', impact: 50 }, { factor: 'Trust', evidence: 'x', impact: 30 }, { factor: 'Offer', evidence: 'x', impact: 20 }] });
      expect(result.largest_weakness.factor).toBe('Hook');
      expect(result.second_weakness.factor).toBe('Trust');
      expect(result.third_weakness.factor).toBe('Offer');
    });
  });

  // Task 9
  describe('resolveRecommendationConflicts', () => {
    test('drops a creative-fix action that conflicts with a higher-priority Scale action', () => {
      const { kept, dropped } = resolveRecommendationConflicts([{ action: 'Scale' }, { action: 'Rewrite Hook' }]);
      expect(kept.map(k => k.action)).toEqual(['Scale']);
      expect(dropped[0].action).toBe('Rewrite Hook');
      expect(dropped[0].conflicts_with).toBe('Scale');
    });

    test('keeps compatible recommendations together (no false-positive conflicts)', () => {
      const { kept, dropped } = resolveRecommendationConflicts([{ action: 'Rewrite Hook' }, { action: 'Shorten Copy' }]);
      expect(kept.length).toBe(2);
      expect(dropped.length).toBe(0);
    });
  });

  // Task 10
  describe('computeExecutiveConfidence', () => {
    test('unanimous agreement plus consistent historical trend yields higher confidence than a conflicted, thin-data case', () => {
      const strong = computeExecutiveConfidence({
        consistencyAudit: { agreement: 'unanimous', overrides: [] },
        historicalComparison: { status: 'ok', trend: { ctr: { direction: 'improving' }, score_overall: { direction: 'improving' } } },
        benchmarkComparison: { ad_set: { status: 'ok', sample_size: 6 } },
        fatigue: { status: 'none' }, latestRow: { spend: 200 },
      });
      const weak = computeExecutiveConfidence({
        consistencyAudit: { agreement: 'resolved', overrides: [{ from: 'SCALE', to: 'STOP' }] },
        historicalComparison: { status: 'insufficient_data' },
        benchmarkComparison: {},
        fatigue: { status: 'insufficient_data' }, latestRow: { spend: null },
      });
      expect(strong.confidence_pct).toBeGreaterThan(weak.confidence_pct);
    });
  });

  // Task 11
  describe('buildBusinessImpactRanking', () => {
    test('returns all 5 named dimensions plus an overall label, grounded in the real per-action business_impact/risk_assessment', () => {
      const priority = {
        business_impact: { reach_increase: { range: '10-20%', probability: 'Medium' }, cpa_change: { range: '+/-10%', probability: 'Low' }, ctr_improvement: { range: null, probability: null } },
        risk_assessment: { learning_phase_risk: { level: 'Medium', reason: 'x' } },
      };
      const result = buildBusinessImpactRanking(priority, { roas: 2.5 });
      expect(result.revenue_impact.level).toMatch(/Low|Medium|High/);
      expect(result.reach_impact.range).toBe('10-20%');
      expect(result.ctr_impact.level).toBe('Not applicable');
      expect(result.learning_impact.level).toBe('Medium');
      expect(['Low', 'Medium', 'High', 'Highest']).toContain(result.overall_business_impact);
    });
  });

  // Task 7
  describe('enrichRecommendationQuality', () => {
    test('adds problem/business_reason/time-to-observe/difficulty without losing existing fields', () => {
      const priority = { action: 'Rewrite Hook', why: 'weak hook', expected_impact: 'Improves CTR.', tier: 'Immediate Actions', priority_label: 'Highest Priority' };
      const rootCause = { negative_factors: [{ factor: 'Hook', evidence: 'No question or curiosity trigger.', impact: 20 }] };
      const result = enrichRecommendationQuality(priority, rootCause, { spend: 100 });
      expect(result.action).toBe('Rewrite Hook'); // original field preserved
      expect(result.problem).toMatch(/Hook/);
      expect(result.estimated_time_to_observe).toBeTruthy();
      expect(result.implementation_difficulty).toBe('Easy');
    });
  });

  // Full orchestrator
  describe('buildExecutiveDecisionLayer', () => {
    test('never throws with minimal input and degrades honestly', () => {
      const result = buildExecutiveDecisionLayer({
        panel: { current_status: 'Monitor' }, priorities: [], fatigue: { status: 'none' },
        scores: { score_overall: null }, healthStatus: null, ruleEngineFindings: [],
        benchmarkVerdict: { verdict: 'unknown' }, benchmarkComparison: {}, historicalComparison: { status: 'insufficient_data' },
        rootCause: { positive_factors: [], negative_factors: [] }, latestRow: {},
      });
      expect(ALLOWED_DECISIONS).toContain(result.decision);
      expect(result.priority_card.available).toBe(false);
      expect(result.winning_formula.available).toBe(false);
    });

    test('produces one internally-consistent decision end-to-end on a realistic winning-creative scenario', () => {
      const result = buildExecutiveDecisionLayer({
        panel: { current_status: 'Scale' },
        priorities: [{ action: 'Duplicate Winner', why: 'Top performer.', confidence_pct: 84, expected_impact: 'Extends reach.', tier: 'Immediate Actions', priority_label: 'Highest Priority', business_impact: {}, risk_assessment: {} }],
        fatigue: { status: 'none' }, scores: { score_overall: 78 }, healthStatus: 'excellent',
        ruleEngineFindings: [], benchmarkVerdict: { verdict: 'above_average', grain: 'account' },
        benchmarkComparison: { account: { status: 'ok', sample_size: 8 } },
        historicalComparison: { status: 'ok', trend: { ctr: { direction: 'improving' } } },
        rootCause: { positive_factors: [{ factor: 'Trust', evidence: 'x', impact: 30 }], negative_factors: [] },
        latestRow: { spend: 300, ctr: 3.1, roas: 2.8 },
      });
      expect(result.decision).toBe('SCALE');
      expect(result.priority_card.action).toBe('Duplicate Winner');
      expect(result.marketing_director_plan.today).toMatch(/healthy/i);
      expect(result.winning_formula.available).toBe(true);
      expect(result.why_not.PAUSE).toBeTruthy();
    });
  });

  // Task 4 addition — Next Month
  describe('buildMarketingDirectorPlan (Next Month)', () => {
    test('produces a real, decision-grounded Next Month step', () => {
      const scale = buildMarketingDirectorPlan({ decision: 'SCALE', priorities: [], latestRow: {}, benchmarkVerdict: {} });
      expect(scale.next_month).toMatch(/winning formula/i);

      const pause = buildMarketingDirectorPlan({ decision: 'PAUSE', priorities: [], latestRow: {}, benchmarkVerdict: {} });
      expect(pause.next_month).toMatch(/resolved elsewhere/i);
    });
  });

  // Task 13 — cross-module (Budget/Audience Intelligence) signals
  describe('crossModuleCandidateDecisions', () => {
    test('real budget waste produces an OPTIMIZE candidate, never fabricated when absent', () => {
      expect(crossModuleCandidateDecisions({ budget: { waste_detected: true, efficiency_status: 'poor' }, audience: null })).toEqual([
        expect.objectContaining({ decision: 'OPTIMIZE', module: 'Budget Intelligence' }),
      ]);
      expect(crossModuleCandidateDecisions({ budget: { waste_detected: false }, audience: null })).toEqual([]);
      expect(crossModuleCandidateDecisions(null)).toEqual([]);
    });

    test('high real audience saturation produces an OPTIMIZE candidate; a healthy saturation score does not', () => {
      const high = crossModuleCandidateDecisions({ budget: null, audience: { saturation_score: 85 } });
      expect(high.some(c => c.module === 'Audience Intelligence')).toBe(true);
      const low = crossModuleCandidateDecisions({ budget: null, audience: { saturation_score: 20 } });
      expect(low.length).toBe(0);
    });
  });

  describe('resolveExecutiveDecision with cross-module signals (Task 13)', () => {
    test('real budget waste escalates an optimistic Scale verdict to OPTIMIZE, with the module named in the audit', () => {
      const result = resolveExecutiveDecision({
        panelStatus: 'Scale', healthStatus: 'excellent', fatigue: { status: 'none' }, scores: { score_overall: 80 },
        ruleEngineFindings: [], crossModuleSignals: { budget: { waste_detected: true, efficiency_status: 'poor' }, audience: null },
      });
      expect(result.decision).toBe('OPTIMIZE');
      expect(result.consistency_audit.overrides[0].module).toBe('Budget Intelligence');
    });
  });

  // Dashboard Normalization (Phase 46) -- recommendation_log wired into arbitration
  describe('recommendationLogCandidateDecisions', () => {
    test('a critical-severity active rule (e.g. LOW_ROAS) produces a PAUSE candidate', () => {
      const rows = [{ rule_code: 'LOW_ROAS', severity: 'critical', recommendation_title: 'Campaign is losing money', recommendation_body: 'Pause and review.' }];
      expect(recommendationLogCandidateDecisions(rows)).toEqual([
        expect.objectContaining({ decision: 'PAUSE', module: 'Recommendation Rules', id: 'LOW_ROAS' }),
      ]);
    });

    test('a warning-severity active rule (e.g. LOW_CTR) produces an OPTIMIZE candidate', () => {
      const rows = [{ rule_code: 'LOW_CTR', severity: 'warning', recommendation_title: 'Creative or targeting issue likely', recommendation_body: 'Refresh the creative.' }];
      expect(recommendationLogCandidateDecisions(rows)).toEqual([
        expect.objectContaining({ decision: 'OPTIMIZE', module: 'Recommendation Rules', id: 'LOW_CTR' }),
      ]);
    });

    test('no active rows, null, or an info-severity row never produce a candidate', () => {
      expect(recommendationLogCandidateDecisions([])).toEqual([]);
      expect(recommendationLogCandidateDecisions(null)).toEqual([]);
      expect(recommendationLogCandidateDecisions([{ rule_code: 'X', severity: 'info', recommendation_title: 'x', recommendation_body: 'x' }])).toEqual([]);
    });
  });

  describe('resolveExecutiveDecision with recommendation_log signals', () => {
    test('a real, currently-active critical rule (LOW_ROAS) overrides an optimistic Scale verdict to PAUSE, and is recorded in the audit', () => {
      const result = resolveExecutiveDecision({
        panelStatus: 'Scale', healthStatus: 'excellent', fatigue: { status: 'none' }, scores: { score_overall: 80 },
        ruleEngineFindings: [],
        recommendationLogRows: [{ rule_code: 'LOW_ROAS', severity: 'critical', recommendation_title: 'Campaign is losing money', recommendation_body: 'Your ROAS is below 1.0. Pause and review.' }],
      });
      expect(result.decision).toBe('PAUSE');
      expect(result.consistency_audit.signals_disagreed).toBe(true);
      expect(result.consistency_audit.overrides[0].module).toBe('Recommendation Rules');
      expect(result.consistency_audit.overrides[0].because).toMatch(/Campaign is losing money/);
    });

    test('no active recommendation_log rows changes nothing (unanimous agreement preserved)', () => {
      const result = resolveExecutiveDecision({
        panelStatus: 'Monitor', healthStatus: 'good', fatigue: { status: 'none' }, scores: { score_overall: 50 },
        ruleEngineFindings: [], recommendationLogRows: [],
      });
      expect(result.decision).toBe('MONITOR');
      expect(result.consistency_audit.agreement).toBe('unanimous');
    });
  });

  describe('buildWhyNot with recommendation_log signals', () => {
    test('the PAUSE reason is honest about the real health status and never claims "not critical"', () => {
      const reasons = buildWhyNot('SCALE', { scores: { score_overall: 80 }, fatigue: { status: 'none' }, healthStatus: 'critical' });
      expect(reasons.PAUSE).not.toMatch(/not critical/);
      expect(reasons.PAUSE).toMatch(/critical/);
    });

    test('the OPTIMIZE reason cites a real active rule when one exists instead of claiming nothing is active', () => {
      const reasons = buildWhyNot('MONITOR', {
        scores: { score_overall: 50 }, fatigue: { status: 'none' },
        recommendationLogRows: [{ rule_code: 'LOW_CTR', recommendation_title: 'Creative or targeting issue likely' }],
      });
      expect(reasons.OPTIMIZE).toMatch(/Creative or targeting issue likely/);
    });
  });
});
