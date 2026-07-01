'use strict';

const {
  normalizeRow, pickRoasValue, attributionWindowParams, computeDeltas,
} = require('../../src/services/metricsFetcher');

describe('metricsFetcher.pickRoasValue', () => {
  test('prefers omni_purchase over other action types', () => {
    const roasArray = [
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '1.5' },
      { action_type: 'omni_purchase', value: '3.2' },
      { action_type: 'purchase', value: '2.1' },
    ];
    expect(pickRoasValue(roasArray)).toBe(3.2);
  });

  test('falls back to purchase when omni_purchase is absent', () => {
    const roasArray = [
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '1.5' },
      { action_type: 'purchase', value: '2.1' },
    ];
    expect(pickRoasValue(roasArray)).toBe(2.1);
  });

  test('falls back to the first entry when no known action_type matches', () => {
    const roasArray = [{ action_type: 'some_unrelated_action', value: '9.9' }];
    expect(pickRoasValue(roasArray)).toBe(9.9);
  });

  test('returns null for empty, missing, or non-array input', () => {
    expect(pickRoasValue([])).toBeNull();
    expect(pickRoasValue(null)).toBeNull();
    expect(pickRoasValue(undefined)).toBeNull();
  });
});

describe('metricsFetcher.normalizeRow', () => {
  test('returns null for falsy input', () => {
    expect(normalizeRow(null)).toBeNull();
  });

  test('parses core numeric fields from a real-shaped Meta insights row', () => {
    const row = {
      spend: '123.45', impressions: '10000', reach: '8000', clicks: '150',
      ctr: '1.5', cpm: '12.3', cpc: '0.82', frequency: '1.25',
      date_start: '2026-06-24', date_stop: '2026-06-30',
    };
    const normalized = normalizeRow(row);
    expect(normalized.spend).toBe(123.45);
    expect(normalized.impressions).toBe(10000);
    expect(normalized.date_start).toBe('2026-06-24');
    expect(normalized.date_stop).toBe('2026-06-30');
  });

  test('parses actions[] into flat metric keys (messaging results)', () => {
    const row = {
      spend: '100',
      actions: [
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '20' },
      ],
      cost_per_action_type: [
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' },
      ],
    };
    const normalized = normalizeRow(row);
    expect(normalized.results).toBe(20);
    expect(normalized.cpr).toBe(5);
  });

  test('derives cpr from spend/results when Meta omits cost_per_action_type', () => {
    const row = {
      spend: '100',
      actions: [{ action_type: 'lead', value: '10' }],
    };
    const normalized = normalizeRow(row);
    expect(normalized.leads).toBe(10);
    expect(normalized.cpl).toBe(10); // 100 / 10
  });

  test('uses action_values (not conversion_values) for purchase_value and derives roas', () => {
    const row = {
      spend: '200',
      actions: [{ action_type: 'purchase', value: '4' }],
      action_values: [{ action_type: 'purchase', value: '800' }],
    };
    const normalized = normalizeRow(row);
    expect(normalized.purchase_value).toBe(800);
    expect(normalized.roas).toBe(4); // 800 / 200
  });

  test('prefers Meta-provided purchase_roas over the derived purchase_value/spend calc', () => {
    const row = {
      spend: '200',
      purchase_roas: [{ action_type: 'omni_purchase', value: '5.5' }],
      actions: [{ action_type: 'purchase', value: '4' }],
      action_values: [{ action_type: 'purchase', value: '800' }],
    };
    const normalized = normalizeRow(row);
    expect(normalized.roas).toBe(5.5);
  });

  test('computes landing_page_view_rate from landing_page_views/clicks', () => {
    const row = {
      spend: '50', clicks: '200',
      actions: [{ action_type: 'landing_page_view', value: '80' }],
    };
    const normalized = normalizeRow(row);
    expect(normalized.landing_page_view_rate).toBe(40); // 80/200 * 100
  });

  test('missing actions[] entirely does not throw and yields no action metrics', () => {
    const normalized = normalizeRow({ spend: '10' });
    expect(normalized.results).toBeUndefined();
    expect(normalized.leads).toBeUndefined();
  });
});

describe('metricsFetcher.attributionWindowParams', () => {
  test('builds the Meta-documented action_attribution_windows param', () => {
    expect(attributionWindowParams(7)).toEqual({
      action_attribution_windows: JSON.stringify(['7d_click']),
    });
  });

  test('returns an empty object when attributionWindowDays is falsy', () => {
    expect(attributionWindowParams(0)).toEqual({});
    expect(attributionWindowParams(null)).toEqual({});
    expect(attributionWindowParams(undefined)).toEqual({});
  });
});

describe('metricsFetcher.computeDeltas', () => {
  test('computes absolute and percentage deltas between two periods', () => {
    const current = { spend: 150, ctr: 2 };
    const prior = { spend: 100, ctr: 1 };
    const deltas = computeDeltas(current, prior);
    expect(deltas.spend).toEqual({ delta_abs: 50, delta_pct: 50 });
    expect(deltas.ctr).toEqual({ delta_abs: 1, delta_pct: 100 });
  });

  test('returns empty object when either period is missing', () => {
    expect(computeDeltas(null, { spend: 1 })).toEqual({});
    expect(computeDeltas({ spend: 1 }, null)).toEqual({});
  });

  test('handles a zero prior value without dividing by zero', () => {
    const deltas = computeDeltas({ spend: 50 }, { spend: 0 });
    expect(deltas.spend).toEqual({ delta_abs: 50, delta_pct: 100 });
  });
});
