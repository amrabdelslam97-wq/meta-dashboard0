/**
 * Creative Intelligence Service — Complete Engine
 *
 * Unified service for comprehensive creative analysis:
 * - Performance metrics calculation
 * - Quality scoring (0-100)
 * - Diagnostics & trend analysis
 * - Leaderboard ranking
 * - Conversation destination analysis
 * - Recommendation generation
 *
 * Reuses existing:
 * - creative_analytics table (Phase 19)
 * - smartSyncEngine for data freshness
 * - Meta API client for data fetching
 * - Dashboard integration
 * - Rule engine for recommendations
 */

const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function pctChange(current, prior) {
  if (current == null || prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

// ─────────────────────────────────────────────
// CREATIVE QUALITY SCORING
// ─────────────────────────────────────────────

function classifyScoreStatus(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Very Good';
  if (score >= 55) return 'Good';
  if (score >= 40) return 'Average';
  if (score >= 25) return 'Poor';
  return 'Critical';
}

/**
 * Phase 48 — Blocker 2 (Creative Score consolidation): this used to compute
 * its own independently-weighted score (weights summed to 0.90, not 1.0 --
 * a real normalization bug) that could disagree with both
 * creativeIntelligenceEngine.js's computeCreativeScore() (the canonical,
 * persisted formula) and creativeScoringEngine.js's own formula for the
 * same ad. Now a thin presentation wrapper over the single persisted score:
 * same route shape, same status vocabulary, `components`/`metrics` reshaped
 * to reflect real data instead of a third independently computed breakdown.
 */
function scoreCreative(metaAdId) {
  const latest = db.get(
    `SELECT * FROM creative_analytics WHERE meta_ad_id = ? ORDER BY date_until DESC LIMIT 1`,
    [metaAdId]
  );

  if (!latest || !latest.spend || latest.spend < 5) {
    return {
      meta_ad_id: metaAdId,
      score: null,
      status: 'INSUFFICIENT_DATA',
      reason: 'Minimum $5 spend required for reliable scoring',
    };
  }

  if (latest.score_overall === null || latest.score_overall === undefined) {
    return {
      meta_ad_id: metaAdId,
      score: null,
      status: 'INSUFFICIENT_DATA',
      reason: 'Creative score has not been computed for this ad yet',
    };
  }

  const overallScore = round(latest.score_overall, 1);

  return {
    meta_ad_id: metaAdId,
    score: overallScore,
    status: classifyScoreStatus(overallScore),
    components: {
      hook: round(latest.score_hook, 1),
      headline: round(latest.score_headline, 1),
      copy: round(latest.score_copy, 1),
      visual: round(latest.score_visual, 1),
      cta: round(latest.score_cta, 1),
      offer: round(latest.score_offer, 1),
      trust: round(latest.score_trust, 1),
      psychology: round(latest.score_psychology, 1),
      conversion_potential: round(latest.score_conversion_potential, 1),
      scroll_stop: round(latest.score_scroll_stop, 1),
      retention: round(latest.score_retention, 1),
      brand: round(latest.score_brand, 1),
      fatigue: round(latest.score_fatigue, 1),
    },
    metrics: {
      ctr: latest.ctr,
      cpa: latest.cpa,
      cpm: latest.cpm,
      frequency: latest.frequency,
      p25_retention: latest.video_p25_pct,
      p100_retention: latest.video_p100_pct,
    },
  };
}

// ─────────────────────────────────────────────
// CREATIVE DIAGNOSTICS
// ─────────────────────────────────────────────

/**
 * Automatically detect creative issues and strengths.
 */
function diagnoseCreative(metaAdId) {
  const latest = db.get(
    `SELECT * FROM creative_analytics WHERE meta_ad_id = ? ORDER BY date_until DESC LIMIT 1`,
    [metaAdId]
  );

  if (!latest) {
    return { meta_ad_id: metaAdId, error: 'No data available' };
  }

  const diagnostics = {
    strengths: [],
    weaknesses: [],
    issues: [],
  };

  // Strength: High CTR
  if (latest.ctr > 1.5) {
    diagnostics.strengths.push(`High CTR (${round(latest.ctr, 2)}%) — Strong engagement`);
  }

  // Strength: Strong Hook
  if (latest.video_p25_pct && latest.video_p25_pct > 60) {
    diagnostics.strengths.push(`Strong Hook (${round(latest.video_p25_pct)}% retention at 3s)`);
  }

  // Strength: High Retention
  if (latest.video_p100_pct && latest.video_p100_pct > 40) {
    diagnostics.strengths.push(`High Retention (${round(latest.video_p100_pct)}% complete views)`);
  }

  // Strength: Efficient Results
  if (latest.cpa && latest.cpa < 10) {
    diagnostics.strengths.push(`Efficient Conversions (CPA: $${round(latest.cpa, 2)})`);
  }

  // Weakness: Low CTR
  if (latest.ctr < 0.5) {
    diagnostics.weaknesses.push(`Low CTR (${round(latest.ctr, 2)}%) — Creative doesn't stand out`);
  }

  // Weakness: Weak Hook
  if (latest.video_p25_pct && latest.video_p25_pct < 30) {
    diagnostics.weaknesses.push(`Weak Hook (${round(latest.video_p25_pct)}% retention) — First 3 seconds critical`);
  }

  // Weakness: Poor Retention
  if (latest.video_p100_pct && latest.video_p100_pct < 20) {
    diagnostics.weaknesses.push(`Poor Retention (${round(latest.video_p100_pct)}%) — Viewers leaving early`);
  }

  // Issue: High Frequency
  if (latest.frequency > 3) {
    diagnostics.issues.push(`High Frequency (${round(latest.frequency, 1)}x) — Audience fatigue risk`);
  }

  // Issue: High CPA
  if (latest.cpa > 50) {
    diagnostics.issues.push(`High CPA ($${round(latest.cpa, 2)}) — Inefficient conversions`);
  }

  // Issue: Low Engagement
  if (latest.ctr < 0.3 && latest.spend > 100) {
    diagnostics.issues.push(`Very Low Engagement (<0.3% CTR with high spend) — Consider pausing`);
  }

  return {
    meta_ad_id: metaAdId,
    ...diagnostics,
  };
}

// ─────────────────────────────────────────────
// TREND ANALYSIS
// ─────────────────────────────────────────────

/**
 * Analyze creative performance trend (7d, 14d, 30d, lifetime).
 */
function analyzeCreativeTrend(metaAdId) {
  const periods = [
    { days: 7, label: '7d' },
    { days: 14, label: '14d' },
    { days: 30, label: '30d' },
  ];

  const trends = {};

  for (const period of periods) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period.days);
    const cutoffISO = cutoffDate.toISOString().split('T')[0];

    const data = db.all(
      `SELECT ctr, cpa, spend, results FROM creative_analytics
       WHERE meta_ad_id = ? AND date_until >= ?
       ORDER BY date_until DESC`,
      [metaAdId, cutoffISO]
    );

    if (data.length < 2) continue;

    const current = data[0];
    const prior = data[data.length - 1];

    const ctrTrend = pctChange(current.ctr, prior.ctr);
    const cpaTrend = pctChange(current.cpa, prior.cpa);
    const totalSpend = data.reduce((s, r) => s + (r.spend || 0), 0);

    let status = 'Stable';
    if (ctrTrend > 20) status = 'Exploding';
    else if (ctrTrend > 10) status = 'Growing';
    else if (ctrTrend < -20) status = 'Declining';
    else if (cpaTrend > 30) status = 'Fatigued';
    else status = 'Stable';

    trends[period.label] = {
      ctr_change_pct: round(ctrTrend),
      cpa_change_pct: round(cpaTrend),
      total_spend: round(totalSpend),
      status,
    };
  }

  return {
    meta_ad_id: metaAdId,
    trends,
  };
}

