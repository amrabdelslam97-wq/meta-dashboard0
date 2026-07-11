'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

function insertAccount(testDb) {
  const id = uuidv4();
  const metaId = `act_creative_${id.slice(0, 8)}`;
  testDb.db.run(
    `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, attribution_window_days, created_at, updated_at)
     VALUES (?, ?, 'Creative Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
    [id, metaId, encryptToken('fake-token')]
  );
  return { id, meta_account_id: metaId };
}

function insertFullTree(testDb, accountId, { campaignMetaId, adsetMetaId, adMetaId, creativeId }) {
  const campaignId = uuidv4();
  testDb.db.run(
    `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Creative Campaign', 'engagement', 'active', datetime('now'), datetime('now'))`,
    [campaignId, accountId, campaignMetaId]
  );
  const adsetId = uuidv4();
  testDb.db.run(
    `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Creative Ad Set', 'active', datetime('now'), datetime('now'))`,
    [adsetId, campaignId, accountId, adsetMetaId]
  );
  const adId = uuidv4();
  testDb.db.run(
    `INSERT INTO ads (id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status, creative_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Creative Ad', 'active', ?, datetime('now'), datetime('now'))`,
    [adId, adsetId, campaignId, accountId, adMetaId, creativeId]
  );
  return { campaignId, adsetId, adId };
}

