'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/decisions -- MMS cross-account trace (Phase X.4)', () => {
  let testDb;
  let app;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_decisions_gov', 'Decisions Governance Test', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [accountId]
    );

    const campaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_decisions_gov_1', 'Decisions Gov Campaign', 'traffic', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId]
    );

    const recId = uuidv4();
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          objective, severity, recommendation_title, recommendation_body,
          generated_at, last_generated_at)
       VALUES (?, 'LOW_CTR', ?, 'campaign', 'camp_decisions_gov_1', 'Decisions Gov Campaign',
               'traffic', 'warning', 'Low CTR', 'Refresh creative.', datetime('now'), datetime('now'))`,
      [recId, accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('GET /decisions attaches an MMS cross-account trace (_governance) with MF10 and governance:not_applicable', async () => {
    const res = await request(app).get('/api/v1/decisions');
    expect(res.status).toBe(200);
    expect(res.body._governance).toBeDefined();
    expect(res.body._governance.execution_order).toContain('MF10');
    expect(res.body._governance.governance).toBe('not_applicable');
    expect(res.body._governance.evidence_count).toBe(res.body.decisions.length);

    // The trace does not touch/replace each decision's own governance_state
    // (computed earlier, at the per-entity grain, per Phase X.3).
    const rec = res.body.decisions.find(d => d.source === 'recommendation');
    expect(rec).toBeDefined();
    expect(rec).toHaveProperty('governance_state');
  });

  test('GET /decisions/winners attaches an MMS cross-account trace', async () => {
    const res = await request(app).get('/api/v1/decisions/winners');
    expect(res.status).toBe(200);
    expect(res.body._governance).toBeDefined();
    expect(res.body._governance.execution_order).toContain('MF10');
    expect(res.body._governance.governance).toBe('not_applicable');
  });

  test('GET /decisions/losers attaches an MMS cross-account trace', async () => {
    const res = await request(app).get('/api/v1/decisions/losers');
    expect(res.status).toBe(200);
    expect(res.body._governance).toBeDefined();
    expect(res.body._governance.execution_order).toContain('MF10');
    expect(res.body._governance.governance).toBe('not_applicable');
  });
});
