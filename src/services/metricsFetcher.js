/**
 * Metrics Fetcher — Phase 4 (replaces Phase 2 version)
 *
 * Fetches real Meta Insights API data for campaigns, ad sets, and ads.
 * Supports: current period, prior period, daily trend, all entity levels.
 * Includes: in-memory cache, delta calculation, action parsing.
 *
 * Intelligence engines receive the same normalized object as before —
 * only the data source changed from mock to real.
 */

const { metaGet }      = require('./metaApiClient');
const cache            = require('./cacheService');
const { priorPeriod, defaultRange } = require('./dateRangeHelper');

// ─────────────────────────────────────────────
// Meta Insights fields — comprehensive set
// ─────────────────────────────────────────────
const CORE_FIELDS = [
  'spend', 'impressions', 'reach', 'clicks',
  'ctr', 'cpm', 'cpc', 'frequency',
  'actions', 'cost_per_action_type',
  'purchase_roas', 'website_purchase_roas',
  'conversion_values',
].join(',');

// ─────────────────────────────────────────────
// Parse Meta actions[] + cost_per_action_type[]
// Maps all known action_types to flat metric keys
// ─────────────────────────────────────────────
function parseActions(actions, costPerAction, conversionValues) {
  const result = {};
  if (!Array.isArray(actions)) return result;

  // Action type → flat metric key mappings
  const ACTION_MAP = {
    // Messaging
    'onsite_conversion.messaging_conversation_started_7d': 'results',
    'onsite_conversion.messaging_first_reply':             'results',
    'onsite_conversion.messaging_conversation_started':    'results',
    // Leads
    'lead':                                   'leads',
    'onsite_conversion.lead_grouped':         'leads',
    'leadgen_grouped':                        'leads',
    // Purchases / Sales
    'purchase':                               'purchases',
    'offsite_conversion.fb_pixel_purchase':   'purchases',
    'omni_purchase':                          'purchases',
    // Traffic
    'link_click':                             'link_clicks',
    'landing_page_view':                      'landing_page_views',
    // General results proxy
    'offsite_conversion':                     'offsite_conversions',
  };

  for (const { action_type, value } of actions) {
    const key = ACTION_MAP[action_type];
    if (key) {
      // Use highest value when multiple action_types map to same key
      const existing = result[key] || 0;
      result[key] = Math.max(existing, parseFloat(value) || 0);
    }
  }

  // Cost per action type → cost metrics
  if (Array.isArray(costPerAction)) {
    const CPA_MAP = {
      'onsite_conversion.messaging_conversation_started_7d': 'cpr',
      'onsite_conversion.messaging_first_reply':             'cpr',
      'onsite_conversion.messaging_conversation_started':    'cpr',
      'lead':                                 'cpl',
      'onsite_conversion.lead_grouped':       'cpl',
      'purchase':                             'cpa',
      'offsite_conversion.fb_pixel_purchase': 'cpa',
      'landing_page_view':                    'cost_per_landing_page_view',
    };
    for (const { action_type, value } of costPerAction) {
      const key = CPA_MAP[action_type];
      if (key && !result[key]) {
        result[key] = parseFloat(value) || 0;
      }
    }
  }

  // Purchase value from conversion_values
  if (Array.isArray(conversionValues)) {
    for (const { action_type, value } of conversionValues) {
      if (['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'].includes(action_type)) {
        result.purchase_value = (result.purchase_value || 0) + (parseFloat(value) || 0);
      }
    }
  }

  return result;
}

