/**
 * Audience Scoring Engine — Phase 23
 *
 * Scores audience segments 0-100 across multiple dimensions:
 * - Cost Efficiency (CPM, CPA trends)
 * - Volume (spend, impressions, reach contribution)
 * - Conversion Rate (CPC, CTR, conversion rate)
 * - Return (ROAS)
 * - Frequency (audience saturation)
 * - Trend (performance change)
 * - Stability (variance in metrics)
 *
 * Generates audience segment health scores used by dashboards,
 * recommendations, and opportunity detection engines.
 */

const db = require('../db/database');
const { defaultRange } = require('./dateRangeHelper');

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
// SCORE CALCULATION
// ─────────────────────────────────────────────

/**
 * Calculate comprehensive audience segment score (0-100).
 * Uses weighted components:
 * - Volume (20%) — contribution to overall spend
 * - Efficiency (25%) — CPM and CPA favorability
 * - Conversion (20%) — CTR and conversion rate
 * - Return (20%) — ROAS favorability
 * - Saturation (10%) — frequency and CPM trend
 * - Stability (5%) — metric consistency over time
 */
function scoreAudienceSegment(metaCampaignId, dimension = 'age_gender', segmentValue, dateRange = defaultRange()) {
  const current = db.get(
    `SELECT * FROM analytics_breakdown_history
     WHERE entity_meta_id = ? AND breakdown_type = ? AND breakdown_value = ?
     AND date_since = ? AND date_until = ?`,
    [metaCampaignId, dimension, segmentValue, dateRange.since, dateRange.until]
  );

  if (!current || !current.spend || current.spend < 5) {
    return {
      segment: segmentValue,
      dimension,
      score: null,
      status: 'INSUFFICIENT_DATA',
      reason: 'Minimum $5 spend required',
    };
  }

  const scores = {};

  // 1. VOLUME SCORE (20% weight)
  // Get total campaign spend to calculate contribution
  const totalSpend = db.get(
    `SELECT SUM(spend) as total FROM analytics_breakdown_history
     WHERE entity_meta_id = ? AND breakdown_type = ? AND date_since = ? AND date_until = ?`,
    [metaCampaignId, dimension, dateRange.since, dateRange.until]
  );
  const contribution = totalSpend?.total ? (current.spend / totalSpend.total) * 100 : 0;
  // Contribution 10-30% is ideal; <5% or >40% is suboptimal
  if (contribution < 5) {
    scores.volume = 30;
  } else if (contribution < 10) {
    scores.volume = 50;
  } else if (contribution <= 30) {
    scores.volume = 100;
  } else if (contribution <= 40) {
    scores.volume = 85;
  } else {
    scores.volume = 60;
  }

  // 2. EFFICIENCY SCORE (25% weight)
  // Combined CPM and CPA favorability
  const cpm = current.cpm || 0;
  const cpa = current.cost_per_result || 0;
  // Assume global benchmarks: good CPM < $10, good CPA < $20
  let cpmScore = Math.min(100, Math.max(0, 100 - (cpm / 10 * 100)));
  let cpaScore = cpa ? Math.min(100, Math.max(0, 100 - (cpa / 20 * 100))) : 50;
  scores.efficiency = Math.round((cpmScore * 0.4 + cpaScore * 0.6));

  // 3. CONVERSION SCORE (20% weight)
  // CTR and conversion indicators
  const ctr = current.ctr || 0;
  // Good CTR benchmark: >0.8%
  let ctrScore = Math.min(100, Math.max(0, ctr / 0.008 * 100));
  // If frequency data available, factor in conversion consistency
  const frequency = current.frequency || 0;
  // Good frequency: 1-2x
  let frequencyScore = frequency < 1 ? 100 : frequency <= 2 ? 90 : frequency <= 3 ? 70 : 40;
  scores.conversion = Math.round((ctrScore * 0.6 + frequencyScore * 0.4));

  // 4. RETURN SCORE (20% weight)
  const roas = current.roas || 0;
  // Good ROAS: >2x
  scores.return = roas ? Math.min(100, Math.max(0, (roas / 2) * 100)) : 50;

  // 5. SATURATION SCORE (10% weight)
  // High frequency + low CTR = audience fatigue
  let saturationScore = 100;
  if (frequency > 3 && ctr < 0.5) {
    saturationScore = 30;
  } else if (frequency > 2.5 && ctr < 0.8) {
    saturationScore = 50;
  } else if (frequency > 2) {
    saturationScore = 75;
  }
  scores.saturation = saturationScore;

  // 6. STABILITY SCORE (5% weight)
  // Check if this segment has prior period data for variance analysis
  const prior = db.get(
    `SELECT * FROM analytics_breakdown_history
     WHERE entity_meta_id = ? AND breakdown_type = ? AND breakdown_value = ?
     AND date_since < ? AND date_until <= ?
     ORDER BY date_until DESC LIMIT 1`,
    [metaCampaignId, dimension, segmentValue, dateRange.since, dateRange.since]
  );

  let stabilityScore = 100;
  if (prior) {
    const ctrChange = pctChange(current.ctr, prior.ctr);
    const cpaChange = pctChange(current.cost_per_result, prior.cost_per_result);
    const variance = Math.abs(ctrChange || 0) + Math.abs(cpaChange || 0);
    if (variance > 50) {
      stabilityScore = 40;
    } else if (variance > 30) {
      stabilityScore = 60;
    } else if (variance > 10) {
      stabilityScore = 80;
    }
  } else {
    stabilityScore = 70; // No history, neutral score
  }
  scores.stability = stabilityScore;

  // CALCULATE OVERALL SCORE
  const weights = {
    volume: 0.20,
    efficiency: 0.25,
    conversion: 0.20,
    return: 0.20,
    saturation: 0.10,
    stability: 0.05,
  };

  const overallScore = Object.entries(weights).reduce((sum, [key, weight]) => {
    return sum + ((scores[key] || 50) * weight);
  }, 0);

  // STATUS MAPPING
  let status = 'Average';
  if (overallScore >= 85) status = 'Excellent';
  else if (overallScore >= 70) status = 'Very Good';
  else if (overallScore >= 55) status = 'Good';
  else if (overallScore >= 40) status = 'Average';
  else if (overallScore >= 25) status = 'Poor';
  else status = 'Critical';

  return {
    segment: segmentValue,
    dimension,
    score: round(overallScore),
    status,
    components: {
      volume: round(scores.volume),
      efficiency: round(scores.efficiency),
      conversion: round(scores.conversion),
      return: round(scores.return),
      saturation: round(scores.saturation),
      stability: round(scores.stability),
    },
    metrics: {
      spend: current.spend,
      contribution_pct: round(contribution, 1),
      cpm: round(cpm, 2),
      cpa: round(cpa, 2),
      ctr: round(ctr, 3),
      roas: round(roas, 2),
      frequency: round(frequency, 2),
    },
  };
}

