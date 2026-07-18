'use strict';

const {
  classifyVsAverage,
  buildBenchmarkComparison,
  overallBenchmarkVerdict,
  buildRootCause,
  buildScoreExplanation,
  buildPriorityEngine,
  buildStrategicAdvice,
  buildChangeRisk,
  buildScalingAdvice,
  buildPauseAdvice,
  compareDimensions,
  buildComparisonBreakdown,
  buildEvolutionStages,
  buildScoreRelationship,
  buildHistoricalComparison,
  buildPreviousVersionComparison,
  buildAdvisorPanel,
  buildCreativeAdvisor,
  buildWinLossNarrative,
  buildBusinessImpactEstimate,
  buildRiskAssessment,
  buildBestWorstComparison,
  buildBusinessEvents,
  buildScoreMilestones,
  buildStateTransitions,
  mergeConsecutiveTimelineEntries,
} = require('../../src/services/advisorEngine');

const { analyzeCreative } = require('../../src/services/creativeTextAnalysis');

const STRONG_TEXT = analyzeCreative({
  headline: 'Save 30% Today', primary_text: 'Tired of overpaying? Save big today. Trusted by thousands of happy customers.',
  description: 'Free shipping.', cta_type: 'SHOP_NOW', media_type: 'image', aspect_ratio: '1:1',
});
const WEAK_TEXT = analyzeCreative({ headline: null, primary_text: null, description: null, cta_type: null, media_type: 'image' });

