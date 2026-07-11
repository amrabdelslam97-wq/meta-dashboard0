/**
 * Budget Intelligence Router — Phase 24
 *
 * Comprehensive budget analysis, waste detection, scaling opportunities,
 * and budget movement recommendations.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { resolveDateRange } = require('../../services/dateRangeHelper');
const { asyncHandler } = require('../../middleware/errorHandler');

const budgetIntel = require('../../services/budgetIntelligenceEngine');
const budgetMovement = require('../../services/budgetMovementEngine');

function loadAccountId(req) {
  // Assumes authentication provides account ID
  return req.user?.account_id || req.query.account_id || 'default';
}

// ── Budget Scoring ────────────────────────────────────────────────

router.get('/efficiency/:level/:entityId', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req);
  const { level, entityId } = req.params;
  const dateRange = resolveDateRange(req.query);

  const score = budgetIntel.scoreBudgetEfficiency(accountId, level, entityId, dateRange);
  return res.json({ data: score });
}));

// ── Budget Waste Detection ─────────────────────────────────────────

router.get('/waste/:level/:entityId', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req);
  const { level, entityId } = req.params;
  const dateRange = resolveDateRange(req.query);

  const waste = budgetIntel.detectBudgetWaste(accountId, level, entityId, dateRange);
  return res.json({ data: waste });
}));

router.get('/waste-summary', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req);
  const dateRange = resolveDateRange(req.query);

  // Detect waste across all campaigns
  const campaigns = db.all(
    `SELECT * FROM budget_distribution_snapshots
     WHERE ad_account_id = ? AND level = 'campaign'
     AND date_since = ? AND date_until = ?`,
    [accountId, dateRange.since, dateRange.until]
  );

  const wasteByEntity = campaigns
    .map(c => ({
      ...c,
      waste: budgetIntel.detectBudgetWaste(accountId, 'campaign', c.entity_meta_id, dateRange),
    }))
    .filter(c => c.waste.waste_detected);

  const totalWaste = wasteByEntity.reduce((s, c) => s + (c.waste.waste_amount || 0), 0);

  return res.json({
    data: {
      date_range: dateRange,
      total_waste_detected: wasteByEntity.length,
      total_waste_amount: Math.round(totalWaste),
      waste_percentage: campaigns.length > 0 ? Math.round((totalWaste / campaigns.reduce((s, c) => s + c.spend_amount, 0)) * 100) : 0,
      waste_by_entity: wasteByEntity.map(c => ({
        entity_id: c.entity_meta_id,
        entity_label: c.entity_label,
        ...c.waste,
      })),
    },
  });
}));

// ── Scaling Opportunities ──────────────────────────────────────────

router.get('/scaling-opportunities', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req);
  const level = req.query.level || 'campaign';
  const dateRange = resolveDateRange(req.query);

  const opportunities = budgetIntel.detectScalingOpportunities(accountId, level, dateRange);
  return res.json({ data: opportunities });
}));

// ── Budget Distribution ────────────────────────────────────────────

router.get('/distribution/:level', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req);
  const { level } = req.params;
  const dateRange = resolveDateRange(req.query);

  const distribution = budgetIntel.getBudgetDistribution(accountId, level, dateRange);
  return res.json({ data: distribution });
}));

// ── Burn Rate & Pacing ─────────────────────────────────────────────

router.get('/burn-rate', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req);
  const dateRange = resolveDateRange(req.query);

  const burnRate = budgetIntel.calculateBurnRate(accountId, dateRange);
  return res.json({ data: burnRate });
}));

// ── Budget Movement Recommendations ────────────────────────────────

router.get('/movement-recommendations', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req);
  const dateRange = resolveDateRange(req.query);

  const recommendations = budgetMovement.generateBudgetMovementRecommendations(accountId, dateRange);
  return res.json({ data: recommendations });
}));

router.post('/simulate-reallocation', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req);
  const { movements } = req.body;
  const dateRange = resolveDateRange(req.query);

  if (!movements || !Array.isArray(movements)) {
    return res.status(400).json({ error: 'movements array required' });
  }

  const simulation = budgetMovement.simulateBudgetReallocation(accountId, movements, dateRange);
  return res.json({ data: simulation });
}));

// ── Master Budget Dashboard ───────────────────────────────────────

router.get('/dashboard', asyncHandler(async (req, res) => {
  const accountId = loadAccountId(req);
  const dateRange = resolveDateRange(req.query);

  const distribution = budgetIntel.getBudgetDistribution(accountId, 'campaign', dateRange);
  const burnRate = budgetIntel.calculateBurnRate(accountId, dateRange);
  const waste = budgetIntel.detectBudgetWaste(accountId, 'campaign', '', dateRange); // Aggregate
  const scaling = budgetIntel.detectScalingOpportunities(accountId, 'campaign', dateRange);
  const movements = budgetMovement.generateBudgetMovementRecommendations(accountId, dateRange);

  return res.json({
    data: {
      date_range: dateRange,
      summary: {
        total_spend: distribution.total_spend,
        total_results: distribution.total_results,
        campaigns: distribution.entities.length,
        average_daily_spend: burnRate.average_daily_spend,
        projected_month_end: burnRate.projected_month_end_spend,
      },
      waste: {
        entities_with_waste: waste.waste_detected ? 1 : 0,
        total_waste_amount: waste.waste_amount,
      },
      scaling: {
        scaling_opportunities: scaling.total_opportunities,
        top_opportunity: scaling.opportunities[0],
      },
      recommendations: {
        total_budget_movements: movements.total_recommendations,
        high_priority: movements.recommendations.filter(r => r.priority === 'high').length,
        critical_priority: movements.recommendations.filter(r => r.priority === 'critical').length,
      },
    },
  });
}));

module.exports = router;
