'use strict';

const request = require('supertest');
const nock = require('nock');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');
const { isEncrypted } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

describe('API: /api/v1/accounts', () => {
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

  test('POST /accounts verifies the token against Meta and stores it encrypted (never plaintext)', async () => {
    nock(BASE).get(`/${VERSION}/act_123456`).query(true)
      .reply(200, { id: 'act_123456', name: 'Test Account', currency: 'USD', timezone_name: 'UTC' });

    const res = await request(app)
      .post('/api/v1/accounts')
      .send({ meta_account_id: 'act_123456', access_token: 'EAATestPlaintextToken123' });

    expect(res.status).toBe(201);
    expect(res.body.data.access_token_encrypted).toBeUndefined(); // never returned in the response

    const row = testDb.db.get('SELECT access_token_encrypted FROM ad_accounts WHERE meta_account_id = ?', ['act_123456']);
    expect(isEncrypted(row.access_token_encrypted)).toBe(true);
    expect(row.access_token_encrypted).not.toContain('EAATestPlaintextToken123');
  });

  test('POST /accounts rejects when Meta verification fails (invalid token) without storing anything', async () => {
    nock(BASE).get(`/${VERSION}/act_bad`).query(true)
      .reply(400, { error: { message: 'Invalid OAuth access token', code: 190 } });

    const res = await request(app)
      .post('/api/v1/accounts')
      .send({ meta_account_id: 'act_bad', access_token: 'bad-token' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid OAuth access token/);

    const row = testDb.db.get('SELECT id FROM ad_accounts WHERE meta_account_id = ?', ['act_bad']);
    expect(row).toBeNull();
  });

  test('POST /accounts requires meta_account_id and access_token', async () => {
    const res = await request(app).post('/api/v1/accounts').send({});
    expect(res.status).toBe(400);
  });

  test('POST /accounts rejects a duplicate already-connected account', async () => {
    nock(BASE).get(`/${VERSION}/act_dup`).query(true)
      .reply(200, { id: 'act_dup', name: 'Dup', currency: 'USD', timezone_name: 'UTC' });

    await request(app).post('/api/v1/accounts').send({ meta_account_id: 'act_dup', access_token: 'token1' });

    const res2 = await request(app).post('/api/v1/accounts').send({ meta_account_id: 'act_dup', access_token: 'token2' });
    expect(res2.status).toBe(409);
  });

  test('GET /accounts never exposes access_token_encrypted', async () => {
    const res = await request(app).get('/api/v1/accounts');
    expect(res.status).toBe(200);
    for (const account of res.body.data) {
      expect(account.access_token_encrypted).toBeUndefined();
    }
  });

  test('POST /accounts/:id/token verifies the new token against the specific ad account before storing it', async () => {
    nock(BASE).get(`/${VERSION}/act_refresh`).query(true)
      .reply(200, { id: 'act_refresh', name: 'Refresh Test', currency: 'USD', timezone_name: 'UTC' });
    const createRes = await request(app).post('/api/v1/accounts')
      .send({ meta_account_id: 'act_refresh', access_token: 'original-token' });
    const accountId = createRes.body.data.id;

    nock(BASE).get(`/${VERSION}/act_refresh`).query(q => q.fields === 'id')
      .reply(200, { id: 'act_refresh' });

    const res = await request(app)
      .post(`/api/v1/accounts/${accountId}/token`)
      .send({ access_token: 'new-rotated-token' });

    expect(res.status).toBe(200);
    const row = testDb.db.get('SELECT access_token_encrypted FROM ad_accounts WHERE id = ?', [accountId]);
    expect(isEncrypted(row.access_token_encrypted)).toBe(true);
  });

  test('POST /accounts/:id/token rejects a token that fails Meta verification and does not overwrite the stored token', async () => {
    nock(BASE).get(`/${VERSION}/act_refresh2`).query(true)
      .reply(200, { id: 'act_refresh2', name: 'Refresh Test 2', currency: 'USD', timezone_name: 'UTC' });
    const createRes = await request(app).post('/api/v1/accounts')
      .send({ meta_account_id: 'act_refresh2', access_token: 'original-token-2' });
    const accountId = createRes.body.data.id;
    const before = testDb.db.get('SELECT access_token_encrypted FROM ad_accounts WHERE id = ?', [accountId]);

    nock(BASE).get(`/${VERSION}/act_refresh2`).query(q => q.fields === 'id')
      .reply(400, { error: { message: 'Invalid OAuth access token', code: 190 } });

    const res = await request(app)
      .post(`/api/v1/accounts/${accountId}/token`)
      .send({ access_token: 'bad-new-token' });

    expect(res.status).toBe(400);
    const after = testDb.db.get('SELECT access_token_encrypted FROM ad_accounts WHERE id = ?', [accountId]);
    expect(after.access_token_encrypted).toBe(before.access_token_encrypted); // unchanged
  });

  test('POST /accounts/:id/token 404s for an unknown account id', async () => {
    const res = await request(app)
      .post('/api/v1/accounts/00000000-0000-0000-0000-000000000000/token')
      .send({ access_token: 'x' });
    expect(res.status).toBe(404);
  });
});
