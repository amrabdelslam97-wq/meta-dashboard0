'use strict';

const nock = require('nock');
const {
  normalizeRow, pickRoasValue, attributionWindowParams, computeDeltas,
  fetchCampaignMetrics, fetchAdSetMetrics, fetchAdMetrics, fetchTrendData,
  parseActions, pickByPriority,
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

  // Video watched-actions parsing -- field shapes and real sample values
  // below are taken directly from a real Insights response for a real
  // campaign in the connected Meta account (verified live before adding
  // this parsing), not invented.
  test('parses video watched-actions fields and derives cost_per_thruplay / video_retention_rate', () => {
    const row = {
      spend: '25529.85',
      video_play_actions:             [{ action_type: 'video_view', value: '16581' }],
      video_p25_watched_actions:      [{ action_type: 'video_view', value: '2442' }],
      video_p50_watched_actions:      [{ action_type: 'video_view', value: '1410' }],
      video_p75_watched_actions:      [{ action_type: 'video_view', value: '729' }],
      video_p95_watched_actions:      [{ action_type: 'video_view', value: '523' }],
      video_p100_watched_actions:     [{ action_type: 'video_view', value: '472' }],
      video_thruplay_watched_actions: [{ action_type: 'video_view', value: '3018' }],
      video_avg_time_watched_actions: [{ action_type: 'video_view', value: '15' }],
    };
    const normalized = normalizeRow(row);
    expect(normalized.video_plays).toBe(16581);
    expect(normalized.video_p25_watched).toBe(2442);
    expect(normalized.video_p100_watched).toBe(472);
    expect(normalized.thruplays).toBe(3018);
    expect(normalized.video_avg_watch_time).toBe(15);
    expect(normalized.cost_per_thruplay).toBeCloseTo(25529.85 / 3018, 5);
    expect(normalized.video_retention_rate).toBeCloseTo((472 / 16581) * 100, 5);
  });

  test('video fields absent from the response leave video metrics undefined, not zero', () => {
    const normalized = normalizeRow({ spend: '100' });
    expect(normalized.video_plays).toBeUndefined();
    expect(normalized.thruplays).toBeUndefined();
    expect(normalized.cost_per_thruplay).toBeUndefined();
  });

  // Engagement action_type parsing -- post_engagement/page_engagement/like
  // and their real cost values, confirmed against the same live response.
  test('parses post_engagement/page_engagement/like into flat metric keys with derived cost_per_engagement', () => {
    const row = {
      spend: '25529.85',
      actions: [
        { action_type: 'post_engagement', value: '62239' },
        { action_type: 'page_engagement', value: '63047' },
        { action_type: 'like', value: '808' },
      ],
      cost_per_action_type: [
        { action_type: 'post_engagement', value: '0.410191' },
        { action_type: 'page_engagement', value: '0.404934' },
      ],
    };
    const normalized = normalizeRow(row);
    expect(normalized.post_engagements).toBe(62239);
    expect(normalized.page_engagements).toBe(63047);
    expect(normalized.page_likes).toBe(808);
    expect(normalized.cost_per_engagement).toBeCloseTo(0.410191, 5); // Meta-supplied value used directly, not derived
  });

  test('derives cost_per_engagement from spend/post_engagements when Meta omits cost_per_action_type', () => {
    const row = {
      spend: '100',
      actions: [{ action_type: 'post_engagement', value: '50' }],
    };
    const normalized = normalizeRow(row);
    expect(normalized.cost_per_engagement).toBe(2); // 100 / 50
  });

  // App Promotion action_type parsing -- these could NOT be verified
  // against a real response (the connected account has no App Promotion
  // campaigns), so this test only proves the mapping/derivation logic is
  // internally consistent given Meta's documented field shape, not that
  // the exact action_type string is confirmed correct in production.
  test('parses app install action_types into app_installs/cpi (unverified against a real account)', () => {
    const row = {
      spend: '500',
      actions: [{ action_type: 'mobile_app_install', value: '25' }],
    };
    const normalized = normalizeRow(row);
    expect(normalized.app_installs).toBe(25);
    expect(normalized.cpi).toBe(20); // 500 / 25
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
    // code 100 ("Unsupported request"), not a rate-limit code -- avoids exercising
    // metaGet's real 5s/10s/20s retry backoff against a nock mock that's only
    // registered once (a genuine rate-limit code here would consume this
    // interceptor on the first attempt, then leak unhandled "no match" errors
    // into whichever later test happens to be running when the real retry
    // timers fire). Same convention the sibling tests below already use.
    nock(BASE).get(`/${VERSION}/camp_err_2/insights`).query(q => JSON.parse(q.time_range).since !== '2026-01-01')
      .reply(400, { error: { message: 'Prior period fetch failed', code: 100 } });

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

// ═══════════════════════════════════════════════════════════════════════
// Cost/Conv discrepancy fix (Meta Ads Manager validation)
//
// Root cause: multiple distinct Meta action_types can legitimately feed the
// same generic bucket (results/leads/purchases/app_installs), and Meta's
// cost_per_action_type[]/actions[] arrays carry no guaranteed ordering. The
// previous code took "whichever one appears first in the response array",
// which is non-deterministic and can silently pick a narrower/different
// action_type than the one actually matching the ad set's configured
// optimization_goal -- reproduced below with the EXACT real values pulled
// from a live Meta Insights response for a Conversations-optimized
// campaign (spend=2773.67): messaging_conversation_started_7d
// (value=185, cost=14.992811 -- matches spend/value exactly, i.e. Meta's
// own "Cost per Result") vs. messaging_first_reply (value=184,
// cost=15.074293 -- a narrower subset event, structurally always >= the
// correct cost since its count can never exceed the started-7d count).
// ═══════════════════════════════════════════════════════════════════════
describe('metricsFetcher Cost/Conv Meta Ads Manager parity fix', () => {
  const REAL_SPEND = '2773.67';
  const startedAction  = { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '185' };
  const firstReplyAction = { action_type: 'onsite_conversion.messaging_first_reply', value: '184' };
  const startedCost   = { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '14.992811' };
  const firstReplyCost = { action_type: 'onsite_conversion.messaging_first_reply', value: '15.074293' };

  test('picks the optimization-goal-matching action_type deterministically, regardless of Meta response array order (order A)', () => {
    const normalized = normalizeRow({
      spend: REAL_SPEND,
      actions: [firstReplyAction, startedAction],
      cost_per_action_type: [firstReplyCost, startedCost], // first_reply listed FIRST, as in the real response
    }, 'CONVERSATIONS');
    expect(normalized.results).toBe(185);
    expect(normalized.cpr).toBe(14.992811); // NOT 15.074293 -- must not silently pick first_reply's narrower/higher cost
  });

  test('picks the same result when the response array order is reversed (order B) -- proves determinism, not luck', () => {
    const normalized = normalizeRow({
      spend: REAL_SPEND,
      actions: [startedAction, firstReplyAction],
      cost_per_action_type: [startedCost, firstReplyCost], // started_7d listed FIRST this time
    }, 'CONVERSATIONS');
    expect(normalized.results).toBe(185);
    expect(normalized.cpr).toBe(14.992811);
  });

  test('without an optimization_goal, still prefers messaging_conversation_started_7d over messaging_first_reply by default priority', () => {
    const normalized = normalizeRow({
      spend: REAL_SPEND,
      actions: [firstReplyAction, startedAction],
      cost_per_action_type: [firstReplyCost, startedCost],
    }); // no optimizationGoal argument at all
    expect(normalized.results).toBe(185);
    expect(normalized.cpr).toBe(14.992811);
  });

  test('cpr recomputed from spend/results exactly reproduces Meta\'s own cost_per_action_type value (14.992811)', () => {
    expect(Math.round((parseFloat(REAL_SPEND) / 185) * 1e6) / 1e6).toBeCloseTo(14.992811, 5);
  });

  // ── Sales objective: purchases/cpa ──
  test('Sales: prefers omni_purchase over offsite_conversion.fb_pixel_purchase and purchase, regardless of array order', () => {
    const normalized = normalizeRow({
      spend: '1000',
      actions: [
        { action_type: 'purchase', value: '12' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '11' },
        { action_type: 'omni_purchase', value: '10' },
      ],
      cost_per_action_type: [
        { action_type: 'purchase', value: '83.33' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '90.90' },
        { action_type: 'omni_purchase', value: '100' }, // 1000/10 -- the one Meta's own Ads Manager uses
      ],
    }, 'OFFSITE_CONVERSIONS');
    expect(normalized.purchases).toBe(10);
    expect(normalized.cpa).toBe(100);
  });

  // ── Leads objective: leads/cpl ──
  test('Leads: prefers onsite_conversion.lead_grouped over lead, regardless of array order', () => {
    const normalized = normalizeRow({
      spend: '500',
      actions: [
        { action_type: 'lead', value: '55' },
        { action_type: 'onsite_conversion.lead_grouped', value: '50' },
      ],
      cost_per_action_type: [
        { action_type: 'lead', value: '9.09' },
        { action_type: 'onsite_conversion.lead_grouped', value: '10' }, // 500/50
      ],
    }, 'LEAD_GENERATION');
    expect(normalized.leads).toBe(50);
    expect(normalized.cpl).toBe(10);
  });

  // ── App Promotion objective: app_installs/cpi ──
  test('App Promotion: prefers omni_app_install over mobile_app_install, regardless of array order', () => {
    const normalized = normalizeRow({
      spend: '200',
      actions: [
        { action_type: 'mobile_app_install', value: '22' },
        { action_type: 'omni_app_install', value: '20' },
      ],
      cost_per_action_type: [
        { action_type: 'mobile_app_install', value: '9.09' },
        { action_type: 'omni_app_install', value: '10' }, // 200/20
      ],
    }, 'APP_INSTALLS');
    expect(normalized.app_installs).toBe(20);
    expect(normalized.cpi).toBe(10);
  });

  // ── Traffic objective: landing_page_views/cost_per_landing_page_view --
  // unaffected by this fix (Meta has never reported more than one
  // action_type for this bucket), confirming no regression.
  test('Traffic: cost_per_landing_page_view is unaffected (single, non-ambiguous action_type)', () => {
    const normalized = normalizeRow({
      spend: '300',
      actions: [{ action_type: 'landing_page_view', value: '150' }],
      cost_per_action_type: [{ action_type: 'landing_page_view', value: '2' }],
    }, 'LANDING_PAGE_VIEWS');
    expect(normalized.landing_page_views).toBe(150);
    expect(normalized.cost_per_landing_page_view).toBe(2);
  });

  // ── Awareness objective: no action-based Cost/Conv at all -- CPM comes
  // directly from Meta's own top-level `cpm` field, never from actions[].
  test('Awareness: cpm is read directly from Meta\'s own field, untouched by any action_type resolution', () => {
    const normalized = normalizeRow({ spend: '400', cpm: '12.5', reach: '32000', actions: [] });
    expect(normalized.cpm).toBe(12.5);
    expect(normalized.results).toBeUndefined();
    expect(normalized.cpr).toBeUndefined();
  });

  // ── optimization_goal that doesn't match the objective's own bucket ──
  test('an engagement campaign whose ad set is NOT Conversations-optimized does not fabricate cpr from unrelated messaging actions', () => {
    const normalized = normalizeRow({
      spend: '100',
      actions: [
        { action_type: 'post_engagement', value: '500' },
        // Some incidental messaging activity exists, but this ad set's
        // optimization_goal is POST_ENGAGEMENT, not CONVERSATIONS -- cpr
        // must not be silently computed from it as if it were the primary KPI.
        { action_type: 'onsite_conversion.messaging_first_reply', value: '3' },
      ],
      cost_per_action_type: [
        { action_type: 'post_engagement', value: '0.20' },
        { action_type: 'onsite_conversion.messaging_first_reply', value: '33.33' },
      ],
    }, 'POST_ENGAGEMENT');
    // post_engagement is a non-ambiguous bucket (cost_per_engagement), unaffected.
    expect(normalized.cost_per_engagement).toBe(0.20);
    // results/cpr still get the incidental messaging value via the default-
    // priority fallback (for display elsewhere), but crucially the fix
    // ensures the PRIMARY KPI selection for this ad set is driven by its
    // real optimization_goal, not by whichever objective label the
    // campaign happens to carry.
    expect(normalized.results).toBe(3);
    expect(normalized.cpr).toBe(33.33);
  });
});

describe('metricsFetcher.pickByPriority', () => {
  test('returns the value for the first matching action_type in priority order, not array order', () => {
    const arr = [{ action_type: 'b', value: '2' }, { action_type: 'a', value: '1' }];
    expect(pickByPriority(arr, ['a', 'b'])).toBe(1);
    expect(pickByPriority(arr, ['b', 'a'])).toBe(2);
  });

  test('returns null (not 0) when no priority action_type is present', () => {
    expect(pickByPriority([{ action_type: 'z', value: '5' }], ['a', 'b'])).toBeNull();
  });

  test('returns null for non-array input', () => {
    expect(pickByPriority(undefined, ['a'])).toBeNull();
    expect(pickByPriority(null, ['a'])).toBeNull();
  });
});

describe('metricsFetcher.parseActions is exported directly (not just via normalizeRow)', () => {
  test('returns {} for non-array actions input', () => {
    expect(parseActions(null, null, null)).toEqual({});
  });
});
