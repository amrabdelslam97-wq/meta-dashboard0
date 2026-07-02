'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/adsets optimization_goal filter', () => {
  let testDb;
  let app;
  let accountId;
  let campaignId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_optgoal_test', 'OptGoal Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
    campaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_optgoal', 'Video Campaign', 'awareness', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId]
    );

    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, optimization_goal, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_video', 'Video AdSet', 'active', 'THRUPLAY', datetime('now'), datetime('now'))`,
      [uuidv4(), campaignId, accountId]
    );
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, optimization_goal, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_reach', 'Reach AdSet', 'active', 'REACH', datetime('now'), datetime('now'))`,
      [uuidv4(), campaignId, accountId]
    );
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_no_goal', 'No Goal AdSet', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), campaignId, accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('GET /adsets with no filter returns all 3 ad sets, including optimization_goal field', async () => {
    const res = await request(app).get('/api/v1/adsets');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(3);
    const video = res.body.data.find(a => a.meta_adset_id === 'adset_video');
    expect(video.optimization_goal).toBe('THRUPLAY');
    const noGoal = res.body.data.find(a => a.meta_adset_id === 'adset_no_goal');
    expect(noGoal.optimization_goal).toBeNull();
  });

  test('GET /adsets?optimization_goal=THRUPLAY returns only the matching ad set', async () => {
    const res = await request(app).get('/api/v1/adsets').query({ optimization_goal: 'THRUPLAY' });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].meta_adset_id).toBe('adset_video');
  });

  test('GET /adsets?optimization_goal=REACH returns only that ad set', async () => {
    const res = await request(app).get('/api/v1/adsets').query({ optimization_goal: 'REACH' });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].meta_adset_id).toBe('adset_reach');
  });

  test('GET /adsets?optimization_goal=NONEXISTENT returns an empty list, not an error', async () => {
    const res = await request(app).get('/api/v1/adsets').query({ optimization_goal: 'NONEXISTENT_GOAL' });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(0);
  });
});
