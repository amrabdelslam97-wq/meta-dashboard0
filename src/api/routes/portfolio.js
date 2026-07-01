/**
 * Portfolio Route — Phase 6C
 *
 * GET /api/v1/portfolio                  — overview card
 * GET /api/v1/portfolio/accounts         — ranked accounts
 * GET /api/v1/portfolio/summary          — aggregate counts + distributions
 * GET /api/v1/portfolio/health           — portfolio health score
 * GET /api/v1/portfolio/objectives       — per-objective KPI summary
 * GET /api/v1/portfolio/alerts           — cross-account alerts
 */

const express = require('express');
const router  = express.Router();
const { resolveDateRange }          = require('../../services/dateRangeHelper');
const { asyncHandler }              = require('../../middleware/errorHandler');
const {
  getPortfolioHealth,
  getAccountRankings,
  getPortfolioSummary,
  getCrossAccountAlerts,
  getPortfolioObjectiveSummary,
} = require('../../services/portfolioEngine');

function dr(req) { return resolveDateRange(req.query); }

router.get('/', asyncHandler(async (req, res) => {
  const dateRange = dr(req);
  const [summary, alerts] = await Promise.all([
    getPortfolioSummary(dateRange),
    getCrossAccountAlerts(),
  ]);
  return res.json({ data: { ...summary, cross_account_alerts: alerts.slice(0, 5), date_range: dateRange } });
}));

router.get('/accounts', asyncHandler(async (req, res) => {
  const rankings = getAccountRankings(dr(req));
  return res.json({ data: rankings, total: rankings.length });
}));

router.get('/summary', asyncHandler(async (req, res) => {
  const summary = getPortfolioSummary(dr(req));
  return res.json({ data: summary });
}));

router.get('/health', asyncHandler(async (req, res) => {
  const health = getPortfolioHealth(dr(req));
  return res.json({ data: health });
}));

router.get('/objectives', asyncHandler(async (req, res) => {
  const summary = getPortfolioObjectiveSummary(dr(req));
  return res.json({ data: summary });
}));

router.get('/alerts', asyncHandler(async (req, res) => {
  const alerts = getCrossAccountAlerts();
  return res.json({ data: alerts, total: alerts.length });
}));

module.exports = router;
