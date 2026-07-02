/**
 * Ad Sets Route — Phase 6B
 *
 * GET /api/v1/adsets                      — list all ad sets with latest health score
 * GET /api/v1/adsets/:id                  — single ad set detail
 * GET /api/v1/adsets/:id/insights         — full intelligence pipeline
 * GET /api/v1/adsets/:id/history          — health score history
 * GET /api/v1/adsets/:id/score-breakdown  — formatted score explanation
 */

const express = require('express');
const router  = express.Router();
const db      = require('../../db/database');
const { runAdSetIntelligence, getAdSetsList } = require('../../services/adSetIntelligence');
const { buildComparisons } = require('../../services/comparisonEngine');
const { formatScoreBreakdown }                = require('../../services/scoreBreakdownService');
const { resolveDateRange }                    = require('../../services/dateRangeHelper');
const { asyncHandler }                        = require('../../middleware/errorHandler');
const { isMockRequested, rejectMockInProduction } = require('../../services/mockGuard');

// ─────────────────────────────────────────────
// GET /adsets
// ─────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const { campaign_id, account_id, status, optimization_goal, limit: lp = '100', offset: op = '0' } = req.query;
  const limit  = Math.min(Math.max(parseInt(lp, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(op, 10) || 0, 0);

  const allAdSets = getAdSetsList({ campaign_id, account_id, status, optimization_goal });
  const page = allAdSets.slice(offset, offset + limit);

  return res.json({
    data:  page,
    meta:  { total: allAdSets.length, limit, offset, returned: page.length },
  });
}));

// ─────────────────────────────────────────────
// GET /adsets/:id
// ─────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const adSet = db.get(
    `SELECT s.*, c.meta_campaign_id, c.name as campaign_name, c.objective,
            a.account_name, a.currency
     FROM ad_sets s
     JOIN campaigns c ON s.campaign_id = c.id
     JOIN ad_accounts a ON s.ad_account_id = a.id
     WHERE s.id = ? OR s.meta_adset_id = ?`,
    [id, id]
  );

  if (!adSet) return res.status(404).json({ error: 'Ad set not found', id });

  const latest = db.get(
    `SELECT health_score, health_status, calculated_at
     FROM health_score_history
     WHERE entity_meta_id = ? AND entity_type = 'ad_set'
     ORDER BY calculated_at DESC LIMIT 1`,
    [adSet.meta_adset_id]
  );

  const recCount = db.get(
    `SELECT COUNT(*) as count FROM recommendation_log
     WHERE entity_meta_id = ? AND dismissed_at IS NULL`,
    [adSet.meta_adset_id]
  );

  const alertCount = db.get(
    `SELECT COUNT(*) as count FROM active_alerts
     WHERE entity_meta_id = ? AND status = 'active'`,
    [adSet.meta_adset_id]
  );

  return res.json({
    data: {
      ...adSet,
      health_score:         latest?.health_score   || null,
      health_status:        latest?.health_status  || null,
      last_scored_at:       latest?.calculated_at  || null,
      recommendation_count: recCount?.count        || 0,
      alert_count:          alertCount?.count       || 0,
    },
  });
}));

// ─────────────────────────────────────────────
// GET /adsets/:id/insights
// ─────────────────────────────────────────────
router.get('/:id/insights', asyncHandler(async (req, res) => {
  if (rejectMockInProduction(req, res)) return;
  const { id }  = req.params;
  const useMock = isMockRequested(req);

  const result = await runAdSetIntelligence(id, {
    useMock,
    dateRange: resolveDateRange(req.query),
  });

  if (!result) return res.status(404).json({ error: 'Ad set not found', id });

  result.comparisons = buildComparisons(result.metrics, result.prior_metrics, result.deltas, req.query.preset || 'last_7_days');

  return res.json(result);
}));

// ─────────────────────────────────────────────
// GET /adsets/:id/history
// ─────────────────────────────────────────────
router.get('/:id/history', asyncHandler(async (req, res) => {
  const { id }       = req.params;
  const { days = '30' } = req.query;
  const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);

  const adSet = db.get(
    'SELECT meta_adset_id, name FROM ad_sets WHERE id = ? OR meta_adset_id = ?',
    [id, id]
  );
  if (!adSet) return res.status(404).json({ error: 'Ad set not found', id });

  const history = db.all(
    `SELECT health_score, health_status, score_reference, calculated_at
     FROM health_score_history
     WHERE entity_meta_id = ? AND entity_type = 'ad_set'
       AND calculated_at >= datetime('now', ?)
     ORDER BY calculated_at ASC`,
    [adSet.meta_adset_id, `-${n} days`]
  );

  return res.json({
    data:            history,
    entity_meta_id:  adSet.meta_adset_id,
    entity_name:     adSet.name,
    entity_type:     'ad_set',
    days_requested:  n,
  });
}));

// ─────────────────────────────────────────────
// GET /adsets/:id/score-breakdown
// ─────────────────────────────────────────────
router.get('/:id/score-breakdown', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const adSet = db.get(
    `SELECT s.meta_adset_id, s.name, a.currency
     FROM ad_sets s
     JOIN ad_accounts a ON s.ad_account_id = a.id
     WHERE s.id = ? OR s.meta_adset_id = ?`,
    [id, id]
  );
  if (!adSet) return res.status(404).json({ error: 'Ad set not found', id });

  const breakdown = formatScoreBreakdown(adSet.meta_adset_id, 'ad_set', adSet.currency);
  return res.json({ data: breakdown });
}));

module.exports = router;
