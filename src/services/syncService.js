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
const { fetchCampaigns, fetchAdSets, fetchAds } = require('./metaApiClient');
const { mapObjective } = require('./objectiveMapper');
const { decryptToken } = require('./tokenCrypto');

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
        meta_updated_time = ?,
        updated_at = ?
      WHERE meta_campaign_id = ?`,
      [
        metaCampaign.name,
        internalObjective,
        objectiveChanged ? 1 : 0,
        objectiveChanged ? now : null,
        normalizeStatus(metaCampaign.status),
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
        objective_effective_from, status, meta_created_time, meta_updated_time,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        adAccountId,
        metaCampaign.id,
        metaCampaign.name,
        internalObjective,
        now,
        normalizeStatus(metaCampaign.status),
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
function upsertAdSet(adAccountId, campaignId, metaAdSet, dbHandle = db) {
  const now = new Date().toISOString();

  const existing = dbHandle.get(
    'SELECT id FROM ad_sets WHERE meta_adset_id = ?',
    [metaAdSet.id]
  );

  if (existing) {
    dbHandle.run(
      `UPDATE ad_sets SET
        name = ?,
        status = ?,
        daily_budget = ?,
        lifetime_budget = ?,
        optimization_goal = ?,
        meta_updated_time = ?,
        updated_at = ?
      WHERE meta_adset_id = ?`,
      [
        metaAdSet.name,
        normalizeStatus(metaAdSet.status),
        metaAdSet.daily_budget ? parseFloat(metaAdSet.daily_budget) / 100 : null,
        metaAdSet.lifetime_budget ? parseFloat(metaAdSet.lifetime_budget) / 100 : null,
        metaAdSet.optimization_goal ?? null,
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
        id, campaign_id, ad_account_id, meta_adset_id, name, status,
        daily_budget, lifetime_budget, optimization_goal, meta_created_time, meta_updated_time,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        campaignId,
        adAccountId,
        metaAdSet.id,
        metaAdSet.name,
        normalizeStatus(metaAdSet.status),
        metaAdSet.daily_budget ? parseFloat(metaAdSet.daily_budget) / 100 : null,
        metaAdSet.lifetime_budget ? parseFloat(metaAdSet.lifetime_budget) / 100 : null,
        metaAdSet.optimization_goal ?? null,
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

  const existing = dbHandle.get(
    'SELECT id FROM ads WHERE meta_ad_id = ?',
    [metaAd.id]
  );

  if (existing) {
    dbHandle.run(
      `UPDATE ads SET
        name = ?,
        status = ?,
        meta_updated_time = ?,
        creative_id = ?,
        thumbnail_url = ?,
        image_url = ?,
        updated_at = ?
      WHERE meta_ad_id = ?`,
      [
        metaAd.name,
        normalizeStatus(metaAd.status),
        metaAd.updated_time || now,
        creativeId,
        thumbnailUrl,
        imageUrl,
        now,
        metaAd.id,
      ]
    );
    return existing.id;
  } else {
    const id = uuidv4();
    dbHandle.run(
      `INSERT INTO ads (
        id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status,
        meta_created_time, meta_updated_time, creative_id, thumbnail_url,
        image_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        adSetId,
        campaignId,
        adAccountId,
        metaAd.id,
        metaAd.name,
        normalizeStatus(metaAd.status),
        metaAd.created_time || now,
        metaAd.updated_time || now,
        creativeId,
        thumbnailUrl,
        imageUrl,
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
  const { syncAdSets = true, syncAds = true } = options;

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

  console.log(`[Sync] Starting sync for account: ${adAccount.meta_account_id}`);

  const accessToken = decryptToken(adAccount.access_token_encrypted);

  // ══════════════════════════════════════════════════════════════
  // PHASE 1 — FETCH everything from Meta into an in-memory tree.
  // No DB writes happen in this phase.
  // ══════════════════════════════════════════════════════════════
  let metaCampaigns;
  try {
    metaCampaigns = await fetchCampaigns(adAccount.meta_account_id, accessToken);
    noteIfIncomplete('campaigns', metaCampaigns, adAccount.meta_account_id);
  } catch (err) {
    summary.errors.push({ level: 'account', message: err.message });
    console.error(`[Sync] Failed to fetch campaigns for ${adAccount.meta_account_id}:`, err.message);
    return summary;
  }

  const campaignTree = [];

  for (const metaCampaign of metaCampaigns) {
    const node = { metaCampaign, adSets: [], fetchError: null };

    if (syncAdSets) {
      try {
        const metaAdSets = await fetchAdSets(metaCampaign.id, accessToken);
        noteIfIncomplete('adsets', metaAdSets, metaCampaign.id);

        for (const metaAdSet of metaAdSets) {
          const adSetNode = { metaAdSet, ads: [], fetchError: null };

          if (syncAds) {
            try {
              const metaAds = await fetchAds(metaAdSet.id, accessToken);
              noteIfIncomplete('ads', metaAds, metaAdSet.id);
              adSetNode.ads = metaAds;
            } catch (err) {
              adSetNode.fetchError = err.message;
            }
          }

          node.adSets.push(adSetNode);
        }
      } catch (err) {
        node.fetchError = err.message;
      }
    }

    campaignTree.push(node);
  }

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
          adSetId = upsertAdSet(adAccount.id, campaignId, adSetNode.metaAdSet, tx);
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
  }

  return summary;
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
    const result = await syncAccount(account, options);
    results.push(result);
  }

  return results;
}

module.exports = {
  syncAccount,
  syncAllAccounts,
  upsertCampaign,
  upsertAdSet,
  upsertAd,
};
