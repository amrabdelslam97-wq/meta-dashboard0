/**
 * Creative Scoring Engine — Phase 21 Section 6
 *
 * Calculate Creative Score (0-100) from:
 * CTR, Hook, Retention, Conversion, Frequency, Cost, ROAS, Quality
 *
 * Never simulate. Only real Meta data.
 */

const db = require('../db/database');

function round(n, dp = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

/**
 * Normalize a metric to 0-100 scale with configurable benchmarks.
 */
function normalizeMetric(value, benchmarkLow, benchmarkHigh) {
  if (value === null || value === undefined) return null;

  // Map value to 0-100 scale
  // benchmarkLow = 0 points, benchmarkHigh = 100 points
  if (value <= benchmarkLow) return 0;
  if (value >= benchmarkHigh) return 100;

  return ((value - benchmarkLow) / (benchmarkHigh - benchmarkLow)) * 100;
}

/**
 * Calculate Creative Score (0-100) for a single ad.
 * Weights different components and returns an overall score + breakdown.
 */
function calculateCreativeScore(metaAdId) {
  const analytics = db.get(
    `SELECT * FROM creative_analytics
     WHERE meta_ad_id = ?
     ORDER BY date_until DESC LIMIT 1`,
    [metaAdId]
  );

  if (!analytics || !analytics.spend || analytics.spend < 5) {
    return {
      meta_ad_id: metaAdId,
      score: null,
      status: 'INSUFFICIENT_DATA',
      reason: 'Minimum $5 spend required for reliable scoring',
      components: {},
    };
  }

  // 1. CTR Score (0-100)
  // Benchmark: 0% CTR = 0, 3% CTR = 100
  const ctrScore = normalizeMetric(analytics.ctr || 0, 0, 3);

  // 2. Conversion Score (0-100)
  // Based on cost per result (lower is better)
  // Benchmark: High CPA = 0, Excellent CPA = 100
  // Excellent = 50% of current average for objective
  const avgCPA = 10; // Placeholder; should be calculated from account average
  const conversionScore = analytics.cpa
    ? normalizeMetric(avgCPA / (analytics.cpa || avgCPA), 0, 1.5) // Inverse scoring
    : null;

  // 3. Retention/Hook Score (0-100)
  // From video metrics if available
  let hookScore = null;
  if (analytics.video_p25_pct) {
    // P25 retention is a good hook indicator
    hookScore = normalizeMetric(analytics.video_p25_pct || 0, 0, 100);
  } else if (analytics.hold_rate) {
    hookScore = normalizeMetric(analytics.hold_rate || 0, 0, 100);
  }

  // 4. ROAS Score (0-100)
  // Benchmark: ROAS < 1 = 0, ROAS > 5 = 100
  const roasScore = analytics.roas ? normalizeMetric(analytics.roas, 1, 5) : null;

  // 5. Frequency Impact (0-100, inverse)
  // High frequency = creative fatigue = lower score
  // Benchmark: Frequency < 1 = 100, Frequency > 5 = 0
  const frequencyScore = analytics.frequency
    ? 100 - normalizeMetric(analytics.frequency, 1, 5)
    : 50; // Neutral if not available

  // 6. Cost Efficiency (0-100)
  // CPM score: lower is better
  // Benchmark: CPM < $5 = 100, CPM > $20 = 0
  const cpmScore = analytics.cpm ? normalizeMetric(analytics.cpm, 5, 20) : null;

  // Weights
  const weights = {
    ctr: 0.25, // CTR is core engagement signal
    conversion: 0.25, // CPA is core business metric
    hook: 0.15, // Hook retention matters for video
    roas: 0.15, // Business outcome
    frequency: 0.10, // Fatigue indicator
    cpm: 0.10, // Cost efficiency
  };

  // Calculate overall score
  const scoreComponents = {
    ctr: ctrScore !== null ? ctrScore : 50,
    conversion: conversionScore !== null ? conversionScore : 50,
    hook: hookScore !== null ? hookScore : 50,
    roas: roasScore !== null ? roasScore : 50,
    frequency: frequencyScore,
    cpm: cpmScore !== null ? cpmScore : 50,
  };

  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
  let weightedScore = 0;
  for (const [component, value] of Object.entries(scoreComponents)) {
    weightedScore += (value || 0) * (weights[component] || 0);
  }

  const overallScore = Math.min(100, Math.max(0, round(weightedScore / totalWeight)));

  // Determine status
  let status = 'Average';
  if (overallScore >= 85) status = 'Excellent';
  else if (overallScore >= 70) status = 'Very Good';
  else if (overallScore >= 55) status = 'Good';
  else if (overallScore >= 40) status = 'Average';
  else if (overallScore >= 25) status = 'Poor';
  else status = 'Critical';

  return {
    meta_ad_id: metaAdId,
    score: overallScore,
    status,
    components: {
      ctr: round(scoreComponents.ctr),
      conversion: round(scoreComponents.conversion),
      hook: round(scoreComponents.hook),
      roas: round(scoreComponents.roas),
      frequency: round(scoreComponents.frequency),
      cpm: round(scoreComponents.cpm),
    },
    metrics: {
      ctr_pct: analytics.ctr,
      cpa: analytics.cpa,
      roas: analytics.roas,
      frequency: analytics.frequency,
      cpm: analytics.cpm,
      p25_retention: analytics.video_p25_pct,
    },
  };
}

/**
 * Score all creatives for a campaign.
 */
function scoreCreativesByCampaign(metaCampaignId, limit = 50) {
  const ads = db.all(
    `SELECT a.meta_ad_id FROM ads a
     WHERE a.campaign_id = (SELECT id FROM campaigns WHERE meta_campaign_id = ?)
     LIMIT ?`,
    [metaCampaignId, limit]
  );

  const scores = ads.map(ad => calculateCreativeScore(ad.meta_ad_id));

  // Rank creatives
  const ranked = [...scores].filter(s => s.score !== null).sort((a, b) => b.score - a.score);

  return {
    campaign: metaCampaignId,
    total_creatives: scores.length,
    with_scores: ranked.length,
    top_creative: ranked[0] || null,
    bottom_creative: ranked[ranked.length - 1] || null,
    average_score: ranked.length > 0 ? round(ranked.reduce((s, c) => s + c.score, 0) / ranked.length) : null,
    distribution: {
      excellent: ranked.filter(c => c.score >= 85).length,
      very_good: ranked.filter(c => c.score >= 70 && c.score < 85).length,
      good: ranked.filter(c => c.score >= 55 && c.score < 70).length,
      average: ranked.filter(c => c.score >= 40 && c.score < 55).length,
      poor: ranked.filter(c => c.score >= 25 && c.score < 40).length,
      critical: ranked.filter(c => c.score < 25).length,
    },
    scores: ranked,
  };
}

module.exports = {
  calculateCreativeScore,
  scoreCreativesByCampaign,
  normalizeMetric,
};
