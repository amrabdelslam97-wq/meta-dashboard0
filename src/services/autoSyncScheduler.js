/**
 * Auto Sync Scheduler — Smart Auto Sync System
 *
 * In-process background scheduler (no external cron/queue -- see CLAUDE.md:
 * this app is a single long-running Node process with no durable in-flight
 * job state, so a periodic re-check is the right amount of machinery). This
 * still gates on the exact same per-account fields Phase 14 introduced
 * (auto_sync_enabled, auto_sync_interval_minutes, status, token_is_valid,
 * last_sync_completed_at) -- unchanged so existing behavior/tests keep
 * working -- but once an account passes that gate, the actual work is
 * delegated to smartSyncEngine, which decides which of the finer-grained
 * entity types (insights/campaigns/adsets/ads/creatives/metadata) are
 * actually due and reuses the existing syncService/metaApiClient to do it.
 *
 * Queue: accounts are processed strictly sequentially, one full account at a
 * time, oldest-synced-first -- never in parallel, so Meta never sees more
 * than one in-flight sync from this app at once.
 *
 * Rate limits: metaApiClient already retries individual requests internally
 * (exponential backoff on Meta's 4/17/32/613 codes). If a request still
 * fails as rate-limited after that, this scheduler additionally backs the
 * *whole account* off for a growing cool-down (1m, 2m, 4m, ... capped at
 * 60m) so a throttled account stops being retried every tick and doesn't
 * starve other accounts of API budget. Whatever entity types didn't get to
 * run this cycle simply remain "due" in sync_entity_state -- next cycle
 * (or after a restart) picks up exactly where it left off, never restarting
 * the whole account from zero.
 *
 * Only started from src/app.js's start() (the real server), never from
 * createApp() -- Supertest boots createApp() directly in-process for many
 * tests, and a live interval left running across the whole Jest suite would
 * fire real Meta API calls / keep the process alive after tests finish.
 */

const db = require('../db/database');
const smartSyncEngine = require('./smartSyncEngine');
const rateLimitMemory = require('./rateLimitMemory');

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // re-check every 2 minutes
const MAX_COOLDOWN_MS = rateLimitMemory.MAX_BACKOFF_MS; // cap account backoff at 60 minutes

let intervalHandle = null;

// ── Live (in-memory, ephemeral) scheduler state for the dashboard ──
// Deliberately NOT persisted to the DB: it's re-derived from ad_accounts +
// sync_entity_state on every tick, and persisting ephemeral progress would
// mean an extra full-database export/rewrite (see database.js) on every
// sub-step of every cycle, which CLAUDE.md flags as the actual cost driver
// in this app's sql.js-backed storage.
const state = {
  status: 'running', // 'running' | 'paused'
  cycleStartedAt: null,
  queue: [],          // account ids for the in-progress cycle, oldest-synced-first
  currentIndex: -1,
  currentAccountId: null,
  currentEntityType: null,
  lastError: null,
  lastErrorAt: null,
  retryCounter: 0,    // cumulative rate-limit retries observed since process start
  completedThisCycle: [],
};

// Backoff Memory (Phase 39, requirement 9): cooldown state now lives on
// ad_accounts.rate_limit_backoff_until/rate_limit_fail_count (see
// rateLimitMemory.js), not an in-memory Map -- it survives a process
// restart (a Railway redeploy, a crash) instead of being silently forgotten,
// which previously meant an account throttled right before a restart got
// hammered again immediately once the process came back up.

function minutesSince(isoString) {
  if (!isoString) return Infinity;
  return (Date.now() - new Date(isoString).getTime()) / 60000;
}

let cycleRunning = false;

async function runDueAccounts() {
  if (state.status === 'paused') return;

  // Guard against overlapping ticks: setInterval fires every
  // CHECK_INTERVAL_MS regardless of whether the previous runDueAccounts()
  // call has resolved. Confirmed in production that a single account's
  // sync can take 60+ minutes when rate-limited (sync_execution_log),
  // which is far longer than the 2-minute tick -- without this guard, a
  // second cycle would start scanning/syncing the same due accounts
  // concurrently with the first.
  if (cycleRunning) {
    console.warn('[AutoSync] Previous cycle still running -- skipping this tick.');
    return;
  }
  cycleRunning = true;

  try {
    await runDueAccountsCycle();
  } finally {
    cycleRunning = false;
  }
}

