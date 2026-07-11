'use strict';

const engine = require('../../src/services/creativeIntelligenceEngine');

function baseCreative(overrides = {}) {
  return {
    headline: 'Shop The Sale Now',
    primary_text: 'Tired of overpaying? Save 30% today. Trusted by thousands of happy customers.',
    description: 'Free shipping.',
    cta_type: 'SHOP_NOW',
    media_type: 'image',
    aspect_ratio: '4:5',
    spend: 100,
    results: 10,
    ctr: 2.5,
    cost_per_result: 10,
    ...overrides,
  };
}

describe('creativeIntelligenceEngine', () => {
  describe('computeCreativeScore', () => {
    test('produces every named sub-score plus a valid overall average', () => {
      const scored = engine.computeCreativeScore(baseCreative());
      for (const key of ['score_hook', 'score_headline', 'score_copy', 'score_visual', 'score_cta', 'score_offer', 'score_trust', 'score_psychology']) {
        expect(typeof scored[key]).toBe('number');
        expect(scored[key]).toBeGreaterThanOrEqual(0);
        expect(scored[key]).toBeLessThanOrEqual(100);
      }
      expect(scored.score_overall).toBeGreaterThan(0);
      expect(scored.score_overall).toBeLessThanOrEqual(100);
    });

    test('score_brand is honestly null (no brand guideline data source exists)', () => {
      const scored = engine.computeCreativeScore(baseCreative());
      expect(scored.score_brand).toBeNull();
    });

    test('score_retention uses real hold_rate when present, is null when no video data exists', () => {
      const withVideo = engine.computeCreativeScore(baseCreative({ hold_rate: 42 }));
      expect(withVideo.score_retention).toBe(42);
      const noVideo = engine.computeCreativeScore(baseCreative());
      expect(noVideo.score_retention).toBeNull();
    });

    test('score_scroll_stop prefers real video_p25_pct over the text-hook fallback', () => {
      const scored = engine.computeCreativeScore(baseCreative({ video_p25_pct: 80 }));
      expect(scored.score_scroll_stop).toBe(96); // 80 * 1.2, capped at 100 -- 80*1.2=96
    });

    test('a strong creative scores meaningfully higher than a weak one', () => {
      const strong = engine.computeCreativeScore(baseCreative());
      const weak = engine.computeCreativeScore({ headline: null, primary_text: null, description: null, cta_type: null, spend: 0, results: 0 });
      expect(strong.score_overall).toBeGreaterThan(weak.score_overall || 0);
    });

    test('incorporates a supplied fatigue result into score_fatigue', () => {
      const withSevere = engine.computeCreativeScore(baseCreative(), { status: 'severe' });
      const withNone = engine.computeCreativeScore(baseCreative(), { status: 'none' });
      expect(withSevere.score_fatigue).toBeLessThan(withNone.score_fatigue);
    });
  });

  describe('detectFatigue', () => {
    function snapshot(overrides) {
      return { spend: 50, frequency: 2, ctr: 2, cpc: 1, cpm: 10, conversion_rate: 5, reach: 1000, results: 10, cost_per_result: 5, date_since: '2026-06-01', date_until: '2026-06-07', ...overrides };
    }

    test('reports insufficient_data with fewer than 2 eligible snapshots', () => {
      const result = engine.detectFatigue([snapshot({})]);
      expect(result.status).toBe('insufficient_data');
      expect(result.recommendation).toBeNull();
    });

    test('detects "none" when nothing has moved meaningfully', () => {
      const result = engine.detectFatigue([snapshot({}), snapshot({})]);
      expect(result.status).toBe('none');
      expect(result.recommendation).toBe('scale'); // healthy + has results/cost data
    });

    test('detects severe fatigue when frequency/CPC/CPM rise and CTR/conversion fall together', () => {
      const early = snapshot({ frequency: 2, ctr: 3, cpc: 1, cpm: 10, conversion_rate: 6 });
      const later = snapshot({ frequency: 3.5, ctr: 1.8, cpc: 1.5, cpm: 14, conversion_rate: 3.5 }); // all four signals + reach flat
      const result = engine.detectFatigue([early, later]);
      expect(result.status).toBe('severe');
      expect(result.recommendation).toBe('pause');
      expect(result.signals.map(s => s.signal)).toEqual(expect.arrayContaining(['increasing_frequency', 'ctr_decline', 'rising_cpc', 'rising_cpm']));
    });

    test('detects audience saturation when frequency rises with flat reach', () => {
      const early = snapshot({ frequency: 2, reach: 1000 });
      const later = snapshot({ frequency: 3, reach: 1010 }); // reach barely moved
      const result = engine.detectFatigue([early, later]);
      expect(result.signals.some(s => s.signal === 'audience_saturation')).toBe(true);
    });

    test('ignores snapshots below the minimum spend threshold (avoids diagnosing on noise)', () => {
      const result = engine.detectFatigue([snapshot({ spend: 2 }), snapshot({ spend: 3 })]);
      expect(result.status).toBe('insufficient_data');
    });

    test('early fatigue (1 signal) recommends refresh, not pause', () => {
      const early = snapshot({ ctr: 3 });
      const later = snapshot({ ctr: 2 }); // one clean decline signal only
      const result = engine.detectFatigue([early, later]);
      expect(result.status).toBe('early');
      expect(result.recommendation).toBe('refresh');
    });
  });

  describe('compareCreativesInAdSet', () => {
    function creative(id, overrideScores) {
      return {
        meta_ad_id: id, ad_name: `Ad ${id}`, cost_per_result: overrideScores.cost_per_result,
        scores: { score_overall: overrideScores.score_overall, score_hook: overrideScores.score_hook ?? 50, score_headline: 50, score_copy: 50, score_cta: overrideScores.score_cta ?? 50, score_offer: 50, score_trust: 50, score_visual: 50 },
      };
    }

    test('ranks by score_overall and identifies winner/runner-up/worst', () => {
      const creatives = [
        creative('a', { score_overall: 40, cost_per_result: 20 }),
        creative('b', { score_overall: 90, cost_per_result: 5, score_hook: 90 }),
        creative('c', { score_overall: 65, cost_per_result: 10 }),
      ];
      const result = engine.compareCreativesInAdSet(creatives);
      expect(result.winner.meta_ad_id).toBe('b');
      expect(result.runner_up.meta_ad_id).toBe('c');
      expect(result.worst.meta_ad_id).toBe('a');
      expect(result.ranking.map(r => r.meta_ad_id)).toEqual(['b', 'c', 'a']);
    });

    test('explains WHY the winner beats the worst using specific score-dimension deltas, not just numbers', () => {
      const creatives = [
        creative('winner', { score_overall: 90, score_hook: 95, cost_per_result: 4 }),
        creative('loser', { score_overall: 30, score_hook: 20, cost_per_result: 25 }),
      ];
      const result = engine.compareCreativesInAdSet(creatives);
      expect(result.comparisons[0].why.some(r => r.includes('hook'))).toBe(true);
      expect(result.comparisons[0].why.some(r => r.includes('cost per result'))).toBe(true);
    });

    test('handles an empty or all-unscored list gracefully', () => {
      const result = engine.compareCreativesInAdSet([]);
      expect(result.winner).toBeNull();
      expect(result.ranking).toEqual([]);
    });

    test('a single creative is its own winner with no worst/comparison', () => {
      const result = engine.compareCreativesInAdSet([creative('solo', { score_overall: 70 })]);
      expect(result.winner.meta_ad_id).toBe('solo');
      expect(result.worst).toBeNull();
      expect(result.comparisons).toEqual([]);
    });
  });

  describe('generateRecommendations', () => {
    test('a weak creative gets multiple concrete, evidence-backed recommendations', () => {
      const weakCreative = { headline: 'BUY BUY BUY BUY BUY BUY NOW', primary_text: null, description: null, cta_type: null, spend: 5, results: 0 };
      const scored = engine.computeCreativeScore(weakCreative);
      const fatigue = { status: 'severe', evidence: 'CTR fell 40%; CPC rose 30%' };
      const recs = engine.generateRecommendations(scored, fatigue);
      expect(recs.some(r => r.action === 'Pause')).toBe(true);
      expect(recs.length).toBeGreaterThan(1);
      expect(recs.every(r => r.reason && r.reason.length > 0)).toBe(true);
    });

    test('a strong, non-fatigued, winning creative recommends Scale and Duplicate Winner', () => {
      const scored = engine.computeCreativeScore(baseCreative());
      const fatigue = { status: 'none' };
      const recs = engine.generateRecommendations(scored, fatigue, { isWinner: true });
      expect(recs.some(r => r.action === 'Scale')).toBe(true);
      expect(recs.some(r => r.action === 'Duplicate Winner')).toBe(true);
    });

    test('the ad-set worst performer gets a Pause Loser recommendation', () => {
      const scored = engine.computeCreativeScore(baseCreative());
      const recs = engine.generateRecommendations(scored, null, { isWorst: true });
      expect(recs.some(r => r.action === 'Pause Loser')).toBe(true);
    });
  });
});
