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
 */
function upsertCampaign(adAccountId, metaCampaign) {
  const now = new Date().toISOString();
  const internalObjective = mapObjective(metaCampaign.objective);

  const existing = db.get(
    'SELECT id, objective, objective_effective_from FROM campaigns WHERE meta_campaign_id = ?',
    [metaCampaign.id]
  );

  if (existing) {
    // Track objective changes: if objective changed, update effective_from
    const objectiveChanged = existing.objective !== internalObjective;

    db.run(
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
    db.run(
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
function upsertAdSet(adAccountId, campaignId, metaAdSet) {
  const now = new Date().toISOString();

  const existing = db.get(
    'SELECT id FROM ad_sets WHERE meta_adset_id = ?',
    [metaAdSet.id]
  );

  if (existing) {
    db.run(
      `UPDATE ad_sets SET
        name = ?,
        status = ?,
        daily_budget = ?,
        lifetime_budget = ?,
        meta_updated_time = ?,
        updated_at = ?
      WHERE meta_adset_id = ?`,
      [
        metaAdSet.name,
        normalizeStatus(metaAdSet.status),
        metaAdSet.daily_budget ? parseFloat(metaAdSet.daily_budget) / 100 : null,
        metaAdSet.lifetime_budget ? parseFloat(metaAdSet.lifetime_budget) / 100 : null,
        metaAdSet.updated_time || now,
        now,
        metaAdSet.id,
      ]
    );
    return existing.id;
  } else {
    const id = uuidv4();
    db.run(
      `INSERT INTO ad_sets (
        id, campaign_id, ad_account_id, meta_adset_id, name, status,
        daily_budget, lifetime_budget, meta_created_time, meta_updated_time,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        campaignId,
        adAccountId,
        metaAdSet.id,
        metaAdSet.name,
        normalizeStatus(metaAdSet.status),
        metaAdSet.daily_budget ? parseFloat(metaAdSet.daily_budget) / 100 : null,
        metaAdSet.lifetime_budget ? parseFloat(metaAdSet.lifetime_budget) / 100 : null,
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
function upsertAd(adAccountId, campaignId, adSetId, metaAd) {
  const now = new Date().toISOString();

  // metaAd.creative comes from the creative{id,thumbnail_url,image_url}
  // field expansion in metaApiClient.fetchAds(). Not every ad has a
  // creative attached (e.g. a newly-created ad still in draft), so these
  // are genuinely nullable, not fabricated defaults.
  const creativeId    = metaAd.creative?.id ?? null;
  const thumbnailUrl  = metaAd.creative?.thumbnail_url ?? null;
  const imageUrl      = metaAd.creative?.image_url ?? null;

  const existing = db.get(
    'SELECT id FROM ads WHERE meta_ad_id = ?',
    [metaAd.id]
  );

  if (existing) {
    db.run(
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
    db.run(
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
  };

  console.log(`[Sync] Starting sync for account: ${adAccount.meta_account_id}`);

  const accessToken = decryptToken(adAccount.access_token_encrypted);

  // ── Step 1: Fetch and upsert campaigns ──
  let metaCampaigns;
  try {
    metaCampaigns = await fetchCampaigns(adAccount.meta_account_id, accessToken);
  } catch (err) {
    summary.errors.push({ level: 'account', message: err.message });
    console.error(`[Sync] Failed to fetch campaigns for ${adAccount.meta_account_id}:`, err.message);
    return summary;
  }

  for (const metaCampaign of metaCampaigns) {
    try {
      const campaignId = upsertCampaign(adAccount.id, metaCampaign);
      summary.campaigns.synced++;

      // ── Step 2: Fetch and upsert ad sets per campaign ──
      if (syncAdSets) {
        let metaAdSets;
        try {
          metaAdSets = await fetchAdSets(metaCampaign.id, accessToken);
        } catch (err) {
          summary.adSets.errors++;
          summary.errors.push({
            level: 'adsets',
            campaignId: metaCampaign.id,
            message: err.message,
          });
          continue;
        }

        for (const metaAdSet of metaAdSets) {
          try {
            const adSetId = upsertAdSet(adAccount.id, campaignId, metaAdSet);
            summary.adSets.synced++;

            // ── Step 3: Fetch and upsert ads per ad set ──
            if (syncAds) {
              let metaAds;
              try {
                metaAds = await fetchAds(metaAdSet.id, accessToken);
              } catch (err) {
                summary.ads.errors++;
                summary.errors.push({
                  level: 'ads',
                  adSetId: metaAdSet.id,
                  message: err.message,
                });
                continue;
              }

              for (const metaAd of metaAds) {
                try {
                  upsertAd(adAccount.id, campaignId, adSetId, metaAd);
                  summary.ads.synced++;
                } catch (err) {
                  summary.ads.errors++;
                  summary.errors.push({
                    level: 'ad',
                    adId: metaAd.id,
                    message: err.message,
                  });
                }
              }
            }

          } catch (err) {
            summary.adSets.errors++;
            summary.errors.push({
              level: 'adset',
              adSetId: metaAdSet.id,
              message: err.message,
            });
          }
        }
      }

    } catch (err) {
      summary.campaigns.errors++;
      summary.errors.push({
        level: 'campaign',
        campaignId: metaCampaign.id,
        message: err.message,
      });
    }
  }

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
