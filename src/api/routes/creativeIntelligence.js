/**
 * Creative Intelligence Routes — Complete Integration
 *
 * Comprehensive creative analysis: scoring, diagnostics, trends, leaderboards,
 * conversation analysis, and recommendations.
 *
 * Integrates with:
 * - Dashboard
 * - Rule Engine
 * - Recommendation Engine
 * - Executive Summary
 * - Smart Auto Sync
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { resolveDateRange } = require('../../services/dateRangeHelper');
const { asyncHandler } = require('../../middleware/errorHandler');

const creativeIntel = require('../../services/creativeIntelligenceService');
const creativeLibrary = require('../../services/creativeLibrary');
const chartDataBuilder = require('../../services/chartDataBuilder');

function loadCampaignMetaId(idOrMetaId) {
  const row = db.get(
    'SELECT meta_campaign_id FROM campaigns WHERE id = ? OR meta_campaign_id = ?',
    [idOrMetaId, idOrMetaId]
  );
  return row?.meta_campaign_id || null;
}

function loadAdsetMetaId(idOrMetaId) {
  const row = db.get(
    'SELECT meta_adset_id FROM ad_sets WHERE id = ? OR meta_adset_id = ?',
    [idOrMetaId, idOrMetaId]
  );
  return row?.meta_adset_id || null;
}

// ── Creative Library (search + filter) ──────────────────
// Backed entirely by creativeLibrary.searchCreativeLibrary(), already built
// (Step 11) but never wired to a route until now -- no new logic here.

router.get('/library', asyncHandler(async (req, res) => {
  const {
    account_id, campaign_id, adset_id, objective, creative_type,
    min_score, max_score, fatigue_status, is_winner, is_loser,
    search, since, until, platform, language,
  } = req.query;

  const result = creativeLibrary.searchCreativeLibrary({
    account_id, campaign_id, adset_id, objective, creative_type,
    min_score: min_score != null ? parseFloat(min_score) : undefined,
    max_score: max_score != null ? parseFloat(max_score) : undefined,
    fatigue_status,
    is_winner: is_winner === 'true' || is_winner === true,
    is_loser: is_loser === 'true' || is_loser === true,
    search, date_since: since, date_until: until, platform, language,
  });

  return res.json({ data: result });
}));

// ── Ad Set Creative Comparison ───────────────────────────
// Backed by creativeLibrary.getAdSetComparison() (Step 6), already built,
// never wired to a route until now.

router.get('/adset/:adsetId/comparison', asyncHandler(async (req, res) => {
  const metaAdsetId = loadAdsetMetaId(req.params.adsetId);
  if (!metaAdsetId) return res.status(404).json({ error: 'Ad set not found' });

  const dateRange = resolveDateRange(req.query);
  const result = creativeLibrary.getAdSetComparison(metaAdsetId, dateRange);

  return res.json({ data: result });
}));

// ── Creative Charts ──────────────────────────────────────
// Reshapes creative_analytics rows via chartDataBuilder.js's generic,
// already-built chart reshaping functions -- no new chart-rendering logic,
// only the query + dispatch to the right existing builder per type.

const CHART_TYPES = ['score_distribution', 'ctr_by_creative', 'retention_curve', 'ranking', 'funnel'];

router.get('/charts/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const { type, ad_id, adset_id } = req.query;
  if (!CHART_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Unsupported chart type', valid_types: CHART_TYPES });
  }

  const dateRange = resolveDateRange(req.query);
  const creatives = db.all(
    `SELECT ca.*, a.name as ad_name FROM creative_analytics ca
     LEFT JOIN ads a ON a.meta_ad_id = ca.meta_ad_id
     WHERE ca.meta_campaign_id = ? AND ca.date_since = ? AND ca.date_until = ?`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  if (type === 'score_distribution') {
    const buckets = [
      { label: '0-40', min: 0, max: 40 },
      { label: '40-60', min: 40, max: 60 },
      { label: '60-80', min: 60, max: 80 },
      { label: '80-100', min: 80, max: 101 },
    ];
    const rows = buckets.map(b => ({
      dimension_value: b.label,
      count: creatives.filter(c => c.score_overall != null && c.score_overall >= b.min && c.score_overall < b.max).length,
    }));
    return res.json({ data: chartDataBuilder.buildBarChart(rows, { labelKey: 'dimension_value', valueKey: 'count' }) });
  }

  if (type === 'ctr_by_creative') {
    const rows = creatives.map(c => ({ dimension_value: c.ad_name || c.meta_ad_id, ctr: c.ctr }));
    return res.json({ data: chartDataBuilder.buildBarChart(rows, { labelKey: 'dimension_value', valueKey: 'ctr' }) });
  }

  if (type === 'retention_curve') {
    if (!ad_id) return res.status(400).json({ error: 'ad_id is required for the retention_curve chart type' });
    const row = creatives.find(c => c.meta_ad_id === ad_id);
    if (!row) return res.status(404).json({ error: 'Ad not found in this campaign for the given date range' });
    return res.json({ data: chartDataBuilder.buildRetentionCurve(row) });
  }

  if (type === 'ranking') {
    if (!adset_id) return res.status(400).json({ error: 'adset_id is required for the ranking chart type' });
    const metaAdsetId = loadAdsetMetaId(adset_id) || adset_id;
    const comparison = creativeLibrary.getAdSetComparison(metaAdsetId, dateRange);
    return res.json({ data: chartDataBuilder.buildRankingChart(comparison.ranking, { labelKey: 'ad_name', valueKey: 'score' }) });
  }

  if (type === 'funnel') {
    const totals = creatives.reduce((acc, c) => ({
      impressions: acc.impressions + (c.impressions || 0),
      link_clicks: acc.link_clicks + (c.link_clicks || 0),
      landing_page_views: acc.landing_page_views + (c.landing_page_views || 0),
      results: acc.results + (c.results || 0),
    }), { impressions: 0, link_clicks: 0, landing_page_views: 0, results: 0 });
    const stages = [
      { label: 'Impressions', value: totals.impressions },
      { label: 'Link Clicks', value: totals.link_clicks },
      { label: 'Landing Page Views', value: totals.landing_page_views },
      { label: 'Results', value: totals.results },
    ];
    return res.json({ data: chartDataBuilder.buildFunnelChart(stages) });
  }
}));

// ── Creative Details bundle (bare :adId) ─────────────────
// Backed by creativeLibrary.getCreativeDetails() (Step 10), already built
// (including the Rule Engine/MAIFS/Executive Summary bundle via
// adIntelligence.runAdIntelligence()), never wired to a route until now.
// Registered AFTER /library, /adset/*, /charts/* so those literal-prefix
// routes are matched first -- a bare `/:adId` pattern would otherwise also
// match the single path segment "library".

router.get('/:adId', asyncHandler(async (req, res) => {
  const details = await creativeLibrary.getCreativeDetails(req.params.adId, { useMock: req.query.mock === 'true' });
  if (!details) return res.status(404).json({ error: 'Ad not found' });
  return res.json({ data: details });
}));

router.get('/:adId/timeline', asyncHandler(async (req, res) => {
  const ad = db.get('SELECT meta_ad_id FROM ads WHERE id = ? OR meta_ad_id = ?', [req.params.adId, req.params.adId]);
  if (!ad) return res.status(404).json({ error: 'Ad not found' });
  const timeline = creativeLibrary.getCreativeTimeline(ad.meta_ad_id);
  return res.json({ data: timeline });
}));

// ── Creative Score ───────────────────────────────────────

router.get('/score/:adId', asyncHandler(async (req, res) => {
  const score = creativeIntel.scoreCreative(req.params.adId);
  return res.json({ data: score });
}));

// ── Creative Diagnostics ────────────────────────────────

router.get('/diagnosis/:adId', asyncHandler(async (req, res) => {
  const diagnosis = creativeIntel.diagnoseCreative(req.params.adId);
  return res.json({ data: diagnosis });
}));

// ── Creative Trend Analysis ─────────────────────────────

router.get('/trend/:adId', asyncHandler(async (req, res) => {
  const trend = creativeIntel.analyzeCreativeTrend(req.params.adId);
  return res.json({ data: trend });
}));

// ── Campaign Leaderboard ────────────────────────────────

router.get('/leaderboard/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const limit = parseInt(req.query.limit) || 20;
  const leaderboard = creativeIntel.getCampaignLeaderboard(metaCampaignId, limit);

  return res.json({ data: leaderboard });
}));

// ── Conversation Destination Analysis ───────────────────

router.get('/destinations/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const analysis = creativeIntel.analyzeConversationDestinations(metaCampaignId, dateRange);

  return res.json({ data: analysis });
}));

// ── Creative Recommendations ────────────────────────────

router.get('/recommendations/:adId', asyncHandler(async (req, res) => {
  const recommendations = creativeIntel.generateCreativeRecommendations(req.params.adId);
  return res.json({ data: recommendations });
}));

// ── Master Creative Dashboard ───────────────────────────

router.get('/dashboard/:adId', asyncHandler(async (req, res) => {
  const adId = req.params.adId;

  const creative = db.get(
    'SELECT * FROM creative_analytics WHERE meta_ad_id = ? ORDER BY date_until DESC LIMIT 1',
    [adId]
  );

  if (!creative) {
    return res.status(404).json({ error: 'Creative not found' });
  }

  const score = creativeIntel.scoreCreative(adId);
  const diagnosis = creativeIntel.diagnoseCreative(adId);
  const trend = creativeIntel.analyzeCreativeTrend(adId);
  const recommendations = creativeIntel.generateCreativeRecommendations(adId);

  return res.json({
    data: {
      creative: {
        meta_ad_id: creative.meta_ad_id,
        name: creative.creative_name,
        type: creative.creative_type,
        campaign: creative.meta_campaign_id,
      },
      assets: {
        headline: creative.headline,
        description: creative.description,
        cta_type: creative.cta_type,
        image_url: creative.image_url,
        video_id: creative.video_id,
      },
      performance: {
        spend: creative.spend,
        results: creative.results,
        ctr: creative.ctr,
        cpm: creative.cpm,
        cpa: creative.cpa,
        roas: creative.roas,
        frequency: creative.frequency,
      },
      scoring: score,
      diagnostics: diagnosis,
      trends: trend,
      recommendations,
    },
  });
}));

// ── Campaign Creatives ──────────────────────────────────

router.get('/campaign/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const creatives = db.all(
    `SELECT meta_ad_id, creative_name, creative_type, spend, results, ctr, cpa, roas
     FROM creative_analytics
     WHERE meta_campaign_id = ?
     ORDER BY date_until DESC LIMIT 100`,
    [metaCampaignId]
  );

  return res.json({
    data: {
      campaign: metaCampaignId,
      total_creatives: creatives.length,
      creatives: creatives.map(c => ({
        ...c,
        score: creativeIntel.scoreCreative(c.meta_ad_id).score,
      })),
    },
  });
}));

module.exports = router;
