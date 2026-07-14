/**
 * Placement / Geographic / Device Attribution Engine — Attribution &
 * Customer Journey Intelligence (Steps 3, 8, 10)
 *
 * Thin read-side wrapper over analyticsEngine.getBreakdownAnalytics() --
 * reuses the exact same persisted analytics_breakdown_history rows (no new
 * Meta calls, no new sync mechanism) for the 'placement', 'country',
 * 'region', 'comscore_market', 'impression_device', and 'device_platform'
 * breakdown types, adding the attribution-specific fields these three steps need on
 * top: ROAS (decoded from the row's own actions_json -- see
 * breakdownsFetcher.js's action_values/purchase_roas fields, added
 * alongside this module), Quality Score (a relative cost-efficiency proxy,
 * same methodology budgetDistributionAnalytics.js's efficiency_score
 * already uses, for consistency), Contribution % / Budget % (identical here
 * -- Meta has no per-placement/per-geo/per-device BUDGET concept, budgets
 * are set at campaign/ad-set level, so "Budget %" can only honestly mean
 * "share of this campaign's spend", the same number as Contribution %, not
 * two different metrics), and a deterministic Recommendation.
 *
 * Coverage note (never fabricate what Meta doesn't expose): Geographic
 * Attribution stops at country/region/comscore_market -- Meta's Insights
 * `breakdowns` param has no city/district/neighborhood/zip dimension (confirmed in
 * breakdownsFetcher.js's own header). Placement Attribution covers every
 * publisher_platform × platform_position combination Meta actually reports
 * for this account (Facebook Feed/Stories/Reels, Instagram Feed/Stories/
 * Reels/Explore, Messenger Inbox, Audience Network, Marketplace, Search,
 * etc.) -- exactly what's real, never an invented placement.
 */

const { defaultRange } = require('./dateRangeHelper');
const { getBreakdownAnalytics } = require('./analyticsEngine');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function decodeRoas(row) {
  try {
    const actions = JSON.parse(row.actions_json || '{}');
    return actions.roas ?? null;
  } catch {
    return null;
  }
}

/**
 * Attaches ROAS/quality_score/contribution_pct/budget_pct/recommendation to
 * a set of already-fetched breakdown rows sharing one campaign/date range.
 */
function enrichForAttribution(rows) {
  const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
  const eligibleForAvg = rows.filter(r => (r.spend || 0) > 0 && (r.results || 0) > 0);
  const avgResultsPerSpend = eligibleForAvg.length > 0
    ? eligibleForAvg.reduce((s, r) => s + r.results / r.spend, 0) / eligibleForAvg.length
    : 0;

  return rows.map(r => {
    const roas = decodeRoas(r);
    const contributionPct = totalSpend > 0 ? round((r.spend / totalSpend) * 100, 1) : 0;
    const resultsPerSpend = r.spend > 0 ? r.results / r.spend : 0;
    const qualityScore = avgResultsPerSpend > 0
      ? Math.max(0, Math.min(100, round((resultsPerSpend / avgResultsPerSpend) * 50, 1)))
      : (r.spend > 0 ? 0 : null);

    let recommendation;
    if (qualityScore != null && qualityScore >= 70 && contributionPct < 20) {
      recommendation = 'Scale: strong relative efficiency, currently receiving a small share of spend.';
    } else if (qualityScore != null && qualityScore < 30 && contributionPct >= 15) {
      recommendation = 'Reduce budget: weak relative efficiency for its current spend share.';
    } else if (qualityScore == null) {
      recommendation = 'Not enough spend/results yet for a reliable verdict.';
    } else {
      recommendation = 'Maintain current allocation.';
    }

    return {
      breakdown_type: r.breakdown_type,
      breakdown_value: r.breakdown_value,
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      cpm: r.cpm,
      cpc: r.cpc,
      results: r.results,
      cost_per_result: r.cost_per_result,
      roas,
      quality_score: qualityScore,
      contribution_pct: contributionPct,
      budget_pct: contributionPct,
      recommendation,
    };
  });
}

/** @param {string} metaCampaignId @param {{since,until}} [dateRange] */
function getPlacementAttribution(metaCampaignId, dateRange = defaultRange()) {
  const result = getBreakdownAnalytics(metaCampaignId, 'placement', dateRange);
  return { ...result, current: enrichForAttribution(result.current) };
}

/**
 * @param {string} metaCampaignId
 * @param {string} [level] - 'country'|'region'|'comscore_market', default 'country'
 * @param {{since,until}} [dateRange]
 */
function getGeographicAttribution(metaCampaignId, level = 'country', dateRange = defaultRange()) {
  const validLevels = ['country', 'region', 'comscore_market'];
  const resolvedLevel = validLevels.includes(level) ? level : 'country';
  const result = getBreakdownAnalytics(metaCampaignId, resolvedLevel, dateRange);
  return {
    ...result,
    current: enrichForAttribution(result.current),
    level: resolvedLevel,
    not_available_levels: ['city', 'district', 'neighborhood', 'zip'],
    not_available_reason: 'Meta\'s Ads Insights API exposes no city/district/neighborhood/zip breakdown for any entity grain -- country, region, and comscore_market (US-only) are the deepest real geographic breakdowns it supports.',
  };
}

/**
 * @param {string} metaCampaignId
 * @param {string} [dimension] - 'impression_device'|'device_platform', default 'impression_device'
 * @param {{since,until}} [dateRange]
 */
function getDeviceAttribution(metaCampaignId, dimension = 'impression_device', dateRange = defaultRange()) {
  const resolvedDimension = dimension === 'device_platform' ? 'device_platform' : 'impression_device';
  const result = getBreakdownAnalytics(metaCampaignId, resolvedDimension, dateRange);
  return { ...result, current: enrichForAttribution(result.current) };
}

module.exports = { getPlacementAttribution, getGeographicAttribution, getDeviceAttribution, enrichForAttribution };
