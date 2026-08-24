'use strict';

/**
 * AP-POS Sync Architecture Audit — Bounded/Resumable Initial Sync.
 *
 * Covers the behavior added on top of the existing sync engine (see
 * SYNC_ARCHITECTURE_AUDIT_REPORT.md / SYNC_BEHAVIOR_SPECIFICATION.md):
 *   - syncAccount()'s full-sweep (activeOnly===false) path now processes
 *     due campaigns in bounded batches, checkpointing a resumable cursor
 *     (ad_accounts.sync_batch_cursor) instead of always attempting every
 *     due campaign in one unbounded pass.
 *   - ad_accounts.initial_sync_completed_at is set only once a FULL sweep
 *     has run to completion (not merely attempted).
 *   - smartSyncEngine's genuinely-automatic triggers ('scheduler', 'cron')
 *     stay full until initial_sync_completed_at is set, then switch to
 *     active-only permanently -- manual triggers ('force', 'force_active')
 *     are unaffected either way.
 *   - runDueForAccount() now also enforces a durable, DB-backed concurrency
 *     guard (not just the in-memory syncLock), covering every tier.
 */

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

function insertAccount(testDb, overrides = {}) {
  const id = uuidv4();
  const metaId = overrides.meta_account_id || `act_batch_${id.slice(0, 8)}`;
  testDb.db.run(
    `INSERT INTO ad_accounts (
       id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid,
       attribution_window_days, created_at, updated_at
     ) VALUES (?, ?, 'Bounded Sync Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
    [id, metaId, encryptToken('fake-token')]
  );
  return { id, meta_account_id: metaId };
}

function mockAccountInfo(metaId) {
  nock(BASE).get(`/${VERSION}/${metaId}`).query(true)
    .reply(200, { id: metaId, name: 'Bounded Sync Test', currency: 'USD', timezone_name: 'UTC' });
}

function mockCustomAudiences(metaId) {
  nock(BASE).get(`/${VERSION}/${metaId}/customaudiences`).query(true).reply(200, { data: [] });
}

function campaign(id) {
  return { id, name: `Campaign ${id}`, objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', effective_status: 'ACTIVE' };
}

describe('Bounded/Resumable Initial Sync', () => {
  let testDb;
  let syncService;
  let smartSyncEngine;

  beforeAll(async () => {
    testDb = await createTestDb();
    syncService = require('../../src/services/syncService');
    smartSyncEngine = require('../../src/services/smartSyncEngine');
  });

  afterAll(() => {
    testDb.cleanup();
  });

  afterEach(() => {
    nock.cleanAll();
    delete process.env.SYNC_CAMPAIGN_BATCH_SIZE;
    delete process.env.SYNC_TIME_BUDGET_MS;
    delete process.env.CRON_TIME_BUDGET_MS;
    testDb.db.run('DELETE FROM ads');
    testDb.db.run('DELETE FROM ad_sets');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM sync_entity_state');
    testDb.db.run('DELETE FROM sync_execution_log');
  });

  describe('syncService.syncAccount — bounded batches + resumable cursor', () => {
    test('a full sweep whose elapsed time exceeds the time budget stops mid-account, checkpoints a cursor, and resumes on the next call', async () => {
      // Batch size alone doesn't cap a single invocation's TOTAL work --
      // runBatchedFullSweep() deliberately keeps processing further batches
      // within the same invocation as long as the time budget allows (real
      // evidence: PHASE_36's own measured 107.8s for a 99-campaign full
      // sync shows throughput-within-budget matters more than an arbitrary
      // per-invocation batch cap -- see syncService.js's header comment on
      // these constants). So to deterministically force a stop mid-account
      // here, constrain the TIME budget and use nock's .delay() to make the
      // batch's own elapsed time exceed it -- batch size is set to 2 so the
      // cut lands after a whole batch (camp_1+camp_2), not mid-write.
      // Wide margins (not tight ones) deliberately: under full-suite load
      // (many test files' worth of timers/sockets sharing the event loop)
      // a tight budget/delay pairing is flaky, since camp_1's own overhead
      // can occasionally approach a small budget on its own. 300ms budget
      // vs. a 3s artificial delay on camp_2 leaves enormous headroom either
      // direction while still keeping this test's runtime reasonable.
      process.env.SYNC_CAMPAIGN_BATCH_SIZE = '2';
      process.env.SYNC_TIME_BUDGET_MS = '300';
      const account = insertAccount(testDb);

      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, {
        data: [campaign('camp_1'), campaign('camp_2'), campaign('camp_3')],
      });
      mockCustomAudiences(account.meta_account_id);
      nock(BASE).get(`/${VERSION}/camp_1/adsets`).query(true).reply(200, { data: [] });
      nock(BASE).get(`/${VERSION}/camp_2/adsets`).query(true).delay(3000).reply(200, { data: [] });
      // camp_3 deliberately NOT mocked -- proves it's genuinely untouched
      // this invocation, not fetched-and-discarded.

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary1 = await syncService.syncAccount(fullAccount);

      expect(summary1.campaigns.synced).toBe(2);
      expect(summary1.sweepComplete).toBe(false);
      expect(summary1.sweepRemaining).toBe(1);
      expect(summary1.errors).toEqual([]);

      const afterBatch1 = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(afterBatch1.sync_batch_cursor).toBe('camp_2');
      expect(afterBatch1.initial_sync_completed_at).toBeNull();
      expect(testDb.db.get('SELECT id FROM campaigns WHERE meta_campaign_id = ?', ['camp_1'])).toBeTruthy();
      expect(testDb.db.get('SELECT id FROM campaigns WHERE meta_campaign_id = ?', ['camp_2'])).toBeTruthy();
      expect(testDb.db.get('SELECT id FROM campaigns WHERE meta_campaign_id = ?', ['camp_3'])).toBeFalsy();

      // Resume: only camp_3 should be fetched this time (cursor skips camp_1/camp_2).
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, {
        data: [campaign('camp_1'), campaign('camp_2'), campaign('camp_3')],
      });
      mockCustomAudiences(account.meta_account_id);
      nock(BASE).get(`/${VERSION}/camp_3/adsets`).query(true).reply(200, { data: [] });

      const summary2 = await syncService.syncAccount(afterBatch1);

      expect(summary2.campaigns.synced).toBe(1);
      expect(summary2.sweepComplete).toBe(true);
      expect(summary2.sweepRemaining).toBe(0);

      const afterBatch2 = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(afterBatch2.sync_batch_cursor).toBeNull();
      expect(afterBatch2.initial_sync_completed_at).toBeTruthy();
      expect(testDb.db.get('SELECT id FROM campaigns WHERE meta_campaign_id = ?', ['camp_3'])).toBeTruthy();
    }, 15_000);

    test('a rate-limited campaign truncates the sweep without touching later campaigns, and the retry resumes cleanly once the throttle clears', async () => {
      const account = insertAccount(testDb);

      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, {
        data: [campaign('camp_ok'), campaign('camp_limited'), campaign('camp_untouched')],
      });
      mockCustomAudiences(account.meta_account_id);
      nock(BASE).get(`/${VERSION}/camp_ok/adsets`).query(true).reply(200, { data: [] });
      nock(BASE).get(`/${VERSION}/camp_limited/adsets`).query(true).times(4)
        .reply(400, { error: { message: 'User request limit reached', code: 17 } });
      // camp_untouched deliberately NOT mocked.

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await syncService.syncAccount(fullAccount);

      expect(summary.sweepComplete).toBe(false);
      expect(summary.sweepRemaining).toBe(1);
      // Both camp_ok and camp_limited were attempted+written (camp_limited
      // with an adset-level error, not silently dropped); only the campaign
      // AFTER the one that tripped the breaker is left genuinely untouched.
      expect(testDb.db.get('SELECT id FROM campaigns WHERE meta_campaign_id = ?', ['camp_ok'])).toBeTruthy();
      expect(testDb.db.get('SELECT id FROM campaigns WHERE meta_campaign_id = ?', ['camp_limited'])).toBeTruthy();
      expect(testDb.db.get('SELECT id FROM campaigns WHERE meta_campaign_id = ?', ['camp_untouched'])).toBeFalsy();
      expect(summary.errors.some(e => /rate limit|User request limit/i.test(e.message))).toBe(true);

      const afterFirst = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(afterFirst.sync_batch_cursor).toBe('camp_limited');
      expect(afterFirst.initial_sync_completed_at).toBeNull();

      // Retry once the throttle clears -- resumes at camp_untouched only.
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, {
        data: [campaign('camp_ok'), campaign('camp_limited'), campaign('camp_untouched')],
      });
      mockCustomAudiences(account.meta_account_id);
      nock(BASE).get(`/${VERSION}/camp_untouched/adsets`).query(true).reply(200, { data: [] });

      const summary2 = await syncService.syncAccount(afterFirst);
      expect(summary2.sweepComplete).toBe(true);
      expect(summary2.errors).toEqual([]);

      const afterSecond = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(afterSecond.sync_batch_cursor).toBeNull();
      expect(afterSecond.initial_sync_completed_at).toBeTruthy();
      // This test's own MAX_RETRIES x exponential-backoff sleep (5s+10s+20s,
      // real setTimeout waits inside metaGet() -- see metaApiClient.js) is
      // the same unmocked-timer pattern smartSyncEngine.test.js's own
      // rate-limit test already uses (45_000ms there); 60_000ms here gives
      // extra headroom since this test also does a full second syncAccount()
      // call afterward, and under full-suite --runInBand load 45s proved
      // too tight.
    }, 60_000);
  });

  describe('smartSyncEngine — initial ingestion vs recurring active-only', () => {
    test('a brand-new account\'s first automatic ("scheduler") sync runs FULL, and only switches to active-only once initial sync completes', async () => {
      const account = insertAccount(testDb);

      // First sync (never-synced account): must request the FULL campaign
      // list (no server-side effective_status filter).
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`)
        .query(q => !q.filtering)
        .reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result1 = await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');
      expect(result1.activeOnly).toBe(false);

      const afterFirst = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(afterFirst.initial_sync_completed_at).toBeTruthy();

      // Force the campaigns tier due again.
      testDb.db.run(
        `UPDATE sync_entity_state SET last_sync_completed_at = datetime('now', '-999 minutes')
         WHERE ad_account_id = ? AND entity_type = 'campaigns'`,
        [account.id]
      );

      // Second sync: initial_sync_completed_at is now set, so this must be
      // active-only (server-side effective_status=ACTIVE filter present).
      // If the engine still requested the unfiltered list, this mock would
      // not match and the request would throw.
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`)
        .query(q => typeof q.filtering === 'string' && q.filtering.includes('ACTIVE'))
        .reply(200, { data: [] });

      const result2 = await smartSyncEngine.runDueForAccount(afterFirst, 'scheduler');
      expect(result2.activeOnly).toBe(true);
    });

    test('the manual "force_active" (Refresh Active Data) trigger stays active-only even before initial sync completes', async () => {
      const account = insertAccount(testDb);

      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`)
        .query(q => typeof q.filtering === 'string' && q.filtering.includes('ACTIVE'))
        .reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(fullAccount.initial_sync_completed_at).toBeNull();

      const result = await smartSyncEngine.forceSyncActiveAccount(fullAccount);
      expect(result.errors).toEqual([]);

      // A manual active-only refresh must NOT itself mark initial sync
      // complete -- that's earned only by an actual full sweep.
      const after = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(after.initial_sync_completed_at).toBeNull();
    });

    test('the "cron" trigger behaves like "scheduler" (respects per-tier cadence, stays full until initial sync completes)', async () => {
      const account = insertAccount(testDb);

      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`)
        .query(q => !q.filtering)
        .reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'cron');
      expect(result.activeOnly).toBe(false);

      // Immediately re-running 'cron' must NOT re-fetch anything (unlike
      // 'force_active', 'cron' respects cadence/due-checks).
      const after = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result2 = await smartSyncEngine.runDueForAccount(after, 'cron');
      expect(result2.ranAny).toBe(false);
    });
  });

  describe('runDueForAccount — durable (DB-backed) concurrency guard', () => {
    test('skips when ad_accounts.last_sync_status is "running" and recent, even without the in-memory syncLock held', async () => {
      const account = insertAccount(testDb);
      const recentStart = new Date().toISOString();
      testDb.db.run(
        `UPDATE ad_accounts SET last_sync_status = 'running', last_sync_started_at = ? WHERE id = ?`,
        [recentStart, account.id]
      );

      // No nock interceptors registered -- any HTTP attempt would throw.
      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');
      expect(result).toEqual({ ranAny: false, skipped: true, reason: 'sync_already_in_progress_for_account' });
    });

    test('a stale "running" row (older than the recovery timeout) does not block a new sync', async () => {
      const account = insertAccount(testDb);
      const staleStart = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min ago
      testDb.db.run(
        `UPDATE ad_accounts SET last_sync_status = 'running', last_sync_started_at = ? WHERE id = ?`,
        [staleStart, account.id]
      );

      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      mockAccountInfo(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const result = await smartSyncEngine.runDueForAccount(fullAccount, 'scheduler');
      expect(result.skipped).toBeFalsy();
      expect(result.ranAny).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2 — full-request time budget (PHASE_2_SYNC_EXECUTION_OBSERVABILITY_REPORT.md)
  //
  // Real production incident: POST /api/v1/sync timed out at Vercel's own
  // 60s ceiling (504) even though SYNC_TIME_BUDGET_MS was 45s, because that
  // budget only wrapped runBatchedFullSweep()'s own batch loop -- time
  // spent on fetchCampaigns()/fetchCustomAudiences() before the batch loop
  // even started was invisible to it. The deadline is now established once,
  // at the very top of syncAccount(), before those calls happen.
  // ═══════════════════════════════════════════════════════════════════
  describe('syncService.syncAccount — full-request deadline (Phase 2)', () => {
    test('time spent on fetchCampaigns()/fetchCustomAudiences() counts against the budget -- no campaigns are touched if it is already exhausted by the time the batch loop would start', async () => {
      // Wide margins, not tight ones (see the other timing test's own
      // comment on why) -- SYNC_TIME_BUDGET_MS=200 vs. a 2s artificial
      // delay on fetchCustomAudiences (which runs BEFORE the batch loop)
      // leaves enormous headroom either direction while still keeping this
      // test's runtime reasonable.
      process.env.SYNC_TIME_BUDGET_MS = '200';
      const account = insertAccount(testDb);

      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, {
        data: [campaign('camp_1'), campaign('camp_2')],
      });
      // Deliberately slow -- this happens BEFORE runBatchedFullSweep()'s own
      // loop, so under the OLD (pre-Phase-2) design this delay would not
      // have counted against SYNC_TIME_BUDGET_MS at all.
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/customaudiences`).query(true).delay(2000).reply(200, { data: [] });
      // camp_1/camp_2's adsets deliberately NOT mocked -- proves neither
      // campaign was touched once the deadline was already exhausted.

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await syncService.syncAccount(fullAccount);

      expect(summary.status).toBe('partial');
      expect(summary.partialReason).toBe('timed_out');
      expect(summary.sweepComplete).toBe(false);
      expect(summary.sweepRemaining).toBe(2);
      expect(summary.campaigns.synced).toBe(0);
      expect(testDb.db.get('SELECT id FROM campaigns WHERE meta_campaign_id = ?', ['camp_1'])).toBeFalsy();

      const afterAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(afterAccount.last_sync_status).toBe('partial');
      expect(afterAccount.last_sync_partial_reason).toBe('timed_out');
      expect(afterAccount.sync_batch_cursor).toBeNull(); // nothing was ever written, so no cursor to advance
      expect(afterAccount.initial_sync_completed_at).toBeNull();
    }, 15_000);

    test('a completed sweep reports status "completed" with no partial reason', async () => {
      const account = insertAccount(testDb);
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, { data: [] });
      mockCustomAudiences(account.meta_account_id);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await syncService.syncAccount(fullAccount);

      expect(summary.status).toBe('completed');
      expect(summary.partialReason).toBeNull();

      const afterAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(afterAccount.last_sync_status).toBe('success');
      expect(afterAccount.last_sync_partial_reason).toBeNull();
    });

    test('a sync with real errors reports status "failed", not "partial"', async () => {
      const account = insertAccount(testDb);
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true)
        .reply(500, { error: { message: 'Internal error' } });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await syncService.syncAccount(fullAccount);

      expect(summary.status).toBe('failed');
      expect(summary.partialReason).toBeNull();

      const afterAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(afterAccount.last_sync_status).toBe('failed');
      expect(afterAccount.last_sync_partial_reason).toBeNull();
    });

    test('the active-only path also respects the deadline defensively (does not attempt the fetch loop if already exhausted)', async () => {
      process.env.SYNC_TIME_BUDGET_MS = '200';
      const account = insertAccount(testDb);
      // initial_sync_completed_at set so an activeOnly=true call is realistic
      testDb.db.run(`UPDATE ad_accounts SET initial_sync_completed_at = datetime('now') WHERE id = ?`, [account.id]);

      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).delay(2000).reply(200, {
        data: [campaign('camp_1')],
      });
      // camp_1's adsets deliberately NOT mocked.

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await syncService.syncAccount(fullAccount, { activeOnly: true });

      expect(summary.status).toBe('partial');
      expect(summary.partialReason).toBe('timed_out');
      expect(summary.campaigns.synced).toBe(0);
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Force Sync Deadline Propagation fix — correctness requirement found
  // while implementing it: if the CAMPAIGN LIST ITSELF is incomplete
  // (metaGetAll's pagination for /campaigns stopped early -- deadline, the
  // 5000-item safety cap, or a page-fetch error), the sweep must never be
  // considered genuinely complete, no matter how thoroughly every
  // DISCOVERED campaign gets processed -- the true full account size isn't
  // known until Meta confirms there's no further page. Exercised here via
  // the existing page_fetch_error mechanism (deterministic, no timing
  // dependency) since it hits the exact same summary.status/sweepComplete/
  // initial_sync_completed_at code path as a deadline-driven stop would.
  // ═══════════════════════════════════════════════════════════════════
  describe('an incomplete campaign LIST never marks the sweep complete (Force Sync Deadline Propagation fix)', () => {
    test('page 1 of the campaign list succeeds, page 2 fails: initial_sync_completed_at is NOT set even though every discovered campaign was processed', async () => {
      const account = insertAccount(testDb);

      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query(true).reply(200, {
        data: [campaign('camp_1')],
        paging: { cursors: {}, next: `${BASE}/${VERSION}/${account.meta_account_id}/campaigns?after=BROKEN` },
      });
      nock(BASE).get(`/${VERSION}/${account.meta_account_id}/campaigns`).query({ after: 'BROKEN' }).reply(500, {});
      mockCustomAudiences(account.meta_account_id);
      nock(BASE).get(`/${VERSION}/camp_1/adsets`).query(true).reply(200, { data: [] });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await syncService.syncAccount(fullAccount);

      // camp_1 (the only campaign actually discovered) was fully processed
      // -- proving this isn't a batch-loop-level partial.
      expect(summary.campaigns.synced).toBe(1);
      expect(summary.errors).toEqual([]);
      // But the sweep as a whole is NOT complete, because the campaign
      // LIST itself was incomplete.
      expect(summary.status).toBe('partial');
      expect(summary.partialReason).toBe('page_fetch_error');
      expect(summary.sweepComplete).toBe(false);

      const afterAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      expect(afterAccount.last_sync_status).toBe('partial');
      expect(afterAccount.last_sync_partial_reason).toBe('page_fetch_error');
      // The critical assertion: initial_sync_completed_at must stay NULL.
      expect(afterAccount.initial_sync_completed_at).toBeNull();
      // And the cursor must NOT have been cleared -- camp_1 is still
      // durably recorded as the resume point, so a retry doesn't re-fetch it.
      expect(afterAccount.sync_batch_cursor).toBe('camp_1');
    });
  });
});
