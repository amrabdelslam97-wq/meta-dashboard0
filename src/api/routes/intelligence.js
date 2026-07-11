/**
 * Intelligence Router — Phase 20
 *
 * Comprehensive audience, placement, device, publisher platform, and creative
 * intelligence for campaigns. Integrates with decision engine, recommendations,
 * and executive summary.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { resolveDateRange } = require('../../services/dateRangeHelper');
const { asyncHandler } = require('../../middleware/errorHandler');

const audienceIntelligenceEngine = require('../../services/audienceIntelligenceEngine');
const placementIntelligenceEngine = require('../../services/placementIntelligenceEngine');
const deviceIntelligenceEngine = require('../../services/deviceIntelligenceEngine');
const publisherPlatformIntelligenceEngine = require('../../services/publisherPlatformIntelligenceEngine');
const creativeIntelligenceEngine = require('../../services/creativeIntelligenceEngine');

function loadCampaignMetaId(idOrMetaId) {
  const row = db.get(
    'SELECT meta_campaign_id FROM campaigns WHERE id = ? OR meta_campaign_id = ?',
    [idOrMetaId, idOrMetaId]
  );
  return row?.meta_campaign_id || null;
}

// ── Audience Intelligence ──────────────────────────────────────────

router.get('/audience/:campaignId/:dimension', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dimension = req.params.dimension || 'age_gender';
  const dateRange = resolveDateRange(req.query);
  const data = audienceIntelligenceEngine.getAudienceBreakdown(metaCampaignId, dimension, dateRange);

  return res.json({ data });
}));

router.get('/audience-types/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = audienceIntelligenceEngine.getAudienceTypePerformance(metaCampaignId, dateRange);

  return res.json({ data });
}));

router.get('/audience-opportunities/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dimension = req.query.dimension || 'age_gender';
  const dateRange = resolveDateRange(req.query);
  const data = audienceIntelligenceEngine.detectAudienceOpportunities(metaCampaignId, dimension, dateRange);

  return res.json({ data });
}));

router.get('/audience-recommendations/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = audienceIntelligenceEngine.generateAudienceRecommendations(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Placement Intelligence ───────────────────────────────────────────

router.get('/placement/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = placementIntelligenceEngine.getPlacementPerformance(metaCampaignId, dateRange);

  return res.json({ data });
}));

router.get('/placement-issues/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = placementIntelligenceEngine.detectPlacementIssues(metaCampaignId, dateRange);

  return res.json({ data });
}));

router.get('/placement-recommendations/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = placementIntelligenceEngine.generatePlacementRecommendations(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Device Intelligence ────────────────────────────────────────────

router.get('/device/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = deviceIntelligenceEngine.getDevicePerformance(metaCampaignId, dateRange);

  return res.json({ data });
}));

router.get('/device-issues/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = deviceIntelligenceEngine.detectDeviceIssues(metaCampaignId, dateRange);

  return res.json({ data });
}));

router.get('/device-recommendations/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = deviceIntelligenceEngine.generateDeviceRecommendations(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Publisher Platform Intelligence ────────────────────────────────

router.get('/platform/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = publisherPlatformIntelligenceEngine.getPlatformPerformance(metaCampaignId, dateRange);

  return res.json({ data });
}));

router.get('/messaging-platforms/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = publisherPlatformIntelligenceEngine.getMessagingPlatformAnalysis(metaCampaignId, dateRange);

  return res.json({ data });
}));

router.get('/platform-recommendations/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = publisherPlatformIntelligenceEngine.generatePlatformRecommendations(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Creative Intelligence (expanded) ───────────────────────────────

router.get('/creative/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  // Integration with existing creativeIntelligenceEngine
  // TODO: expand with new creative analysis

  return res.json({
    data: {
      date_range: dateRange,
      note: 'Creative intelligence endpoint — under development',
    },
  });
}));

// ── Master Intelligence Dashboard ──────────────────────────────────

router.get('/master/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);

  const audience = audienceIntelligenceEngine.getAudienceBreakdown(metaCampaignId, 'age_gender', dateRange);
  const audienceOpportunities = audienceIntelligenceEngine.detectAudienceOpportunities(metaCampaignId, 'age_gender', dateRange);
  const audienceRecs = audienceIntelligenceEngine.generateAudienceRecommendations(metaCampaignId, dateRange);

  const placement = placementIntelligenceEngine.getPlacementPerformance(metaCampaignId, dateRange);
  const placementIssues = placementIntelligenceEngine.detectPlacementIssues(metaCampaignId, dateRange);
  const placementRecs = placementIntelligenceEngine.generatePlacementRecommendations(metaCampaignId, dateRange);

  const device = deviceIntelligenceEngine.getDevicePerformance(metaCampaignId, dateRange);
  const deviceRecs = deviceIntelligenceEngine.generateDeviceRecommendations(metaCampaignId, dateRange);

  const platform = publisherPlatformIntelligenceEngine.getPlatformPerformance(metaCampaignId, dateRange);
  const platformRecs = publisherPlatformIntelligenceEngine.generatePlatformRecommendations(metaCampaignId, dateRange);

  return res.json({
    data: {
      date_range: dateRange,
      campaign: metaCampaignId,
      audience_intelligence: {
        best_segment: audience.best_segment,
        opportunities: audienceOpportunities.opportunities.length,
        recommendations_count: audienceRecs.total_count,
      },
      placement_intelligence: {
        best_placement: placement.best_ctr_placement?.placement_label,
        issues: placementIssues.issues.length,
        opportunities: placementIssues.opportunities.length,
        recommendations_count: placementRecs.total_recommendations,
      },
      device_intelligence: {
        best_device: device.best_device?.device_label,
        worst_device: device.worst_device?.device_label,
        recommendations_count: deviceRecs.total_recommendations,
      },
      platform_intelligence: {
        best_platform: platform.best_platform?.platform,
        messaging_platforms_count: platform.platforms.filter(p => ['Facebook', 'Instagram', 'Messenger'].includes(p.platform)).length,
        recommendations_count: platformRecs.total_recommendations,
      },
      total_recommendations: audienceRecs.total_count + placementRecs.total_recommendations + deviceRecs.total_recommendations + platformRecs.total_recommendations,
    },
  });
}));

module.exports = router;
