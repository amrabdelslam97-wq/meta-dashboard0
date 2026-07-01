/**
 * Health History Route — Phase 3
 *
 * GET /api/v1/health-history?entity_meta_id=&days=30
 *   Returns health score trend data for chart rendering.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { asyncHandler } = require('../../middleware/errorHandler');

router.get('/', asyncHandler(async (req, res) => {
  const { entity_meta_id, entity_type = 'campaign', days = '30', since, until } = req.query;

  let dateFilter = '';
  const params = [];

  if (since && until) {
    dateFilter = 'AND calculated_at >= ? AND calculated_at <= ?';
    params.push(since, until + 'T23:59:59');
  } else {
    const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    dateFilter = `AND calculated_at >= datetime('now', '-${n} days')`;
  }

  if (entity_meta_id) {
    const rows = db.all(
      `SELECT health_score, health_status, score_reference, calculated_at
       FROM health_score_history
       WHERE entity_meta_id = ? AND entity_type = ? ${dateFilter}
       ORDER BY calculated_at ASC`,
      [entity_meta_id, entity_type, ...params]
    );
    return res.json({ data: rows, entity_meta_id, entity_type });
  }

  // All campaigns — return latest per campaign for overview
  const latest = db.all(`
    SELECT h.entity_meta_id, h.entity_label, h.health_score, h.health_status,
           h.calculated_at, c.name, c.objective
    FROM health_score_history h
    INNER JOIN (
      SELECT entity_meta_id, MAX(calculated_at) as latest
      FROM health_score_history WHERE entity_type = 'campaign'
      GROUP BY entity_meta_id
    ) m ON h.entity_meta_id = m.entity_meta_id AND h.calculated_at = m.latest
    LEFT JOIN campaigns c ON c.meta_campaign_id = h.entity_meta_id
    ORDER BY h.health_score DESC
  `);

  return res.json({ data: latest });
}));

module.exports = router;