// ─────────────────────────────────────────────
// Normalize a single Meta insights data row
// ─────────────────────────────────────────────
function normalizeRow(d) {
  if (!d) return null;

  const base = {
    spend:       parseFloat(d.spend       || 0),
    impressions: parseFloat(d.impressions || 0),
    reach:       parseFloat(d.reach       || 0),
    clicks:      parseFloat(d.clicks      || 0),
    ctr:         parseFloat(d.ctr         || 0),
    cpm:         parseFloat(d.cpm         || 0),
    cpc:         parseFloat(d.cpc         || 0),
    frequency:   parseFloat(d.frequency   || 0),
    date_start:  d.date_start || null,
    date_stop:   d.date_stop  || null,
  };

  // ROAS from Meta's purchase_roas array
  const roasSource = d.purchase_roas || d.website_purchase_roas;
  if (Array.isArray(roasSource) && roasSource[0]) {
    base.roas = parseFloat(roasSource[0].value) || null;
  }

  // Actions → objective-specific metrics
  const actionMetrics = parseActions(d.actions, d.cost_per_action_type, d.conversion_values);
  Object.assign(base, actionMetrics);

  // Derive missing cost metrics from volume + spend
  if (!base.cpr && base.results   > 0 && base.spend > 0) base.cpr = base.spend / base.results;
  if (!base.cpl && base.leads     > 0 && base.spend > 0) base.cpl = base.spend / base.leads;
  if (!base.cpa && base.purchases > 0 && base.spend > 0) base.cpa = base.spend / base.purchases;

  // Derive ROAS from purchase_value / spend when Meta doesn't provide it
  if (!base.roas && base.purchase_value > 0 && base.spend > 0) {
    base.roas = base.purchase_value / base.spend;
  }

  // Landing page view rate (%)
  if (base.landing_page_views > 0 && base.clicks > 0) {
    base.landing_page_view_rate = (base.landing_page_views / base.clicks) * 100;
  }

  return base;
}

// ─────────────────────────────────────────────
// Normalize full Meta insights API response
// Returns single aggregated metrics object
// ─────────────────────────────────────────────
function normalizeInsights(raw) {
  if (!raw?.data?.length) return null;
  return normalizeRow(raw.data[0]);
}

// ─────────────────────────────────────────────
// Normalize daily trend response
// Returns array of { date, ...metrics }
// ─────────────────────────────────────────────
function normalizeTrend(raw) {
  if (!raw?.data?.length) return [];
  return raw.data.map(d => normalizeRow(d)).filter(Boolean);
}

// ─────────────────────────────────────────────
// Calculate deltas between current and prior period
// ─────────────────────────────────────────────
const NUMERIC_METRICS = [
  'spend','impressions','reach','clicks','ctr','cpm','cpc','frequency',
  'results','leads','purchases','purchase_value','roas',
  'cpr','cpl','cpa','link_clicks','landing_page_views',
  'cost_per_landing_page_view',
];

function computeDeltas(current, prior) {
  if (!current || !prior) return {};
  const deltas = {};

  for (const key of NUMERIC_METRICS) {
    const cur = current[key];
    const prr = prior[key];
    if (cur == null || prr == null) continue;

    const delta_abs = Math.round((cur - prr) * 100) / 100;
    const delta_pct = prr !== 0
      ? Math.round(((cur - prr) / Math.abs(prr)) * 1000) / 10   // 1 decimal
      : (cur > 0 ? 100 : 0);

    deltas[key] = { delta_abs, delta_pct };
  }
  return deltas;
}

// ─────────────────────────────────────────────
// Core fetch helper: one Meta Insights API call
// ─────────────────────────────────────────────
async function fetchInsights(entityId, accessToken, since, until, extraParams = {}) {
  return metaGet(
    `${entityId}/insights`,
    {
      fields:     CORE_FIELDS,
      time_range: JSON.stringify({ since, until }),
      ...extraParams,
    },
    accessToken
  );
}

