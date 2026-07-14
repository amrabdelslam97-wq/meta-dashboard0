/**
 * Analytics Router — Executive Marketing Analytics Layer (Phase 17)
 *
 * Thin routes only -- every domain's real logic lives in its own service
 * (analyticsEngine.js, creativeAnalytics.js, budgetDistributionAnalytics.js,
 * messagingAnalytics.js, languageAnalytics.js, chartDataBuilder.js). Every
 * GET here reads already-synced data (no live Meta calls, so the Dashboard
 * stays responsive regardless of how heavy the underlying aggregation is);
 * POST /analytics/sync is the one exception -- an on-demand "Force Sync"-
 * style manual refresh for a single account, reusing the exact same sync
 * functions the Smart Scheduler's 'analytics' tier calls automatically.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { resolveDateRange } = require('../../services/dateRangeHelper');
const { asyncHandler } = require('../../middleware/errorHandler');

const analyticsEngine = require('../../services/analyticsEngine');
const creativeAnalytics = require('../../services/creativeAnalytics');
const budgetDistributionAnalytics = require('../../services/budgetDistributionAnalytics');
const messagingAnalytics = require('../../services/messagingAnalytics');
const languageAnalytics = require('../../services/languageAnalytics');
const chart = require('../../services/chartDataBuilder');
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

// ── Audience Analytics ──────────────────────────────────────────
router.get('/audience/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });
  const dimension = ['age', 'gender', 'age_gender'].includes(req.query.dimension) ? req.query.dimension : 'age_gender';
  const dateRange = resolveDateRange(req.query);
  return res.json({ data: analyticsEngine.getBreakdownAnalytics(metaCampaignId, dimension, dateRange) });
}));

// ── Geographic Analytics ─────────────────────────────────────────
router.get('/geographic/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });
  const dimension = ['country', 'region', 'comscore_market'].includes(req.query.dimension) ? req.query.dimension : 'country';
  const dateRange = resolveDateRange(req.query);
  return res.json({ data: analyticsEngine.getBreakdownAnalytics(metaCampaignId, dimension, dateRange) });
}));

// ── Placement Analytics ──────────────────────────────────────────
router.get('/placement/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });
  const dateRange = resolveDateRange(req.query);
  return res.json({ data: analyticsEngine.getBreakdownAnalytics(metaCampaignId, 'placement', dateRange) });
}));

// ── Device Analytics ──────────────────────────────────────────────
router.get('/device/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });
  const dateRange = resolveDateRange(req.query);
  return res.json({ data: analyticsEngine.getBreakdownAnalytics(metaCampaignId, 'impression_device', dateRange) });
}));

// ── Creative Analytics ───────────────────────────────────────────
router.get('/creative/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });
  const dateRange = resolveDateRange(req.query);
  return res.json({ data: creativeAnalytics.getCreativeAnalytics(metaCampaignId, dateRange) });
}));

// ── Messaging Destination Analytics ──────────────────────────────
router.get('/messaging/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });
  const dateRange = resolveDateRange(req.query);
  return res.json({ data: messagingAnalytics.getMessagingDestinationAnalytics(metaCampaignId, dateRange) });
}));

// ── Language Analytics (targeting configuration, not performance -- see languageAnalytics.js) ──
router.get('/language/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });
  return res.json({ data: languageAnalytics.getLanguageTargeting(metaCampaignId) });
}));

// ── Budget Distribution Analytics ────────────────────────────────
router.get('/budget-distribution/:accountId', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req.params.accountId);
  if (!accountId) return res.status(404).json({ error: 'Account not found' });
  const dateRange = resolveDateRange(req.query);
  return res.json({ data: budgetDistributionAnalytics.getBudgetDistribution(accountId, dateRange) });
}));

// ── Executive Charts Layer ───────────────────────────────────────
// GET /analytics/charts/:campaignId?domain=audience|geographic|placement|device|creative
//                                   &dimension=age|gender|age_gender|country|region
//                                   &format=bar|pie|distribution|treemap
router.get('/charts/:campaignId', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });

  const domain = req.query.domain || 'audience';
  const format = req.query.format || 'bar';
  const dateRange = resolveDateRange(req.query);

  let rows, labelKey = 'breakdown_value', valueKey = req.query.metric || 'spend';
  if (domain === 'creative') {
    rows = creativeAnalytics.getCreativeAnalytics(metaCampaignId, dateRange).creatives;
    labelKey = 'headline';
  } else {
    const dimension = req.query.dimension || (domain === 'geographic' ? 'country' : domain === 'device' ? 'impression_device' : domain === 'placement' ? 'placement' : 'age_gender');
    rows = analyticsEngine.getBreakdownAnalytics(metaCampaignId, dimension, dateRange).current;
  }

  const builders = {
    bar: () => chart.buildBarChart(rows, { labelKey, valueKey }),
    pie: () => chart.buildPieChart(rows, { labelKey, valueKey }),
    distribution: () => chart.buildDistributionChart(rows, { labelKey, valueKey }),
    treemap: () => chart.buildTreemap(rows, { labelKey, valueKey }),
  };
  if (!builders[format]) return res.status(400).json({ error: `Unsupported format: ${format}`, valid_formats: Object.keys(builders) });

  return res.json({ data: builders[format](), domain, date_range: dateRange });
}));

// GET /analytics/charts/:campaignId/trend?bucket=day|week|month
router.get('/charts/:campaignId/trend', asyncHandler(async (req, res) => {
  const metaCampaignId = loadCampaignMetaId(req.params.campaignId);
  if (!metaCampaignId) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = db.get(
    `SELECT c.*, a.access_token_encrypted, a.attribution_window_days FROM campaigns c
     JOIN ad_accounts a ON a.id = c.ad_account_id WHERE c.meta_campaign_id = ?`,
    [metaCampaignId]
  );
  const { fetchTrendData } = require('../../services/metricsFetcher');
  const { decryptToken } = require('../../services/tokenCrypto');
  const dateRange = resolveDateRange(req.query);
  const accessToken = decryptToken(campaign.access_token_encrypted);
  const daily = await fetchTrendData(metaCampaignId, accessToken, dateRange.since, dateRange.until, campaign.attribution_window_days);

  const bucket = ['day', 'week', 'month'].includes(req.query.bucket) ? req.query.bucket : 'day';
  const series = bucket === 'day' ? daily : chart.aggregateTrend(daily, bucket);
  const metricKeys = (req.query.metrics || 'spend,results').split(',');

  return res.json({ data: chart.buildLineChart(series, { metricKeys }), bucket, date_range: dateRange });
}));

// ── Manual sync (Force Sync-style, for one account) ──────────────
// Reuses smartSyncEngine.runAnalyticsTier() directly (source: 'force') --
// the exact same function the Smart Scheduler's 'analytics' tier calls
// automatically -- so a manual refresh here is checkpointed/logged into
// sync_entity_state/sync_execution_log identically to every other sync
// path, never a second, unlogged copy of the same three sync calls.
router.post('/sync', asyncHandler(async (req, res) => {
  const { account_id } = req.body || {};
  if (!account_id) return res.status(400).json({ error: 'account_id is required' });

  const account = db.get("SELECT * FROM ad_accounts WHERE id = ? AND status = 'active' AND token_is_valid = 1", [account_id]);
  if (!account) return res.status(404).json({ error: 'Account not found or not active' });

  await smartSyncEngine.runAnalyticsTier(account, 'force');

  return res.json({
    success: true,
    message: 'Analytics sync complete.',
    history: smartSyncEngine.getSyncHistory(1, account_id),
  });
}));

module.exports = router;
