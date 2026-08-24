/**
 * Sync Service — Phase 1
 *
 * Fetches campaigns (and their ad sets and ads) from Meta API
 * and upserts them into the local database.
 *
 * Phase 1 stores ONLY:
 *   - meta_campaign_id, name, objective, status, timestamps
 *   - meta_adset_id, name, status, budgets, timestamps
 *   - meta_ad_id, name, status, timestamps
 *
 * No metrics. No insights. No analytics.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { fetchCampaigns, fetchAdSets, fetchAds, fetchCustomAudiences, isRateLimitError } = require('./metaApiClient');
const { mapObjective } = require('./objectiveMapper');
const { decryptToken } = require('./tokenCrypto');
const { classifyAudienceType } = require('./audienceAttributionEngine');

/**
 * Normalize a Meta status string to our internal enum.
 * Meta statuses: ACTIVE, PAUSED, ARCHIVED, DELETED
 */
function normalizeStatus(metaStatus) {
  if (!metaStatus) return 'paused';
  const map = {
    ACTIVE: 'active',
    PAUSED: 'paused',
    ARCHIVED: 'archived',
    DELETED: 'deleted',
  };
  return map[String(metaStatus).toUpperCase()] || 'paused';
}

/**
 * Upsert a single campaign into the database.
 * Insert if new, update if already exists (matched by meta_campaign_id).
 *
 * @param {string} adAccountId - Internal DB id of the ad account
 * @param {object} metaCampaign - Raw campaign object from Meta API
 * @param {object} dbHandle - {run, get} -- defaults to the module-level db
 *   (auto-persists per call); pass the handle a transaction() callback
 *   receives to batch many upserts into a single persist.
 */
async function upsertCampaign(adAccountId, metaCampaign, dbHandle = db) {
  const now = new Date().toISOString();
  const internalObjective = mapObjective(metaCampaign.objective);

  const existing = await dbHandle.get(
    'SELECT id, objective, objective_effective_from FROM campaigns WHERE meta_campaign_id = ?',
    [metaCampaign.id]
  );

  if (existing) {
    // Track objective changes: if objective changed, update effective_from
    const objectiveChanged = existing.objective !== internalObjective;

    await dbHandle.run(
      `UPDATE campaigns SET
        name = ?,
        objective = ?,
        objective_effective_from = CASE WHEN ? = 1 THEN ? ELSE objective_effective_from END,
        status = ?,
        effective_status = ?,
        meta_updated_time = ?,
        updated_at = ?
      WHERE meta_campaign_id = ?`,
      [
        metaCampaign.name,
        internalObjective,
        objectiveChanged ? 1 : 0,
        objectiveChanged ? now : null,
        normalizeStatus(metaCampaign.status),
        metaCampaign.effective_status || null,
        metaCampaign.updated_time || now,
        now,
        metaCampaign.id,
      ]
    );

    return existing.id;
  } else {
    const id = uuidv4();
    await dbHandle.run(
      `INSERT INTO campaigns (
        id, ad_account_id, meta_campaign_id, name, objective,
        objective_effective_from, status, effective_status, meta_created_time, meta_updated_time,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        adAccountId,
        metaCampaign.id,
        metaCampaign.name,
        internalObjective,
        now,
        normalizeStatus(metaCampaign.status),
        metaCampaign.effective_status || null,
        metaCampaign.created_time || now,
        metaCampaign.updated_time || now,
        now,
        now,
      ]
    );

    return id;
  }
}

/**
 * Upsert a single ad set into the database.
 */
async function upsertAdSet(adAccountId, campaignId, metaAdSet, dbHandle = db, customAudienceSubtypeById = {}) {
  const now = new Date().toISOString();

  // targeting{locales} from metaApiClient.fetchAdSets() -- Language
  // Analytics' configuration view (Executive Marketing Analytics Layer).
  // Not every ad set targets specific locales (broad targeting omits it
  // entirely), so this is genuinely nullable, not a fabricated default.
  const targetingLocales = metaAdSet.targeting?.locales
    ? JSON.stringify(metaAdSet.targeting.locales)
    : null;

  // Attribution & Customer Journey Intelligence (Step 9): the trimmed real
  // targeting sub-objects (never the full raw blob -- age/gender/interest
  // IDs beyond what audience-type classification needs aren't stored) plus
  // the derived classification itself, computed once at sync time so every
  // read (audienceAttributionEngine.js and beyond) is a pure DB read, never
  // re-parsing raw Meta targeting JSON.
  const targetingJson = metaAdSet.targeting
    ? JSON.stringify({
        custom_audiences: metaAdSet.targeting.custom_audiences || null,
        lookalike_spec: metaAdSet.targeting.lookalike_spec || null,
        flexible_spec_count: Array.isArray(metaAdSet.targeting.flexible_spec) ? metaAdSet.targeting.flexible_spec.length : 0,
        geo_location_types: metaAdSet.targeting.geo_locations?.location_types || null,
        advantage_audience: metaAdSet.targeting.targeting_automation?.advantage_audience ?? null,
      })
    : null;
  const audienceType = classifyAudienceType(metaAdSet.targeting, customAudienceSubtypeById);

  const existing = await dbHandle.get(
    'SELECT id FROM ad_sets WHERE meta_adset_id = ?',
    [metaAdSet.id]
  );

  if (existing) {
    await dbHandle.run(
      `UPDATE ad_sets SET
        name = ?,
        status = ?,
        effective_status = ?,
        daily_budget = ?,
        lifetime_budget = ?,
        optimization_goal = ?,
        targeting_locales = ?,
        targeting_json = ?,
        audience_type = ?,
        meta_updated_time = ?,
        updated_at = ?
      WHERE meta_adset_id = ?`,
      [
        metaAdSet.name,
        normalizeStatus(metaAdSet.status),
        metaAdSet.effective_status || null,
        metaAdSet.daily_budget ? parseFloat(metaAdSet.daily_budget) / 100 : null,
        metaAdSet.lifetime_budget ? parseFloat(metaAdSet.lifetime_budget) / 100 : null,
        metaAdSet.optimization_goal ?? null,
        targetingLocales,
        targetingJson,
        audienceType,
        metaAdSet.updated_time || now,
        now,
        metaAdSet.id,
      ]
    );
    return existing.id;
  } else {
    const id = uuidv4();
    await dbHandle.run(
      `INSERT INTO ad_sets (
        id, campaign_id, ad_account_id, meta_adset_id, name, status, effective_status,
        daily_budget, lifetime_budget, optimization_goal, targeting_locales, targeting_json, audience_type,
        meta_created_time, meta_updated_time, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        campaignId,
        adAccountId,
        metaAdSet.id,
        metaAdSet.name,
        normalizeStatus(metaAdSet.status),
        metaAdSet.effective_status || null,
        metaAdSet.daily_budget ? parseFloat(metaAdSet.daily_budget) / 100 : null,
        metaAdSet.lifetime_budget ? parseFloat(metaAdSet.lifetime_budget) / 100 : null,
        metaAdSet.optimization_goal ?? null,
        targetingLocales,
        targetingJson,
        audienceType,
        metaAdSet.created_time || now,
        metaAdSet.updated_time || now,
        now,
        now,
      ]
    );
    return id;
  }
}

