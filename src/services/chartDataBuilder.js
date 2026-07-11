/**
 * Chart Data Builder — Executive Charts Layer (Phase 17)
 *
 * Pure, generic reshaping of already-fetched real data (analyticsEngine's
 * breakdown rows, creativeAnalytics/budgetDistributionAnalytics snapshots,
 * metricsFetcher's trend data) into chart-library-ready JSON contracts.
 * No DB access, no Meta API calls, no fabricated data -- every builder here
 * takes real rows in and reshapes them; if given no rows, it returns an
 * honestly-empty chart, never a placeholder series.
 *
 * Every builder that represents a single point in time (bar/pie/stacked/
 * heatmap/treemap) can be wrapped with withComparison() to attach the
 * current/previous/diff/pct/growth contract every dataset is required to
 * support; time-series builders (line/area/trend) inherently show the
 * comparison as two series on the same chart instead.
 */

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ─────────────────────────────────────────────
// Time-series charts (Line / Area) — Daily / Weekly / Monthly trend,
// Performance Timeline. `series` is an array of already-normalized rows,
// each carrying a date field (date_start, from metricsFetcher.normalizeTrend)
// and metric fields.
// ─────────────────────────────────────────────
function buildLineChart(series, { dateKey = 'date_start', metricKeys, previousSeries = null } = {}) {
  const labels = series.map(r => r[dateKey]);
  const datasets = metricKeys.map(key => ({
    label: key,
    data: series.map(r => r[key] ?? null),
  }));

  const chart = { type: 'line', labels, datasets };

  if (previousSeries) {
    chart.previous = {
      labels: previousSeries.map(r => r[dateKey]),
      datasets: metricKeys.map(key => ({ label: key, data: previousSeries.map(r => r[key] ?? null) })),
    };
  }
  return chart;
}

function buildAreaChart(series, options = {}) {
  return { ...buildLineChart(series, options), type: 'area' };
}

/** Rolls a daily trend series (metricsFetcher.fetchTrendData output) up into weekly or monthly buckets, summing volume metrics and re-deriving rate/cost metrics from the bucket totals. */
function aggregateTrend(dailyRows, bucket = 'week', { dateKey = 'date_start' } = {}) {
  const bucketKeyFor = (dateStr) => {
    const d = new Date(dateStr);
    if (bucket === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    // week: ISO-ish -- Monday-start week key, using the Monday's date as the label
    const day = d.getDay();
    const diffToMonday = (day + 6) % 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - diffToMonday);
    return monday.toISOString().slice(0, 10);
  };

  const groups = new Map();
  for (const row of dailyRows) {
    const key = bucketKeyFor(row[dateKey]);
    if (!groups.has(key)) {
      groups.set(key, { [dateKey]: key, spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0 });
    }
    const g = groups.get(key);
    g.spend += row.spend || 0;
    g.impressions += row.impressions || 0;
    g.reach += row.reach || 0;
    g.clicks += row.clicks || 0;
    g.results += row.results || 0;
  }

  return [...groups.values()]
    .sort((a, b) => (a[dateKey] < b[dateKey] ? -1 : 1))
    .map(g => ({
      ...g,
      ctr: g.impressions > 0 ? round((g.clicks / g.impressions) * 100, 4) : 0,
      cpm: g.impressions > 0 ? round((g.spend / g.impressions) * 1000, 2) : 0,
      cost_per_result: g.results > 0 ? round(g.spend / g.results, 2) : null,
    }));
}

// ─────────────────────────────────────────────
// Categorical charts (Bar / Pie / Distribution)
// ─────────────────────────────────────────────
function buildBarChart(rows, { labelKey = 'dimension_value', valueKey = 'spend' } = {}) {
  return {
    type: 'bar',
    labels: rows.map(r => r[labelKey]),
    data: rows.map(r => r[valueKey] ?? 0),
  };
}

function buildPieChart(rows, { labelKey = 'dimension_value', valueKey = 'spend' } = {}) {
  const total = rows.reduce((s, r) => s + (r[valueKey] || 0), 0);
  return {
    type: 'pie',
    labels: rows.map(r => r[labelKey]),
    data: rows.map(r => r[valueKey] ?? 0),
    percentages: rows.map(r => (total > 0 ? round(((r[valueKey] || 0) / total) * 100, 1) : 0)),
  };
}

/** Distribution chart = pie's percentage view, explicitly labeled for callers that want the "% of total" framing without the pie-specific naming. */
function buildDistributionChart(rows, options = {}) {
  return { ...buildPieChart(rows, options), type: 'distribution' };
}

// ─────────────────────────────────────────────
// Stacked Bar — multiple metrics (or multiple series, e.g. one per
// audience/placement segment) per label, e.g. spend+results per day.
// ─────────────────────────────────────────────
function buildStackedChart(rows, { labelKey = 'dimension_value', seriesKeys }) {
  return {
    type: 'stacked_bar',
    labels: rows.map(r => r[labelKey]),
    datasets: seriesKeys.map(key => ({
      label: key,
      data: rows.map(r => r[key] ?? 0),
    })),
  };
}

