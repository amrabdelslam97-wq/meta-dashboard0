/**
 * Analytics Engine — Executive Marketing Analytics Layer (Phase 17)
 *
 * Audience / Geographic / Placement / Device analytics. Reuses the existing
 * architecture end to end -- no new Meta API surface, no new cache
 * mechanism, no new scheduler:
 *   - Fetching:  breakdownsFetcher.js's fetchBreakdown() (Phase 4, extended
 *                Phase 17 with placement/device dimensions) -- itself built
 *                on metaApiClient.metaGet(), which already retries/backs off
 *                on Meta rate limits.
 *   - Caching:   breakdownsFetcher already caches the raw per-call response
 *                via cacheService's existing 'breakdown' TTL.
 *   - Sync:      driven by smartSyncEngine.js's new 'analytics' tier (Task 9
 *                of this phase), which reuses the exact same due-check/
 *                checkpoint/rate-limit-cooldown machinery every other tier
 *                (insights/campaigns/adsets/ads/creatives/metadata) already
 *                uses -- see smartSyncEngine.js's runAnalyticsTier().
 *   - Storage:   analytics_breakdown_history (schema.phase19.js) -- durable,
 *                queryable history, so reads never need a live Meta call.
 *
 * Coverage note (never fabricate what Meta doesn't expose): Meta's Insights
 * `breakdowns` param has no city/zip/district/radius-targeting dimension and
 * no "audience type" (custom/lookalike/broad/Advantage+) or language
 * dimension -- those aren't real Insights breakdowns, so they are not
 * implemented as one here. What IS real and implemented:
 *   Audience:    age, gender (both derived from ONE combined age+gender
 *                Meta call -- see deriveSingleDimension() below -- so
 *                Audience Analytics costs exactly 1 Meta call per period,
 *                not 2)
 *   Geographic:  country, region (2 Meta calls per period; dma omitted by
 *                default -- US-only, most accounts get zero rows for it)
 *   Placement:   publisher_platform × platform_position combined (1 Meta
 *                call per period covers every Facebook/Instagram/Messenger/
 *                Audience Network × Feed/Stories/Reels/etc. combination
 *                Meta actually reports)
 *   Device:      impression_device (1 Meta call per period)
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { fetchBreakdown } = require('./breakdownsFetcher');
const { decryptToken } = require('./tokenCrypto');
const { priorPeriod, defaultRange } = require('./dateRangeHelper');
const { buildInsight } = require('./analyticsInsight');
const { isRateLimitError } = require('./metaApiClient');

// Per-cycle campaign cap: an account with dozens of active campaigns would
// otherwise generate hundreds of Meta calls in a single analytics cycle.
// Oldest-analytics-first ordering (see accountsNeedingAnalytics query below)
// guarantees every campaign eventually gets covered across cycles instead of
// the same few always winning -- the same fairness approach
// autoSyncScheduler.js already uses for accounts.
const MAX_CAMPAIGNS_PER_CYCLE = 10;

const DOMAIN_META_BREAKDOWNS = {
  // audience's 'age' and 'gender' entries are DERIVED client-side from one
  // combined 'age_gender' Meta call -- see syncCampaignAnalytics().
  // 'dma' added for Attribution & Customer Journey Intelligence's
  // Geographic Attribution (Step 8) -- US-only, most accounts get zero rows,
  // but it's a real Meta breakdown already fully supported end-to-end
  // (breakdownsFetcher.VALID_BREAKDOWNS), so it's honest to include rather
  // than silently cap geographic depth at country/region.
  geographic: ['country', 'region', 'dma'],
  placement: ['placement'],
  device: ['impression_device', 'device_platform'],
};

function nowIso() { return new Date().toISOString(); }

/**
 * Roll a combined age_gender row set up into single-dimension (age-only or
 * gender-only) rows by summing volume metrics and re-deriving rate/cost
 * metrics from the summed totals -- real data, just re-aggregated, not a
 * second Meta call.
 */
