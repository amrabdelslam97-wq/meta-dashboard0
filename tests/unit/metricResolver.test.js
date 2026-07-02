'use strict';

const { resolveProfile } = require('../../src/services/kpiProfileResolver');
const { resolveMetrics, resolveMetric, isApplicable, formatMetricLabel } = require('../../src/services/metricResolver');

describe('metricResolver.resolveMetrics', () => {
  test('a metric present in the profile and present in raw data is applicable + available with its real value', () => {
    const profile = resolveProfile('sales');
    const raw = { roas: 2.4, cpa: 45, purchases: 10, ctr: 1.8 };
    const resolved = resolveMetrics(profile, raw);
    const roas = resolved.find(m => m.key === 'roas');
    expect(roas).toMatchObject({ key: 'roas', label: 'ROAS', value: 2.4, applicable: true, available: true, reason: null });
  });

  test('a metric present in the profile but missing from raw data is applicable but not available', () => {
    const profile = resolveProfile('sales');
    const raw = { roas: 2.4 }; // cpa/purchases/ctr genuinely absent, e.g. Meta returned no data for them
    const resolved = resolveMetrics(profile, raw);
    const cpa = resolved.find(m => m.key === 'cpa');
    expect(cpa).toMatchObject({ applicable: true, available: false, value: null, reason: 'no_data_returned' });
  });

  test('resolveMetrics only ever returns keys that are part of the profile (never invents extra metrics)', () => {
    const profile = resolveProfile('traffic');
    const raw = { roas: 99, purchases: 5, ctr: 2 }; // roas/purchases are NOT traffic metrics
    const resolved = resolveMetrics(profile, raw);
    const keys = resolved.map(m => m.key);
    expect(keys).not.toContain('roas');
    expect(keys).not.toContain('purchases');
    expect(keys).toContain('ctr');
    expect(keys).toEqual(profile.displayMetrics);
  });

  test('handles a completely missing raw metrics object (null) without throwing', () => {
    const profile = resolveProfile('leads');
    expect(() => resolveMetrics(profile, null)).not.toThrow();
    const resolved = resolveMetrics(profile, null);
    expect(resolved.every(m => m.available === false && m.value === null)).toBe(true);
  });
});

describe('metricResolver.resolveMetric (single key, distinguishes not-applicable from not-available)', () => {
  test('a metric key not in the profile at all is not_applicable_to_objective', () => {
    const profile = resolveProfile('traffic');
    const result = resolveMetric(profile, 'roas', { roas: 5 });
    expect(result).toMatchObject({ applicable: false, available: false, reason: 'not_applicable_to_objective' });
  });

  test('a metric key in the profile but missing data is no_data_returned, not not_applicable', () => {
    const profile = resolveProfile('sales');
    const result = resolveMetric(profile, 'roas', {});
    expect(result).toMatchObject({ applicable: true, available: false, reason: 'no_data_returned' });
  });

  test('a metric key in the profile with real data resolves correctly', () => {
    const profile = resolveProfile('sales');
    const result = resolveMetric(profile, 'roas', { roas: 3.1 });
    expect(result).toMatchObject({ applicable: true, available: true, value: 3.1, reason: null });
  });
});

describe('metricResolver.isApplicable', () => {
  test('true for a metric in the profile, false for one that is not', () => {
    const profile = resolveProfile('leads');
    expect(isApplicable(profile, 'leads')).toBe(true);
    expect(isApplicable(profile, 'roas')).toBe(false);
  });
});

describe('metricResolver.formatMetricLabel', () => {
  test('returns the canonical label for known keys', () => {
    expect(formatMetricLabel('roas')).toBe('ROAS');
    expect(formatMetricLabel('cpa')).toBe('Cost Per Purchase');
    expect(formatMetricLabel('app_installs')).toBe('App Installs');
    expect(formatMetricLabel('thruplays')).toBe('ThruPlays');
  });

  test('falls back to a title-cased version of unknown keys instead of throwing', () => {
    expect(formatMetricLabel('some_future_metric_key')).toBe('Some Future Metric Key');
  });
});
