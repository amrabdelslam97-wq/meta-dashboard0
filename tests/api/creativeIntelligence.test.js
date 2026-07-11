'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');
const { encryptToken } = require('../../src/services/tokenCrypto');
const { computeCreativeScore } = require('../../src/services/creativeIntelligenceEngine');

describe('API: /api/v1/creative-intelligence', () => {
  let testDb, app, accountId, campaignId, campaignMetaId, adSetId, adSetMetaId, adId;
  const range = { since: '2026-05-01', until: '2026-05-07' };

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, attribution_window_days, created_at, updated_at)
       VALUES (?, 'act_ci_api', 'Creative Intelligence API Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
      [accountId, encryptToken('fake-token')]
    );

    campaignId = uuidv4();
    campaignMetaId = 'camp_ci_api_1';
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Creative Intelligence API Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId, campaignMetaId]
    );

    adSetId = uuidv4();
    adSetMetaId = 'adset_ci_api_1';
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'CI API Ad Set', 'active', datetime('now'), datetime('now'))`,
      [adSetId, campaignId, accountId, adSetMetaId]
    );

    adId = uuidv4();
    testDb.db.run(
      `INSERT INTO ads (id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ad_ci_api_winner', 'CI API Winner Ad', 'active', datetime('now'), datetime('now'))`,
      [adId, adSetId, campaignId, accountId]
    );
    const loserAdId = uuidv4();
    testDb.db.run(
      `INSERT INTO ads (id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ad_ci_api_loser', 'CI API Loser Ad', 'active', datetime('now'), datetime('now'))`,
      [loserAdId, adSetId, campaignId, accountId]
    );

    const winnerCreative = {
      headline: 'Save 30% Today', primary_text: 'Tired of overpaying? Save big. Trusted by thousands.',
      description: 'Free shipping.', cta_type: 'SHOP_NOW', media_type: 'image',
      spend: 100, results: 10, ctr: 2.5, cost_per_result: 10, video_p25_pct: 80, video_p50_pct: 60, video_p75_pct: 40, video_p95_pct: 20, video_p100_pct: 10,
    };
    const winnerScored = computeCreativeScore(winnerCreative, { status: 'none' });
    testDb.db.run(
      `INSERT INTO creative_analytics
         (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_type, headline, cta_type,
          date_since, date_until, spend, results, ctr, roas, cpa, impressions, link_clicks, landing_page_views,
          video_p25_pct, video_p50_pct, video_p75_pct, video_p95_pct, video_p100_pct,
          score_overall, score_hook, score_cta, ai_analysis_json, fatigue_status, fatigue_recommendation, calculated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [uuidv4(), accountId, 'ad_ci_api_winner', adSetMetaId, campaignMetaId, 'video', winnerCreative.headline, winnerCreative.cta_type,
        range.since, range.until, 100, 10, 2.5, 3.2, 10, 1000, 200, 150,
        80, 60, 40, 20, 10,
        winnerScored.score_overall, winnerScored.score_hook, winnerScored.score_cta,
        JSON.stringify(winnerScored.text_analysis), 'none', null]
    );

    const loserCreative = { headline: 'Buy Stuff', primary_text: null, description: null, cta_type: 'LEARN_MORE', media_type: 'image', spend: 100, results: 1, ctr: 0.4, cost_per_result: 100 };
    const loserScored = computeCreativeScore(loserCreative, { status: 'severe' });
    testDb.db.run(
      `INSERT INTO creative_analytics
         (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_type, headline, cta_type,
          date_since, date_until, spend, results, ctr, roas, cpa, impressions, link_clicks, landing_page_views,
          score_overall, score_hook, score_cta, ai_analysis_json, fatigue_status, fatigue_recommendation, calculated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [uuidv4(), accountId, 'ad_ci_api_loser', adSetMetaId, campaignMetaId, 'image', loserCreative.headline, loserCreative.cta_type,
        range.since, range.until, 100, 1, 0.4, 0.5, 100, 500, 20, 5,
        loserScored.score_overall, loserScored.score_hook, loserScored.score_cta,
        JSON.stringify(loserScored.text_analysis), 'severe', 'pause']
    );
  });

  afterAll(() => { testDb.cleanup(); });

  const q = `?since=${range.since}&until=${range.until}`;

  describe('GET /library', () => {
    test('returns both creatives with winner/loser roles flagged', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/library${q}&campaign_id=${campaignId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      const winner = res.body.data.creatives.find(c => c.meta_ad_id === 'ad_ci_api_winner');
      const loser = res.body.data.creatives.find(c => c.meta_ad_id === 'ad_ci_api_loser');
      expect(winner.library_role).toBe('winner');
      expect(loser.library_role).toBe('loser');
    });

    test('filters by min_score and fatigue_status', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/library${q}&campaign_id=${campaignId}&fatigue_status=severe`);
      expect(res.status).toBe(200);
      expect(res.body.data.creatives.map(c => c.meta_ad_id)).toEqual(['ad_ci_api_loser']);
    });

    test('reports the language filter as an honest warning, not silently ignored', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/library${q}&campaign_id=${campaignId}&language=en`);
      expect(res.status).toBe(200);
      expect(res.body.data.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('GET /adset/:adsetId/comparison', () => {
    test('returns winner/worst for the ad set', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/adset/${adSetId}/comparison${q}`);
      expect(res.status).toBe(200);
      expect(res.body.data.winner.meta_ad_id).toBe('ad_ci_api_winner');
      expect(res.body.data.worst.meta_ad_id).toBe('ad_ci_api_loser');
    });

    test('404s for an unknown ad set', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/adset/does-not-exist/comparison${q}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /charts/:campaignId', () => {
    test('score_distribution buckets both creatives', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/charts/${campaignId}${q}&type=score_distribution`);
      expect(res.status).toBe(200);
      expect(res.body.data.type).toBe('bar');
      expect(res.body.data.data.reduce((a, b) => a + b, 0)).toBe(2);
    });

    test('ctr_by_creative returns one bar per creative', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/charts/${campaignId}${q}&type=ctr_by_creative`);
      expect(res.status).toBe(200);
      expect(res.body.data.labels.length).toBe(2);
    });

    test('retention_curve requires ad_id and returns real watch-percentage checkpoints', async () => {
      const missing = await request(app).get(`/api/v1/creative-intelligence/charts/${campaignId}${q}&type=retention_curve`);
      expect(missing.status).toBe(400);

      const res = await request(app).get(`/api/v1/creative-intelligence/charts/${campaignId}${q}&type=retention_curve&ad_id=ad_ci_api_winner`);
      expect(res.status).toBe(200);
      expect(res.body.data.type).toBe('retention_curve');
      expect(res.body.data.data).toEqual([80, 60, 40, 20, 10]);
    });

    test('ranking requires adset_id and returns the ordered ad set ranking', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/charts/${campaignId}${q}&type=ranking&adset_id=${adSetId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.type).toBe('ranking');
      expect(res.body.data.items[0].label).toBe('CI API Winner Ad');
    });

    test('funnel sums impressions/clicks/landing-page-views/results across creatives', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/charts/${campaignId}${q}&type=funnel`);
      expect(res.status).toBe(200);
      expect(res.body.data.stages.map(s => s.label)).toEqual(['Impressions', 'Link Clicks', 'Landing Page Views', 'Results']);
      expect(res.body.data.stages[0].value).toBe(1500); // 1000 + 500
    });

    test('rejects an unsupported chart type', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/charts/${campaignId}${q}&type=not_a_real_type`);
      expect(res.status).toBe(400);
      expect(res.body.valid_types).toContain('score_distribution');
    });

    test('404s for an unknown campaign', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/charts/does-not-exist${q}&type=score_distribution`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /:adId', () => {
    test('returns the full Creative Details bundle using mock ad intelligence', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/${adId}?mock=true`);
      expect(res.status).toBe(200);
      expect(res.body.data.analyzed).toBe(true);
      expect(res.body.data.snapshot.meta_ad_id).toBe('ad_ci_api_winner');
      expect(res.body.data.comparison.winner.meta_ad_id).toBe('ad_ci_api_winner');
      expect(res.body.data.intelligence).toBeDefined();
      expect(typeof res.body.data.executive_summary).toBe('string');
    });

    test('404s for an unknown ad', async () => {
      const res = await request(app).get('/api/v1/creative-intelligence/does-not-exist?mock=true');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /:adId/timeline', () => {
    test('returns the timeline for a known ad', async () => {
      const res = await request(app).get(`/api/v1/creative-intelligence/${adId}/timeline`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('insufficient_data');
      expect(res.body.data.events[0].type).toBe('launch');
    });

    test('404s for an unknown ad', async () => {
      const res = await request(app).get('/api/v1/creative-intelligence/does-not-exist/timeline');
      expect(res.status).toBe(404);
    });
  });
});
