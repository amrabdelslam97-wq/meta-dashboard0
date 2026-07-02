'use strict';

const nock = require('nock');
const { metaGet, metaGetAll, fetchAdPreview, fetchCampaigns, fetchAdSets } = require('../../src/services/metaApiClient');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

describe('metaApiClient.metaGet', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('returns parsed JSON on a successful request', async () => {
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true)
      .reply(200, { data: [{ id: 'camp_1', name: 'Test Campaign' }] });

    const result = await metaGet('act_123/campaigns', {}, 'fake-token');
    expect(result.data[0].id).toBe('camp_1');
  });

  test('throws a descriptive isMetaError on a non-rate-limit Meta error (e.g. invalid token)', async () => {
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true)
      .reply(400, { error: { message: 'Invalid OAuth access token', code: 190, type: 'OAuthException' } });

    await expect(metaGet('act_123/campaigns', {}, 'bad-token')).rejects.toMatchObject({
      isMetaError: true,
      code: 190,
      type: 'OAuthException',
      message: 'Invalid OAuth access token',
    });
  });

  // These exercise the real BASE_RETRY_DELAY_MS backoff (5s/10s/20s) with
  // real timers rather than Jest fake timers -- fake timers fake
  // setImmediate/nextTick globally by default, which axios/nock's
  // internal socket plumbing depends on to ever resolve, making the
  // retried request hang forever instead of completing. Real timers cost
  // wall-clock time here but are the only combination that reliably
  // exercises the actual retry code path end-to-end.
  test('retries on HTTP 429 with exponential backoff and eventually succeeds', async () => {
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true).reply(429, { error: { message: 'Too many requests' } });
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true).reply(200, { data: [{ id: 'camp_ok' }] });

    const result = await metaGet('act_123/campaigns', {}, 'token');
    expect(result.data[0].id).toBe('camp_ok');
  }, 15000);

  // Regression test: Meta's real rate-limit errors frequently arrive as
  // HTTP 400 with error.code 4/17/32/613 (or 80000-80014), not HTTP 429.
  // Before this fix only HTTP 429 triggered a retry, so these far more
  // common real-world throttling responses were treated as hard failures.
  test('retries on a Meta rate-limit error code delivered via HTTP 400 (not just HTTP 429)', async () => {
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true)
      .reply(400, { error: { message: 'User request limit reached', code: 17 } });
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true)
      .reply(200, { data: [{ id: 'camp_after_throttle' }] });

    const result = await metaGet('act_123/campaigns', {}, 'token');
    expect(result.data[0].id).toBe('camp_after_throttle');
  }, 15000);

  test('retries on an ads-insights rate-limit code in the 80000-80014 range', async () => {
    nock(BASE).get(`/${VERSION}/act_123/insights`).query(true)
      .reply(400, { error: { message: 'Ad account rate limit', code: 80004 } });
    nock(BASE).get(`/${VERSION}/act_123/insights`).query(true)
      .reply(200, { data: [{ spend: '10' }] });

    const result = await metaGet('act_123/insights', {}, 'token');
    expect(result.data[0].spend).toBe('10');
  }, 15000);

  test('gives up after MAX_RETRIES exhausted and throws the rate-limit error', async () => {
    // 1 initial attempt + 3 retries = 4 total rate-limited responses
    for (let i = 0; i < 4; i++) {
      nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true)
        .reply(429, { error: { message: 'Still rate limited' } });
    }

    await expect(metaGet('act_123/campaigns', {}, 'token'))
      .rejects.toMatchObject({ isMetaError: true, isRateLimit: true });
  }, 45000);
});

