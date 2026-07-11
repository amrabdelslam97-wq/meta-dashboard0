/**
 * Messaging Destination Analytics — Executive Marketing Analytics Layer (Phase 17)
 * Extended with Destination Attribution + Platform Comparison — Attribution &
 * Customer Journey Intelligence (Steps 2 + 7).
 *
 * Groups already-synced/already-persisted data by destination -- reuses
 * creativeAnalytics' persisted snapshots (which already carry
 * ads.destination_type, a real Meta Ad field added in schema.phase20.js,
 * fetched by the SAME fetchAds() call syncService.js already makes -- zero
 * new Meta API calls, zero new sync mechanism). Read-only: never calls Meta.
 *
 * destination_type is NOT messaging-specific despite this file's original
 * name -- it's Meta's general-purpose "where does this ad drive traffic"
 * field (real observed values include MESSENGER, WHATSAPP, INSTAGRAM_DIRECT,
 * WEBSITE, APP, ON_AD, and PHONE_CALL where a call-focused campaign uses it),
 * which is exactly what Step 2's "Destination Attribution" needs across
 * every objective, not just messaging ones. getDestinationAttribution()
 * below is the general-purpose superset; getMessagingDestinationAnalytics()
 * is untouched for backward compatibility with its existing callers.
 */

const db = require('../db/database');
const { defaultRange } = require('./dateRangeHelper');
const { buildInsight } = require('./analyticsInsight');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * @param {string} metaCampaignId
 * @param {{since:string, until:string}} [dateRange]
 */
function getMessagingDestinationAnalytics(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT
       COALESCE(destination_type, 'UNKNOWN') as destination_type,
       SUM(spend) as spend,
       SUM(results) as results,
       AVG(ctr) as ctr,
       AVG(cpm) as cpm
     FROM creative_analytics
     WHERE meta_campaign_id = ? AND date_since = ? AND date_until = ? AND destination_type IS NOT NULL
     GROUP BY COALESCE(destination_type, 'UNKNOWN')
     ORDER BY spend DESC`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  const withCost = rows.map(r => ({
    ...r,
    cost_per_conversation: r.results > 0 ? Math.round((r.spend / r.results) * 100) / 100 : null,
  }));

  if (withCost.length === 0) {
    return {
      date_range: dateRange,
      destinations: [],
      note: 'No ads with a messaging destination_type were found for this campaign/period -- either this is not a messaging-objective campaign, or it has not been synced/analyzed yet.',
      insight: buildInsight([], { labelKey: 'destination_type' }),
    };
  }

  return {
    date_range: dateRange,
    destinations: withCost,
    insight: buildInsight(withCost, { costKey: 'cost_per_conversation', labelKey: 'destination_type' }),
  };
}

// ─────────────────────────────────────────────
// Step 2 — Destination Attribution (Spend/Results/ROAS/CTR/Conversion Rate/
// Cost per Result/Revenue/Contribution %, every destination_type value).
// ─────────────────────────────────────────────

/**
 * @param {string} metaCampaignId
 * @param {{since:string, until:string}} [dateRange]
 */
function getDestinationAttribution(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT
       COALESCE(destination_type, 'UNKNOWN') as destination_type,
       SUM(spend) as spend,
       SUM(results) as results,
       AVG(ctr) as ctr,
       AVG(conversion_rate) as conversion_rate,
       -- revenue reconstructed from each ad's own spend*roas (its real
       -- purchase_value, per metricsFetcher.js), summed, THEN divided back
       -- by total spend for a correctly weighted group ROAS -- averaging
       -- per-ad ROAS ratios directly would be mathematically wrong (it
       -- would weight a $10-spend ad's ROAS equally with a $10,000 one).
       SUM(spend * COALESCE(roas, 0)) as revenue
     FROM creative_analytics
     WHERE meta_campaign_id = ? AND date_since = ? AND date_until = ? AND destination_type IS NOT NULL
     GROUP BY COALESCE(destination_type, 'UNKNOWN')
     ORDER BY spend DESC`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);

  const enriched = rows.map(r => ({
    destination_type: r.destination_type,
    spend: round(r.spend),
    results: r.results,
    ctr: round(r.ctr, 4),
    conversion_rate: round(r.conversion_rate),
    cost_per_result: r.results > 0 ? round(r.spend / r.results) : null,
    revenue: round(r.revenue),
    roas: r.spend > 0 && r.revenue > 0 ? round(r.revenue / r.spend) : null,
    contribution_pct: totalSpend > 0 ? round((r.spend / totalSpend) * 100, 1) : 0,
  }));

  if (enriched.length === 0) {
    return {
      date_range: dateRange,
      destinations: [],
      note: 'No ads with a destination_type were found for this campaign/period -- either creative analytics has not synced yet, or Meta did not return a destination_type for this objective.',
      insight: buildInsight([], { labelKey: 'destination_type' }),
    };
  }

  return {
    date_range: dateRange,
    destinations: enriched,
    insight: buildInsight(enriched, { costKey: 'cost_per_result', labelKey: 'destination_type' }),
  };
}

// ─────────────────────────────────────────────
// Step 7 — Platform Comparison. A presentation-layer synthesis over
// getDestinationAttribution()'s own data -- never a second data source or
// ranking implementation.
// ─────────────────────────────────────────────

/**
 * @param {string} metaCampaignId
 * @param {{since:string, until:string}} [dateRange]
 */
function comparePlatforms(metaCampaignId, dateRange = defaultRange()) {
  const { destinations, date_range, note } = getDestinationAttribution(metaCampaignId, dateRange);
  if (destinations.length === 0) {
    return { date_range, platforms: [], winner: null, note };
  }

  // Ranked by cost efficiency (cost_per_result, lower is better) among
  // destinations with a real result count -- a destination with zero
  // results has nothing to rank on cost, so it's listed but never picked
  // as winner.
  const ranked = [...destinations].sort((a, b) => {
    if (a.cost_per_result == null) return 1;
    if (b.cost_per_result == null) return -1;
    return a.cost_per_result - b.cost_per_result;
  });
  const winner = ranked.find(d => d.cost_per_result != null) || null;

  return {
    date_range,
    platforms: destinations,
    winner: winner ? { destination_type: winner.destination_type, cost_per_result: winner.cost_per_result, roas: winner.roas, spend: winner.spend } : null,
  };
}

module.exports = { getMessagingDestinationAnalytics, getDestinationAttribution, comparePlatforms };
