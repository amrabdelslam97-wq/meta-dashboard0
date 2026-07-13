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
function upsertCampaign(adAccountId, metaCampaign, dbHandle = db) {
  const now = new Date().toISOString();
  const internalObjective = mapObjective(metaCampaign.objective);

  const existing = dbHandle.get(
    'SELECT id, objective, objective_effective_from FROM campaigns WHERE meta_campaign_id = ?',
    [metaCampaign.id]
  );

  if (existing) {
    // Track objective changes: if objective changed, update effective_from
    const objectiveChanged = existing.objective !== internalObjective;

    dbHandle.run(
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
    dbHandle.run(
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
function upsertAdSet(adAccountId, campaignId, metaAdSet, dbHandle = db, customAudienceSubtypeById = {}) {
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

  const existing = dbHandle.get(
    'SELECT id FROM ad_sets WHERE meta_adset_id = ?',
    [metaAdSet.id]
  );

  if (existing) {
    dbHandle.run(
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
    dbHandle.run(
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
function upsertAd(adAccountId, campaignId, adSetId, metaAd, dbHandle = db) {
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

  const existing = dbHandle.get(
    'SELECT id FROM ads WHERE meta_ad_id = ?',
    [metaAd.id]
  );

  if (existing) {
    dbHandle.run(
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
    dbHandle.run(
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
 * @returns {object} Summary of what was synced
 */
async function syncAccount(adAccount, options = {}) {
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
  const inFlight = db.get(
    `SELECT last_sync_status, last_sync_started_at FROM ad_accounts WHERE id = ?`,
    [adAccount.id]
  );
  if (inFlight && inFlight.last_sync_status === 'running' && inFlight.last_sync_started_at) {
    const ageMinutes = (Date.now() - new Date(inFlight.last_sync_started_at).getTime()) / 60000;
    if (ageMinutes < DEFAULT_SYNC_RECOVERY_TIMEOUT_MINUTES) {
      summary.errors.push({ level: 'account', message: `Sync already in progress for this account (started ${inFlight.last_sync_started_at}).` });
      summary.completedAt = new Date().toISOString();
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
    markSyncFailed(adAccount.id, summary);
    return summary;
  }

  const startedAt = new Date().toISOString();
  db.run(
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
    metaCampaigns = await fetchCampaigns(adAccount.meta_account_id, accessToken, { activeOnly });
    noteIfIncomplete('campaigns', metaCampaigns, adAccount.meta_account_id);

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
      db.run(`UPDATE ad_accounts SET token_is_valid = 0 WHERE id = ?`, [adAccount.id]);
    }
    markSyncFailed(adAccount.id, summary);
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
      const customAudiences = await fetchCustomAudiences(adAccount.meta_account_id, accessToken);
      customAudienceSubtypeById = Object.fromEntries(customAudiences.map(a => [a.id, a.subtype || null]));
    }
  } catch (err) {
    console.warn(`[Sync] Could not fetch custom audiences for ${adAccount.meta_account_id} (audience-type classification will be less precise):`, err.message);
  }

  const campaignTree = [];

  db.run(`UPDATE ad_accounts SET sync_progress_phase = ? WHERE id = ?`, ['fetching_adsets_and_ads', adAccount.id]);

  // Once Meta reports an account-level rate limit (e.g. "User request limit
  // reached"), that throttle applies to every subsequent call for this same
  // account/token for the rest of this run -- retrying it per campaign only
  // guarantees the same failure while burning metaGet()'s full 3-attempt
  // backoff (up to ~35s) each time. Confirmed in production: a 37- and a
  // 99-campaign account each spent 23-60+ minutes making guaranteed-to-fail
  // calls this way. Once set, remaining nodes are marked with the same error
  // without any further network call -- everything else about per-node error
  // isolation/reporting stays exactly as it was.
  let rateLimitBreaker = null;

  for (const metaCampaign of metaCampaigns) {
    const node = { metaCampaign, adSets: [], fetchError: null };

    if (syncAdSets) {
      if (rateLimitBreaker) {
        node.fetchError = rateLimitBreaker;
      } else {
        try {
          const metaAdSets = await fetchAdSets(metaCampaign.id, accessToken, { activeOnly });
          noteIfIncomplete('adsets', metaAdSets, metaCampaign.id);

          for (const metaAdSet of metaAdSets) {
            const adSetNode = { metaAdSet, ads: [], fetchError: null };

            if (syncAds) {
              if (rateLimitBreaker) {
                adSetNode.fetchError = rateLimitBreaker;
              } else {
                try {
                  const metaAds = await fetchAds(metaAdSet.id, accessToken, { activeOnly });
                  noteIfIncomplete('ads', metaAds, metaAdSet.id);
                  adSetNode.ads = metaAds;
                } catch (err) {
                  adSetNode.fetchError = err.message;
                  if (isRateLimitError(err)) rateLimitBreaker = err.message;
                }
              }
            }

            node.adSets.push(adSetNode);
          }
        } catch (err) {
          node.fetchError = err.message;
          if (isRateLimitError(err)) rateLimitBreaker = err.message;
        }
      }
    }

    campaignTree.push(node);
  }

  db.run(`UPDATE ad_accounts SET sync_progress_phase = ? WHERE id = ?`, ['writing', adAccount.id]);

  // ══════════════════════════════════════════════════════════════
  // PHASE 2 — WRITE the whole tree in one transaction (one persist()).
  // ══════════════════════════════════════════════════════════════
  db.transaction((tx) => {
    for (const node of campaignTree) {
      let campaignId;
      try {
        campaignId = upsertCampaign(adAccount.id, node.metaCampaign, tx);
        summary.campaigns.synced++;
      } catch (err) {
        summary.campaigns.errors++;
        summary.errors.push({ level: 'campaign', campaignId: node.metaCampaign.id, message: err.message });
        continue;
      }

      if (!syncAdSets) continue;

      if (node.fetchError) {
        summary.adSets.errors++;
        summary.errors.push({ level: 'adsets', campaignId: node.metaCampaign.id, message: node.fetchError });
        continue;
      }

      for (const adSetNode of node.adSets) {
        let adSetId;
        try {
          adSetId = upsertAdSet(adAccount.id, campaignId, adSetNode.metaAdSet, tx, customAudienceSubtypeById);
          summary.adSets.synced++;
        } catch (err) {
          summary.adSets.errors++;
          summary.errors.push({ level: 'adset', adSetId: adSetNode.metaAdSet.id, message: err.message });
          continue;
        }

        if (!syncAds) continue;

        if (adSetNode.fetchError) {
          summary.ads.errors++;
          summary.errors.push({ level: 'ads', adSetId: adSetNode.metaAdSet.id, message: adSetNode.fetchError });
          continue;
        }

        for (const metaAd of adSetNode.ads) {
          try {
            upsertAd(adAccount.id, campaignId, adSetId, metaAd, tx);
            summary.ads.synced++;
          } catch (err) {
            summary.ads.errors++;
            summary.errors.push({ level: 'ad', adId: metaAd.id, message: err.message });
          }
        }
      }
    }
  });

  summary.completedAt = new Date().toISOString();

  console.log(
    `[Sync] Completed for ${adAccount.meta_account_id}: ` +
    `${summary.campaigns.synced} campaigns, ` +
    `${summary.adSets.synced} ad sets, ` +
    `${summary.ads.synced} ads`
  );

  if (summary.errors.length > 0) {
    console.warn(`[Sync] ${summary.errors.length} errors during sync`);
    markSyncFailed(adAccount.id, summary);
  } else {
    db.run(
      `UPDATE ad_accounts
       SET last_sync_completed_at = ?, last_successful_sync_at = ?,
           last_sync_status = 'success', sync_progress_phase = NULL, last_sync_error = NULL
       WHERE id = ?`,
      [summary.completedAt, summary.completedAt, adAccount.id]
    );
  }

  return summary;
}

/**
 * Record a failed/partially-failed sync on ad_accounts -- shared by the
 * early-return-on-fetch-failure path and the end-of-sync error-count check,
 * so both write the same tracking columns instead of one being silently
 * skipped.
 */
function markSyncFailed(adAccountId, summary) {
  const now = new Date().toISOString();
  const errorMessage = summary.errors.map(e => `[${e.level}] ${e.message}`).join('; ') || 'Unknown sync error';
  db.run(
    `UPDATE ad_accounts
     SET last_sync_completed_at = ?, last_failed_sync_at = ?,
         last_sync_status = 'failed', sync_progress_phase = NULL, last_sync_error = ?
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
function recoverInterruptedSyncs(timeoutMinutes = parseInt(process.env.SYNC_RECOVERY_TIMEOUT_MINUTES, 10) || DEFAULT_SYNC_RECOVERY_TIMEOUT_MINUTES) {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60000).toISOString();
  const stuck = db.all(
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
    db.run(
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
  const accounts = db.all(
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
};
