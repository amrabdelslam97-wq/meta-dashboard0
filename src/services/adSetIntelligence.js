/**
 * Ad Set Intelligence — Phase 6B
 *
 * Pure orchestration layer for ad set level intelligence.
 * Reuses existing engines 100%. Contains NO scoring logic.
 *
 * The shared health/benchmark/recommendation/alert/trend sequence is
 * delegated to intelligenceOrchestrator.runScoringPipeline() (entityType=
 * 'ad_set') instead of duplicating it inline -- this file previously had
 * its own copy of the exact same sequence found in
 * intelligenceOrchestrator.js and adIntelligence.js.
 */

const db                    = require('../db/database');

const { runScoringPipeline } = require('./intelligenceOrchestrator');
const { fetchAdSetMetrics, computeDeltas } = require('./metricsFetcher');
const { resolveDateRange, priorPeriod } = require('./dateRangeHelper');
const { decryptToken } = require('./tokenCrypto');

// ─────────────────────────────────────────────
// Stable variance index derived from entity ID (Phase 7B)
// Ensures distinct mock metrics per entity regardless of how many
// siblings share the same parent campaign.
// ─────────────────────────────────────────────
function stableIndexFromId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % 7; // bounded 0-6 for reasonable metric variance
}

// ─────────────────────────────────────────────
// Load ad set + parent campaign from DB
// ─────────────────────────────────────────────
function loadAdSetWithParent(id) {
  // Accept internal UUID or meta_adset_id
  const adSet = db.get(
    `SELECT s.*, a.access_token_encrypted, a.id as internal_account_id,
            a.meta_account_id, a.account_name, a.currency, a.attribution_window_days
     FROM ad_sets s
     JOIN ad_accounts a ON s.ad_account_id = a.id
     WHERE s.id = ? OR s.meta_adset_id = ?`,
    [id, id]
  );
  if (!adSet) return null;
  adSet.access_token_encrypted = decryptToken(adSet.access_token_encrypted);

  const campaign = db.get(
    `SELECT id, meta_campaign_id, name, objective, status
     FROM campaigns WHERE id = ?`,
    [adSet.campaign_id]
  );

  return { adSet, campaign };
}

// ─────────────────────────────────────────────
// Mock metrics for development / no Meta token
// ─────────────────────────────────────────────
function getMockAdSetMetrics(objective, index = 0) {
  const base = {
    spend:       Math.round((400 + index * 120) * 100) / 100,
    impressions: 28000 + index * 5000,
    reach:       14000 + index * 2500,
    clicks:      340 + index * 50,
    ctr:         Math.round((1.2 + index * 0.1) * 100) / 100,
    cpm:         Math.round((14.3 - index * 0.3) * 100) / 100,
    cpc:         Math.round((1.18 + index * 0.08) * 100) / 100,
    frequency:   Math.round((2.0 + index * 0.25) * 100) / 100,
  };
  const extras = {
    messaging: { results: 60 + index * 8,  cpr: Math.round((6.5 - index * 0.4) * 100) / 100 },
    leads:     { leads:   40 + index * 6,  cpl: Math.round((10 - index * 0.5) * 100) / 100  },
    sales:     { purchases: 8 + index * 2, cpa: Math.round((50 - index * 3) * 100) / 100, roas: Math.round((2.4 + index * 0.2) * 100) / 100 },
    traffic:   { link_clicks: 320 + index * 40, landing_page_views: 240 + index * 30 },
    awareness: { reach: 14000 + index * 3000, impressions: 32000 + index * 6000 },
  };
  return { ...base, ...(extras[objective] || {}) };
}

