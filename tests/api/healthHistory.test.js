'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/health-history', () => {
  let testDb;
  let app;
  let ownAccountId, otherAccountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    ownAccountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_health_own', 'Health Own', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [ownAccountId]
    );
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_health_own', 'Own Campaign', 'traffic', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), ownAccountId]
    );
    testDb.db.run(
      `INSERT INTO health_score_history (id, ad_account_id, entity_type, entity_meta_id, entity_label, health_score, health_status, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_health_own', 'Own Campaign', 72, 'good', datetime('now'))`,
      [uuidv4(), ownAccountId]
    );

    otherAccountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_health_other', 'Health Other', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [otherAccountId]
    );
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_health_other', 'Other Campaign', 'traffic', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), otherAccountId]
    );
    testDb.db.run(
      `INSERT INTO health_score_history (id, ad_account_id, entity_type, entity_meta_id, entity_label, health_score, health_status, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_health_other', 'Other Campaign', 40, 'warning', datetime('now'))`,
      [uuidv4(), otherAccountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('GET /health-history (all campaigns) mixes every account by default', async () => {
    const res = await request(app).get('/api/v1/health-history');
    expect(res.status).toBe(200);
    expect(res.body.data.some(h => h.entity_meta_id === 'camp_health_own')).toBe(true);
    expect(res.body.data.some(h => h.entity_meta_id === 'camp_health_other')).toBe(true);
  });

  test('GET /health-history?account_id= scopes the all-campaigns overview to one account', async () => {
    const res = await request(app).get(`/api/v1/health-history?account_id=${ownAccountId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some(h => h.entity_meta_id === 'camp_health_own')).toBe(true);
    expect(res.body.data.some(h => h.entity_meta_id === 'camp_health_other')).toBe(false);
  });

  test('GET /health-history?entity_meta_id=&account_id= scopes a single entity\'s trend to the given account', async () => {
    const res = await request(app).get(`/api/v1/health-history?entity_meta_id=camp_health_own&account_id=${ownAccountId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  test('GET /health-history?entity_meta_id=&account_id= returns empty when entity belongs to a different account', async () => {
    const res = await request(app).get(`/api/v1/health-history?entity_meta_id=camp_health_other&account_id=${ownAccountId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(0);
  });
});