describe('advisorEngine', () => {
  describe('classifyVsAverage / buildBenchmarkComparison', () => {
    test('classifies above/below/average with a tolerance band', () => {
      expect(classifyVsAverage(4, 2, true).status).toBe('above_average'); // higher-is-better, well above
      expect(classifyVsAverage(1, 2, true).status).toBe('below_average');
      expect(classifyVsAverage(2.05, 2, true).status).toBe('average'); // inside +/-10%
      expect(classifyVsAverage(5, 10, false).status).toBe('above_average'); // lower-is-better: 5 < 10 is good
      expect(classifyVsAverage(15, 10, false).status).toBe('below_average');
    });

    test('returns null when either value is missing', () => {
      expect(classifyVsAverage(null, 10, true)).toBeNull();
      expect(classifyVsAverage(5, null, true)).toBeNull();
    });

    test('buildBenchmarkComparison passes through insufficient_data/not_applicable grains untouched', () => {
      const result = buildBenchmarkComparison(
        { ad_set: { status: 'not_applicable', reason: 'no ad set' }, campaign: { status: 'insufficient_data', sample_size: 1 }, account: { status: 'ok', sample_size: 5, averages: { ctr: 2, cpa: 10, cpm: 10, frequency: 2, roas: 2, score_overall: 50 } } },
        { ctr: 3, cpa: 8, cpm: 10, roas: 2.5, score_overall: 60 }
      );
      expect(result.ad_set.status).toBe('not_applicable');
      expect(result.campaign.status).toBe('insufficient_data');
      expect(result.account.status).toBe('ok');
      expect(result.account.metrics.ctr.status).toBe('above_average');
      expect(result.account.metrics.cpa.status).toBe('above_average'); // 8 < 10, lower cost is better
    });

    test('overallBenchmarkVerdict prefers ad_set grain over campaign/account', () => {
      const comparison = {
        ad_set: { status: 'ok', sample_size: 3, metrics: { ctr: { status: 'above_average' }, cpa: { status: 'above_average' } } },
        campaign: { status: 'ok', sample_size: 10, metrics: { ctr: { status: 'below_average' } } },
        account: { status: 'not_applicable' },
      };
      const verdict = overallBenchmarkVerdict(comparison);
      expect(verdict.grain).toBe('ad_set');
      expect(verdict.verdict).toBe('above_average');
    });
  });

  describe('buildRootCause', () => {
    test('never fabricates factors -- an empty/absent creative yields no positive factors', () => {
      const { positive_factors, negative_factors } = buildRootCause({ textAnalysis: WEAK_TEXT, fatigue: { status: 'none', signals: [] }, benchmarkComparison: null });
      expect(positive_factors.length).toBe(0);
      expect(negative_factors.length).toBeGreaterThan(0);
    });

    test('a strong creative surfaces real, evidence-backed positive factors', () => {
      const { positive_factors } = buildRootCause({ textAnalysis: STRONG_TEXT, fatigue: { status: 'none', signals: [] }, benchmarkComparison: null });
      expect(positive_factors.length).toBeGreaterThan(0);
      for (const f of positive_factors) {
        expect(typeof f.evidence).toBe('string');
        expect(f.evidence.length).toBeGreaterThan(0);
      }
    });

    test('fatigue signals become negative factors with the real signal detail as evidence', () => {
      const fatigue = { status: 'moderate', signals: [{ signal: 'rising_cpc', detail: 'CPC rose 40%' }] };
      const { negative_factors } = buildRootCause({ textAnalysis: null, fatigue, benchmarkComparison: null });
      expect(negative_factors.some(f => f.evidence === 'CPC rose 40%')).toBe(true);
    });
  });

  describe('buildScoreExplanation', () => {
    test('flags missing dimensions and derives confidence from spend', () => {
      const explanation = buildScoreExplanation({ scores: { score_overall: 40 }, textAnalysis: WEAK_TEXT, fatigue: { status: 'none' }, spend: 3 });
      expect(explanation.missing_opportunities.length).toBeGreaterThan(0);
      expect(explanation.confidence_level).toBe('low');
    });

    test('high spend with a determined fatigue verdict yields higher confidence', () => {
      const explanation = buildScoreExplanation({ scores: { score_overall: 80 }, textAnalysis: STRONG_TEXT, fatigue: { status: 'none' }, spend: 250 });
      expect(explanation.confidence_level).toBe('high');
    });
  });

  describe('buildPriorityEngine', () => {
    test('dedupes, ranks by priority, and caps at 3', () => {
      const recs = [
        { action: 'Rewrite Hook', reason: 'weak hook', priority: 'medium' },
        { action: 'Pause', reason: 'severe fatigue', priority: 'high' },
        { action: 'Rewrite Hook', reason: 'duplicate entry', priority: 'medium' },
        { action: 'Reduce Text', reason: 'too long', priority: 'low' },
        { action: 'Improve CTA', reason: 'weak cta', priority: 'medium' },
      ];
      const priorities = buildPriorityEngine(recs, { spend: 50, fatigueStatus: 'moderate' });
      expect(priorities.length).toBe(3);
      expect(priorities[0].action).toBe('Pause'); // high priority first
      expect(priorities.every(p => typeof p.how === 'string' && p.how.length > 0)).toBe(true);
      expect(priorities.every(p => typeof p.expected_impact === 'string')).toBe(true);
      expect(new Set(priorities.map(p => p.action)).size).toBe(3); // no duplicates
    });
  });

  describe('buildStrategicAdvice', () => {
    test('tells a healthy above-benchmark creative not to change yet', () => {
      const advice = buildStrategicAdvice({
        scores: { score_overall: 80 }, fatigue: { status: 'none' },
        benchmarkVerdict: { verdict: 'above_average', grain: 'ad_set' }, priorities: [], spend: 100,
      });
      expect(advice.headline).toMatch(/Do not change/i);
    });

    test('tells a severely fatigued creative to pause now', () => {
      const advice = buildStrategicAdvice({
        scores: { score_overall: 50 }, fatigue: { status: 'severe', evidence: 'CTR fell 40%' },
        benchmarkVerdict: { verdict: 'average', grain: 'account' }, priorities: [], spend: 100,
      });
      expect(advice.headline).toMatch(/Pause/i);
      expect(advice.detail).toContain('CTR fell 40%');
    });

    test('recommends the single highest-priority fix when otherwise mixed', () => {
      const advice = buildStrategicAdvice({
        scores: { score_overall: 55 }, fatigue: { status: 'none' },
        benchmarkVerdict: { verdict: 'average', grain: 'account' },
        priorities: [{ action: 'Rewrite Hook', why: 'weak hook evidence' }], spend: 100,
      });
      expect(advice.headline).toMatch(/Rewrite Hook/);
    });
  });

  describe('buildChangeRisk', () => {
    test('a top-performer winner with no fatigue should be left unchanged', () => {
      const risk = buildChangeRisk({ scores: { score_overall: 80 }, fatigue: { status: 'none' }, comparisonRole: { isWinner: true }, spend: 100 });
      expect(risk.risk_level).toBe('Leave unchanged');
    });

    test('a severely fatigued creative is safe to edit (little to lose)', () => {
      const risk = buildChangeRisk({ scores: { score_overall: 45 }, fatigue: { status: 'severe' }, comparisonRole: {}, spend: 100 });
      expect(risk.risk_level).toBe('Safe to edit');
    });

    test('low spend/insufficient data means monitor first, regardless of score', () => {
      const risk = buildChangeRisk({ scores: { score_overall: 90 }, fatigue: { status: 'insufficient_data' }, comparisonRole: {}, spend: 2 });
      expect(risk.risk_level).toBe('Monitor first');
    });

    test('a healthy non-winner strong performer is high risk to touch', () => {
      const risk = buildChangeRisk({ scores: { score_overall: 75 }, fatigue: { status: 'none' }, comparisonRole: { isWinner: false }, spend: 100 });
      expect(risk.risk_level).toBe('High risk');
    });
  });

  describe('buildScalingAdvice', () => {
    test('never recommends scaling a fatigued creative', () => {
      const advice = buildScalingAdvice({ scores: { score_overall: 90 }, fatigue: { status: 'early' }, comparisonRole: {}, latestRow: { spend: 200 }, benchmarkVerdict: { verdict: 'average' } });
      expect(advice.recommended).toBe(false);
      expect(advice.reason).toMatch(/fatigue/i);
    });

    test('never recommends scaling a weak score', () => {
      const advice = buildScalingAdvice({ scores: { score_overall: 40 }, fatigue: { status: 'none' }, comparisonRole: {}, latestRow: { spend: 200 }, benchmarkVerdict: { verdict: 'average' } });
      expect(advice.recommended).toBe(false);
    });

    test('recommends Duplicate for a healthy ad-set winner', () => {
      const advice = buildScalingAdvice({ scores: { score_overall: 80 }, fatigue: { status: 'none' }, comparisonRole: { isWinner: true }, latestRow: { spend: 200, frequency: 3 }, benchmarkVerdict: { verdict: 'average' } });
      expect(advice.recommended).toBe(true);
      expect(advice.actions.some(a => a.action === 'Duplicate')).toBe(true);
    });

    test('recommends Expand Audience when frequency is low', () => {
      const advice = buildScalingAdvice({ scores: { score_overall: 80 }, fatigue: { status: 'none' }, comparisonRole: {}, latestRow: { spend: 200, frequency: 1.2 }, benchmarkVerdict: { verdict: 'average' } });
      expect(advice.actions.some(a => a.action === 'Expand Audience')).toBe(true);
    });
  });

  describe('buildPauseAdvice', () => {
    test('severe fatigue -> Pause', () => {
      expect(buildPauseAdvice({ scores: { score_overall: 50 }, fatigue: { status: 'severe', evidence: 'x' }, textAnalysis: null }).action).toBe('Pause');
    });
    test('no fatigue -> no pause action', () => {
      const advice = buildPauseAdvice({ scores: { score_overall: 80 }, fatigue: { status: 'none' }, textAnalysis: null });
      expect(advice.action).toBeNull();
    });
    test('early fatigue with a genuinely weak dimension -> Rewrite naming that dimension', () => {
      const advice = buildPauseAdvice({ scores: { score_overall: 60 }, fatigue: { status: 'early', evidence: 'CPC rose 12%' }, textAnalysis: WEAK_TEXT });
      expect(advice.action).toBe('Rewrite');
    });
  });

  describe('compareDimensions / buildComparisonBreakdown', () => {
    test('only reports dimensions with a real, non-negligible score gap', () => {
      const a = { meta_ad_id: 'a', scores: { score_hook: 90, score_cta: 50 } };
      const b = { meta_ad_id: 'b', scores: { score_hook: 92, score_cta: 20 } }; // hook diff 2 (skip), cta diff 30 (report)
      const diffs = compareDimensions(a, b);
      expect(diffs.length).toBe(1);
      expect(diffs[0].dimension).toBe('CTA strength');
    });

    test('buildComparisonBreakdown never fabricates a runner-up comparison when there is none', () => {
      const comparison = { winner: { meta_ad_id: 'w' }, runner_up: null, worst: { meta_ad_id: 'l' } };
      const shaped = [
        { meta_ad_id: 'w', scores: { score_hook: 90 } },
        { meta_ad_id: 'l', scores: { score_hook: 20 } },
      ];
      const breakdown = buildComparisonBreakdown(comparison, shaped);
      expect(breakdown.winner_vs_weakest).toBeTruthy();
      expect(breakdown.winner_vs_runner_up).toBeUndefined();
    });
  });

  describe('buildEvolutionStages', () => {
    test('never invents Growth/Decline/Recovery stages with no backing event', () => {
      const timeline = { status: 'ok', events: [{ type: 'launch', date: '2026-01-01', score_overall: 50 }] };
      const { stages } = buildEvolutionStages(timeline);
      expect(stages.length).toBe(1);
      expect(stages[0].stage).toBe('Launch');
    });

    test('reports Stable only when there is truly no decline/fatigue event after peak', () => {
      const timeline = { status: 'ok', events: [
        { type: 'launch', date: '2026-01-01', score_overall: 40 },
        { type: 'peak', date: '2026-01-10', score_overall: 80 },
      ] };
      const { stages } = buildEvolutionStages(timeline);
      expect(stages.map(s => s.stage)).toEqual(expect.arrayContaining(['Launch', 'Growth', 'Peak', 'Stable']));
    });

    test('reports Decline and Fatigue when both events exist, no Stable', () => {
      const timeline = { status: 'ok', events: [
        { type: 'launch', date: '2026-01-01', score_overall: 40 },
        { type: 'peak', date: '2026-01-10', score_overall: 80 },
        { type: 'decline', date: '2026-01-20', score_overall: 60, drop_from_peak_pct: 25 },
        { type: 'fatigue', date: '2026-01-21', fatigue_status: 'moderate' },
      ] };
      const { stages } = buildEvolutionStages(timeline);
      const names = stages.map(s => s.stage);
      expect(names).toEqual(expect.arrayContaining(['Decline', 'Fatigue']));
      expect(names).not.toContain('Stable');
    });
  });

  // Phase 43 (Task 2)
  describe('buildScoreRelationship', () => {
    test('both high -> both_high pattern', () => {
      expect(buildScoreRelationship(90, 80).pattern).toBe('both_high');
    });
    test('both low -> both_low pattern', () => {
      expect(buildScoreRelationship(20, 30).pattern).toBe('both_low');
    });
    test('high health + low creative names the real carry-vs-creative relationship', () => {
      const result = buildScoreRelationship(85, 25);
      expect(result.pattern).toBe('high_health_low_creative');
    });
    test('a high health score next to a mid creative score never claims "both middling" -- describes each tier honestly', () => {
      const result = buildScoreRelationship(99, 57);
      expect(result.pattern).toBe('mixed');
      expect(result.explanation).toMatch(/Health is strong \(99\)/);
      expect(result.explanation).toMatch(/creative quality is middling \(57\)/);
      expect(result.explanation).not.toMatch(/both.*middl/i);
    });
    test('missing scores are reported honestly, not fabricated', () => {
      expect(buildScoreRelationship(null, 80).pattern).toBe('insufficient_data');
    });
  });

  // Phase 43 (Task 8)
  describe('buildHistoricalComparison', () => {
    test('insufficient_data with fewer than 2 real snapshots', () => {
      expect(buildHistoricalComparison([{ date_since: '2026-01-01', spend: 100, ctr: 2 }]).status).toBe('insufficient_data');
    });
    test('compares the two most recent real snapshots and labels trend direction correctly per metric', () => {
      const result = buildHistoricalComparison([
        { date_since: '2026-01-01', spend: 100, ctr: 2, cpa: 20, score_overall: 50 },
        { date_since: '2026-01-08', spend: 100, ctr: 3, cpa: 10, score_overall: 70 },
      ]);
      expect(result.status).toBe('ok');
      expect(result.trend.ctr.direction).toBe('improving'); // higher ctr = better
      expect(result.trend.cpa.direction).toBe('improving'); // lower cpa = better
      expect(result.trend.score_overall.direction).toBe('improving');
    });
  });

  describe('buildPreviousVersionComparison', () => {
    test('reports no_version_change honestly when no content change event exists', () => {
      const result = buildPreviousVersionComparison({ events: [{ type: 'launch', date: '2026-01-01' }], snapshots: [] });
      expect(result.status).toBe('no_version_change');
    });
    test('compares metrics before/after the most recent real content change', () => {
      const timeline = {
        events: [{ type: 'change', field: 'headline', date: '2026-01-08', from: 'Old', to: 'New' }],
        snapshots: [
          { date_since: '2026-01-01', ctr: 1, score_overall: 40 },
          { date_since: '2026-01-08', ctr: 2, score_overall: 60 },
        ],
      };
      const result = buildPreviousVersionComparison(timeline);
      expect(result.status).toBe('ok');
      expect(result.comparison.ctr.before).toBe(1);
      expect(result.comparison.ctr.after).toBe(2);
    });
  });

  // Phase 43 (Task 7)
  describe('buildAdvisorPanel', () => {
    test('never recommends Scale when fatigue is active -- Pause takes precedence', () => {
      const panel = buildAdvisorPanel({
        scores: { score_overall: 80 }, fatigue: { status: 'severe' },
        benchmarkVerdict: { verdict: 'above_average', grain: 'account' },
        scalingAdvice: { recommended: false, reason: 'fatigued' },
        pauseAdvice: { action: 'Pause', reason: 'severe fatigue' },
        changeRisk: { risk_level: 'Safe to edit' },
        priorities: [], latestRow: { spend: 200, frequency: 3 },
      });
      expect(panel.current_status).toBe('Pause');
      expect(panel.recommended_actions).toContain('Pause the ad');
    });

    test('every field is grounded in a real passed-in value, and confidence has a real reason', () => {
      const panel = buildAdvisorPanel({
        scores: { score_overall: 78 }, fatigue: { status: 'none' },
        benchmarkVerdict: { verdict: 'above_average', grain: 'ad_set' },
        scalingAdvice: { recommended: true, actions: [{ action: 'Duplicate', reason: 'winner' }] },
        pauseAdvice: { action: null, reason: 'healthy' },
        changeRisk: { risk_level: 'Leave unchanged' },
        priorities: [{ action: 'Improve CTA' }], latestRow: { spend: 200, frequency: 1.5 },
      });
      expect(panel.current_status).toBe('Scale');
      expect(panel.recommended_actions).toContain('Duplicate');
      expect(typeof panel.confidence).toBe('number');
      expect(panel.confidence_reason).toMatch(/supporting signal/);
    });
  });

  describe('buildCreativeAdvisor (orchestrator)', () => {
    test('degrades gracefully with minimal input and never throws', () => {
      const advisor = buildCreativeAdvisor({
        scores: { score_overall: null }, fatigue: { status: 'insufficient_data', evidence: 'not enough data' },
        textAnalysis: null, latestRow: { spend: null }, benchmarkAverages: {}, comparison: {}, comparisonRole: {},
        shapedSiblings: [], timeline: { status: 'no_data', events: [] }, recommendations: [],
      });
      expect(advisor.priorities).toEqual([]);
      expect(advisor.evolution.stages).toEqual([]);
      expect(advisor.change_risk.risk_level).toBe('Monitor first');
      // Phase 43 additions -- present and honest even with minimal input.
      expect(advisor.score_relationship.pattern).toBe('insufficient_data');
      expect(advisor.benchmark.historical.status).toBe('insufficient_data');
      expect(advisor.benchmark.previous_version.status).toBe('no_version_change');
      expect(advisor.rich_timeline.metrics_timeline).toEqual([]);
      expect(advisor.rich_timeline.state_transitions).toEqual([]);
      expect(advisor.panel.current_status).toBeTruthy();
      expect(typeof advisor.panel.confidence).toBe('number');
    });

    test('wires a real health score into score_relationship (Task 2)', () => {
      const advisor = buildCreativeAdvisor({
        scores: { score_overall: 80 }, fatigue: { status: 'none', evidence: '' },
        textAnalysis: null, latestRow: { spend: 200 }, benchmarkAverages: {}, comparison: {}, comparisonRole: {},
        shapedSiblings: [], timeline: { status: 'no_data', events: [] }, recommendations: [],
        healthScore: 85,
      });
      expect(advisor.score_relationship.pattern).toBe('both_high');
    });
  });

  // Phase 44 (Task 6)
  describe('buildWinLossNarrative', () => {
    test('names a real CTR gap and dimension diffs, and identifies who it was compared against', () => {
      const a = { meta_ad_id: 'a', ad_name: 'Ad A', ctr: 3.78, frequency: 1.2, fatigue_status: 'none', scores: { score_hook: 90 } };
      const b = { meta_ad_id: 'b', ad_name: 'Ad B', ctr: 3.0, frequency: 2.0, fatigue_status: 'moderate', scores: { score_hook: 40 } };
      const result = buildWinLossNarrative(a, b);
      expect(result.narrative).toMatch(/CTR is 26% higher/);
      expect(result.narrative).toMatch(/hook quality is stronger/);
      expect(result.narrative).toMatch(/Compared against: Ad B\./);
    });

    test('never fabricates a reason when nothing crosses the explanation threshold', () => {
      const a = { meta_ad_id: 'a', ad_name: 'Ad A', scores: { score_hook: 51 } };
      const b = { meta_ad_id: 'b', ad_name: 'Ad B', scores: { score_hook: 50 } };
      const result = buildWinLossNarrative(a, b);
      expect(result.narrative).toMatch(/no single dimension crossed the explanation threshold/);
    });
  });

  // Phase 44 (Task 8)
  describe('buildBusinessImpactEstimate', () => {
    test('is not_applicable for defensive actions (Pause/Refresh/Reallocate Budget)', () => {
      const result = buildBusinessImpactEstimate('Pause', {});
      expect(result.reach_increase.range).toBeNull();
      expect(result.reach_increase.note).toMatch(/Not applicable/);
    });

    test('grounds CTR-improvement range in a real peer-average gap when available, never a bare fabricated number', () => {
      const benchmarkComparison = { ad_set: { status: 'ok', metrics: { ctr: { status: 'below_average', diff_pct: -20 } } } };
      const result = buildBusinessImpactEstimate('Rewrite Hook', { benchmarkComparison, latestRow: {} });
      expect(result.ctr_improvement.range).toMatch(/^\d+(\.\d+)?-\d+(\.\d+)?%$/);
      expect(result.ctr_improvement.note).toMatch(/real CTR gap/);
    });

    test('scaling impact reflects real frequency headroom', () => {
      const lowFreq = buildBusinessImpactEstimate('Scale', { latestRow: { frequency: 1.2 } });
      const highFreq = buildBusinessImpactEstimate('Scale', { latestRow: { frequency: 3.5 } });
      expect(lowFreq.reach_increase.probability).toBe('Medium');
      expect(highFreq.reach_increase.probability).toBe('Low');
    });
  });

  // Phase 44 (Task 9)
  describe('buildRiskAssessment', () => {
    test('returns all five named risk dimensions with a level and reason', () => {
      const result = buildRiskAssessment('Scale', { fatigueStatus: 'none', latestRow: { spend: 200, frequency: 1.5 } });
      for (const key of ['implementation_risk', 'learning_phase_risk', 'audience_fatigue_risk', 'budget_risk', 'performance_volatility']) {
        expect(result[key].level).toMatch(/Low|Medium|High/);
        expect(typeof result[key].reason).toBe('string');
      }
    });

    test('flags high audience fatigue risk when fatigue is already active', () => {
      const result = buildRiskAssessment('Scale', { fatigueStatus: 'severe', latestRow: { spend: 200 } });
      expect(result.audience_fatigue_risk.level).toBe('High');
    });

    test('flags high performance volatility when spend is too low for a stable read', () => {
      const result = buildRiskAssessment('Rewrite Hook', { fatigueStatus: 'insufficient_data', latestRow: { spend: 2 } });
      expect(result.performance_volatility.level).toBe('High');
    });
  });

  // Phase 44 (Task 5)
  describe('buildBestWorstComparison', () => {
    test('reports insufficient_data honestly when the account has no other scored creative', () => {
      expect(buildBestWorstComparison({ score_overall: 60 }, { best: null, worst: null }).status).toBe('insufficient_data');
    });

    test('reports a real score gap against both the best and worst in the account', () => {
      const result = buildBestWorstComparison(
        { score_overall: 60 },
        { best: { meta_ad_id: 'best1', ad_name: 'Best Ad', score_overall: 90 }, worst: { meta_ad_id: 'worst1', ad_name: 'Worst Ad', score_overall: 20 } }
      );
      expect(result.status).toBe('ok');
      expect(result.best.score_gap).toBe(30);
      expect(result.worst.score_gap).toBe(40);
    });
  });

  // Phase 44 (Task 4)
  describe('buildBusinessEvents / buildScoreMilestones', () => {
    test('detects a real CTR peak, CPA drop, and frequency increase between consecutive real snapshots', () => {
      const timeline = [
        { date_since: '2026-01-01', ctr: 1, cpa: 20, frequency: 1.5 },
        { date_since: '2026-01-08', ctr: 1.5, cpa: 15, frequency: 2.0 },
      ];
      const events = buildBusinessEvents(timeline);
      expect(events.some(e => e.type === 'ctr_peak')).toBe(true);
      expect(events.some(e => e.type === 'cpa_drop')).toBe(true);
      expect(events.some(e => e.type === 'frequency_increase')).toBe(true);
    });

    test('never invents an event when metrics did not move meaningfully', () => {
      const timeline = [
        { date_since: '2026-01-01', ctr: 1, cpa: 20, frequency: 1.5 },
        { date_since: '2026-01-08', ctr: 1.01, cpa: 19.9, frequency: 1.51 },
      ];
      expect(buildBusinessEvents(timeline)).toEqual([]);
    });

    test('detects a real creative-score milestone crossing into strong/weak territory', () => {
      const timeline = [
        { date_since: '2026-01-01', score_overall: 55 },
        { date_since: '2026-01-08', score_overall: 70 },
      ];
      const events = buildScoreMilestones(timeline, []);
      expect(events.some(e => e.type === 'creative_score_milestone' && /strong territory/.test(e.detail))).toBe(true);
    });

    test('detects a real health-status change between two persisted health_score_history rows', () => {
      const healthHistory = [
        { health_score: 40, health_status: 'warning', calculated_at: '2026-01-01T00:00:00Z' },
        { health_score: 90, health_status: 'excellent', calculated_at: '2026-01-08T00:00:00Z' },
      ];
      const events = buildScoreMilestones([], healthHistory);
      expect(events.some(e => e.type === 'health_score_milestone' && /warning.*excellent/.test(e.detail))).toBe(true);
    });
  });

  // Phase 44 (Task 1) — panel priority/business_risk
  describe('buildAdvisorPanel priority/business_risk (Task 1)', () => {
    test('Scale/Pause decisions are HIGH priority; Monitor is LOW', () => {
      const scalePanel = buildAdvisorPanel({
        scores: { score_overall: 80 }, fatigue: { status: 'none' }, benchmarkVerdict: { verdict: 'above_average', grain: 'account' },
        scalingAdvice: { recommended: true, actions: [{ action: 'Scale' }] }, pauseAdvice: { action: null, reason: '' },
        changeRisk: { risk_level: 'Leave unchanged' }, priorities: [], latestRow: { spend: 200, frequency: 1.5 },
      });
      expect(scalePanel.priority).toBe('HIGH');

      const monitorPanel = buildAdvisorPanel({
        scores: { score_overall: 55 }, fatigue: { status: 'none' }, benchmarkVerdict: { verdict: 'average', grain: 'account' },
        scalingAdvice: { recommended: false, reason: '' }, pauseAdvice: { action: null, reason: '' },
        changeRisk: { risk_level: 'Monitor first' }, priorities: [], latestRow: { spend: 200, frequency: 1.5 },
      });
      expect(monitorPanel.priority).toBe('LOW');
    });

    test('business_risk is HIGH when fatigue is severe', () => {
      const panel = buildAdvisorPanel({
        scores: { score_overall: 40 }, fatigue: { status: 'severe' }, benchmarkVerdict: { verdict: 'below_average', grain: 'account' },
        scalingAdvice: { recommended: false, reason: '' }, pauseAdvice: { action: 'Pause', reason: 'severe fatigue' },
        changeRisk: { risk_level: 'Safe to edit' }, priorities: [], latestRow: { spend: 200, frequency: 4 },
      });
      expect(panel.business_risk).toBe('HIGH');
    });
  });

  // Phase 44 (Task 3) — score relationship next_step
  describe('buildScoreRelationship next_step (Task 3)', () => {
    test('every real pattern includes an actionable next_step', () => {
      expect(buildScoreRelationship(90, 80).next_step).toBeTruthy();
      expect(buildScoreRelationship(85, 25).next_step).toMatch(/hook or copy/i);
      expect(buildScoreRelationship(99, 57).next_step).toMatch(/improving the hook/i);
    });
  });

  // Phase 45 (Task 8) — Timeline duplicate merging
  describe('mergeConsecutiveTimelineEntries / buildStateTransitions', () => {
    test('collapses repeated identical health-score entries into one ranged, human-readable entry', () => {
      const rows = [
        { type: 'health_score', date: '2026-07-15', detail: 'Health score 99 (excellent)' },
        { type: 'health_score', date: '2026-07-16', detail: 'Health score 99 (excellent)' },
        { type: 'health_score', date: '2026-07-17', detail: 'Health score 99 (excellent)' },
      ];
      const merged = mergeConsecutiveTimelineEntries(rows);
      expect(merged.length).toBe(1);
      expect(merged[0].detail).toMatch(/Health Score remained Excellent/);
      expect(merged[0].date_range).toEqual(['2026-07-15', '2026-07-17']);
      expect(merged[0].repeat_count).toBe(3);
    });

    test('never merges entries that genuinely differ', () => {
      const rows = [
        { type: 'health_score', date: '2026-07-15', detail: 'Health score 99 (excellent)' },
        { type: 'health_score', date: '2026-07-16', detail: 'Health score 60 (good)' },
      ];
      expect(mergeConsecutiveTimelineEntries(rows).length).toBe(2);
    });

    test('buildStateTransitions itself applies the merge to real health_score_history rows', () => {
      const healthHistory = [
        { health_score: 99, health_status: 'excellent', calculated_at: '2026-07-15T10:00:00Z' },
        { health_score: 99, health_status: 'excellent', calculated_at: '2026-07-16T10:00:00Z' },
        { health_score: 99, health_status: 'excellent', calculated_at: '2026-07-17T10:00:00Z' },
      ];
      const result = buildStateTransitions({ healthHistory, recommendationHistory: [], alertHistory: [] });
      expect(result.length).toBe(1);
      expect(result[0].repeat_count).toBe(3);
    });
  });
});
