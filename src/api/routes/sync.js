/**
 * Sync Router
 *
 * POST /sync — triggers a manual sync from Meta API to database.
 * Phase 1: sync campaigns, ad sets, ads for all active accounts.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const cache = require('../../services/cacheService');
const { syncAccount, syncAllAccounts } = require('../../services/syncService');
const smartSyncEngine = require('../../services/smartSyncEngine');
const autoSyncScheduler = require('../../services/autoSyncScheduler');
const executionTracker = require('../../services/syncExecutionTracker');
const { asyncHandler } = require('../../middleware/errorHandler');

// Time-Budget Guard (AP-POS Sync Architecture Audit): vercel.json caps every
// function invocation -- including /api/cron/sync -- at maxDuration=60s.
// Without an elapsed-time check, enough active accounts in the loop below
// could silently exceed that ceiling: the platform kills the invocation
// mid-loop, the response never returns, and whichever accounts hadn't been
// reached yet simply never ran that day (not deferred -- skipped, with no
// record of why). DEFAULT_CRON_TIME_BUDGET_MS=50s leaves ~10s of headroom
// for this invocation's own overhead (request routing, response
// serialization) within the 60s ceiling. Configurable via env for the same
// reason SYNC_TIME_BUDGET_MS (syncService.js) is -- do not guess a value
// that outlives vercel.json's own maxDuration if that ever changes.
const DEFAULT_CRON_TIME_BUDGET_MS = 50_000;

function getCronTimeBudgetMs() {
  const parsed = parseInt(process.env.CRON_TIME_BUDGET_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CRON_TIME_BUDGET_MS;
}

/**
 * Shared by POST /sync/refresh-active and the Vercel Cron trigger route
 * (src/api/routes/cron.js) so the "refresh every active, token-valid
 * account" orchestration exists in exactly one place — the cron route
 * calls this directly rather than re-implementing it, per the migration
 * mission's explicit "do not duplicate synchronization logic" rule. The
 * actual sync work (Meta API calls, DB writes, the DB-backed per-account
 * in-flight guard) all still lives in smartSyncEngine.forceSyncActiveAccount(),
 * unchanged.
 *
 * @param {'force_active'|'cron'} source - forwarded to
 *   smartSyncEngine.forceSyncActiveAccount() unchanged. Defaults to
 *   'force_active' (the manual "Refresh Active Data" button's existing,
 *   unchanged behavior: bypasses cadence, always active-only). cron.js
 *   passes 'cron' instead -- the genuinely-automatic recurring trigger,
 *   which respects each tier's own due-check instead of bypassing cadence,
 *   and stays FULL (not active-only) until the account's initial hierarchy
 *   sweep completes -- see smartSyncEngine.runDueForAccount()'s doc comment.
 */
async function refreshAllActiveAccounts(source = 'force_active') {
  // Stalest-synced-first -- same priority shape as autoSyncScheduler.js's
  // runDueAccountsCycle (never-synced accounts first, then accounts with
  // active campaigns, oldest-synced first). Matters now that this loop can
  // be time-budget-truncated (below): an unordered scan would let the same
  // early accounts monopolize every cron tick while later ones never get a
  // turn; this ordering guarantees whichever accounts get deferred today
  // are exactly the ones prioritized on the next tick.
  const accounts = await db.all(
    `SELECT * FROM ad_accounts
     WHERE status = 'active' AND token_is_valid = 1
     ORDER BY
       last_sync_completed_at IS NOT NULL,
       (SELECT COUNT(*) FROM campaigns c WHERE c.ad_account_id = ad_accounts.id AND c.status = 'active') = 0,
       last_sync_completed_at ASC`
  );

  const timeBudgetMs = getCronTimeBudgetMs();
  const loopStartedAt = Date.now();
  const results = [];

  for (const account of accounts) {
    if (Date.now() - loopStartedAt >= timeBudgetMs) {
      console.warn(`[Sync] Time budget (${timeBudgetMs}ms) reached — ${accounts.length - results.length} account(s) deferred to next cycle.`);
      break;
    }

    // One account's uncaught throw (e.g. decryptToken() failing on a
    // corrupted/rotated-key token -- see tokenCrypto.js) must not abort
    // every account still queued behind it in this same cron run.
    // syncService.js's syncAccount() already guards against this exact
    // failure per-account (see its "Automatic Recovery" comment); this
    // loop had no equivalent guard, even though it's the one Vercel Cron
    // actually invokes (see this function's own header comment).
    try {
      results.push(await smartSyncEngine.forceSyncActiveAccount(account, source));
    } catch (err) {
      console.error(`[Cron] Sync threw for account ${account.meta_account_id}:`, err.message);
      results.push({
        accountId: account.id, metaAccountId: account.meta_account_id,
        campaigns: { synced: 0, errors: 1 }, adSets: { synced: 0, errors: 0 }, ads: { synced: 0, errors: 0 },
        errors: [{ level: 'account', message: err.message }], warnings: [],
      });
    }
  }
  return { accounts_synced: results.length, results };
}

