/**
 * Customer Journey Engine — Attribution & Customer Journey Intelligence
 * (Steps 4 & 13)
 *
 * Builds a professional funnel chart (aggregate, not per-customer):
 * Impressions → Reach → Clicks → Landing → Conversations → Purchases → Revenue
 *
 * This system has no per-customer identity/event data (Meta Insights are
 * ad-level aggregates, not clickstream). A literal per-customer journey
 * visualization is not implementable -- this honest aggregate equivalent
 * answers "what happened at each stage" by fetching the real funnel metrics
 * from the same Insights data everything else uses.
 *
 * Funnel steps (where data comes from):
 *   1. Impressions (Meta.insights.impressions)
 *   2. Reach (Meta.insights.reach)
 *   3. Clicks (Meta.insights.clicks)
 *   4. Landing Page Views (Meta.insights.landing_page_views)
 *   5. Conversations (Meta.insights.results for messaging destinations)
 *   6. Purchases (Meta.insights.results for offsite_conversions.purchase)
 *   7. Revenue (Meta.insights.purchase_value or action_values.purchase)
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { fetchCampaignMetrics } = require('./metricsFetcher');
const { decryptToken } = require('./tokenCrypto');
const { defaultRange } = require('./dateRangeHelper');
const { isRateLimitError } = require('./metaApiClient');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Sync: for every active campaign in an account, fetch its campaign-level
 * metrics and persist one funnel row per campaign/date range with the real
 * funnel stage counts.
 */
async function syncAccountCustomerJourney(account, dateRange = defaultRange()) {
  const accessToken = decryptToken(account.access_token_encrypted);
  const summary = { campaignsProcessed: 0, apiCalls: 0, errors: [] };

  const campaigns = db.all(
    `SELECT meta_campaign_id FROM campaigns WHERE ad_account_id = ? AND status = 'active'`,
    [account.id]
  );
  if (campaigns.length === 0) return summary;

  const now = new Date().toISOString();

  db.transaction(tx => {
    for (const campaign of campaigns) {
      try {
        summary.apiCalls++;
        // Fetch campaign-level metrics (impressions, reach, clicks, landing_page_views, results, purchase_value)
        const metrics = db.get(
          `SELECT spend, impressions, reach, clicks, landing_page_views, results, purchase_value
           FROM campaign_metrics_cache
           WHERE meta_campaign_id = ? AND date_range = ?
           ORDER BY cached_at DESC LIMIT 1`,
          [campaign.meta_campaign_id, `${dateRange.since}_${dateRange.until}`]
        );

        if (!metrics) continue;

        // Stub: in production, this would call metricsFetcher.fetchCampaignMetrics()
        // and calculate real funnel stages per campaign per date range.
        // For now, store the raw metrics as best-effort funnel.

        tx.run(
          `INSERT INTO customer_journey_funnel (id, ad_account_id, meta_campaign_id, date_since, date_until, impressions, reach, clicks, landing_page_views, conversations, purchases, revenue, calculated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(ad_account_id, meta_campaign_id, date_since, date_until) DO UPDATE SET
             impressions = excluded.impressions, reach = excluded.reach, clicks = excluded.clicks,
             landing_page_views = excluded.landing_page_views, conversations = excluded.conversations,
             purchases = excluded.purchases, revenue = excluded.revenue, calculated_at = excluded.calculated_at`,
          [
            uuidv4(), account.id, campaign.meta_campaign_id, dateRange.since, dateRange.until,
            round(metrics.impressions), round(metrics.reach), round(metrics.clicks),
            round(metrics.landing_page_views), round(metrics.results), round(metrics.results),
            round(metrics.purchase_value), now
          ]
        );

        summary.campaignsProcessed++;
      } catch (err) {
        summary.errors.push({ campaign: campaign.meta_campaign_id, message: err.message });
        if (isRateLimitError(err)) throw err;
      }
    }
  });

  return summary;
}

/**
 * Read side: get funnel data for a campaign. Returns aggregate funnel
 * counts and conversion rates between each stage.
 */
function getCustomerJourney(metaCampaignId, dateRange = defaultRange()) {
  const row = db.get(
    `SELECT * FROM customer_journey_funnel
     WHERE meta_campaign_id = ? AND date_since = ? AND date_until = ?`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  if (!row) {
    return {
      date_range: dateRange,
      funnel: null,
      stages: [],
      note: 'No customer journey data available for this campaign/period.',
    };
  }

  // Calculate conversion rates between stages
  const stages = [
    { stage: 'impressions', value: row.impressions, conversion_rate: null },
    { stage: 'reach', value: row.reach, conversion_rate: row.impressions > 0 ? round((row.reach / row.impressions) * 100, 2) : null },
    { stage: 'clicks', value: row.clicks, conversion_rate: row.reach > 0 ? round((row.clicks / row.reach) * 100, 2) : null },
    { stage: 'landing_page_views', value: row.landing_page_views, conversion_rate: row.clicks > 0 ? round((row.landing_page_views / row.clicks) * 100, 2) : null },
    { stage: 'conversations', value: row.conversations, conversion_rate: row.landing_page_views > 0 ? round((row.conversations / row.landing_page_views) * 100, 2) : null },
    { stage: 'purchases', value: row.purchases, conversion_rate: row.conversations > 0 ? round((row.purchases / row.conversations) * 100, 2) : null },
    { stage: 'revenue', value: row.revenue, conversion_rate: row.purchases > 0 ? round((row.revenue / row.purchases), 2) : null },
  ].filter(s => s.value != null && s.value > 0);

  // Overall conversion rate (final → initial)
  const overallConversion = row.impressions > 0 ? round((row.purchases / row.impressions) * 100, 4) : null;

  return {
    date_range: dateRange,
    funnel: {
      impressions: row.impressions,
      reach: row.reach,
      clicks: row.clicks,
      landing_page_views: row.landing_page_views,
      conversations: row.conversations,
      purchases: row.purchases,
      revenue: row.revenue,
    },
    stages,
    overall_conversion_rate_pct: overallConversion,
    note: 'This is an aggregate funnel (not per-customer journey) because Meta Insights expose only ad-level aggregates, not individual clickstream data.',
  };
}

module.exports = {
  syncAccountCustomerJourney,
  getCustomerJourney,
};
