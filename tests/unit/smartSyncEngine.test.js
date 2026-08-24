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
    test('returns the spec default intervals when nothing has been customized', async () => {
      const config = await smartSyncEngine.getScheduleConfig();
      expect(config).toEqual({
        insights: 15, campaigns: 60, adsets: 60, ads: 60, creatives: 1440, metadata: 1440,
        analytics: 360, // Executive Marketing Analytics Layer tier (Phase 17)
      });
    });

    test('setScheduleInterval persists a custom interval and rejects invalid input', async () => {
      await smartSyncEngine.setScheduleInterval('insights', 5);
      expect((await smartSyncEngine.getScheduleConfig()).insights).toBe(5);

      await expect(smartSyncEngine.setScheduleInterval('not_a_real_tier', 10)).rejects.toThrow();
      await expect(smartSyncEngine.setScheduleInterval('insights', 0)).rejects.toThrow();

      // restore default so later tests in this file aren't affected
      await smartSyncEngine.setScheduleInterval('insights', 15);
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

    // AUTONOMOUS META SYNC RECOVERY mission (Phase 1/2): a decrypt failure
    // (e.g. a stale/rotated TOKEN_ENCRYPTION_KEY -- the exact real-world
    // condition that produced a raw, unrecorded 500 "Unsupported state or
    // unable to authenticate data" on a real Preview Force Sync attempt,
    // forensically traced via Vercel runtime logs before this fix) must now
    // be caught, durably recorded, and returned gracefully -- never an
    // uncaught throw reaching Express's generic error handler.
    test('a token decrypt failure is caught, durably recorded, and returned gracefully -- never thrown uncaught', async () => {
      const account = insertAccount(testDb);
      // Corrupt the stored ciphertext so decryptToken() genuinely fails
      // AES-GCM auth-tag verification, the same failure class proven live.
      testDb.db.run(
        `UPDATE ad_accounts SET access_token_encrypted = ? WHERE id = ?`,
        ['enc:v1:000000000000000000000000:00000000000000000000000000000000:deadbeef', account.id]
      );

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'force');

      expect(result.ranAny).toBe(false);
      expect(result.errorCode).toBe('TOKEN_DECRYPT_FAILED');
      expect(result.executionId).toBeTruthy();

      const execution = testDb.db.get('SELECT * FROM sync_live_executions WHERE id = ?', [result.executionId]);
      expect(execution.status).toBe('failed');
      expect(execution.error_code).toBe('TOKEN_DECRYPT_FAILED');
      expect(execution.finished_at).toBeTruthy();
      // No tier ever ran -- confirms this returned before any Meta contact,
      // not after a failed one.
      const logRows = testDb.db.all('SELECT * FROM sync_execution_log WHERE ad_account_id = ?', [account.id]);
      expect(logRows.length).toBe(0);
    });

    test('sync_live_executions is created immediately (status=running) before any tier runs, and finished on success', async () => {
      const account = insertAccount(testDb);
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'force');

      expect(result.executionId).toBeTruthy();
      const execution = testDb.db.get('SELECT * FROM sync_live_executions WHERE id = ?', [result.executionId]);
      expect(execution.ad_account_id).toBe(account.id);
      expect(execution.source).toBe('force');
      expect(execution.status).toBe('completed');
      expect(execution.started_at).toBeTruthy();
      expect(execution.finished_at).toBeTruthy();

      const events = testDb.db.all('SELECT stage FROM sync_live_events WHERE execution_id = ? ORDER BY ts ASC', [result.executionId]);
      expect(events.map(e => e.stage)).toEqual(expect.arrayContaining(['TOKEN_DECRYPT_SUCCESS', 'INSIGHTS', 'CAMPAIGNS', 'METADATA', 'ANALYTICS']));
    });

    // AUTONOMOUS META SYNC RECOVERY mission (Phase 9/11): the actual root
    // cause of the live `Vercel Runtime Timeout Error: Task timed out after
    // 60 seconds` traced this session -- Force Sync runs ALL tiers
    // (insights -> campaign tree -> metadata -> analytics) in one
    // invocation, but only the campaign tree tier had any deadline
    // awareness. A single shared deadline must now cause later tiers to be
    // skipped/deferred (not attempted) once the budget is gone, producing a
    // clean 'partial' result instead of running until the platform kills it.
    test('tiers still due when the shared deadline is already exhausted are deferred, not attempted -- status becomes partial', async () => {
      const account = insertAccount(testDb);
      const originalBudget = process.env.SYNC_TIME_BUDGET_MS;
      process.env.SYNC_TIME_BUDGET_MS = '1'; // exhausted almost immediately after being read

      try {
        // No nock interceptors registered at all -- if any tier actually
        // attempted a Meta call, the request would throw and fail the test.
        const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
        // Give the 1ms budget time to actually elapse before entering the
        // tier loop (createExecution/decryptToken both take non-zero time).
        const result = await smartSyncEngine.runDueForAccount(fullAccount, 'force');

        expect(result.deferredTiers.length).toBeGreaterThan(0);
        const execution = testDb.db.get('SELECT * FROM sync_live_executions WHERE id = ?', [result.executionId]);
        expect(execution.status).toBe('partial');
        expect(execution.partial_reason).toBe('timed_out');
      } finally {
        if (originalBudget === undefined) delete process.env.SYNC_TIME_BUDGET_MS;
        else process.env.SYNC_TIME_BUDGET_MS = originalBudget;
      }
    });
  });

  // AUTONOMOUS META SYNC RECOVERY mission -- live forensic evidence
  // (executionId 7ae47b40-3719-48a6-b0b3-6b310b5c8646, real Preview Force
  // Sync against act_665699145095366) proved runInsightsTier's unbounded
  // per-campaign loop consumed an entire invocation's shared time budget
  // (37 sequential Meta calls, all HTTP 200) before the campaign-tree tier
  // ever got a turn. These tests prove the bounded/resumable replacement
  // directly, using deterministic campaign counts/timing rather than
  // depending on any live account state.
  describe('runInsightsTier — bounded/resumable', () => {
    const cacheService = require('../../src/services/cacheService');
    const executionTracker = require('../../src/services/syncExecutionTracker');

    function insertInsightsCampaign(accountId, metaCampaignId) {
      const id = uuidv4();
      testDb.db.run(
        `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, effective_status, created_at, updated_at)
         VALUES (?, ?, ?, 'Insights Test Campaign', 'engagement', 'active', 'ACTIVE', datetime('now'), datetime('now'))`,
        [id, accountId, metaCampaignId]
      );
      return id;
    }

    function mockInsightsForCampaign(metaCampaignId) {
      // fetchCampaignMetrics makes two calls per campaign (current + prior
      // period) -- .persist() so exact call-count bookkeeping isn't needed
      // in tests that only care about batch/cursor behavior.
      nock(BASE).persist().get(`/${VERSION}/${metaCampaignId}/insights`).query(true)
        .reply(200, { data: [] });
    }

    async function freshAccount(accountId) {
      return testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [accountId]);
    }

    beforeEach(() => {
      cacheService.flush();
    });

    // Test A (mission spec): the engine must NOT attempt all N campaigns if
    // the batch cap is insufficient -- it must stop, checkpoint, and leave
    // the rest genuinely still-due. Calls runInsightsTier() directly (not
    // the full runDueForAccount) so this is a focused test of the tier
    // itself, unaffected by the other tiers' own Meta calls.
    test('Test A — a batch of campaigns exceeding the count cap is not fully attempted in one pass; the rest remain pending via a persisted cursor', async () => {
      const account = insertAccount(testDb);
      const originalBatchSize = process.env.INSIGHTS_BATCH_SIZE;
      process.env.INSIGHTS_BATCH_SIZE = '5';
      try {
        for (let i = 0; i < 12; i++) {
          const metaCampaignId = `insights_camp_${account.id}_${i}`;
          insertInsightsCampaign(account.id, metaCampaignId);
          mockInsightsForCampaign(metaCampaignId);
        }

        const result = await smartSyncEngine.runInsightsTier(await freshAccount(account.id), 'fake-token', 'force');

        expect(result.complete).toBe(false);
        expect(result.processed).toBe(5);
        expect(result.remaining).toBe(7);

        const row = testDb.db.get('SELECT insights_sync_cursor FROM ad_accounts WHERE id = ?', [account.id]);
        expect(row.insights_sync_cursor).toBeTruthy();
      } finally {
        if (originalBatchSize === undefined) delete process.env.INSIGHTS_BATCH_SIZE;
        else process.env.INSIGHTS_BATCH_SIZE = originalBatchSize;
      }
    });

    // Test B (mission spec): the next execution must resume from the
    // persisted cursor, not redo already-completed campaigns.
    test('Test B — the next invocation resumes from the persisted cursor instead of restarting from the first campaign', async () => {
      const account = insertAccount(testDb);
      const originalBatchSize = process.env.INSIGHTS_BATCH_SIZE;
      process.env.INSIGHTS_BATCH_SIZE = '3';
      try {
        for (let i = 0; i < 7; i++) {
          const metaCampaignId = `resume_camp_${account.id}_${i}`;
          insertInsightsCampaign(account.id, metaCampaignId);
          mockInsightsForCampaign(metaCampaignId);
        }

        const first = await smartSyncEngine.runInsightsTier(await freshAccount(account.id), 'fake-token', 'force');
        expect(first.processed).toBe(3);
        const cursorAfterFirst = testDb.db.get('SELECT insights_sync_cursor FROM ad_accounts WHERE id = ?', [account.id]).insights_sync_cursor;
        expect(cursorAfterFirst).toBeTruthy();

        // Re-fetch the account row (picks up the persisted cursor) and run again.
        const second = await smartSyncEngine.runInsightsTier(await freshAccount(account.id), 'fake-token', 'force');
        expect(second.processed).toBe(3);
        // 3 (run 1) + 3 (run 2) = 6 distinct campaigns of 7 -- if items were
        // being redone instead of resumed, remaining would still be 4, not 1.
        expect(second.remaining).toBe(1);
      } finally {
        if (originalBatchSize === undefined) delete process.env.INSIGHTS_BATCH_SIZE;
        else process.env.INSIGHTS_BATCH_SIZE = originalBatchSize;
      }
    });

    // Test E (mission spec): enough resumed invocations must eventually
    // process every campaign and mark the tier genuinely complete.
    test('Test E — repeated resume eventually processes every campaign and clears the cursor', async () => {
      const account = insertAccount(testDb);
      const originalBatchSize = process.env.INSIGHTS_BATCH_SIZE;
      process.env.INSIGHTS_BATCH_SIZE = '4';
      try {
        const total = 10;
        for (let i = 0; i < total; i++) {
          const metaCampaignId = `full_camp_${account.id}_${i}`;
          insertInsightsCampaign(account.id, metaCampaignId);
          mockInsightsForCampaign(metaCampaignId);
        }

        let processedTotal = 0;
        let complete = false;
        for (let iteration = 0; iteration < 10 && !complete; iteration++) {
          const result = await smartSyncEngine.runInsightsTier(await freshAccount(account.id), 'fake-token', 'force');
          processedTotal += result.processed;
          complete = result.complete;
        }

        expect(complete).toBe(true);
        expect(processedTotal).toBe(total);
        const row = testDb.db.get('SELECT insights_sync_cursor FROM ad_accounts WHERE id = ?', [account.id]);
        expect(row.insights_sync_cursor).toBeNull();
      } finally {
        if (originalBatchSize === undefined) delete process.env.INSIGHTS_BATCH_SIZE;
        else process.env.INSIGHTS_BATCH_SIZE = originalBatchSize;
      }
    });

    // Test G (mission spec): idempotency -- if the cursor's campaign is no
    // longer resolvable (deleted upstream), the tier falls back to the
    // start rather than corrupting state, and never duplicates DB rows
    // (campaigns table itself is untouched by this tier -- it only reads).
    test('Test G — a stale cursor pointing at a deleted campaign safely falls back to the start, no corruption', async () => {
      const account = insertAccount(testDb);
      insertInsightsCampaign(account.id, `still_here_${account.id}`);
      mockInsightsForCampaign(`still_here_${account.id}`);
      testDb.db.run(`UPDATE ad_accounts SET insights_sync_cursor = ? WHERE id = ?`, ['deleted_campaign_id', account.id]);

      const result = await smartSyncEngine.runInsightsTier(await freshAccount(account.id), 'fake-token', 'force');

      expect(result.complete).toBe(true);
      expect(result.processed).toBe(1);
      const row = testDb.db.get('SELECT insights_sync_cursor FROM ad_accounts WHERE id = ?', [account.id]);
      expect(row.insights_sync_cursor).toBeNull();
    });

    // Test C (mission spec, adapted -- see this tier's own header comment:
    // Insights is cache-warming only, it has never durably written rows to
    // the campaigns/ad_sets/ads tables, unlike the campaign tree tier which
    // already proves Meta-200 -> persisted -> checkpoint via
    // writeCampaignBatch()/sync_batch_cursor, covered by
    // boundedResumableInitialSync.test.js). What Insights DOES durably
    // persist is its own resumable position -- proven here, using a real
    // executionId/recorder exactly like runDueForAccount() wires one up.
    test('Test C — every bounded pass is followed by a durable cursor checkpoint event, not just an in-memory counter', async () => {
      const account = insertAccount(testDb);
      const originalBatchSize = process.env.INSIGHTS_BATCH_SIZE;
      process.env.INSIGHTS_BATCH_SIZE = '2';
      try {
        for (let i = 0; i < 5; i++) {
          const metaCampaignId = `checkpoint_camp_${account.id}_${i}`;
          insertInsightsCampaign(account.id, metaCampaignId);
          mockInsightsForCampaign(metaCampaignId);
        }

        const executionId = await executionTracker.createExecution(account.id, 'force');
        const recorder = executionTracker.createRecorder(executionId);
        await smartSyncEngine.runInsightsTier(await freshAccount(account.id), 'fake-token', 'force', { recorder });

        const execution = testDb.db.get('SELECT * FROM sync_live_executions WHERE id = ?', [executionId]);
        expect(execution.cursor_after).toBeTruthy();
        const checkpointEvents = testDb.db.all(
          "SELECT * FROM sync_live_events WHERE execution_id = ? AND stage = 'CHECKPOINT_PERSISTED'",
          [executionId]
        );
        expect(checkpointEvents.length).toBe(1);
      } finally {
        if (originalBatchSize === undefined) delete process.env.INSIGHTS_BATCH_SIZE;
        else process.env.INSIGHTS_BATCH_SIZE = originalBatchSize;
      }
    });
  });

  describe('getEntityFreshness', () => {
    test('reports is_stale based on the configured interval for that entity type', async () => {
      const account = insertAccount(testDb);
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');

      const freshness = await smartSyncEngine.getEntityFreshness(account.id);
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

    test('needsLifecycleBackfill is true when a campaign has NULL effective_status, false once populated', async () => {
      const account = insertAccount(testDb);
      insertLegacyCampaign(account.id, 'camp_legacy_1');
      expect(await smartSyncEngine.needsLifecycleBackfill(account.id)).toBe(true);

      testDb.db.run(`UPDATE campaigns SET effective_status = 'ACTIVE' WHERE ad_account_id = ?`, [account.id]);
      expect(await smartSyncEngine.needsLifecycleBackfill(account.id)).toBe(false);
    });

    test('needsLifecycleBackfill is false for an account with no campaigns at all (nothing to backfill)', async () => {
      const account = insertAccount(testDb);
      expect(await smartSyncEngine.needsLifecycleBackfill(account.id)).toBe(false);
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

    test('markLifecycleBackfillCompleteIfDone is a no-op (returns false) while NULLs remain', async () => {
      const account = insertAccount(testDb);
      insertLegacyCampaign(account.id, 'camp_legacy_4');

      expect(await smartSyncEngine.markLifecycleBackfillCompleteIfDone(account.id)).toBe(false);
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

      // analyticsEngine's age_gender/country/region/comscore_market/placement/
      // impression_device/device_platform breakdown calls (current+prior),
      // budget distribution's fetchCampaignMetrics, and (Phase 40) customer
      // journey's + attribution window comparison's own real
      // fetchCampaignMetrics calls (2 + 6, current+prior each) -- all return
      // empty data; only proving the tier actually fires and completes
      // cleanly, not exercising each domain's own parsing (already covered
      // by analyticsEngine.test.js/budgetDistributionAnalytics.test.js/
      // customerJourneyEngine.test.js/attributionWindowEngine.test.js).
      nock(BASE).get(`/${VERSION}/camp_tier_analytics_1/insights`).query(true).times(40).reply(200, { data: [] });

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
