'use strict';

/**
 * refreshAllActiveAccounts() (src/api/routes/sync.js) is the shared
 * orchestration both POST /sync/refresh-active and the Vercel Cron trigger
 * route (src/api/routes/cron.js) call. It loops over every active,
 * token-valid account and calls smartSyncEngine.forceSyncActiveAccount()
 * for each. Found during the Neon Development migration mission: this loop
 * had no per-account try/catch, so a single account throwing (e.g.
 * decryptToken() failing on a corrupted/rotated-key token -- the exact
 * failure mode this migration itself produces, since Neon Development's
 * TOKEN_ENCRYPTION_KEY is deliberately different from the source
 * environment's) would abort the entire cron run, silently skipping every
 * account still queued behind it. syncService.js's syncAccount() already
 * guards against this exact failure per-account (see its "Automatic
 * Recovery" comment); this test proves the same guarantee now holds here.
 */

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');

describe('sync.refreshAllActiveAccounts — one account throwing does not abort the batch', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('a later account still gets processed after an earlier account throws', async () => {
    const brokenId = uuidv4();
    const healthyId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, created_at, updated_at)
       VALUES (?, 'act_refresh_broken', 'Refresh Broken', ?, 'active', 1, datetime('now'), datetime('now'))`,
      [brokenId, encryptToken('fake-token')]
    );
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, created_at, updated_at)
       VALUES (?, 'act_refresh_healthy', 'Refresh Healthy', ?, 'active', 1, datetime('now'), datetime('now'))`,
      [healthyId, encryptToken('fake-token')]
    );

    const smartSyncEngine = require('../../src/services/smartSyncEngine');
    jest.spyOn(smartSyncEngine, 'forceSyncActiveAccount').mockImplementation(async (account) => {
      if (account.id === brokenId) {
        throw new Error('Unsupported state or unable to authenticate data');
      }
      return {
        accountId: account.id, metaAccountId: account.meta_account_id,
        campaigns: { synced: 1, errors: 0 }, adSets: { synced: 0, errors: 0 }, ads: { synced: 0, errors: 0 },
        errors: [], warnings: [],
      };
    });

    const { refreshAllActiveAccounts } = require('../../src/api/routes/sync');
    const { accounts_synced, results } = await refreshAllActiveAccounts();

    expect(accounts_synced).toBe(2);
    const brokenResult = results.find(r => r.accountId === brokenId);
    const healthyResult = results.find(r => r.accountId === healthyId);

    expect(brokenResult.errors).toEqual([{ level: 'account', message: 'Unsupported state or unable to authenticate data' }]);
    expect(healthyResult.errors).toEqual([]);
    expect(healthyResult.campaigns.synced).toBe(1);

    smartSyncEngine.forceSyncActiveAccount.mockRestore();
  });
});
