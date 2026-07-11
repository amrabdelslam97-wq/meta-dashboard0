/**
 * Audience Attribution Engine — Attribution & Customer Journey Intelligence
 * (Step 9)
 *
 * Classifies each ad set's real Meta targeting configuration into an
 * audience type, then aggregates spend/results/ctr/roas/cpa/frequency by
 * that type. No fabricated categories: every bucket below is backed by a
 * real, distinguishable Meta targeting field --
 *
 *   advantage_plus  — targeting.targeting_automation.advantage_audience
 *   lookalike       — targeting.lookalike_spec present, OR any referenced
 *                      custom audience whose real subtype (resolved via
 *                      metaApiClient.fetchCustomAudiences(), NOT derivable
 *                      from the ad set's own targeting) is LOOKALIKE
 *   remarketing     — a referenced custom audience with subtype WEBSITE,
 *                      ENGAGEMENT, or APP (Meta's own retargeting-style
 *                      subtypes)
 *   custom_audience — a referenced custom audience whose subtype is CUSTOM
 *                      (an uploaded customer list) or could not be resolved
 *                      (e.g. it was deleted, or belongs to another account
 *                      the token can't read as a shared audience)
 *   interest        — targeting.flexible_spec present (interests/behaviors),
 *                      no custom/lookalike audience
 *   broad           — none of the above (demographic/geo targeting only)
 *
 * Deliberately NOT implemented: "Saved Audience" and "Dynamic Audience" are
 * not classifiable from ad-set targeting at all -- "Saved Audience" is an
 * Ads Manager UI reuse-workflow label, not a distinct targeting-API concept
 * (a saved audience IS just a broad/interest/custom targeting spec someone
 * named and reused, indistinguishable from a one-off spec at the API level);
 * "Dynamic Audience" (Dynamic Product Ads) requires product-catalog/
 * product-set integration this system does not have. Both would require
 * inventing a category with no real signal behind it.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { fetchAdSetMetrics } = require('./metricsFetcher');
const { decryptToken } = require('./tokenCrypto');
const { defaultRange } = require('./dateRangeHelper');
const { buildInsight } = require('./analyticsInsight');
const { isRateLimitError } = require('./metaApiClient');

const REMARKETING_SUBTYPES = new Set(['WEBSITE', 'ENGAGEMENT', 'APP']);

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * @param {object|null} targeting - the ad set's raw targeting object (from
 *   metaApiClient.fetchAdSets()'s targeting{...} field expansion)
 * @param {object} customAudienceSubtypeById - { [audienceId]: subtype },
 *   built once per account from metaApiClient.fetchCustomAudiences()
 * @returns {string} one of advantage_plus|lookalike|remarketing|custom_audience|interest|broad|unknown
 */
function classifyAudienceType(targeting, customAudienceSubtypeById = {}) {
  if (!targeting) return 'unknown';

  const advantageAudience = targeting.targeting_automation?.advantage_audience === 1
    || targeting.targeting_automation?.advantage_audience === true;
  if (advantageAudience) return 'advantage_plus';

  const customAudiences = Array.isArray(targeting.custom_audiences) ? targeting.custom_audiences : [];
  const hasLookalikeSpec = !!targeting.lookalike_spec;
  const subtypes = customAudiences.map(a => customAudienceSubtypeById[a.id]).filter(Boolean);

  if (hasLookalikeSpec || subtypes.includes('LOOKALIKE')) return 'lookalike';
  if (subtypes.some(s => REMARKETING_SUBTYPES.has(s))) return 'remarketing';
  if (customAudiences.length > 0) return 'custom_audience';

  const hasInterests = Array.isArray(targeting.flexible_spec) && targeting.flexible_spec.length > 0;
  if (hasInterests) return 'interest';

  return 'broad';
}

/**
 * Sync: for every active ad set in an account, fetch its own performance
 * (metricsFetcher.fetchAdSetMetrics -- the same function the ad-set
 * Intelligence Center detail view already calls, no new Meta call shape),
 * group by the already-classified ad_sets.audience_type (computed at
 * campaign/ad-set sync time by syncService.js, not re-derived here), and
 * persist one row per (campaign, audience_type, date range).
 */
