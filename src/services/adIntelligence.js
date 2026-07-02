/**
 * Ad Intelligence — Phase 6B
 *
 * Pure orchestration layer for ad level intelligence.
 * Reuses existing engines 100%. Contains NO scoring logic.
 *
 * The shared health/benchmark/recommendation/alert/trend sequence is
 * delegated to intelligenceOrchestrator.runScoringPipeline() (entityType=
 * 'ad') instead of duplicating it inline -- this file previously had its
 * own copy of the exact same sequence found in intelligenceOrchestrator.js
 * and adSetIntelligence.js.
 */

const db                    = require('../db/database');

const { runScoringPipeline } = require('./intelligenceOrchestrator');
const { fetchAdMetrics, computeDeltas } = require('./metricsFetcher');
const { resolveDateRange, priorPeriod } = require('./dateRangeHelper');
const { decryptToken } = require('./tokenCrypto');
const { fetchAdPreview } = require('./metaApiClient');

// ─────────────────────────────────────────────
// Stable variance index derived from entity ID (Phase 7B)
// ─────────────────────────────────────────────
function stableIndexFromId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % 7;
}

// ─────────────────────────────────────────────
// Load ad + parent campaign from DB
// ─────────────────────────────────────────────
function loadAdWithParent(id) {
  // Accept internal UUID or meta_ad_id
  const ad = db.get(
    `SELECT ad.*, a.access_token_encrypted, a.id as internal_account_id,
             a.meta_account_id, a.account_name, a.currency, a.attribution_window_days
     FROM ads ad
     JOIN ad_accounts a ON ad.ad_account_id = a.id
     WHERE ad.id = ? OR ad.meta_ad_id = ?`,
    [id, id]
  );
  if (!ad) return null;
  ad.access_token_encrypted = decryptToken(ad.access_token_encrypted);

  const campaign = db.get(
    `SELECT id, meta_campaign_id, name, objective, status
     FROM campaigns WHERE id = ?`,
    [ad.campaign_id]
  );

  const adSet = db.get(
    `SELECT id, meta_adset_id, name, optimization_goal FROM ad_sets WHERE id = ?`,
    [ad.ad_set_id]
  );

  return { ad, campaign, adSet };
}

// ─────────────────────────────────────────────
// Mock metrics for development / no Meta token
// ─────────────────────────────────────────────
function getMockAdMetrics(objective, index = 0) {
  const base = {
    spend:       Math.round((200 + index * 80) * 100) / 100,
    impressions: 14000 + index * 3000,
    reach:       7000  + index * 1500,
    clicks:      170   + index * 30,
    ctr:         Math.round((1.2 + index * 0.15) * 100) / 100,
    cpm:         Math.round((14.3 + index * 0.2) * 100) / 100,
    cpc:         Math.round((1.18 + index * 0.12) * 100) / 100,
    frequency:   Math.round((2.0 + index * 0.3) * 100) / 100,
  };
  const extras = {
    messaging: { results: 28 + index * 4, cpr: Math.round((7 + index * 0.5) * 100) / 100 },
    leads:     { leads:   18 + index * 3, cpl: Math.round((11 + index * 0.6) * 100) / 100 },
    sales:     { purchases: 4 + index,    cpa: Math.round((50 + index * 5) * 100) / 100, roas: Math.round((2.2 - index * 0.1) * 100) / 100 },
    traffic:   { link_clicks: 160 + index * 20, landing_page_views: 120 + index * 15 },
    awareness: { reach: 7000 + index * 1500, impressions: 16000 + index * 3000 },
  };
  return { ...base, ...(extras[objective] || {}) };
}

