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

  // ─────────────────────────────────────────────
  // Multi Meta Ad Account Management milestone
  // ─────────────────────────────────────────────

  test('POST /accounts accepts account_name/business_name/notes and PATCH updates them', async () => {
    nock(BASE).get(`/${VERSION}/act_fields`).query(true)
      .reply(200, { id: 'act_fields', name: 'Meta Default Name', currency: 'USD', timezone_name: 'UTC' });

    const createRes = await request(app).post('/api/v1/accounts').send({
      meta_account_id: 'act_fields',
      access_token: 'tok',
      account_name: 'My Custom Name',
      business_name: 'Acme Inc',
      notes: 'Primary store account',
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.account_name).toBe('My Custom Name');
    expect(createRes.body.data.business_name).toBe('Acme Inc');
    expect(createRes.body.data.notes).toBe('Primary store account');

    const id = createRes.body.data.id;
    const patchRes = await request(app).patch(`/api/v1/accounts/${id}`).send({
      business_name: 'Acme Holdings', notes: 'Updated notes',
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.business_name).toBe('Acme Holdings');
    expect(patchRes.body.data.notes).toBe('Updated notes');
  });

  test('PATCH /accounts/:id status=paused disables and status=active re-enables an account', async () => {
    nock(BASE).get(`/${VERSION}/act_toggle`).query(true)
      .reply(200, { id: 'act_toggle', name: 'Toggle Test', currency: 'USD', timezone_name: 'UTC' });
    const createRes = await request(app).post('/api/v1/accounts')
      .send({ meta_account_id: 'act_toggle', access_token: 'tok' });
    const id = createRes.body.data.id;

    const disableRes = await request(app).patch(`/api/v1/accounts/${id}`).send({ status: 'paused' });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.data.status).toBe('paused');

    const enableRes = await request(app).patch(`/api/v1/accounts/${id}`).send({ status: 'active' });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.data.status).toBe('active');
  });

  describe('Smart Auto Sync — enabled by default (Tasks 1-3)', () => {
    test('a newly connected account is auto_sync_enabled=true immediately, with no user configuration recorded yet', async () => {
      nock(BASE).get(`/${VERSION}/act_autoon`).query(true)
        .reply(200, { id: 'act_autoon', name: 'Auto On Test', currency: 'USD', timezone_name: 'UTC' });

      const res = await request(app).post('/api/v1/accounts')
        .send({ meta_account_id: 'act_autoon', access_token: 'tok' });

      expect(res.status).toBe(201);
      expect(res.body.data.auto_sync_enabled).toBe(true);

      const row = testDb.db.get(
        'SELECT auto_sync_enabled, auto_sync_interval_minutes, auto_sync_user_configured_at, status, token_is_valid FROM ad_accounts WHERE id = ?',
        [res.body.data.id]
      );
      expect(row.auto_sync_enabled).toBe(1);
      expect(row.auto_sync_interval_minutes).toBe(60); // stored default sync configuration
      expect(row.auto_sync_user_configured_at).toBeNull();

      // Immediately visible to the Scheduler's own eligibility query
      // (autoSyncScheduler.js) -- status/token_is_valid are already correct
      // from account creation, so auto_sync_enabled=1 alone makes it eligible.
      expect(row.status).toBe('active');
      expect(row.token_is_valid).toBe(1);
    });

    test('explicitly disabling Auto Sync via PATCH stamps auto_sync_user_configured_at and is never silently re-enabled', async () => {
      nock(BASE).get(`/${VERSION}/act_userdisabled`).query(true)
        .reply(200, { id: 'act_userdisabled', name: 'User Disabled Test', currency: 'USD', timezone_name: 'UTC' });
      const createRes = await request(app).post('/api/v1/accounts')
        .send({ meta_account_id: 'act_userdisabled', access_token: 'tok' });
      const id = createRes.body.data.id;
      expect(createRes.body.data.auto_sync_enabled).toBe(true); // on by default

      const disableRes = await request(app).patch(`/api/v1/accounts/${id}`).send({ auto_sync_enabled: false });
      expect(disableRes.status).toBe(200);
      expect(disableRes.body.data.auto_sync_enabled).toBe(false);
      expect(disableRes.body.data.auto_sync_user_configured_at).toBeTruthy();

      // An unrelated PATCH (e.g. editing notes) must not touch auto-sync state.
      const notesRes = await request(app).patch(`/api/v1/accounts/${id}`).send({ notes: 'unrelated edit' });
      expect(notesRes.status).toBe(200);
      expect(notesRes.body.data.auto_sync_enabled).toBe(false);

      // Re-running the one-time migration pass must never flip this back on
      // (Task 2: respect existing/explicit user choice).
      const { runPhase18Migrations } = require('../../src/db/schema.phase18');
      runPhase18Migrations();
      const row = testDb.db.get('SELECT auto_sync_enabled FROM ad_accounts WHERE id = ?', [id]);
      expect(row.auto_sync_enabled).toBe(0);
    });

    test('the one-time migration never touches a pre-existing account\'s current auto_sync_enabled value (0 or 1), only ever a genuine NULL', async () => {
      const { v4: uuidv4 } = require('uuid');
      const { encryptToken } = require('../../src/services/tokenCrypto');
      const legacyOffId = uuidv4();
      const legacyOnId = uuidv4();
      testDb.db.run(
        `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, auto_sync_enabled, created_at, updated_at)
         VALUES (?, 'act_legacy_off', 'Legacy Off', ?, 'active', 1, 0, datetime('now'), datetime('now'))`,
        [legacyOffId, encryptToken('tok')]
      );
      testDb.db.run(
        `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, auto_sync_enabled, created_at, updated_at)
         VALUES (?, 'act_legacy_on', 'Legacy On', ?, 'active', 1, 1, datetime('now'), datetime('now'))`,
        [legacyOnId, encryptToken('tok')]
      );

      const { runPhase18Migrations } = require('../../src/db/schema.phase18');
      runPhase18Migrations();

      expect(testDb.db.get('SELECT auto_sync_enabled FROM ad_accounts WHERE id = ?', [legacyOffId]).auto_sync_enabled).toBe(0);
      expect(testDb.db.get('SELECT auto_sync_enabled FROM ad_accounts WHERE id = ?', [legacyOnId]).auto_sync_enabled).toBe(1);
    });
  });

  test('PATCH /accounts/:id auto_sync_interval_minutes rejects a value below 5', async () => {
    nock(BASE).get(`/${VERSION}/act_autosync`).query(true)
      .reply(200, { id: 'act_autosync', name: 'Autosync Test', currency: 'USD', timezone_name: 'UTC' });
    const createRes = await request(app).post('/api/v1/accounts')
      .send({ meta_account_id: 'act_autosync', access_token: 'tok' });
    const id = createRes.body.data.id;

    const res = await request(app).patch(`/api/v1/accounts/${id}`).send({ auto_sync_enabled: true, auto_sync_interval_minutes: 2 });
    expect(res.status).toBe(400);
  });

  test('DELETE /accounts/:id soft-removes the account: status becomes disconnected, row and history are kept', async () => {
    nock(BASE).get(`/${VERSION}/act_remove`).query(true)
      .reply(200, { id: 'act_remove', name: 'Remove Test', currency: 'USD', timezone_name: 'UTC' });
    const createRes = await request(app).post('/api/v1/accounts')
      .send({ meta_account_id: 'act_remove', access_token: 'tok' });
    const id = createRes.body.data.id;

    const delRes = await request(app).delete(`/api/v1/accounts/${id}`);
    expect(delRes.status).toBe(200);

    const row = testDb.db.get('SELECT status FROM ad_accounts WHERE id = ?', [id]);
    expect(row).not.toBeNull(); // row still exists -- not a hard delete
    expect(row.status).toBe('disconnected');

    // Excluded from "active"-filtered listings such as auto-sync eligibility
    const activeRows = testDb.db.all("SELECT id FROM ad_accounts WHERE status = 'active' AND id = ?", [id]);
    expect(activeRows.length).toBe(0);
  });

  test('DELETE /accounts/:id 404s for an unknown account id', async () => {
    const res = await request(app).delete('/api/v1/accounts/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  describe('POST /accounts/:id/test-connection', () => {
    test('reports account_exists/token_valid/currency/timezone/business_name/active_status/permissions on full success', async () => {
      nock(BASE).get(`/${VERSION}/act_testconn`).query(true)
        .reply(200, { id: 'act_testconn', name: 'Test Conn', currency: 'USD', timezone_name: 'UTC' });
      const createRes = await request(app).post('/api/v1/accounts')
        .send({ meta_account_id: 'act_testconn', access_token: 'tok' });
      const id = createRes.body.data.id;

      nock(BASE).get(`/${VERSION}/act_testconn`).query(q => q.fields && q.fields.includes('account_status'))
        .reply(200, {
          id: 'act_testconn', currency: 'EGP', timezone_name: 'Africa/Cairo',
          business_name: 'Acme Egypt', account_status: 1,
        });
      nock(BASE).get(`/${VERSION}/me/permissions`).query(true)
        .reply(200, { data: [{ permission: 'ads_management', status: 'granted' }, { permission: 'email', status: 'declined' }] });

      const res = await request(app).post(`/api/v1/accounts/${id}/test-connection`).send({});
      expect(res.status).toBe(200);
      const r = res.body.data;
      expect(r.account_exists).toBe(true);
      expect(r.token_valid).toBe(true);
      expect(r.currency).toBe('EGP');
      expect(r.timezone).toBe('Africa/Cairo');
      expect(r.business_name).toBe('Acme Egypt');
      expect(r.active_status).toBe(true);
      expect(r.permissions).toEqual(['ads_management']);
      expect(r.errors).toEqual([]);
    });

    test('reports token_valid:false and a collected error when Meta rejects the token, without throwing', async () => {
      nock(BASE).get(`/${VERSION}/act_testconn_bad`).query(true)
        .reply(200, { id: 'act_testconn_bad', name: 'Test Conn Bad', currency: 'USD', timezone_name: 'UTC' });
      const createRes = await request(app).post('/api/v1/accounts')
        .send({ meta_account_id: 'act_testconn_bad', access_token: 'tok' });
      const id = createRes.body.data.id;

      nock(BASE).get(`/${VERSION}/act_testconn_bad`).query(q => q.fields && q.fields.includes('account_status'))
        .reply(400, { error: { message: 'Invalid OAuth access token', code: 190 } });
      nock(BASE).get(`/${VERSION}/me/permissions`).query(true)
        .reply(400, { error: { message: 'Invalid OAuth access token', code: 190 } });

      const res = await request(app).post(`/api/v1/accounts/${id}/test-connection`).send({});
      expect(res.status).toBe(200); // the endpoint itself succeeds; failures are reported in the body
      const r = res.body.data;
      expect(r.account_exists).toBe(false);
      expect(r.token_valid).toBe(false);
      expect(r.errors.length).toBe(2);
      expect(r.errors.map(e => e.check).sort()).toEqual(['account', 'permissions']);
    });

    test('404s for an unknown account id', async () => {
      const res = await request(app).post('/api/v1/accounts/00000000-0000-0000-0000-000000000000/test-connection').send({});
      expect(res.status).toBe(404);
    });
  });

  describe('GET /accounts/:id/sync-status', () => {
    test('returns the sync-tracking fields for a never-synced account, with Auto Sync on by default', async () => {
      nock(BASE).get(`/${VERSION}/act_syncstatus`).query(true)
        .reply(200, { id: 'act_syncstatus', name: 'Sync Status Test', currency: 'USD', timezone_name: 'UTC' });
      const createRes = await request(app).post('/api/v1/accounts')
        .send({ meta_account_id: 'act_syncstatus', access_token: 'tok' });
      const id = createRes.body.data.id;

      const res = await request(app).get(`/api/v1/accounts/${id}/sync-status`);
      expect(res.status).toBe(200);
      expect(res.body.data.last_sync_status).toBe('idle');
      expect(res.body.data.last_sync_started_at).toBeNull();
      // Smart Auto Sync: a newly connected, verified account is managed by
      // the Scheduler immediately -- no manual opt-in required.
      expect(res.body.data.auto_sync_enabled).toBe(true);
      expect(res.body.data.auto_sync_user_configured_at).toBeNull();
    });

    test('404s for an unknown account id', async () => {
      const res = await request(app).get('/api/v1/accounts/00000000-0000-0000-0000-000000000000/sync-status');
      expect(res.status).toBe(404);
    });
  });
});
