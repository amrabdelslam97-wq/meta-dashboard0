'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');
const cache = require('../../src/services/cacheService');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

function insertAccount(testDb, overrides = {}) {
  const id = uuidv4();
  const metaId = overrides.meta_account_id || `act_analytics_${id.slice(0, 8)}`;
  testDb.db.run(
    `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, created_at, updated_at)
     VALUES (?, ?, 'Analytics Test', ?, 'active', 1, datetime('now'), datetime('now'))`,
    [id, metaId, encryptToken('fake-token')]
  );
  return { id, meta_account_id: metaId };
}

function insertCampaign(testDb, accountId, metaCampaignId, overrides = {}) {
  const id = uuidv4();
  testDb.db.run(
    `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Analytics Campaign', 'engagement', ?, datetime('now'), datetime('now'))`,
    [id, accountId, metaCampaignId, overrides.status || 'active']
  );
  return id;
}

describe('analyticsEngine', () => {
  let testDb;
  let analyticsEngine;

  beforeAll(async () => {
    testDb = await createTestDb();
    analyticsEngine = require('../../src/services/analyticsEngine');
  });

  afterAll(() => { testDb.cleanup(); });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM analytics_breakdown_history');
  });

  describe('deriveSingleDimension', () => {
    test('rolls combined age/gender rows up into single-dimension totals with re-derived rates', () => {
      const ageGenderRows = [
        { dimension_value: '25-34 / female', spend: 100, impressions: 10000, reach: 5000, clicks: 100, results: 10 },
        { dimension_value: '25-34 / male', spend: 50, impressions: 5000, reach: 2500, clicks: 40, results: 4 },
        { dimension_value: '35-44 / female', spend: 30, impressions: 3000, reach: 1500, clicks: 20, results: 2 },
      ];

      const byAge = analyticsEngine.deriveSingleDimension(ageGenderRows, 'age');
      const total2534 = byAge.find(r => r.dimension_value === '25-34');
      expect(total2534.spend).toBe(150);
      expect(total2534.impressions).toBe(15000);
      expect(total2534.results).toBe(14);
      expect(total2534.cost_per_result).toBeCloseTo(150 / 14, 2);

      const byGender = analyticsEngine.deriveSingleDimension(ageGenderRows, 'gender');
      const female = byGender.find(r => r.dimension_value === 'female');
      expect(female.spend).toBe(130);
      expect(female.results).toBe(12);
    });
  });

  describe('syncCampaignAnalyticsForRange', () => {
    test('fetches age_gender (deriving age+gender), country, region, dma, placement, impression_device, and device_platform -- 7 Meta calls total, all persisted', async () => {
      const account = insertAccount(testDb);
      insertCampaign(testDb, account.id, 'camp_analytics_1');

      nock(BASE).get(`/${VERSION}/camp_analytics_1/insights`).query(q => q.breakdowns === 'age,gender')
        .reply(200, { data: [{ age: '25-34', gender: 'female', spend: '100', impressions: '1000', reach: '500', clicks: '10', ctr: '1', cpm: '10', cpc: '1', frequency: '2', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }] }] });
      nock(BASE).get(`/${VERSION}/camp_analytics_1/insights`).query(q => q.breakdowns === 'country')
        .reply(200, { data: [{ country: 'US', spend: '80', impressions: '800', reach: '400', clicks: '8', ctr: '1', cpm: '10', cpc: '1', frequency: '2' }] });
      nock(BASE).get(`/${VERSION}/camp_analytics_1/insights`).query(q => q.breakdowns === 'region')
        .reply(200, { data: [{ region: 'California', spend: '40', impressions: '400', reach: '200', clicks: '4', ctr: '1', cpm: '10', cpc: '1', frequency: '2' }] });
      nock(BASE).get(`/${VERSION}/camp_analytics_1/insights`).query(q => q.breakdowns === 'dma')
        .reply(200, { data: [{ dma: 'New York', spend: '15', impressions: '150', reach: '75', clicks: '2', ctr: '1', cpm: '10', cpc: '1', frequency: '2' }] });
      nock(BASE).get(`/${VERSION}/camp_analytics_1/insights`).query(q => q.breakdowns === 'publisher_platform,platform_position')
        .reply(200, { data: [{ publisher_platform: 'facebook', platform_position: 'feed', spend: '60', impressions: '600', reach: '300', clicks: '6', ctr: '1', cpm: '10', cpc: '1', frequency: '2' }] });
      nock(BASE).get(`/${VERSION}/camp_analytics_1/insights`).query(q => q.breakdowns === 'impression_device')
        .reply(200, { data: [{ impression_device: 'android_smartphone', spend: '20', impressions: '200', reach: '100', clicks: '2', ctr: '1', cpm: '10', cpc: '1', frequency: '2' }] });
      nock(BASE).get(`/${VERSION}/camp_analytics_1/insights`).query(q => q.breakdowns === 'device_platform')
        .reply(200, { data: [{ device_platform: 'mobile', spend: '20', impressions: '200', reach: '100', clicks: '2', ctr: '1', cpm: '10', cpc: '1', frequency: '2' }] });

      const range = { since: '2026-06-01', until: '2026-06-07' };
      const summary = await analyticsEngine.syncCampaignAnalyticsForRange(account.id, 'camp_analytics_1', 'fake-token', range);

      expect(summary.apiCalls).toBe(7);
      expect(summary.breakdownsFailed).toBe(0);

      const types = testDb.db.all(
        `SELECT DISTINCT breakdown_type FROM analytics_breakdown_history WHERE entity_meta_id = ? ORDER BY breakdown_type`,
        ['camp_analytics_1']
      ).map(r => r.breakdown_type);
      expect(types.sort()).toEqual(['age', 'age_gender', 'country', 'device_platform', 'dma', 'gender', 'impression_device', 'placement', 'region']);

      const country = testDb.db.get(
        `SELECT * FROM analytics_breakdown_history WHERE entity_meta_id = ? AND breakdown_type = 'country'`,
        ['camp_analytics_1']
      );
      expect(country.breakdown_value).toBe('US');
      expect(country.spend).toBe(80);
    });

    test('re-syncing the same campaign/period upserts (no duplicate rows)', async () => {
      const account = insertAccount(testDb);
      insertCampaign(testDb, account.id, 'camp_analytics_upsert');
      const range = { since: '2026-06-01', until: '2026-06-07' };

      for (let i = 0; i < 2; i++) {
        // A real re-sync only re-fetches once the 10-min 'breakdown' cache
        // TTL has elapsed -- flush it here to exercise two genuinely
        // separate fetch+persist cycles instead of the (correct) cache hit
        // a real back-to-back call within the TTL would produce.
        cache.flush();
        nock(BASE).get(`/${VERSION}/camp_analytics_upsert/insights`).query(q => q.breakdowns === 'age,gender')
          .reply(200, { data: [{ age: '25-34', gender: 'female', spend: String(100 + i), impressions: '1000', reach: '500', clicks: '10', ctr: '1', cpm: '10', cpc: '1', frequency: '2' }] });
        nock(BASE).get(`/${VERSION}/camp_analytics_upsert/insights`).query(q => q.breakdowns === 'country')
          .reply(200, { data: [] });
        nock(BASE).get(`/${VERSION}/camp_analytics_upsert/insights`).query(q => q.breakdowns === 'region')
          .reply(200, { data: [] });
        nock(BASE).get(`/${VERSION}/camp_analytics_upsert/insights`).query(q => q.breakdowns === 'publisher_platform,platform_position')
          .reply(200, { data: [] });
        nock(BASE).get(`/${VERSION}/camp_analytics_upsert/insights`).query(q => q.breakdowns === 'impression_device')
          .reply(200, { data: [] });
        await analyticsEngine.syncCampaignAnalyticsForRange(account.id, 'camp_analytics_upsert', 'fake-token', range);
      }

      const rows = testDb.db.all(
        `SELECT * FROM analytics_breakdown_history WHERE entity_meta_id = ? AND breakdown_type = 'age_gender'`,
        ['camp_analytics_upsert']
      );
      expect(rows.length).toBe(1); // upserted, not duplicated
      expect(rows[0].spend).toBe(101); // reflects the second (latest) sync
    });

    test('a rate-limited breakdown call stops the campaign cycle immediately and re-throws', async () => {
      const account = insertAccount(testDb);
      insertCampaign(testDb, account.id, 'camp_analytics_ratelimit');
      const range = { since: '2026-06-01', until: '2026-06-07' };

      nock(BASE).get(`/${VERSION}/camp_analytics_ratelimit/insights`).query(q => q.breakdowns === 'age,gender')
        .times(4)
        .reply(400, { error: { message: 'User request limit reached', code: 17 } });

      await expect(
        analyticsEngine.syncCampaignAnalyticsForRange(account.id, 'camp_analytics_ratelimit', 'fake-token', range)
      ).rejects.toThrow();
    }, 45_000);
  });

  describe('syncAccountAnalytics', () => {
    test('processes at most MAX_CAMPAIGNS_PER_CYCLE campaigns, oldest-analytics-first', async () => {
      const account = insertAccount(testDb);
      const campaignIds = [];
      for (let i = 0; i < analyticsEngine.MAX_CAMPAIGNS_PER_CYCLE + 3; i++) {
        const metaId = `camp_cap_${i}`;
        insertCampaign(testDb, account.id, metaId);
        campaignIds.push(metaId);
      }

      // Every campaign's breakdown calls return empty data -- we only care
      // about HOW MANY distinct campaigns get a request, not their content.
      nock(BASE).get(/\/insights$/).query(true).times(1000).reply(200, { data: [] });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await analyticsEngine.syncAccountAnalytics(fullAccount, { since: '2026-06-01', until: '2026-06-07' });

      expect(summary.campaignsProcessed).toBe(analyticsEngine.MAX_CAMPAIGNS_PER_CYCLE);
    });
  });

  describe('getBreakdownAnalytics (read side, no Meta calls)', () => {
    test('returns current rows with prior-period comparison and an attached insight, without hitting Meta', async () => {
      const account = insertAccount(testDb);
      const range = { since: '2026-06-15', until: '2026-06-21' };
      const prior = { since: '2026-06-08', until: '2026-06-14' };
      const now = new Date().toISOString();

      const insertRow = (dateRange, value, spend, results) => testDb.db.run(
        `INSERT INTO analytics_breakdown_history (id, ad_account_id, entity_type, entity_meta_id, breakdown_type, breakdown_value, date_since, date_until, spend, impressions, reach, clicks, ctr, cpm, cpc, frequency, results, cost_per_result, calculated_at)
         VALUES (?, ?, 'campaign', 'camp_read_1', 'country', ?, ?, ?, ?, 1000, 500, 10, 1, 10, 1, 2, ?, ?, ?)`,
        [uuidv4(), account.id, value, dateRange.since, dateRange.until, spend, results, results > 0 ? spend / results : null, now]
      );

      insertRow(range, 'US', 100, 10);
      insertRow(range, 'EG', 50, 20); // much cheaper cost-per-result -> should be top performer
      insertRow(prior, 'US', 80, 8);

      // No nock interceptors at all -- proves this function never calls Meta.
      const result = analyticsEngine.getBreakdownAnalytics('camp_read_1', 'country', range);

      expect(result.current.length).toBe(2);
      const us = result.current.find(r => r.breakdown_value === 'US');
      expect(us.previous).toBeTruthy();
      expect(us.previous.spend).toBe(80);
      expect(us.spend_delta_pct).toBeCloseTo(25, 1); // (100-80)/80 * 100

      const eg = result.current.find(r => r.breakdown_value === 'EG');
      expect(eg.previous).toBeNull(); // no prior-period row for EG

      expect(result.insight.top_performer.label).toBe('EG');
    });
  });
});
