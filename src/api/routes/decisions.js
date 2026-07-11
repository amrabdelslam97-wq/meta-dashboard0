/**
 * Decisions Route — Phase 5
 *
 * GET  /api/v1/decisions                  — today's priority actions
 * GET  /api/v1/decisions/winners          — top winner campaigns
 * GET  /api/v1/decisions/losers           — top loser campaigns
 * GET  /api/v1/decisions/opportunities    — opportunity list
 * GET  /api/v1/decisions/history          — decision history log
 * PATCH /api/v1/decisions/history/:id     — mark complete / dismiss / add note
 */

const express = require('express');
const router  = express.Router();
const db      = require('../../db/database');
const { generateTodaysDecisions, persistDecisions, getDecisionHistory, DECISION_LABELS } = require('../../services/decisionEngine');
const { getTopWinners }          = require('../../services/topWinnersEngine');
const { getTopLosers }           = require('../../services/topLosersEngine');
const { detectAllOpportunities } = require('../../services/opportunityEngine');
const { buildPortfolioTrace }    = require('../../services/mmsOrchestrator');
const { resolveAccount: getDefaultAccount } = require('../../services/accountResolver');
const { asyncHandler }           = require('../../middleware/errorHandler');

// ─────────────────────────────────────────────
// GET /decisions — today's priority actions
// ─────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const account = getDefaultAccount(req);
  if (!account) return res.status(404).json({ error: 'No active ad account found' });

  const result = generateTodaysDecisions(account.id);

  // Persist to DB (idempotent — one per campaign+type per day)
  try { persistDecisions(account.id, result.decisions); } catch {}

  return res.json({
    ...result,
    decision_labels: DECISION_LABELS,
    _governance: buildPortfolioTrace({ decisions: result.decisions }),
  });
}));

// ─────────────────────────────────────────────
// GET /decisions/winners
// ─────────────────────────────────────────────
router.get('/winners', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '5', 10), 20);
  const winners = getTopWinners(limit, req.query.account_id || null);
  return res.json({ data: winners, total: winners.length, _governance: buildPortfolioTrace({ decisions: winners }) });
}));

// ─────────────────────────────────────────────
// GET /decisions/losers
// ─────────────────────────────────────────────
router.get('/losers', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '5', 10), 20);
  const losers = getTopLosers(limit, req.query.account_id || null);
  return res.json({ data: losers, total: losers.length, _governance: buildPortfolioTrace({ decisions: losers }) });
}));

// ─────────────────────────────────────────────
// GET /decisions/opportunities
// ─────────────────────────────────────────────
router.get('/opportunities', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 30);
  const opps  = detectAllOpportunities(limit, req.query.account_id || null);
  return res.json({ data: opps, total: opps.length });
}));

// ─────────────────────────────────────────────
// GET /decisions/history
// ─────────────────────────────────────────────
router.get('/history', asyncHandler(async (req, res) => {
  const account = getDefaultAccount(req);
  if (!account) return res.status(404).json({ error: 'No active ad account found' });

  const { status, limit: lp = '50' } = req.query;
  const limit = Math.min(parseInt(lp, 10) || 50, 200);

  let history = [];
  try {
    history = getDecisionHistory(account.id, limit, status || null);
  } catch {
    // decision_history table may not exist yet on first run before migration
  }

  return res.json({ data: history, total: history.length });
}));

// ─────────────────────────────────────────────
// PATCH /decisions/history/:id — update action
// ─────────────────────────────────────────────
router.patch('/history/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action_taken, action_notes, status } = req.body || {};
  const now = new Date().toISOString();

  let row;
  try {
    row = db.get('SELECT id FROM decision_history WHERE id = ?', [id]);
  } catch {
    return res.status(404).json({ error: 'decision_history table not found — run migrations' });
  }
  if (!row) return res.status(404).json({ error: 'Decision not found' });

  if (action_taken !== undefined) {
    db.run('UPDATE decision_history SET action_taken = ?, updated_at = ? WHERE id = ?',
      [action_taken ? 1 : 0, now, id]);
  }
  if (action_notes !== undefined) {
    db.run('UPDATE decision_history SET action_notes = ?, updated_at = ? WHERE id = ?',
      [action_notes, now, id]);
  }
  if (status) {
    const validStatuses = ['pending', 'completed', 'dismissed', 'snoozed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status', valid: validStatuses });
    }
    db.run('UPDATE decision_history SET status = ?, updated_at = ? WHERE id = ?',
      [status, now, id]);
    if (status === 'completed') {
      db.run('UPDATE decision_history SET completed_at = ?, action_taken = 1, updated_at = ? WHERE id = ?',
        [now, now, id]);
    }
    if (status === 'dismissed') {
      db.run('UPDATE decision_history SET dismissed_at = ?, updated_at = ? WHERE id = ?',
        [now, now, id]);
    }
  }

  const updated = db.get('SELECT * FROM decision_history WHERE id = ?', [id]);
  return res.json({ data: { ...updated, action_taken: Boolean(updated.action_taken) } });
}));

module.exports = router;
