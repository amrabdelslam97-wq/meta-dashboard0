'use strict';

const nock = require('nock');
const {
  normalizeRow, pickRoasValue, attributionWindowParams, computeDeltas,
  fetchCampaignMetrics, fetchAdSetMetrics, fetchAdMetrics, fetchTrendData,
} = require('../../src/services/metricsFetcher');
const cache = require('../../src/services/cacheService');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

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

// Regression tests for a production incident: a real Meta API failure
// (e.g. bad access token, invalid API version, rate limit) was being
// swallowed inside these functions and converted into an empty/null
// result indistinguishable from "Meta genuinely has no data for this
// period" -- masking the real cause everywhere downstream (insights.js's
// own error-surfacing catch block never ran because these functions never
// threw). The fix removes that swallowing; these tests lock in that a real
// API error now propagates as a real, informative exception.
describe('metricsFetcher error propagation (does not swallow real Meta API failures)', () => {
  afterEach(() => {
    nock.cleanAll();
    cache.flush();
  });

  test('fetchCampaignMetrics throws (with isMetaError/code intact) when the CURRENT period fetch fails', async () => {
    nock(BASE).get(`/${VERSION}/camp_err_1/insights`).query(true)
      .reply(400, { error: { message: 'Invalid OAuth access token', code: 190 } });

    await expect(
      fetchCampaignMetrics('camp_err_1', 'bad-token', { since: '2026-01-01', until: '2026-01-07' }, 7)
    ).rejects.toMatchObject({ isMetaError: true, code: 190, message: 'Invalid OAuth access token' });
  });

  test('fetchCampaignMetrics still gracefully degrades to prior:null when only the PRIOR period fetch fails', async () => {
    nock(BASE).get(`/${VERSION}/camp_err_2/insights`).query(q => JSON.parse(q.time_range).since === '2026-01-01')
      .reply(200, { data: [{ spend: '10', impressions: '100' }] });
    nock(BASE).get(`/${VERSION}/camp_err_2/insights`).query(q => JSON.parse(q.time_range).since !== '2026-01-01')
      .reply(400, { error: { message: 'Prior period rate limited', code: 4 } });

    const result = await fetchCampaignMetrics('camp_err_2', 'token', { since: '2026-01-01', until: '2026-01-07' }, 7);
    expect(result.current.spend).toBe(10);
    expect(result.prior).toBeNull();
  });

  test('fetchAdSetMetrics throws instead of silently returning [] on a real Meta error', async () => {
    nock(BASE).get(`/${VERSION}/camp_err_3/insights`).query(true)
      .reply(400, { error: { message: 'Unsupported request', code: 100 } }); // non-retryable code -- avoids exercising metaGet's rate-limit retry loop, which is covered elsewhere

    await expect(
      fetchAdSetMetrics('camp_err_3', 'token', '2026-01-01', '2026-01-07', 7)
    ).rejects.toMatchObject({ isMetaError: true, code: 100 });
  });

  test('fetchAdMetrics throws instead of silently returning [] on a real Meta error', async () => {
    nock(BASE).get(`/${VERSION}/camp_err_4/insights`).query(true)
      .reply(400, { error: { message: 'Unsupported request', code: 100 } }); // non-retryable code -- avoids exercising metaGet's rate-limit retry loop, which is covered elsewhere

    await expect(
      fetchAdMetrics('camp_err_4', 'token', '2026-01-01', '2026-01-07', 7)
    ).rejects.toMatchObject({ isMetaError: true, code: 100 });
  });

  test('fetchTrendData throws instead of silently returning [] on a real Meta error', async () => {
    nock(BASE).get(`/${VERSION}/camp_err_5/insights`).query(true)
      .reply(400, { error: { message: 'Unsupported request', code: 100 } }); // non-retryable code -- avoids exercising metaGet's rate-limit retry loop, which is covered elsewhere

    await expect(
      fetchTrendData('camp_err_5', 'token', '2026-01-01', '2026-01-07', 7)
    ).rejects.toMatchObject({ isMetaError: true, code: 100 });
  });
});

// Regression test for a second, independently-discovered bug: Meta does
// NOT automatically include adset_id/ad_id in an Insights response for
// level=adset/level=ad -- they must be requested explicitly like any other
// field. Without them, fetchAdSetMetrics/fetchAdMetrics could never
// attribute a row back to a specific ad set/ad (meta_adset_id/meta_ad_id
// would always be undefined), independent of the error-swallowing bug
// above -- confirmed against a real Meta Insights response before fixing.
describe('metricsFetcher requests entity-identifying fields for adset/ad level calls', () => {
  afterEach(() => {
    nock.cleanAll();
    cache.flush();
  });

  test('fetchAdSetMetrics requests adset_id and adset_name, and attributes rows correctly', async () => {
    const scope = nock(BASE).get(`/${VERSION}/camp_fields_1/insights`)
      .query(q => q.fields.includes('adset_id') && q.fields.includes('adset_name'))
      .reply(200, { data: [{ spend: '10', adset_id: 'adset_123', adset_name: 'Test AdSet' }] });

    const result = await fetchAdSetMetrics('camp_fields_1', 'token', '2026-01-01', '2026-01-07', 7);
    expect(scope.isDone()).toBe(true);
    expect(result[0].meta_adset_id).toBe('adset_123');
    expect(result[0].name).toBe('Test AdSet');
  });

  test('fetchAdMetrics requests ad_id, ad_name, and adset_id, and attributes rows correctly', async () => {
    const scope = nock(BASE).get(`/${VERSION}/camp_fields_2/insights`)
      .query(q => q.fields.includes('ad_id') && q.fields.includes('ad_name') && q.fields.includes('adset_id'))
      .reply(200, { data: [{ spend: '10', ad_id: 'ad_456', ad_name: 'Test Ad', adset_id: 'adset_123' }] });

    const result = await fetchAdMetrics('camp_fields_2', 'token', '2026-01-01', '2026-01-07', 7);
    expect(scope.isDone()).toBe(true);
    expect(result[0].meta_ad_id).toBe('ad_456');
    expect(result[0].name).toBe('Test Ad');
    expect(result[0].meta_adset_id).toBe('adset_123');
  });
});