async function runDueAccountsCycle() {
  // Scheduler Priority (Phase 39, requirement 10):
  //   1. Accounts never synchronized              (last_sync_completed_at IS NULL)
  //   2 + 3. Accounts with active campaigns, oldest-synced (stalest) first
  //   4. Remaining accounts, oldest-synced first
  // A single ORDER BY tuple encodes all four: the never-synced tier sorts
  // first outright, then within "has synced before" accounts with at least
  // one ACTIVE campaign sort ahead of accounts with none, and staleness
  // (last_sync_completed_at ASC) is the tiebreaker in every tier -- so
  // "stale data" (tier 2) is naturally folded into whichever tier an
  // account already falls into rather than needing a separate pass.
  const accounts = db.all(
    `SELECT * FROM ad_accounts
     WHERE auto_sync_enabled = 1 AND status = 'active' AND token_is_valid = 1
     ORDER BY
       last_sync_completed_at IS NOT NULL,
       (SELECT COUNT(*) FROM campaigns c WHERE c.ad_account_id = ad_accounts.id AND c.status = 'active') = 0,
       last_sync_completed_at ASC`
  );

  state.queue = accounts.map(a => a.id);
  state.cycleStartedAt = new Date().toISOString();
  state.completedThisCycle = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    state.currentIndex = i;
    state.currentAccountId = account.id;
    state.currentEntityType = null;

    const interval = account.auto_sync_interval_minutes || 60;
    const dueAt = account.last_sync_completed_at || account.last_sync_started_at;
    if (minutesSince(dueAt) < interval) { state.completedThisCycle.push(account.id); continue; }

    // Backoff Memory (requirement 9): read straight from the row this cycle
    // already fetched (rate_limit_backoff_until, persisted -- see
    // rateLimitMemory.js) instead of an in-memory-only cooldown map.
    if (rateLimitMemory.isInBackoff(account)) { state.completedThisCycle.push(account.id); continue; }

    try {
      await smartSyncEngine.runDueForAccount(account, 'scheduler', (entityType) => {
        state.currentEntityType = entityType;
      });
      rateLimitMemory.clearBackoff(account.id);
    } catch (err) {
      state.lastError = err.message;
      state.lastErrorAt = new Date().toISOString();
      if (smartSyncEngine.isRateLimitError(err)) {
        state.retryCounter++;
        const { backoffMs } = rateLimitMemory.recordRateLimitHit(account.id);
        console.warn(`[AutoSync] Rate limited on account ${account.id} — cooling down ${Math.round(backoffMs / 1000)}s (Automatic Recovery: remaining accounts continue this cycle)`);
      } else {
        console.error(`[AutoSync] Sync failed for account ${account.id}:`, err.message);
      }
    }
    state.completedThisCycle.push(account.id);
  }

  state.currentAccountId = null;
  state.currentEntityType = null;
}

function startAutoSyncScheduler() {
  if (intervalHandle) return intervalHandle; // already running
  intervalHandle = setInterval(() => {
    runDueAccounts().catch(err => console.error('[AutoSync] Scheduler tick failed:', err.message));
  }, CHECK_INTERVAL_MS);
  intervalHandle.unref?.(); // don't keep the process alive solely for this timer
  console.log(`[AutoSync] Smart scheduler started (checking every ${CHECK_INTERVAL_MS / 60000} minutes).`);
  return intervalHandle;
}

function stopAutoSyncScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function pauseScheduler() {
  state.status = 'paused';
  return getSchedulerStatus();
}

function resumeScheduler() {
  state.status = 'running';
  return getSchedulerStatus();
}

function minutesToMs(minutes) {
  return minutes * 60000;
}

/**
 * Per-account breakdown for the Dashboard's Executive Sync Status section
 * (Task 5) and each Account card (Task 6) -- one row per connected account,
 * everything already computed elsewhere (accounts table + this module's own
 * in-memory queue/cooldown state + smartSyncEngine's freshness helper), no
 * new sync mechanism, no duplicated scheduling logic.
 */
function getPerAccountStatus() {
  const accounts = db.all(
    `SELECT id, account_name, status, auto_sync_enabled, auto_sync_interval_minutes,
            last_sync_completed_at, last_sync_started_at, last_successful_sync_at,
            last_failed_sync_at, last_sync_status, last_sync_error,
            last_full_sync_at, rate_limit_backoff_until
     FROM ad_accounts
     ORDER BY account_name ASC`
  );

  return accounts.map(a => {
    const enabled = Boolean(a.auto_sync_enabled);
    const inCooldown = rateLimitMemory.isInBackoff(a);
    const queueIndex = state.queue.indexOf(a.id);
    const isCurrent = state.currentAccountId === a.id;

    const dueAt = a.last_sync_completed_at || a.last_sync_started_at;
    const nextScheduledAt = enabled && a.status === 'active' && dueAt
      ? new Date(new Date(dueAt).getTime() + minutesToMs(a.auto_sync_interval_minutes || 60)).toISOString()
      : (enabled && a.status === 'active' ? 'due now (never synced)' : null);

    let schedulerState;
    if (!enabled) schedulerState = 'disabled';
    else if (a.status !== 'active') schedulerState = 'disconnected';
    else if (isCurrent) schedulerState = 'syncing';
    else if (inCooldown) schedulerState = 'cooldown';
    else if (queueIndex !== -1 && !state.completedThisCycle.includes(a.id)) schedulerState = 'queued';
    else schedulerState = 'idle';

    return {
      id: a.id,
      account_name: a.account_name,
      auto_sync_enabled: enabled,
      scheduler_state: schedulerState,
      last_successful_sync_at: a.last_successful_sync_at || null,
      last_failed_sync_at: a.last_failed_sync_at || null,
      last_full_sync_at: a.last_full_sync_at || null,
      last_sync_status: a.last_sync_status || 'idle',
      last_sync_error: a.last_sync_error || null,
      next_scheduled_sync_at: nextScheduledAt,
      queue_position: queueIndex !== -1 ? queueIndex + 1 : null,
      queue_size: state.queue.length || null,
      current_sync_tier: isCurrent ? state.currentEntityType : null,
      cooldown_resumes_at: inCooldown ? a.rate_limit_backoff_until : null,
      freshness: smartSyncEngine.getEntityFreshness(a.id),
    };
  });
}

