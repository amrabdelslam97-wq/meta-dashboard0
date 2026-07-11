'use strict';

const { buildInsight } = require('../../src/services/analyticsInsight');

describe('analyticsInsight.buildInsight', () => {
  test('returns insufficient_data when no rows have real spend/cost data', () => {
    const result = buildInsight([{ dimension_value: '18-24', spend: 0, cost_per_result: null }]);
    expect(result.trend).toBe('insufficient_data');
    expect(result.top_performer).toBeNull();
    expect(result.bottom_performer).toBeNull();
    expect(result.confidence).toBe('low');
  });

  test('identifies a real top/bottom performer and flags the efficiency gap as an opportunity/risk', () => {
    const rows = [
      { dimension_value: '18-24', spend: 100, cost_per_result: 5 },
      { dimension_value: '25-34', spend: 400, cost_per_result: 8 },
      { dimension_value: '35-44', spend: 300, cost_per_result: 9 },
      { dimension_value: '45-54', spend: 200, cost_per_result: 20 }, // clear outlier
    ];
    const result = buildInsight(rows);

    expect(result.top_performer.label).toBe('18-24');
    expect(result.bottom_performer.label).toBe('45-54');
    expect(result.trend).toBe('divergent');
    expect(result.opportunity).toMatch(/18-24/);
    expect(result.risk).toMatch(/45-54/);
    expect(result.recommendation).toMatch(/45-54/);
    expect(result.recommendation).toMatch(/18-24/);
    expect(['high', 'medium']).toContain(result.confidence);
  });

  test('reports "stable" trend with no opportunity/risk when performance is evenly distributed', () => {
    const rows = [
      { dimension_value: 'facebook / feed', spend: 100, cost_per_result: 10 },
      { dimension_value: 'instagram / feed', spend: 100, cost_per_result: 10.5 },
      { dimension_value: 'instagram / reels', spend: 100, cost_per_result: 9.8 },
    ];
    const result = buildInsight(rows);
    expect(result.trend).toBe('stable');
    expect(result.opportunity).toBeNull();
    expect(result.risk).toBeNull();
  });

  test('falls back to cpr/cpa when cost_per_result is absent, and to a custom costKey/labelKey when given', () => {
    const rows = [
      { name: 'Ad A', spend: 100, cpa: 4 },
      { name: 'Ad B', spend: 100, cpa: 12 },
    ];
    const result = buildInsight(rows, { costKey: 'cpa', labelKey: 'name' });
    expect(result.top_performer.label).toBe('Ad A');
    expect(result.top_performer.cpa).toBe(4);
  });

  test('a single ranked row never claims a divergent trend (nothing to compare against)', () => {
    const rows = [{ dimension_value: 'US', spend: 500, cost_per_result: 7 }];
    const result = buildInsight(rows);
    expect(result.trend).toBe('stable');
    expect(result.top_performer.label).toBe('US');
    expect(result.bottom_performer.label).toBe('US');
  });
});
