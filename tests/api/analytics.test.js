'use strict';

const request = require('supertest');
const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

describe('API: /api/v1/analytics', () => {
  let testDb, app, accountId, campaignId, campaignMetaId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, attribution_window_days, created_at, updated_at)
       VALUES (?, 'act_analytics_api', 'Analytics API Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
      [accountId, encryptToken('fake-token')]
    );

    campaignId = uuidv4();
    campaignMetaId = 'camp_analytics_api_1';
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Analytics API Campaign', 'engagement', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId, campaignMetaId]
    );

    const now = new Date().toISOString();
    const range = { since: '2026-06-15', until: '2026-06-21' };
    testDb.db.run(
      `INSERT INTO analytics_breakdown_history (id, ad_account_id, entity_type, entity_meta_id, breakdown_type, breakdown_value, date_since, date_until, spend, impressions, results, cost_per_result, calculated_at)
       VALUES (?, ?, 'campaign', ?, 'age_gender', '25-34 / female', ?, ?, 100, 1000, 10, 10, ?)`,
      [uuidv4(), accountId, campaignMetaId, range.since, range.until, now]
    );
    testDb.db.run(
      `INSERT INTO analytics_breakdown_history (id, ad_account_id, entity_type, entity_meta_id, breakdown_type, breakdown_value, date_since, date_until, spend, impressions, results, cost_per_result, calculated_at)
       VALUES (?, ?, 'campaign', ?, 'country', 'US', ?, ?, 60, 600, 6, 10, ?)`,
      [uuidv4(), accountId, campaignMetaId, range.since, range.until, now]
    );
    testDb.db.run(
      `INSERT INTO analytics_breakdown_history (id, ad_account_id, entity_type, entity_meta_id, breakdown_type, breakdown_value, date_since, date_until, spend, impressions, results, cost_per_result, calculated_at)
       VALUES (?, ?, 'campaign', ?, 'placement', 'facebook / feed', ?, ?, 40, 400, 4, 10, ?)`,
      [uuidv4(), accountId, campaignMetaId, range.since, range.until, now]
    );
    testDb.db.run(
      `INSERT INTO analytics_breakdown_history (id, ad_account_id, entity_type, entity_meta_id, breakdown_type, breakdown_value, date_since, date_until, spend, impressions, results, cost_per_result, calculated_at)
       VALUES (?, ?, 'campaign', ?, 'impression_device', 'android_smartphone', ?, ?, 30, 300, 3, 10, ?)`,
      [uuidv4(), accountId, campaignMetaId, range.since, range.until, now]
    );
    testDb.db.run(
      `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, meta_campaign_id, headline, destination_type, date_since, date_until, spend, results, cpa, calculated_at)
       VALUES (?, ?, 'ad_api_1', ?, 'Winning Headline', 'WHATSAPP', ?, ?, 50, 10, 5, ?)`,
      [uuidv4(), accountId, campaignMetaId, range.since, range.until, now]
    );
    testDb.db.run(
      `INSERT INTO budget_distribution_snapshots (id, ad_account_id, level, entity_meta_id, entity_label, date_since, date_until, budget_amount, spend_amount, results, budget_pct, spend_pct, results_pct, efficiency_score, is_waste, is_scaling_opportunity, calculated_at)
       VALUES (?, ?, 'campaign', ?, 'Analytics API Campaign', ?, ?, 100, 80, 10, 100, 100, 100, 60, 0, 0, ?)`,
      [uuidv4(), accountId, campaignMetaId, range.since, range.until, now]
    );
  });

  afterAll(() => { testDb.cleanup(); });
  afterEach(() => { nock.cleanAll(); });

  const q = '?since=2026-06-15&until=2026-06-21';

  test('GET /analytics/audience/:campaignId returns age_gender breakdown by default with an insight attached', async () => {
    const res = await request(app).get(`/api/v1/analytics/audience/${campaignId}${q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.breakdown_type).toBe('age_gender');
    expect(res.body.data.current.length).toBe(1);
    expect(res.body.data.insight).toBeDefined();
  });

  test('GET /analytics/audience/:campaignId?dimension=gender respects the dimension query param', async () => {
    const res = await request(app).get(`/api/v1/analytics/audience/${campaignId}${q}&dimension=gender`);
    expect(res.status).toBe(200);
    expect(res.body.data.breakdown_type).toBe('gender');
  });

  test('GET /analytics/geographic/:campaignId returns country data by default', async () => {
    const res = await request(app).get(`/api/v1/analytics/geographic/${campaignId}${q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.breakdown_type).toBe('country');
    expect(res.body.data.current[0].breakdown_value).toBe('US');
  });

  test('GET /analytics/placement/:campaignId returns placement data', async () => {
    const res = await request(app).get(`/api/v1/analytics/placement/${campaignId}${q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.current[0].breakdown_value).toBe('facebook / feed');
  });

  test('GET /analytics/device/:campaignId returns impression_device data', async () => {
    const res = await request(app).get(`/api/v1/analytics/device/${campaignId}${q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.current[0].breakdown_value).toBe('android_smartphone');
  });

  test('GET /analytics/creative/:campaignId returns persisted creative rows', async () => {
    const res = await request(app).get(`/api/v1/analytics/creative/${campaignId}${q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.creatives[0].headline).toBe('Winning Headline');
  });

  test('GET /analytics/messaging/:campaignId groups by destination_type', async () => {
    const res = await request(app).get(`/api/v1/analytics/messaging/${campaignId}${q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.destinations[0].destination_type).toBe('WHATSAPP');
  });

  test('GET /analytics/language/:campaignId returns targeting configuration with an honest note', async () => {
    const res = await request(app).get(`/api/v1/analytics/language/${campaignId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.note).toMatch(/does not expose performance/);
  });

  test('GET /analytics/budget-distribution/:accountId returns the persisted snapshot', async () => {
    const res = await request(app).get(`/api/v1/analytics/budget-distribution/${accountId}${q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.campaigns[0].spend_amount).toBe(80);
  });

  test('GET /analytics/charts/:campaignId builds a bar chart from the audience breakdown by default', async () => {
    const res = await request(app).get(`/api/v1/analytics/charts/${campaignId}${q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('bar');
    expect(res.body.data.labels).toEqual(['25-34 / female']);
  });

  test('GET /analytics/charts/:campaignId?format=pie&domain=geographic builds a pie chart from the geographic breakdown', async () => {
    const res = await request(app).get(`/api/v1/analytics/charts/${campaignId}${q}&format=pie&domain=geographic`);
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('pie');
    expect(res.body.data.percentages).toEqual([100]);
  });

  test('GET /analytics/charts/:campaignId?format=bogus 400s with valid formats listed', async () => {
    const res = await request(app).get(`/api/v1/analytics/charts/${campaignId}${q}&format=bogus`);
    expect(res.status).toBe(400);
    expect(res.body.valid_formats).toContain('bar');
  });

  test('unknown campaign id 404s on every analytics route', async () => {
    const badId = '00000000-0000-0000-0000-000000000000';
    for (const path of ['audience', 'geographic', 'placement', 'device', 'creative', 'messaging', 'language']) {
      const res = await request(app).get(`/api/v1/analytics/${path}/${badId}`);
      expect(res.status).toBe(404);
    }
  });

  test('POST /analytics/sync requires account_id', async () => {
    const res = await request(app).post('/api/v1/analytics/sync').send({});
    expect(res.status).toBe(400);
  });

  test('POST /analytics/sync 404s for an unknown account', async () => {
    const res = await request(app).post('/api/v1/analytics/sync').send({ account_id: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
  });

  test('POST /analytics/sync reuses smartSyncEngine (logged into sync_execution_log, not a separate unlogged sync path)', async () => {
    nock(BASE).get(/\/insights$/).query(true).times(50).reply(200, { data: [] });
    nock(BASE).get(new RegExp(`/${VERSION}/ad_.*`)).query(true).times(50).reply(200, { creative: null });

    const res = await request(app).post('/api/v1/analytics/sync').send({ account_id: accountId });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const logRow = testDb.db.get(
      `SELECT * FROM sync_execution_log WHERE ad_account_id = ? AND entity_type = 'analytics' AND source = 'force' ORDER BY started_at DESC LIMIT 1`,
      [accountId]
    );
    expect(logRow).toBeDefined();

    const stateRow = testDb.db.get(
      `SELECT * FROM sync_entity_state WHERE ad_account_id = ? AND entity_type = 'analytics'`,
      [accountId]
    );
    expect(stateRow).toBeDefined();
  });
});
