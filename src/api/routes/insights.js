/**
 * Insights Route — Phase 4
 *
 * GET /api/v1/campaigns/:id/insights
 *   Full intelligence view with REAL Meta Insights data.
 *   Supports presets, custom ranges, prior period comparison.
 *   ?mock=true  → use mock data (development / no token)
 *   ?refresh=true → bypass cache
 *
 * GET /api/v1/campaigns/:id/insights/trend
 *   Daily trend data (time_increment=1) — chart-ready series.
 *
 * GET /api/v1/campaigns/:id/insights/breakdowns
 *   Lazy-loaded breakdown data: age, gender, region.
 *   ?dimension=age|gender|region  (default: all three)
 *
 * GET /api/v1/campaigns/:id/insights/adsets
 *   Per-ad-set metrics for the campaign.
 *
 * GET /api/v1/campaigns/:id/insights/ads
 *   Per-ad metrics for the campaign.
 *
 * POST /api/v1/campaigns/:id/insights/refresh
 *   Clears cache for this campaign and reloads.
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });

const db                = require('../../db/database');
const { buildComparisons } = require('../../services/comparisonEngine');
const cache             = require('../../services/cacheService');
const { resolveDateRange, priorPeriod, isInAttributionWindow } = require('../../services/dateRangeHelper');
const { fetchCampaignMetrics, fetchAdSetMetrics, fetchAdMetrics, fetchTrendData } = require('../../services/metricsFetcher');
const { fetchBreakdown, fetchAllBreakdowns, enrichBreakdown } = require('../../services/breakdownsFetcher');
const { runIntelligencePipeline } = require('../../services/intelligenceOrchestrator');
const { asyncHandler }            = require('../../middleware/errorHandler');
const { isMockRequested, rejectMockInProduction } = require('../../services/mockGuard');
const { decryptToken } = require('../../services/tokenCrypto');

// ─────────────────────────────────────────────
// Mock data (development / no Meta token)
// ─────────────────────────────────────────────
function getMockMetrics(objective) {
  const base = { spend:1200, impressions:85000, reach:42000, clicks:1020, ctr:1.2, cpm:14.1, cpc:1.18, frequency:2.02 };
  const extras = {
    engagement:    { results:85, cpr:14.1 },
    leads:         { leads:62, cpl:19.4 },
    sales:         { purchases:18, cpa:66.7, roas:2.4, purchase_value:2880 },
    traffic:       { link_clicks:980, landing_page_views:740, cost_per_landing_page_view:1.62 },
    awareness:     { reach:55000, impressions:120000, cpm:10.0 },
    app_promotion: { app_installs:45, cpi:6.4 },
    unknown:       {},
  };
  return { ...base, ...(extras[objective] || {}) };
}

function getMockPriorMetrics(objective) {
  const base = { spend:1000, impressions:70000, reach:35000, clicks:700, ctr:1.0, cpm:14.3, cpc:1.43, frequency:1.75 };
  const extras = {
    engagement:    { results:60, cpr:16.7 },
    leads:         { leads:40, cpl:25.0 },
    sales:         { purchases:10, cpa:100, roas:1.5, purchase_value:1500 },
    traffic:       { link_clicks:650, landing_page_views:490 },
    awareness:     { reach:40000, impressions:90000 },
    app_promotion: { app_installs:30, cpi:8.1 },
    unknown:       {},
  };
  return { ...base, ...(extras[objective] || {}) };
}

function getMockDeltas(current, prior) {
  const deltas = {};
  for (const k of Object.keys(current)) {
    if (typeof current[k] === 'number' && prior[k] != null) {
      const abs = Math.round((current[k] - prior[k]) * 100) / 100;
      const pct = prior[k] !== 0 ? Math.round(((current[k] - prior[k]) / Math.abs(prior[k])) * 1000) / 10 : 0;
      deltas[k] = { delta_abs: abs, delta_pct: pct };
    }
  }
  return deltas;
}

// ─────────────────────────────────────────────
// Load campaign + account from DB
// ─────────────────────────────────────────────
function loadCampaign(id) {
  const campaign = db.get(
    `SELECT c.*, a.access_token_encrypted, a.id as internal_account_id,
            a.meta_account_id, a.account_name, a.attribution_window_days, a.currency
     FROM campaigns c
     JOIN ad_accounts a ON c.ad_account_id = a.id
     WHERE c.id = ? OR c.meta_campaign_id = ?`,
    [id, id]
  );
  // Decrypted here once so every call site below can keep using
  // campaign.access_token_encrypted unchanged.
  if (campaign) campaign.access_token_encrypted = decryptToken(campaign.access_token_encrypted);
  return campaign;
}

// ─────────────────────────────────────────────
// GET /insights — Main intelligence endpoint
// ─────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const { id }      = req.params;
  if (rejectMockInProduction(req, res)) return;
  const useMock     = isMockRequested(req);
  const forceRefresh = req.query.refresh === 'true';

  const campaign = loadCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found', id });

  const dateRange = resolveDateRange(req.query);
  const { since, until } = dateRange;
  const prior     = priorPeriod(since, until);
  const adAccountId = campaign.internal_account_id;

  // Clear cache if refresh requested
  if (forceRefresh) {
    cache.invalidateCampaign(campaign.meta_campaign_id);
  }

  let currentMetrics, priorMetrics, deltas, fetchedAt, source, fromCache = false;

  if (useMock) {
    currentMetrics = getMockMetrics(campaign.objective);
    priorMetrics   = getMockPriorMetrics(campaign.objective);
    deltas         = getMockDeltas(currentMetrics, priorMetrics);
    fetchedAt      = new Date().toISOString();
    source         = 'mock';
  } else {
    let metricsResult;
    try {
      metricsResult  = await fetchCampaignMetrics(campaign.meta_campaign_id, campaign.access_token_encrypted, dateRange, campaign.attribution_window_days);
      currentMetrics = metricsResult.current;
      priorMetrics   = metricsResult.prior;
      deltas         = metricsResult.deltas;
      fetchedAt      = metricsResult.fetched_at;
      source         = metricsResult.source;
      fromCache      = metricsResult.from_cache || false;
    } catch (err) {
      return res.status(502).json({
        analyzed: false,
        reason:   'Meta API error: ' + err.message,
        campaign_id:   campaign.meta_campaign_id,
        campaign_name: campaign.name,
      });
    }

    // Phase 8 (Production Readiness): do NOT fabricate metrics when Meta returns
    // no insights for the period (e.g. zero spend, paused before range, new campaign).
    // Previously this silently substituted an all-zero metrics object, which is
    // itself a form of fake data — health scores, recommendations, and alerts
    // would all be computed against numbers Meta never actually reported.
    if (!currentMetrics) {
      return res.json({
        analyzed:      false,
        reason:        'No Meta insights available for the selected period',
        campaign_id:   campaign.meta_campaign_id,
        campaign_name: campaign.name,
        objective:     campaign.objective,
        date_range:    { since, until },
        is_mock:       false,
      });
    }
  }

  // Attribution window check
  const dataIncomplete = isInAttributionWindow(until, campaign.attribution_window_days || 7);

  // Run intelligence pipeline (health score, recommendations, alerts)
  const intelligence = runIntelligencePipeline(
    { id: campaign.id, meta_campaign_id: campaign.meta_campaign_id, name: campaign.name, objective: campaign.objective },
    currentMetrics,
    priorMetrics,
    adAccountId
  );

  return res.json({
    campaign_id:    campaign.meta_campaign_id,
    campaign_name:  campaign.name,
    objective:      campaign.objective,
    account_name:   campaign.account_name,
    currency:       campaign.currency || 'USD',

    date_range: {
      since,
      until,
      prior_since:  prior.since,
      prior_until:  prior.until,
      days:         prior.days,
    },

    data_freshness: {
      fetched_at:              fetchedAt,
      source,
      from_cache:              fromCache,
      data_may_be_incomplete:  dataIncomplete,
      attribution_window_days: campaign.attribution_window_days || 7,
      warning: dataIncomplete
        ? 'Conversion data may be incomplete — within attribution window'
        : null,
    },

    metrics:        currentMetrics,
    prior_metrics:  priorMetrics,
    deltas,
    comparisons:    buildComparisons(currentMetrics, priorMetrics, deltas, req.query.preset || 'last_7_days'),

    health_score:     intelligence.health.score,
    health_status:    intelligence.health.status,
    health_breakdown: intelligence.health.breakdown,
    health_trend:     intelligence.health.trend,

    benchmark:        intelligence.benchmark,
    goal_achievement: intelligence.goal_achievement,
    recommendations:  intelligence.recommendations,
    alerts:           intelligence.alerts,

    fetched_at: fetchedAt,
    is_mock:    useMock,
    _meta:      intelligence.meta,
  });
}));

// ─────────────────────────────────────────────
// GET /insights/trend — Daily time series
// ─────────────────────────────────────────────
router.get('/trend', asyncHandler(async (req, res) => {
  if (rejectMockInProduction(req, res)) return;
  const { id }  = req.params;
  const useMock = isMockRequested(req);
  const campaign = loadCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const { since, until } = resolveDateRange(req.query);

  if (useMock) {
    // Generate synthetic daily trend
    const trend = [];
    const start = new Date(since);
    const end   = new Date(until);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const variance = 0.8 + Math.random() * 0.4;
      trend.push({
        date_start:  dateStr,
        date_stop:   dateStr,
        spend:       Math.round(120 * variance * 100) / 100,
        impressions: Math.round(8500 * variance),
        reach:       Math.round(4200 * variance),
        clicks:      Math.round(102 * variance),
        ctr:         Math.round(1.2 * variance * 100) / 100,
        cpm:         Math.round(14.1 / variance * 100) / 100,
        cpc:         Math.round(1.18 / variance * 100) / 100,
        frequency:   Math.round((1.5 + Math.random()) * 100) / 100,
      });
    }
    return res.json({ data: trend, date_range: { since, until }, source: 'mock', fetched_at: new Date().toISOString() });
  }

  if (req.query.refresh === 'true') cache.invalidateCampaign(campaign.meta_campaign_id);

  const trend = await fetchTrendData(campaign.meta_campaign_id, campaign.access_token_encrypted, since, until, campaign.attribution_window_days);

  return res.json({
    data:        trend,
    date_range:  { since, until },
    source:      'meta_api',
    fetched_at:  new Date().toISOString(),
  });
}));

// ─────────────────────────────────────────────
// GET /insights/breakdowns — Age, Gender, Region
// ─────────────────────────────────────────────
router.get('/breakdowns', asyncHandler(async (req, res) => {
  if (rejectMockInProduction(req, res)) return;
  const { id }       = req.params;
  const { dimension } = req.query;  // age | gender | region | (omit for all)
  const useMock      = isMockRequested(req);
  const campaign     = loadCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const { since, until } = resolveDateRange(req.query);

  if (useMock) {
    const mockAge    = [
      { dimension:'age', dimension_value:'18-24', spend:180, impressions:12000, reach:6000, clicks:150, ctr:1.25, cpm:15.0, frequency:2.0, spend_pct:15 },
      { dimension:'age', dimension_value:'25-34', spend:480, impressions:32000, reach:16000, clicks:420, ctr:1.31, cpm:15.0, frequency:2.0, spend_pct:40 },
      { dimension:'age', dimension_value:'35-44', spend:360, impressions:24000, reach:12000, clicks:300, ctr:1.25, cpm:15.0, frequency:2.0, spend_pct:30 },
      { dimension:'age', dimension_value:'45-54', spend:120, impressions:8000,  reach:4000,  clicks:96,  ctr:1.20, cpm:15.0, frequency:2.0, spend_pct:10 },
      { dimension:'age', dimension_value:'55+',   spend:60,  impressions:4000,  reach:2000,  clicks:54,  ctr:1.35, cpm:15.0, frequency:2.0, spend_pct:5  },
    ];
    const mockGender = [
      { dimension:'gender', dimension_value:'male',    spend:720, impressions:48000, reach:24000, clicks:612, ctr:1.28, cpm:15.0, frequency:2.0, spend_pct:60 },
      { dimension:'gender', dimension_value:'female',  spend:432, impressions:28800, reach:14400, clicks:374, ctr:1.30, cpm:15.0, frequency:2.0, spend_pct:36 },
      { dimension:'gender', dimension_value:'unknown', spend:48,  impressions:3200,  reach:1600,  clicks:34,  ctr:1.06, cpm:15.0, frequency:2.0, spend_pct:4  },
    ];
    const mockRegion = [
      { dimension:'region', dimension_value:'Cairo',       spend:540, impressions:36000, reach:18000, clicks:468, ctr:1.30, cpm:15.0, frequency:2.1, spend_pct:45 },
      { dimension:'region', dimension_value:'Alexandria',  spend:240, impressions:16000, reach:8000,  clicks:204, ctr:1.28, cpm:15.0, frequency:1.9, spend_pct:20 },
      { dimension:'region', dimension_value:'Giza',        spend:180, impressions:12000, reach:6000,  clicks:150, ctr:1.25, cpm:15.0, frequency:2.0, spend_pct:15 },
      { dimension:'region', dimension_value:'Sharm el-Sheikh', spend:120, impressions:8000, reach:4000, clicks:96, ctr:1.20, cpm:15.0, frequency:1.8, spend_pct:10 },
      { dimension:'region', dimension_value:'Other',       spend:120, impressions:8000,  reach:4000,  clicks:102, ctr:1.28, cpm:15.0, frequency:2.0, spend_pct:10 },
    ];

    if (dimension === 'age')    return res.json({ age:    { data: mockAge,    from_cache: false } });
    if (dimension === 'gender') return res.json({ gender: { data: mockGender, from_cache: false } });
    if (dimension === 'region') return res.json({ region: { data: mockRegion, from_cache: false } });
    return res.json({ age: { data: mockAge }, gender: { data: mockGender }, region: { data: mockRegion }, source: 'mock', fetched_at: new Date().toISOString() });
  }

  if (req.query.refresh === 'true') cache.invalidateCampaign(campaign.meta_campaign_id);

  if (dimension) {
    const result = await fetchBreakdown(campaign.meta_campaign_id, campaign.access_token_encrypted, since, until, dimension);
    result.data = enrichBreakdown(result.data);
    return res.json({ [dimension]: result, fetched_at: new Date().toISOString() });
  }

  const all = await fetchAllBreakdowns(campaign.meta_campaign_id, campaign.access_token_encrypted, since, until);
  if (all.age.data)    all.age.data    = enrichBreakdown(all.age.data);
  if (all.gender.data) all.gender.data = enrichBreakdown(all.gender.data);
  if (all.region.data) all.region.data = enrichBreakdown(all.region.data);

  return res.json({ ...all, fetched_at: new Date().toISOString() });
}));

// ─────────────────────────────────────────────
// GET /insights/adsets — Per-ad-set breakdown
// ─────────────────────────────────────────────
router.get('/adsets', asyncHandler(async (req, res) => {
  if (rejectMockInProduction(req, res)) return;
  const { id }  = req.params;
  const useMock = isMockRequested(req);
  const campaign = loadCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const { since, until } = resolveDateRange(req.query);

  if (useMock) {
    const adsets = db.all('SELECT meta_adset_id, name, status FROM ad_sets WHERE campaign_id = ?', [campaign.id]);
    const data = adsets.map((s, i) => ({
      meta_adset_id: s.meta_adset_id, name: s.name, status: s.status,
      spend: Math.round(400 * (1 + i * 0.3) * 100) / 100,
      impressions: 28000 + i * 5000, reach: 14000 + i * 2000,
      clicks: 340 + i * 50, ctr: 1.2 + i * 0.1, cpm: 14 + i * 0.5,
      cpc: 1.18 + i * 0.1, frequency: 2.0 + i * 0.2,
    }));
    return res.json({ data, date_range: { since, until }, source: 'mock', fetched_at: new Date().toISOString() });
  }

  const data = await fetchAdSetMetrics(campaign.meta_campaign_id, campaign.access_token_encrypted, since, until, campaign.attribution_window_days);
  return res.json({ data, date_range: { since, until }, source: 'meta_api', fetched_at: new Date().toISOString() });
}));

// ─────────────────────────────────────────────
// GET /insights/ads — Per-ad breakdown
// ─────────────────────────────────────────────
router.get('/ads', asyncHandler(async (req, res) => {
  if (rejectMockInProduction(req, res)) return;
  const { id }  = req.params;
  const useMock = isMockRequested(req);
  const campaign = loadCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const { since, until } = resolveDateRange(req.query);

  if (useMock) {
    const ads = db.all('SELECT meta_ad_id, name, status FROM ads WHERE campaign_id = ?', [campaign.id]);
    const data = ads.map((a, i) => ({
      meta_ad_id: a.meta_ad_id, name: a.name, status: a.status,
      spend: Math.round(200 * (1 + i * 0.5) * 100) / 100,
      impressions: 14000 + i * 3000, reach: 7000 + i * 1500,
      clicks: 170 + i * 30, ctr: 1.2 + i * 0.15, cpm: 14.3 + i * 0.3,
      cpc: 1.18 + i * 0.15, frequency: 2.0 + i * 0.3,
    }));
    return res.json({ data, date_range: { since, until }, source: 'mock', fetched_at: new Date().toISOString() });
  }

  const data = await fetchAdMetrics(campaign.meta_campaign_id, campaign.access_token_encrypted, since, until, campaign.attribution_window_days);
  return res.json({ data, date_range: { since, until }, source: 'meta_api', fetched_at: new Date().toISOString() });
}));

// ─────────────────────────────────────────────
// POST /insights/refresh — Invalidate cache
// ─────────────────────────────────────────────
router.post('/refresh', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const campaign = loadCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const count = cache.invalidateCampaign(campaign.meta_campaign_id);
  return res.json({ success: true, entries_cleared: count, campaign_id: campaign.meta_campaign_id });
}));

// ─────────────────────────────────────────────
// GET /insights/cache-stats — Debug (development only, see sync.js's
// /cache/stats for the same reasoning)
// ─────────────────────────────────────────────
router.get('/cache-stats', asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.json(cache.stats());
}));

module.exports = router;
