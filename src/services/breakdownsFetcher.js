/**
 * Breakdowns Fetcher — Phase 4, extended Phase 17 (Executive Marketing
 * Analytics Layer) with Placement/Device dimensions.
 *
 * Fetches Meta Insights breakdown data (age, gender, region, placement,
 * device, ...). Lazy-loaded only when the Breakdowns tab (or the new
 * Analytics module) needs it. All responses are cached for 10 minutes
 * (cacheService's existing 'breakdown' TTL -- no new cache mechanism).
 *
 * Supported single-field breakdowns (Meta's real, documented Insights
 * `breakdowns` values -- never invented):
 *   age                → 18-24, 25-34, 35-44, 45-54, 55-64, 65+
 *   gender             → male, female, unknown
 *   region             → state/governorate-level region name
 *   country            → ISO country code
 *   comscore_market    → US comScore market (replaces the deprecated `dma`
 *                        breakdown -- Meta's Insights API now rejects `dma`
 *                        outright with "(#100) dma breakdown is no longer
 *                        supported; ... use comscore_market breakdown",
 *                        confirmed via a real production error response)
 *   publisher_platform → facebook, instagram, messenger, audience_network
 *   platform_position  → feed, story, reels, video_feed, marketplace,
 *                         instream_video, right_hand_column, search, ... --
 *                         Meta's own placement-position vocabulary; combined
 *                         with publisher_platform (below) this is what
 *                         distinguishes "Facebook Feed" from "Instagram Reels".
 *   impression_device  → mobile_app, mobile_web, desktop, tablet, ...
 *   device_platform    → mobile, desktop, tablet (coarser than impression_device)
 *
 * Supported multi-field breakdowns (Meta's `breakdowns` param accepts a
 * comma-separated list and returns one combined row per unique
 * combination -- not two separate single-field calls):
 *   age_gender → breakdowns=age,gender (Audience Analytics' combined view)
 *   placement  → breakdowns=publisher_platform,platform_position (Placement
 *                Analytics' full granularity: platform × position)
 *
 * There is no Meta Insights breakdown for city/zip/district/radius-targeting
 * or "audience type" (custom/lookalike/broad/Advantage+) or language -- Meta
 * does not expose performance sliced by those dimensions via this API.
 * Deliberately not faked; see analyticsEngine.js's header comment for how
 * those requirements are honestly covered from real, available fields
 * instead (ad set targeting metadata, not a fabricated breakdown).
 */

const { metaGet }   = require('./metaApiClient');
const cache         = require('./cacheService');
const { normalizeRow } = require('./metricsFetcher');

// action_values/purchase_roas -- Attribution & Customer Journey Intelligence
// (Placement/Geo/Device Attribution, Steps 3/8/10): the exact same real
// Meta fields metricsFetcher.normalizeRow() already knows how to extract
// ROAS/purchase_value from (fetchCampaignMetrics/fetchAdMetrics already
// request them) -- added here so breakdown rows carry ROAS too, not a new
// extraction shape. normalizeRow() is dimension-agnostic, so this is a
// zero-new-call, zero-new-parsing-logic addition.
const BREAKDOWN_FIELDS = [
  'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpm', 'cpc', 'frequency',
  'actions', 'cost_per_action_type', 'action_values', 'purchase_roas',
].join(',');

// Maps a public breakdown name to the real Meta `breakdowns` param value(s)
// -- single-field breakdowns map to themselves; multi-field aliases map to
// Meta's actual comma-separated combination.
const BREAKDOWN_PARAM_MAP = {
  age: 'age',
  gender: 'gender',
  region: 'region',
  country: 'country',
  comscore_market: 'comscore_market',
  publisher_platform: 'publisher_platform',
  platform_position: 'platform_position',
  impression_device: 'impression_device',
  device_platform: 'device_platform',
  age_gender: 'age,gender',
  placement: 'publisher_platform,platform_position',
};

const VALID_BREAKDOWNS = Object.keys(BREAKDOWN_PARAM_MAP);

/**
 * Build a single dimension_value label from whichever of Meta's breakdown
 * fields are actually present on a row -- handles both single-field
 * (`{age: '25-34'}`) and multi-field (`{age:'25-34', gender:'female'}`,
 * `{publisher_platform:'facebook', platform_position:'feed'}`) responses.
 */
function buildDimensionValue(d, breakdown) {
  const metaParam = BREAKDOWN_PARAM_MAP[breakdown];
  const fields = metaParam.split(',');
  const parts = fields.map(f => d[f]).filter(v => v !== undefined && v !== null && v !== '');
  return parts.length ? parts.join(' / ') : 'unknown';
}

// ─────────────────────────────────────────────
// Fetch one breakdown dimension (single- or multi-field alias)
// ─────────────────────────────────────────────
async function fetchBreakdown(metaCampaignId, accessToken, since, until, breakdown) {
  if (!VALID_BREAKDOWNS.includes(breakdown)) {
    throw new Error(`Invalid breakdown: ${breakdown}. Valid: ${VALID_BREAKDOWNS.join(', ')}`);
  }

  const cacheKey = cache.keyBreakdown(metaCampaignId, breakdown, since, until);
  const cached   = cache.get(cacheKey);
  if (cached) return { data: cached, from_cache: true };

  const raw = await metaGet(
    `${metaCampaignId}/insights`,
    {
      fields:    BREAKDOWN_FIELDS,
      time_range: JSON.stringify({ since, until }),
      breakdowns: BREAKDOWN_PARAM_MAP[breakdown],
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
      dimension_value: buildDimensionValue(d, breakdown),
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
  VALID_BREAKDOWNS,
};
