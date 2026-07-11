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

function loadCampaignMetaId(idOrMetaId) {
  const row = db.get(
    'SELECT meta_campaign_id FROM campaigns WHERE id = ? OR meta_campaign_id = ?',
    [idOrMetaId, idOrMetaId]
  );
  return row?.meta_campaign_id || null;
}

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