// ─────────────────────────────────────────────
// MAIN: Run intelligence pipeline for one ad
// ─────────────────────────────────────────────
async function runAdIntelligence(adId, options = {}) {
  const { useMock = false, dateRange } = options;

  const loaded = loadAdWithParent(adId);
  if (!loaded) return null;

  const { ad, campaign, adSet } = loaded;
  const adAccountId = ad.internal_account_id;
  const { since, until } = resolveDateRange(dateRange || {});

  // ── Build synthetic entity (same shape the engines expect) ──
  const entity = {
    meta_campaign_id: ad.meta_ad_id,          // used as entity_meta_id in DB
    name:             ad.name,
    objective:        campaign?.objective || 'unknown',
    optimization_goal: adSet?.optimization_goal || null,
  };

  // ── Fetch metrics ──
  let currentMetrics = null;
  let priorMetrics   = null;

  if (useMock) {
    // Use a stable hash of the entity's own meta ID for variance — NOT sibling position.
    // Sibling-position indexing collapsed to idx=0 for any ad that is the only one
    // in its campaign, causing identical mock values across unrelated ads (Phase 7B fix).
    const idx = stableIndexFromId(ad.meta_ad_id);
    currentMetrics = getMockAdMetrics(entity.objective, idx);
    priorMetrics   = getMockAdMetrics(entity.objective, idx + 1);
  } else {
    // Ad preview is fetched once, on-demand, and cached in the ads table --
    // not during bulk sync (Meta's /previews endpoint is a per-ad call and
    // would multiply the request volume of a sync by one call per ad for
    // no benefit, since previews are only useful when someone is actually
    // looking at this specific ad).
    if (!ad.preview_url) {
      try {
        const previewUrl = await fetchAdPreview(ad.meta_ad_id, ad.access_token_encrypted);
        if (previewUrl) {
          db.run('UPDATE ads SET preview_url = ? WHERE id = ?', [previewUrl, ad.id]);
          ad.preview_url = previewUrl;
        }
      } catch (previewErr) {
        console.warn(`[AdIntelligence] Preview fetch failed for ${ad.meta_ad_id}:`, previewErr.message);
      }
    }

    let fetchError = null;
    let metaErrorDetails = null;
    try {
      // fetchAdMetrics calls /{meta_campaign_id}/insights?level=ad
      // Logging is done inside fetchAdMetrics (see metricsFetcher.js)
      const allAdMetrics = await fetchAdMetrics(
        campaign?.meta_campaign_id,
        ad.access_token_encrypted,
        since,
        until,
        ad.attribution_window_days
      );
      // Filter to this specific ad by its real Meta ID
      currentMetrics = allAdMetrics.find(m => m.meta_ad_id === ad.meta_ad_id) || null;
      if (!currentMetrics && allAdMetrics.length > 0) {
        console.warn(`[AdIntelligence] Ad ${ad.meta_ad_id} not found in response.`);
        console.warn(`[AdIntelligence] Available IDs:`, allAdMetrics.map(m => m.meta_ad_id));
      }
    } catch (err) {
      console.error(`[AdIntelligence] Metrics fetch threw for ${ad.meta_ad_id}:`, err.message);
      fetchError = err.message;
      metaErrorDetails = { code: err.code, type: err.type, httpStatus: err.httpStatus };
    }

    if (!currentMetrics) {
      const reason = fetchError
        ? `Meta API error: ${fetchError}${metaErrorDetails ? ` (code=${metaErrorDetails.code}, http=${metaErrorDetails.httpStatus})` : ''}`
        : `Meta returned no insights for ad ${ad.meta_ad_id} in campaign ${campaign?.meta_campaign_id} for period ${since}→${until}`;
      console.warn('[AdIntelligence] analyzed=false —', reason);
      return {
        analyzed:         false,
        reason,
        meta_ad_id:       ad.meta_ad_id,
        ad_name:          ad.name,
        objective:        entity.objective,
        meta_campaign_id: campaign?.meta_campaign_id || null,
        date_range:       { since, until },
        is_mock:          false,
      };
    }

    // FIX 2 (Phase 9): Fetch prior period metrics for ads.
    // Previously missing — campaigns had this, ads did not.
    try {
      const prior = priorPeriod(since, until);
      const allPriorAdMetrics = await fetchAdMetrics(
        campaign?.meta_campaign_id,
        ad.access_token_encrypted,
        prior.since,
        prior.until,
        ad.attribution_window_days
      );
      priorMetrics = allPriorAdMetrics.find(m => m.meta_ad_id === ad.meta_ad_id) || null;
    } catch (priorErr) {
      console.warn('[AdIntelligence] Prior period fetch failed:', priorErr.message);
    }
  }

  const startedAt = Date.now();

  // FIX 4 (Phase 9): Sequential-safety pattern -- preserved by
  // runScoringPipeline (shared with intelligenceOrchestrator.js and
  // adSetIntelligence.js instead of duplicated inline): scoring is
  // computed first (pure, no DB writes), and only if it succeeds do the
  // writes proceed.
  const { healthResult, benchmarkResult, recommendations, alerts, trend } =
    runScoringPipeline(entity, currentMetrics, priorMetrics, adAccountId, 'ad');

  return {
    meta_ad_id:       ad.meta_ad_id,
    ad_name:          ad.name,
    status:           ad.status,
    objective:        entity.objective,
    adset_name:       adSet?.name || null,
    meta_adset_id:    adSet?.meta_adset_id || null,
    campaign_name:    campaign?.name || null,
    meta_campaign_id: campaign?.meta_campaign_id || null,
    account_name:     ad.account_name,
    currency:         ad.currency,

    creative: {
      creative_id:   ad.creative_id   || null,
      thumbnail_url: ad.thumbnail_url || null,
      image_url:     ad.image_url     || null,
      preview_url:   ad.preview_url   || null,
    },

    date_range: { since, until },

    data_freshness: {
      fetched_at: new Date().toISOString(),
      source:     useMock ? 'mock' : 'meta_api',
    },

    metrics:       currentMetrics,
    prior_metrics: priorMetrics,
    deltas:        computeDeltas(currentMetrics, priorMetrics),

    health_score:     healthResult.health_score,
    health_status:    healthResult.health_status,
    health_breakdown: healthResult.breakdown,
    health_trend:     trend.map(t => ({
      score:         t.health_score,
      status:        t.health_status,
      calculated_at: t.calculated_at,
    })),

    benchmark:       { summary: benchmarkResult.summary, metrics: benchmarkResult.metrics },
    recommendations,
    alerts,

    _meta: { duration_ms: Date.now() - startedAt },
  };
}

