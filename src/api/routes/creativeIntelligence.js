/**
 * Creative Intelligence Router — Creative Intelligence Engine
 *
 * GET /api/v1/creative-intelligence/library                — Step 11: searchable/filterable Creative Library
 * GET /api/v1/creative-intelligence/adset/:adsetId/comparison — Step 6: winner/runner-up/worst within an ad set
 * GET /api/v1/creative-intelligence/charts/:campaignId      — Step 9: chart-ready datasets
 * GET /api/v1/creative-intelligence/:adId                   — Step 10: full Creative Details page
 * GET /api/v1/creative-intelligence/:adId/timeline          — Step 8: launch/peak/decline/fatigue/recovery/changes
 *
 * Thin routes only -- every domain's real logic lives in creativeLibrary.js/
 * creativeIntelligenceEngine.js/chartDataBuilder.js, matching analytics.js's
 * established convention for this codebase. Every GET here reads
 * already-synced data (creative_analytics, populated by
 * creativeAnalytics.js's existing sync pipeline) with one exception:
 * GET /:adId reuses adIntelligence.runAdIntelligence() for its Rule
 * Engine/MAIFS/Diagnosis/Health bundle, a per-detail-view read consistent
 * with how /api/v1/ads/:id/insights already behaves.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { resolveDateRange } = require('../../services/dateRangeHelper');
const { asyncHandler } = require('../../middleware/errorHandler');
const { isMockRequested, rejectMockInProduction } = require('../../services/mockGuard');

const creativeLibrary = require('../../services/creativeLibrary');
const chart = require('../../services/chartDataBuilder');

function loadAdsetMetaId(idOrMetaId) {
  const row = db.get('SELECT meta_adset_id FROM ad_sets WHERE id = ? OR meta_adset_id = ?', [idOrMetaId, idOrMetaId]);
  return row?.meta_adset_id || null;
}

function loadCampaignMetaId(idOrMetaId) {
  const row = db.get('SELECT meta_campaign_id FROM campaigns WHERE id = ? OR meta_campaign_id = ?', [idOrMetaId, idOrMetaId]);
  return row?.meta_campaign_id || null;
}

// ─────────────────────────────────────────────
// GET /library — Step 11: Creative Library (search + filter)
// ─────────────────────────────────────────────
router.get('/library', asyncHandler(async (req, res) => {
  const {
    account_id, campaign_id, adset_id, objective, creative_type,
    min_score, max_score, fatigue_status, is_winner, is_loser,
    search, platform, language,
  } = req.query;
  // since/until (resolveDateRange) is this router's established convention
  // (matches /charts, /adset/:adsetId/comparison, and analytics.js) --
  // searchCreativeLibrary() itself takes date_since/date_until internally.
  const dateRange = resolveDateRange(req.query);

  const result = creativeLibrary.searchCreativeLibrary({
    account_id, campaign_id, adset_id, objective, creative_type,
    fatigue_status, search, platform, language,
    date_since: dateRange.since, date_until: dateRange.until,
    min_score: min_score != null ? parseFloat(min_score) : null,
    max_score: max_score != null ? parseFloat(max_score) : null,
    is_winner: is_winner === 'true',
    is_loser: is_loser === 'true',
  });

  return res.json({ data: result });
}));

// ─────────────────────────────────────────────
// GET /adset/:adsetId/comparison — Step 6: winner/runner-up/worst within an ad set
// ─────────────────────────────────────────────
router.get('/adset/:adsetId/comparison', asyncHandler(async (req, res) => {
  const metaAdsetId = loadAdsetMetaId(req.params.adsetId);
  if (!metaAdsetId) return res.status(404).json({ error: 'Ad set not found' });

  const dateRange = resolveDateRange(req.query);
  return res.json({ data: creativeLibrary.getAdSetComparison(metaAdsetId, dateRange) });
}));

// ─────────────────────────────────────────────
// GET /charts/:campaignId — Step 9: chart-ready datasets
// ?type=score_distribution|ctr_by_creative|roas_by_creative|ranking|
//       retention_curve|fatigue_timeline|trend|funnel|scatter|bubble|heatmap
// ranking/retention_curve/fatigue_timeline/trend require ?ad_id= or ?adset_id=
// as appropriate (see per-type handling below).
// ─────────────────────────────────────────────
router.get('/charts/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const type = req.query.type || 'score_distribution';
  const dateRange = resolveDateRange(req.query);
  const library = creativeLibrary.searchCreativeLibrary({ campaign_id: metaCampaignId, date_since: dateRange.since, date_until: dateRange.until });
  const rows = library.creatives;

  switch (type) {
    case 'score_distribution': {
      const buckets = [
        { label: '0-20', min: 0, max: 20 }, { label: '21-40', min: 21, max: 40 },
        { label: '41-60', min: 41, max: 60 }, { label: '61-80', min: 61, max: 80 },
        { label: '81-100', min: 81, max: 100 },
      ];
      const bucketRows = buckets.map(b => ({
        dimension_value: b.label,
        spend: rows.filter(r => r.score_overall != null && r.score_overall >= b.min && r.score_overall <= b.max).length,
      }));
      return res.json({ data: chart.buildBarChart(bucketRows, { labelKey: 'dimension_value', valueKey: 'spend' }), date_range: dateRange });
    }

    case 'ctr_by_creative':
      return res.json({ data: chart.buildBarChart(rows, { labelKey: 'headline', valueKey: 'ctr' }), date_range: dateRange });

    case 'roas_by_creative':
      return res.json({ data: chart.buildBarChart(rows, { labelKey: 'headline', valueKey: 'roas' }), date_range: dateRange });

    case 'scatter':
      return res.json({
        data: chart.buildScatterChart(rows, { xKey: req.query.x || 'score_overall', yKey: req.query.y || 'roas', labelKey: 'headline' }),
        date_range: dateRange,
      });

    case 'bubble':
      return res.json({
        data: chart.buildBubbleChart(rows, { xKey: req.query.x || 'score_overall', yKey: req.query.y || 'roas', sizeKey: req.query.size || 'spend', labelKey: 'headline' }),
        date_range: dateRange,
      });

    case 'heatmap':
      return res.json({
        data: chart.buildHeatmap(rows, { rowKey: req.query.row || 'creative_type', colKey: req.query.col || 'fatigue_status', valueKey: req.query.metric || 'spend' }),
        date_range: dateRange,
      });

    case 'funnel': {
      const sum = key => rows.reduce((s, r) => s + (r[key] || 0), 0);
      const stages = [
        { label: 'Impressions', value: sum('impressions') },
        { label: 'Link Clicks', value: sum('link_clicks') },
        { label: 'Landing Page Views', value: sum('landing_page_views') },
        { label: 'Results', value: sum('results') },
      ];
      return res.json({ data: chart.buildFunnelChart(stages), date_range: dateRange });
    }

    case 'ranking': {
      if (!req.query.adset_id) return res.status(400).json({ error: 'ranking requires ?adset_id=' });
      const metaAdsetId = loadAdsetMetaId(req.query.adset_id);
      if (!metaAdsetId) return res.status(404).json({ error: 'Ad set not found' });
      const comparison = creativeLibrary.getAdSetComparison(metaAdsetId, dateRange);
      return res.json({ data: chart.buildRankingChart(comparison.ranking, { labelKey: 'ad_name', valueKey: 'score' }), date_range: dateRange });
    }

    case 'retention_curve': {
      if (!req.query.ad_id) return res.status(400).json({ error: 'retention_curve requires ?ad_id=' });
      const row = rows.find(r => r.meta_ad_id === req.query.ad_id) ||
        db.get('SELECT * FROM creative_analytics WHERE meta_ad_id = ? ORDER BY date_until DESC LIMIT 1', [req.query.ad_id]);
      if (!row) return res.status(404).json({ error: 'Creative not found' });
      return res.json({ data: chart.buildRetentionCurve(row), date_range: dateRange });
    }

    case 'fatigue_timeline':
    case 'trend': {
      if (!req.query.ad_id) return res.status(400).json({ error: `${type} requires ?ad_id=` });
      const timeline = creativeLibrary.getCreativeTimeline(req.query.ad_id);
      const metricKeys = (req.query.metrics || (type === 'trend' ? 'ctr,roas,score_overall' : 'score_overall')).split(',');
      return res.json({ data: chart.buildLineChart(timeline.snapshots, { dateKey: 'date_since', metricKeys }), timeline_events: timeline.events, date_range: dateRange });
    }

    default:
      return res.status(400).json({
        error: `Unsupported chart type: ${type}`,
        valid_types: ['score_distribution', 'ctr_by_creative', 'roas_by_creative', 'ranking', 'retention_curve', 'fatigue_timeline', 'trend', 'funnel', 'scatter', 'bubble', 'heatmap'],
      });
  }
}));

// ─────────────────────────────────────────────
// GET /:adId — Step 10: Creative Details page
// ─────────────────────────────────────────────
router.get('/:adId', asyncHandler(async (req, res) => {
  if (rejectMockInProduction(req, res)) return;

  const result = await creativeLibrary.getCreativeDetails(req.params.adId, { useMock: isMockRequested(req) });
  if (!result) return res.status(404).json({ error: 'Ad not found', id: req.params.adId });

  return res.json({ data: result });
}));

// ─────────────────────────────────────────────
// GET /:adId/timeline — Step 8: Creative Timeline
// ─────────────────────────────────────────────
router.get('/:adId/timeline', asyncHandler(async (req, res) => {
  const ad = db.get('SELECT meta_ad_id FROM ads WHERE id = ? OR meta_ad_id = ?', [req.params.adId, req.params.adId]);
  if (!ad) return res.status(404).json({ error: 'Ad not found', id: req.params.adId });

  return res.json({ data: creativeLibrary.getCreativeTimeline(ad.meta_ad_id) });
}));

module.exports = router;
