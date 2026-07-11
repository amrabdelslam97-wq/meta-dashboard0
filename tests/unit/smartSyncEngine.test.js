'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

function insertAccount(testDb, overrides = {}) {
  const id = uuidv4();
  const metaId = overrides.meta_account_id || `act_smart_${id.slice(0, 8)}`;
  testDb.db.run(
    `INSERT INTO ad_accounts (
       id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid,
       attribution_window_days, created_at, updated_at
     ) VALUES (?, ?, 'Smart Sync Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
    [id, metaId, encryptToken('fake-token')]
  );
  return { id, meta_account_id: metaId };
}

function mockAccountInfo(metaId) {
  nock(BASE).get(`/${VERSION}/${metaId}`).query(true)
    .reply(200, { id: metaId, name: 'Smart Sync Test', currency: 'USD', timezone_name: 'UTC' });
}

describe('smartSyncEngine', () => {
  let testDb;
  let smartSyncEngine;

  beforeAll(async () => {
    testDb = await createTestDb();
    smartSyncEngine = require('../../src/services/smartSyncEngine');
  });

  afterAll(() => {
    testDb.cleanup();
  });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM sync_entity_state');
    testDb.db.run('DELETE FROM sync_execution_log');
  });

  describe('schedule config', () => {
    test('returns the spec default intervals when nothing has been customized', () => {
      const config = smartSyncEngine.getScheduleConfig();
      expect(config).toEqual({
        insights: 15, campaigns: 60, adsets: 60, ads: 60, creatives: 1440, metadata: 1440,
        analytics: 360, // Executive Marketing Analytics Layer tier (Phase 17)
      });
    });

    test('setScheduleInterval persists a custom interval and rejects invalid input', () => {
      smartSyncEngine.setScheduleInterval('insights', 5);
      expect(smartSyncEngine.getScheduleConfig().insights).toBe(5);

      expect(() => smartSyncEngine.setScheduleInterval('not_a_real_tier', 10)).toThrow();
      expect(() => smartSyncEngine.setScheduleInterval('insights', 0)).toThrow();

      // restore default so later tests in this file aren't affected
      smartSyncEngine.setScheduleInterval('insights', 15);
    });
  });

  describe('runDueForAccount', () => {
    test('a never-synced account runs every tier once and checkpoints each entity type', async () => {
      const account = insertAccount(testDb);
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');

      expect(result.ranAny).toBe(true);
      expect(result.ranTiers).toEqual(
        expect.arrayContaining(['insights', 'campaigns', 'adsets', 'ads', 'creatives', 'metadata', 'analytics'])
      );

      const states = testDb.db.all('SELECT entity_type FROM sync_entity_state WHERE ad_account_id = ?', [account.id]);
      expect(states.map(s => s.entity_type).sort()).toEqual(
        ['ads', 'adsets', 'analytics', 'campaigns', 'creatives', 'insights', 'metadata']
      );

      const logRows = testDb.db.all('SELECT entity_type, source, status FROM sync_execution_log WHERE ad_account_id = ?', [account.id]);
      expect(logRows.length).toBe(7); // 6 original tiers + the new 'analytics' tier (Phase 17)
      expect(logRows.every(r => r.source === 'scheduler')).toBe(true);
    });

    test('re-running immediately after does not re-fetch anything (nothing is due yet)', async () => {
      const account = insertAccount(testDb);
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');

      // No nock interceptors registered for this second call -- if the engine
      // tried to hit Meta again, the request would throw.
      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');
      expect(result.ranAny).toBe(false);
    });

    test('forceSyncAccount bypasses the due-check even when nothing is due', async () => {
      const account = insertAccount(testDb);
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');

      // Immediately force-sync again -- everything is fresh, but Force Sync
      // must still run every tier.
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const summary = await smartSyncEngine.forceSyncAccount(fullAccount);
      expect(summary.campaigns.synced).toBe(0);

      const logRows = testDb.db.all(
        "SELECT entity_type FROM sync_execution_log WHERE ad_account_id = ? AND source = 'force'",
        [account.id]
      );
      expect(logRows.length).toBe(7); // 6 original tiers + the new 'analytics' tier (Phase 17)
    });

    test('a rate-limited campaign fetch is recorded and re-thrown so the scheduler can back the account off', async () => {
      const account = insertAccount(testDb);
      // Meta rate-limit error code 17, returned as HTTP 400 (not 429) exactly
      // like metaApiClient.js's own doc comment describes -- and repeated
      // MAX_RETRIES+1 times so metaGet's internal retry budget is exhausted
      // and the error actually surfaces here instead of being retried away.
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true)
        .times(4)
        .reply(400, { error: { message: 'User request limit reached', code: 17 } });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      await expect(smartSyncEngine.runDueForAccount(fullAccount, 'scheduler')).rejects.toThrow();

      const logRow = testDb.db.get(
        "SELECT * FROM sync_execution_log WHERE ad_account_id = ? AND entity_type = 'campaigns'",
        [account.id]
      );
      expect(logRow.rate_limited).toBe(1);
      expect(logRow.status).toBe('failed');
    }, 45_000);
  });

  describe('getEntityFreshness', () => {
    test('reports is_stale based on the configured interval for that entity type', async () => {
      const account = insertAccount(testDb);
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');

      const freshness = smartSyncEngine.getEntityFreshness(account.id);
      const insights = freshness.find(f => f.entity_type === 'insights');
      expect(insights.is_stale).toBe(false);
      expect(insights.interval_minutes).toBe(15);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // One-Time Effective Status Backfill (Task 3)
  // ═══════════════════════════════════════════════════════════════════
  describe('lifecycle effective_status backfill', () => {
    function insertLegacyCampaign(accountId, metaCampaignId) {
      const id = uuidv4();
      testDb.db.run(
        `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, effective_status, created_at, updated_at)
         VALUES (?, ?, ?, 'Legacy Campaign', 'engagement', 'active', NULL, datetime('now'), datetime('now'))`,
        [id, accountId, metaCampaignId]
      );
      return id;
    }

    test('needsLifecycleBackfill is true when a campaign has NULL effective_status, false once populated', () => {
      const account = insertAccount(testDb);
      insertLegacyCampaign(account.id, 'camp_legacy_1');
      expect(smartSyncEngine.needsLifecycleBackfill(account.id)).toBe(true);

      testDb.db.run(`UPDATE campaigns SET effective_status = 'ACTIVE' WHERE ad_account_id = ?`, [account.id]);
      expect(smartSyncEngine.needsLifecycleBackfill(account.id)).toBe(false);
    });

    test('needsLifecycleBackfill is false for an account with no campaigns at all (nothing to backfill)', () => {
      const account = insertAccount(testDb);
      expect(smartSyncEngine.needsLifecycleBackfill(account.id)).toBe(false);
    });

    test('a legacy account with NULL effective_status gets its campaigns/adsets/ads tree force-synced even though nothing was due on its own interval, and is then marked complete', async () => {
      const account = insertAccount(testDb);
      insertLegacyCampaign(account.id, 'camp_legacy_2');

      // Simulate "already synced recently" for every tier via sync_entity_state,
      // so none of them would normally be due -- only the backfill escalation
      // should force campaigns/adsets/ads to run this cycle.
      const now = new Date().toISOString();
      for (const entityType of smartSyncEngine.ENTITY_TYPES) {
        testDb.db.run(
          `INSERT INTO sync_entity_state (id, ad_account_id, entity_type, last_sync_completed_at, last_success_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), account.id, entityType, now, now, now, now]
        );
      }

      // Mocked Meta response now returns effective_status -- exactly what a
      // real post-Phase-15 sync would already provide, no new field/call shape.
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true)
        .reply(200, { data: [{ id: 'camp_legacy_2', name: 'Legacy Campaign', objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', effective_status: 'ACTIVE' }] });
      nock(BASE).get(`/${VERSION}/camp_legacy_2/adsets`).query(true).reply(200, { data: [] });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(fullAccount.lifecycle_backfill_completed_at).toBeNull();

      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');

      expect(result.backfillPending).toBe(true);
      expect(result.ranTiers).toEqual(expect.arrayContaining(['campaigns', 'adsets', 'ads']));
      // Insights/metadata/creatives were genuinely fresh (just seeded above)
      // and must NOT be forced -- backfill escalates only the
      // campaigns/adsets/ads tiers that actually carry effective_status.
      expect(result.ranTiers).not.toContain('insights');
      expect(result.ranTiers).not.toContain('metadata');
      expect(result.ranTiers).not.toContain('creatives');

      const campaignRow = testDb.db.get('SELECT effective_status FROM campaigns WHERE meta_campaign_id = ?', ['camp_legacy_2']);
      expect(campaignRow.effective_status).toBe('ACTIVE');

      const updatedAccount = testDb.db.get('SELECT lifecycle_backfill_completed_at FROM ad_accounts WHERE id = ?', [account.id]);
      expect(updatedAccount.lifecycle_backfill_completed_at).toBeTruthy();
    });

    test('once marked complete, a subsequent cycle does not re-check or re-force the tree (no HTTP calls needed)', async () => {
      const account = insertAccount(testDb);
      insertLegacyCampaign(account.id, 'camp_legacy_3');
      testDb.db.run(`UPDATE campaigns SET effective_status = 'ACTIVE' WHERE ad_account_id = ?`, [account.id]);
      testDb.db.run(
        `UPDATE ad_accounts SET lifecycle_backfill_completed_at = datetime('now') WHERE id = ?`,
        [account.id]
      );
      const now = new Date().toISOString();
      for (const entityType of smartSyncEngine.ENTITY_TYPES) {
        testDb.db.run(
          `INSERT INTO sync_entity_state (id, ad_account_id, entity_type, last_sync_completed_at, last_success_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), account.id, entityType, now, now, now, now]
        );
      }

      // No nock interceptors registered at all -- any HTTP attempt would throw.
      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');

      expect(result.ranAny).toBe(false);
    });

    test('markLifecycleBackfillCompleteIfDone is a no-op (returns false) while NULLs remain', () => {
      const account = insertAccount(testDb);
      insertLegacyCampaign(account.id, 'camp_legacy_4');

      expect(smartSyncEngine.markLifecycleBackfillCompleteIfDone(account.id)).toBe(false);
      const row = testDb.db.get('SELECT lifecycle_backfill_completed_at FROM ad_accounts WHERE id = ?', [account.id]);
      expect(row.lifecycle_backfill_completed_at).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Executive Marketing Analytics Layer tier integration (Phase 17)
  // ═══════════════════════════════════════════════════════════════════
  describe('analytics tier', () => {
    function insertCampaignWithBudget(testDb, accountId, metaCampaignId) {
      const campaignId = uuidv4();
      testDb.db.run(
        `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, effective_status, created_at, updated_at)
         VALUES (?, ?, ?, 'Analytics Tier Campaign', 'engagement', 'active', 'ACTIVE', datetime('now'), datetime('now'))`,
        [campaignId, accountId, metaCampaignId]
      );
      testDb.db.run(
        `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, effective_status, daily_budget, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Ad Set', 'active', 'ACTIVE', 50, datetime('now'), datetime('now'))`,
        [uuidv4(), campaignId, accountId, `adset_${metaCampaignId}`]
      );
      return campaignId;
    }

    test('runs breakdowns/creative/budget sync for real campaign data and checkpoints the analytics tier', async () => {
      const account = insertAccount(testDb, { auto_sync_enabled: true });
      insertCampaignWithBudget(testDb, account.id, 'camp_tier_analytics_1');

      // Mark every OTHER tier as already-fresh so only 'analytics' is due
      // this cycle -- isolates the assertion to the new tier.
      const now = new Date().toISOString();
      for (const entityType of ['insights', 'campaigns', 'adsets', 'ads', 'creatives', 'metadata']) {
        testDb.db.run(
          `INSERT INTO sync_entity_state (id, ad_account_id, entity_type, last_sync_completed_at, last_success_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), account.id, entityType, now, now, now, now]
        );
      }

      // analyticsEngine's age_gender/country/region/placement/impression_device
      // breakdown calls, plus fetchCampaignMetrics (budget distribution) --
      // all return empty data; only proving the tier actually fires and
      // completes cleanly, not exercising each domain's own parsing (already
      // covered by analyticsEngine.test.js/budgetDistributionAnalytics.test.js).
      nock(BASE).get(`/${VERSION}/camp_tier_analytics_1/insights`).query(true).times(20).reply(200, { data: [] });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');

      expect(result.ranTiers).toEqual(['analytics']);

      const logRow = testDb.db.get(
        `SELECT * FROM sync_execution_log WHERE ad_account_id = ? AND entity_type = 'analytics' ORDER BY started_at DESC LIMIT 1`,
        [account.id]
      );
      expect(logRow).toBeDefined();
      expect(logRow.status).toBe('success');

      const stateRow = testDb.db.get(
        `SELECT * FROM sync_entity_state WHERE ad_account_id = ? AND entity_type = 'analytics'`,
        [account.id]
      );
      expect(stateRow.last_success_at).toBeTruthy();
    });

    test('a rate-limited analytics call stops the tier and re-throws, same contract as every other tier', async () => {
      const account = insertAccount(testDb, { auto_sync_enabled: true });
      insertCampaignWithBudget(testDb, account.id, 'camp_tier_analytics_ratelimit');

      // Mark every OTHER tier as already-fresh so the rate-limited mock below
      // is only ever consumed by the analytics tier's own calls, not an
      // earlier tier (e.g. insights) hitting the same /insights endpoint first.
      const now = new Date().toISOString();
      for (const entityType of ['insights', 'campaigns', 'adsets', 'ads', 'creatives', 'metadata']) {
        testDb.db.run(
          `INSERT INTO sync_entity_state (id, ad_account_id, entity_type, last_sync_completed_at, last_success_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), account.id, entityType, now, now, now, now]
        );
      }

      nock(BASE).get(`/${VERSION}/camp_tier_analytics_ratelimit/insights`).query(true)
        .times(4)
        .reply(400, { error: { message: 'User request limit reached', code: 17 } });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      await expect(smartSyncEngine.runDueForAccount(fullAccount, 'scheduler')).rejects.toThrow();

      const logRow = testDb.db.get(
        `SELECT * FROM sync_execution_log WHERE ad_account_id = ? AND entity_type = 'analytics'`,
        [account.id]
      );
      expect(logRow.rate_limited).toBe(1);
      expect(logRow.status).toBe('failed');
    }, 45_000);
  });
});
