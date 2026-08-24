'use strict';

const nock = require('nock');
const { metaGet, metaGetAll, fetchAdPreview, fetchCampaigns, fetchAdSets, fetchCustomAudiences } = require('../../src/services/metaApiClient');

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

  // ═══════════════════════════════════════════════════════════════════
  // Force Sync Deadline Propagation fix (FORCE_SYNC_END_TO_END_VERIFICATION_
  // REPORT.md): a real production Force Sync for a 173-campaign account
  // (needing 2 pages at Meta's 100-per-page limit) timed out at Vercel's
  // 60s hard kill AFTER the request-wide deadline fix from the previous
  // mission -- because that fix only checked the deadline between
  // syncAccount()'s own high-level awaited calls, never inside
  // metaGetAll()'s own pagination loop. These tests prove the deadline now
  // reaches that layer.
  // ═══════════════════════════════════════════════════════════════════
  describe('deadline propagation (Force Sync Deadline Propagation fix)', () => {
    test('stops requesting further pages once the deadline is reached, without throwing, marking the result incomplete', async () => {
      nock(BASE).get(`/${VERSION}/act_173/campaigns`).query(true).reply(200, {
        data: [{ id: 'camp_page1' }],
        paging: { cursors: { after: 'CURSOR1' }, next: `${BASE}/${VERSION}/act_173/campaigns?after=CURSOR1` },
      });
      // Page 2 deliberately NOT mocked -- proves it's genuinely never requested.

      const deadlineAt = Date.now() - 1; // already in the past
      const items = await metaGetAll('act_173/campaigns', {}, 'token', deadlineAt);

      expect(items.map(i => i.id)).toEqual(['camp_page1']);
      expect(items.incomplete).toBe(true);
      expect(items.incompleteReason).toBe('deadline_exceeded');
    });

    test('a 173-campaign account spanning two 100-item pages: both pages fetched when the deadline is comfortable', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `camp_${i + 1}` }));
      const page2 = Array.from({ length: 73 }, (_, i) => ({ id: `camp_${i + 101}` }));
      nock(BASE).get(`/${VERSION}/act_173/campaigns`).query(true).reply(200, {
        data: page1,
        paging: { cursors: { after: 'CURSOR1' }, next: `${BASE}/${VERSION}/act_173/campaigns?after=CURSOR1` },
      });
      nock(BASE).get(`/${VERSION}/act_173/campaigns`).query(q => q.after === 'CURSOR1').reply(200, {
        data: page2,
        paging: { cursors: { after: 'CURSOR2' } },
      });

      const deadlineAt = Date.now() + 60_000; // generous
      const items = await metaGetAll('act_173/campaigns', {}, 'token', deadlineAt);

      expect(items.length).toBe(173);
      expect(items.incomplete).toBe(false);
    });

    test('a 173-campaign account interrupted between page 1 and page 2: page 1 data is preserved, page 2 never requested', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `camp_${i + 1}` }));
      nock(BASE).get(`/${VERSION}/act_173/campaigns`).query(true).reply(200, {
        data: page1,
        paging: { cursors: { after: 'CURSOR1' }, next: `${BASE}/${VERSION}/act_173/campaigns?after=CURSOR1` },
      });
      // Page 2 (the remaining 73) deliberately NOT mocked.

      // Deterministic, not a race: the first page is always fetched
      // unconditionally regardless of deadlineAt (see metaGetAll()'s own
      // header comment -- there must be at least SOME data to make
      // progress/resume from), so an already-past deadline still reliably
      // demonstrates "page 1 succeeds, page 2 is never attempted" without
      // depending on exact timing between two async operations.
      const deadlineAt = Date.now() - 1;
      const items = await metaGetAll('act_173/campaigns', {}, 'token', deadlineAt);

      // Page 1's 100 items are NOT lost -- this is the core semantic
      // requirement (never discard already-fetched data merely because the
      // deadline was reached).
      expect(items.length).toBe(100);
      expect(items.incomplete).toBe(true);
      expect(items.incompleteReason).toBe('deadline_exceeded');
    }, 10_000);

    test('does not retry a rate-limited page fetch if the deadline would be exceeded before the backoff completes', async () => {
      nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true)
        .reply(400, { error: { message: 'User request limit reached', code: 17 } });
      // No successful-retry mock registered -- proves no retry is attempted.

      const deadlineAt = Date.now() + 1000; // far less than the 5s minimum backoff
      await expect(metaGet('act_123/campaigns', {}, 'token', 0, deadlineAt)).rejects.toMatchObject({
        isRateLimit: true,
        deadlineExceeded: true,
      });
    });

    test('still retries normally when the deadline comfortably covers the backoff', async () => {
      nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true).reply(429, { error: { message: 'Too many requests' } });
      nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true).reply(200, { data: [{ id: 'camp_ok' }] });

      const deadlineAt = Date.now() + 60_000;
      const result = await metaGet('act_123/campaigns', {}, 'token', 0, deadlineAt);
      expect(result.data[0].id).toBe('camp_ok');
    }, 15_000);

    test('omitting deadlineAt entirely preserves all existing behavior (backward compatible)', async () => {
      nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(true).reply(200, {
        data: [{ id: 'camp_1' }],
        paging: { cursors: { after: 'CURSOR1' }, next: `${BASE}/${VERSION}/act_123/campaigns?after=CURSOR1` },
      });
      nock(BASE).get(`/${VERSION}/act_123/campaigns`).query(q => q.after === 'CURSOR1').reply(200, {
        data: [{ id: 'camp_2' }],
        paging: { cursors: { after: 'CURSOR2' } },
      });

      const items = await metaGetAll('act_123/campaigns', {}, 'token'); // no deadlineAt at all
      expect(items.map(i => i.id)).toEqual(['camp_1', 'camp_2']);
      expect(items.incomplete).toBe(false);
    });
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

  test('requests the documented campaign fields (including effective_status) and returns raw Meta objects', async () => {
    const scope = nock(BASE).get(`/${VERSION}/act_123/campaigns`)
      .query(q => q.fields === 'id,name,objective,status,effective_status,created_time,updated_time')
      .reply(200, { data: [{ id: 'camp_1', name: 'X', objective: 'OUTCOME_LEADS', status: 'ACTIVE', effective_status: 'ACTIVE' }] });

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

  // Attribution & Customer Journey Intelligence (Step 9): requests targeting
  // sub-fields at one level only, never `field{subfield}` on an inner field
  // -- the exact shape of a real bug found and fixed in
  // fetchAdCreativeDetail()'s asset_feed_spec{id} request.
  test('requests audience-targeting fields (custom_audiences, lookalike_spec, flexible_spec, geo_locations, targeting_automation) at one nesting level', async () => {
    const scope = nock(BASE).get(`/${VERSION}/camp_1/adsets`)
      .query(q => q.fields.includes('custom_audiences') && q.fields.includes('lookalike_spec')
        && q.fields.includes('flexible_spec') && q.fields.includes('geo_locations') && q.fields.includes('targeting_automation')
        && !q.fields.includes('custom_audiences{') && !q.fields.includes('targeting_automation{'))
      .reply(200, { data: [{ id: 'adset_1', name: 'AdSet', status: 'ACTIVE', targeting: { custom_audiences: [{ id: 'aud_1' }] } }] });

    const adSets = await fetchAdSets('camp_1', 'token');
    expect(scope.isDone()).toBe(true);
    expect(adSets[0].targeting.custom_audiences).toEqual([{ id: 'aud_1' }]);
  });
});

describe('metaApiClient.fetchCustomAudiences', () => {
  afterEach(() => { nock.cleanAll(); });

  test('fetches every custom audience on an account with its real subtype', async () => {
    const scope = nock(BASE).get(`/${VERSION}/act_1/customaudiences`)
      .query(q => q.fields === 'id,name,subtype')
      .reply(200, { data: [
        { id: 'aud_1', name: 'Website Visitors 30d', subtype: 'WEBSITE' },
        { id: 'aud_2', name: 'Lookalike 1% US', subtype: 'LOOKALIKE' },
      ] });

    const audiences = await fetchCustomAudiences('act_1', 'token');
    expect(scope.isDone()).toBe(true);
    expect(audiences.map(a => ({ id: a.id, name: a.name, subtype: a.subtype }))).toEqual([
      { id: 'aud_1', name: 'Website Visitors 30d', subtype: 'WEBSITE' },
      { id: 'aud_2', name: 'Lookalike 1% US', subtype: 'LOOKALIKE' },
    ]);
  });
});
