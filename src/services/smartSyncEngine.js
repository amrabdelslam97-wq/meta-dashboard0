/**
 * Smart Sync Engine
 *
 * The "what to sync and how to log it" layer for the Smart Auto Sync System.
 * Sits on top of the existing, untouched syncService/metaApiClient/
 * metricsFetcher -- this module never talks to graph.facebook.com directly
 * except for the one-off account-info refresh (metadata tier), which reuses
 * metaApiClient.metaGet exactly like accounts.js's existing test-connection
 * route already does.
 *
 * Priority / entity types (highest frequency first, per spec):
 *   1. insights   — warms the existing Insights cache (metricsFetcher +
 *                    cacheService) for the account's campaigns. No new
 *                    table: Insights were never persisted, only cached.
 *   2. campaigns  — campaign metadata (syncService.syncAccount, adsets/ads off)
 *   3. adsets     — escalates syncService.syncAccount to include ad sets
 *   4. ads        — escalates to include ads
 *   5. creatives  — rides along with ads (Meta returns creative fields in
 *                    the same ads fetch -- see syncService/metaApiClient
 *                    fetchAds()), tracked with its own (slower) cadence
 *   6. metadata   — account-level info (currency/timezone/business_name/status)
 *
 * Because campaigns → adsets → ads is a strict tree (fetching ad sets
 * requires the campaign list, fetching ads requires the ad set list),
 * "only request what needs refreshing" is implemented as a depth escalation:
 * the deepest due tier decides how far syncService.syncAccount walks the
 * tree in a *single* Meta fetch pass, and each shallower tier that rode
 * along for free is still checkpointed/logged independently.
 *
 * ad_accounts.last_sync_status/last_sync_started_at/last_sync_completed_at/
 * last_successful_sync_at/last_failed_sync_at remain owned EXCLUSIVELY by
 * syncService.syncAccount(), unchanged -- this module only ever writes to
 * its own sync_entity_state/sync_execution_log tables, so it can never
 * clobber that existing tracking or any test/behavior built on it.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { syncAccount } = require('./syncService');
const { metaGet } = require('./metaApiClient');
const { decryptToken } = require('./tokenCrypto');
const { fetchCampaignMetrics } = require('./metricsFetcher');
const { defaultRange } = require('./dateRangeHelper');
const { DEFAULT_INTERVALS } = require('../db/schema.phase16');
const analyticsEngine = require('./analyticsEngine');
const creativeAnalytics = require('./creativeAnalytics');
const budgetDistributionAnalytics = require('./budgetDistributionAnalytics');
const audienceAttributionEngine = require('./audienceAttributionEngine');
const customerJourneyEngine = require('./customerJourneyEngine');
const attributionWindowEngine = require('./attributionWindowEngine');
const languageAttributionEngine = require('./languageAttributionEngine');

const ENTITY_TYPES = ['insights', 'campaigns', 'adsets', 'ads', 'creatives', 'metadata', 'analytics'];

// Fallback default for the 'analytics' tier (Executive Marketing Analytics
// Layer, Phase 17) if sync_schedule_config's seeded row (schema.phase19.js)
// is ever missing -- mirrors DEFAULT_INTERVALS' own role for the six
// original tiers, which don't cover this newer entity_type.
const ANALYTICS_TIER_FALLBACK_INTERVAL = 360;

// Meta's standard rate-limit/throttling error codes (mirrors metaApiClient.js
// -- duplicated as a small constant, not re-implemented, since metaApiClient
// deliberately keeps this private and already retries internally).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

function isRateLimitError(err) {
  if (!err) return false;
  if (err.isRateLimit) return true;
  if (err.isMetaError && RATE_LIMIT_CODES.has(err.code)) return true;
  return false;
}

// ─────────────────────────────────────────────
// Schedule config (Settings-configurable intervals)
// ─────────────────────────────────────────────

function getScheduleConfig() {
  const rows = db.all('SELECT entity_type, interval_minutes FROM sync_schedule_config');
  const config = { ...DEFAULT_INTERVALS, analytics: ANALYTICS_TIER_FALLBACK_INTERVAL };
  for (const row of rows) config[row.entity_type] = row.interval_minutes;
  return config;
}

function setScheduleInterval(entityType, minutes) {
  if (!ENTITY_TYPES.includes(entityType)) {
    throw Object.assign(new Error(`Unknown entity_type: ${entityType}`), { status: 400 });
  }
  const parsed = parseInt(minutes, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw Object.assign(new Error('interval_minutes must be a number >= 1'), { status: 400 });
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO sync_schedule_config (entity_type, interval_minutes, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(entity_type) DO UPDATE SET interval_minutes = excluded.interval_minutes, updated_at = excluded.updated_at`,
    [entityType, parsed, now]
  );
  return { entity_type: entityType, interval_minutes: parsed };
}

// ─────────────────────────────────────────────
// Entity state (durable checkpoint / freshness / resume)
// ─────────────────────────────────────────────

function getEntityStates(adAccountId) {
  const rows = db.all('SELECT * FROM sync_entity_state WHERE ad_account_id = ?', [adAccountId]);
  const byType = {};
  for (const row of rows) byType[row.entity_type] = row;
  return byType;
}

function minutesSince(isoString) {
  if (!isoString) return Infinity;
  return (Date.now() - new Date(isoString).getTime()) / 60000;
}

/** Is this entity type due, ignoring any in-memory rate-limit cooldown (the scheduler applies that separately). */
function isDue(state, intervalMinutes) {
  if (!state) return true; // never synced -- immediately due, same semantics as the legacy account-level check
  const referencePoint = state.last_sync_completed_at; // set on every attempt, success or failure
  return minutesSince(referencePoint) >= intervalMinutes;
}

