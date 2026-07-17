'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');
const { computeCreativeScore } = require('../../src/services/creativeIntelligenceEngine');
const { getAccountCreativeLearning, getCampaignCreativeLearning } = require('../../src/services/advisorLearningEngine');

describe('advisorLearningEngine', () => {
  let testDb;
  let accountId, campaignId;

  function insertCreative({ metaAdId, headline, primaryText, ctaType, ctr, spend = 100 }) {
    const creative = {
      headline, primary_text: primaryText, description: null, cta_type: ctaType, media_type: 'image',
      spend, results: 10, ctr, cost_per_result: 10,
    };
    const scored = computeCreativeScore(creative, { status: 'none' });
    testDb.db.run(
      `INSERT INTO creative_analytics
         (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_type, headline, cta_type,
          date_since, date_until, spend, results, ctr, cpa, score_overall, ai_analysis_json, fatigue_status, calculated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [uuidv4(), accountId, metaAdId, 'adset_learn_1', campaignId === undefined ? 'camp_learn_1' : 'camp_learn_1', 'image', headline, ctaType,
        '2026-04-01', '2026-04-07', spend, 10, ctr, 10, scored.score_overall, JSON.stringify(scored.text_analysis), 'none']
    );
  }

  beforeAll(async () => {
    testDb = await createTestDb();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_learn', 'Learning Test', ?, datetime('now'), datetime('now'))`,
      [accountId, encryptToken('fake-token')]
    );
    campaignId = 'camp_learn_1';
    const internalCampaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Learning Test Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [internalCampaignId, accountId, campaignId]
    );

    // 3 strong "winners" (social proof + urgency + strong CTA + short copy)
    // and 3 weak "losers" (no persuasion signals, generic CTA) -- a real,
    // reviewable gap the pattern detector should surface, not fabricate.
    for (let i = 0; i < 3; i++) {
      insertCreative({
        metaAdId: `ad_winner_${i}`, headline: 'Save Today',
        primaryText: 'Trusted by thousands of happy customers. Limited time offer, act now!',
        ctaType: 'SHOP_NOW', ctr: 3.5 + i * 0.1,
      });
    }
    for (let i = 0; i < 3; i++) {
      insertCreative({
        metaAdId: `ad_loser_${i}`, headline: null,
        primaryText: 'We are a company that sells things for people who need them sometimes in various situations.',
        ctaType: 'LEARN_MORE', ctr: 0.2 + i * 0.01,
      });
    }
  });

  afterAll(() => {
    testDb.cleanup();
  });

  describe('getAccountCreativeLearning', () => {
    test('reports insufficient_data honestly below the minimum sample size', () => {
      const result = getAccountCreativeLearning('non-existent-account-id');
      expect(result.status).toBe('insufficient_data');
      expect(result.sample_size).toBe(0);
    });

    test('detects a real winning pattern (social proof / urgency / strong CTA) with an honest evidence gap', () => {
      const result = getAccountCreativeLearning(accountId);
      expect(result.status).toBe('ok');
      expect(result.sample_size.total).toBe(6);
      expect(result.winning_patterns.length).toBeGreaterThan(0);
      for (const p of result.winning_patterns) {
        expect(p.winners_pct).toBeGreaterThan(p.losers_pct);
        expect(p.gap).toBeGreaterThanOrEqual(25);
      }
    });
  });

  describe('getCampaignCreativeLearning', () => {
    test('identifies the most successful and weakest message with a real category label', () => {
      const result = getCampaignCreativeLearning(campaignId);
      expect(result.status).toBe('ok');
      expect(result.most_successful_message).toBeTruthy();
      expect(result.weakest_message).toBeTruthy();
      expect(result.most_successful_message.score_overall).toBeGreaterThan(result.weakest_message.score_overall);
      expect(typeof result.most_successful_message.message_category).toBe('string');
    });

    test('reports insufficient_data for an unknown campaign', () => {
      const result = getCampaignCreativeLearning('camp_does_not_exist');
      expect(result.status).toBe('insufficient_data');
    });
  });
});
