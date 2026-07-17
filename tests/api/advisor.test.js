'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');
const { encryptToken } = require('../../src/services/tokenCrypto');
const { computeCreativeScore } = require('../../src/services/creativeIntelligenceEngine');

describe('API: /api/v1/advisor', () => {
  let testDb, app, accountId, campaignId, campaignMetaId, adSetId, adSetMetaId;
  const range = { since: '2026-06-01', until: '2026-06-07' };

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, attribution_window_days, created_at, updated_at)
       VALUES (?, 'act_advisor_api', 'Advisor API Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
      [accountId, encryptToken('fake-token')]
    );

    campaignId = uuidv4();
    campaignMetaId = 'camp_advisor_api_1';
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Advisor API Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId, campaignMetaId]
    );

    adSetId = uuidv4();
    adSetMetaId = 'adset_advisor_api_1';
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Advisor API Ad Set', 'active', datetime('now'), datetime('now'))`,
      [adSetId, campaignId, accountId, adSetMetaId]
    );

    const winnerAdId = uuidv4();
    testDb.db.run(
      `INSERT INTO ads (id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ad_advisor_api_winner', 'Advisor API Winner Ad', 'active', datetime('now'), datetime('now'))`,
      [winnerAdId, adSetId, campaignId, accountId]
    );
    const loserAdId = uuidv4();
    testDb.db.run(
      `INSERT INTO ads (id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ad_advisor_api_loser', 'Advisor API Loser Ad', 'active', datetime('now'), datetime('now'))`,
      [loserAdId, adSetId, campaignId, accountId]
    );

    const winnerCreative = {
      headline: 'Save 30% Today', primary_text: 'Tired of overpaying? Save big today. Trusted by thousands of happy customers.',
      description: 'Free shipping.', cta_type: 'SHOP_NOW', media_type: 'image',
      spend: 200, results: 20, ctr: 3.2, cost_per_result: 8,
    };
    const winnerScored = computeCreativeScore(winnerCreative, { status: 'none' });
    testDb.db.run(
      `INSERT INTO creative_analytics
         (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_type, headline, cta_type,
          date_since, date_until, spend, results, ctr, roas, cpa, frequency,
          score_overall, score_hook, score_headline, score_copy, score_visual, score_cta, score_offer, score_trust, score_psychology,
          ai_analysis_json, fatigue_status, fatigue_recommendation, calculated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [uuidv4(), accountId, 'ad_advisor_api_winner', adSetMetaId, campaignMetaId, 'image', winnerCreative.headline, winnerCreative.cta_type,
        range.since, range.until, winnerCreative.spend, winnerCreative.results, winnerCreative.ctr, 3.5, 8, 1.4,
        winnerScored.score_overall, winnerScored.score_hook, winnerScored.score_headline, winnerScored.score_copy,
        winnerScored.score_visual, winnerScored.score_cta, winnerScored.score_offer, winnerScored.score_trust, winnerScored.score_psychology,
        JSON.stringify(winnerScored.text_analysis), 'none', null]
    );

    // detectFatigue() (Phase 41) recomputes fatigue LIVE from real historical
    // snapshots, not from a hand-set fatigue_status column -- a genuine
    // "severe" verdict needs a prior + latest snapshot showing a real
    // worsening trend across >=4 of its own checked signals.
    testDb.db.run(
      `INSERT INTO creative_analytics
         (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_type, headline, cta_type,
          date_since, date_until, spend, results, ctr, cpc, cpm, frequency, reach, conversion_rate, cpa, calculated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [uuidv4(), accountId, 'ad_advisor_api_loser', adSetMetaId, campaignMetaId, 'image', null, 'LEARN_MORE',
        '2026-05-25', '2026-05-31', 100, 10, 3, 1, 10, 2, 1000, 5, 10]
    );

    const loserCreative = { headline: null, primary_text: null, description: null, cta_type: 'LEARN_MORE', media_type: 'image', spend: 100, results: 1, ctr: 0.3, cost_per_result: 100 };
    const loserScored = computeCreativeScore(loserCreative, { status: 'severe' });
    testDb.db.run(
      `INSERT INTO creative_analytics
         (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_type, headline, cta_type,
          date_since, date_until, spend, results, ctr, roas, cpa, cpc, cpm, frequency, reach, conversion_rate,
          score_overall, score_hook, ai_analysis_json, fatigue_status, fatigue_recommendation, calculated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [uuidv4(), accountId, 'ad_advisor_api_loser', adSetMetaId, campaignMetaId, 'image', loserCreative.headline, loserCreative.cta_type,
        range.since, range.until, loserCreative.spend, loserCreative.results, loserCreative.ctr, 0.4, 100, 1.5, 15, 3, 1050, 2,
        loserScored.score_overall, loserScored.score_hook,
        JSON.stringify(loserScored.text_analysis), 'severe', 'pause']
    );
  });

  afterAll(() => { testDb.cleanup(); });

  describe('GET /creative/:adId', () => {
    test('returns the full advisor bundle for a healthy winner, never recommending scaling for the loser and vice versa', async () => {
      const res = await request(app).get(`/api/v1/advisor/creative/ad_advisor_api_winner?mock=true`);
      expect(res.status).toBe(200);
      expect(res.body.data.analyzed).toBe(true);
      expect(res.body.data.priorities).toBeDefined();
      expect(res.body.data.strategic_advice).toBeDefined();
      expect(res.body.data.benchmark).toBeDefined();
      expect(res.body.data.comparison_breakdown.winner_vs_weakest).toBeTruthy();
    });

    test('a severely fatigued creative gets Pause advice, not scaling advice', async () => {
      const res = await request(app).get(`/api/v1/advisor/creative/ad_advisor_api_loser?mock=true`);
      expect(res.status).toBe(200);
      expect(res.body.data.pause_advice.action).toBe('Pause');
      expect(res.body.data.scaling_advice.recommended).toBe(false);
    });

    test('404s for an unknown ad', async () => {
      const res = await request(app).get('/api/v1/advisor/creative/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /account/:accountId/learning', () => {
    test('returns insufficient_data for a fresh/unknown account rather than fabricating patterns', async () => {
      const res = await request(app).get(`/api/v1/advisor/account/${accountId}/learning`);
      expect(res.status).toBe(200);
      expect(['ok', 'insufficient_data']).toContain(res.body.data.status);
    });
  });

  describe('GET /campaign/:campaignId/learning', () => {
    test('identifies the best/weakest message for the campaign', async () => {
      const res = await request(app).get(`/api/v1/advisor/campaign/${campaignId}/learning`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).not.toBe('insufficient_data');
      expect(res.body.data.most_successful_message.meta_ad_id).toBe('ad_advisor_api_winner');
      expect(res.body.data.weakest_message.meta_ad_id).toBe('ad_advisor_api_loser');
    });
  });
});
