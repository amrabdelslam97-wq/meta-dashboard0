/**
 * Creative Fatigue Engine — Phase 21 Section 7
 *
 * Detect creative fatigue using:
 * - Frequency trend
 * - CTR trend
 * - CPM trend
 * - Cost trend
 * - Conversion trend
 * - Result trend
 *
 * Return: Fresh, Stable, Getting Tired, Fatigued, Dead Creative
 */

const db = require('../db/database');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function pctChange(current, prior) {
  if (current == null || prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/**
 * Analyze creative fatigue by comparing recent performance to historical.
 */
function detectCreativeFatigue(metaAdId, lookbackDays = 30) {
  // Get creative analytics history (if available as time series)
  // For now, we use the snapshot approach from creative_analytics

  const latest = db.get(
    `SELECT * FROM creative_analytics WHERE meta_ad_id = ? ORDER BY date_until DESC LIMIT 1`,
    [metaAdId]
  );

  if (!latest) {
    return {
      meta_ad_id: metaAdId,
      status: 'UNKNOWN',
      reason: 'No performance data available',
    };
  }

  // Get prior period data if available (assuming multiple date ranges in table)
  const prior = db.get(
    `SELECT * FROM creative_analytics WHERE meta_ad_id = ?
     AND date_until < ? ORDER BY date_until DESC LIMIT 1`,
    [metaAdId, latest.date_since]
  );

  // Fatigue indicators
  const fatigueSignals = {
    frequency_increase: 0,
    ctr_decline: 0,
    cpm_increase: 0,
    cpa_increase: 0,
    roas_decline: 0,
  };

  if (prior) {
    // Frequency increase (fatigue indicator)
    if (prior.frequency && latest.frequency) {
      const freqChange = pctChange(latest.frequency, prior.frequency);
      if (freqChange > 20) fatigueSignals.frequency_increase = 1;
    }

    // CTR decline (main fatigue signal)
    if (prior.ctr && latest.ctr) {
      const ctrChange = pctChange(latest.ctr, prior.ctr);
      if (ctrChange < -15) fatigueSignals.ctr_decline = 2; // Higher weight
    }

    // CPM increase (indicates less competitive targeting)
    if (prior.cpm && latest.cpm) {
      const cpmChange = pctChange(latest.cpm, prior.cpm);
      if (cpmChange > 20) fatigueSignals.cpm_increase = 1;
    }

    // CPA increase (conversion efficiency decline)
    if (prior.cpa && latest.cpa) {
      const cpaChange = pctChange(latest.cpa, prior.cpa);
      if (cpaChange > 25) fatigueSignals.cpa_increase = 1;
    }

    // ROAS decline
    if (prior.roas && latest.roas) {
      const roasChange = pctChange(latest.roas, prior.roas);
      if (roasChange < -20) fatigueSignals.roas_decline = 1;
    }
  }

  const totalSignals = Object.values(fatigueSignals).reduce((s, v) => s + v, 0);

  // Determine fatigue status
  let status = 'Fresh';
  if (totalSignals >= 5) {
    status = 'Dead Creative';
  } else if (totalSignals >= 3) {
    status = 'Fatigued';
  } else if (totalSignals >= 2) {
    status = 'Getting Tired';
  } else if (totalSignals >= 1) {
    status = 'Stable'; // Starting to show signs
  }

  // Additional fatigue indicators from single snapshot
  const absoluteFatigueIndicators = [];

  // High frequency + low CTR = fatigue
  if (latest.frequency > 3 && latest.ctr < 0.5) {
    absoluteFatigueIndicators.push('High frequency with low CTR');
    if (status === 'Fresh' || status === 'Stable') status = 'Getting Tired';
  }

  // Very low CTR
  if (latest.ctr < 0.3) {
    absoluteFatigueIndicators.push('Very low CTR (<0.3%)');
    if (status !== 'Fatigued' && status !== 'Dead Creative') status = 'Fatigued';
  }

  return {
    meta_ad_id: metaAdId,
    status,
    fatigue_score: totalSignals, // 0-5+ scale
    signals: {
      frequency_increase: fatigueSignals.frequency_increase > 0,
      ctr_decline: fatigueSignals.ctr_decline > 0,
      cpm_increase: fatigueSignals.cpm_increase > 0,
      cpa_increase: fatigueSignals.cpa_increase > 0,
      roas_decline: fatigueSignals.roas_decline > 0,
    },
    indicators: absoluteFatigueIndicators,
    metrics: {
      current_frequency: latest.frequency,
      current_ctr: latest.ctr,
      current_cpm: latest.cpm,
      current_cpa: latest.cpa,
      current_roas: latest.roas,
      prior_frequency: prior ? prior.frequency : null,
      prior_ctr: prior ? prior.ctr : null,
      prior_cpm: prior ? prior.cpm : null,
      prior_cpa: prior ? prior.cpa : null,
      prior_roas: prior ? prior.roas : null,
    },
    recommendation: getRefreshRecommendation(status),
  };
}

/**
 * Get recommendation based on fatigue status.
 */
function getRefreshRecommendation(status) {
  const recommendations = {
    'Fresh': 'Maintain current performance. Monitor closely.',
    'Stable': 'Monitor for fatigue signals. Consider A/B testing variations.',
    'Getting Tired': 'Start developing refresh. Test new headline or visual.',
    'Fatigued': 'Begin immediate creative refresh. Launch variations.',
    'Dead Creative': 'Pause immediately. Replace with new creative.',
  };

  return recommendations[status] || 'Monitor performance';
}

/**
 * Batch detect fatigue for all creatives in campaign.
 */
function detectCampaignFatigue(metaCampaignId) {
  const ads = db.all(
    `SELECT a.meta_ad_id FROM ads a
     WHERE a.campaign_id = (SELECT id FROM campaigns WHERE meta_campaign_id = ?)`,
    [metaCampaignId]
  );

  const results = ads.map(ad => detectCreativeFatigue(ad.meta_ad_id));
  const byStatus = {
    'Fresh': 0,
    'Stable': 0,
    'Getting Tired': 0,
    'Fatigued': 0,
    'Dead Creative': 0,
    'UNKNOWN': 0,
  };

  for (const result of results) {
    byStatus[result.status] = (byStatus[result.status] || 0) + 1;
  }

  return {
    campaign: metaCampaignId,
    total_creatives: results.length,
    fatigue_status: byStatus,
    creatives_to_refresh: results.filter(r => r.status === 'Getting Tired' || r.status === 'Fatigued').length,
    creatives_to_pause: results.filter(r => r.status === 'Dead Creative').length,
    high_performers: results.filter(r => r.status === 'Fresh').length,
    fatigued_creatives: results.filter(r => r.status !== 'Fresh' && r.status !== 'UNKNOWN'),
  };
}

module.exports = {
  detectCreativeFatigue,
  detectCampaignFatigue,
  getRefreshRecommendation,
};
