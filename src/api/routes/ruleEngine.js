/**
 * Rule Engine Route — Phase X.2 (Rule Engine Authority)
 *
 * GET /api/v1/rule-engine/inventory — the full business-logic registry
 * (native Framework rules + DB-driven alert/recommendation rules +
 * diagnosisEngine/opportunityEngine attributed thresholds), each entry
 * tagged with `owner`. Read-only, does not affect execution.
 */

const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../../middleware/errorHandler');
const { getBusinessLogicInventory } = require('../../services/ruleInventory');

router.get('/inventory', asyncHandler(async (req, res) => {
  const inventory = getBusinessLogicInventory();
  return res.json({ data: inventory });
}));

module.exports = router;
