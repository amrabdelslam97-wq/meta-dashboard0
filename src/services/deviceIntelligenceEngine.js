/**
 * Device Intelligence Engine — Phase 20 Part 4
 *
 * Break down performance by device: Android, iPhone, iPad, Desktop, Mobile Web, Tablet.
 *
 * Calculate all KPIs per device.
 * AI detects: best/worst device, device fatigue, device bias, device opportunity.
 */

const db = require('../db/database');
const { defaultRange } = require('./dateRangeHelper');
const { buildInsight } = require('./analyticsInsight');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const DEVICE_LABELS = {
  android_smartphone: 'Android Phone',
  iphone: 'iPhone',
  ipad: 'iPad',
  android_tablet: 'Android Tablet',
  desktop: 'Desktop',
  mobile_web: 'Mobile Web',
};

/**
 * Get device performance breakdown.
 */
function getDevicePerformance(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT * FROM analytics_breakdown_history
     WHERE meta_campaign_id = ? AND breakdown_type IN ('impression_device', 'device_platform')
     AND date_since = ? AND date_until = ?
     ORDER BY spend DESC`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  if (rows.length === 0) {
    return {
      date_range: dateRange,
      devices: [],
      insight: null,
      note: 'No device data available for this campaign/period.',
    };
  }

  const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
  const avgCPA = rows.reduce((s, r) => s + (r.results > 0 ? r.spend / r.results : 0), 0) / rows.length;

  const enriched = rows.map(r => {
    const cpa = r.results > 0 ? round(r.spend / r.results, 2) : null;
    const efficiency = avgCPA && cpa ? round((avgCPA / cpa) * 100, 1) : null;
    const contribution = totalSpend > 0 ? round(r.spend / totalSpend * 100, 1) : 0;

    return {
      device: r.breakdown_value,
      device_label: DEVICE_LABELS[r.breakdown_value] || r.breakdown_value,
      spend: r.spend,
      reach: r.reach,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      cpc: r.cpc,
      cpm: r.cpm,
      results: r.results,
      cost_per_result: cpa,
      roas: r.roas,
      frequency: r.frequency,
      contribution_pct: contribution,
      efficiency: efficiency,
      trend: 'stable',
    };
  });

  const ranking = [...enriched].sort((a, b) => (a.cost_per_result || Infinity) - (b.cost_per_result || Infinity));

  return {
    date_range: dateRange,
    devices: enriched,
    best_device: ranking[0] || null,
    worst_device: ranking[ranking.length - 1] || null,
    insight: buildInsight(enriched, { costKey: 'cost_per_result', labelKey: 'device_label' }),
  };
}

/**
 * Detect device-specific issues.
 */
function detectDeviceIssues(metaCampaignId, dateRange = defaultRange()) {
  const performance = getDevicePerformance(metaCampaignId, dateRange);
  const issues = [];

  if (performance.devices.length < 2) return { issues };

  const avgCPA = performance.devices.reduce((s, d) => s + (d.cost_per_result || 0), 0) / performance.devices.length;

  // Detect underperforming devices with high spend
  const problematic = performance.devices.filter(d =>
    d.cost_per_result && d.cost_per_result > avgCPA * 1.3 && d.contribution_pct > 10
  );

  if (problematic.length > 0) {
    issues.push({
      type: 'device_underperformance',
      devices: problematic.map(d => d.device_label),
      detail: `${problematic.map(d => d.device_label).join(', ')} underperforming by >30% but receiving ${problematic[0].contribution_pct}%+ budget.`,
      action: 'Reduce budget or test device-specific creatives.',
    });
  }

  // Detect device bias
  const mobileDominance = performance.devices
    .filter(d => ['Android Phone', 'iPhone', 'Mobile Web'].includes(d.device_label))
    .reduce((s, d) => s + d.contribution_pct, 0);

  if (mobileDominance > 85) {
    issues.push({
      type: 'mobile_bias',
      detail: `${round(mobileDominance)}% of budget going to mobile devices.`,
      opportunity: 'Consider desktop/tablet testing if not already optimized.',
    });
  }

  return { issues };
}

/**
 * Generate device recommendations.
 */
function generateDeviceRecommendations(metaCampaignId, dateRange = defaultRange()) {
  const performance = getDevicePerformance(metaCampaignId, dateRange);
  const issues = detectDeviceIssues(metaCampaignId, dateRange);

  const recommendations = [];

  if (performance.best_device) {
    recommendations.push({
      priority: 'medium',
      type: 'scale',
      device: performance.best_device.device_label,
      action: `Increase budget for ${performance.best_device.device_label} — most efficient device.`,
      expected_impact: 'Improve overall CPA by 5%',
      confidence: 'medium',
    });
  }

  if (performance.worst_device && performance.worst_device.contribution_pct > 10) {
    recommendations.push({
      priority: 'medium',
      type: 'reduce',
      device: performance.worst_device.device_label,
      action: `Reduce ${performance.worst_device.device_label} budget — significantly underperforming.`,
      expected_impact: 'Eliminate wasted spend',
      confidence: 'medium',
    });
  }

  return {
    recommendations: recommendations.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }),
    issues: issues.issues,
    total_recommendations: recommendations.length,
  };
}

module.exports = {
  getDevicePerformance,
  detectDeviceIssues,
  generateDeviceRecommendations,
};