async function syncAccountAudienceAttribution(account, dateRange = defaultRange()) {
  const accessToken = decryptToken(account.access_token_encrypted);
  const summary = { campaignsProcessed: 0, apiCalls: 0, errors: [] };

  const adSets = db.all(
    `SELECT s.meta_adset_id, s.audience_type, c.meta_campaign_id
     FROM ad_sets s JOIN campaigns c ON c.id = s.campaign_id
     WHERE s.ad_account_id = ? AND s.status = 'active'`,
    [account.id]
  );
  if (adSets.length === 0) return summary;

  const byCampaign = new Map();
  for (const row of adSets) {
    if (!byCampaign.has(row.meta_campaign_id)) byCampaign.set(row.meta_campaign_id, []);
    byCampaign.get(row.meta_campaign_id).push(row);
  }

  for (const [metaCampaignId, campaignAdSets] of byCampaign) {
    let metrics;
    try {
      summary.apiCalls++;
      metrics = await fetchAdSetMetrics(metaCampaignId, accessToken, dateRange.since, dateRange.until, account.attribution_window_days);
    } catch (err) {
      summary.errors.push({ campaign: metaCampaignId, message: err.message });
      if (isRateLimitError(err)) throw err;
      continue;
    }

    const metricsByAdSetId = new Map(metrics.map(m => [m.meta_adset_id, m]));
    const byType = new Map();
    for (const row of campaignAdSets) {
      const m = metricsByAdSetId.get(row.meta_adset_id);
      if (!m) continue;
      const type = row.audience_type || 'unknown';
      if (!byType.has(type)) byType.set(type, { spend: 0, results: 0, clicks: 0, impressions: 0, purchase_value: 0, frequencySum: 0, frequencyCount: 0 });
      const agg = byType.get(type);
      agg.spend += m.spend || 0;
      agg.results += m.results || 0;
      agg.clicks += m.clicks || 0;
      agg.impressions += m.impressions || 0;
      agg.purchase_value += m.purchase_value || 0;
      if (m.frequency != null) { agg.frequencySum += m.frequency; agg.frequencyCount++; }
    }

    const totalSpend = [...byType.values()].reduce((s, a) => s + a.spend, 0);
    const now = new Date().toISOString();

    db.transaction(tx => {
      for (const [type, agg] of byType) {
        const ctr = agg.impressions > 0 ? round((agg.clicks / agg.impressions) * 100, 4) : null;
        const roas = agg.spend > 0 && agg.purchase_value > 0 ? round(agg.purchase_value / agg.spend, 2) : null;
        const cpa = agg.results > 0 ? round(agg.spend / agg.results, 2) : null;
        const frequency = agg.frequencyCount > 0 ? round(agg.frequencySum / agg.frequencyCount, 2) : null;
        const contributionPct = totalSpend > 0 ? round((agg.spend / totalSpend) * 100, 1) : 0;

        tx.run(
          `INSERT INTO audience_attribution (id, ad_account_id, meta_campaign_id, audience_type, date_since, date_until, spend, results, ctr, roas, cpa, frequency, contribution_pct, calculated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(ad_account_id, meta_campaign_id, audience_type, date_since, date_until) DO UPDATE SET
             spend = excluded.spend, results = excluded.results, ctr = excluded.ctr, roas = excluded.roas,
             cpa = excluded.cpa, frequency = excluded.frequency, contribution_pct = excluded.contribution_pct,
             calculated_at = excluded.calculated_at`,
          [uuidv4(), account.id, metaCampaignId, type, dateRange.since, dateRange.until, round(agg.spend), round(agg.results), ctr, roas, cpa, frequency, contributionPct, now]
        );
      }
    });

    summary.campaignsProcessed++;
  }

  return summary;
}

/** Read side (no Meta calls). */
function getAudienceAttribution(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT * FROM audience_attribution WHERE meta_campaign_id = ? AND date_since = ? AND date_until = ? ORDER BY spend DESC`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );
  return {
    date_range: dateRange,
    audience_types: rows,
    insight: buildInsight(rows, { costKey: 'cpa', labelKey: 'audience_type' }),
    not_classifiable: ['saved_audience', 'dynamic_audience'],
    not_classifiable_reason: 'Saved Audience is an Ads Manager UI reuse label, not a distinct targeting-API concept; Dynamic Audience (Dynamic Product Ads) requires product-catalog integration this system does not have. Neither can be honestly distinguished from the categories above.',
  };
}

module.exports = {
  classifyAudienceType,
  syncAccountAudienceAttribution,
  getAudienceAttribution,
};
