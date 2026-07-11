/**
 * Attribution Intelligence Router — Phase 8
 *
 * Deep attribution analysis for WHERE results came from, WHY they happened,
 * and WHO/HOW/WHICH platform deserves the credit/budget.
 *
 * Every route reads already-synced data (no live Meta calls) from Phase 22
 * attribution tables. POST /attribution/sync is the one exception -- an
 * on-demand "Force Sync"-style manual refresh for a single account, reusing
 * the exact same sync functions the Smart Scheduler's 'analytics' tier calls.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { resolveDateRange } = require('../../services/dateRangeHelper');
const { asyncHandler } = require('../../middleware/errorHandler');

// Attribution Engines
const conversationAttributionEngine = require('../../services/conversationAttributionEngine');
const placementAttributionEngine = require('../../services/placementAttributionEngine');
const creativeAttributionEngine = require('../../services/creativeAttributionEngine');
const audienceAttributionEngine = require('../../services/audienceAttributionEngine');
const customerJourneyEngine = require('../../services/customerJourneyEngine');
const attributionWindowEngine = require('../../services/attributionWindowEngine');
const languageAttributionEngine = require('../../services/languageAttributionEngine');
const messagingAnalytics = require('../../services/messagingAnalytics');
const budgetDistributionAnalytics = require('../../services/budgetDistributionAnalytics');
const smartSyncEngine = require('../../services/smartSyncEngine');

function loadCampaignMetaId(idOrMetaId) {
  const row = db.get(
    'SELECT meta_campaign_id FROM campaigns WHERE id = ? OR meta_campaign_id = ?',
    [idOrMetaId, idOrMetaId]
  );
  return row?.meta_campaign_id || null;
}

function loadAccountId(idOrMetaId) {
  const row = db.get(
    'SELECT id FROM ad_accounts WHERE id = ? OR meta_account_id = ?',
    [idOrMetaId, idOrMetaId]
  );
  return row?.id || null;
}

// ── Step 1: Conversation Attribution ─────────────────────────────
// WHERE conversations came from by destination (Messenger/WhatsApp/Instagram)
router.get('/conversations/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = conversationAttributionEngine.getConversationAttribution(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Step 3: Placement Attribution ────────────────────────────────
// Deep placement analysis: Facebook Feed, Instagram Reels, Stories, etc.
router.get('/placement/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = placementAttributionEngine.getPlacementAttribution(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Step 8: Geographic Attribution ──────────────────────────────
// Deep hierarchy: Country → Region → DMA (US-only)
router.get('/geographic/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const level = req.query.level || 'country';
  const dateRange = resolveDateRange(req.query);
  const data = placementAttributionEngine.getGeographicAttribution(metaCampaignId, level, dateRange);

  return res.json({ data });
}));

// ── Step 9: Audience Attribution ────────────────────────────────
// Compare performance by audience type: Broad, Interest, Custom, Lookalike, Advantage+, Remarketing
router.get('/audience/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = audienceAttributionEngine.getAudienceAttribution(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Step 10: Device Attribution ────────────────────────────────
// Desktop, Mobile (Android/iPhone), Tablet, Web
router.get('/device/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dimension = req.query.dimension === 'device_platform' ? 'device_platform' : 'impression_device';
  const dateRange = resolveDateRange(req.query);
  const data = placementAttributionEngine.getDeviceAttribution(metaCampaignId, dimension, dateRange);

  return res.json({ data });
}));


// ── Step 12: Creative Attribution ───────────────────────────────
// Which Hook, Headline, CTA, Visual, Offer drove more Messages/Sales/Higher ROAS/Better Retention/Lower CPA
router.get('/creative/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = creativeAttributionEngine.getCreativeAttribution(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Step 4 & 13: Customer Journey Funnel ────────────────────────
// Professional funnel: Impressions → Reach → Clicks → Landing → Conversations → Purchases → Revenue
router.get('/journey/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = customerJourneyEngine.getCustomerJourney(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Step 5: Attribution Window Comparison ─────────────────────────
// Compare results/CPA/ROAS under 1d_click, 7d_click, 1d_view attribution windows
router.get('/attribution-windows/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = attributionWindowEngine.getAttributionWindowComparison(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Step 11: Language Attribution ──────────────────────────────────
// Performance by targeted language
router.get('/language/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const dateRange = resolveDateRange(req.query);
  const data = languageAttributionEngine.getLanguageAttribution(metaCampaignId, dateRange);

  return res.json({ data });
}));

// ── Manual sync (Force Sync-style, for one account) ──────────────
// Reuses smartSyncEngine.runAnalyticsTier() directly -- the exact same function
// the Smart Scheduler calls, checkpointed/logged identically.
router.post('/sync', asyncHandler(async (req, res) => {
  const { account_id } = req.body || {};
  if (!account_id) return res.status(400).json({ error: 'account_id is required' });

  const account = db.get("SELECT * FROM ad_accounts WHERE id = ? AND status = 'active' AND token_is_valid = 1", [account_id]);
  if (!account) return res.status(404).json({ error: 'Account not found or not active' });

  await smartSyncEngine.runAnalyticsTier(account, 'force');

  return res.json({
    success: true,
    message: 'Attribution sync complete.',
    history: smartSyncEngine.getSyncHistory(1, account_id),
  });
}));

module.exports = router;