// ─────────────────────────────────────────────
// Heatmap — two categorical dimensions x one metric, e.g. placement x
// device, or hour-of-day x day-of-week (once/if that granularity is synced).
// ─────────────────────────────────────────────
function buildHeatmap(rows, { rowKey, colKey, valueKey = 'spend' }) {
  const rowLabels = [...new Set(rows.map(r => r[rowKey]))];
  const colLabels = [...new Set(rows.map(r => r[colKey]))];
  const lookup = new Map(rows.map(r => [`${r[rowKey]}::${r[colKey]}`, r[valueKey] ?? 0]));

  const matrix = rowLabels.map(rowLabel =>
    colLabels.map(colLabel => lookup.get(`${rowLabel}::${colLabel}`) ?? 0)
  );

  return { type: 'heatmap', rows: rowLabels, cols: colLabels, matrix };
}

// ─────────────────────────────────────────────
// Treemap — hierarchical size-by-value, e.g. spend allocation across
// campaigns/placements.
// ─────────────────────────────────────────────
function buildTreemap(rows, { labelKey = 'dimension_value', valueKey = 'spend' } = {}) {
  return {
    type: 'treemap',
    children: rows.map(r => ({ name: r[labelKey], value: r[valueKey] ?? 0 })),
  };
}

// ─────────────────────────────────────────────
// Scatter / Bubble — two (or three) continuous metrics as points, e.g.
// Creative Score vs Spend, or Score (x) vs ROAS (y) vs Spend (bubble size).
// Generic over any row shape (creative_analytics rows, breakdown rows, ...).
// ─────────────────────────────────────────────
function buildScatterChart(rows, { xKey, yKey, labelKey = 'dimension_value' } = {}) {
  return {
    type: 'scatter',
    points: rows.map(r => ({ x: r[xKey] ?? null, y: r[yKey] ?? null, label: r[labelKey] ?? null })),
  };
}

function buildBubbleChart(rows, { xKey, yKey, sizeKey, labelKey = 'dimension_value' } = {}) {
  return {
    type: 'bubble',
    points: rows.map(r => ({ x: r[xKey] ?? null, y: r[yKey] ?? null, size: r[sizeKey] ?? 0, label: r[labelKey] ?? null })),
  };
}

// ─────────────────────────────────────────────
// Funnel — ordered sequential stage volumes, e.g. Impressions -> Clicks ->
// Landing Page Views -> Results. `stages` is already in funnel order.
// ─────────────────────────────────────────────
function buildFunnelChart(stages) {
  const top = stages[0]?.value || 0;
  return {
    type: 'funnel',
    stages: stages.map(s => ({
      label: s.label,
      value: s.value ?? 0,
      pct_of_top: top > 0 ? round(((s.value || 0) / top) * 100, 1) : 0,
    })),
  };
}

// ─────────────────────────────────────────────
// Ranking — an ordered list with rank position, e.g.
// creativeIntelligenceEngine.compareCreativesInAdSet()'s `ranking` array.
// ─────────────────────────────────────────────
function buildRankingChart(rankedRows, { labelKey = 'ad_name', valueKey = 'score' } = {}) {
  return {
    type: 'ranking',
    items: rankedRows.map((r, i) => ({ rank: r.rank ?? i + 1, label: r[labelKey], value: r[valueKey] ?? 0 })),
  };
}

// ─────────────────────────────────────────────
// Retention Curve — one creative's video watch-percentage checkpoints as a
// line (creative_analytics.video_pXX_pct columns). Single-row-to-multi-point,
// unlike every other builder above (which reshape many rows into one
// series) -- kept here anyway since the shape is generic ("named percentage
// checkpoints on one entity"), not creative-specific business logic.
// ─────────────────────────────────────────────
const DEFAULT_RETENTION_CHECKPOINTS = [
  { key: 'video_p25_pct', label: '25%' },
  { key: 'video_p50_pct', label: '50%' },
  { key: 'video_p75_pct', label: '75%' },
  { key: 'video_p95_pct', label: '95%' },
  { key: 'video_p100_pct', label: '100%' },
];

function buildRetentionCurve(row, { checkpoints = DEFAULT_RETENTION_CHECKPOINTS } = {}) {
  return {
    type: 'retention_curve',
    labels: checkpoints.map(c => c.label),
    data: checkpoints.map(c => row?.[c.key] ?? null),
  };
}

// ─────────────────────────────────────────────
// Current-vs-previous wrapper -- every non-time-series chart above can be
// wrapped with this to attach the diff/pct/growth contract.
// ─────────────────────────────────────────────
function withComparison(currentValue, previousValue) {
  const cur = currentValue ?? 0;
  const prev = previousValue ?? 0;
  const diff = round(cur - prev);
  const diffPct = prev !== 0 ? round(((cur - prev) / Math.abs(prev)) * 100, 1) : null;
  return {
    current: cur,
    previous: prev,
    difference: diff,
    percentage_change: diffPct,
    growth: diff > 0,
    decline: diff < 0,
  };
}

/** Attaches withComparison() per-row for a chart built from rows that each carry a `previous` sub-object (the shape analyticsEngine.getBreakdownAnalytics()'s `current` rows already have). */
function attachRowComparisons(rows, valueKey = 'spend') {
  return rows.map(r => ({
    ...r,
    comparison: withComparison(r[valueKey], r.previous ? r.previous[valueKey] : null),
  }));
}

module.exports = {
  buildLineChart,
  buildAreaChart,
  aggregateTrend,
  buildBarChart,
  buildPieChart,
  buildDistributionChart,
  buildStackedChart,
  buildHeatmap,
  buildTreemap,
  buildScatterChart,
  buildBubbleChart,
  buildFunnelChart,
  buildRankingChart,
  buildRetentionCurve,
  withComparison,
  attachRowComparisons,
};
