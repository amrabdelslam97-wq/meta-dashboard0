'use strict';

const { createTestDb } = require('../helpers/testDb');
const {
  calculateHealthScore, saveHealthScore, getHealthScoreTrend, scoreToStatus, normalizeMetric,
} = require('../../src/services/healthScoreEngine');

describe('healthScoreEngine.scoreToStatus', () => {
  test.each([
    [95, 'excellent'], [80, 'excellent'],
    [79, 'good'], [60, 'good'],
    [59, 'warning'], [40, 'warning'],
    [39, 'critical'], [0, 'critical'],
  ])('%d -> %s', (score, status) => {
    expect(scoreToStatus(score)).toBe(status);
  });
});

describe('healthScoreEngine.normalizeMetric', () => {
  const lowerIsBetter = { comparison_direction: 'lower_is_better', excellent_threshold: 5, critical_threshold: 60 };
  const higherIsBetter = { comparison_direction: 'higher_is_better', excellent_threshold: 3, critical_threshold: 0.5 };
  const optimalRange = { comparison_direction: 'optimal_range', optimal_low: 1.5, optimal_high: 3.5 };

  test('lower_is_better: at or below excellent scores 100', () => {
    expect(normalizeMetric(5, lowerIsBetter)).toBe(100);
    expect(normalizeMetric(2, lowerIsBetter)).toBe(100);
  });

  test('lower_is_better: at or above critical scores 0', () => {
    expect(normalizeMetric(60, lowerIsBetter)).toBe(0);
    expect(normalizeMetric(100, lowerIsBetter)).toBe(0);
  });

  test('lower_is_better: linear interpolation between excellent and critical', () => {
    // Midpoint between 5 and 60 is 32.5 -> should score ~50
    expect(normalizeMetric(32.5, lowerIsBetter)).toBe(50);
  });

  test('higher_is_better: at or above excellent scores 100', () => {
    expect(normalizeMetric(3, higherIsBetter)).toBe(100);
    expect(normalizeMetric(10, higherIsBetter)).toBe(100);
  });

  test('higher_is_better: at or below critical scores 0', () => {
    expect(normalizeMetric(0.5, higherIsBetter)).toBe(0);
    expect(normalizeMetric(0, higherIsBetter)).toBe(0);
  });

  test('optimal_range: inside the band scores 100', () => {
    expect(normalizeMetric(2.5, optimalRange)).toBe(100);
    expect(normalizeMetric(1.5, optimalRange)).toBe(100);
    expect(normalizeMetric(3.5, optimalRange)).toBe(100);
  });

  test('optimal_range: below the band scores proportionally lower', () => {
    expect(normalizeMetric(0.75, optimalRange)).toBe(50); // 0.75/1.5 * 100
  });

  test('optimal_range: above the band decays proportionally', () => {
    // overshoot=3.5 over maxOvershoot=3.5 -> fully decayed to 0
    expect(normalizeMetric(7, optimalRange)).toBe(0);
  });

  test('returns null for null/undefined/NaN input', () => {
    expect(normalizeMetric(null, lowerIsBetter)).toBeNull();
    expect(normalizeMetric(undefined, lowerIsBetter)).toBeNull();
    expect(normalizeMetric(NaN, lowerIsBetter)).toBeNull();
  });
});

