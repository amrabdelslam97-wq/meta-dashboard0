/**
 * Alerts Route — Phase 3
 *
 * GET   /api/v1/alerts          — list with filters
 * PATCH /api/v1/alerts/:id      — snooze / dismiss
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { asyncHandler } = require('../../middleware/errorHandler');

// ── GET /alerts ───────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const { severity, campaign_id, status = 'active', limit: lp = '100', offset: op = '0' } = req.query;

  const limit  = Math.min(Math.max(parseInt(lp, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(op, 10) || 0, 0);

  const conditions = [];
  const params = [];

  if (status === 'active') {
    conditions.push("a.status = 'active' AND (a.snoozed_until IS NULL OR a.snoozed_until < datetime('now'))");
  } else if (status === 'snoozed') {
    conditions.push("a.status = 'active' AND a.snoozed_until >= datetime('now')");
  } else if (status === 'dismissed') {
    conditions.push("a.status = 'dismissed'");
  } else if (status === 'resolved') {
    conditions.push("a.status = 'resolved'");
  } else {
    conditions.push("a.status != 'resolved'");
  }

  if (severity) { conditions.push('a.severity = ?'); params.push(severity); }
  if (campaign_id) { conditions.push('a.entity_meta_id = ?'); params.push(campaign_id); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.get(`SELECT COUNT(*) as c FROM active_alerts a ${where}`, params);

  const rows = db.all(
    `SELECT
       a.id, a.alert_code, a.entity_type, a.entity_meta_id, a.entity_label,
       a.severity, a.alert_message, a.detected_value, a.threshold_value,
       a.status, a.first_detected_at, a.last_detected_at, a.occurrence_count,
       a.snoozed_until, a.resolved_at,
       r.alert_name, r.description as rule_description,
       c.name as campaign_name, c.objective
     FROM active_alerts a
     LEFT JOIN alert_rules r ON a.alert_rule_id = r.id
     LEFT JOIN campaigns c ON c.meta_campaign_id = a.entity_meta_id
     ${where}
     ORDER BY
       CASE a.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
       a.last_detected_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return res.json({ data: rows, meta: { total: total.c, limit, offset, returned: rows.length } });
}));

// ── PATCH /alerts/:id ─────────────────────────────────────────
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action, snooze_hours, snooze_until } = req.body || {};
  const now = new Date().toISOString();

  const alert = db.get('SELECT id, status FROM active_alerts WHERE id = ?', [id]);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  if (action === 'dismiss') {
    db.run("UPDATE active_alerts SET status = 'dismissed' WHERE id = ?", [id]);
  } else if (action === 'snooze') {
    let until;
    if (snooze_until) {
      const parsed = new Date(snooze_until);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'snooze_until must be a valid date string' });
      }
      until = parsed.toISOString();
    } else {
      const hours = parseInt(snooze_hours, 10) || 24;
      const d = new Date();
      d.setHours(d.getHours() + hours);
      until = d.toISOString();
    }
    db.run('UPDATE active_alerts SET snoozed_until = ? WHERE id = ?', [until, id]);
  } else if (action === 'resolve') {
    db.run("UPDATE active_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?", [now, id]);
  } else {
    return res.status(400).json({ error: 'Invalid action', valid: ['dismiss', 'snooze', 'resolve'] });
  }

  const updated = db.get('SELECT * FROM active_alerts WHERE id = ?', [id]);
  return res.json({ data: updated });
}));

module.exports = router;
