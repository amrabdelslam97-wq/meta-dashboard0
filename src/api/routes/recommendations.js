/**
 * Recommendations Route — Phase 3
 *
 * GET  /api/v1/recommendations         — list with filters
 * PATCH /api/v1/recommendations/:id    — mark complete / dismiss / add note
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { asyncHandler } = require('../../middleware/errorHandler');

// ── GET /recommendations ──────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const { severity, campaign_id, status, limit: lp = '50', offset: op = '0' } = req.query;

  const limit  = Math.min(Math.max(parseInt(lp, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(op, 10) || 0, 0);

  const conditions = [];
  const params = [];

  // status filter
  if (status === 'active') {
    conditions.push('r.dismissed_at IS NULL AND r.action_taken IS NOT 1');
  } else if (status === 'completed') {
    conditions.push('r.action_taken = 1');
  } else if (status === 'dismissed') {
    conditions.push('r.dismissed_at IS NOT NULL');
  } else {
    // default: non-dismissed
    conditions.push('r.dismissed_at IS NULL');
  }

  if (severity) {
    conditions.push('r.severity = ?');
    params.push(severity);
  }
  if (campaign_id) {
    conditions.push('r.entity_meta_id = ?');
    params.push(campaign_id);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.get(
    `SELECT COUNT(*) as c FROM recommendation_log r ${where}`, params
  );

  const rows = db.all(
    `SELECT
       r.id, r.rule_code, r.entity_meta_id, r.entity_label,
       r.objective, r.severity, r.recommendation_title, r.recommendation_body,
       r.metric_snapshot,
       r.health_score_at_generation, r.generated_at, r.last_generated_at,
       r.dismissed_at, r.action_taken, r.action_notes, r.action_taken_at,
       c.name as campaign_name, c.status as campaign_status
     FROM recommendation_log r
     LEFT JOIN campaigns c ON c.meta_campaign_id = r.entity_meta_id
     ${where}
     ORDER BY
       CASE r.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
       r.last_generated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // Parse metric_snapshot JSON
  const data = rows.map(r => ({
    ...r,
    metric_snapshot: r.metric_snapshot ? JSON.parse(r.metric_snapshot) : null,
    action_taken: Boolean(r.action_taken),
  }));

  return res.json({ data, meta: { total: total.c, limit, offset, returned: data.length } });
}));

// ── PATCH /recommendations/:id ────────────────────────────────
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action_taken, action_notes, dismiss } = req.body || {};
  const now = new Date().toISOString();

  const rec = db.get('SELECT id FROM recommendation_log WHERE id = ?', [id]);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found' });

  if (dismiss === true) {
    db.run('UPDATE recommendation_log SET dismissed_at = ?, updated_at = ? WHERE id = ?',
      [now, now, id]);
  }
  if (action_taken !== undefined) {
    db.run(
      `UPDATE recommendation_log
       SET action_taken = ?, action_taken_at = ?, updated_at = ? WHERE id = ?`,
      [action_taken ? 1 : 0, action_taken ? now : null, now, id]
    );
  }
  if (action_notes !== undefined) {
    db.run('UPDATE recommendation_log SET action_notes = ?, updated_at = ? WHERE id = ?',
      [action_notes, now, id]);
  }

  const updated = db.get('SELECT * FROM recommendation_log WHERE id = ?', [id]);
  return res.json({ data: { ...updated, action_taken: Boolean(updated.action_taken) } });
}));

module.exports = router;