function deriveSingleDimension(ageGenderRows, field) {
  const groups = new Map();
  for (const row of ageGenderRows) {
    // dimension_value looks like "25-34 / female" (buildDimensionValue's
    // ' / ' join order matches BREAKDOWN_PARAM_MAP['age_gender'] = 'age,gender').
    const [age, gender] = String(row.dimension_value).split(' / ');
    const key = field === 'age' ? (age || 'unknown') : (gender || 'unknown');
    if (!groups.has(key)) {
      groups.set(key, { dimension: field, dimension_value: key, spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0 });
    }
    const g = groups.get(key);
    g.spend += row.spend || 0;
    g.impressions += row.impressions || 0;
    g.reach += row.reach || 0; // approximate (reach isn't strictly additive across overlapping segments, but no better real source exists without a second call)
    g.clicks += row.clicks || 0;
    g.results += row.results || 0;
  }
  return [...groups.values()].map(g => ({
    ...g,
    ctr: g.impressions > 0 ? Math.round((g.clicks / g.impressions) * 100 * 10000) / 10000 : 0,
    cpm: g.impressions > 0 ? Math.round((g.spend / g.impressions) * 1000 * 100) / 100 : 0,
    cpc: g.clicks > 0 ? Math.round((g.spend / g.clicks) * 100) / 100 : 0,
    frequency: g.reach > 0 ? Math.round((g.impressions / g.reach) * 100) / 100 : 0,
    cost_per_result: g.results > 0 ? Math.round((g.spend / g.results) * 100) / 100 : null,
  })).sort((a, b) => b.spend - a.spend);
}

function persistBreakdownRows(tx, adAccountId, metaCampaignId, breakdownType, rows, dateRange) {
  const calculatedAt = nowIso();
  for (const row of rows) {
    tx.run(
      `INSERT INTO analytics_breakdown_history (
         id, ad_account_id, entity_type, entity_meta_id, breakdown_type, breakdown_value,
         date_since, date_until, spend, impressions, reach, clicks, ctr, cpm, cpc, frequency,
         results, cost_per_result, actions_json, calculated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(ad_account_id, entity_meta_id, breakdown_type, breakdown_value, date_since, date_until)
       DO UPDATE SET
         spend = excluded.spend, impressions = excluded.impressions, reach = excluded.reach,
         clicks = excluded.clicks, ctr = excluded.ctr, cpm = excluded.cpm, cpc = excluded.cpc,
         frequency = excluded.frequency, results = excluded.results,
         cost_per_result = excluded.cost_per_result, actions_json = excluded.actions_json,
         calculated_at = excluded.calculated_at`,
      [
        uuidv4(), adAccountId, 'campaign', metaCampaignId, breakdownType, row.dimension_value,
        dateRange.since, dateRange.until,
        row.spend ?? 0, row.impressions ?? 0, row.reach ?? 0, row.clicks ?? 0,
        row.ctr ?? 0, row.cpm ?? 0, row.cpc ?? 0, row.frequency ?? 0,
        row.results ?? null, row.cost_per_result ?? row.cpr ?? null,
        JSON.stringify({ roas: row.roas ?? null, leads: row.leads ?? null, purchases: row.purchases ?? null }),
        calculatedAt,
      ]
    );
  }
}

/**
 * Fetch + persist every analytics domain for ONE campaign, for ONE date
 * range (current or prior period -- caller decides which, same "fetch both
 * so comparison never needs a live call later" pattern metricsFetcher.js
 * already uses for campaign metrics).
 *
 * @returns {{apiCalls: number, breakdownsSynced: number, breakdownsFailed: number, errors: object[]}}
 */
async function syncCampaignAnalyticsForRange(adAccountId, metaCampaignId, accessToken, dateRange) {
  const summary = { apiCalls: 0, breakdownsSynced: 0, breakdownsFailed: 0, errors: [] };

  // Audience: one combined call covers both age and gender (see module header).
  try {
    summary.apiCalls++;
    const ageGender = await fetchBreakdown(metaCampaignId, accessToken, dateRange.since, dateRange.until, 'age_gender');
    db.transaction(tx => {
      persistBreakdownRows(tx, adAccountId, metaCampaignId, 'age_gender', ageGender.data, dateRange);
      persistBreakdownRows(tx, adAccountId, metaCampaignId, 'age', deriveSingleDimension(ageGender.data, 'age'), dateRange);
      persistBreakdownRows(tx, adAccountId, metaCampaignId, 'gender', deriveSingleDimension(ageGender.data, 'gender'), dateRange);
    });
    summary.breakdownsSynced += 3; // age_gender + derived age + derived gender
  } catch (err) {
    summary.breakdownsFailed++;
    summary.errors.push({ breakdown: 'age_gender', message: err.message });
    if (isRateLimitError(err)) throw err; // stop this account's cycle immediately, same contract as smartSyncEngine's other tiers
  }

  for (const [domain, breakdownTypes] of Object.entries(DOMAIN_META_BREAKDOWNS)) {
    for (const breakdownType of breakdownTypes) {
      try {
        summary.apiCalls++;
        const result = await fetchBreakdown(metaCampaignId, accessToken, dateRange.since, dateRange.until, breakdownType);
        db.transaction(tx => persistBreakdownRows(tx, adAccountId, metaCampaignId, breakdownType, result.data, dateRange));
        summary.breakdownsSynced++;
      } catch (err) {
        summary.breakdownsFailed++;
        summary.errors.push({ breakdown: breakdownType, domain, message: err.message });
        if (isRateLimitError(err)) throw err;
      }
    }
  }

  return summary;
}

