/**
 * Freshness Helper — Phase 38
 *
 * Small, additive compatibility layer: computes a standardized "how fresh
 * is this synced data" shape from ad_accounts' EXISTING sync-tracking
 * columns (last_successful_sync_at / last_sync_completed_at -- both already
 * written by syncService.js on every sync, no new columns, no new sync
 * logic). Endpoints attach the result as one new top-level field; nothing
 * about their existing response shape changes.
 *
 * Deliberately does not call Meta at all -- "freshness" here means "how
 * old is the local copy", which is exactly what the dashboard needs to
 * decide whether to show a plain number or an "Updated N ago" caveat,
 * without spending any Meta API budget to compute it.
 */

const DEFAULT_STALE_THRESHOLD_MINUTES = parseInt(process.env.STALE_THRESHOLD_MINUTES, 10) || 60;

function ageMinutesFrom(isoString) {
  if (!isoString) return null;
  return Math.round((Date.now() - new Date(isoString).getTime()) / 60000);
}

/**
 * Freshness for a single account (used whenever a request is scoped to
 * one account_id).
 */
function buildFreshness(account, thresholdMinutes = DEFAULT_STALE_THRESHOLD_MINUTES) {
  const lastSyncAt = account?.last_successful_sync_at || account?.last_sync_completed_at || null;
  const ageMinutes = ageMinutesFrom(lastSyncAt);
  return {
    last_sync_at: lastSyncAt,
    data_source: 'sqlite',
    sync_age_minutes: ageMinutes,
    stale: ageMinutes === null || ageMinutes > thresholdMinutes,
  };
}

/**
 * Portfolio-wide freshness (used for "All Accounts" views with no single
 * account_id to report against). Reports the OLDEST successful sync among
 * the given accounts -- i.e. errs toward flagging staleness rather than
 * hiding it behind whichever account happens to have synced most recently.
 */
function buildPortfolioFreshness(accounts, thresholdMinutes = DEFAULT_STALE_THRESHOLD_MINUTES) {
  if (!accounts || accounts.length === 0) {
    return { last_sync_at: null, data_source: 'sqlite', sync_age_minutes: null, stale: true };
  }
  let oldest = null;
  for (const a of accounts) {
    const t = a.last_successful_sync_at || a.last_sync_completed_at || null;
    if (t && (oldest === null || new Date(t) < new Date(oldest))) oldest = t;
  }
  const ageMinutes = ageMinutesFrom(oldest);
  return {
    last_sync_at: oldest,
    data_source: 'sqlite',
    sync_age_minutes: ageMinutes,
    stale: ageMinutes === null || ageMinutes > thresholdMinutes,
  };
}

module.exports = { buildFreshness, buildPortfolioFreshness, DEFAULT_STALE_THRESHOLD_MINUTES };
