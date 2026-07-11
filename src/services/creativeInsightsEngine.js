/**
 * Creative Insights Engine — Phase 21 Section 9
 *
 * Generate AI insights about creative performance.
 * Top Strengths, Top Weaknesses, Why it wins, Why it loses,
 * Biggest Opportunity, Biggest Risk.
 */

const db = require('../db/database');
const { calculateCreativeScore } = require('./creativeScoringEngine');
const { detectCreativeFatigue } = require('./creativeFatigueEngine');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Generate comprehensive AI insights for a creative.
 */
function generateCreativeInsights(metaAdId) {
  const analytics = db.get(
    `SELECT * FROM creative_analytics WHERE meta_ad_id = ? ORDER BY date_until DESC LIMIT 1`,
    [metaAdId]
  );

  if (!analytics || !analytics.spend || analytics.spend < 5) {
    return {
      meta_ad_id: metaAdId,
      error: 'Insufficient data for analysis (minimum $5 spend required)',
    };
  }

  const score = calculateCreativeScore(metaAdId);
  const fatigue = detectCreativeFatigue(metaAdId);

  const insights = {
    meta_ad_id: metaAdId,
    overall_score: score.score,
    fatigue_status: fatigue.status,
  };

  // Top Strengths (components scoring highest)
  const componentScores = Object.entries(score.components)
    .map(([name, value]) => ({ name, value: value || 0 }))
    .sort((a, b) => b.value - a.value);

  insights.top_strengths = [];
  if (componentScores[0]?.value > 70) {
    if (componentScores[0].name === 'ctr') {
      insights.top_strengths.push(`Excellent click-through rate (${round(analytics.ctr, 3)}%)`);
    } else if (componentScores[0].name === 'hook') {
      insights.top_strengths.push(`Strong hook/retention (${round(analytics.video_p25_pct || 0)}%)`);
    } else if (componentScores[0].name === 'roas') {
      insights.top_strengths.push(`High return on ad spend (${round(analytics.roas, 1)}x)`);
    } else if (componentScores[0].name === 'conversion') {
      insights.top_strengths.push(`Strong conversion efficiency (CPA: $${round(analytics.cpa, 2)})`);
    }
  }
  if (componentScores[1]?.value > 70) {
    insights.top_strengths.push(`Secondary strength: ${componentScores[1].name}`);
  }

  // Top Weaknesses (components scoring lowest)
  const weakestComponent = componentScores[componentScores.length - 1];
  insights.top_weaknesses = [];
  if (weakestComponent?.value < 40) {
    if (weakestComponent.name === 'ctr') {
      insights.top_weaknesses.push(`Low click-through rate (${round(analytics.ctr, 3)}%)`);
    } else if (weakestComponent.name === 'frequency') {
      insights.top_weaknesses.push(`High frequency fatigue (${round(analytics.frequency, 1)}x)`);
    } else if (weakestComponent.name === 'cpm') {
      insights.top_weaknesses.push(`High cost-per-impression ($${round(analytics.cpm, 2)})`);
    }
  }

  // Why it wins / Why it loses
  insights.why_it_wins = [];
  insights.why_it_loses = [];

  if (analytics.ctr > 1.5) {
    insights.why_it_wins.push('High engagement — audience resonates with content');
  }
  if (analytics.roas > 2) {
    insights.why_it_wins.push('Drives profitable results — strong conversion link');
  }
  if (analytics.frequency < 2) {
    insights.why_it_wins.push('Fresh audience reach — minimal saturation');
  }

  if (analytics.ctr < 0.5) {
    insights.why_it_loses.push('Low engagement — creative doesn\'t stand out');
  }
  if (analytics.frequency > 3) {
    insights.why_it_loses.push('High frequency fatigue — audience has seen this repeatedly');
  }
  if (analytics.cpa > 30) {
    insights.why_it_loses.push('Inefficient conversions — cost exceeds value');
  }

  // Biggest Opportunity
  insights.biggest_opportunity = null;
  if (analytics.spend > 100 && analytics.ctr < 1 && score.components.ctr < 50) {
    insights.biggest_opportunity = {
      type: 'engagement_improvement',
      description: 'Test new visuals or headlines — could significantly improve CTR',
      potential_uplift: 'Improving CTR by 50% could reduce CPA by 30%',
    };
  }
  if (analytics.frequency > 4 && analytics.ctr > 1.5 && analytics.roas > 1.5) {
    insights.biggest_opportunity = {
      type: 'scaling',
      description: 'Scale this high-performing creative — strong metrics despite high frequency',
      potential_uplift: 'Doubling budget could deliver 40-60% revenue increase',
    };
  }

  // Biggest Risk
  insights.biggest_risk = null;
  if (fatigue.status === 'Fatigued') {
    insights.biggest_risk = {
      type: 'creative_fatigue',
      description: 'Creative is fatigued — performance declining rapidly',
      risk_level: 'Critical',
      action: 'Pause immediately and replace with fresh creative',
    };
  }
  if (fatigue.status === 'Getting Tired') {
    insights.biggest_risk = {
      type: 'approaching_fatigue',
      description: 'Showing early signs of fatigue — act before decline accelerates',
      risk_level: 'High',
      action: 'Begin developing refresh; consider launching variations',
    };
  }
  if (analytics.cpm > 50 && analytics.ctr < 0.5) {
    insights.biggest_risk = {
      type: 'cost_inefficiency',
      description: 'High CPM with low CTR = wasted budget',
      risk_level: 'High',
      action: 'Test new creative or pause if not improving',
    };
  }

  return insights;
}

/**
 * Compare two creatives within a campaign.
 */
function compareCreatives(metaAdId1, metaAdId2) {
  const creative1 = db.get(
    `SELECT ca.*, a.name FROM creative_analytics ca
     JOIN ads a ON a.meta_ad_id = ca.meta_ad_id
     WHERE ca.meta_ad_id = ? ORDER BY ca.date_until DESC LIMIT 1`,
    [metaAdId1]
  );

  const creative2 = db.get(
    `SELECT ca.*, a.name FROM creative_analytics ca
     JOIN ads a ON a.meta_ad_id = ca.meta_ad_id
     WHERE ca.meta_ad_id = ? ORDER BY ca.date_until DESC LIMIT 1`,
    [metaAdId2]
  );

  if (!creative1 || !creative2) {
    return { error: 'One or both creatives not found' };
  }

  const metrics = ['spend', 'ctr', 'cpm', 'cpa', 'roas', 'frequency'];
  const comparison = {};

  for (const metric of metrics) {
    const val1 = creative1[metric];
    const val2 = creative2[metric];

    if (val1 && val2) {
      const pctDiff = ((val2 - val1) / val1) * 100;
      const winner = pctDiff > 0 ? 'creative_2' : 'creative_1';

      comparison[metric] = {
        creative_1_value: val1,
        creative_2_value: val2,
        percent_difference: round(pctDiff, 1),
        winner: winner,
      };
    }
  }

  return {
    creative_1: {
      meta_ad_id: metaAdId1,
      name: creative1.name,
    },
    creative_2: {
      meta_ad_id: metaAdId2,
      name: creative2.name,
    },
    comparison,
  };
}

module.exports = {
  generateCreativeInsights,
  compareCreatives,
};