describe('metaApiClient.metaGetAll pagination', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('follows paging.next (not just cursors.after) across multiple pages', async () => {
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true).reply(200, {
      data: [{ id: 'camp_1' }],
      paging: { cursors: { after: 'CURSOR1' }, next: `${BASE}/${VERSION}/act_123/campaigns?after=CURSOR1` },
    });
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(q => q.after === 'CURSOR1').reply(200, {
      data: [{ id: 'camp_2' }],
      // No paging.next on the last page -- loop must stop here.
      paging: { cursors: { after: 'CURSOR2' } },
    });

    const items = await metaGetAll('act_123/campaigns', {}, 'token');
    expect(items.map(i => i.id)).toEqual(['camp_1', 'camp_2']);
    expect(items.incomplete).toBe(false);
  });

  test('stops when paging.next is absent even if cursors.after is present (Meta guidance)', async () => {
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true).reply(200, {
      data: [{ id: 'camp_only' }],
      // cursors.after present but no paging.next -- must NOT fetch another page.
      paging: { cursors: { after: 'SOME_CURSOR' } },
    });

    const items = await metaGetAll('act_123/campaigns', {}, 'token');
    expect(items.map(i => i.id)).toEqual(['camp_only']);
  });

  test('marks the result incomplete when a subsequent page fetch fails', async () => {
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true).reply(200, {
      data: [{ id: 'camp_1' }],
      paging: { cursors: {}, next: `${BASE}/${VERSION}/act_123/campaigns?after=BROKEN` },
    });
    // The follow-up GET to the literal next URL fails.
    nock(BASE).get(`/${VERSION}/act_123/campaigns`).query({ after: 'BROKEN' }).reply(500, {});

    const items = await metaGetAll('act_123/campaigns', {}, 'token');
    expect(items.map(i => i.id)).toEqual(['camp_1']);
    expect(items.incomplete).toBe(true);
    expect(items.incompleteReason).toBe('page_fetch_error');
  });
});

describe('metaApiClient.fetchAdPreview', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('extracts the iframe src URL from the real Ad Previews HTML response shape', async () => {
    // Meta HTML-encodes the query-string separator between the first and
    // subsequent params as "&amp;" -- fetchAdPreview must decode it back
    // to a literal "&" so the extracted URL is actually usable.
    nock(BASE).get(`/${VERSION}/ad_123/previews`).query(true).reply(200, {
      data: [{ body: '<iframe src="https://www.facebook.com/ads/preview/abc123?width=500&amp;height=500" width="500" height="500"></iframe>' }],
    });

    const previewUrl = await fetchAdPreview('ad_123', 'token');
    expect(previewUrl).toBe('https://www.facebook.com/ads/preview/abc123?width=500&height=500');
  });

  test('returns null when the response has no usable body (does not fabricate a URL)', async () => {
    nock(BASE).get(`/${VERSION}/ad_123/previews`).query(true).reply(200, { data: [] });
    const previewUrl = await fetchAdPreview('ad_123', 'token');
    expect(previewUrl).toBeNull();
  });
});

describe('metaApiClient.fetchCampaigns', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('requests the documented campaign fields and returns raw Meta objects', async () => {
    const scope = nock(BASE).get(`/${VERSION}/act_123/campaigns`)
      .query(q => q.fields === 'id,name,objective,status,created_time,updated_time')
      .reply(200, { data: [{ id: 'camp_1', name: 'X', objective: 'OUTCOME_LEADS', status: 'ACTIVE' }] });

    const campaigns = await fetchCampaigns('act_123', 'token');
    expect(scope.isDone()).toBe(true);
    expect(campaigns[0].objective).toBe('OUTCOME_LEADS');
  });
});

describe('metaApiClient.fetchAdSets', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  // Regression test: optimization_goal must be explicitly requested --
  // Meta does not include ad-set-identifying/context fields automatically
  // just because a request is scoped to an ad set (confirmed against a
  // real Insights response during a related fix -- the same is true here
  // for the ad set object's own fields, not just Insights rows).
  test('requests optimization_goal alongside the existing ad set fields', async () => {
    const scope = nock(BASE).get(`/${VERSION}/camp_1/adsets`)
      .query(q => q.fields.includes('optimization_goal'))
      .reply(200, { data: [{ id: 'adset_1', name: 'Video AdSet', status: 'ACTIVE', optimization_goal: 'THRUPLAY' }] });

    const adSets = await fetchAdSets('camp_1', 'token');
    expect(scope.isDone()).toBe(true);
    expect(adSets[0].optimization_goal).toBe('THRUPLAY');
  });
});
