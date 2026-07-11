/**
 * Condition Comparator — Phase X.2 (Rule Engine Authority)
 *
 * Shared numeric-comparison and percent-change primitives. Extracted from
 * ruleEngine.js's inline switch, which was reimplemented with slightly
 * different shapes in recommendationResolver.js and alertEngine.js (three
 * separate "compare a metric against a threshold" implementations with
 * overlapping but inconsistent operator vocabularies). Pure functions, no
 * state, no DB access -- every call site keeps its own condition/rule shape
 * and calls these only for the actual numeric comparison, so this is not a
 * new engine, just a deduplicated primitive.
 */

// Base comparison operators shared by ruleEngine.js, recommendationResolver.js,
// and alertEngine.js. ruleEngine.js additionally supports ratio_lt/ratio_gt/
// delta_gt/delta_lt/flat -- those are unique to it today (confirmed not
// duplicated elsewhere) and stay local to ruleEngine.js's own evaluateCondition().
function compare(actual, operator, threshold) {
  if (actual == null || threshold == null) return false;
  const v = parseFloat(actual);
  if (isNaN(v)) return false;
  switch (operator) {
    case 'gt':  return v > threshold;
    case 'gte': return v >= threshold;
    case 'lt':  return v < threshold;
    case 'lte': return v <= threshold;
    case 'eq':  return v === threshold;
    default:    return false;
  }
}

// Percent change from `prior` to `current`. The two existing call sites
// diverged on denominator convention: alertEngine.js divides by `prior` as-is
// ('raw'), diagnosisEngine.js's conversionRateFalling() divides by
// `Math.abs(prior)` ('abs', the default). They only disagree when `prior` is
// negative, which none of this system's ad metrics ever are in practice --
// but each call site's exact pre-existing behavior is preserved explicitly
// rather than silently unified onto one convention.
function pctChange(current, prior, { denominator = 'abs' } = {}) {
  if (current == null || prior == null) return null;
  const cur = parseFloat(current);
  const prr = parseFloat(prior);
  if (isNaN(cur) || isNaN(prr) || prr === 0) return null;
  const denom = denominator === 'raw' ? prr : Math.abs(prr);
  return ((cur - prr) / denom) * 100;
}

module.exports = { compare, pctChange };