function upsertEntityState(adAccountId, entityType, patch) {
  const now = new Date().toISOString();
  const existing = db.get(
    'SELECT id FROM sync_entity_state WHERE ad_account_id = ? AND entity_type = ?',
    [adAccountId, entityType]
  );
  if (existing) {
    const fields = Object.keys(patch);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    db.run(
      `UPDATE sync_entity_state SET ${setClause}, updated_at = ? WHERE id = ?`,
      [...fields.map(f => patch[f]), now, existing.id]
    );
  } else {
    const id = uuidv4();
    const fields = Object.keys(patch);
    db.run(
      `INSERT INTO sync_entity_state (id, ad_account_id, entity_type, ${fields.join(', ')}, created_at, updated_at)
       VALUES (?, ?, ?, ${fields.map(() => '?').join(', ')}, ?, ?)`,
      [id, adAccountId, entityType, ...fields.map(f => patch[f]), now, now]
    );
  }
}

// ─────────────────────────────────────────────
// Execution logging (history for the Logging requirement)
// ─────────────────────────────────────────────

function recordExecution(adAccountId, entityType, source, result) {
  const {
    startedAt, finishedAt, recordsCreated = 0, recordsUpdated = 0, recordsFailed = 0,
    apiCalls = 0, retries = 0, rateLimited = false, status, errorMessage = null,
  } = result;
  const durationMs = finishedAt && startedAt
    ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
    : null;

  db.run(
    `INSERT INTO sync_execution_log (
      id, ad_account_id, entity_type, source, started_at, finished_at, duration_ms,
      records_created, records_updated, records_failed, api_calls, retries, rate_limited,
      status, error_message
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      uuidv4(), adAccountId, entityType, source, startedAt, finishedAt, durationMs,
      recordsCreated, recordsUpdated, recordsFailed, apiCalls, retries, rateLimited ? 1 : 0,
      status, errorMessage,
    ]
  );

  upsertEntityState(adAccountId, entityType, {
    last_sync_started_at: startedAt,
    last_sync_completed_at: finishedAt,
    last_success_at: status === 'success' ? finishedAt : (getEntityStates(adAccountId)[entityType]?.last_success_at ?? null),
    last_failed_at: status !== 'success' ? finishedAt : (getEntityStates(adAccountId)[entityType]?.last_failed_at ?? null),
    last_error: errorMessage,
    sync_source: source,
    duration_ms: durationMs,
  });

  return durationMs;
}

// ─────────────────────────────────────────────
// Per-entity-type sync execution
// ─────────────────────────────────────────────

/** Tier 1: warm the existing Insights cache for this account's known campaigns. */
async function runInsightsTier(account, accessToken, source) {
  const startedAt = new Date().toISOString();
  const campaigns = db.all(
    "SELECT meta_campaign_id FROM campaigns WHERE ad_account_id = ? AND status != 'archived'",
    [account.id]
  );

  let apiCalls = 0, updated = 0, failed = 0, retries = 0, rateLimited = false, lastError = null;

  for (const c of campaigns) {
    try {
      apiCalls++;
      await fetchCampaignMetrics(c.meta_campaign_id, accessToken, defaultRange(), account.attribution_window_days);
      updated++;
    } catch (err) {
      failed++;
      lastError = err.message;
      if (isRateLimitError(err)) {
        rateLimited = true;
        retries = 3; // metaGet already exhausted its internal retry budget before surfacing this
        break; // Meta is actively throttling this account -- stop hammering it this cycle
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const status = rateLimited ? 'failed' : (failed > 0 && updated === 0 && campaigns.length > 0 ? 'failed' : 'success');
  recordExecution(account.id, 'insights', source, {
    startedAt, finishedAt, recordsUpdated: updated, recordsFailed: failed,
    apiCalls, retries, rateLimited, status, errorMessage: lastError,
  });
  if (rateLimited) { const e = new Error(lastError || 'Rate limited'); e.isRateLimit = true; throw e; }
}

/** Tier 6: lightweight account-info refresh (currency/timezone/business_name/status). */
async function runMetadataTier(account, accessToken, source) {
  const startedAt = new Date().toISOString();
  let status = 'success', errorMessage = null, rateLimited = false, updated = 0, failed = 0;

  try {
    const info = await metaGet(
      account.meta_account_id,
      { fields: 'id,name,currency,timezone_name,business_name,account_status' },
      accessToken
    );
    const now = new Date().toISOString();
    db.run(
      `UPDATE ad_accounts SET currency = ?, timezone = ?, business_name = COALESCE(?, business_name), updated_at = ? WHERE id = ?`,
      [info.currency || account.currency, info.timezone_name || account.timezone, info.business_name || null, now, account.id]
    );
    updated = 1;
  } catch (err) {
    failed = 1;
    errorMessage = err.message;
    rateLimited = isRateLimitError(err);
    status = 'failed';
  }

  const finishedAt = new Date().toISOString();
  recordExecution(account.id, 'metadata', source, {
    startedAt, finishedAt, recordsUpdated: updated, recordsFailed: failed,
    apiCalls: 1, retries: rateLimited ? 3 : 0, rateLimited, status, errorMessage,
  });
  if (rateLimited) { const e = new Error(errorMessage); e.isRateLimit = true; throw e; }
}

/**
 * Analytics tier (Executive Marketing Analytics Layer, Phase 17): audience/
 * geographic/placement/device breakdowns (analyticsEngine.js), creative
 * detail + video performance (creativeAnalytics.js), and budget allocation
 * (budgetDistributionAnalytics.js) -- each already rate-limit-aware and
 * capped per cycle (MAX_CAMPAIGNS_PER_CYCLE/MAX_ADS_PER_CYCLE) on its own,
 * so this tier just sequences the three and rolls their results into one
 * execution-log entry, same shape as every other tier.
 */
async function runAnalyticsTier(account, source) {
  const startedAt = new Date().toISOString();
  const dateRange = defaultRange();
  let updated = 0, failed = 0, apiCalls = 0, rateLimited = false, status = 'success', errorMessage = null;
  const errors = [];

  const steps = [
    ['breakdowns', () => analyticsEngine.syncAccountAnalytics(account, dateRange)],
    ['creatives', () => creativeAnalytics.syncAccountCreativeAnalytics(account, dateRange)],
    ['budget', () => budgetDistributionAnalytics.syncAccountBudgetDistribution(account, dateRange)],
    ['audience_attribution', () => audienceAttributionEngine.syncAccountAudienceAttribution(account, dateRange)],
    ['customer_journey', () => customerJourneyEngine.syncAccountCustomerJourney(account, dateRange)],
    ['attribution_windows', () => attributionWindowEngine.syncAccountAttributionWindows(account, dateRange)],
    ['language_attribution', () => languageAttributionEngine.syncAccountLanguageAttribution(account, dateRange)],
  ];

  for (const [label, run] of steps) {
    try {
      const result = await run();
      apiCalls += result.apiCalls || 0;
      updated += result.campaignsProcessed || result.adsProcessed || 0;
      if (result.errors?.length) {
        failed += result.errors.length;
        errors.push(...result.errors.map(e => ({ step: label, ...e })));
      }
    } catch (err) {
      failed++;
      errors.push({ step: label, message: err.message });
      if (isRateLimitError(err)) {
        rateLimited = true;
        break; // Meta is actively throttling this account -- stop this tier's remaining steps this cycle
      }
    }
  }

  if (errors.length > 0) {
    status = rateLimited ? 'failed' : 'partial';
    errorMessage = errors.map(e => `[${e.step}] ${e.message}`).join('; ');
  }

  const finishedAt = new Date().toISOString();
  recordExecution(account.id, 'analytics', source, {
    startedAt, finishedAt, recordsUpdated: updated, recordsFailed: failed,
    apiCalls, retries: rateLimited ? 3 : 0, rateLimited, status, errorMessage,
  });

  if (rateLimited) { const e = new Error(errorMessage); e.isRateLimit = true; throw e; }
}

/**
 * Tiers 2–5 (campaigns/adsets/ads/creatives): a single syncService.syncAccount
 * call walked exactly as deep as the deepest due tier requires, then
 * checkpointed/logged separately per tier so freshness/cadence stays
 * independent even though the underlying Meta fetch was shared.
 */
async function runCampaignTreeTiers(account, dueTiers, source) {
  const syncAdSets = dueTiers.adsets || dueTiers.ads || dueTiers.creatives;
  const syncAds = dueTiers.ads || dueTiers.creatives;
  const startedAt = new Date().toISOString();

  let summary, status = 'success', errorMessage = null, rateLimited = false;
  try {
    summary = await syncAccount(account, { syncAdSets, syncAds });
    if (summary.errors && summary.errors.length > 0) {
      // A 'account'-level error means fetchCampaigns itself failed (see
      // syncService.js's early-return path) -- nothing at all was synced,
      // so this is a hard failure, not a partial success.
      status = summary.errors.some(e => e.level === 'account') ? 'failed' : 'partial';
      errorMessage = summary.errors.map(e => `[${e.level}] ${e.message}`).join('; ');
      rateLimited = summary.errors.some(e => /rate.?limit|limit reached|too many requests|429/i.test(e.message || ''));
    }
  } catch (err) {
    status = 'failed';
    errorMessage = err.message;
    rateLimited = isRateLimitError(err);
    summary = { campaigns: { synced: 0, errors: 1 }, adSets: { synced: 0, errors: 0 }, ads: { synced: 0, errors: 0 } };
  }
  const finishedAt = new Date().toISOString();

  if (dueTiers.campaigns) {
    recordExecution(account.id, 'campaigns', source, {
      startedAt, finishedAt, recordsUpdated: summary.campaigns.synced, recordsFailed: summary.campaigns.errors,
      apiCalls: 1, status, errorMessage, rateLimited,
    });
  }
  if (dueTiers.adsets && syncAdSets) {
    recordExecution(account.id, 'adsets', source, {
      startedAt, finishedAt, recordsUpdated: summary.adSets.synced, recordsFailed: summary.adSets.errors,
      apiCalls: summary.campaigns.synced, status, errorMessage, rateLimited,
    });
  }
  if (dueTiers.ads && syncAds) {
    recordExecution(account.id, 'ads', source, {
      startedAt, finishedAt, recordsUpdated: summary.ads.synced, recordsFailed: summary.ads.errors,
      apiCalls: summary.adSets.synced, status, errorMessage, rateLimited,
    });
  }
  if (dueTiers.creatives && syncAds) {
    recordExecution(account.id, 'creatives', source, {
      startedAt, finishedAt, recordsUpdated: summary.ads.synced, recordsFailed: summary.ads.errors,
      apiCalls: 0, status, errorMessage, rateLimited,
    });
  }

  if (rateLimited) { const e = new Error(errorMessage || 'Rate limited'); e.isRateLimit = true; throw e; }
  return summary;
}

// ─────────────────────────────────────────────
// One-Time Effective Status Backfill (Task 3).
//
// campaigns/ad_sets/ads.effective_status (Phase 15) is only ever populated
// as a side effect of a normal metadata sync -- fetchCampaigns()/
// fetchAdSets()/fetchAds() already request it in their `fields` param (no
// new Meta API call shape needed). The only reason a row can still have a
// NULL effective_status is that its account hasn't been metadata-synced
// since Phase 15 shipped. So "backfill" is implemented as: force the
// existing campaigns/adsets/ads tiers to run (the same syncService.
// syncAccount() call already used for normal due syncs -- no insights
// re-fetch, no cache invalidation, no intelligence recompute) whenever an
// account that hasn't been marked complete still has NULL rows, then mark
// it complete once none remain. This converges every account (legacy-null
// or brand new) to "complete" without a second Meta pipeline ever existing.
// ─────────────────────────────────────────────

/** True if this account has any campaign/ad_set/ad row still missing effective_status. */
function needsLifecycleBackfill(accountId) {
  const row = db.get(
    `SELECT 1 AS found FROM (
       SELECT id FROM campaigns WHERE ad_account_id = ? AND effective_status IS NULL
       UNION ALL
       SELECT id FROM ad_sets WHERE ad_account_id = ? AND effective_status IS NULL
       UNION ALL
       SELECT id FROM ads WHERE ad_account_id = ? AND effective_status IS NULL
     ) LIMIT 1`,
    [accountId, accountId, accountId]
  );
  return !!row;
}

/** Marks the account "Lifecycle Backfill Complete" iff no NULL effective_status rows remain. Idempotent. */
function markLifecycleBackfillCompleteIfDone(accountId) {
  if (needsLifecycleBackfill(accountId)) return false;
  db.run(
    `UPDATE ad_accounts SET lifecycle_backfill_completed_at = ?
     WHERE id = ? AND lifecycle_backfill_completed_at IS NULL`,
    [new Date().toISOString(), accountId]
  );
  return true;
}

/**
 * Run whichever entity types are currently due for one account, in priority
 * order. Throws (after fully recording what happened) on a rate-limit hit so
 * the caller (the scheduler) can back the whole account off -- everything
 * already-recorded stays recorded, and un-run tiers simply remain "due" for
 * the next cycle, which is exactly the resume-from-failed-point behavior.
 *
 * @param {object} account - ad_accounts row
 * @param {'scheduler'|'force'} source
 * @param {function} [onEntityStart] - optional (entityType) => void, for live status
 */
async function runDueForAccount(account, source = 'scheduler', onEntityStart = () => {}) {
  const config = getScheduleConfig();
  const states = getEntityStates(account.id);

  const due = {};
  for (const type of ENTITY_TYPES) {
    due[type] = source === 'force' ? true : isDue(states[type], config[type]);
  }

  // Task 3 — escalate the metadata tree to run (campaigns+adsets+ads, exactly
  // what a normal sync already fetches) whenever this account still has
  // unbackfilled effective_status and hasn't been marked complete yet, even
  // if none of those tiers were otherwise due on their own interval.
  const backfillPending = !account.lifecycle_backfill_completed_at && needsLifecycleBackfill(account.id);
  if (backfillPending) {
    due.campaigns = true;
    due.adsets = true;
    due.ads = true;
  }

  if (!due.insights && !due.campaigns && !due.adsets && !due.ads && !due.creatives && !due.metadata && !due.analytics) {
    return { ranAny: false };
  }

  const accessToken = decryptToken(account.access_token_encrypted);
  const ranTiers = [];
  let treeSummary = null;

  // Tier 1 — Insights (highest frequency, no tree dependency)
  if (due.insights) {
    onEntityStart('insights');
    await runInsightsTier(account, accessToken, source);
    ranTiers.push('insights');
  }

  // Tiers 2–5 — campaign/adset/ad/creative tree, one shared fetch pass
  if (due.campaigns || due.adsets || due.ads || due.creatives) {
    onEntityStart('campaigns');
    treeSummary = await runCampaignTreeTiers(account, due, source);
    ranTiers.push(...['campaigns', 'adsets', 'ads', 'creatives'].filter(t => due[t]));

    // Task 3 — mark complete the moment nothing is left NULL, so this
    // account is never metadata-force-synced again after today.
    if (!account.lifecycle_backfill_completed_at) {
      markLifecycleBackfillCompleteIfDone(account.id);
    }
  }

  // Tier 6 — account metadata (lowest frequency)
  if (due.metadata) {
    onEntityStart('metadata');
    await runMetadataTier(account, accessToken, source);
    ranTiers.push('metadata');
  }

  // Tier 7 — Executive Marketing Analytics Layer (audience/geographic/
  // placement/device/creative/budget). Heaviest, least time-sensitive tier,
  // so it runs last.
  if (due.analytics) {
    onEntityStart('analytics');
    await runAnalyticsTier(account, source);
    ranTiers.push('analytics');
  }

  return { ranAny: ranTiers.length > 0, ranTiers, summary: treeSummary, backfillPending };
}

/**
 * Force Sync — runs every tier immediately for one account regardless of
 * cadence, without touching the scheduler's queue/cooldown state. Used by
 * POST /sync when account_id is given ("Force Sync" button). Returns the
 * same summary shape syncService.syncAccount() returns (campaigns/adSets/ads
 * synced+errors counts) so callers don't need to sync a second time to get it.
 */
async function forceSyncAccount(account) {
  const result = await runDueForAccount(account, 'force');
  return result.summary || {
    accountId: account.id, metaAccountId: account.meta_account_id,
    campaigns: { synced: 0, errors: 0 }, adSets: { synced: 0, errors: 0 }, ads: { synced: 0, errors: 0 },
    errors: [], warnings: [],
  };
}

// ─────────────────────────────────────────────
// Dashboard read helpers
// ─────────────────────────────────────────────

function getSyncHistory(limit = 50, adAccountId = null) {
  const params = [];
  let where = '';
  if (adAccountId) { where = 'WHERE l.ad_account_id = ?'; params.push(adAccountId); }
  params.push(limit);
  return db.all(
    `SELECT l.*, a.account_name
     FROM sync_execution_log l
     LEFT JOIN ad_accounts a ON a.id = l.ad_account_id
     ${where}
     ORDER BY l.started_at DESC
     LIMIT ?`,
    params
  );
}

function getEntityFreshness(adAccountId) {
  const rows = db.all('SELECT * FROM sync_entity_state WHERE ad_account_id = ?', [adAccountId]);
  const config = getScheduleConfig();
  return rows.map(r => ({
    ...r,
    interval_minutes: config[r.entity_type],
    data_freshness_minutes: r.last_success_at ? Math.round(minutesSince(r.last_success_at)) : null,
    is_stale: isDue(r, config[r.entity_type]),
  }));
}

module.exports = {
  ENTITY_TYPES,
  getScheduleConfig,
  setScheduleInterval,
  runDueForAccount,
  forceSyncAccount,
  runAnalyticsTier,
  getSyncHistory,
  getEntityFreshness,
  isRateLimitError,
  needsLifecycleBackfill,
  markLifecycleBackfillCompleteIfDone,
};