// ─────────────────────────────────────────────
// Get ads list with latest health scores
// ─────────────────────────────────────────────
function getAdsList(filters = {}) {
  const { adset_id, campaign_id, account_id, status } = filters;

  const conditions = [];
  const params     = [];

  if (adset_id) {
    const as = db.get('SELECT id FROM ad_sets WHERE id = ? OR meta_adset_id = ?', [adset_id, adset_id]);
    if (as) { conditions.push('ad.ad_set_id = ?'); params.push(as.id); }
  }
  if (campaign_id) {
    const camp = db.get('SELECT id FROM campaigns WHERE id = ? OR meta_campaign_id = ?', [campaign_id, campaign_id]);
    if (camp) { conditions.push('ad.campaign_id = ?'); params.push(camp.id); }
  }
  if (account_id) { conditions.push('ad.ad_account_id = ?'); params.push(account_id); }
  if (status)     { conditions.push('ad.status = ?'); params.push(status); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Latest health score is joined in-query (correlated subquery for the
  // per-entity MAX(calculated_at), same pattern dashboard.js already uses)
  // instead of one extra db.get() per row in a .map() -- that N+1 pattern
  // meant listing 2,000 ads issued 1 (list) + 2,000 (score lookups) queries
  // to return a single page.
  const ads = db.all(
    `SELECT
       ad.id, ad.meta_ad_id, ad.name, ad.status,
       ad.ad_set_id, ad.campaign_id, ad.ad_account_id,
       ad.creative_id, ad.thumbnail_url, ad.image_url, ad.preview_url,
       s.meta_adset_id, s.name as adset_name,
       c.meta_campaign_id, c.name as campaign_name, c.objective,
       a.account_name, a.currency,
       h.health_score, h.health_status, h.calculated_at as last_scored_at
     FROM ads ad
     JOIN ad_sets s ON ad.ad_set_id = s.id
     JOIN campaigns c ON ad.campaign_id = c.id
     JOIN ad_accounts a ON ad.ad_account_id = a.id
     LEFT JOIN health_score_history h ON h.entity_meta_id = ad.meta_ad_id
       AND h.entity_type = 'ad'
       AND h.calculated_at = (
         SELECT MAX(h2.calculated_at) FROM health_score_history h2
         WHERE h2.entity_meta_id = ad.meta_ad_id AND h2.entity_type = 'ad'
       )
     ${where}
     ORDER BY ad.name ASC`,
    params
  );
  // Phase 7B: creative_id/thumbnail_url/image_url/preview_url now explicitly selected (may be null)

  return ads.map(a => ({
    ...a,
    health_score:   a.health_score ?? null,
    health_status:  a.health_status ?? null,
    last_scored_at: a.last_scored_at ?? null,
  }));
}

module.exports = {
  runAdIntelligence,
  getAdsList,
  loadAdWithParent,
};