// ─────────────────────────────────────────────
// CAMPAIGN METRICS
// ─────────────────────────────────────────────
async function fetchCampaignMetrics(metaCampaignId, accessToken, dateRange) {
  const range = dateRange || defaultRange();
  const { since, until } = range;
  const prior  = priorPeriod(since, until);
  const fetchedAt = new Date().toISOString();

  // ── Current period ──
  const currentKey = cache.keyInsights(metaCampaignId, since, until);
  let currentMetrics = cache.get(currentKey);

  if (!currentMetrics) {
    try {
      const raw = await fetchInsights(metaCampaignId, accessToken, since, until);
      currentMetrics = normalizeInsights(raw);
      if (currentMetrics) cache.set(currentKey, currentMetrics, 'current');
    } catch (err) {
      console.warn(`[Metrics] Current period fetch failed for ${metaCampaignId}:`, err.message);
      currentMetrics = null;
    }
  }

  // ── Prior period ──
  const priorKey = cache.keyPrior(metaCampaignId, prior.since, prior.until);
  let priorMetrics = cache.get(priorKey);

  if (!priorMetrics) {
    try {
      const raw = await fetchInsights(metaCampaignId, accessToken, prior.since, prior.until);
      priorMetrics = normalizeInsights(raw);
      if (priorMetrics) cache.set(priorKey, priorMetrics, 'prior'); // 24h TTL
    } catch (err) {
      console.warn(`[Metrics] Prior period fetch failed for ${metaCampaignId}:`, err.message);
      priorMetrics = null;
    }
  }

  const deltas = computeDeltas(currentMetrics, priorMetrics);

  return {
    current:     currentMetrics,
    prior:       priorMetrics,
    deltas,
    date_range:  range,
    prior_range: { since: prior.since, until: prior.until },
    fetched_at:  fetchedAt,
    source:      'meta_api',
  };
}

