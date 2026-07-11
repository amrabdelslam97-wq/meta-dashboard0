'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { recoverInterruptedSyncs } = require('../../src/services/syncService');
const { encryptToken } = require('../../src/services/tokenCrypto');

function insertAccount(testDb, overrides = {}) {
  const id = uuidv4();
  testDb.db.run(
    `INSERT INTO ad_accounts (
       id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid,
       last_sync_status, last_sync_started_at, last_sync_error, created_at, updated_at
     ) VALUES (?, ?, 'Recovery Test', ?, 'active', 1, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      overrides.meta_account_id || `act_recovery_${id.slice(0, 8)}`,
      encryptToken('fake-token'),
      overrides.last_sync_status ?? 'running',
      overrides.last_sync_started_at ?? null,
      overrides.last_sync_error ?? null,
    ]
  );
  return id;
}

describe('syncService.recoverInterruptedSyncs', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  afterEach(() => {
    testDb.db.run('DELETE FROM ad_accounts');
  });

  test('marks a sync stuck "running" past the timeout as failed, with completed_at set and a recovery note', () => {
    const id = insertAccount(testDb, {
      last_sync_status: 'running',
      last_sync_started_at: new Date(Date.now() - 45 * 60000).toISOString(), // 45 min ago
    });

    const result = recoverInterruptedSyncs(30); // 30 min timeout

    expect(result.recovered).toBe(1);
    expect(result.accounts).toContain(id);

    const row = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [id]);
    expect(row.last_sync_status).toBe('failed');
    expect(row.last_sync_completed_at).toBeTruthy();
    expect(row.last_failed_sync_at).toBeTruthy();
    expect(row.sync_progress_phase).toBeNull();
    expect(row.last_sync_error).toBe('Recovered after interrupted server shutdown.');
  });

  test('does not touch a sync that is "running" but still within the timeout window (genuinely in progress)', () => {
    const id = insertAccount(testDb, {
      last_sync_status: 'running',
      last_sync_started_at: new Date(Date.now() - 5 * 60000).toISOString(), // 5 min ago
    });

    const result = recoverInterruptedSyncs(30);

    expect(result.recovered).toBe(0);
    const row = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [id]);
    expect(row.last_sync_status).toBe('running');
    expect(row.last_sync_completed_at).toBeNull();
  });

  test('does not touch accounts that are not "running" (idle/success/failed)', () => {
    insertAccount(testDb, { last_sync_status: 'idle', last_sync_started_at: null });
    insertAccount(testDb, {
      last_sync_status: 'success',
      last_sync_started_at: new Date(Date.now() - 60 * 60000).toISOString(),
    });

    const result = recoverInterruptedSyncs(30);
    expect(result.recovered).toBe(0);
  });

  test('a "running" row with no last_sync_started_at at all is left alone (cannot determine staleness)', () => {
    const id = insertAccount(testDb, { last_sync_status: 'running', last_sync_started_at: null });

    const result = recoverInterruptedSyncs(30);

    expect(result.recovered).toBe(0);
    const row = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [id]);
    expect(row.last_sync_status).toBe('running');
  });

  test('appends to (does not clobber) a pre-existing last_sync_error', () => {
    const id = insertAccount(testDb, {
      last_sync_status: 'running',
      last_sync_started_at: new Date(Date.now() - 45 * 60000).toISOString(),
      last_sync_error: 'Some earlier error message',
    });

    recoverInterruptedSyncs(30);

    const row = testDb.db.get('SELECT last_sync_error FROM ad_accounts WHERE id = ?', [id]);
    expect(row.last_sync_error).toBe('Some earlier error message | Recovered after interrupted server shutdown.');
  });

  test('recovers multiple stuck accounts in one pass and leaves a fresh one alone', () => {
    const stuck1 = insertAccount(testDb, { last_sync_status: 'running', last_sync_started_at: new Date(Date.now() - 40 * 60000).toISOString() });
    const stuck2 = insertAccount(testDb, { last_sync_status: 'running', last_sync_started_at: new Date(Date.now() - 120 * 60000).toISOString() });
    const fresh  = insertAccount(testDb, { last_sync_status: 'running', last_sync_started_at: new Date(Date.now() - 2 * 60000).toISOString() });

    const result = recoverInterruptedSyncs(30);

    expect(result.recovered).toBe(2);
    expect(result.accounts.sort()).toEqual([stuck1, stuck2].sort());
    const freshRow = testDb.db.get('SELECT last_sync_status FROM ad_accounts WHERE id = ?', [fresh]);
    expect(freshRow.last_sync_status).toBe('running');
  });

  test('respects the SYNC_RECOVERY_TIMEOUT_MINUTES default (30) when no argument is passed', () => {
    const id = insertAccount(testDb, {
      last_sync_status: 'running',
      last_sync_started_at: new Date(Date.now() - 31 * 60000).toISOString(),
    });

    const result = recoverInterruptedSyncs(); // no arg -> default 30

    expect(result.recovered).toBe(1);
    expect(result.accounts).toContain(id);
  });

  test('a recovered account becomes eligible for the Smart Scheduler\'s normal due-check again (no permanent lock)', () => {
    const id = insertAccount(testDb, {
      last_sync_status: 'running',
      last_sync_started_at: new Date(Date.now() - 45 * 60000).toISOString(),
    });
    testDb.db.run(
      `UPDATE ad_accounts SET auto_sync_enabled = 1, auto_sync_interval_minutes = 60 WHERE id = ?`,
      [id]
    );

    recoverInterruptedSyncs(30);

    // Same query shape autoSyncScheduler.runDueAccounts() uses to find
    // eligible accounts -- proves recovery doesn't add any exclusion.
    const eligible = testDb.db.get(
      `SELECT id FROM ad_accounts WHERE id = ? AND auto_sync_enabled = 1 AND status = 'active' AND token_is_valid = 1`,
      [id]
    );
    expect(eligible).toBeTruthy();
  });
});
