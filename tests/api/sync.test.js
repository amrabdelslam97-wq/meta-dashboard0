'use strict';

/**
 * Real HTTP-layer coverage of POST /api/v1/sync's structured response
 * (AUTONOMOUS META SYNC RECOVERY mission, Phase 13) and the new
 * GET /sync/execution/:id + GET /sync/live/:account_id endpoints -- through
 * the actual Express route (supertest), not by calling smartSyncEngine
 * functions directly (already covered by smartSyncEngine.test.js). This
 * catches serialization/route-wiring bugs a service-level unit test can't:
 * e.g. whether executionId actually survives res.json(), whether a thrown
 * error is caught and reshaped into the documented structured body instead
 * of falling through to the generic errorHandler.
 */

const request = require('supertest');
const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

describe('API: POST /api/v1/sync — structured response + durable execution tracking', () => {
  let testDb;
  let app;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  function insertAccount(overrides = {}) {
    const id = uuidv4();
    const metaId = overrides.meta_account_id || `act_apisync_${id.slice(0, 8)}`;
    testDb.db.run(
      `INSERT INTO ad_accounts (
         id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid,
         attribution_window_days, created_at, updated_at
       ) VALUES (?, ?, 'API Sync Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
      [id, metaId, encryptToken('fake-token')]
    );
    return { id, meta_account_id: metaId };
  }

  test('a successful sync returns an executionId that resolves to a real sync_live_executions row via the API', async () => {
    const account = insertAccount();
    nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
    nock(BASE).get(`/${VERSION}/${account.meta_account_id}`).query(true)
      .reply(200, { id: account.meta_account_id, name: 'API Sync Test', currency: 'USD', timezone_name: 'UTC' });

    const res = await request(app).post('/api/v1/sync').send({ account_id: account.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.executionId).toBe('string');
    expect(res.body.account_id).toBe(account.id);
    expect(['completed', 'partial']).toContain(res.body.status);

    // Fetch it back through the real API (not a direct DB query) --
    // proves the GET endpoint and the executionId returned by POST refer
    // to the exact same durable row.
    const execRes = await request(app).get(`/api/v1/sync/execution/${res.body.executionId}`);
    expect(execRes.status).toBe(200);
    expect(execRes.body.data.execution.id).toBe(res.body.executionId);
    expect(execRes.body.data.execution.ad_account_id).toBe(account.id);
    expect(execRes.body.data.execution.finished_at).toBeTruthy();
    expect(Array.isArray(execRes.body.data.events)).toBe(true);
    expect(execRes.body.data.events.length).toBeGreaterThan(0);
  });

  test('GET /sync/live/:account_id returns the most recent execution for that account', async () => {
    const account = insertAccount();
    nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
    nock(BASE).get(`/${VERSION}/${account.meta_account_id}`).query(true)
      .reply(200, { id: account.meta_account_id, name: 'API Sync Test', currency: 'USD', timezone_name: 'UTC' });

    const postRes = await request(app).post('/api/v1/sync').send({ account_id: account.id });

    const liveRes = await request(app).get(`/api/v1/sync/live/${account.id}`);
    expect(liveRes.status).toBe(200);
    expect(liveRes.body.data.execution.id).toBe(postRes.body.executionId);
  });

  test('GET /sync/execution/:id returns 404 for a nonexistent execution, not a crash', async () => {
    const res = await request(app).get('/api/v1/sync/execution/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  test('a token decrypt failure returns a structured 200 body (never a raw 500) with the real errorCode', async () => {
    const account = insertAccount();
    testDb.db.run(
      `UPDATE ad_accounts SET access_token_encrypted = ? WHERE id = ?`,
      ['enc:v1:000000000000000000000000:00000000000000000000000000000000:deadbeef', account.id]
    );

    const res = await request(app).post('/api/v1/sync').send({ account_id: account.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.status).toBe('failed');
    expect(res.body.errorCode).toBe('TOKEN_DECRYPT_FAILED');
    expect(typeof res.body.executionId).toBe('string');

    const execRes = await request(app).get(`/api/v1/sync/execution/${res.body.executionId}`);
    expect(execRes.body.data.execution.status).toBe('failed');
    expect(execRes.body.data.execution.error_code).toBe('TOKEN_DECRYPT_FAILED');
  });

  test('an unknown account_id returns 404 and never creates an execution row', async () => {
    const res = await request(app).post('/api/v1/sync').send({ account_id: uuidv4() });
    expect(res.status).toBe(404);
    expect(res.body.executionId).toBeUndefined();
  });
});
