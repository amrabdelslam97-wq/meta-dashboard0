/**
 * Ads Route — Phase 6B
 *
 * GET /api/v1/ads                      — list all ads with latest health score
 * GET /api/v1/ads/:id                  — single ad detail
 * GET /api/v1/ads/:id/insights         — full intelligence pipeline
 * GET /api/v1/ads/:id/history          — health score history
 * GET /api/v1/ads/:id/score-breakdown  — formatted score explanation
 */

const express = require('express');
const router  = express.Router();
const db      = require('../../db/database');
const { runAdIntelligence, getAdsList } = require('../../services/adIntelligence');
const { buildComparisons } = require('../../services/comparisonEngine');
const { formatScoreBreakdown }          = require('../../services/scoreBreakdownService');
const { resolveDateRange }              = require('../../services/dateRangeHelper');
const { asyncHandler }                  = require('../../middleware/errorHandler');

// ─────────────────────────────────────────────
// GET /ads
// ─────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const { adset_id, campaign_id, account_id, status, limit: lp = '100', offset: op = '0' } = req.query;
  const limit  = Math.min(Math.max(parseInt(lp, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(op, 10) || 0, 0);

  const allAds = getAdsList({ adset_id, campaign_id, account_id, status });
  const page   = allAds.slice(offset, offset + limit);

  return res.json({
    data: page,
    meta: { total: allAds.length, limit, offset, returned: page.length },
  });
}));

// ─────────────────────────────────────────────
// GET /ads/:id
// ─────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const ad = db.get(
    `SELECT ad.*, s.meta_adset_id, s.name as adset_name,
            c.meta_campaign_id, c.name as campaign_name, c.objective,
            a.account_name, a.currency
     FROM ads ad
     JOIN ad_sets s ON ad.ad_set_id = s.id
     JOIN campaigns c ON ad.campaign_id = c.id
     JOIN ad_accounts a ON ad.ad_account_id = a.id
     WHERE ad.id = ? OR ad.meta_ad_id = ?`,
    [id, id]
  );

  if (!ad) return res.status(404).json({ error: 'Ad not found', id });

  const latest = db.get(
    `SELECT health_score, health_status, calculated_at
     FROM health_score_history
     WHERE entity_meta_id = ? AND entity_type = 'ad'
     ORDER BY calculated_at DESC LIMIT 1`,
    [ad.meta_ad_id]
  );

  const recCount = db.get(
    `SELECT COUNT(*) as count FROM recommendation_log
     WHERE entity_meta_id = ? AND dismissed_at IS NULL`,
    [ad.meta_ad_id]
  );

  const alertCount = db.get(
    `SELECT COUNT(*) as count FROM active_alerts
     WHERE entity_meta_id = ? AND status = 'active'`,
    [ad.meta_ad_id]
  );

  return res.json({
    data: {
      ...ad,
      health_score:         latest?.health_score   || null,
      health_status:        latest?.health_status  || null,
      last_scored_at:       latest?.calculated_at  || null,
      recommendation_count: recCount?.count        || 0,
      alert_count:          alertCount?.count       || 0,
    },
  });
}));

// ─────────────────────────────────────────────
// GET /ads/:id/insights
// ─────────────────────────────────────────────
router.get('/:id/insights', asyncHandler(async (req, res) => {
  const { id }  = req.params;
  const useMock = req.query.mock === 'true';

  const result = await runAdIntelligence(id, {
    useMock,
    dateRange: resolveDateRange(req.query),
  });

  if (!result) return res.status(404).json({ error: 'Ad not found', id });

  result.comparisons = buildComparisons(result.metrics, result.prior_metrics, result.deltas, req.query.preset || 'last_7_days');

  return res.json(result);
}));

// ─────────────────────────────────────────────
// GET /ads/:id/history
// ─────────────────────────────────────────────
router.get('/:id/history', asyncHandler(async (req, res) => {
  const { id }       = req.params;
  const { days = '30' } = req.query;
  const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);

  const ad = db.get(
    'SELECT meta_ad_id, name FROM ads WHERE id = ? OR meta_ad_id = ?',
    [id, id]
  );
  if (!ad) return res.status(404).json({ error: 'Ad not found', id });

  const history = db.all(
    `SELECT health_score, health_status, score_reference, calculated_at
     FROM health_score_history
     WHERE entity_meta_id = ? AND entity_type = 'ad'
       AND calculated_at >= datetime('now', ?)
     ORDER BY calculated_at ASC`,
    [ad.meta_ad_id, `-${n} days`]
  );

  return res.json({
    data:           history,
    entity_meta_id: ad.meta_ad_id,
    entity_name:    ad.name,
    entity_type:    'ad',
    days_requested: n,
  });
}));

// ─────────────────────────────────────────────
// GET /ads/:id/score-breakdown
// ─────────────────────────────────────────────
router.get('/:id/score-breakdown', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const ad = db.get(
    `SELECT ad.meta_ad_id, ad.name, a.currency
     FROM ads ad
     JOIN ad_accounts a ON ad.ad_account_id = a.id
     WHERE ad.id = ? OR ad.meta_ad_id = ?`,
    [id, id]
  );
  if (!ad) return res.status(404).json({ error: 'Ad not found', id });

  const breakdown = formatScoreBreakdown(ad.meta_ad_id, 'ad', ad.currency);
  return res.json({ data: breakdown });
}));

module.exports = router;
