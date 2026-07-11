/**
 * Creative Attribution Engine — Attribution & Customer Journey Intelligence
 * (Step 12)
 *
 * Connects Creative Intelligence's already-computed, already-persisted
 * per-creative scores (creative_analytics.score_hook/score_headline/
 * score_cta/score_offer/score_visual/score_trust, set by
 * creativeAnalytics.js's sync pipeline -- see the Creative Intelligence
 * Engine phase) to real outcomes (results, ROAS, cost per result, retention,
 * fatigue) -- pure aggregation over already-synced data, zero new Meta
 * calls, zero new sync mechanism. Answers "which Hook generated more
 * messages/sales/higher ROAS/better retention/lower CPA" by bucketing
 * creatives into score tiers and comparing real averages across tiers, not
 * a fabricated causal claim -- correlation across this account's own
 * creatives, honestly labeled as such.
 */

const db = require('../db/database');
const { defaultRange } = require('./dateRangeHelper');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const SCORE_TIERS = [
  { key: 'high', label: 'High (70-100)', min: 70, max: 100 },
  { key: 'medium', label: 'Medium (40-69)', min: 40, max: 69 },
  { key: 'low', label: 'Low (0-39)', min: 0, max: 39 },
];

const SCORE_DIMENSIONS = ['score_hook', 'score_headline', 'score_copy', 'score_cta', 'score_offer', 'score_visual', 'score_trust'];

function avg(values) {
  const real = values.filter(v => v != null);
  return real.length > 0 ? round(real.reduce((s, v) => s + v, 0) / real.length) : null;
}

/**
 * @param {string} scoreDimension - one of SCORE_DIMENSIONS
 * @param {object[]} rows - creative_analytics rows for one campaign/date range
 */
function attributeByScoreDimension(scoreDimension, rows) {
  const withScore = rows.filter(r => r[scoreDimension] != null);
  const tiers = SCORE_TIERS.map(tier => {
    const inTier = withScore.filter(r => r[scoreDimension] >= tier.min && r[scoreDimension] <= tier.max);
    const fatigued = inTier.filter(r => r.fatigue_status === 'moderate' || r.fatigue_status === 'severe').length;
    return {
      tier: tier.key,
      label: tier.label,
      creative_count: inTier.length,
      avg_results: avg(inTier.map(r => r.results)),
      avg_roas: avg(inTier.map(r => r.roas)),
      avg_cost_per_result: avg(inTier.map(r => r.cpa)),
      avg_retention: avg(inTier.map(r => r.hold_rate ?? r.video_p100_pct)),
      fatigue_rate_pct: inTier.length > 0 ? round((fatigued / inTier.length) * 100, 1) : null,
    };
  }).filter(t => t.creative_count > 0);

  return { score_dimension: scoreDimension, tiers };
}

/**
 * @param {string} metaCampaignId
 * @param {{since,until}} [dateRange]
 */
function getCreativeAttribution(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT meta_ad_id, headline, destination_type, results, roas, cpa, hold_rate, video_p100_pct, fatigue_status,
            score_hook, score_headline, score_copy, score_cta, score_offer, score_visual, score_trust, score_overall
     FROM creative_analytics WHERE meta_campaign_id = ? AND date_since = ? AND date_until = ?`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  if (rows.length === 0) {
    return {
      date_range: dateRange,
      by_score_dimension: [],
      note: 'No scored creatives found for this campaign/period -- run a Creative Analytics sync first (Creative Intelligence Engine).',
    };
  }

  const byScoreDimension = SCORE_DIMENSIONS
    .map(dim => attributeByScoreDimension(dim, rows))
    .filter(d => d.tiers.length > 0);

  // Top/bottom performer by score_overall (real ranking, not a tier average).
  const ranked = [...rows].filter(r => r.score_overall != null).sort((a, b) => b.score_overall - a.score_overall);
  const bestCreative = ranked[0] || null;
  const worstCreative = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  return {
    date_range: dateRange,
    creative_count: rows.length,
    by_score_dimension: byScoreDimension,
    best_creative: bestCreative ? { meta_ad_id: bestCreative.meta_ad_id, headline: bestCreative.headline, score_overall: bestCreative.score_overall, results: bestCreative.results, roas: bestCreative.roas } : null,
    worst_creative: worstCreative ? { meta_ad_id: worstCreative.meta_ad_id, headline: worstCreative.headline, score_overall: worstCreative.score_overall, results: worstCreative.results, roas: worstCreative.roas } : null,
    methodology_note: 'Tiers compare this campaign\'s own creatives against each other (correlation, not a controlled experiment) -- a real, evidence-backed comparison of what actually happened, never a causal guarantee that raising a score will reproduce these exact deltas.',
  };
}

module.exports = { getCreativeAttribution, attributeByScoreDimension, SCORE_TIERS, SCORE_DIMENSIONS };