// ─────────────────────────────────────────────
// AD SET METRICS (for campaign detail breakdown)
// ─────────────────────────────────────────────
async function fetchAdSetMetrics(metaCampaignId, accessToken, since, until) {
  const key = `${metaCampaignId}:adsets:${since}:${until}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // AUDIT LOG — full outgoing request details
  console.log('[MetricsFetcher][AdSet] ── Outgoing Meta Request ──');
  console.log('[MetricsFetcher][AdSet] Campaign ID:', metaCampaignId);
  console.log('[MetricsFetcher][AdSet] Level: adset');
  console.log('[MetricsFetcher][AdSet] Date range:', since, '->', until);
  console.log('[MetricsFetcher][AdSet] Token length:', accessToken?.length ?? 0);
  console.log('[MetricsFetcher][AdSet] Fields:', CORE_FIELDS);

  let raw;
  try {
    raw = await metaGet(
      `${metaCampaignId}/insights`,
      {
        fields:     CORE_FIELDS,
        time_range: JSON.stringify({ since, until }),
        level:      'adset',
      },
      accessToken
    );
  } catch (err) {
    // Log the full error — never swallow
    console.error('[MetricsFetcher][AdSet] ── Meta API ERROR ──');
    console.error('[MetricsFetcher][AdSet] Message:', err.message);
    console.error('[MetricsFetcher][AdSet] Code:', err.code);
    console.error('[MetricsFetcher][AdSet] Type:', err.type);
    console.error('[MetricsFetcher][AdSet] HTTP Status:', err.httpStatus);
    return [];
  }

  // Log the raw response before any parsing
  console.log('[MetricsFetcher][AdSet] ── Raw Meta Response ──');
  console.log('[MetricsFetcher][AdSet] data.length:', raw?.data?.length ?? 0);
  if (!raw?.data?.length) {
    console.warn('[MetricsFetcher][AdSet] data[] IS EMPTY — Meta returned no rows for this campaign/period');
    console.log('[MetricsFetcher][AdSet] Full raw response:', JSON.stringify(raw));
  }

  const adsets = (raw?.data || []).map(d => {
    // Mapping audit: log adset_id field presence
    if (!d.adset_id) {
      console.warn('[MetricsFetcher][AdSet] WARNING: row missing adset_id:', JSON.stringify(d));
    }
    return {
      meta_adset_id: d.adset_id,
      name:          d.adset_name,
      ...normalizeRow(d),
    };
  });

  console.log('[MetricsFetcher][AdSet] Parsed', adsets.length, 'ad set rows');
  cache.set(key, adsets, 'current');
  return adsets;
}

// ─────────────────────────────────────────────
// AD METRICS
// ─────────────────────────────────────────────
async function fetchAdMetrics(metaCampaignId, accessToken, since, until) {
  const key = `${metaCampaignId}:ads:${since}:${until}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // AUDIT LOG — full outgoing request details
  console.log('[MetricsFetcher][Ad] ── Outgoing Meta Request ──');
  console.log('[MetricsFetcher][Ad] Campaign ID:', metaCampaignId);
  console.log('[MetricsFetcher][Ad] Level: ad');
  console.log('[MetricsFetcher][Ad] Date range:', since, '->', until);
  console.log('[MetricsFetcher][Ad] Token length:', accessToken?.length ?? 0);
  console.log('[MetricsFetcher][Ad] Fields:', CORE_FIELDS);

  let raw;
  try {
    raw = await metaGet(
      `${metaCampaignId}/insights`,
      {
        fields:     CORE_FIELDS,
        time_range: JSON.stringify({ since, until }),
        level:      'ad',
      },
      accessToken
    );
  } catch (err) {
    // Log the full error — never swallow
    console.error('[MetricsFetcher][Ad] ── Meta API ERROR ──');
    console.error('[MetricsFetcher][Ad] Message:', err.message);
    console.error('[MetricsFetcher][Ad] Code:', err.code);
    console.error('[MetricsFetcher][Ad] Type:', err.type);
    console.error('[MetricsFetcher][Ad] HTTP Status:', err.httpStatus);
    return [];
  }

  // Log the raw response before any parsing
  console.log('[MetricsFetcher][Ad] ── Raw Meta Response ──');
  console.log('[MetricsFetcher][Ad] data.length:', raw?.data?.length ?? 0);
  if (!raw?.data?.length) {
    console.warn('[MetricsFetcher][Ad] data[] IS EMPTY — Meta returned no rows for this campaign/period');
    console.log('[MetricsFetcher][Ad] Full raw response:', JSON.stringify(raw));
  }

  const ads = (raw?.data || []).map(d => {
    // Mapping audit: log ad_id field presence
    if (!d.ad_id) {
      console.warn('[MetricsFetcher][Ad] WARNING: row missing ad_id:', JSON.stringify(d));
    }
    return {
      meta_ad_id:    d.ad_id,
      name:          d.ad_name,
      meta_adset_id: d.adset_id,
      ...normalizeRow(d),
    };
  });

  console.log('[MetricsFetcher][Ad] Parsed', ads.length, 'ad rows');
  cache.set(key, ads, 'current');
  return ads;
}

// ─────────────────────────────────────────────
// DAILY TREND DATA (time_increment=1)
// ─────────────────────────────────────────────
async function fetchTrendData(metaCampaignId, accessToken, since, until) {
  const key = cache.keyTrend(metaCampaignId, since, until);
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const raw = await metaGet(
      `${metaCampaignId}/insights`,
      {
        fields:         CORE_FIELDS,
        time_range:     JSON.stringify({ since, until }),
        time_increment: 1,
      },
      accessToken
    );

    const trend = normalizeTrend(raw);
    cache.set(key, trend, 'trend');
    return trend;
  } catch (err) {
    console.warn(`[Metrics] Trend fetch failed for ${metaCampaignId}:`, err.message);
    return [];
  }
}

module.exports = {
  fetchCampaignMetrics,
  fetchAdSetMetrics,
  fetchAdMetrics,
  fetchTrendData,
  normalizeInsights,
  normalizeTrend,
  normalizeRow,
  computeDeltas,
  defaultDateRange: defaultRange,
  getPriorPeriod: priorPeriod,
};
