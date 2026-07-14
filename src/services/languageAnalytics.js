/**
 * Language Analytics — Executive Marketing Analytics Layer (Phase 17)
 * Extended with Language Performance Attribution — Attribution & Customer
 * Journey Intelligence (Step 11)
 *
 * Meta's Insights API has NO language performance breakdown (confirmed --
 * `breakdowns` supports age/gender/region/country/comscore_market/publisher_platform/
 * platform_position/impression_device/device_platform, never language).
 * getLanguageTargeting() (below, untouched) exposes the honest fallback:
 * each ad set's configured target locales alongside that ad set's own
 * overall performance -- "what languages are we targeting, and how is that
 * ad set doing overall", not "how did French vs. Arabic perform", which
 * this API cannot answer.
 *
 * getLanguagePerformanceAttribution() (new, Step 11) goes one step further
 * and IS a genuine performance join: each ad set's own real spend/ctr/roas/
 * cpa (fetched via metricsFetcher.fetchAdSetMetrics(), the exact same
 * function adSetIntelligence.js's detail view and audienceAttributionEngine.js
 * already call -- no new Meta call shape) grouped by its configured locale
 * SET (an ad set targeting both English and Arabic is one combined group,
 * "English (US) + Arabic" -- never fanned out to both locales separately,
 * which would double-count its spend and break contribution_pct summing to
 * 100). This is still honestly a per-AD-SET-TARGETING-CONFIGURATION split,
 * not Meta natively reporting "this specific impression was served in
 * Arabic" -- an ad set that mixes languages within one combined audience
 * still reports one blended number for that group, which is the ceiling of
 * what's real here.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { fetchAdSetMetrics } = require('./metricsFetcher');
const { decryptToken } = require('./tokenCrypto');
const { defaultRange } = require('./dateRangeHelper');
const { buildInsight } = require('./analyticsInsight');
const { isRateLimitError } = require('./metaApiClient');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Meta's numeric locale IDs for the languages this single-user system's
// connected accounts most commonly target (Arabic-market and English).
// Unrecognized IDs are returned as-is (labelled "locale_<id>") rather than
// guessed, so this list only needs to grow with real, observed accounts.
const LOCALE_LABELS = {
  6: 'English (US)', 24: 'Arabic', 32: 'French (France)', 23: 'Spanish',
  1001: 'English (UK)', 1010: 'English (All)',
};

function labelLocale(id) {
  return LOCALE_LABELS[id] || `locale_${id}`;
}

/**
 * @param {string} metaCampaignId
 */
function getLanguageTargeting(metaCampaignId) {
  const adSets = db.all(
    `SELECT s.meta_adset_id, s.name, s.targeting_locales, s.status
     FROM ad_sets s
     JOIN campaigns c ON c.id = s.campaign_id
     WHERE c.meta_campaign_id = ?`,
    [metaCampaignId]
  );

  const rows = adSets.map(s => {
    let locales = [];
    try { locales = s.targeting_locales ? JSON.parse(s.targeting_locales) : []; } catch { locales = []; }
    return {
      meta_adset_id: s.meta_adset_id,
      name: s.name,
      status: s.status,
      targeted_locale_ids: locales,
      targeted_languages: locales.map(labelLocale),
      all_languages: locales.length === 0,
    };
  });

  return {
    ad_sets: rows,
    note: 'Meta\'s Insights API does not expose performance broken down by language -- this shows each ad set\'s configured language targeting, not a per-language performance split.',
  };
}

// ─────────────────────────────────────────────
// Step 11 — Language Performance Attribution (real spend/ctr/roas/cpa,
// grouped by each ad set's own configured locale set)
// ─────────────────────────────────────────────

/** Builds a stable group key + display label from a locale ID array. */
function localeGroupKey(locales) {
  if (!locales || locales.length === 0) return { key: 'all', label: 'All Languages' };
  const sorted = [...locales].sort((a, b) => a - b);
  return { key: sorted.join(','), label: sorted.map(labelLocale).join(' + ') };
}