/** Live snapshot for the dashboard's Executive Sync Status section. */
function getSchedulerStatus() {
  const eligible = db.get(
    `SELECT COUNT(*) as count FROM ad_accounts WHERE auto_sync_enabled = 1 AND status = 'active' AND token_is_valid = 1`
  );
  const totals = db.get(`
    SELECT
      (SELECT COUNT(*) FROM ad_accounts) as accounts,
      (SELECT COUNT(*) FROM campaigns) as campaigns,
      (SELECT COUNT(*) FROM ad_sets) as ad_sets,
      (SELECT COUNT(*) FROM ads) as ads
  `);
  const lastSuccess = db.get(`SELECT MAX(last_successful_sync_at) as t FROM ad_accounts`);
  const lastFailed = db.get(`SELECT MAX(last_failed_sync_at) as t FROM ad_accounts`);
  const avgDuration = db.get(
    `SELECT AVG(duration_ms) as avg_ms FROM sync_execution_log WHERE started_at >= datetime('now', '-24 hours')`
  );

  const currentAccount = state.currentAccountId
    ? db.get('SELECT id, account_name FROM ad_accounts WHERE id = ?', [state.currentAccountId])
    : null;

  // Backoff Memory (requirement 9): read the persisted per-account
  // cooldowns straight from ad_accounts instead of an in-memory Map, so
  // this snapshot is accurate even immediately after a process restart.
  // Filtered in JS, not SQL -- rate_limit_backoff_until is a JS
  // toISOString() string ("...T...Z") while SQLite's datetime('now') uses
  // a different format ("... ..."), so a raw SQL string comparison between
  // them is not reliably chronological.
  const accountsInCooldown = db.all(
    `SELECT id, rate_limit_backoff_until FROM ad_accounts WHERE rate_limit_backoff_until IS NOT NULL`
  ).filter(a => new Date(a.rate_limit_backoff_until).getTime() > Date.now());

  const queueSize = state.queue.length;
  const queuePosition = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
  const completed = state.completedThisCycle.length;
  const waiting = Math.max(queueSize - completed - (state.currentAccountId ? 1 : 0), 0);
  const syncing = state.currentAccountId ? 1 : 0;

  return {
    scheduler_status: state.status,
    cycle_started_at: state.cycleStartedAt,
    next_scheduled_at: intervalHandle ? new Date(Date.now() + CHECK_INTERVAL_MS).toISOString() : null,
    current_account: currentAccount ? { id: currentAccount.id, name: currentAccount.account_name } : null,
    current_entity_type: state.currentEntityType,
    queue_position: queuePosition,
    queue_size: queueSize,
    progress_pct: queueSize > 0 ? Math.round((completed / queueSize) * 100) : 100,
    accounts: {
      connected: totals.accounts,
      eligible_for_auto_sync: eligible.count,
      waiting,
      syncing,
      completed,
    },
    last_successful_sync_at: lastSuccess.t || null,
    last_failed_sync_at: lastFailed.t || null,
    average_sync_duration_ms: avgDuration.avg_ms ? Math.round(avgDuration.avg_ms) : null,
    meta_api: {
      rate_limit_status: accountsInCooldown.length > 0 ? 'limited' : 'ok',
      accounts_in_cooldown: accountsInCooldown.map(a => ({ account_id: a.id, resumes_at: a.rate_limit_backoff_until })),
      retry_counter: state.retryCounter,
    },
    totals: {
      campaigns: totals.campaigns,
      ad_sets: totals.ad_sets,
      ads: totals.ads,
    },
    last_error: state.lastError,
    last_error_at: state.lastErrorAt,
    per_account: getPerAccountStatus(),
  };
}

module.exports = {
  startAutoSyncScheduler,
  stopAutoSyncScheduler,
  runDueAccounts,
  pauseScheduler,
  resumeScheduler,
  getSchedulerStatus,
  getPerAccountStatus,
};
