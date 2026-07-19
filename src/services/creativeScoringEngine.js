/**
 * Creative Scoring Engine — Phase 21 Section 6
 *
 * Phase 48 — Blocker 2 (Creative Score consolidation): this module used to
 * compute its own independent weighted score (CTR/conversion/hook/ROAS/
 * frequency/CPM, with a hardcoded avgCPA=10 placeholder). That produced a
 * different number than creativeIntelligenceEngine.js's computeCreativeScore()
 * -- the formula actually persisted to creative_analytics.score_* and used
 * by the rest of the Creative Intelligence/Advisor/Executive Decision
 * pipeline -- for the same ad. calculateCreativeScore() is now a thin
 * presentation wrapper over that single persisted score: same route shape,
 * same status vocabulary, same `metrics` block, but `components` reflects
 * the real canonical scoring dimensions instead of a second, independently
 * computed breakdown.
 */

const db = require('../db/database');

function round(n, dp = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

function classifyScoreStatus(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Very Good';
  if (score >= 55) return 'Good';
  if (score >= 40) return 'Average';
  if (score >= 25) return 'Poor';
  return 'Critical';
}

/**
 * Read the canonical Creative Score (persisted by creativeAnalytics.js via
 * creativeIntelligenceEngine.js's computeCreativeScore()) for a single ad,
 * reshaped into this route family's existing response envelope.
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

  if (analytics.score_overall === null || analytics.score_overall === undefined) {
    return {
      meta_ad_id: metaAdId,
      score: null,
      status: 'INSUFFICIENT_DATA',
      reason: 'Creative score has not been computed for this ad yet',
      components: {},
    };
  }

  const overallScore = round(analytics.score_overall);

  return {
    meta_ad_id: metaAdId,
    score: overallScore,
    status: classifyScoreStatus(overallScore),
    components: {
      hook: round(analytics.score_hook),
      headline: round(analytics.score_headline),
      copy: round(analytics.score_copy),
      visual: round(analytics.score_visual),
      cta: round(analytics.score_cta),
      offer: round(analytics.score_offer),
      trust: round(analytics.score_trust),
      psychology: round(analytics.score_psychology),
      conversion_potential: round(analytics.score_conversion_potential),
      scroll_stop: round(analytics.score_scroll_stop),
      retention: round(analytics.score_retention),
      brand: round(analytics.score_brand),
      fatigue: round(analytics.score_fatigue),
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
};