describe('healthScoreEngine.calculateHealthScore', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('all engagement metrics present and excellent -> perfect score', () => {
    const campaign = { meta_campaign_id: 'camp_test_1', name: 'Test Campaign', objective: 'engagement' };
    const metrics = { cpr: 5, ctr: 3, frequency: 2.5, reach: 5000 };
    const result = calculateHealthScore(campaign, metrics, 'test-account-id');
    expect(result.health_score).toBe(100);
    expect(result.health_status).toBe('excellent');
    expect(result.score_reference).toBe('platform_default');
  });

  // Regression test for T4-01: calculateHealthScore used to compute the
  // correct weight-coverage-blended formula and then immediately overwrite
  // it with a plain weightedTotal/weightUsed average that ignored how much
  // of the objective's total weight was actually covered. With only CTR
  // available (weight 0.30 of the engagement objective's 1.0 total) and CTR
  // itself scoring 100, the old buggy code would produce 100 (since
  // 30/0.3 = 100, identical to full coverage). The fixed formula blends
  // toward neutral (50) proportional to the *missing* 0.70 of weight,
  // producing 65 instead -- this is the exact bug this test guards against.
  test('partial metric coverage blends toward neutral instead of extrapolating from one metric (T4-01)', () => {
    const campaign = { meta_campaign_id: 'camp_test_2', name: 'Partial Data Campaign', objective: 'engagement' };
    const metrics = { ctr: 3 }; // only CTR present; cpr/frequency/reach missing
    const result = calculateHealthScore(campaign, metrics, 'test-account-id');
    expect(result.health_score).toBe(65);
    expect(result.health_status).toBe('good');
    expect(result.breakdown.cpr).toEqual({ value: null, normalized: null, weight: 0.40 });
  });

  test('no metrics at all yields the fully neutral 50 score', () => {
    const campaign = { meta_campaign_id: 'camp_test_3', name: 'No Data Campaign', objective: 'leads' };
    const result = calculateHealthScore(campaign, {}, 'test-account-id');
    expect(result.health_score).toBe(50);
    expect(result.health_status).toBe('warning');
  });

  test('unknown objective with no scoring config returns neutral score with a note', () => {
    const campaign = { meta_campaign_id: 'camp_test_4', name: 'Unknown Objective', objective: 'not_a_real_objective' };
    const result = calculateHealthScore(campaign, { ctr: 5 }, 'test-account-id');
    expect(result.health_score).toBe(50);
    expect(result.health_status).toBe('warning');
    expect(result.note).toMatch(/No scoring config found/);
  });

  test('worst-case metrics across the board produce a critical score', () => {
    const campaign = { meta_campaign_id: 'camp_test_5', name: 'Bad Campaign', objective: 'sales' };
    // sales: roas (higher, excellent 4/critical 0.5), cpa (lower, excellent 20/critical 250),
    // purchases (higher, excellent 20/critical 0), ctr (higher, excellent 3/critical 0.5)
    const metrics = { roas: 0.1, cpa: 500, purchases: 0, ctr: 0 };
    const result = calculateHealthScore(campaign, metrics, 'test-account-id');
    expect(result.health_score).toBe(0);
    expect(result.health_status).toBe('critical');
  });
});

describe('healthScoreEngine.saveHealthScore + getHealthScoreTrend', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  const campaign = { meta_campaign_id: 'camp_trend_test', name: 'Trend Campaign', objective: 'engagement' };

  test('saveHealthScore writes a new row and getHealthScoreTrend reads it back', () => {
    const result = { health_score: 72, health_status: 'good', score_reference: 'platform_default', breakdown: {} };
    saveHealthScore(campaign, 'acct-1', result, 'campaign');

    const trend = getHealthScoreTrend('camp_trend_test', 30, 'campaign');
    expect(trend.length).toBe(1);
    expect(trend[0].health_score).toBe(72);
    expect(trend[0].health_status).toBe('good');
  });

  test('saveHealthScore dedups an identical score recorded within the skip window', () => {
    const result = { health_score: 72, health_status: 'good', score_reference: 'platform_default', breakdown: {} };
    saveHealthScore(campaign, 'acct-1', result, 'campaign'); // identical to the row already written above

    const trend = getHealthScoreTrend('camp_trend_test', 30, 'campaign');
    expect(trend.length).toBe(1); // still just the one row, not two
  });

  test('saveHealthScore writes a new row when the score actually changes', () => {
    const changed = { health_score: 45, health_status: 'warning', score_reference: 'platform_default', breakdown: {} };
    saveHealthScore(campaign, 'acct-1', changed, 'campaign');

    const trend = getHealthScoreTrend('camp_trend_test', 30, 'campaign');
    expect(trend.length).toBe(2);
    expect(trend[1].health_score).toBe(45); // chronological order, most recent last
  });
});
