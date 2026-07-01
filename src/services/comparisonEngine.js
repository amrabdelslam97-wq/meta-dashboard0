/**
 * Comparison Engine — Phase 7B
 *
 * PRESENTATION LAYER ONLY. Does not duplicate delta math.
 * Wraps the existing computeDeltas() output (metricsFetcher.js) with
 * explicit comparison context: what was it compared against, and why.
 *
 * Required by spec: every metric must expose
 *   current_value, comparison_value, comparison_type, delta_percent, delta_absolute
 * If no prior data exists, returns "No comparison available" instead of a fake number.
 */

// ─────────────────────────────────────────────
// Map a date range preset to its human comparison label
// ─────────────────────────────────────────────
const COMPARISON_LABELS = {
  today:        'Yesterday',
  yesterday:    'Day Before',
  last_3_days:  'Previous 3 Days',
  last_7_days:  'Previous 7 Days',
  last_7:       'Previous 7 Days',
  last_14:      'Previous 14 Days',
  last_30_days: 'Previous 30 Days',
  last_30:      'Previous 30 Days',
  this_month:   'Previous Month',
  last_month:   'Month Before',
  custom:       'Previous Period (Equal Duration)',
};

function getComparisonLabel(preset) {
  return COMPARISON_LABELS[preset] || 'Previous Period';
}

/**
 * Build a full comparison object for a single metric.
 *
 * @param {string} metricKey
 * @param {number|null} currentValue
 * @param {number|null} priorValue
 * @param {object|null} deltaEntry  — { delta_abs, delta_pct } from computeDeltas(), or undefined
 * @param {string} preset — the active date range preset, for labeling
 */
function buildMetricComparison(metricKey, currentValue, priorValue, deltaEntry, preset) {
  const hasCurrent = currentValue !== null && currentValue !== undefined;
  const hasPrior   = priorValue   !== null && priorValue   !== undefined;

  if (!hasCurrent) {
    return {
      metric_key:        metricKey,
      current_value:      null,
      comparison_value:   null,
      comparison_type:    null,
      delta_percent:      null,
      delta_absolute:     null,
      comparison_available: false,
      message:            'No data available',
    };
  }

  if (!hasPrior || !deltaEntry) {
    return {
      metric_key:        metricKey,
      current_value:      currentValue,
      comparison_value:   null,
      comparison_type:    getComparisonLabel(preset),
      delta_percent:      null,
      delta_absolute:     null,
      comparison_available: false,
      message:            'No comparison available',
    };
  }

  return {
    metric_key:        metricKey,
    current_value:      currentValue,
    comparison_value:   priorValue,
    comparison_type:    getComparisonLabel(preset),
    delta_percent:      deltaEntry.delta_pct,
    delta_absolute:     deltaEntry.delta_abs,
    comparison_available: true,
    message:            null,
  };
}

/**
 * Build comparison objects for every metric present in current/deltas.
 * Reuses the already-computed deltas object — does not recompute anything.
 *
 * @param {object} currentMetrics
 * @param {object} priorMetrics
 * @param {object} deltas — output of computeDeltas()
 * @param {string} preset — active date range preset
 */
function buildComparisons(currentMetrics, priorMetrics, deltas, preset) {
  const result = {};
  const keys = Object.keys(currentMetrics || {});

  for (const key of keys) {
    if (typeof currentMetrics[key] !== 'number') continue; // skip non-numeric fields (date_start, etc.)
    const cur   = currentMetrics[key];
    const prior = priorMetrics ? priorMetrics[key] : null;
    const delta = deltas ? deltas[key] : null;
    result[key] = buildMetricComparison(key, cur, prior, delta, preset);
  }

  return result;
}

module.exports = {
  buildComparisons,
  buildMetricComparison,
  getComparisonLabel,
  COMPARISON_LABELS,
};
