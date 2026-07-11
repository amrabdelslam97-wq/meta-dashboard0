'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/portfolio -- MMS cross-account trace (Phase X.4)', () => {
  let testDb;
  let app;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    const accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_portfolio_gov', 'Portfolio Governance Test', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  const routes = ['/', '/accounts', '/summary', '/health', '/objectives', '/alerts'];

  test.each(routes)('GET /portfolio%s attaches an MMS cross-account trace (_governance) with MF10 and governance:not_applicable', async (route) => {
    const res = await request(app).get(`/api/v1/portfolio${route === '/' ? '' : route}`);
    expect(res.status).toBe(200);
    expect(res.body._governance).toBeDefined();
    expect(res.body._governance.execution_order).toContain('MF10');
    expect(res.body._governance.governance).toBe('not_applicable');
    expect(typeof res.body._governance.governance_reason).toBe('string');
  });
});
