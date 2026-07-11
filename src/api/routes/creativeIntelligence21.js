/**
 * Creative Intelligence Router — Phase 21
 *
 * Complete creative analysis: profiles, assets, performance, scoring,
 * fatigue detection, insights, timeline, and recommendations.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { asyncHandler } = require('../../middleware/errorHandler');

const creativeProfileEngine = require('../../services/creativeProfileEngine');
const creativeScoringEngine = require('../../services/creativeScoringEngine');
const creativeFatigueEngine = require('../../services/creativeFatigueEngine');
const creativeInsightsEngine = require('../../services/creativeInsightsEngine');

// ── Creative Profile ───────────────────────────────────────

router.get('/profile/:adId', asyncHandler(async (req, res) => {
  const profile = creativeProfileEngine.getCreativeProfile(req.params.adId);

  if (profile.error) {
    return res.status(404).json({ error: profile.error });
  }

  return res.json({ data: profile });
}));

// ── Creative Assets ───────────────────────────────────────

router.get('/assets/:adId', asyncHandler(async (req, res) => {
  const assets = creativeProfileEngine.getCreativeAssets(req.params.adId);

  if (assets.error) {
    return res.status(404).json({ error: assets.error });
  }

  return res.json({ data: assets });
}));

// ── Creative Score ────────────────────────────────────────

router.get('/score/:adId', asyncHandler(async (req, res) => {
  const score = creativeScoringEngine.calculateCreativeScore(req.params.adId);

  return res.json({ data: score });
}));

router.get('/scores/campaign/:campaignId', asyncHandler(async (req, res) => {
  const scores = creativeScoringEngine.scoreCreativesByCampaign(req.params.campaignId);

  return res.json({ data: scores });
}));

// ── Creative Fatigue ──────────────────────────────────────

router.get('/fatigue/:adId', asyncHandler(async (req, res) => {
  const fatigue = creativeFatigueEngine.detectCreativeFatigue(req.params.adId);

  return res.json({ data: fatigue });
}));

router.get('/fatigue/campaign/:campaignId', asyncHandler(async (req, res) => {
  const fatigue = creativeFatigueEngine.detectCampaignFatigue(req.params.campaignId);

  return res.json({ data: fatigue });
}));

// ── Creative Insights ─────────────────────────────────────

router.get('/insights/:adId', asyncHandler(async (req, res) => {
  const insights = creativeInsightsEngine.generateCreativeInsights(req.params.adId);

  return res.json({ data: insights });
}));

router.get('/compare', asyncHandler(async (req, res) => {
  const { ad1, ad2 } = req.query;

  if (!ad1 || !ad2) {
    return res.status(400).json({ error: 'ad1 and ad2 parameters required' });
  }

  const comparison = creativeInsightsEngine.compareCreatives(ad1, ad2);

  return res.json({ data: comparison });
}));

// ── Master Creative Dashboard ─────────────────────────────

router.get('/dashboard/:adId', asyncHandler(async (req, res) => {
  const adId = req.params.adId;

  const profile = creativeProfileEngine.getCreativeProfile(adId);
  const assets = creativeProfileEngine.getCreativeAssets(adId);
  const score = creativeScoringEngine.calculateCreativeScore(adId);
  const fatigue = creativeFatigueEngine.detectCreativeFatigue(adId);
  const insights = creativeInsightsEngine.generateCreativeInsights(adId);

  return res.json({
    data: {
      profile: profile.profile || { error: 'Not found' },
      assets,
      performance: profile.performance,
      scoring: {
        score: score.score,
        status: score.status,
        components: score.components,
      },
      fatigue: {
        status: fatigue.status,
        signals: fatigue.signals,
        recommendation: fatigue.recommendation,
      },
      insights,
    },
  });
}));

// ── Campaign Creatives List ────────────────────────────────

router.get('/campaign/:campaignId', asyncHandler(async (req, res) => {
  const creatives = creativeProfileEngine.listCreativesByCampaign(req.params.campaignId);

  return res.json({ data: creatives });
}));

module.exports = router;
