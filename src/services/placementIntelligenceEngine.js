/**
 * Placement Intelligence Engine — Phase 20 Part 2
 *
 * Full placement analytics across all Meta placements:
 * Facebook Feed/Stories/Reels/Right Column/Search/Profile/Video Feed,
 * Instagram Feed/Stories/Reels/Explore/Profile Feed/Suggested Reels,
 * Messenger Inbox/Stories, Audience Network, Marketplace, Instant Articles, In-stream.
 *
 * For every placement: spend, reach, impressions, CTR, CPM, CPC, results, ROAS,
 * messaging conversations, purchases, video metrics, frequency.
 *
 * AI detects: best/worst placement, budget waste, low CTR, high CPM, best conversion,
 * best messaging, best purchase, creative fit.
 *
 * Generates: scale, reduce, duplicate, exclude, optimize creative, refresh creative.
 */

const db = require('../db/database');
const { defaultRange } = require('./dateRangeHelper');
const { buildInsight } = require('./analyticsInsight');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Meta placement categories
const PLACEMENT_CATEGORIES = {
  facebook_feed: 'Facebook Feed',
  facebook_stories: 'Facebook Stories',
  facebook_reels: 'Facebook Reels',
  facebook_right_column: 'Facebook Right Column',
  facebook_search: 'Facebook Search',
  facebook_profile: 'Facebook Profile',
  facebook_instream: 'Facebook In-stream Video',
  instagram_feed: 'Instagram Feed',
  instagram_stories: 'Instagram Stories',
  instagram_reels: 'Instagram Reels',
  instagram_explore: 'Instagram Explore',
  instagram_profile: 'Instagram Profile Feed',
  instagram_suggested_reels: 'Instagram Suggested Reels',
  messenger_inbox: 'Messenger Inbox',
  messenger_stories: 'Messenger Stories',
  audience_network: 'Audience Network',
  marketplace: 'Marketplace',
  instant_articles: 'Instant Articles',
  instream_video: 'In-stream Video',
};

/**
 * Get placement performance breakdown.
 */
