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
const { syncAccount, DEFAULT_SYNC_RECOVERY_TIMEOUT_MINUTES, getRequestDeadline } = require('./syncService');
const executionTracker = require('./syncExecutionTracker');
const { metaGet, isRateLimitError } = require('./metaApiClient');
const { decryptToken } = require('./tokenCrypto');
const { fetchCampaignMetrics } = require('./metricsFetcher');
const { defaultRange, daysAgo, today } = require('./dateRangeHelper');
const { DEFAULT_INTERVALS } = require('../db/schema.phase16');
const syncLock = require('./syncLock');
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

// Bounded/Resumable Insights Tier (AUTONOMOUS META SYNC RECOVERY mission,
// schema.phase35.js): live forensic evidence (executionId 7ae47b40-3719-
// 48a6-b0b3-6b310b5c8646) proved runInsightsTier's unbounded per-campaign
// loop can consume an entire invocation's shared time budget by itself (37
// campaigns, 37 sequential Meta calls, all HTTP 200, zero time left for the
// campaign-tree tier) -- and this only gets worse as the account's known
// campaign count grows. Two independent caps, same pattern as
// syncService.js's DEFAULT_SYNC_CAMPAIGN_BATCH_SIZE/DEFAULT_SYNC_TIME_BUDGET_MS:
// a COUNT cap (never attempt more than this many campaigns in one pass,
// regardless of how much time is left) and a TIME cap carved out of the
// shared deadline (never let this tier alone consume more than this many ms
// of the invocation, even if the count cap hasn't been reached) -- whichever
// is hit first stops the tier and persists ad_accounts.insights_sync_cursor
// so the NEXT invocation resumes at the next campaign instead of restarting
// tier 1 from scratch (which would otherwise starve every tier behind it on
// every single invocation, forever, for a large/growing account).
const DEFAULT_INSIGHTS_BATCH_SIZE = 15;
const DEFAULT_INSIGHTS_TIER_TIME_BUDGET_MS = 15_000;

