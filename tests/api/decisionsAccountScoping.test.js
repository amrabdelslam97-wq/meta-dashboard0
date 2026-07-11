'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

// Multi-account scoping (Multi Meta Ad Account Management milestone):
// GET /decisions/winners, /losers and /opportunities previously had no way
// to scope to a single account -- topWinnersEngine/topLosersEngine/
// opportunityEngine always joined ALL accounts' campaigns together.
describe('API: /api/v1/decisions winners/losers/opportunities -- account_id scoping', () => {
  let testDb;
  let app;
  let ownAccountId, ownCampaignId;
  let otherAccountId, otherCampaignId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    ownAccountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_scope_own', 'Scope Own', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [ownAccountId]
    );
    ownCampaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_scope_own', 'Own Winner Campaign', 'traffic', 'active', datetime('now'), datetime('now'))`,
      [ownCampaignId, ownAccountId]
    );
    testDb.db.run(
      `INSERT INTO health_score_history (id, ad_account_id, entity_type, entity_meta_id, entity_label, health_score, health_status, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_scope_own', 'Own Winner Campaign', 85, 'excellent', datetime('now'))`,
      [uuidv4(), ownAccountId]
    );

    otherAccountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_scope_other', 'Scope Other', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [otherAccountId]
    );
    otherCampaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_scope_other', 'Other Winner Campaign', 'traffic', 'active', datetime('now'), datetime('now'))`,
      [otherCampaignId, otherAccountId]
    );
    testDb.db.run(
      `INSERT INTO health_score_history (id, ad_account_id, entity_type, entity_meta_id, entity_label, health_score, health_status, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_scope_other', 'Other Winner Campaign', 85, 'excellent', datetime('now'))`,
      [uuidv4(), otherAccountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('GET /decisions/winners?account_id= scopes to that account only', async () => {
    const res = await request(app).get(`/api/v1/decisions/winners?account_id=${ownAccountId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some(w => w.meta_campaign_id === 'camp_scope_own')).toBe(true);
    expect(res.body.data.some(w => w.meta_campaign_id === 'camp_scope_other')).toBe(false);
  });

  test('GET /decisions/winners without account_id keeps default behavior (all accounts mixed)', async () => {
    const res = await request(app).get('/api/v1/decisions/winners');
    expect(res.body.data.some(w => w.meta_campaign_id === 'camp_scope_own')).toBe(true);
    expect(res.body.data.some(w => w.meta_campaign_id === 'camp_scope_other')).toBe(true);
  });

  test('GET /decisions/losers?account_id= scopes to that account only', async () => {
    const res = await request(app).get(`/api/v1/decisions/losers?account_id=${ownAccountId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some(l => l.meta_campaign_id === 'camp_scope_other')).toBe(false);
  });

  test('GET /decisions/opportunities?account_id= scopes to that account only', async () => {
    const res = await request(app).get(`/api/v1/decisions/opportunities?account_id=${ownAccountId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every(o => o.meta_campaign_id !== 'camp_scope_other')).toBe(true);
    // Health score 85 with no recorded frequency should trigger at least
    // "Ready To Scale" and "Budget Reallocation" for the own campaign.
    expect(res.body.data.some(o => o.meta_campaign_id === 'camp_scope_own')).toBe(true);
  });
});
