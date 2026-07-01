/**
 * Breakdowns Fetcher — Phase 4
 *
 * Fetches Meta Insights breakdown data (age, gender, region).
 * Lazy-loaded only when the Breakdowns tab is opened.
 * All responses are cached for 10 minutes.
 *
 * Supported breakdowns:
 *   age     → age groups: 18-24, 25-34, 35-44, 45-54, 55-64, 65+
 *   gender  → male, female, unknown
 *   region  → country, region/governorate, or DMA
 */

const { metaGet }   = require('./metaApiClient');
const cache         = require('./cacheService');
const { normalizeRow } = require('./metricsFetcher');

const BREAKDOWN_FIELDS = [
  'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpm', 'cpc', 'frequency',
  'actions', 'cost_per_action_type',
].join(',');

// ─────────────────────────────────────────────
// Fetch one breakdown dimension
// ─────────────────────────────────────────────
async function fetchBreakdown(metaCampaignId, accessToken, since, until, breakdown) {
  const validBreakdowns = ['age', 'gender', 'region', 'country', 'dma'];
  if (!validBreakdowns.includes(breakdown)) {
    throw new Error(`Invalid breakdown: ${breakdown}. Valid: ${validBreakdowns.join(', ')}`);
  }

  const cacheKey = cache.keyBreakdown(metaCampaignId, breakdown, since, until);
  const cached   = cache.get(cacheKey);
  if (cached) return { data: cached, from_cache: true };

  const raw = await metaGet(
    `${metaCampaignId}/insights`,
    {
      fields:    BREAKDOWN_FIELDS,
      time_range: JSON.stringify({ since, until }),
      breakdowns: breakdown,
    },
    accessToken
  );

  const rows = (raw?.data || []).map(d => {
    const metrics = normalizeRow(d);
    // Remove date fields from breakdown rows (not meaningful at aggregate level)
    delete metrics.date_start;
    delete metrics.date_stop;

    return {
      dimension:       breakdown,
      dimension_value: d[breakdown] || d.age || d.gender || d.region || d.country || d.dma || 'unknown',
      ...metrics,
    };
  });

  // Sort by spend descending for default display order
  rows.sort((a, b) => (b.spend || 0) - (a.spend || 0));

  cache.set(cacheKey, rows, 'breakdown');
  return { data: rows, from_cache: false };
}

// ─────────────────────────────────────────────
// Fetch all three breakdowns in parallel
// ─────────────────────────────────────────────
async function fetchAllBreakdowns(metaCampaignId, accessToken, since, until) {
  const [ageResult, genderResult, regionResult] = await Promise.allSettled([
    fetchBreakdown(metaCampaignId, accessToken, since, until, 'age'),
    fetchBreakdown(metaCampaignId, accessToken, since, until, 'gender'),
    fetchBreakdown(metaCampaignId, accessToken, since, until, 'region'),
  ]);

  return {
    age: ageResult.status === 'fulfilled'
      ? ageResult.value
      : { data: [], error: ageResult.reason?.message },

    gender: genderResult.status === 'fulfilled'
      ? genderResult.value
      : { data: [], error: genderResult.reason?.message },

    region: regionResult.status === 'fulfilled'
      ? regionResult.value
      : { data: [], error: regionResult.reason?.message },
  };
}

// ─────────────────────────────────────────────
// Summarize breakdown for display
// Adds percentage of total spend per row
// ─────────────────────────────────────────────
function enrichBreakdown(rows) {
  if (!rows?.length) return rows;
  const totalSpend = rows.reduce((sum, r) => sum + (r.spend || 0), 0);
  return rows.map(r => ({
    ...r,
    spend_pct: totalSpend > 0 ? Math.round((r.spend / totalSpend) * 1000) / 10 : 0,
  }));
}

module.exports = {
  fetchBreakdown,
  fetchAllBreakdowns,
  enrichBreakdown,
};