/**
 * Sync: for every active ad set in an account, fetch its own performance
 * (metricsFetcher.fetchAdSetMetrics -- same function audienceAttributionEngine.js
 * and the ad-set Intelligence Center detail view already call), group by
 * the ad set's own targeting_locales, and persist one row per (campaign,
 * locale group, date range).
 */
async function syncAccountLanguagePerformance(account, dateRange = defaultRange()) {
  const accessToken = decryptToken(account.access_token_encrypted);
  const summary = { campaignsProcessed: 0, apiCalls: 0, errors: [] };

  const adSets = db.all(
    `SELECT s.meta_adset_id, s.targeting_locales, c.meta_campaign_id
     FROM ad_sets s JOIN campaigns c ON c.id = s.campaign_id
     WHERE s.ad_account_id = ? AND s.status = 'active'`,
    [account.id]
  );
  if (adSets.length === 0) return summary;

  const byCampaign = new Map();
  for (const row of adSets) {
    if (!byCampaign.has(row.meta_campaign_id)) byCampaign.set(row.meta_campaign_id, []);
    let locales = [];
    try { locales = row.targeting_locales ? JSON.parse(row.targeting_locales) : []; } catch { locales = []; }
    byCampaign.get(row.meta_campaign_id).push({ ...row, locales });
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
    const byGroup = new Map();
    for (const row of campaignAdSets) {
      const m = metricsByAdSetId.get(row.meta_adset_id);
      if (!m) continue;
      const { key, label } = localeGroupKey(row.locales);
      if (!byGroup.has(key)) byGroup.set(key, { label, spend: 0, results: 0, clicks: 0, impressions: 0, purchase_value: 0 });
      const agg = byGroup.get(key);
      agg.spend += m.spend || 0;
      agg.results += m.results || 0;
      agg.clicks += m.clicks || 0;
      agg.impressions += m.impressions || 0;
      agg.purchase_value += m.purchase_value || 0;
    }

    const totalSpend = [...byGroup.values()].reduce((s, a) => s + a.spend, 0);
    const now = new Date().toISOString();

    db.transaction(tx => {
      for (const [key, agg] of byGroup) {
        const ctr = agg.impressions > 0 ? round((agg.clicks / agg.impressions) * 100, 4) : null;
        const roas = agg.spend > 0 && agg.purchase_value > 0 ? round(agg.purchase_value / agg.spend, 2) : null;
        const cpa = agg.results > 0 ? round(agg.spend / agg.results, 2) : null;
        const contributionPct = totalSpend > 0 ? round((agg.spend / totalSpend) * 100, 1) : 0;

        tx.run(
          `INSERT INTO language_performance_attribution (id, ad_account_id, meta_campaign_id, locale_id, locale_label, date_since, date_until, spend, results, ctr, roas, cpa, contribution_pct, calculated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(ad_account_id, meta_campaign_id, locale_id, date_since, date_until) DO UPDATE SET
             locale_label = excluded.locale_label, spend = excluded.spend, results = excluded.results, ctr = excluded.ctr,
             roas = excluded.roas, cpa = excluded.cpa, contribution_pct = excluded.contribution_pct, calculated_at = excluded.calculated_at`,
          [uuidv4(), account.id, metaCampaignId, key, agg.label, dateRange.since, dateRange.until, round(agg.spend), round(agg.results), ctr, roas, cpa, contributionPct, now]
        );
      }
    });

    summary.campaignsProcessed++;
  }

  return summary;
}

/** Read side (no Meta calls). */
function getLanguagePerformanceAttribution(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT * FROM language_performance_attribution WHERE meta_campaign_id = ? AND date_since = ? AND date_until = ? ORDER BY spend DESC`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );
  return {
    date_range: dateRange,
    languages: rows,
    insight: buildInsight(rows, { costKey: 'cpa', labelKey: 'locale_label' }),
    note: 'Grouped by each ad set\'s own configured locale targeting -- Meta reports no per-impression language, so a mixed-language ad set contributes one blended row, never fanned out (which would double-count its spend).',
  };
}

module.exports = {
  getLanguageTargeting, labelLocale,
  syncAccountLanguagePerformance, getLanguagePerformanceAttribution,
};
