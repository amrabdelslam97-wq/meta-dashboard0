/**
 * Rate Limit Memory (Phase 39, requirement 9 — "Backoff Memory")
 *
 * Durable, per-account "when is this account next allowed to sync"
 * bookkeeping. Before this module existed, autoSyncScheduler.js tracked
 * cooldowns purely in an in-memory Map -- forgotten on every process
 * restart (a Railway redeploy, a crash, a manual restart), so an account
 * that had just been throttled would immediately be retried again as soon
 * as the process came back up, defeating the whole point of backing off.
 *
 * Backed by three columns on ad_accounts (schema.phase31.js):
 *   rate_limit_backoff_until — ISO timestamp; "next_allowed_sync". NULL
 *     means not currently backed off.
 *   rate_limit_fail_count    — consecutive rate-limit hits; drives the
 *     exponential backoff growth (1m, 2m, 4m, ... capped at 60m), the same
 *     formula autoSyncScheduler.js used in-memory before this.
 *   (last_full_sync_at lives on the same table but is owned by
 *   smartSyncEngine.js, not this module.)
 */

const db = require('../db/database');

const MAX_BACKOFF_MS = 60 * 60 * 1000; // 60 minutes, same ceiling as before

function isInBackoff(account) {
  const until = account?.rate_limit_backoff_until;
  return !!(until && new Date(until).getTime() > Date.now());
}

function getBackoffUntil(accountId) {
  const row = db.get('SELECT rate_limit_backoff_until FROM ad_accounts WHERE id = ?', [accountId]);
  return row?.rate_limit_backoff_until || null;
}

/**
 * Record a rate-limit hit for this account and compute its next allowed
 * sync time using exponential backoff (1m * 2^failCount, capped at 60m).
 * @returns {{ backoffMs: number, until: string }}
 */
function recordRateLimitHit(accountId) {
  const row = db.get('SELECT rate_limit_fail_count FROM ad_accounts WHERE id = ?', [accountId]);
  const failCount = row?.rate_limit_fail_count || 0;
  const backoffMs = Math.min(60_000 * Math.pow(2, failCount), MAX_BACKOFF_MS);
  const until = new Date(Date.now() + backoffMs).toISOString();

  db.run(
    `UPDATE ad_accounts SET rate_limit_backoff_until = ?, rate_limit_fail_count = ? WHERE id = ?`,
    [until, failCount + 1, accountId]
  );

  return { backoffMs, until };
}

/** Clear an account's backoff -- called after a successful sync. */
function clearBackoff(accountId) {
  db.run(
    `UPDATE ad_accounts SET rate_limit_backoff_until = NULL, rate_limit_fail_count = 0 WHERE id = ?`,
    [accountId]
  );
}

module.exports = {
  isInBackoff,
  getBackoffUntil,
  recordRateLimitHit,
  clearBackoff,
  MAX_BACKOFF_MS,
};
