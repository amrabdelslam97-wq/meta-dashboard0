/**
 * Campaigns Router
 *
 * Phase 1: Single endpoint only.
 * GET /campaigns — returns campaigns from the database.
 *
 * Data comes from DB only. Never calls Meta API directly.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { formatScoreBreakdown } = require('../../services/scoreBreakdownService');
const { VALID_OBJECTIVES } = require('../../services/kpiProfileResolver');
const { asyncHandler } = require('../../middleware/errorHandler');

/**
 * GET /campaigns
 *
 * Query parameters (all optional):
 *   account_id  — filter by internal ad_account_id
 *   status      — filter by status: active | paused | archived | deleted
 *   objective   — filter by objective
 *   limit       — max results (default: 100, max: 500)
 *   offset      — pagination offset (default: 0)
 *
 * Response:
 *   {
 *     data: Campaign[],
 *     meta: { total, limit, offset, account_id }
 *   }
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const {
      account_id,
      status,
      objective,
      limit: limitParam = '100',
      offset: offsetParam = '0',
    } = req.query;

    // Validate and clamp pagination
    const limit = Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(offsetParam, 10) || 0, 0);

    // ── Build WHERE clause dynamically ──
    const conditions = [];
    const params = [];

    if (account_id) {
      conditions.push('c.ad_account_id = ?');
      params.push(account_id);
    }

    if (status) {
      const validStatuses = ['active', 'paused', 'archived', 'deleted'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: 'Invalid status filter',
          valid_values: validStatuses,
        });
      }
      conditions.push('c.status = ?');
      params.push(status);
    }

    if (objective) {
      const validObjectives = [...VALID_OBJECTIVES, 'unknown'];
      if (!validObjectives.includes(objective)) {
        return res.status(400).json({
          error: 'Invalid objective filter',
          valid_values: validObjectives,
        });
      }
      conditions.push('c.objective = ?');
      params.push(objective);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // ── Count total matching records ──
    const countRow = db.get(
      `SELECT COUNT(*) as total FROM campaigns c ${whereClause}`,
      params
    );
    const total = countRow?.total || 0;

    // ── Fetch paginated results with account info ──
    const campaigns = db.all(
      `SELECT
        c.id,
        c.meta_campaign_id,
        c.name,
        c.objective,
        c.status,
        c.effective_status,
        c.objective_effective_from,
        c.meta_created_time,
        c.meta_updated_time,
        c.created_at,
        c.updated_at,
        c.ad_account_id,
        a.meta_account_id,
        a.account_name,
        a.client_label,
        a.currency
      FROM campaigns c
      JOIN ad_accounts a ON c.ad_account_id = a.id
      ${whereClause}
      ORDER BY c.meta_created_time DESC, c.name ASC
      LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return res.json({
      data: campaigns,
      meta: {
        total,
        limit,
        offset,
        returned: campaigns.length,
        filters: {
          account_id: account_id || null,
          status: status || null,
          objective: objective || null,
        },
      },
    });
  })
);

/**
 * GET /campaigns/:id
 *
 * Returns a single campaign by internal UUID.
 * Includes its ad sets.
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const campaign = db.get(
      `SELECT
        c.*,
        a.meta_account_id,
        a.account_name,
        a.client_label,
        a.currency
      FROM campaigns c
      JOIN ad_accounts a ON c.ad_account_id = a.id
      WHERE c.id = ?`,
      [id]
    );

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Include ad sets for this campaign
    const adSets = db.all(
      `SELECT * FROM ad_sets WHERE campaign_id = ? ORDER BY name ASC`,
      [id]
    );

    return res.json({
      data: { ...campaign, ad_sets: adSets },
    });
  })
);

/**
 * GET /campaigns/:id/score-breakdown
 */
router.get(
  '/:id/score-breakdown',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const campaign = db.get(
      `SELECT c.meta_campaign_id, c.name, a.currency
       FROM campaigns c JOIN ad_accounts a ON c.ad_account_id = a.id
       WHERE c.id = ? OR c.meta_campaign_id = ?`,
      [id, id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found', id });
    const breakdown = formatScoreBreakdown(campaign.meta_campaign_id, 'campaign', campaign.currency);
    return res.json({ data: breakdown });
  })
);

/**
 * GET /campaigns/:id/history — FIX 5 (Phase 9)
 * Alias to /health-history?entity_meta_id=X&entity_type=campaign
 * for API consistency with adsets/:id/history and ads/:id/history.
 * No duplicated logic — reads from the same health_score_history table.
 */
router.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { days = '30', since, until } = req.query;
    const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);

    const campaign = db.get(
      'SELECT meta_campaign_id, name FROM campaigns WHERE id = ? OR meta_campaign_id = ?',
      [id, id]
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found', id });

    let dateFilter, params;
    if (since && until) {
      dateFilter = 'AND calculated_at >= ? AND calculated_at <= ?';
      params = [campaign.meta_campaign_id, 'campaign', since, until + 'T23:59:59'];
    } else {
      dateFilter = `AND calculated_at >= datetime('now', '-${n} days')`;
      params = [campaign.meta_campaign_id, 'campaign'];
    }

    const history = db.all(
      `SELECT health_score, health_status, score_reference, calculated_at
       FROM health_score_history
       WHERE entity_meta_id = ? AND entity_type = ? ${dateFilter}
       ORDER BY calculated_at ASC`,
      params
    );

    return res.json({
      data:            history,
      entity_meta_id:  campaign.meta_campaign_id,
      entity_name:     campaign.name,
      entity_type:     'campaign',
      days_requested:  n,
    });
  })
);

module.exports = router;