/**
 * Upsert a single ad into the database.
 */
async function upsertAd(adAccountId, campaignId, adSetId, metaAd, dbHandle = db) {
  const now = new Date().toISOString();

  // metaAd.creative comes from the creative{id,thumbnail_url,image_url}
  // field expansion in metaApiClient.fetchAds(). Not every ad has a
  // creative attached (e.g. a newly-created ad still in draft), so these
  // are genuinely nullable, not fabricated defaults.
  const creativeId    = metaAd.creative?.id ?? null;
  const thumbnailUrl  = metaAd.creative?.thumbnail_url ?? null;
  const imageUrl      = metaAd.creative?.image_url ?? null;
  // destination_type from metaApiClient.fetchAds() -- Messaging Destination
  // Analytics (Executive Marketing Analytics Layer). Only present on
  // message-objective ads; genuinely null otherwise, not a fabricated default.
  const destinationType = metaAd.destination_type ?? null;

  const existing = await dbHandle.get(
    'SELECT id FROM ads WHERE meta_ad_id = ?',
    [metaAd.id]
  );

  if (existing) {
    await dbHandle.run(
      `UPDATE ads SET
        name = ?,
        status = ?,
        effective_status = ?,
        meta_updated_time = ?,
        creative_id = ?,
        thumbnail_url = ?,
        image_url = ?,
        destination_type = ?,
        updated_at = ?
      WHERE meta_ad_id = ?`,
      [
        metaAd.name,
        normalizeStatus(metaAd.status),
        metaAd.effective_status || null,
        metaAd.updated_time || now,
        creativeId,
        thumbnailUrl,
        imageUrl,
        destinationType,
        now,
        metaAd.id,
      ]
    );
    return existing.id;
  } else {
    const id = uuidv4();
    await dbHandle.run(
      `INSERT INTO ads (
        id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status, effective_status,
        meta_created_time, meta_updated_time, creative_id, thumbnail_url,
        image_url, destination_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        adSetId,
        campaignId,
        adAccountId,
        metaAd.id,
        metaAd.name,
        normalizeStatus(metaAd.status),
        metaAd.effective_status || null,
        metaAd.created_time || now,
        metaAd.updated_time || now,
        creativeId,
        thumbnailUrl,
        imageUrl,
        destinationType,
        now,
        now,
      ]
    );
    return id;
  }
}

// Bounded/Resumable Initial Sync (AP-POS Sync Architecture Audit).
//
// Only used for FULL sweeps (activeOnly === false -- initial ingestion, or
// an explicit manual Full Sync/Full Rebuild): a single syncAccount() call no
// longer attempts every due campaign in one pass. Instead it processes due
// campaigns in bounded batches, writing (and checkpointing via
// ad_accounts.sync_batch_cursor, schema.phase32.js) after each batch, and
// stops once either bound is hit -- whichever comes first. The NEXT
// syncAccount() call for this account (any trigger) then resumes from the
// cursor instead of restarting the sweep from campaign #1.
//
// Active-only sweeps (activeOnly === true, the routine recurring case) are
// NOT batched -- they're already bounded server-side by Meta's
// effective_status=ACTIVE filter (metaApiClient.buildEffectiveStatusFilter),
// so the due list is expected to stay small; see SYNC_REQUEST_BUDGET.md.
//
// Defaults are chosen from evidence, not guessed: vercel.json caps every
// function invocation (including /api/cron/sync) at maxDuration=60s, and
// metaGet() can legitimately take up to ~35s for a single call under
// worst-case rate-limit retries (BASE_RETRY_DELAY_MS=5000, 3 retries:
// 5s+10s+20s). SYNC_CAMPAIGN_BATCH_SIZE is a secondary, count-based safety
// cap (in case many campaigns each resolve fast and the time budget alone
// would let an unreasonably large batch accumulate in memory before its
// single write transaction). Configurable via env, per the mission's
// "batch size must not be guessed, and must be configurable" requirement.
//
// Phase 2 correction (PHASE_2_SYNC_EXECUTION_OBSERVABILITY_REPORT.md): a
// real production Force Sync produced `Vercel Runtime Timeout Error: Task
// timed out after 60 seconds` (POST /api/v1/sync, 504) even though
// SYNC_TIME_BUDGET_MS was 45s. Root cause: that 45s timer previously only
// wrapped runBatchedFullSweep()'s own batch loop -- it started AFTER
// fetchCampaigns() and fetchCustomAudiences() had already run, so their own
// latency (network + metaGet's internal retry/backoff, up to ~35s per call
// under throttling, plus adaptive pacing delay) was not counted against any
// budget at all. SYNC_TIME_BUDGET_MS is now a single deadline established
// once at the very top of syncAccount() (see getRequestDeadline() below)
// and threaded through every phase of the request -- fetch, batch loop, and
// the final status write all check against the SAME deadline, so nothing
// downstream of it can silently consume unbudgeted time again.
const DEFAULT_SYNC_CAMPAIGN_BATCH_SIZE = 25;
const DEFAULT_SYNC_TIME_BUDGET_MS = 45_000;

function getCampaignBatchSize() {
  const parsed = parseInt(process.env.SYNC_CAMPAIGN_BATCH_SIZE, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SYNC_CAMPAIGN_BATCH_SIZE;
}

function getSyncTimeBudgetMs() {
  const parsed = parseInt(process.env.SYNC_TIME_BUDGET_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SYNC_TIME_BUDGET_MS;
}

/** Absolute deadline (ms epoch) for one syncAccount() call, established once at request start. */
function getRequestDeadline(startedAtMs = Date.now()) {
  return startedAtMs + getSyncTimeBudgetMs();
}

/**
 * Fetch this campaign's ad sets (and each ad set's ads), preserving the
 * existing rate-limit-breaker short-circuit and per-node error isolation
 * exactly as the original single-pass loop did. Returns a campaignTree node
 * shaped identically to what the write phase already expects.
 *
 * @param {object} rateLimitState - { broken: string|null }, mutated in place
 *   so the breaker persists across campaigns within (and across batches of)
 *   the same syncAccount() invocation, same semantics as before.
 */
async function fetchCampaignNode(metaCampaign, accessToken, options, rateLimitState, noteIfIncomplete) {
  const { syncAdSets, syncAds, activeOnly, deadlineAt, recorder } = options;
  const node = { metaCampaign, adSets: [], fetchError: null };

  if (!syncAdSets) return node;

  if (rateLimitState.broken) {
    node.fetchError = rateLimitState.broken;
    return node;
  }

  try {
    const metaAdSets = await fetchAdSets(metaCampaign.id, accessToken, { activeOnly, deadlineAt, recorder });
    noteIfIncomplete('adsets', metaAdSets, metaCampaign.id);

    for (const metaAdSet of metaAdSets) {
      const adSetNode = { metaAdSet, ads: [], fetchError: null };

      if (syncAds) {
        if (rateLimitState.broken) {
          adSetNode.fetchError = rateLimitState.broken;
        } else {
          try {
            const metaAds = await fetchAds(metaAdSet.id, accessToken, { activeOnly, deadlineAt, recorder });
            noteIfIncomplete('ads', metaAds, metaAdSet.id);
            adSetNode.ads = metaAds;
          } catch (err) {
            adSetNode.fetchError = err.message;
            if (isRateLimitError(err)) rateLimitState.broken = err.message;
          }
        }
      }

      node.adSets.push(adSetNode);
    }
  } catch (err) {
    node.fetchError = err.message;
    if (isRateLimitError(err)) rateLimitState.broken = err.message;
  }

  return node;
}

/** Writes one batch's worth of already-fetched campaignTree nodes in a single transaction (one persist() call), same shape/error-isolation as the original whole-account write phase. */
async function writeCampaignBatch(adAccount, campaignTree, summary, customAudienceSubtypeById) {
  await db.transaction(async (tx) => {
    for (const node of campaignTree) {
      let campaignId;
      try {
        campaignId = await upsertCampaign(adAccount.id, node.metaCampaign, tx);
        summary.campaigns.synced++;
      } catch (err) {
        summary.campaigns.errors++;
        summary.errors.push({ level: 'campaign', campaignId: node.metaCampaign.id, message: err.message });
        continue;
      }

      if (node.fetchError) {
        summary.adSets.errors++;
        summary.errors.push({ level: 'adsets', campaignId: node.metaCampaign.id, message: node.fetchError });
        continue;
      }

      for (const adSetNode of node.adSets) {
        let adSetId;
        try {
          adSetId = await upsertAdSet(adAccount.id, campaignId, adSetNode.metaAdSet, tx, customAudienceSubtypeById);
          summary.adSets.synced++;
        } catch (err) {
          summary.adSets.errors++;
          summary.errors.push({ level: 'adset', adSetId: adSetNode.metaAdSet.id, message: err.message });
          continue;
        }

        if (adSetNode.fetchError) {
          summary.ads.errors++;
          summary.errors.push({ level: 'ads', adSetId: adSetNode.metaAdSet.id, message: adSetNode.fetchError });
          continue;
        }

        for (const metaAd of adSetNode.ads) {
          try {
            await upsertAd(adAccount.id, campaignId, adSetId, metaAd, tx);
            summary.ads.synced++;
          } catch (err) {
            summary.ads.errors++;
            summary.errors.push({ level: 'ad', adId: metaAd.id, message: err.message });
          }
        }
      }
    }
  });
}

/**
 * Bounded/resumable FULL-sweep tree walk (activeOnly === false only).
 * Resumes from adAccount.sync_batch_cursor if a previous invocation left one
 * (falls back to processing from the start if the cursor's campaign is no
 * longer in the current list -- e.g. deleted upstream -- which is safe, just
 * potentially redundant, since every upsert here is idempotent by
 * meta_campaign_id/meta_adset_id/meta_ad_id). Processes batches of up to
 * getCampaignBatchSize() campaigns, writing+checkpointing after each, until
 * either the campaign list is exhausted (sweep complete -- cursor cleared,
 * caller marks initial_sync_completed_at) or `deadlineAt` (an absolute
 * timestamp established once by the caller at the very start of the whole
 * request, not by this function) is reached (sweep left incomplete --
 * cursor left pointing at the last written campaign, so the next invocation
 * resumes here).
 *
 * @param {number} deadlineAt - ms-epoch deadline for the ENTIRE syncAccount()
 *   call (see getRequestDeadline()), not just this function's own work --
 *   time already spent on fetchCampaigns()/fetchCustomAudiences() before
 *   this was called counts against it.
 * @param {boolean} campaignListIncomplete - true when `sortedMetaCampaigns`
 *   is itself not the account's full campaign list (metaCampaigns.incomplete
 *   from fetchCampaigns() -- the campaign-list pagination itself stopped
 *   early). When true, this function can never report sweepComplete=true or
 *   clear the durable cursor, even if every campaign IN the given (partial)
 *   array gets fully processed -- the true full account size isn't known
 *   yet, so "processed everything we were given" is not the same claim as
 *   "processed everything that exists." Without this, a deadline hit while
 *   merely LISTING campaigns could let a partial discovery masquerade as a
 *   complete sweep and incorrectly clear the resume cursor.
 */
async function runBatchedFullSweep(adAccount, sortedMetaCampaigns, accessToken, options, summary, noteIfIncomplete, customAudienceSubtypeById, deadlineAt, campaignListIncomplete = false) {
  const { recorder = null } = options;
  let startIndex = 0;
  if (adAccount.sync_batch_cursor) {
    const cursorIndex = sortedMetaCampaigns.findIndex(c => c.id === adAccount.sync_batch_cursor);
    if (cursorIndex !== -1) startIndex = cursorIndex + 1;
  }

  const remaining = sortedMetaCampaigns.slice(startIndex);
  const batchSize = getCampaignBatchSize();
  const rateLimitState = { broken: null };

  // Already out of budget before even the first campaign of this invocation
  // (e.g. fetchCampaigns()/fetchCustomAudiences() alone consumed it) --
  // deliberately do not attempt any work rather than start a batch we
  // cannot safely finish; the due list is left completely untouched, so
  // the next invocation retries from exactly the same point.
  if (Date.now() >= deadlineAt) {
    return { sweepComplete: false, remaining: remaining.length, reason: 'timed_out' };
  }

  let cursor = adAccount.sync_batch_cursor || null;
  let i = 0;
  let reason = null;
  let batchNumber = 0;
  while (i < remaining.length) {
    if (Date.now() >= deadlineAt) { reason = 'timed_out'; break; }

    batchNumber++;
    const cursorBefore = cursor;
    const batch = remaining.slice(i, i + batchSize);
    const campaignTree = [];
    for (const metaCampaign of batch) {
      campaignTree.push(await fetchCampaignNode(metaCampaign, accessToken, options, rateLimitState, noteIfIncomplete));
      // Stop pulling in more campaigns as soon as either bound trips --
      // time budget (re-checked between campaigns too, not just between
      // batches, since a single campaign's adset/ad fetch can itself
      // consume most of it), or the rate-limit breaker. Once broken,
      // every FURTHER campaign is deliberately left untouched (not
      // fetched, not written, not counted) rather than mass-marked with
      // the breaker placeholder like the old unbatched path did -- that
      // keeps them genuinely "still due" so the next invocation actually
      // retries them once Meta's throttle clears, instead of writing a
      // permanent error for a purely transient condition.
      if (rateLimitState.broken) { reason = 'rate_limited'; break; }
      if (Date.now() >= deadlineAt) { reason = 'timed_out'; break; }
    }

    if (campaignTree.length === 0) break; // broken/time-out before even one campaign in this batch could be fetched

    await writeCampaignBatch(adAccount, campaignTree, summary, customAudienceSubtypeById);
    if (recorder) {
      await recorder.dbWrite('campaign_batch', { campaigns: campaignTree.length });
      await recorder.progress({
        campaigns_processed: summary.campaigns.synced,
        ad_sets_processed: summary.adSets.synced,
        ads_processed: summary.ads.synced,
      });
    }
    cursor = campaignTree[campaignTree.length - 1].metaCampaign.id;
    await db.run(`UPDATE ad_accounts SET sync_batch_cursor = ? WHERE id = ?`, [cursor, adAccount.id]);
    if (recorder) {
      await recorder.batch('BATCH_COMPLETE', {
        batchNumber, cursorBefore, cursorAfter: cursor,
        processed: campaignTree.length, remaining: remaining.length - (i + campaignTree.length),
      });
    }

    i += campaignTree.length;
    if (campaignTree.length < batch.length) { reason = reason || 'timed_out'; break; }
    if (rateLimitState.broken) { reason = reason || 'rate_limited'; break; }
    // Otherwise a full batch completed cleanly with more due campaigns
    // remaining -- the outer while loop's own top-of-loop deadline check
    // decides whether to start another batch or stop here.
  }

  const processedEverythingGiven = i >= remaining.length;
  const sweepComplete = processedEverythingGiven && !campaignListIncomplete;
  if (sweepComplete) {
    await db.run(`UPDATE ad_accounts SET sync_batch_cursor = NULL WHERE id = ?`, [adAccount.id]);
  }
  // reason=null when processedEverythingGiven but campaignListIncomplete is
  // the ONLY reason sweepComplete is still false -- syncService.syncAccount()
  // fills the real reason in from metaCampaigns.incompleteReason itself in
  // that specific case, so this function doesn't need to duplicate it.
  const reasonForCaller = sweepComplete ? null : (reason || (processedEverythingGiven ? null : 'batch_limit'));

  return {
    sweepComplete,
    remaining: remaining.length - i,
    rateLimitBreaker: rateLimitState.broken,
    reason: reasonForCaller,
  };
}

/**
 * Sync all campaigns (and optionally ad sets + ads) for one ad account.
 *
 * Split into two phases:
 *   1. FETCH everything from Meta (async, network-bound) into an in-memory
 *      tree -- no DB writes happen here.
 *   2. WRITE the whole tree inside a single db.transaction() (synchronous,
 *      DB-bound) -- one persist() for the entire sync instead of one per
 *      campaign/ad-set/ad. Previously each upsert call independently
 *      triggered database.js's full-database export-and-rewrite, so
 *      syncing an account with, say, 30 campaigns x 5 ad sets x 8 ads
 *      (~1,400 rows) meant ~1,400 full-database serializations in one
 *      request. A transaction cannot span the async Meta fetches (that
 *      would hold a DB write-lock open across slow network calls), which
 *      is why the fetch and write phases had to be separated rather than
 *      simply wrapping the original single loop.
 *
 * Per-campaign/ad-set/ad error isolation is preserved exactly as before --
 * a fetch failure at any level is recorded against that node and does not
 * abort sibling nodes; the same is true for a write failure.
 *
 * @param {object} adAccount - Row from ad_accounts table
 * @param {object} options
 * @param {boolean} options.syncAdSets - Also sync ad sets (default: true)
 * @param {boolean} options.syncAds - Also sync ads (default: true)
 * @param {number|null} [options.deadlineAt] - external deadline override
 *   (AUTONOMOUS META SYNC RECOVERY mission, Phase 11): smartSyncEngine's
 *   runDueForAccount() runs multiple tiers (insights, this campaign tree,
 *   metadata, analytics) in ONE request/invocation -- if this function
 *   always computed its own fresh deadline from Date.now(), time already
 *   spent in an earlier tier (e.g. the insights tier's per-campaign Meta
 *   calls) would never count against it, defeating the whole point of a
 *   request-wide budget. When provided, this OVERRIDES the internal
 *   getRequestDeadline() call so every tier shares one real deadline.
 *   Omitted (default null) preserves the original behavior for every other
 *   caller (tests, any direct syncAccount() call) -- purely additive.
 * @param {object|null} [options.recorder] - optional syncExecutionTracker
 *   recorder, forwarded into fetchCampaigns/fetchCustomAudiences/the
 *   campaign tree walk so every real Meta request this call makes is
 *   durably logged. Purely additive/optional.
 * @returns {object} Summary of what was synced
 */
async function syncAccount(adAccount, options = {}) {
  // Request-wide deadline (Phase 2 fix -- see DEFAULT_SYNC_TIME_BUDGET_MS's
  // own comment for the production incident this addresses): established
  // ONCE, right here, before any awaited work at all -- every phase below
  // (custom-audience/campaign prefetch, the batch loop, the activeOnly
  // path) checks against this SAME deadline, so no phase can silently spend
  // time nothing else is aware of.
  const deadlineAt = options.deadlineAt || getRequestDeadline();
  const recorder = options.recorder || null;

  // activeOnly (Phase 39, requirement 1/6) -- when true, only ACTIVE
  // campaigns/ad sets/ads are requested from Meta at all (server-side
  // filtering, see metaApiClient.buildEffectiveStatusFilter). Historical
  // paused/archived/deleted rows already in SQLite are never touched or
  // deleted by this -- they simply aren't re-fetched. Full Sync (explicit,
  // manual only -- see smartSyncEngine.forceSyncAccount) passes false to
  // reload everything, exactly like this function always behaved before.
  const { syncAdSets = true, syncAds = true, activeOnly = false } = options;

  const summary = {
    accountId: adAccount.id,
    metaAccountId: adAccount.meta_account_id,
    campaigns: { synced: 0, errors: 0 },
    adSets: { synced: 0, errors: 0 },
    ads: { synced: 0, errors: 0 },
    startedAt: new Date().toISOString(),
    completedAt: null,
    errors: [],
    // Set whenever metaGetAll() hit its 5000-item safety cap or a
    // mid-pagination page fetch failed -- either way, what got synced
    // below is a partial, not complete, set for that level. Previously
    // this was silently swallowed (only a console.warn/error), giving
    // callers no way to know a sync was incomplete.
    warnings: [],
  };

  function noteIfIncomplete(level, items, contextId) {
    if (items.incomplete) {
      summary.warnings.push({ level, id: contextId, reason: items.incompleteReason, itemCount: items.length });
    }
  }

  // Guard against overlapping syncs for the same account -- e.g. a manual
  // "Force Sync" (POST /sync) racing the scheduler's own due-check, or two
  // manual triggers in a row. Nothing previously checked last_sync_status
  // before starting another sync (confirmed via code read); this closes
  // that race window. Mirrors recoverInterruptedSyncs()'s own 30-minute
  // default timeout so a genuinely stuck 'running' row from a crashed
  // process doesn't permanently block new syncs for this account.
  const inFlight = await db.get(
    `SELECT last_sync_status, last_sync_started_at FROM ad_accounts WHERE id = ?`,
    [adAccount.id]
  );
  if (inFlight && inFlight.last_sync_status === 'running' && inFlight.last_sync_started_at) {
    const ageMinutes = (Date.now() - new Date(inFlight.last_sync_started_at).getTime()) / 60000;
    if (ageMinutes < DEFAULT_SYNC_RECOVERY_TIMEOUT_MINUTES) {
      summary.errors.push({ level: 'account', message: `Sync already in progress for this account (started ${inFlight.last_sync_started_at}).` });
      summary.completedAt = new Date().toISOString();
      summary.status = 'failed';
      summary.partialReason = null;
      summary.sweepComplete = false;
      summary.sweepRemaining = 0;
      return summary;
    }
  }

  console.log(`[Sync] Starting sync for account: ${adAccount.meta_account_id}${activeOnly ? ' (active-only, incremental)' : ' (full)'}`);

  // Automatic Recovery (requirement 15): a corrupted/missing encryption key
  // or malformed stored token must fail just THIS account, not throw out of
  // syncAccount() entirely -- syncAllAccounts()'s loop has no other guard
  // against an uncaught throw here, and a single bad account previously
  // could have aborted every account queued after it in the same run.
  let accessToken;
  try {
    accessToken = decryptToken(adAccount.access_token_encrypted);
  } catch (err) {
    summary.errors.push({ level: 'account', message: `Token decryption failed: ${err.message}` });
    console.error(`[Sync] Could not decrypt access token for ${adAccount.meta_account_id}:`, err.message);
    summary.completedAt = new Date().toISOString();
    summary.status = 'failed';
    summary.partialReason = null;
    summary.sweepComplete = false;
    summary.sweepRemaining = 0;
    await markSyncFailed(adAccount.id, summary);
    return summary;
  }

  const startedAt = new Date().toISOString();
  await db.run(
    `UPDATE ad_accounts
     SET last_sync_started_at = ?, last_sync_status = 'running', sync_progress_phase = ?, last_sync_error = NULL
     WHERE id = ?`,
    [startedAt, 'fetching_campaigns', adAccount.id]
  );

  // ══════════════════════════════════════════════════════════════
  // PHASE 1 — FETCH everything from Meta into an in-memory tree.
  // No DB writes happen in this phase.
  // ══════════════════════════════════════════════════════════════
  let metaCampaigns;
  try {
    metaCampaigns = await fetchCampaigns(adAccount.meta_account_id, accessToken, { activeOnly, deadlineAt, recorder });
    noteIfIncomplete('campaigns', metaCampaigns, adAccount.meta_account_id);
    if (recorder) await recorder.progress({ campaigns_discovered: metaCampaigns.length });

    // Campaign Priority (requirement 12): ACTIVE campaigns first, then most
    // recently updated (the closest available proxy for "spending today" /
    // "updated today" without a chicken-and-egg dependency on Insights data
    // this same pass hasn't fetched yet) -- so if a rate limit trips
    // mid-account, the campaigns most likely to matter were already synced.
    // Sorted IN PLACE (not via [...spread]) so metaGetAll's incomplete/
    // incompleteReason properties on the array survive the sort.
    metaCampaigns.sort((a, b) => {
      const aActive = a.effective_status === 'ACTIVE' ? 0 : 1;
      const bActive = b.effective_status === 'ACTIVE' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(b.updated_time || 0) - new Date(a.updated_time || 0);
    });
  } catch (err) {
    summary.errors.push({ level: 'account', message: err.message });
    console.error(`[Sync] Failed to fetch campaigns for ${adAccount.meta_account_id}:`, err.message);
    // Error Classification (requirement 14): an expired/invalid token will
    // never succeed on retry -- mark it invalid now so syncAllAccounts()'s
    // WHERE token_is_valid = 1 (and the scheduler's identical filter) stop
    // repeatedly re-attempting a doomed sync every cycle until the user
    // reconnects the account (accounts.js's existing reconnect flow already
    // clears this flag once a fresh token is provided).
    if (err.isAuthError) {
      await db.run(`UPDATE ad_accounts SET token_is_valid = 0 WHERE id = ?`, [adAccount.id]);
    }
    summary.completedAt = new Date().toISOString();
    summary.status = 'failed';
    summary.partialReason = null;
    summary.sweepComplete = false;
    summary.sweepRemaining = 0;
    await markSyncFailed(adAccount.id, summary);
    return summary;
  }

  // Attribution & Customer Journey Intelligence (Step 9): every referenced
  // custom audience's real subtype (CUSTOM/WEBSITE/ENGAGEMENT/APP/LOOKALIKE)
  // is fetched ONCE per account here, never per ad set -- classifyAudienceType()
  // needs it to distinguish lookalike/remarketing from a generic custom
  // audience, which an ad set's own targeting.custom_audiences never reveals
  // (it only ever returns the referenced audience's id). A failure here is
  // non-fatal -- classification falls back to whatever's derivable from the
  // ad set's own targeting alone (custom_audience/interest/broad/advantage_plus
  // still work; lookalike/remarketing specifically become custom_audience).
  let customAudienceSubtypeById = {};
  try {
    if (syncAdSets) {
      const customAudiences = await fetchCustomAudiences(adAccount.meta_account_id, accessToken, { deadlineAt, recorder });
      customAudienceSubtypeById = Object.fromEntries(customAudiences.map(a => [a.id, a.subtype || null]));
    }
  } catch (err) {
    console.warn(`[Sync] Could not fetch custom audiences for ${adAccount.meta_account_id} (audience-type classification will be less precise):`, err.message);
  }

  const campaignTreeOptions = { syncAdSets, syncAds, activeOnly, deadlineAt, recorder };
  let sweepComplete = true;
  let sweepRemaining = 0;
  let partialReason = null;

  await db.run(`UPDATE ad_accounts SET sync_progress_phase = ? WHERE id = ?`, ['fetching_adsets_and_ads', adAccount.id]);

  if (activeOnly) {
    // ══════════════════════════════════════════════════════════════
    // Active-only sweeps (the routine recurring case) stay small by
    // construction -- Meta's own effective_status=ACTIVE server-side
    // filter (fetchCampaigns/fetchAdSets/fetchAds' activeOnly option)
    // already bounds the due list -- so the whole thing is still
    // fetched, then written in one transaction (one persist()), exactly
    // as this function always behaved before batching existed. A
    // deadline check is still applied defensively (Phase 2 hardening):
    // if it's already blown by the time this branch starts, don't even
    // attempt the fetch loop -- report a clean 'timed_out' partial
    // instead of risking a second platform-level kill.
    // ══════════════════════════════════════════════════════════════
    if (Date.now() >= deadlineAt) {
      sweepComplete = false;
      sweepRemaining = metaCampaigns.length;
      partialReason = 'timed_out';
    } else {
      const rateLimitState = { broken: null };
      const campaignTree = [];
      for (const metaCampaign of metaCampaigns) {
        campaignTree.push(await fetchCampaignNode(metaCampaign, accessToken, campaignTreeOptions, rateLimitState, noteIfIncomplete));
        if (rateLimitState.broken || Date.now() >= deadlineAt) {
          partialReason = rateLimitState.broken ? 'rate_limited' : 'timed_out';
          break;
        }
      }
      if (campaignTree.length < metaCampaigns.length) {
        sweepComplete = false;
        sweepRemaining = metaCampaigns.length - campaignTree.length;
      }

      await db.run(`UPDATE ad_accounts SET sync_progress_phase = ? WHERE id = ?`, ['writing', adAccount.id]);
      await writeCampaignBatch(adAccount, campaignTree, summary, customAudienceSubtypeById);
    }
  } else {
    // ══════════════════════════════════════════════════════════════
    // Bounded/Resumable Initial Sync (AP-POS Sync Architecture Audit) --
    // full sweeps (initial ingestion, or an explicit manual Full Sync/
    // Full Rebuild) process due campaigns in checkpointed batches instead
    // of one unbounded pass, so a single invocation can never be forced
    // to attempt every campaign in a large/growing account at once --
    // see runBatchedFullSweep()'s own header comment.
    // ══════════════════════════════════════════════════════════════
    const result = await runBatchedFullSweep(adAccount, metaCampaigns, accessToken, campaignTreeOptions, summary, noteIfIncomplete, customAudienceSubtypeById, deadlineAt, metaCampaigns.incomplete);
    sweepComplete = result.sweepComplete;
    sweepRemaining = result.remaining;
    partialReason = result.reason;
    await db.run(`UPDATE ad_accounts SET sync_progress_phase = ? WHERE id = ?`, ['writing', adAccount.id]);
  }

  // Force Sync Deadline Propagation fix (FORCE_SYNC_END_TO_END_VERIFICATION_
  // REPORT.md / this follow-up mission): metaGetAll() can now stop
  // paginating the CAMPAIGN LIST ITSELF early (deadline, the existing
  // 5000-item safety cap, or a page-fetch error) -- metaCampaigns.incomplete
  // signals this. If it's true, the sweep can never be considered genuinely
  // complete no matter how thoroughly every DISCOVERED campaign got
  // processed, because the true full account size isn't known yet -- Meta
  // never confirmed there wasn't a further page. Without this check, a
  // deadline hit while merely LISTING campaigns (e.g. page 1 of a
  // 173-campaign account, which needs 2 pages at the 100-per-page limit)
  // could let a 100-of-173 partial discovery incorrectly set
  // initial_sync_completed_at once the (incomplete) list of 100 was fully
  // batch-processed.
  if (metaCampaigns.incomplete) {
    sweepComplete = false;
    if (!partialReason) {
      partialReason = metaCampaigns.incompleteReason === 'deadline_exceeded' ? 'timed_out' : metaCampaigns.incompleteReason;
    }
  }

  summary.completedAt = new Date().toISOString();
  // Completion Criteria (mission Section 14): sweepComplete=false means this
  // invocation's batch/time budget ran out (or a rate limit truncated it)
  // before every due campaign was processed -- NOT a failure, just partial
  // progress with a durable resume point (ad_accounts.sync_batch_cursor).
  // "Initial sync complete" (Section 1/8/16) specifically means a FULL
  // sweep (activeOnly === false) ran to completion at least once ever.
  summary.sweepComplete = sweepComplete;
  summary.sweepRemaining = sweepRemaining;
  // Phase 2 — structured status for callers (API response, sync_execution_log,
  // ad_accounts.last_sync_status/last_sync_partial_reason): 'completed' only
  // when the sweep is genuinely done AND nothing errored; 'partial' when the
  // sweep stopped early with no fatal errors (durable checkpoint, safe to
  // resume); 'failed' when real errors were recorded. partialReason further
  // distinguishes WHY a partial happened -- never fabricated, only set when
  // this invocation actually observed that condition.
  summary.status = summary.errors.length > 0 ? 'failed' : (sweepComplete ? 'completed' : 'partial');
  summary.partialReason = summary.status === 'partial' ? partialReason : null;

  console.log(
    `[Sync] ${summary.status} for ${adAccount.meta_account_id}: ` +
    `${summary.campaigns.synced} campaigns, ` +
    `${summary.adSets.synced} ad sets, ` +
    `${summary.ads.synced} ads` +
    (sweepComplete ? '' : ` (${sweepRemaining} campaign(s) still due, reason: ${summary.partialReason})`)
  );

  if (summary.status === 'failed') {
    console.warn(`[Sync] ${summary.errors.length} errors during sync`);
    await markSyncFailed(adAccount.id, summary);
  } else if (summary.status === 'partial') {
    // Genuinely different from both 'success' (nothing left to do) and
    // 'failed' (this invocation itself errored): the sweep stopped early
    // for a known, non-fatal reason (time budget, rate limit, or a batch
    // boundary) with a durable checkpoint already committed --
    // ad_accounts.sync_batch_cursor (full sweeps) is what the NEXT
    // invocation actually resumes from; last_sync_partial_reason here is
    // purely for observability (API responses, dashboard, sync history).
    await db.run(
      `UPDATE ad_accounts
       SET last_sync_completed_at = ?, last_sync_status = 'partial',
           last_sync_partial_reason = ?, sync_progress_phase = NULL, last_sync_error = NULL
       WHERE id = ?`,
      [summary.completedAt, summary.partialReason, adAccount.id]
    );
  } else {
    await db.run(
      `UPDATE ad_accounts
       SET last_sync_completed_at = ?, last_successful_sync_at = ?,
           last_sync_status = 'success', last_sync_partial_reason = NULL,
           sync_progress_phase = NULL, last_sync_error = NULL
       WHERE id = ?`,
      [summary.completedAt, summary.completedAt, adAccount.id]
    );

    if (!activeOnly && sweepComplete) {
      await db.run(
        `UPDATE ad_accounts SET initial_sync_completed_at = ? WHERE id = ? AND initial_sync_completed_at IS NULL`,
        [summary.completedAt, adAccount.id]
      );
    }
  }

  return summary;
}

/**
 * Record a failed/partially-failed sync on ad_accounts -- shared by the
 * early-return-on-fetch-failure path and the end-of-sync error-count check,
 * so both write the same tracking columns instead of one being silently
 * skipped.
 */
async function markSyncFailed(adAccountId, summary) {
  const now = new Date().toISOString();
  const errorMessage = summary.errors.map(e => `[${e.level}] ${e.message}`).join('; ') || 'Unknown sync error';
  await db.run(
    `UPDATE ad_accounts
     SET last_sync_completed_at = ?, last_failed_sync_at = ?,
         last_sync_status = 'failed', last_sync_partial_reason = NULL,
         sync_progress_phase = NULL, last_sync_error = ?
     WHERE id = ?`,
    [now, now, errorMessage, adAccountId]
  );
}

// Default timeout (minutes) before a sync stuck in last_sync_status='running'
// is considered abandoned by an ungraceful shutdown/crash, not genuinely
// still in progress. Configurable via SYNC_RECOVERY_TIMEOUT_MINUTES so an
// operator can tune it without a code change.
const DEFAULT_SYNC_RECOVERY_TIMEOUT_MINUTES = 30;

/**
 * Automatic Recovery For Interrupted Sync (run once on every server startup,
 * before the scheduler starts -- see src/app.js).
 *
 * sql.js/database.js has no durable in-flight job state (CLAUDE.md): if the
 * process dies between syncAccount() setting last_sync_status='running' and
 * it reaching markSyncFailed()/its own success UPDATE, that row is stuck
 * 'running' forever -- nothing else in this codebase ever reconciles it.
 * This finds every such row whose last_sync_started_at is older than
 * `timeoutMinutes` and marks it 'failed' with an explanatory note, exactly
 * like a real failed sync (same columns markSyncFailed() writes), so:
 *   - the Dashboard stops showing a perpetual "syncing" state for it
 *   - the account is never permanently blocked -- once last_sync_status is
 *     no longer 'running', it's just a normal failed sync, and the Smart
 *     Scheduler's existing due-check (last_sync_completed_at/interval, see
 *     autoSyncScheduler.js) picks it up again on its own next-due cycle like
 *     any other account -- no separate "eligible for retry" flag needed.
 *
 * @param {number} timeoutMinutes
 * @returns {{recovered: number, accounts: string[]}}
 */
async function recoverInterruptedSyncs(timeoutMinutes = parseInt(process.env.SYNC_RECOVERY_TIMEOUT_MINUTES, 10) || DEFAULT_SYNC_RECOVERY_TIMEOUT_MINUTES) {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60000).toISOString();
  const stuck = await db.all(
    `SELECT id, meta_account_id, last_sync_started_at FROM ad_accounts
     WHERE last_sync_status = 'running'
       AND last_sync_started_at IS NOT NULL
       AND last_sync_started_at < ?`,
    [cutoff]
  );

  if (stuck.length === 0) return { recovered: 0, accounts: [] };

  const now = new Date().toISOString();
  const note = 'Recovered after interrupted server shutdown.';

  for (const account of stuck) {
    await db.run(
      `UPDATE ad_accounts SET
         last_sync_status = 'failed',
         last_sync_completed_at = ?,
         last_failed_sync_at = ?,
         sync_progress_phase = NULL,
         last_sync_error = CASE
           WHEN last_sync_error IS NULL OR last_sync_error = '' THEN ?
           ELSE last_sync_error || ' | ' || ?
         END
       WHERE id = ?`,
      [now, now, note, note, account.id]
    );
    console.warn(
      `[Sync] Recovered interrupted sync for account ${account.meta_account_id} ` +
      `(stuck 'running' since ${account.last_sync_started_at}, timeout ${timeoutMinutes}m).`
    );
  }

  return { recovered: stuck.length, accounts: stuck.map(a => a.id) };
}

/**
 * Sync all active ad accounts in the database.
 */
async function syncAllAccounts(options = {}) {
  const accounts = await db.all(
    "SELECT * FROM ad_accounts WHERE status = 'active' AND token_is_valid = 1"
  );

  if (accounts.length === 0) {
    console.log('[Sync] No active accounts to sync.');
    return [];
  }

  console.log(`[Sync] Syncing ${accounts.length} account(s)...`);

  const results = [];
  for (const account of accounts) {
    // Automatic Recovery (requirement 15): syncAccount() already catches
    // everything it knows how to internally and always returns a summary
    // rather than throwing -- this is a last-resort safety net so that even
    // a genuinely unexpected exception in one account (e.g. a DB error)
    // pauses only that account instead of aborting every account still
    // queued behind it in this same run.
    try {
      const result = await syncAccount(account, options);
      results.push(result);
    } catch (err) {
      console.error(`[Sync] Unexpected error syncing account ${account.meta_account_id}, continuing with remaining accounts:`, err.message);
      results.push({
        accountId: account.id,
        metaAccountId: account.meta_account_id,
        campaigns: { synced: 0, errors: 1 },
        adSets: { synced: 0, errors: 0 },
        ads: { synced: 0, errors: 0 },
        errors: [{ level: 'account', message: err.message }],
        warnings: [],
        status: 'failed',
        partialReason: null,
        sweepComplete: false,
        sweepRemaining: 0,
      });
    }
  }

  return results;
}

module.exports = {
  syncAccount,
  syncAllAccounts,
  recoverInterruptedSyncs,
  upsertCampaign,
  upsertAdSet,
  upsertAd,
  DEFAULT_SYNC_RECOVERY_TIMEOUT_MINUTES,
  getRequestDeadline,
};
