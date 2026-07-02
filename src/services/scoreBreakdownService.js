/**
 * Score Breakdown Service — Phase 6B
 *
 * PRESENTATION LAYER ONLY.
 * Reads stored score_breakdown JSONB from health_score_history.
 * Does NOT recalculate anything. Does NOT call scoring engines.
 *
 * Input:  stored score_breakdown + objective + health_score
 * Output: human-readable explanation with contributions, labels, interpretation
 */

const db = require('../db/database');
// Human-readable metric labels now live in metricResolver.js (the KPI
// Profile Resolver's companion module) -- this file previously had its own
// independent copy that had already drifted (missing video/engagement/
// app-install labels the resolver layer added). Re-exported under the same
// name for backward compatibility with any existing importer.
const { METRIC_LABELS } = require('./metricResolver');

// ─────────────────────────────────────────────
// Format metric value with appropriate unit
// ─────────────────────────────────────────────
function formatValue(metricKey, value, currency = '') {
  if (value === null || value === undefined) return 'N/A';
  const v = parseFloat(value);
  if (isNaN(v)) return 'N/A';

  const curr = currency || '';

  switch (metricKey) {
    case 'ctr':
      return `${v.toFixed(2)}%`;
    case 'frequency':
      return v.toFixed(2);
    case 'roas':
      return `${v.toFixed(2)}x`;
    case 'cpr': case 'cpl': case 'cpa': case 'cpm': case 'cpc':
    case 'cost_per_landing_page_view':
      return `${v.toFixed(2)} ${curr}`.trim();
    case 'spend': case 'purchase_value':
      return `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${curr}`.trim();
    case 'reach': case 'impressions': case 'landing_page_views':
    case 'results': case 'leads': case 'purchases': case 'link_clicks':
      return v.toLocaleString('en-US');
    default:
      return v.toFixed(2);
  }
}

// ─────────────────────────────────────────────
// Generate interpretation text for one metric
// ─────────────────────────────────────────────
function interpretMetric(metricKey, normalized, direction, value, currency) {
  if (normalized === null || normalized === undefined) {
    return 'No data available for this metric in the selected period.';
  }

  const label     = METRIC_LABELS[metricKey] || metricKey;
  const formatted = formatValue(metricKey, value, currency);

  if (normalized >= 80) {
    return `Your ${label} of ${formatted} is in the Excellent range — strong contribution to your score.`;
  }
  if (normalized >= 60) {
    return `Your ${label} of ${formatted} is in the Good range — contributing positively.`;
  }
  if (normalized >= 40) {
    const direction_hint = direction === 'lower_is_better'
      ? 'Reducing this further would improve your score.'
      : 'Improving this would boost your score.';
    return `Your ${label} of ${formatted} is in the Warning range. ${direction_hint}`;
  }
  const direction_hint = direction === 'lower_is_better'
    ? 'This is significantly above target — review your targeting and bidding.'
    : 'This is below minimum threshold — immediate attention needed.';
  return `Your ${label} of ${formatted} is in the Critical range. ${direction_hint}`;
}

// ─────────────────────────────────────────────
// Load latest score breakdown from DB
// ─────────────────────────────────────────────
function loadLatestBreakdown(entityMetaId, entityType = 'campaign') {
  return db.get(
    `SELECT health_score, health_status, objective, score_breakdown,
            score_reference, benchmark_industry, calculated_at
     FROM health_score_history
     WHERE entity_meta_id = ? AND entity_type = ?
       AND score_breakdown IS NOT NULL
     ORDER BY calculated_at DESC LIMIT 1`,
    [entityMetaId, entityType]
  );
}

// ─────────────────────────────────────────────
// Load threshold context from objective_scoring_configs
// ─────────────────────────────────────────────
function loadThresholds(objective, metricKey) {
  return db.get(
    `SELECT excellent_threshold, good_threshold, warning_threshold, critical_threshold,
            comparison_direction, optimal_low, optimal_high
     FROM objective_scoring_configs
     WHERE objective = ? AND metric_key = ?`,
    [objective, metricKey]
  );
}

// ─────────────────────────────────────────────
// MAIN: Format score breakdown for display
// ─────────────────────────────────────────────
function formatScoreBreakdown(entityMetaId, entityType = 'campaign', currency = '') {
  const row = loadLatestBreakdown(entityMetaId, entityType);

  if (!row) {
    return {
      analyzed:    false,
      entity_meta_id: entityMetaId,
      entity_type:   entityType,
      message:     'No analysis data found. Run insights to generate a score breakdown.',
    };
  }

  let breakdown = {};
  try {
    breakdown = row.score_breakdown ? JSON.parse(row.score_breakdown) : {};
  } catch {
    return { analyzed: false, entity_meta_id: entityMetaId, entity_type: entityType, message: 'Score breakdown data is malformed.' };
  }

  const contributions = [];
  const positiveFactors  = [];
  const negativeFactors  = [];
  const suggestions      = [];

  for (const [metricKey, data] of Object.entries(breakdown)) {
    const { value, normalized, weight } = data;
    const thresholds = loadThresholds(row.objective, metricKey);

    const weightedContribution = normalized !== null ? normalized * weight : null;

    const label       = METRIC_LABELS[metricKey] || metricKey;
    const direction   = thresholds?.comparison_direction || 'lower_is_better';
    const isPositive  = normalized !== null && normalized >= 60;
    const isNegative  = normalized !== null && normalized < 40;

    if (isPositive) positiveFactors.push(label);
    if (isNegative) {
      negativeFactors.push(label);
      const improve = direction === 'lower_is_better'
        ? `Reduce ${label} below ${formatValue(metricKey, thresholds?.good_threshold, currency)}`
        : `Increase ${label} above ${formatValue(metricKey, thresholds?.good_threshold, currency)}`;
      suggestions.push({ metric: metricKey, action: improve });
    }

    contributions.push({
      metric_key:          metricKey,
      display_label:       label,
      actual_value:        value !== null ? parseFloat(value) : null,
      formatted_value:     formatValue(metricKey, value, currency),
      normalized_score:    normalized,
      weight:              weight,
      weight_pct:          Math.round(weight * 100),
      weighted_contribution: weightedContribution !== null ? Math.round(weightedContribution * 100) / 100 : null,
      classification:      isPositive ? 'positive' : isNegative ? 'negative' : 'neutral',
      direction:           direction,
      excellent_threshold: thresholds?.excellent_threshold ?? null,
      good_threshold:      thresholds?.good_threshold ?? null,
      benchmark_source:    data.source === 'benchmark' ? 'Industry Benchmark' : 'Platform Default',
      interpretation:      interpretMetric(metricKey, normalized, direction, value, currency),
    });
  }

  // Sort by weight descending — most important metrics first
  contributions.sort((a, b) => b.weight - a.weight);

  return {
    analyzed:          true,
    entity_meta_id:    entityMetaId,
    entity_type:       entityType,
    objective:         row.objective,
    health_score:      row.health_score,
    health_status:     row.health_status,
    score_reference:   row.score_reference,
    benchmark_industry: row.benchmark_industry || null,
    calculated_at:     row.calculated_at,
    formula:           `Weighted average of ${contributions.length} objective-specific KPIs`,
    contributions,
    positive_factors:  positiveFactors,
    negative_factors:  negativeFactors,
    improvement_suggestions: suggestions,
  };
}

module.exports = { formatScoreBreakdown, METRIC_LABELS, formatValue };
