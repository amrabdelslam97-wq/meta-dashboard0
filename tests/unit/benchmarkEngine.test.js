'use strict';

const { createTestDb } = require('../helpers/testDb');
const { evaluateBenchmarks, evaluateMetric } = require('../../src/services/benchmarkEngine');

describe('benchmarkEngine.evaluateMetric', () => {
  const lowerBenchmark = {
    comparison_direction: 'lower_is_better',
    excellent_threshold: 5, good_threshold: 15, warning_threshold: 30, critical_threshold: 60,
    source: 'platform_default',
  };
  const higherBenchmark = {
    comparison_direction: 'higher_is_better',
    excellent_threshold: 3, good_threshold: 2, warning_threshold: 1, critical_threshold: 0.5,
    source: 'platform_default',
  };
  const optimalBenchmark = {
    comparison_direction: 'optimal_range', optimal_low: 1.5, optimal_high: 3.5,
    source: 'platform_default',
  };

  test('returns no_data when value is null/undefined', () => {
    expect(evaluateMetric(null, lowerBenchmark).status).toBe('no_data');
    expect(evaluateMetric(undefined, lowerBenchmark).status).toBe('no_data');
  });

  test('returns no_benchmark when no benchmark is resolvable', () => {
    expect(evaluateMetric(5, null).status).toBe('no_benchmark');
  });

  test('lower_is_better: value at/below excellent is "above" (better than excellent)', () => {
    expect(evaluateMetric(5, lowerBenchmark).status).toBe('above');
    expect(evaluateMetric(2, lowerBenchmark).status).toBe('above');
  });

  test('lower_is_better: value between excellent and good is "optimal"', () => {
    expect(evaluateMetric(10, lowerBenchmark).status).toBe('optimal');
  });

  test('lower_is_better: value between good and warning is "below"', () => {
    expect(evaluateMetric(25, lowerBenchmark).status).toBe('below');
  });

  test('lower_is_better: value past warning is "critical"', () => {
    expect(evaluateMetric(45, lowerBenchmark).status).toBe('critical');
    expect(evaluateMetric(100, lowerBenchmark).status).toBe('critical');
  });

  test('higher_is_better: value at/above excellent is "above"', () => {
    expect(evaluateMetric(3, higherBenchmark).status).toBe('above');
  });

  test('higher_is_better: value past warning downward is "critical"', () => {
    expect(evaluateMetric(0.2, higherBenchmark).status).toBe('critical');
  });

  test('optimal_range: inside the band is "optimal"', () => {
    expect(evaluateMetric(2.5, optimalBenchmark).status).toBe('optimal');
  });

  test('optimal_range: below the band is "below", above is "above"', () => {
    expect(evaluateMetric(0.5, optimalBenchmark).status).toBe('below');
    expect(evaluateMetric(5, optimalBenchmark).status).toBe('above');
  });
});

describe('benchmarkEngine.evaluateBenchmarks (metric-set-per-objective, T4-06)', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  // Regression test for T4-06: metricsByObjective had drifted from
  // objective_scoring_configs, dropping each objective's primary volume
  // KPI and substituting an unrelated 'cpm'. Assert the exact metric sets
  // now evaluated per objective match the seeded scoring configs.
  test.each([
    ['messaging', ['cpr', 'ctr', 'frequency', 'reach']],
    ['leads',     ['cpl', 'leads', 'ctr', 'frequency']],
    ['sales',     ['roas', 'cpa', 'purchases', 'ctr']],
    ['traffic',   ['cpc', 'ctr', 'landing_page_views', 'frequency']],
    ['awareness', ['reach', 'cpm', 'frequency', 'impressions']],
  ])('%s objective evaluates exactly %j', (objective, expectedKeys) => {
    const campaign = { objective };
    const metrics = Object.fromEntries(expectedKeys.map(k => [k, 1]));
    const result = evaluateBenchmarks(campaign, metrics, 'test-account');
    expect(Object.keys(result.metrics).sort()).toEqual([...expectedKeys].sort());
  });

  test('unknown objective falls back to a universal metric set', () => {
    const result = evaluateBenchmarks({ objective: 'not_a_real_objective' }, {}, 'test-account');
    expect(Object.keys(result.metrics).sort()).toEqual(['cpm', 'ctr', 'frequency']);
  });

  test('summary tallies statuses correctly against platform-default thresholds', () => {
    // messaging: cpr excellent<=5, ctr excellent>=3, frequency optimal 1.5-3.5, reach excellent>=5000
    const result = evaluateBenchmarks(
      { objective: 'messaging' },
      { cpr: 5, ctr: 3, frequency: 2.5, reach: 5000 },
      'test-account'
    );
    expect(result.summary.above + result.summary.optimal).toBe(4);
    expect(result.summary.critical).toBe(0);
    expect(result.summary.total).toBe(4);
  });

  test('missing metric values resolve to no_data rather than throwing', () => {
    const result = evaluateBenchmarks({ objective: 'sales' }, {}, 'test-account');
    expect(result.summary.no_data).toBe(4);
  });
});