/**
 * Sync analytics for one account: current + prior period, for up to
 * MAX_CAMPAIGNS_PER_CYCLE active campaigns (oldest-analytics-first, so
 * every campaign is eventually covered across cycles).
 */
async function syncAccountAnalytics(account, dateRange = defaultRange()) {
  const accessToken = decryptToken(account.access_token_encrypted);
  const prior = priorPeriod(dateRange.since, dateRange.until);

  const campaigns = db.all(
    `SELECT c.meta_campaign_id,
            (SELECT MAX(calculated_at) FROM analytics_breakdown_history h WHERE h.entity_meta_id = c.meta_campaign_id) as last_analytics_at
     FROM campaigns c
     WHERE c.ad_account_id = ? AND c.status = 'active'
     ORDER BY last_analytics_at IS NOT NULL, last_analytics_at ASC
     LIMIT ?`,
    [account.id, MAX_CAMPAIGNS_PER_CYCLE]
  );

  const overall = { campaignsProcessed: 0, apiCalls: 0, breakdownsSynced: 0, breakdownsFailed: 0, errors: [] };

  for (const campaign of campaigns) {
    try {
      const current = await syncCampaignAnalyticsForRange(account.id, campaign.meta_campaign_id, accessToken, dateRange);
      const previous = await syncCampaignAnalyticsForRange(account.id, campaign.meta_campaign_id, accessToken, prior);
      overall.campaignsProcessed++;
      overall.apiCalls += current.apiCalls + previous.apiCalls;
      overall.breakdownsSynced += current.breakdownsSynced + previous.breakdownsSynced;
      overall.breakdownsFailed += current.breakdownsFailed + previous.breakdownsFailed;
      overall.errors.push(...current.errors, ...previous.errors);
    } catch (err) {
      overall.errors.push({ campaign: campaign.meta_campaign_id, message: err.message });
      if (isRateLimitError(err)) throw err; // let the scheduler's cooldown handle the whole account
    }
  }

  return overall;
}

// ─────────────────────────────────────────────
// Read side — NEVER calls Meta; reads only what's already been synced, so
// Dashboard reads stay fast regardless of how heavy the underlying
// aggregation is (heavy work already happened in the background sync).
// ─────────────────────────────────────────────

/**
 * @param {string} metaCampaignId
 * @param {string} breakdownType - one of the types persisted above
 * @param {{since:string, until:string}} [dateRange]
 * @returns {{ current: object[], previous: object[], date_range, prior_range, insight }}
 */
function getBreakdownAnalytics(metaCampaignId, breakdownType, dateRange = defaultRange()) {
  const prior = priorPeriod(dateRange.since, dateRange.until);

  const current = db.all(
    `SELECT * FROM analytics_breakdown_history
     WHERE entity_meta_id = ? AND breakdown_type = ? AND date_since = ? AND date_until = ?
     ORDER BY spend DESC`,
    [metaCampaignId, breakdownType, dateRange.since, dateRange.until]
  );
  const previous = db.all(
    `SELECT * FROM analytics_breakdown_history
     WHERE entity_meta_id = ? AND breakdown_type = ? AND date_since = ? AND date_until = ?
     ORDER BY spend DESC`,
    [metaCampaignId, breakdownType, prior.since, prior.until]
  );

  const previousByValue = new Map(previous.map(r => [r.breakdown_value, r]));
  const withComparison = current.map(row => {
    const prev = previousByValue.get(row.breakdown_value);
    return {
      ...row,
      previous: prev ? { spend: prev.spend, results: prev.results, cost_per_result: prev.cost_per_result } : null,
      spend_delta_pct: prev && prev.spend > 0 ? Math.round(((row.spend - prev.spend) / prev.spend) * 1000) / 10 : null,
    };
  });

  return {
    breakdown_type: breakdownType,
    date_range: dateRange,
    prior_range: { since: prior.since, until: prior.until },
    current: withComparison,
    previous,
    insight: buildInsight(current, { costKey: 'cost_per_result', labelKey: 'breakdown_value' }),
  };
}

module.exports = {
  MAX_CAMPAIGNS_PER_CYCLE,
  syncCampaignAnalyticsForRange,
  syncAccountAnalytics,
  getBreakdownAnalytics,
  deriveSingleDimension,
};