/**
 * POST /sync
 *
 * "Force Sync" — with account_id, immediately syncs every entity tier for
 * just that account (bypassing the smart scheduler's cadence, exactly like
 * before) via smartSyncEngine so it's logged/checkpointed the same way the
 * background scheduler is. Does not touch the scheduler's queue/cooldown
 * state — the next scheduled cycle runs exactly as it would have.
 *
 * Optional body:
 *   { account_id: "uuid" } — sync only this account
 *   { sync_ad_sets: false } — skip ad sets and ads (account_id path only;
 *     ignored when force-syncing all accounts, which always runs every tier)
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { account_id, sync_ad_sets = true, sync_ads = true } = req.body || {};

    if (account_id) {
      // Sync a specific account
      const account = await db.get(
        "SELECT * FROM ad_accounts WHERE id = ? AND status = 'active' AND token_is_valid = 1",
        [account_id]
      );

      if (!account) {
        return res.status(404).json({
          error: 'Account not found or not active',
          account_id,
        });
      }

      let result;
      try {
        if (sync_ad_sets === false || sync_ads === false) {
          // Explicit partial sync requested — bypass smartSyncEngine's
          // all-tiers Force Sync and call syncService directly, same as before.
          result = await syncAccount(account, { syncAdSets: sync_ad_sets, syncAds: sync_ads });
        } else {
          result = await smartSyncEngine.forceSyncAccount(account);
        }
      } catch (err) {
        // Structured Force Sync API (AUTONOMOUS META SYNC RECOVERY mission,
        // Phase 13): a rate-limit/tier-level throw from forceSyncAccount()
        // previously fell straight through to errorHandler.js's generic
        // 500 ("Internal server error") -- the actual, already-recorded
        // (sync_live_executions) reason was discarded. Caught here instead
        // so the response reflects the real outcome.
        return res.status(200).json({
          success: false,
          executionId: err.executionId || null,
          account_id,
          status: err.isRateLimit ? 'partial' : 'failed',
          partialReason: err.isRateLimit ? 'rate_limited' : null,
          errorCode: err.isRateLimit ? 'RATE_LIMITED' : 'TIER_ERROR',
          message: err.message,
        });
      }

      return res.json({
        success: result.status !== 'failed',
        executionId: result.executionId || null,
        account_id,
        status: result.status || (result.errors?.length ? 'failed' : 'completed'),
        partialReason: result.partialReason || null,
        errorCode: result.errorCode || null,
        results: [result],
      });
    }

    // Sync all active accounts
    const results = await syncAllAccounts({
      syncAdSets: sync_ad_sets,
      syncAds: sync_ads,
    });

    return res.json({
      success: true,
      accounts_synced: results.length,
      results,
    });
  })
);

/**
 * POST /sync/refresh-active — Phase 39, "Refresh Active Data"
 *
 * Force Refresh (A): immediately re-syncs every tier for the given
 * account(s), bypassing cadence like Force Sync always has, but stays
 * ACTIVE-only -- only ACTIVE campaigns/ad sets/ads are re-requested from
 * Meta. Historical/paused/archived data already in SQLite is never touched
 * or deleted. This is the cheap, fast, safe-to-click-often refresh; for a
 * full historical reload use POST /sync/full ("Full Rebuild") instead.
 *
 * Optional body: { account_id: "uuid" } — omit to refresh every active,
 * token-valid account (sequentially, same queue discipline as the scheduler).
 */