describe('creativeAnalytics', () => {
  let testDb;
  let creativeAnalytics;

  beforeAll(async () => {
    testDb = await createTestDb();
    creativeAnalytics = require('../../src/services/creativeAnalytics');
  });

  afterAll(() => { testDb.cleanup(); });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM ad_sets');
    testDb.db.run('DELETE FROM ads');
    testDb.db.run('DELETE FROM creative_analytics');
  });

  describe('extractCreativeContent', () => {
    test('extracts headline/body/description/CTA from a link_data (image/link ad) creative', () => {
      const creative = {
        id: 'creative_1', image_url: 'https://example.com/img.jpg',
        object_story_spec: {
          link_data: { name: 'Big Sale', message: 'Shop now and save', description: 'Limited time', call_to_action: { type: 'SHOP_NOW' } },
        },
      };
      const content = creativeAnalytics.extractCreativeContent(creative);
      expect(content.creative_type).toBe('image');
      expect(content.headline).toBe('Big Sale');
      expect(content.primary_text).toBe('Shop now and save');
      expect(content.description).toBe('Limited time');
      expect(content.cta_type).toBe('SHOP_NOW');
    });

    test('extracts from video_data for a video ad and detects creative_type "video"', () => {
      const creative = {
        id: 'creative_2', video_id: 'vid_123',
        object_story_spec: { video_data: { title: 'Watch This', message: 'Amazing product', call_to_action: { type: 'LEARN_MORE' } } },
      };
      const content = creativeAnalytics.extractCreativeContent(creative);
      expect(content.creative_type).toBe('video');
      expect(content.headline).toBe('Watch This');
      expect(content.cta_type).toBe('LEARN_MORE');
      expect(content.video_id).toBe('vid_123');
    });

    test('detects carousel via child_attachments and never fabricates a missing field', () => {
      const creative = {
        id: 'creative_3',
        object_story_spec: { link_data: { child_attachments: [{ name: 'Slide 1' }, { name: 'Slide 2' }] } },
      };
      const content = creativeAnalytics.extractCreativeContent(creative);
      expect(content.creative_type).toBe('carousel');
      expect(content.headline).toBeNull();
      expect(content.description).toBeNull();
    });

    test('returns "unknown" type and all-null content for a null/absent creative', () => {
      const content = creativeAnalytics.extractCreativeContent(null);
      expect(content.creative_type).toBe('unknown');
      expect(content.headline).toBeNull();
    });
  });

  describe('syncAccountCreativeAnalytics', () => {
    test('fetches creative detail + reuses one ad-metrics call per campaign, persisting video percentages derived from real counts', async () => {
      const account = insertAccount(testDb);
      insertFullTree(testDb, account.id, { campaignMetaId: 'camp_cr_1', adsetMetaId: 'adset_cr_1', adMetaId: 'ad_cr_1', creativeId: 'creative_cr_1' });

      nock(BASE).get(`/${VERSION}/camp_cr_1/insights`).query(q => q.level === 'ad')
        .reply(200, {
          data: [{
            ad_id: 'ad_cr_1', ad_name: 'Creative Ad', adset_id: 'adset_cr_1',
            spend: '50', impressions: '1000', reach: '500', clicks: '20', ctr: '2', cpm: '50', cpc: '2.5', frequency: '2',
            video_play_actions: [{ action_type: 'video_view', value: '400' }],
            video_p25_watched_actions: [{ action_type: 'video_view', value: '300' }],
            video_p100_watched_actions: [{ action_type: 'video_view', value: '80' }],
            video_thruplay_watched_actions: [{ action_type: 'video_view', value: '120' }],
            video_avg_time_watched_actions: [{ action_type: 'video_view', value: '8.5' }],
          }],
        });
      nock(BASE).get(`/${VERSION}/ad_cr_1`).query(true)
        .reply(200, { creative: { id: 'creative_cr_1', video_id: 'vid_1', object_story_spec: { video_data: { title: 'Great Ad', message: 'Buy now', call_to_action: { type: 'SHOP_NOW' } } } } });
      nock(BASE).get(`/${VERSION}/vid_1`).query(true).reply(200, { length: 14.2 });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const range = { since: '2026-06-01', until: '2026-06-07' };
      const summary = await creativeAnalytics.syncAccountCreativeAnalytics(fullAccount, range);

      expect(summary.adsProcessed).toBe(1);
      expect(summary.errors).toEqual([]);

      const row = testDb.db.get(`SELECT * FROM creative_analytics WHERE meta_ad_id = 'ad_cr_1'`);
      expect(row.headline).toBe('Great Ad');
      expect(row.cta_type).toBe('SHOP_NOW');
      expect(row.creative_type).toBe('video');
      expect(row.video_p25_pct).toBeCloseTo(75, 1); // 300/400*100
      expect(row.video_p100_pct).toBeCloseTo(20, 1); // 80/400*100
      expect(row.hold_rate).toBeCloseTo(30, 1); // thruplays(120)/plays(400)*100
      expect(row.spend).toBe(50);
      expect(row.video_length_sec).toBeCloseTo(14.2, 1);

      // New: Creative Intelligence fields computed at persist time.
      expect(row.score_overall).toBeGreaterThan(0);
      expect(row.score_cta).toBeGreaterThanOrEqual(80); // SHOP_NOW is a strong CTA
      expect(row.fatigue_status).toBe('insufficient_data'); // only one snapshot exists yet
      expect(JSON.parse(row.ai_analysis_json).hook).toBeDefined();
      expect(row.thumb_stop_rate).toBeCloseTo(40, 1); // 400 plays / 1000 impressions * 100
    });

    test('does not re-process an ad that already has a snapshot for this exact date range', async () => {
      const account = insertAccount(testDb);
      insertFullTree(testDb, account.id, { campaignMetaId: 'camp_cr_2', adsetMetaId: 'adset_cr_2', adMetaId: 'ad_cr_2', creativeId: 'creative_cr_2' });
      const range = { since: '2026-06-01', until: '2026-06-07' };

      testDb.db.run(
        `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, date_since, date_until, calculated_at)
         VALUES (?, ?, 'ad_cr_2', ?, ?, datetime('now'))`,
        [uuidv4(), account.id, range.since, range.until]
      );

      // No nock interceptors -- a fetch attempt here would throw.
      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await creativeAnalytics.syncAccountCreativeAnalytics(fullAccount, range);
      expect(summary.adsProcessed).toBe(0);
      expect(summary.apiCalls).toBe(0);
    });

    test('fatigue accumulates real trend signals across two sync cycles, and video length is fetched once then reused (no duplicate download)', async () => {
      const account = insertAccount(testDb);
      insertFullTree(testDb, account.id, { campaignMetaId: 'camp_cr_fatigue', adsetMetaId: 'adset_cr_fatigue', adMetaId: 'ad_cr_fatigue', creativeId: 'creative_cr_fatigue' });
      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);

      const range1 = { since: '2026-06-01', until: '2026-06-07' };
      nock(BASE).get(`/${VERSION}/camp_cr_fatigue/insights`).query(true)
        .reply(200, { data: [{ ad_id: 'ad_cr_fatigue', adset_id: 'adset_cr_fatigue', spend: '100', impressions: '10000', reach: '5000', clicks: '200', ctr: '3', cpm: '10', cpc: '0.5', frequency: '2' }] });
      nock(BASE).get(`/${VERSION}/ad_cr_fatigue`).query(true)
        .reply(200, { creative: { id: 'creative_cr_fatigue', video_id: 'vid_fatigue', object_story_spec: { video_data: { title: 'Fatigue Ad', call_to_action: { type: 'SHOP_NOW' } } } } });
      nock(BASE).get(`/${VERSION}/vid_fatigue`).query(true).reply(200, { length: 20 });
      await creativeAnalytics.syncAccountCreativeAnalytics(fullAccount, range1);

      const first = testDb.db.get(`SELECT * FROM creative_analytics WHERE meta_ad_id = 'ad_cr_fatigue' AND date_since = ?`, [range1.since]);
      expect(first.fatigue_status).toBe('insufficient_data'); // only one snapshot so far
      expect(first.video_length_sec).toBeCloseTo(20, 1);

      // Second cycle, later period: frequency way up, CTR/conversion down --
      // a real fatigue signature. No video-length mock this time -- proves
      // it's reused from the first snapshot, not re-fetched (no duplicate download).
      const range2 = { since: '2026-06-08', until: '2026-06-14' };
      nock(BASE).get(`/${VERSION}/camp_cr_fatigue/insights`).query(true)
        .reply(200, { data: [{ ad_id: 'ad_cr_fatigue', adset_id: 'adset_cr_fatigue', spend: '100', impressions: '10000', reach: '5050', clicks: '80', ctr: '1.2', cpm: '14', cpc: '1.1', frequency: '3.5' }] });
      nock(BASE).get(`/${VERSION}/ad_cr_fatigue`).query(true)
        .reply(200, { creative: { id: 'creative_cr_fatigue', video_id: 'vid_fatigue', object_story_spec: { video_data: { title: 'Fatigue Ad', call_to_action: { type: 'SHOP_NOW' } } } } });
      const summary2 = await creativeAnalytics.syncAccountCreativeAnalytics(fullAccount, range2);
      expect(summary2.errors).toEqual([]); // would contain a nock-no-match error if video length were re-fetched

      const second = testDb.db.get(`SELECT * FROM creative_analytics WHERE meta_ad_id = 'ad_cr_fatigue' AND date_since = ?`, [range2.since]);
      expect(['moderate', 'severe']).toContain(second.fatigue_status);
      expect(['refresh', 'pause']).toContain(second.fatigue_recommendation);
      expect(second.video_length_sec).toBeCloseTo(20, 1); // reused, not re-fetched
    });
  });

  describe('getCreativeAnalytics (read side, no Meta calls)', () => {
    test('returns persisted creatives ranked with an attached insight', () => {
      const account = insertAccount(testDb);
      const range = { since: '2026-06-01', until: '2026-06-07' };
      const now = new Date().toISOString();
      testDb.db.run(
        `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, meta_campaign_id, headline, date_since, date_until, spend, results, cpa, calculated_at)
         VALUES (?, ?, 'ad_x', 'camp_read_cr', 'Winner Ad', ?, ?, 100, 20, 5, ?)`,
        [uuidv4(), account.id, range.since, range.until, now]
      );
      testDb.db.run(
        `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, meta_campaign_id, headline, date_since, date_until, spend, results, cpa, calculated_at)
         VALUES (?, ?, 'ad_y', 'camp_read_cr', 'Loser Ad', ?, ?, 100, 4, 25, ?)`,
        [uuidv4(), account.id, range.since, range.until, now]
      );

      const result = creativeAnalytics.getCreativeAnalytics('camp_read_cr', range);
      expect(result.creatives.length).toBe(2);
      expect(result.insight.top_performer.label).toBe('Winner Ad');
      expect(result.insight.bottom_performer.label).toBe('Loser Ad');
    });
  });
});