// ─────────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────────

/**
 * Generate creative leaderboards for a campaign.
 */
function getCampaignLeaderboard(metaCampaignId, limit = 20) {
  const creatives = db.all(
    `SELECT * FROM creative_analytics
     WHERE meta_campaign_id = ?
     ORDER BY date_until DESC LIMIT 1000`,
    [metaCampaignId]
  );

  if (creatives.length === 0) {
    return {
      campaign: metaCampaignId,
      note: 'No creative data available for this campaign',
    };
  }

  // Score all creatives
  const scored = creatives
    .filter(c => c.spend >= 5)
    .map(c => {
      const score = scoreCreative(c.meta_ad_id);
      return { ...c, ...score };
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  return {
    campaign: metaCampaignId,
    top_performers: scored.slice(0, limit),
    bottom_performers: scored.slice(-limit).reverse(),
    highest_ctr: [...scored].sort((a, b) => (b.ctr || 0) - (a.ctr || 0)).slice(0, 5),
    highest_roas: [...scored].filter(c => c.roas).sort((a, b) => (b.roas || 0) - (a.roas || 0)).slice(0, 5),
    lowest_cpa: [...scored].filter(c => c.cpa).sort((a, b) => (a.cpa || Infinity) - (b.cpa || Infinity)).slice(0, 5),
  };
}

// ─────────────────────────────────────────────
// CONVERSATION DESTINATION ANALYSIS
// ─────────────────────────────────────────────

/**
 * Break down messaging results by destination.
 */
function analyzeConversationDestinations(metaCampaignId, dateRange) {
  const creatives = db.all(
    `SELECT * FROM creative_analytics
     WHERE meta_campaign_id = ? AND date_since = ? AND date_until = ?`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  const destinations = new Map();
  const destLabels = {
    'MESSENGER': 'Messenger',
    'INSTAGRAM_DIRECT': 'Instagram DM',
    'WHATSAPP': 'WhatsApp',
    'WEBSITE': 'Website',
    'ON_AD': 'On Ad',
  };

  for (const creative of creatives) {
    const dest = creative.destination_type || 'UNKNOWN';
    if (!destinations.has(dest)) {
      destinations.set(dest, {
        spend: 0,
        results: 0,
        clicks: 0,
        ctr: 0,
        count: 0,
      });
    }

    const agg = destinations.get(dest);
    agg.spend += creative.spend || 0;
    agg.results += creative.results || 0;
    agg.clicks += creative.clicks || 0;
    agg.ctr = (agg.ctr * agg.count + (creative.ctr || 0)) / (agg.count + 1);
    agg.count++;
  }

  const totalSpend = Array.from(destinations.values()).reduce((s, d) => s + d.spend, 0);

  const results = Array.from(destinations.entries()).map(([dest, data]) => ({
    destination: destLabels[dest] || dest,
    spend: round(data.spend),
    results: round(data.results),
    ctr: round(data.ctr, 2),
    cost_per_result: data.results > 0 ? round(data.spend / data.results, 2) : null,
    share_of_spend_pct: totalSpend > 0 ? round((data.spend / totalSpend) * 100, 1) : 0,
    share_of_results_pct: Array.from(destinations.values()).reduce((s, d) => s + d.results, 0) > 0
      ? round((data.results / Array.from(destinations.values()).reduce((s, d) => s + d.results, 0)) * 100, 1)
      : 0,
  }));

  return {
    campaign: metaCampaignId,
    date_range: dateRange,
    destinations: results.sort((a, b) => b.spend - a.spend),
  };
}

// ─────────────────────────────────────────────
// RECOMMENDATIONS
// ─────────────────────────────────────────────

/**
 * Generate creative recommendations based on performance.
 */
function generateCreativeRecommendations(metaAdId) {
  const score = scoreCreative(metaAdId);
  const diagnostics = diagnoseCreative(metaAdId);
  const trend = analyzeCreativeTrend(metaAdId);

  const recommendations = [];

  // High performer: Duplicate
  if (score.score >= 75 && Object.values(trend).some(t => t?.status === 'Growing')) {
    recommendations.push({
      priority: 'high',
      type: 'duplicate',
      description: 'High performer with growing trend — create variations',
      expected_impact: 'Extend winning creative life and reach',
    });
  }

  // Low performer: Pause
  if (score.score <= 30 && !diagnostics.weaknesses.includes) {
    recommendations.push({
      priority: 'high',
      type: 'pause',
      description: 'Critical score (< 30) — pause immediately',
      expected_impact: 'Stop wasting budget',
    });
  }

  // Weak hook: Refresh
  if (diagnostics.weaknesses.some(w => w.includes('Weak Hook'))) {
    recommendations.push({
      priority: 'medium',
      type: 'refresh',
      description: 'Weak hook detected — test new creative hook/opening',
      expected_impact: 'Improve initial engagement and retention',
    });
  }

  // High frequency: Reduce or pause
  if (diagnostics.issues.some(i => i.includes('High Frequency'))) {
    recommendations.push({
      priority: 'medium',
      type: 'reduce_frequency',
      description: 'High frequency — reduce audience size or cap frequency',
      expected_impact: 'Combat fatigue and improve CTR',
    });
  }

  return {
    meta_ad_id: metaAdId,
    score: score.score,
    status: score.status,
    recommendations: recommendations.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }),
  };
}

module.exports = {
  scoreCreative,
  diagnoseCreative,
  analyzeCreativeTrend,
  getCampaignLeaderboard,
  analyzeConversationDestinations,
  generateCreativeRecommendations,
};