router.post('/refresh-active', asyncHandler(async (req, res) => {
  const { account_id } = req.body || {};

  if (account_id) {
    const account = await db.get(
      "SELECT * FROM ad_accounts WHERE id = ? AND status = 'active' AND token_is_valid = 1",
      [account_id]
    );
    if (!account) {
      return res.status(404).json({ error: 'Account not found or not active', account_id });
    }
    const result = await smartSyncEngine.forceSyncActiveAccount(account);
    return res.json({ success: true, mode: 'refresh_active', results: [result] });
  }

  const { accounts_synced, results } = await refreshAllActiveAccounts();
  return res.json({ success: true, mode: 'refresh_active', accounts_synced, results });
}));

/**
 * POST /sync/full — Phase 39, "Full Sync mode" / Force Refresh (B) "Full Rebuild"
 *
 * The ONLY sync path that ever reloads historical data -- paused/archived
 * campaigns/ad sets/ads included, not just ACTIVE. Never triggered
 * automatically by the background scheduler (which only ever runs
 * incremental, active-only cycles); this is a manual, explicit action only.
 * Equivalent to the existing POST /sync (account_id, default tiers) path --
 * exposed under its own name so the dashboard can offer it as a distinct,
 * clearly-labeled "Full Rebuild" action separate from the cheaper
 * /sync/refresh-active.
 *
 * Optional body: { account_id: "uuid" } — omit to full-rebuild every active,
 * token-valid account (sequentially).
 */
router.post('/full', asyncHandler(async (req, res) => {
  const { account_id } = req.body || {};

  if (account_id) {
    const account = await db.get(
      "SELECT * FROM ad_accounts WHERE id = ? AND status = 'active' AND token_is_valid = 1",
      [account_id]
    );
    if (!account) {
      return res.status(404).json({ error: 'Account not found or not active', account_id });
    }
    const result = await smartSyncEngine.forceSyncAccount(account);
    return res.json({ success: true, mode: 'full_sync', results: [result] });
  }

  const accounts = await db.all("SELECT * FROM ad_accounts WHERE status = 'active' AND token_is_valid = 1");
  const results = [];
  for (const account of accounts) {
    results.push(await smartSyncEngine.forceSyncAccount(account));
  }
  return res.json({ success: true, mode: 'full_sync', accounts_synced: results.length, results });
}));

/**
 * GET /sync/scheduler-status
 * Executive Sync Status feed for the Dashboard: scheduler running/paused,
 * current account/entity/progress, accounts connected/waiting/syncing/
 * completed, Meta API rate-limit status, totals, last error.
 */
router.get('/scheduler-status', asyncHandler(async (req, res) => {
  return res.json({ data: await autoSyncScheduler.getSchedulerStatus() });
}));

/**
 * POST /sync/scheduler/pause and /sync/scheduler/resume
 * Pausing stops the next tick from picking up new work; it does not abort
 * an account sync already in progress. Force Sync (POST /sync with
 * account_id) still works while paused.
 */
router.post('/scheduler/pause', asyncHandler(async (req, res) => {
  return res.json({ data: await autoSyncScheduler.pauseScheduler() });
}));
router.post('/scheduler/resume', asyncHandler(async (req, res) => {
  return res.json({ data: await autoSyncScheduler.resumeScheduler() });
}));

/**
 * GET /sync/history
 * Recent sync execution log rows (Logging requirement) — optionally scoped
 * to one account.
 */
