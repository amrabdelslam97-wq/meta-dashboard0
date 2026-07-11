/**
 * Language Attribution Engine — Attribution & Customer Journey Intelligence
 * (Step 11)
 *
 * Analyzes performance by targeted language (locale_id from ad_sets.targeting_locales).
 *
 * Extends the existing languageAnalytics.js (which shows targeting configuration)
 * with genuine performance data -- how campaigns perform when targeting each
 * specific language, aggregated across all ad sets using that language.
 *
 * Note: this is "language targeting" (what languages you chose to reach),
 * not "language detected" (what language the user's browser was in). The
 * latter would require a different Meta Insights breakdown (which doesn't
 * exist in the current API; user browser language detection would be in
 * platform/audience audience breakdowns, not a separate "language" dimension).
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

// Map of common locale IDs to labels (Meta's locale format)
const LOCALE_MAP = {
  en_US: 'English (US)',
  ar_AR: 'Arabic',
  en_GB: 'English (UK)',
  fr_FR: 'French',
  de_DE: 'German',
  es_ES: 'Spanish',
  it_IT: 'Italian',
  pt_BR: 'Portuguese (Brazil)',
  ru_RU: 'Russian',
  zh_CN: 'Chinese (Simplified)',
  ja_JP: 'Japanese',
};

function getLocaleLabel(localeId) {
  return LOCALE_MAP[localeId] || localeId;
}

/**
 * Sync: for every active ad set in an account, extract targeting_locales
 * from its targeting config, fetch its own metrics, and aggregate by locale.
 * Persist one row per (campaign, locale_id, date range).
 */
async function syncAccountLanguageAttribution(account, dateRange = defaultRange()) {
  const accessToken = decryptToken(account.access_token_encrypted);
  const summary = { campaignsProcessed: 0, apiCalls: 0, errors: [] };

  const adSets = db.all(
    `SELECT s.meta_adset_id, s.targeting_json, c.meta_campaign_id
     FROM ad_sets s JOIN campaigns c ON c.id = s.campaign_id
     WHERE s.ad_account_id = ? AND s.status = 'active'`,
    [account.id]
  );
  if (adSets.length === 0) return summary;

  const byCampaign = new Map();
  const byLocale = new Map(); // { localeId -> { spend, results, clicks, impressions, ... } }

  for (const row of adSets) {
    if (!byCampaign.has(row.meta_campaign_id)) byCampaign.set(row.meta_campaign_id, []);
    byCampaign.get(row.meta_campaign_id).push(row);

    // Extract targeting_locales from targeting_json
    let locales = [];
    try {
      const targeting = JSON.parse(row.targeting_json || '{}');
      locales = Array.isArray(targeting.targeting_locales) ? targeting.targeting_locales : [];
    } catch {
      locales = [];
    }

    if (locales.length === 0) locales = ['all']; // Fallback for unspecified locales

    for (const locale of locales) {
      if (!byLocale.has(locale)) byLocale.set(locale, { spend: 0, results: 0, clicks: 0, impressions: 0, purchase_value: 0, frequencySum: 0, frequencyCount: 0, adSetIds: [] });
      byLocale.get(locale).adSetIds.push(row.meta_adset_id);
    }
  }

  const now = new Date().toISOString();

  // For each campaign
  for (const [metaCampaignId, campaignAdSets] of byCampaign) {
    // Fetch all ad set metrics for this campaign
    let allMetrics;
    try {
      summary.apiCalls++;
      allMetrics = await fetchAdSetMetrics(metaCampaignId, accessToken, dateRange.since, dateRange.until, account.attribution_window_days);
    } catch (err) {
      summary.errors.push({ campaign: metaCampaignId, message: err.message });
      if (isRateLimitError(err)) throw err;
      continue;
    }

    const metricsByAdSetId = new Map(allMetrics.map(m => [m.meta_adset_id, m]));

    // Group metrics by locale
    const byLocaleForCampaign = new Map();
    for (const adSet of campaignAdSets) {
      const m = metricsByAdSetId.get(adSet.meta_adset_id);
      if (!m) continue;

      // Extract locales from targeting_json
      let locales = [];
      try {
        const targeting = JSON.parse(adSet.targeting_json || '{}');
        locales = Array.isArray(targeting.targeting_locales) ? targeting.targeting_locales : [];
      } catch {
        locales = [];
      }
      if (locales.length === 0) locales = ['all'];

      for (const locale of locales) {
        if (!byLocaleForCampaign.has(locale)) {
          byLocaleForCampaign.set(locale, { spend: 0, results: 0, clicks: 0, impressions: 0, purchase_value: 0, frequencySum: 0, frequencyCount: 0 });
        }
        const agg = byLocaleForCampaign.get(locale);
        agg.spend += m.spend || 0;
        agg.results += m.results || 0;
        agg.clicks += m.clicks || 0;
        agg.impressions += m.impressions || 0;
        agg.purchase_value += m.purchase_value || 0;
        if (m.frequency != null) { agg.frequencySum += m.frequency; agg.frequencyCount++; }
      }
    }

    const totalSpend = [...byLocaleForCampaign.values()].reduce((s, a) => s + a.spend, 0);

    db.transaction(tx => {
      for (const [locale, agg] of byLocaleForCampaign) {
        const ctr = agg.impressions > 0 ? round((agg.clicks / agg.impressions) * 100, 4) : null;
        const roas = agg.spend > 0 && agg.purchase_value > 0 ? round(agg.purchase_value / agg.spend, 2) : null;
        const cpa = agg.results > 0 ? round(agg.spend / agg.results, 2) : null;
        const contributionPct = totalSpend > 0 ? round((agg.spend / totalSpend) * 100, 1) : 0;

        tx.run(
          `INSERT INTO language_performance_attribution (id, ad_account_id, meta_campaign_id, locale_id, locale_label, date_since, date_until, spend, results, ctr, roas, cpa, contribution_pct, calculated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(ad_account_id, meta_campaign_id, locale_id, date_since, date_until) DO UPDATE SET
             spend = excluded.spend, results = excluded.results, ctr = excluded.ctr, roas = excluded.roas,
             cpa = excluded.cpa, contribution_pct = excluded.contribution_pct, calculated_at = excluded.calculated_at`,
          [uuidv4(), account.id, metaCampaignId, locale, getLocaleLabel(locale), dateRange.since, dateRange.until, round(agg.spend), round(agg.results), ctr, roas, cpa, contributionPct, now]
        );
      }
    });

    summary.campaignsProcessed++;
  }

  return summary;
}

/**
 * Read side: get language performance for a campaign. Shows which languages
 * had the best ROAS/CPA and which received the most budget.
 */
function getLanguageAttribution(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT * FROM language_performance_attribution
     WHERE meta_campaign_id = ? AND date_since = ? AND date_until = ?
     ORDER BY spend DESC`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  if (rows.length === 0) {
    return {
      date_range: dateRange,
      languages: [],
      insight: null,
      note: 'No language attribution data available for this campaign/period.',
    };
  }

  return {
    date_range: dateRange,
    languages: rows,
    insight: buildInsight(rows, { costKey: 'cpa', labelKey: 'locale_label' }),
    note: 'Language targeting performance (which languages you chose to reach). Not language detection (user browser language) -- that would require a different Meta Insights breakdown.',
  };
}

module.exports = {
  syncAccountLanguageAttribution,
  getLanguageAttribution,
  getLocaleLabel,
};