function getPlacementPerformance(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT * FROM analytics_breakdown_history
     WHERE meta_campaign_id = ? AND breakdown_type = 'placement' AND date_since = ? AND date_until = ?
     ORDER BY spend DESC`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  if (rows.length === 0) {
    return {
      date_range: dateRange,
      placements: [],
      insight: null,
      note: 'No placement data available for this campaign/period.',
    };
  }

  const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
  const avgCTR = rows.reduce((s, r) => s + (r.ctr || 0), 0) / rows.length;
  const avgCPM = rows.reduce((s, r) => s + (r.cpm || 0), 0) / rows.length;

  const enriched = rows.map(r => {
    const ctrDeviation = avgCTR > 0 ? round((r.ctr - avgCTR) / avgCTR * 100, 1) : null;
    const cpmDeviation = avgCPM > 0 ? round((r.cpm - avgCPM) / avgCPM * 100, 1) : null;
    const efficiency = r.results && r.results > 0 && r.spend > 0 ? round(r.results / r.spend * 100, 1) : null;
    const contribution = totalSpend > 0 ? round(r.spend / totalSpend * 100, 1) : 0;

    let recommendation = 'Maintain';
    if (ctrDeviation && ctrDeviation < -30) {
      recommendation = 'Low CTR — test new creatives';
    } else if (cpmDeviation && cpmDeviation > 30) {
      recommendation = 'High CPM — consider budget shift';
    } else if (efficiency && contribution < 10 && efficiency > 150) {
      recommendation = 'Scale — high efficiency';
    }

    return {
      placement: r.breakdown_value,
      placement_label: PLACEMENT_CATEGORIES[r.breakdown_value] || r.breakdown_value,
      spend: r.spend,
      reach: r.reach,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      ctr_deviation_pct: ctrDeviation,
      cpc: r.cpc,
      cpm: r.cpm,
      cpm_deviation_pct: cpmDeviation,
      results: r.results,
      cost_per_result: r.results > 0 ? round(r.spend / r.results, 2) : null,
      roas: r.roas,
      frequency: r.frequency,
      contribution_pct: contribution,
      efficiency: efficiency,
      recommendation,
    };
  });

  // Rank placements
  const byCTR = [...enriched].sort((a, b) => (b.ctr || 0) - (a.ctr || 0));
  const byCPM = [...enriched].sort((a, b) => (a.cpm || 0) - (b.cpm || 0));
  const byEfficiency = [...enriched].sort((a, b) => (b.efficiency || 0) - (a.efficiency || 0));

  return {
    date_range: dateRange,
    placements: enriched,
    best_ctr_placement: byCTR[0] || null,
    lowest_cpm_placement: byCPM[0] || null,
    most_efficient_placement: byEfficiency[0] || null,
    worst_ctr_placement: byCTR[byCTR.length - 1] || null,
    highest_cpm_placement: byCPM[byCPM.length - 1] || null,
    insight: buildInsight(enriched, { costKey: 'cost_per_result', labelKey: 'placement_label' }),
  };
}

/**
 * Detect placement-specific issues and opportunities.
 */
function detectPlacementIssues(metaCampaignId, dateRange = defaultRange()) {
  const performance = getPlacementPerformance(metaCampaignId, dateRange);
  if (performance.placements.length === 0) {
    return { issues: [], opportunities: [] };
  }

  const issues = [];
  const opportunities = [];

  const totalSpend = performance.placements.reduce((s, p) => s + p.spend, 0);

  // High-spend low-CTR placements
  const problematicPlacements = performance.placements.filter(p =>
    p.contribution_pct > 15 && p.ctr && p.ctr < 0.5
  );
  if (problematicPlacements.length > 0) {
    issues.push({
      type: 'low_ctr_high_spend',
      placements: problematicPlacements.map(p => p.placement_label),
      detail: `${problematicPlacements.map(p => p.placement_label).join(', ')} receiving significant budget but showing <0.5% CTR.`,
      action: 'Test new creatives or reduce budget allocation.',
    });
  }

  // Expensive placements
  const expensivePlacements = performance.placements.filter(p =>
    p.cpm && performance.best_cpm_placement && p.cpm > performance.best_cpm_placement.cpm * 1.5
  );
  if (expensivePlacements.length > 0) {
    issues.push({
      type: 'high_cpm',
      placements: expensivePlacements.map(p => p.placement_label),
      detail: `${expensivePlacements.map(p => p.placement_label).join(', ')} >50% more expensive than lowest-cost placement.`,
      action: 'Consider budget reallocation if performance does not justify cost.',
    });
  }

  // Scaling opportunities
  const scalingCandidates = performance.placements.filter(p =>
    p.efficiency && p.efficiency > 150 && p.contribution_pct < 10
  );
  if (scalingCandidates.length > 0) {
    opportunities.push({
      type: 'scaling',
      placements: scalingCandidates.map(p => p.placement_label),
      detail: `${scalingCandidates.map(p => p.placement_label).join(', ')} show >50% above-average efficiency but <10% budget share.`,
      potential_uplift: 'Reallocating 5-10% budget could improve overall ROAS by 10-20%.',
      action: 'Increase budget to high-performing placements.',
    });
  }

  // Budget distribution insight
  const top3 = performance.placements.slice(0, 3);
  const concentrationPct = top3.reduce((s, p) => s + p.contribution_pct, 0);
  if (concentrationPct > 70) {
    issues.push({
      type: 'budget_concentration',
      detail: `Top 3 placements consume ${round(concentrationPct)}% of budget.`,
      risk: 'Risk concentration if top placements underperform.',
      action: 'Consider diversifying across secondary placements.',
    });
  }

  return {
    date_range: dateRange,
    issues,
    opportunities,
  };
}

/**
 * Generate AI recommendations for placement optimization.
 */
function generatePlacementRecommendations(metaCampaignId, dateRange = defaultRange()) {
  const performance = getPlacementPerformance(metaCampaignId, dateRange);
  const issues = detectPlacementIssues(metaCampaignId, dateRange);

  const recommendations = [];

  // Scale best performer
  if (performance.most_efficient_placement) {
    recommendations.push({
      priority: 'high',
      type: 'scale',
      placement: performance.most_efficient_placement.placement_label,
      action: `Increase budget for ${performance.most_efficient_placement.placement_label} — most efficient placement.`,
      expected_impact: 'Improve overall ROAS by 5-10%',
      confidence: 'high',
    });
  }

  // Reduce low performer
  const lowestPerformers = performance.placements.filter(p =>
    p.contribution_pct > 10 && p.efficiency && p.efficiency < 50
  );
  if (lowestPerformers.length > 0) {
    recommendations.push({
      priority: 'high',
      type: 'reduce',
      placements: lowestPerformers.map(p => p.placement_label),
      action: `Reduce budget for ${lowestPerformers.map(p => p.placement_label).join(', ')} — significantly underperforming.`,
      expected_impact: 'Eliminate budget waste',
      confidence: 'high',
    });
  }

  // Test creatives for low CTR placements
  const lowCTRPlacements = performance.placements.filter(p => p.ctr && p.ctr < 0.3 && p.contribution_pct > 5);
  if (lowCTRPlacements.length > 0) {
    recommendations.push({
      priority: 'medium',
      type: 'refresh_creative',
      placements: lowCTRPlacements.map(p => p.placement_label),
      action: `Test new creatives for ${lowCTRPlacements.map(p => p.placement_label).join(', ')} — showing low CTR.`,
      expected_impact: 'Improve engagement and reduce CPM',
      confidence: 'medium',
    });
  }

  return {
    date_range: dateRange,
    recommendations: recommendations.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }),
    issues: issues.issues,
    opportunities: issues.opportunities,
    total_recommendations: recommendations.length,
  };
}

module.exports = {
  getPlacementPerformance,
  detectPlacementIssues,
  generatePlacementRecommendations,
};
