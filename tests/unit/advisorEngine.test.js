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
  buildCreativeAdvisor,
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
    });
  });
});
