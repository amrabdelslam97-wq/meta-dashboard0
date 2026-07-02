/**
 * Recommendation Resolver
 *
 * Single source of truth for "which recommendation rules apply to this
 * objective, and does a given rule's condition currently fire against these
 * metrics." Moved out of recommendationEngine.js (which becomes the
 * consumer -- its dedup/upsert/auto-resolve/suppression control flow is
 * unchanged, it just sources these two primitives from here instead of
 * defining them locally) so that recommendationEngine.js is never the only
 * place that knows how to evaluate a rule's condition_logic -- a future
 * consumer (e.g. a "preview what would fire" endpoint) can reuse
 * evaluateCondition()/loadApplicableRules() without duplicating them.
 *
 * recommendationEngine.js requires from here (not the reverse) to avoid a
 * circular require -- same one-directional dependency shape as
 * healthResolver.js -> healthScoreEngine.js.
 */

const db = require('../db/database');

// ─────────────────────────────────────────────
// Evaluate a single condition object against metrics
// condition_logic shape: { metric, operator, value }
// Operators: lt | gt | lte | gte | eq
// ─────────────────────────────────────────────
function evaluateCondition(condition, metrics) {
  const { metric, operator, value: threshold } = condition;

  const actual = metrics[metric];
  if (actual === null || actual === undefined) return false;

  const v = parseFloat(actual);
  if (isNaN(v)) return false;

  switch (operator) {
    case 'lt':  return v < threshold;
    case 'gt':  return v > threshold;
    case 'lte': return v <= threshold;
    case 'gte': return v >= threshold;
    case 'eq':  return v === threshold;
    default:    return false;
  }
}

// ─────────────────────────────────────────────
// Load all active rules applicable to an objective
// (objective IS NULL means the rule applies to every objective)
// ─────────────────────────────────────────────
function loadApplicableRules(objective) {
  return db.all(
    `SELECT * FROM recommendation_rules
     WHERE is_active = 1
       AND (objective IS NULL OR objective = ?)
     ORDER BY priority ASC`,
    [objective]
  );
}

module.exports = { evaluateCondition, loadApplicableRules };