router.get('/history', asyncHandler(async (req, res) => {
  const { account_id, limit } = req.query;
  const rows = await smartSyncEngine.getSyncHistory(limit ? parseInt(limit, 10) : 50, account_id || null);
  return res.json({ data: rows });
}));

/**
 * GET /sync/execution/:id
 * Durable live/finished execution state (AUTONOMOUS META SYNC RECOVERY
 * mission, Phase 12/13) — sync_live_executions, committed incrementally as
 * the run progresses, survives a hard Vercel platform kill unlike anything
 * that only ever lived in console output or in-memory summary objects.
 * Poll this while status='running' to watch a Force Sync live.
 */
router.get('/execution/:id', asyncHandler(async (req, res) => {
  const execution = await executionTracker.getExecution(req.params.id);
  if (!execution) return res.status(404).json({ error: 'Execution not found' });
  const events = await executionTracker.getEvents(req.params.id);
  return res.json({ data: { execution, events } });
}));

/**
 * GET /sync/live/:account_id
 * The most recent execution (running or finished) for one account — what
 * the dashboard polls right after a Force Sync click, before it has an
 * executionId of its own to look up directly.
 */
router.get('/live/:account_id', asyncHandler(async (req, res) => {
  const execution = await executionTracker.getLatestExecutionForAccount(req.params.account_id);
  if (!execution) return res.json({ data: null });
  const events = await executionTracker.getEvents(execution.id);
  return res.json({ data: { execution, events } });
}));

/**
 * GET /sync/freshness/:account_id
 * Per-entity-type data freshness for one account (Data Freshness requirement).
 */
router.get('/freshness/:account_id', asyncHandler(async (req, res) => {
  const account = await db.get('SELECT id FROM ad_accounts WHERE id = ?', [req.params.account_id]);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  return res.json({ data: await smartSyncEngine.getEntityFreshness(req.params.account_id) });
}));

/**
 * GET /sync/status
 * Returns a summary of what's currently in the database.
 */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const accounts = await db.get('SELECT COUNT(*) as count FROM ad_accounts');
    const campaigns = await db.get('SELECT COUNT(*) as count FROM campaigns');
    const adSets = await db.get('SELECT COUNT(*) as count FROM ad_sets');
    const ads = await db.get('SELECT COUNT(*) as count FROM ads');

    const activeCampaigns = await db.get(
      "SELECT COUNT(*) as count FROM campaigns WHERE status = 'active'"
    );

    const latestCampaign = await db.get(
      'SELECT updated_at FROM campaigns ORDER BY updated_at DESC LIMIT 1'
    );

    return res.json({
      database: {
        ad_accounts: accounts?.count || 0,
        campaigns: campaigns?.count || 0,
        ad_sets: adSets?.count || 0,
        ads: ads?.count || 0,
        active_campaigns: activeCampaigns?.count || 0,
      },
      last_sync: latestCampaign?.updated_at || null,
    });
  })
);


/**
 * POST /sync/cache/flush — Phase 4
 * Clears all cached insights data (forces fresh Meta API calls).
 */
router.post('/cache/flush', asyncHandler(async (req, res) => {
  const { account_id } = req.body || {};
  let count;
  if (account_id) {
    const acct = await db.get('SELECT meta_account_id FROM ad_accounts WHERE id = ?', [account_id]);
    count = acct ? cache.invalidateAccount(acct.meta_account_id) : 0;
  } else {
    count = cache.flush();
  }
  return res.json({ success: true, entries_cleared: count });
}));

/**
 * GET /sync/cache/stats — Phase 4
 * Internal diagnostics (cache size/hit/miss counts) -- not needed by the
 * shipped frontend and not appropriate to expose in production. Unlike
 * POST /cache/flush (a real operator action the frontend actually uses),
 * this is pure debug output, so it's disabled outside development rather
 * than left permanently public.
 */
router.get('/cache/stats', asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.json(cache.stats());
}));

module.exports = router;
module.exports.refreshAllActiveAccounts = refreshAllActiveAccounts;