// ─────────────────────────────────────────────
// MAIN: Run intelligence pipeline for one ad set
// ─────────────────────────────────────────────
async function runAdSetIntelligence(adSetId, options = {}) {
  const { useMock = false, dateRange } = options;

  const loaded = loadAdSetWithParent(adSetId);
  if (!loaded) return null;

  const { adSet, campaign } = loaded;
  const adAccountId = adSet.internal_account_id;
  const { since, until } = resolveDateRange(dateRange || {});

  // ── Build synthetic entity (same shape the engines expect) ──
  const entity = {
    meta_campaign_id: adSet.meta_adset_id,   // used as entity_meta_id in DB
    name:             adSet.name,
    objective:        campaign?.objective || 'unknown',
  };

  // ── Fetch metrics ──
  let currentMetrics = null;
  let priorMetrics   = null;

  if (useMock) {
    // Use a stable hash of the entity's own meta ID for variance — NOT sibling position.
    // Sibling-position indexing collapsed to idx=0 for any ad set that is the only one
    // in its campaign, causing identical mock values across unrelated entities (Phase 7B fix).
    const idx = stableIndexFromId(adSet.meta_adset_id);
    currentMetrics = getMockAdSetMetrics(entity.objective, idx);
    priorMetrics   = getMockAdSetMetrics(entity.objective, idx + 1);
  } else {
    let fetchError = null;
    let metaErrorDetails = null;
    try {
      // fetchAdSetMetrics calls /{meta_campaign_id}/insights?level=adset
      // Logging is done inside fetchAdSetMetrics (see metricsFetcher.js)
      const allAdSetMetrics = await fetchAdSetMetrics(
        campaign?.meta_campaign_id,
        adSet.access_token_encrypted,
        since,
        until,
        adSet.attribution_window_days
      );
      // Filter to this specific ad set by its real Meta ID
      currentMetrics = allAdSetMetrics.find(m => m.meta_adset_id === adSet.meta_adset_id) || null;
      if (!currentMetrics && allAdSetMetrics.length > 0) {
        // Data came back but this adset wasn't in it — log the IDs for diagnosis
        console.warn(`[AdSetIntelligence] Adset ${adSet.meta_adset_id} not found in response.`);
        console.warn(`[AdSetIntelligence] Available IDs:`, allAdSetMetrics.map(m => m.meta_adset_id));
      }
    } catch (err) {
      console.error(`[AdSetIntelligence] Metrics fetch threw for ${adSet.meta_adset_id}:`, err.message);
      fetchError = err.message;
      metaErrorDetails = { code: err.code, type: err.type, httpStatus: err.httpStatus };
    }

    if (!currentMetrics) {
      // Return exact Meta reason — never invent a generic message
      const reason = fetchError
        ? `Meta API error: ${fetchError}${metaErrorDetails ? ` (code=${metaErrorDetails.code}, http=${metaErrorDetails.httpStatus})` : ''}`
        : `Meta returned no insights for adset ${adSet.meta_adset_id} in campaign ${campaign?.meta_campaign_id} for period ${since}→${until}`;
      console.warn('[AdSetIntelligence] analyzed=false —', reason);
      return {
        analyzed:         false,
        reason,
        meta_adset_id:    adSet.meta_adset_id,
        adset_name:       adSet.name,
        objective:        entity.objective,
        meta_campaign_id: campaign?.meta_campaign_id || null,
        date_range:       { since, until },
        is_mock:          false,
      };
    }

    // FIX 2 (Phase 9): Fetch prior period metrics for ad sets.
    // Previously missing — campaigns had this, ad sets did not.
    // Enables: comparison engine, delta indicators, prior-period-based alerts.
    try {
      const prior = priorPeriod(since, until);
      const allPriorAdSetMetrics = await fetchAdSetMetrics(
        campaign?.meta_campaign_id,
        adSet.access_token_encrypted,
        prior.since,
        prior.until,
        adSet.attribution_window_days
      );
      priorMetrics = allPriorAdSetMetrics.find(m => m.meta_adset_id === adSet.meta_adset_id) || null;
    } catch (priorErr) {
      console.warn('[AdSetIntelligence] Prior period fetch failed:', priorErr.message);
    }
  }

  const startedAt = Date.now();

  // FIX 4 (Phase 9): Sequential-safety pattern -- preserved by
  // runScoringPipeline (shared with intelligenceOrchestrator.js and
  // adIntelligence.js instead of duplicated inline). sql.js auto-persists
  // on every db.run(), making SQLite BEGIN/COMMIT transactions
  // incompatible with the module-level db API used here, so scoring is
  // computed first (pure, no DB writes) and only written if it succeeds.
  const { healthResult, benchmarkResult, recommendations, alerts, trend } =
    runScoringPipeline(entity, currentMetrics, priorMetrics, adAccountId, 'ad_set');

  return {
    meta_adset_id:    adSet.meta_adset_id,
    adset_name:       adSet.name,
    status:           adSet.status,
    objective:        entity.objective,
    campaign_name:    campaign?.name || null,
    meta_campaign_id: campaign?.meta_campaign_id || null,
    account_name:     adSet.account_name,
    currency:         adSet.currency,

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
// Get ad sets list with latest health scores
// ─────────────────────────────────────────────
function getAdSetsList(filters = {}) {
  const { campaign_id, account_id, status, optimization_goal } = filters;

  const conditions = [];
  const params     = [];

  if (campaign_id) {
    // Accept internal UUID or meta_campaign_id
    const camp = db.get('SELECT id FROM campaigns WHERE id = ? OR meta_campaign_id = ?', [campaign_id, campaign_id]);
    if (camp) { conditions.push('s.campaign_id = ?'); params.push(camp.id); }
  }
  if (account_id) { conditions.push('s.ad_account_id = ?'); params.push(account_id); }
  if (status)     { conditions.push('s.status = ?'); params.push(status); }
  if (optimization_goal) { conditions.push('s.optimization_goal = ?'); params.push(optimization_goal); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Latest health score is joined in-query instead of one extra db.get()
  // per row in a .map() (same N+1 fix as adIntelligence.getAdsList).
  const adSets = db.all(
    `SELECT
       s.id, s.meta_adset_id, s.name, s.status,
       s.daily_budget, s.lifetime_budget, s.optimization_goal,
       s.campaign_id, s.ad_account_id,
       c.meta_campaign_id, c.name as campaign_name, c.objective,
       a.account_name, a.currency,
       h.health_score, h.health_status, h.calculated_at as last_scored_at
     FROM ad_sets s
     JOIN campaigns c ON s.campaign_id = c.id
     JOIN ad_accounts a ON s.ad_account_id = a.id
     LEFT JOIN health_score_history h ON h.entity_meta_id = s.meta_adset_id
       AND h.entity_type = 'ad_set'
       AND h.calculated_at = (
         SELECT MAX(h2.calculated_at) FROM health_score_history h2
         WHERE h2.entity_meta_id = s.meta_adset_id AND h2.entity_type = 'ad_set'
       )
     ${where}
     ORDER BY s.name ASC`,
    params
  );

  return adSets.map(s => ({
    ...s,
    health_score:   s.health_score ?? null,
    health_status:  s.health_status ?? null,
    last_scored_at: s.last_scored_at ?? null,
  }));
}

module.exports = {
  runAdSetIntelligence,
  getAdSetsList,
  loadAdSetWithParent,
};
