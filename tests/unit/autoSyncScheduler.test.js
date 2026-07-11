'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { runDueAccounts, getSchedulerStatus, getPerAccountStatus } = require('../../src/services/autoSyncScheduler');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

function insertAccount(testDb, overrides = {}) {
  const id = uuidv4();
  const metaId = overrides.meta_account_id || `act_auto_${id.slice(0, 8)}`;
  testDb.db.run(
    `INSERT INTO ad_accounts (
       id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid,
       auto_sync_enabled, auto_sync_interval_minutes, last_sync_completed_at, created_at, updated_at
     ) VALUES (?, ?, 'Auto Sync Test', ?, 'active', 1, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id, metaId, encryptToken('fake-token'),
      overrides.auto_sync_enabled ? 1 : 0,
      overrides.auto_sync_interval_minutes ?? 60,
      overrides.last_sync_completed_at ?? null,
    ]
  );
  return { id, meta_account_id: metaId };
}

describe('autoSyncScheduler.runDueAccounts', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ad_accounts');
  });

  test('syncs an account whose interval has elapsed since its last completed sync', async () => {
    const overdue = insertAccount(testDb, {
      auto_sync_enabled: true,
      auto_sync_interval_minutes: 5,
      last_sync_completed_at: new Date(Date.now() - 10 * 60000).toISOString(), // 10 min ago > 5 min interval
    });

    nock(BASE).get(`/${VERSION}/${overdue.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
    // smartSyncEngine's metadata tier (account info refresh) is also due for
    // a never-before-synced account (no sync_entity_state row yet).
    nock(BASE).get(`/${VERSION}/${overdue.meta_account_id}`).query(true)
      .reply(200, { id: overdue.meta_account_id, name: 'Auto Sync Test', currency: 'USD', timezone_name: 'UTC' });

    await runDueAccounts();

    const row = testDb.db.get('SELECT last_sync_status FROM ad_accounts WHERE id = ?', [overdue.id]);
    expect(row.last_sync_status).toBe('success');
  });

  test('does not sync an account whose interval has not yet elapsed', async () => {
    const fresh = insertAccount(testDb, {
      auto_sync_enabled: true,
      auto_sync_interval_minutes: 60,
      last_sync_completed_at: new Date(Date.now() - 5 * 60000).toISOString(), // 5 min ago < 60 min interval
    });

    // No nock interceptor registered -- if the scheduler tried to sync this
    // account, the real HTTP call would throw (nock blocks unmocked
    // requests), which would fail this test.
    await runDueAccounts();

    const row = testDb.db.get('SELECT last_sync_status FROM ad_accounts WHERE id = ?', [fresh.id]);
    expect(row.last_sync_status).toBe('idle');
  });

  test('does not sync an account with auto_sync_enabled=0', async () => {
    const disabled = insertAccount(testDb, {
      auto_sync_enabled: false,
      auto_sync_interval_minutes: 5,
      last_sync_completed_at: new Date(Date.now() - 60 * 60000).toISOString(),
    });

    await runDueAccounts();

    const row = testDb.db.get('SELECT last_sync_status FROM ad_accounts WHERE id = ?', [disabled.id]);
    expect(row.last_sync_status).toBe('idle');
  });

  test('treats an account that has never synced (null last_sync_completed_at) as immediately due', async () => {
    const neverSynced = insertAccount(testDb, {
      auto_sync_enabled: true,
      auto_sync_interval_minutes: 60,
      last_sync_completed_at: null,
    });

    nock(BASE).get(`/${VERSION}/${neverSynced.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
    nock(BASE).get(`/${VERSION}/${neverSynced.meta_account_id}`).query(true)
      .reply(200, { id: neverSynced.meta_account_id, name: 'Auto Sync Test', currency: 'USD', timezone_name: 'UTC' });

    await runDueAccounts();

    const row = testDb.db.get('SELECT last_sync_status FROM ad_accounts WHERE id = ?', [neverSynced.id]);
    expect(row.last_sync_status).toBe('success');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scheduler Auto Discovery (Task 4) -- runDueAccounts() re-queries
  // ad_accounts fresh on every call (no cached/held-over account list), so
  // newly added/removed/reconnected accounts are picked up on the very next
  // tick with zero restart, zero manual refresh, zero cache to clear.
  // ═══════════════════════════════════════════════════════════════════
  describe('auto discovery — no restart required', () => {
    test('an account inserted after an earlier tick already ran is synced on the very next tick', async () => {
      // First tick: nothing exists yet.
      await runDueAccounts();

      // Simulates a brand-new account connected via POST /accounts while the
      // scheduler's setInterval loop is already running in the background.
      const justAdded = insertAccount(testDb, { auto_sync_enabled: true, auto_sync_interval_minutes: 60, last_sync_completed_at: null });
      nock(BASE).get(`/${VERSION}/${justAdded.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      nock(BASE).get(`/${VERSION}/${justAdded.meta_account_id}`).query(true)
        .reply(200, { id: justAdded.meta_account_id, name: 'Auto Sync Test', currency: 'USD', timezone_name: 'UTC' });

      await runDueAccounts(); // next tick -- no restart, no code path re-init

      const row = testDb.db.get('SELECT last_sync_status FROM ad_accounts WHERE id = ?', [justAdded.id]);
      expect(row.last_sync_status).toBe('success');
    });

    test('a disconnected account is excluded starting the very next tick, and resumes once reconnected', async () => {
      const account = insertAccount(testDb, { auto_sync_enabled: true, auto_sync_interval_minutes: 5, last_sync_completed_at: null });
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}`).query(true)
        .reply(200, { id: account.meta_account_id, name: 'Auto Sync Test', currency: 'USD', timezone_name: 'UTC' });
      await runDueAccounts();
      expect(testDb.db.get('SELECT last_sync_status FROM ad_accounts WHERE id = ?', [account.id]).last_sync_status).toBe('success');

      // "Removed" via the same soft-disconnect DELETE /accounts/:id uses.
      testDb.db.run(`UPDATE ad_accounts SET status = 'disconnected' WHERE id = ?`, [account.id]);
      testDb.db.run(`UPDATE ad_accounts SET last_sync_completed_at = ? WHERE id = ?`,
        [new Date(Date.now() - 60 * 60000).toISOString(), account.id]); // well past due, if it were still eligible

      // No new nock interceptors -- a sync attempt here would throw.
      await runDueAccounts();

      // "Reconnected" -- flip status back to active.
      testDb.db.run(`UPDATE ad_accounts SET status = 'active' WHERE id = ?`, [account.id]);
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}`).query(true)
        .reply(200, { id: account.meta_account_id, name: 'Auto Sync Test', currency: 'USD', timezone_name: 'UTC' });

      await runDueAccounts();
      const row = testDb.db.get('SELECT last_sync_status, last_sync_completed_at FROM ad_accounts WHERE id = ?', [account.id]);
      expect(row.last_sync_status).toBe('success');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Executive Sync Status per-account breakdown (Task 5 / Task 6)
  // ═══════════════════════════════════════════════════════════════════
  describe('per-account status', () => {
    test('a disabled account reports scheduler_state "disabled" with no next_scheduled_sync_at', () => {
      const account = insertAccount(testDb, { auto_sync_enabled: false });
      const rows = getPerAccountStatus();
      const row = rows.find(r => r.id === account.id);
      expect(row.auto_sync_enabled).toBe(false);
      expect(row.scheduler_state).toBe('disabled');
      expect(row.next_scheduled_sync_at).toBeNull();
    });

    test('a disconnected account reports scheduler_state "disconnected" even if auto_sync_enabled=1', () => {
      const account = insertAccount(testDb, { auto_sync_enabled: true });
      testDb.db.run(`UPDATE ad_accounts SET status = 'disconnected' WHERE id = ?`, [account.id]);
      const row = getPerAccountStatus().find(r => r.id === account.id);
      expect(row.scheduler_state).toBe('disconnected');
    });

    test('an enabled, never-synced account reports "due now" and is discoverable via getSchedulerStatus().per_account', () => {
      const account = insertAccount(testDb, { auto_sync_enabled: true, auto_sync_interval_minutes: 60, last_sync_completed_at: null });
      const status = getSchedulerStatus();
      const row = status.per_account.find(r => r.id === account.id);
      expect(row).toBeDefined();
      expect(row.auto_sync_enabled).toBe(true);
      expect(row.next_scheduled_sync_at).toBe('due now (never synced)');
      expect(Array.isArray(row.freshness)).toBe(true);
    });

    test('an account currently mid-sync reports scheduler_state "syncing" and its current tier', async () => {
      const account = insertAccount(testDb, { auto_sync_enabled: true, auto_sync_interval_minutes: 5, last_sync_completed_at: null });
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true)
        .reply(function () {
          // Snapshot per-account status WHILE this request is in flight --
          // proves scheduler_state/current_sync_tier reflect the live cycle,
          // not just a post-hoc read.
          const row = getPerAccountStatus().find(r => r.id === account.id);
          expect(row.scheduler_state).toBe('syncing');
          expect(row.current_sync_tier).toBe('campaigns');
          return [200, { data: [] }];
        });
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}`).query(true)
        .reply(200, { id: account.meta_account_id, name: 'Auto Sync Test', currency: 'USD', timezone_name: 'UTC' });

      await runDueAccounts();

      // After the cycle completes, no longer "syncing".
      const after = getPerAccountStatus().find(r => r.id === account.id);
      expect(after.scheduler_state).not.toBe('syncing');
    });
  });
});