/**
 * Score all segments in a dimension for a campaign.
 * Returns ranked list with scores.
 */
function scoreAudienceDimension(metaCampaignId, dimension = 'age_gender', dateRange = defaultRange()) {
  const segments = db.all(
    `SELECT DISTINCT breakdown_value FROM analytics_breakdown_history
     WHERE entity_meta_id = ? AND breakdown_type = ? AND date_since = ? AND date_until = ?`,
    [metaCampaignId, dimension, dateRange.since, dateRange.until]
  );

  if (segments.length === 0) {
    return {
      dimension,
      date_range: dateRange,
      segments: [],
      note: `No audience data available for dimension: ${dimension}`,
    };
  }

  const scored = segments.map(s => scoreAudienceSegment(metaCampaignId, dimension, s.breakdown_value, dateRange));

  // Sort by score descending
  scored.sort((a, b) => (b.score || 0) - (a.score || 0));

  const statusCounts = {};
  for (const s of scored) {
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  }

  return {
    dimension,
    date_range: dateRange,
    total_segments: scored.length,
    status_distribution: statusCounts,
    segments: scored,
    top_performers: scored.filter(s => s.score >= 70).slice(0, 10),
    underperformers: scored.filter(s => s.score < 40).slice(0, 10),
  };
}

/**
 * Get ranking across all major dimensions.
 */
function getRankingAcrossAllDimensions(metaCampaignId, dateRange = defaultRange()) {
  const dimensions = ['age_gender', 'gender', 'age', 'country', 'region', 'placement', 'impression_device', 'device_platform'];

  const results = {};
  for (const dim of dimensions) {
    const scored = scoreAudienceDimension(metaCampaignId, dim, dateRange);
    results[dim] = {
      top_3: scored.segments.slice(0, 3),
      bottom_3: scored.segments.slice(-3).reverse(),
      status_counts: scored.status_distribution,
    };
  }

  return {
    date_range: dateRange,
    by_dimension: results,
  };
}

module.exports = {
  scoreAudienceSegment,
  scoreAudienceDimension,
  getRankingAcrossAllDimensions,
};