function getInsightsBatchSize() {
  const parsed = parseInt(process.env.INSIGHTS_BATCH_SIZE, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INSIGHTS_BATCH_SIZE;
}

function getInsightsTierTimeBudgetMs() {
  const parsed = parseInt(process.env.INSIGHTS_TIER_TIME_BUDGET_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INSIGHTS_TIER_TIME_BUDGET_MS;
}

// isRateLimitError now comes directly from metaApiClient.js (the module that
// actually tags errors with .isRateLimit/.isMetaError/.code in the first
// place) instead of a locally-duplicated copy of its RATE_LIMIT_ERROR_CODES
// set, which had drifted out of sync-risk since Phase 16 first added this
// file (both copies happened to still agree, but nothing enforced that).

// ─────────────────────────────────────────────
// Schedule config (Settings-configurable intervals)
// ─────────────────────────────────────────────

async function getScheduleConfig() {
  const rows = await db.all('SELECT entity_type, interval_minutes FROM sync_schedule_config');
  const config = { ...DEFAULT_INTERVALS, analytics: ANALYTICS_TIER_FALLBACK_INTERVAL };
  for (const row of rows) config[row.entity_type] = row.interval_minutes;
  return config;
}

async function setScheduleInterval(entityType, minutes) {
  if (!ENTITY_TYPES.includes(entityType)) {
    throw Object.assign(new Error(`Unknown entity_type: ${entityType}`), { status: 400 });
  }
  const parsed = parseInt(minutes, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw Object.assign(new Error('interval_minutes must be a number >= 1'), { status: 400 });
  }
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO sync_schedule_config (entity_type, interval_minutes, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(entity_type) DO UPDATE SET interval_minutes = excluded.interval_minutes, updated_at = excluded.updated_at`,
    [entityType, parsed, now]
  );
  return { entity_type: entityType, interval_minutes: parsed };
}

// ─────────────────────────────────────────────
// Entity state (durable checkpoint / freshness / resume)
// ─────────────────────────────────────────────

async function getEntityStates(adAccountId) {
  const rows = await db.all('SELECT * FROM sync_entity_state WHERE ad_account_id = ?', [adAccountId]);
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

async function upsertEntityState(adAccountId, entityType, patch) {
  const now = new Date().toISOString();
  const existing = await db.get(
    'SELECT id FROM sync_entity_state WHERE ad_account_id = ? AND entity_type = ?',
    [adAccountId, entityType]
  );
  if (existing) {
    const fields = Object.keys(patch);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    await db.run(
      `UPDATE sync_entity_state SET ${setClause}, updated_at = ? WHERE id = ?`,
      [...fields.map(f => patch[f]), now, existing.id]
    );
  } else {
    const id = uuidv4();
    const fields = Object.keys(patch);
    await db.run(
      `INSERT INTO sync_entity_state (id, ad_account_id, entity_type, ${fields.join(', ')}, created_at, updated_at)
       VALUES (?, ?, ?, ${fields.map(() => '?').join(', ')}, ?, ?)`,
      [id, adAccountId, entityType, ...fields.map(f => patch[f]), now, now]
    );
  }
}

// ─────────────────────────────────────────────
// Execution logging (history for the Logging requirement)
// ─────────────────────────────────────────────

async function recordExecution(adAccountId, entityType, source, result) {
  const {
    startedAt, finishedAt, recordsCreated = 0, recordsUpdated = 0, recordsFailed = 0,
    apiCalls = 0, retries = 0, rateLimited = false, status, errorMessage = null,
  } = result;
  const durationMs = finishedAt && startedAt
    ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
    : null;

  await db.run(
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

  const priorStates = await getEntityStates(adAccountId);
  await upsertEntityState(adAccountId, entityType, {
    last_sync_started_at: startedAt,
    last_sync_completed_at: finishedAt,
    last_success_at: status === 'success' ? finishedAt : (priorStates[entityType]?.last_success_at ?? null),
    last_failed_at: status !== 'success' ? finishedAt : (priorStates[entityType]?.last_failed_at ?? null),
    last_error: errorMessage,
    sync_source: source,
    duration_ms: durationMs,
  });

  return durationMs;
}

// ─────────────────────────────────────────────
// Per-entity-type sync execution
// ─────────────────────────────────────────────

/**
 * Detect the latest date this account's Insights were successfully warmed
 * (Incremental Synchronization, requirement 3) and request only the missing
 * window since then, capped to defaultRange()'s existing 7-day span so a
 * long-neglected account doesn't suddenly issue an unbounded catch-up
 * request. Always includes yesterday+today: Meta's own Insights data for
 * "today" is still accruing and "yesterday" can still be settling within
 * the account's attribution window, so both are re-requested every cycle
 * even when nothing else changed ("request today's updates, request
 * yesterday if incomplete").
 */
async function incrementalInsightsRange(account) {
  const state = await db.get(
    `SELECT last_success_at FROM sync_entity_state WHERE ad_account_id = ? AND entity_type = 'insights'`,
    [account.id]
  );
  if (!state?.last_success_at) return defaultRange(); // never synced -- existing default window, not full history

  const lastSyncedDate = state.last_success_at.slice(0, 10);
  const floor = daysAgo(7);
  const since = lastSyncedDate < floor ? floor : lastSyncedDate;
  return { since, until: today() };
}

/**
 * Campaign Priority (requirement 12): ACTIVE campaigns first, then most
 * recently updated -- "spending today" isn't knowable before Insights are
 * fetched (this tier IS the fetch), so recency-of-metadata-update is the
 * best available proxy within this tier's own data.
 */
function orderByPriority(campaigns) {
  return campaigns.slice().sort((a, b) => {
    const aActive = a.status === 'active' ? 0 : 1;
    const bActive = b.status === 'active' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return new Date(b.meta_updated_time || 0) - new Date(a.meta_updated_time || 0);
  });
}

/**
 * Tier 1: warm the existing Insights cache for this account's known campaigns.
 *
 * Bounded/Resumable (AUTONOMOUS META SYNC RECOVERY mission, schema.phase35.js
 * -- see DEFAULT_INSIGHTS_BATCH_SIZE/DEFAULT_INSIGHTS_TIER_TIME_BUDGET_MS's
 * own comment for the live incident this fixes): this tier no longer
 * attempts every known campaign in one pass. It resumes from
 * ad_accounts.insights_sync_cursor, processes at most getInsightsBatchSize()
 * campaigns, and stops early if its OWN carved-out sub-budget (a fraction of
 * the shared deadline, never the whole thing) runs out -- whichever limit
 * hits first. The cursor is persisted after the batch so the NEXT invocation
 * (this account's very next Force Sync or scheduler tick) continues from
 * the next campaign instead of restarting tier 1 and starving every tier
 * behind it again. Reaching the end of the full list clears the cursor
 * (pass genuinely complete) exactly like syncService.runBatchedFullSweep()'s
 * sync_batch_cursor semantics for the campaign tree.
 *
 * @param {object} [options]
 * @param {number|null} [options.deadlineAt] - the shared, whole-request
 *   deadline (runDueForAccount's getRequestDeadline()) -- this tier's own
 *   sub-budget is carved out of it, never exceeds it, and NEVER consumes it
 *   entirely regardless of campaign count (the actual live-proven bug).
 * @param {object|null} [options.recorder] - optional syncExecutionTracker
 *   recorder for durable Meta-request observability.
 * @returns {{complete: boolean, processed: number, remaining: number}}
 *   complete=false means this pass stopped early (batch/time cap) with a
 *   resumable cursor persisted -- NOT a failure.
 */
async function runInsightsTier(account, accessToken, source, options = {}) {
  const { deadlineAt = null, recorder = null } = options;
  const startedAt = new Date().toISOString();
  const allCampaigns = orderByPriority(await db.all(
    "SELECT meta_campaign_id, status, meta_updated_time FROM campaigns WHERE ad_account_id = ? AND status != 'archived'",
    [account.id]
  ));

  // Resume point: same fallback semantics as syncService.js's
  // sync_batch_cursor -- if the cursor's campaign is no longer in the
  // current list (deleted upstream, or a first-ever pass with no cursor
  // yet), start from the beginning. Every fetchCampaignMetrics() call is
  // idempotent by meta_campaign_id, so a redundant re-fetch is safe.
  let startIndex = 0;
  if (account.insights_sync_cursor) {
    const cursorIndex = allCampaigns.findIndex(c => c.meta_campaign_id === account.insights_sync_cursor);
    if (cursorIndex !== -1) startIndex = cursorIndex + 1;
  }
  const cursorBefore = account.insights_sync_cursor || null;
  const pending = allCampaigns.slice(startIndex);
  const batchSize = getInsightsBatchSize();
  const tierDeadline = deadlineAt ? Math.min(deadlineAt, Date.now() + getInsightsTierTimeBudgetMs()) : (Date.now() + getInsightsTierTimeBudgetMs());
  const batch = pending.slice(0, batchSize);

  // Incremental for the scheduler's routine cadence; a Force Sync (full or
  // active-only) still warms the same default() 7-day window it always has,
  // so a manually-triggered refresh always shows a full, familiar range.
  const range = source === 'scheduler' ? await incrementalInsightsRange(account) : defaultRange();

  let apiCalls = 0, updated = 0, failed = 0, retries = 0, rateLimited = false, lastError = null;
  let lastProcessedId = null;
  let stoppedEarly = false;

  for (const c of batch) {
    if (Date.now() >= tierDeadline) { stoppedEarly = true; break; }
    const reqStartedAt = Date.now();
    try {
      apiCalls++;
      if (recorder) await recorder.metaRequestStart({ resource: 'insights', page: null });
      await fetchCampaignMetrics(c.meta_campaign_id, accessToken, range, account.attribution_window_days);
      if (recorder) await recorder.metaRequestEnd({ resource: 'insights', page: null, status: 200, durationMs: Date.now() - reqStartedAt });
      updated++;
      lastProcessedId = c.meta_campaign_id;
    } catch (err) {
      failed++;
      lastError = err.message;
      if (recorder) await recorder.metaRequestEnd({ resource: 'insights', page: null, status: err.httpStatus || null, durationMs: Date.now() - reqStartedAt, error: err.message });
      if (isRateLimitError(err)) {
        rateLimited = true;
        retries = 3; // metaGet already exhausted its internal retry budget before surfacing this
        break; // Meta is actively throttling this account -- stop hammering it this cycle
      }
      // A non-rate-limit failure on one campaign (e.g. deleted upstream)
      // must not block the cursor from advancing past it -- otherwise this
      // one bad campaign would permanently wedge every future pass at the
      // same position. Still counted in `failed`, just not retried forever.
      lastProcessedId = c.meta_campaign_id;
    }
  }

  const reachedEndOfList = startIndex + updated + failed >= allCampaigns.length && !stoppedEarly && !rateLimited;
  const newCursor = reachedEndOfList ? null : (lastProcessedId || cursorBefore);
  await db.run(`UPDATE ad_accounts SET insights_sync_cursor = ? WHERE id = ?`, [newCursor, account.id]);
  const remaining = allCampaigns.length - (startIndex + updated + failed);
  if (recorder) {
    await recorder.progress({ campaigns_processed: updated });
    await recorder.checkpoint('insights', { cursorBefore, cursorAfter: newCursor, processed: updated, remaining: Math.max(remaining, 0) });
  }

  const finishedAt = new Date().toISOString();
  const status = rateLimited ? 'failed' : (failed > 0 && updated === 0 && batch.length > 0 ? 'failed' : 'success');
  await recordExecution(account.id, 'insights', source, {
    startedAt, finishedAt, recordsUpdated: updated, recordsFailed: failed,
    apiCalls, retries, rateLimited, status, errorMessage: lastError,
  });
  if (rateLimited) { const e = new Error(lastError || 'Rate limited'); e.isRateLimit = true; throw e; }
  return { complete: reachedEndOfList, processed: updated, remaining: Math.max(remaining, 0) };
}

/** Tier 6: lightweight account-info refresh (currency/timezone/business_name/status). */
async function runMetadataTier(account, accessToken, source, options = {}) {
  const { recorder = null } = options;
  const startedAt = new Date().toISOString();
  let status = 'success', errorMessage = null, rateLimited = false, updated = 0, failed = 0;
  const reqStartedAt = Date.now();

  try {
    if (recorder) await recorder.metaRequestStart({ resource: 'account_metadata', page: null });
    const info = await metaGet(
      account.meta_account_id,
      { fields: 'id,name,currency,timezone_name,business_name,account_status' },
      accessToken
    );
    if (recorder) await recorder.metaRequestEnd({ resource: 'account_metadata', page: null, status: 200, durationMs: Date.now() - reqStartedAt });
    const now = new Date().toISOString();
    await db.run(
      `UPDATE ad_accounts SET currency = ?, timezone = ?, business_name = COALESCE(?, business_name), updated_at = ? WHERE id = ?`,
      [info.currency || account.currency, info.timezone_name || account.timezone, info.business_name || null, now, account.id]
    );
    updated = 1;
  } catch (err) {
    failed = 1;
    errorMessage = err.message;
    rateLimited = isRateLimitError(err);
    status = 'failed';
    if (recorder) await recorder.metaRequestEnd({ resource: 'account_metadata', page: null, status: err.httpStatus || null, durationMs: Date.now() - reqStartedAt, error: err.message });
  }

  const finishedAt = new Date().toISOString();
  await recordExecution(account.id, 'metadata', source, {
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
 *
 * @param {object} [options]
 * @param {number|null} [options.deadlineAt] - AUTONOMOUS META SYNC RECOVERY
 *   mission (Phase 11): checked between each of the 7 steps below -- this
 *   tier runs LAST (after insights/campaigns/metadata), so on a Force Sync
 *   it's the most likely to start with little/no budget left; previously it
 *   had no deadline awareness at all and would attempt every step regardless.
 */
async function runAnalyticsTier(account, source, options = {}) {
  const { deadlineAt = null } = options;
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
    if (deadlineAt && Date.now() >= deadlineAt) break;
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
  await recordExecution(account.id, 'analytics', source, {
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
async function runCampaignTreeTiers(account, dueTiers, source, options = {}) {
  const { activeOnly = false, deadlineAt = null, recorder = null } = options;
  const syncAdSets = dueTiers.adsets || dueTiers.ads || dueTiers.creatives;
  const syncAds = dueTiers.ads || dueTiers.creatives;
  const startedAt = new Date().toISOString();

  let summary, status = 'success', errorMessage = null, rateLimited = false;
  try {
    summary = await syncAccount(account, { syncAdSets, syncAds, activeOnly, deadlineAt, recorder });
    // Phase 2 (PHASE_2_SYNC_EXECUTION_OBSERVABILITY_REPORT.md): prefer
    // syncAccount()'s own structured summary.status -- it already knows
    // about the 'partial' case (sweep stopped early via time budget/rate
    // limit/batch boundary with ZERO errors), which the old errors-only
    // derivation below could never detect and would silently report as
    // 'success' even though real work was still due. Falls back to the
    // errors-based derivation only if summary.status is somehow absent
    // (kept for robustness, not expected to trigger against current code).
    if (summary.status) {
      status = summary.status;
      if (summary.errors && summary.errors.length > 0) {
        errorMessage = summary.errors.map(e => `[${e.level}] ${e.message}`).join('; ');
        rateLimited = summary.errors.some(e => /rate.?limit|limit reached|too many requests|429/i.test(e.message || ''));
      } else if (summary.partialReason) {
        errorMessage = `Sync paused (${summary.partialReason}) -- ${summary.sweepRemaining ?? 0} item(s) still due, will resume automatically.`;
        rateLimited = summary.partialReason === 'rate_limited';
      }
    } else if (summary.errors && summary.errors.length > 0) {
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
    summary = {
      campaigns: { synced: 0, errors: 1 }, adSets: { synced: 0, errors: 0 }, ads: { synced: 0, errors: 0 },
      errors: [{ level: 'account', message: err.message }], warnings: [],
      status: 'failed', partialReason: null, sweepComplete: false, sweepRemaining: 0,
    };
  }
  const finishedAt = new Date().toISOString();

  if (dueTiers.campaigns) {
    await recordExecution(account.id, 'campaigns', source, {
      startedAt, finishedAt, recordsUpdated: summary.campaigns.synced, recordsFailed: summary.campaigns.errors,
      apiCalls: 1, status, errorMessage, rateLimited,
    });
  }
  if (dueTiers.adsets && syncAdSets) {
    await recordExecution(account.id, 'adsets', source, {
      startedAt, finishedAt, recordsUpdated: summary.adSets.synced, recordsFailed: summary.adSets.errors,
      apiCalls: summary.campaigns.synced, status, errorMessage, rateLimited,
    });
  }
  if (dueTiers.ads && syncAds) {
    await recordExecution(account.id, 'ads', source, {
      startedAt, finishedAt, recordsUpdated: summary.ads.synced, recordsFailed: summary.ads.errors,
      apiCalls: summary.adSets.synced, status, errorMessage, rateLimited,
    });
  }
  if (dueTiers.creatives && syncAds) {
    await recordExecution(account.id, 'creatives', source, {
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
async function needsLifecycleBackfill(accountId) {
  const row = await db.get(
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
async function markLifecycleBackfillCompleteIfDone(accountId) {
  if (await needsLifecycleBackfill(accountId)) return false;
  await db.run(
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
 * This is the ONE entry point every sync trigger funnels through (the
 * background Scheduler, Force Sync, Refresh Active Data, Full Rebuild), so
 * it's wrapped in syncLock (requirement 16, Prevent Concurrent Sync) --
 * whichever trigger gets here first for a given account wins, and every
 * other concurrent trigger for that same account returns immediately with
 * `skipped: true` instead of racing it.
 *
 * @param {object} account - ad_accounts row
 * @param {'scheduler'|'cron'|'force'|'force_active'} source - 'force' is a
 *   Full Sync/Full Rebuild (every tier, every status, bypasses cadence);
 *   'force_active' is the manual Refresh Active Data button (every tier,
 *   ACTIVE-only always, bypasses cadence); 'scheduler' is autoSyncScheduler.js's
 *   periodic tick (Railway) and 'cron' is cron.js's Vercel Cron tick -- the
 *   two genuinely AUTOMATIC triggers, both respecting each tier's own
 *   due-check (incremental, not bypassed) and both FULL until this account's
 *   initial hierarchy sweep completes (ad_accounts.initial_sync_completed_at),
 *   then ACTIVE-only permanently after (Bounded/Resumable Initial Sync,
 *   AP-POS Sync Architecture Audit).
 * @param {function} [onEntityStart] - optional (entityType) => void, for live status
 */
async function runDueForAccount(account, source = 'scheduler', onEntityStart = () => {}) {
  if (!syncLock.acquire(account.id)) {
    return { ranAny: false, skipped: true, reason: 'sync_already_in_progress_for_account' };
  }

  try {
    // Durable, DB-backed concurrency guard (AP-POS Sync Architecture Audit,
    // requirement 18): syncLock above is process-memory-only and gives no
    // protection across separate Vercel serverless invocations/instances
    // (e.g. an overlapping cron tick and a manual dashboard trigger hitting
    // the same account from two different cold-started instances). This
    // mirrors syncService.syncAccount()'s own already-durable
    // last_sync_status='running' guard (same timeout constant, reused
    // rather than redefined so the two can't drift) but is checked here so
    // it covers the whole tiered sync -- insights/metadata/analytics too,
    // not just the campaign/adset/ad tree tier syncAccount() itself guards.
    const inFlight = await db.get(
      `SELECT last_sync_status, last_sync_started_at FROM ad_accounts WHERE id = ?`,
      [account.id]
    );
    if (inFlight && inFlight.last_sync_status === 'running' && inFlight.last_sync_started_at) {
      const ageMinutes = (Date.now() - new Date(inFlight.last_sync_started_at).getTime()) / 60000;
      if (ageMinutes < DEFAULT_SYNC_RECOVERY_TIMEOUT_MINUTES) {
        return { ranAny: false, skipped: true, reason: 'sync_already_in_progress_for_account' };
      }
    }

    const config = await getScheduleConfig();
    const states = await getEntityStates(account.id);
    // 'cron' deliberately does NOT bypass cadence here -- it's grouped with
    // 'scheduler' as a genuinely-automatic incremental trigger, not with the
    // two manual/explicit "bypass everything" triggers. This is what keeps
    // the daily Vercel Cron tick from re-running every tier regardless of
    // its own freshness (the old behavior, when it reused 'force_active'
    // verbatim) -- each tier still only runs when its own interval says so.
    const isForce = source === 'force' || source === 'force_active';

    const due = {};
    for (const type of ENTITY_TYPES) {
      due[type] = isForce ? true : isDue(states[type], config[type]);
    }

    // Task 3 — escalate the metadata tree to run (campaigns+adsets+ads, exactly
    // what a normal sync already fetches) whenever this account still has
    // unbackfilled effective_status and hasn't been marked complete yet, even
    // if none of those tiers were otherwise due on their own interval.
    const backfillPending = !account.lifecycle_backfill_completed_at && await needsLifecycleBackfill(account.id);
    if (backfillPending) {
      due.campaigns = true;
      due.adsets = true;
      due.ads = true;
    }

    if (!due.insights && !due.campaigns && !due.adsets && !due.ads && !due.creatives && !due.metadata && !due.analytics) {
      return { ranAny: false };
    }

    // Active-Only Sync (requirements 1, 4, 6) + Bounded/Resumable Initial
    // Sync (AP-POS Sync Architecture Audit): 'force' (Full Sync/Full
    // Rebuild) is the ONLY mode that ALWAYS reloads paused/archived/deleted
    // objects. 'force_active' (manual "Refresh Active Data") always stays
    // ACTIVE-only. The two genuinely AUTOMATIC triggers -- 'scheduler'
    // (autoSyncScheduler.js's periodic tick, Railway) and 'cron' (cron.js's
    // daily Vercel Cron invocation) -- stay FULL until this account's very
    // first full hierarchy sweep ever completes (ad_accounts.
    // initial_sync_completed_at, schema.phase32.js), then switch to
    // ACTIVE-only permanently after -- this is what makes "initial
    // ingestion" (build the account's local universe once, including
    // historical paused/archived campaigns) an explicit, distinct phase
    // from "recurring sync" (maintain only the active universe), rather
    // than every automatic trigger being active-only from the very first
    // sync as it was before this column existed. That first full sweep
    // itself is bounded/resumable, not one unbounded pass -- see
    // syncService.runBatchedFullSweep()'s header comment.
    //
    // A pending legacy effective_status backfill needs one genuinely full
    // pass regardless of source or initial-sync state, so it overrides
    // everything above except 'force' (which is already full); once
    // complete (markLifecycleBackfillCompleteIfDone below) this never
    // applies again.
    let activeOnly;
    if (source === 'force') {
      activeOnly = false;
    } else if (backfillPending) {
      activeOnly = false;
    } else if (source === 'force_active') {
      activeOnly = true;
    } else {
      activeOnly = !!account.initial_sync_completed_at;
    }

    // AUTONOMOUS META SYNC RECOVERY mission (Phase 2/3/11): this is the ONE
    // entry point every sync trigger funnels through, and previously the
    // ONLY durable record of an attempt was ad_accounts.last_sync_status --
    // written by syncAccount() itself, deep inside the campaign-tree tier
    // below. A failure/timeout BEFORE that point (e.g. the unguarded
    // decryptToken() call two lines down, or a slow insights tier ahead of
    // it) left literally nothing durable behind -- exactly what produced
    // "No new progress was committed" on a real Force Sync attempt even
    // after token decryption itself was proven working seconds earlier via
    // Test Connection. sync_live_executions is created HERE, before
    // anything that can fail, specifically to close that gap: a hard
    // Vercel platform kill can no longer leave this run unknowable.
    const executionId = await executionTracker.createExecution(account.id, source);
    const recorder = executionTracker.createRecorder(executionId);
    // ONE deadline for the whole multi-tier request (Phase 11 fix): previously
    // only the campaign-tree tier (via syncAccount()'s own getRequestDeadline())
    // had any time-budget awareness -- the insights tier (one Meta Insights call
    // PER campaign already in the DB, no cap, no deadline check) and the
    // analytics tier (7 sequential sub-engines, each making its own Meta calls)
    // ran with zero awareness of the platform's 60s hard ceiling. A Force Sync
    // (source='force') marks EVERY tier due at once, so all of this happened in
    // ONE invocation -- fully explaining a raw `Vercel Runtime Timeout Error`
    // even when decryption and the first Meta contact both succeeded. Establishing
    // one deadline here and threading it into every tier (mirroring the
    // campaign-tree tier's existing, already-proven pattern) is what makes the
    // whole request cooperatively stop and report a clean partial/timed_out
    // result instead of hitting the platform's own kill.
    const deadlineAt = getRequestDeadline();

    let accessToken;
    try {
      accessToken = decryptToken(account.access_token_encrypted);
      await recorder.stage('TOKEN_DECRYPT_SUCCESS');
    } catch (err) {
      // Previously unguarded -- threw straight out of this function, past
      // asyncHandler, into Express's generic error handler as a raw 500
      // ("Unsupported state or unable to authenticate data") with ZERO
      // durable record that a decrypt failure (not a Meta/network issue)
      // was the actual cause. Now recorded and returned gracefully, mirroring
      // syncAccount()'s own long-standing guarded decrypt path.
      await executionTracker.finishExecution(executionId, {
        status: 'failed', errorCode: 'TOKEN_DECRYPT_FAILED', errorMessage: err.message,
      });
      await recorder.stage('TOKEN_DECRYPT_FAILED', err.message);
      return { ranAny: false, executionId, error: err.message, errorCode: 'TOKEN_DECRYPT_FAILED' };
    }

    const ranTiers = [];
    const deferredTiers = [];
    let treeSummary = null;
    let insightsResult = null;

    try {
      // Tier 1 — Insights (highest frequency, no tree dependency)
      if (due.insights) {
        if (Date.now() >= deadlineAt) {
          deferredTiers.push('insights');
        } else {
          onEntityStart('insights');
          await recorder.stage('insights');
          insightsResult = await runInsightsTier(account, accessToken, source, { deadlineAt, recorder });
          ranTiers.push('insights');
          // Bounded/Resumable Insights Tier: a batch/sub-deadline stop is
          // real, unfinished work (a resumable cursor was persisted), not a
          // completed tier -- must count toward this execution's own
          // partial/deferred accounting exactly like an interrupted
          // campaign-tree sweep does, so the UI/API never reports
          // 'completed' while campaigns still await their insights refresh.
          if (!insightsResult.complete) deferredTiers.push('insights');
        }
      }

      // Tiers 2–5 — campaign/adset/ad/creative tree, one shared fetch pass
      if (due.campaigns || due.adsets || due.ads || due.creatives) {
        if (Date.now() >= deadlineAt) {
          deferredTiers.push(...['campaigns', 'adsets', 'ads', 'creatives'].filter(t => due[t]));
        } else {
          onEntityStart('campaigns');
          await recorder.stage('campaigns');
          treeSummary = await runCampaignTreeTiers(account, due, source, { activeOnly, deadlineAt, recorder });
          ranTiers.push(...['campaigns', 'adsets', 'ads', 'creatives'].filter(t => due[t]));

          // Task 3 — mark complete the moment nothing is left NULL, so this
          // account is never metadata-force-synced again after today.
          if (!account.lifecycle_backfill_completed_at) {
            await markLifecycleBackfillCompleteIfDone(account.id);
          }
        }
      }

      // Tier 6 — account metadata (lowest frequency)
      if (due.metadata) {
        if (Date.now() >= deadlineAt) {
          deferredTiers.push('metadata');
        } else {
          onEntityStart('metadata');
          await recorder.stage('metadata');
          await runMetadataTier(account, accessToken, source, { recorder });
          ranTiers.push('metadata');
        }
      }

      // Tier 7 — Executive Marketing Analytics Layer (audience/geographic/
      // placement/device/creative/budget). Heaviest, least time-sensitive tier,
      // so it runs last.
      if (due.analytics) {
        if (Date.now() >= deadlineAt) {
          deferredTiers.push('analytics');
        } else {
          onEntityStart('analytics');
          await recorder.stage('analytics');
          await runAnalyticsTier(account, source, { deadlineAt });
          ranTiers.push('analytics');
        }
      }
    } catch (err) {
      const isTimedOut = Date.now() >= deadlineAt;
      await executionTracker.finishExecution(executionId, {
        status: err.isRateLimit ? 'partial' : 'failed',
        partialReason: err.isRateLimit ? 'rate_limited' : (isTimedOut ? 'timed_out' : null),
        errorCode: err.isRateLimit ? 'RATE_LIMITED' : 'TIER_ERROR',
        errorMessage: err.message,
      });
      err.executionId = executionId;
      throw err;
    }

    // Full Sync Mode (requirement 4): record when this account was last
    // genuinely reloaded end-to-end, distinct from last_sync_completed_at
    // (which every mode, including routine incremental cycles, updates).
    if (source === 'force' && ranTiers.length > 0) {
      await db.run(`UPDATE ad_accounts SET last_full_sync_at = ? WHERE id = ?`, [new Date().toISOString(), account.id]);
    }

    const finalStatus = deferredTiers.length > 0 ? 'partial' : 'completed';
    await executionTracker.finishExecution(executionId, {
      status: finalStatus,
      partialReason: deferredTiers.length > 0 ? 'timed_out' : null,
    });

    return { ranAny: ranTiers.length > 0, ranTiers, deferredTiers, executionId, summary: treeSummary, insightsResult, backfillPending, activeOnly };
  } finally {
    syncLock.release(account.id);
  }
}

/**
 * Force Sync / Full Rebuild / Full Sync mode — runs every tier immediately
 * for one account regardless of cadence, reloading ALL statuses (paused/
 * archived included), without touching the scheduler's queue/cooldown
 * state. This is the ONLY path that ever does a full reload -- never called
 * automatically by the scheduler (requirement 4/5). Used by POST /sync (no
 * explicit status filter, existing behavior, unchanged) and POST /sync/full
 * ("Full Rebuild" / "Full Sync mode", requirement 4/6B). Returns the same
 * summary shape syncService.syncAccount() returns (campaigns/adSets/ads
 * synced+errors counts) so callers don't need to sync a second time to get it.
 */
async function forceSyncAccount(account) {
  const result = await runDueForAccount(account, 'force');
  const summary = result.summary || {
    accountId: account.id, metaAccountId: account.meta_account_id,
    campaigns: { synced: 0, errors: 0 }, adSets: { synced: 0, errors: 0 }, ads: { synced: 0, errors: 0 },
    errors: result.error ? [{ level: 'account', message: result.error }] : [],
    warnings: [],
    status: result.error ? 'failed' : (result.skipped ? 'skipped' : 'completed'),
    partialReason: null,
  };
  // Structured Force Sync API (AUTONOMOUS META SYNC RECOVERY mission, Phase
  // 13): executionId/errorCode let the route (and eventually the UI) show
  // real state instead of collapsing every outcome into "Internal server
  // error" -- see sync_live_executions (schema.phase34.js) for the full
  // durable record this id points to.
  summary.executionId = result.executionId || null;
  summary.errorCode = result.errorCode || null;
  summary.deferredTiers = result.deferredTiers || [];
  return summary;
}

/**
 * Refresh Active Data (requirement 6A) — runs every tier immediately for one
 * account, bypassing cadence exactly like forceSyncAccount(), but stays
 * ACTIVE-only: only ACTIVE campaigns/ad sets/ads are re-requested from Meta.
 * Historical/paused/archived data already in SQLite is untouched, not
 * deleted. Used by POST /sync/refresh-active (source='force_active', the
 * default -- unchanged, bypasses cadence, always active-only).
 *
 * Also reused by refreshAllActiveAccounts() (src/api/routes/sync.js) for
 * the Vercel Cron trigger (src/api/routes/cron.js), passing source='cron'
 * instead -- the genuinely-automatic recurring path, which (unlike a manual
 * button click) respects each tier's own due-check rather than bypassing
 * cadence, and stays FULL until this account's initial sweep completes
 * rather than always active-only -- see runDueForAccount()'s own doc
 * comment for the full source-to-behavior mapping.
 */
async function forceSyncActiveAccount(account, source = 'force_active') {
  const result = await runDueForAccount(account, source);
  const summary = result.summary || {
    accountId: account.id, metaAccountId: account.meta_account_id,
    campaigns: { synced: 0, errors: 0 }, adSets: { synced: 0, errors: 0 }, ads: { synced: 0, errors: 0 },
    errors: result.error ? [{ level: 'account', message: result.error }] : [],
    warnings: [],
    status: result.error ? 'failed' : (result.skipped ? 'skipped' : 'completed'),
    partialReason: null,
  };
  summary.executionId = result.executionId || null;
  summary.errorCode = result.errorCode || null;
  summary.deferredTiers = result.deferredTiers || [];
  return summary;
}

// ─────────────────────────────────────────────
// Dashboard read helpers
// ─────────────────────────────────────────────

async function getSyncHistory(limit = 50, adAccountId = null) {
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

async function getEntityFreshness(adAccountId) {
  const rows = await db.all('SELECT * FROM sync_entity_state WHERE ad_account_id = ?', [adAccountId]);
  const config = await getScheduleConfig();
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
  forceSyncActiveAccount,
  runInsightsTier,
  runAnalyticsTier,
  getSyncHistory,
  getEntityFreshness,
  isRateLimitError,
  needsLifecycleBackfill,
  markLifecycleBackfillCompleteIfDone,
};
