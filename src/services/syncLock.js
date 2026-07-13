/**
 * Sync Lock (Phase 39, requirement 16 — "Prevent Concurrent Sync")
 *
 * A tiny in-process mutex, keyed by ad_account_id, so at most one
 * synchronization runs for a given account at a time regardless of which
 * trigger started it -- the background Scheduler's periodic tick, a manual
 * "Force Sync" / "Refresh Active Data" / "Full Rebuild" button, or the
 * startup interrupted-sync recovery path. All of those funnel through
 * smartSyncEngine.runDueForAccount() (directly, or via forceSyncAccount() /
 * forceSyncActiveAccount()), so wrapping that single entry point closes the
 * race for every trigger at once without duplicating the guard per call site.
 *
 * This is intentionally NOT the same mechanism as syncService.syncAccount()'s
 * own last_sync_status='running' DB check (which predates this and still
 * guards direct syncAccount() callers, e.g. POST /sync with sync_ad_sets:
 * false) -- that one is durable/DB-backed (survives a restart) but only
 * covers the campaign/adset/ad tree tier. This one is process-memory-only
 * (cheap, no extra persist() cost) and covers every tier (insights,
 * metadata, analytics too), which is what requirement 16 actually asks for.
 */

const locked = new Set();

/** @returns {boolean} true if the lock was acquired, false if already held. */
function acquire(accountId) {
  if (locked.has(accountId)) return false;
  locked.add(accountId);
  return true;
}

function release(accountId) {
  locked.delete(accountId);
}

function isLocked(accountId) {
  return locked.has(accountId);
}

module.exports = { acquire, release, isLocked };
