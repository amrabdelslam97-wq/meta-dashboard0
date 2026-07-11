/**
 * Dashboard Route — Phase 3
 *
 * GET /api/v1/dashboard
 *   Returns aggregated control center data:
 *   - account summary counts
 *   - alert counts by severity
 *   - average health score
 *   - top 10 campaigns by health score
 *   - recommendation counts
 *
 * All data comes from existing DB tables — no new Meta API calls.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { resolveDateRange } = require('../../services/dateRangeHelper');
const { asyncHandler } = require('../../middleware/errorHandler');

router.get('/', asyncHandler(async (req, res) => {
  // ── Date range + optional account filter (Phase 6C) ──
  const { account_id } = req.query;
  const dateRange = resolveDateRange(req.query);
  // Date filter for health_score_history (only when explicitly set)
  const hasDateFilter = !!(req.query.preset || (req.query.since && req.query.until));
  const dateClause  = hasDateFilter ? 'AND calculated_at >= ? AND calculated_at <= ?' : '';
  const dateParams  = hasDateFilter ? [dateRange.since, dateRange.until + 'T23:59:59'] : [];
  // Account filter clause — applied to every query with an account dimension.
  // health_score_history/active_alerts/recommendation_log all carry
  // ad_account_id directly (no join needed); campaigns carries it natively.
  const acctClause  = account_id ? 'AND ad_account_id = ?' : '';
  const acctParamsFirst = account_id ? [account_id] : [];

  // ── Account summary (portfolio-wide by design — not scoped by account_id,
  // since it answers "how many accounts exist", which is meaningful
  // regardless of which single account the rest of the dashboard is
  // currently filtered to) ──
  const accountCounts = db.get(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
    FROM ad_accounts
  `);

  // ── Campaign counts ──
  const campaignCounts = db.get(
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
    FROM campaigns
    WHERE 1=1 ${account_id ? 'AND ad_account_id = ?' : ''}`,
    account_id ? [account_id] : []
  );

  // ── Average health score from history (latest per campaign) ──
  const avgHealth = db.get(
    `SELECT AVG(h.health_score) as avg_score
     FROM health_score_history h
     INNER JOIN (
       SELECT entity_meta_id, MAX(calculated_at) as latest
       FROM health_score_history
       WHERE entity_type = 'campaign' ${dateClause} ${acctClause}
       GROUP BY entity_meta_id
     ) latest ON h.entity_meta_id = latest.entity_meta_id
              AND h.calculated_at = latest.latest`,
    [...dateParams, ...acctParamsFirst]
  );

  // ── Alert counts ──
  const alertCounts = db.get(
    `SELECT
      SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN severity = 'warning'  THEN 1 ELSE 0 END) as warning,
      SUM(CASE WHEN severity = 'info'     THEN 1 ELSE 0 END) as info,
      COUNT(*) as total
    FROM active_alerts
    WHERE status = 'active'
      AND (snoozed_until IS NULL OR snoozed_until < datetime('now'))
      ${acctClause}`,
    acctParamsFirst
  );

  // ── Recommendation counts ──
  const recCounts = db.get(
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN severity = 'warning'  THEN 1 ELSE 0 END) as warning,
      SUM(CASE WHEN action_taken = 1 THEN 1 ELSE 0 END) as completed
    FROM recommendation_log
    WHERE dismissed_at IS NULL
      ${acctClause}`,
    acctParamsFirst
  );

  // ── Top 10 campaigns by latest health score (scoped to account_id and
  // to the requested date range, matching what the response's date_range/
  // account_filter fields already claim to represent) ──
  const topCampaigns = db.all(
    `SELECT
      c.id,
      c.meta_campaign_id,
      c.name,
      c.objective,
      c.status,
      c.effective_status,
      h.health_score,
      h.health_status,
      h.calculated_at as score_calculated_at,
      (
        SELECT COUNT(*) FROM recommendation_log r
        WHERE r.entity_meta_id = c.meta_campaign_id
          AND r.dismissed_at IS NULL
      ) as recommendation_count,
      (
        SELECT COUNT(*) FROM active_alerts a
        WHERE a.entity_meta_id = c.meta_campaign_id
          AND a.status = 'active'
          AND (a.snoozed_until IS NULL OR a.snoozed_until < datetime('now'))
      ) as alert_count,
      a.account_name,
      a.currency
    FROM campaigns c
    JOIN ad_accounts a ON c.ad_account_id = a.id
    LEFT JOIN health_score_history h ON h.entity_meta_id = c.meta_campaign_id
      AND h.entity_type = 'campaign'
      AND h.calculated_at = (
        SELECT MAX(h2.calculated_at)
        FROM health_score_history h2
        WHERE h2.entity_meta_id = c.meta_campaign_id
          AND h2.entity_type = 'campaign'
          ${dateClause}
      )
    WHERE 1=1 ${account_id ? 'AND c.ad_account_id = ?' : ''}
    ORDER BY COALESCE(h.health_score, -1) DESC
    LIMIT 10`,
    [...dateParams, ...(account_id ? [account_id] : [])]
  );

  // ── Campaigns needing attention (critical/warning), scoped the same way ──
  const needsAttention = db.all(
    `SELECT DISTINCT
      c.id,
      c.meta_campaign_id,
      c.name,
      c.objective,
      h.health_score,
      h.health_status,
      COUNT(al.id) as alert_count
    FROM campaigns c
    JOIN ad_accounts a ON c.ad_account_id = a.id
    LEFT JOIN health_score_history h ON h.entity_meta_id = c.meta_campaign_id
      AND h.entity_type = 'campaign'
      AND h.calculated_at = (
        SELECT MAX(h2.calculated_at) FROM health_score_history h2
        WHERE h2.entity_meta_id = c.meta_campaign_id AND h2.entity_type = 'campaign'
          ${dateClause}
      )
    LEFT JOIN active_alerts al ON al.entity_meta_id = c.meta_campaign_id
      AND al.status = 'active'
      AND al.severity = 'critical'
    WHERE (h.health_status IN ('warning','critical') OR al.id IS NOT NULL)
      ${account_id ? 'AND c.ad_account_id = ?' : ''}
    GROUP BY c.id
    ORDER BY COALESCE(h.health_score, 100) ASC
    LIMIT 5`,
    [...dateParams, ...(account_id ? [account_id] : [])]
  );

  return res.json({
    summary: {
      accounts:    { total: accountCounts.total || 0, active: accountCounts.active || 0 },
      campaigns:   { total: campaignCounts.total || 0, active: campaignCounts.active || 0 },
      health:      { average: avgHealth.avg_score ? Math.round(avgHealth.avg_score) : null },
      alerts:      { critical: alertCounts.critical || 0, warning: alertCounts.warning || 0, info: alertCounts.info || 0, total: alertCounts.total || 0 },
      recommendations: { total: recCounts.total || 0, critical: recCounts.critical || 0, completed: recCounts.completed || 0 },
    },
    top_campaigns:     topCampaigns,
    needs_attention:   needsAttention,
    date_range:        dateRange,
    account_filter:    account_id || null,
    generated_at:      new Date().toISOString(),
  });
}));

module.exports = router;
