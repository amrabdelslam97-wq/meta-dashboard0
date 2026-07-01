'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/dashboard (account_id filter, T3-02/T3-08)', () => {
  let testDb;
  let app;
  let accountA, accountB;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountA = uuidv4();
    accountB = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_dash_a', 'Account A', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [accountA]
    );
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_dash_b', 'Account B', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [accountB]
    );

    const campA = uuidv4();
    const campB = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_dash_a', 'Campaign A', 'sales', 'active', datetime('now'), datetime('now'))`,
      [campA, accountA]
    );
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_dash_b', 'Campaign B', 'sales', 'active', datetime('now'), datetime('now'))`,
      [campB, accountB]
    );

    testDb.db.run(
      `INSERT INTO health_score_history
         (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
          health_score, health_status, score_reference, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_dash_a', 'Campaign A', 'sales', 90, 'excellent', 'platform_default', datetime('now'))`,
      [uuidv4(), accountA]
    );
    testDb.db.run(
      `INSERT INTO health_score_history
         (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
          health_score, health_status, score_reference, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_dash_b', 'Campaign B', 'sales', 30, 'critical', 'platform_default', datetime('now'))`,
      [uuidv4(), accountB]
    );

    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'ROAS_BELOW_ONE', 'campaign', 'camp_dash_b', 'Campaign B', 'critical', 'ROAS below 1.0')`,
      [uuidv4(), accountB]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('with no account_id, dashboard aggregates across the whole portfolio', async () => {
    const res = await request(app).get('/api/v1/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.summary.accounts.total).toBe(2);
    expect(res.body.summary.campaigns.total).toBe(2);
    expect(res.body.summary.alerts.critical).toBe(1);
    // avg of 90 and 30 = 60
    expect(res.body.summary.health.average).toBe(60);
  });

  // Regression test for T3-02/T3-08: acctClause/acctParam were built but
  // never actually applied to any of the 6 queries -- account_id had no
  // effect on the response at all.
  test('with account_id=A, campaign/health/alert counts are scoped to account A only', async () => {
    const res = await request(app).get('/api/v1/dashboard').query({ account_id: accountA });
    expect(res.status).toBe(200);

    // Portfolio-wide by design -- answers "how many accounts exist"
    expect(res.body.summary.accounts.total).toBe(2);

    // Everything else must be scoped to account A only
    expect(res.body.summary.campaigns.total).toBe(1);
    expect(res.body.summary.health.average).toBe(90);
    expect(res.body.summary.alerts.critical).toBe(0); // account B's alert must not leak in
    expect(res.body.account_filter).toBe(accountA);

    expect(res.body.top_campaigns.length).toBe(1);
    expect(res.body.top_campaigns[0].meta_campaign_id).toBe('camp_dash_a');
  });

  test('with account_id=B, the critical campaign and its alert are correctly scoped', async () => {
    const res = await request(app).get('/api/v1/dashboard').query({ account_id: accountB });
    expect(res.status).toBe(200);
    expect(res.body.summary.campaigns.total).toBe(1);
    expect(res.body.summary.health.average).toBe(30);
    expect(res.body.summary.alerts.critical).toBe(1);
    expect(res.body.needs_attention.some(c => c.meta_campaign_id === 'camp_dash_b')).toBe(true);
    expect(res.body.needs_attention.some(c => c.meta_campaign_id === 'camp_dash_a')).toBe(false);
  });
});
