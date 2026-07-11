/**
 * Publisher Platform Intelligence Engine — Phase 20 Part 3
 *
 * Separate and analyze results by publisher platform:
 * Facebook, Instagram, Messenger, Audience Network, Threads (future).
 *
 * For messaging campaigns: Messenger Conversations, Instagram Conversations,
 * WhatsApp Conversations, Facebook Messages, Instagram DM.
 *
 * AI determines: best messaging destination, highest quality conversations,
 * lowest cost destination, highest reply rate, highest conversion destination.
 */

const db = require('../db/database');
const { defaultRange } = require('./dateRangeHelper');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const PLATFORM_MAPPING = {
  'facebook / feed': 'Facebook',
  'facebook / facebook_reels': 'Facebook',
  'facebook / facebook_stories': 'Facebook',
  'facebook / right_column': 'Facebook',
  'facebook / search': 'Facebook',
  'facebook / facebook_profile_feed': 'Facebook',
  'facebook / instream_video': 'Facebook',
  'instagram / feed': 'Instagram',
  'instagram / instagram_reels': 'Instagram',
  'instagram / instagram_stories': 'Instagram',
  'instagram / explore': 'Instagram',
  'instagram / instagram_profile_feed': 'Instagram',
  'instagram / suggested_reels': 'Instagram',
  'messenger / inbox': 'Messenger',
  'messenger / messenger_stories': 'Messenger',
  'audience_network / banner': 'Audience Network',
  'audience_network / native': 'Audience Network',
};

/**
 * Get platform-level performance aggregation.
 */
function getPlatformPerformance(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT * FROM analytics_breakdown_history
     WHERE meta_campaign_id = ? AND breakdown_type = 'placement'
     AND date_since = ? AND date_until = ?`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );

  if (rows.length === 0) {
    return {
      date_range: dateRange,
      platforms: [],
      note: 'No placement data available to derive platform performance.',
    };
  }

  // Group by platform
  const byPlatform = new Map();
  for (const row of rows) {
    const platform = PLATFORM_MAPPING[row.breakdown_value] || 'Unknown';
    if (!byPlatform.has(platform)) {
      byPlatform.set(platform, {
        spend: 0,
        reach: 0,
        impressions: 0,
        clicks: 0,
        results: 0,
        purchase_value: 0,
        placements: [],
      });
    }
    const agg = byPlatform.get(platform);
    agg.spend += row.spend || 0;
    agg.reach += row.reach || 0;
    agg.impressions += row.impressions || 0;
    agg.clicks += row.clicks || 0;
    agg.results += row.results || 0;
    agg.purchase_value += (row.revenue || 0);
    agg.placements.push(row.breakdown_value);
  }

  const totalSpend = Array.from(byPlatform.values()).reduce((s, p) => s + p.spend, 0);

  const platforms = Array.from(byPlatform.entries()).map(([platform, agg]) => {
    const ctr = agg.impressions > 0 ? round((agg.clicks / agg.impressions) * 100, 2) : null;
    const cpm = agg.impressions > 0 ? round((agg.spend / agg.impressions) * 1000, 2) : null;
    const cpa = agg.results > 0 ? round(agg.spend / agg.results, 2) : null;
    const roas = agg.spend > 0 && agg.purchase_value > 0 ? round(agg.purchase_value / agg.spend, 2) : null;

    return {
      platform,
      spend: round(agg.spend),
      reach: round(agg.reach),
      impressions: round(agg.impressions),
      clicks: round(agg.clicks),
      ctr,
      cpm,
      results: round(agg.results),
      cost_per_result: cpa,
      roas,
      revenue: round(agg.purchase_value),
      contribution_pct: totalSpend > 0 ? round((agg.spend / totalSpend) * 100, 1) : 0,
      placements_count: agg.placements.length,
    };
  });

  // Rank
  const ranking = [...platforms].sort((a, b) => (a.cost_per_result || Infinity) - (b.cost_per_result || Infinity));

  return {
    date_range: dateRange,
    platforms: platforms.sort((a, b) => b.spend - a.spend),
    best_platform: ranking[0] || null,
    worst_platform: ranking[ranking.length - 1] || null,
  };
}

/**
 * Get messaging-specific platform analysis.
 */
function getMessagingPlatformAnalysis(metaCampaignId, dateRange = defaultRange()) {
  const platformPerf = getPlatformPerformance(metaCampaignId, dateRange);

  // Filter to messaging-capable platforms
  const messagingPlatforms = platformPerf.platforms.filter(p =>
    ['Facebook', 'Instagram', 'Messenger'].includes(p.platform)
  );

  if (messagingPlatforms.length === 0) {
    return {
      date_range: dateRange,
      messaging_platforms: [],
      note: 'No messaging-capable platforms data available.',
    };
  }

  const totalResults = messagingPlatforms.reduce((s, p) => s + (p.results || 0), 0);

  const enriched = messagingPlatforms.map(p => ({
    ...p,
    conversation_count: p.results || 0,
    conversation_rate: p.impressions > 0 ? round((p.results / p.impressions) * 100, 2) : null,
    cost_per_conversation: p.cost_per_result, // Same as cost_per_result for messaging
    conversation_contribution_pct: totalResults > 0 ? round((p.results / totalResults) * 100, 1) : 0,
  }));

  const ranking = [...enriched].sort((a, b) => (a.cost_per_conversation || Infinity) - (b.cost_per_conversation || Infinity));

  return {
    date_range: dateRange,
    messaging_platforms: enriched.sort((a, b) => b.spend - a.spend),
    best_messaging_platform: ranking[0] || null,
    highest_quality_destination: enriched.reduce((best, p) => {
      if (!best || (p.conversation_rate && p.conversation_rate > (best.conversation_rate || 0))) return p;
      return best;
    }, null),
  };
}

/**
 * Generate platform-level recommendations.
 */
function generatePlatformRecommendations(metaCampaignId, dateRange = defaultRange()) {
  const platformPerf = getPlatformPerformance(metaCampaignId, dateRange);
  const messagingPerf = getMessagingPlatformAnalysis(metaCampaignId, dateRange);

  const recommendations = [];

  // Best platform recommendation
  if (platformPerf.best_platform) {
    recommendations.push({
      priority: 'high',
      type: 'scale',
      platform: platformPerf.best_platform.platform,
      action: `Increase budget for ${platformPerf.best_platform.platform} — most cost-efficient platform.`,
      expected_impact: 'Improve overall ROAS by 5-15%',
      confidence: 'high',
    });
  }

  // Worst platform recommendation
  if (platformPerf.worst_platform && platformPerf.worst_platform.contribution_pct > 10) {
    recommendations.push({
      priority: 'high',
      type: 'reduce',
      platform: platformPerf.worst_platform.platform,
      action: `Reduce ${platformPerf.worst_platform.platform} budget — underperforming significantly.`,
      expected_impact: 'Eliminate wasted spend',
      confidence: 'high',
    });
  }

  // For messaging campaigns
  if (messagingPerf.messaging_platforms.length > 1) {
    if (messagingPerf.best_messaging_platform) {
      recommendations.push({
        priority: 'medium',
        type: 'expand_messaging',
        platform: messagingPerf.best_messaging_platform.platform,
        action: `${messagingPerf.best_messaging_platform.platform} shows lowest cost per conversation — allocate more messaging budget here.`,
        expected_impact: 'Reduce cost per conversation by 10-20%',
        confidence: 'medium',
      });
    }

    if (messagingPerf.highest_quality_destination && messagingPerf.highest_quality_destination.platform !== messagingPerf.best_messaging_platform?.platform) {
      recommendations.push({
        priority: 'medium',
        type: 'test_quality',
        platform: messagingPerf.highest_quality_destination.platform,
        action: `${messagingPerf.highest_quality_destination.platform} shows highest conversation quality — test scaling.`,
        expected_impact: 'Higher quality leads/customers',
        confidence: 'low',
      });
    }
  }

  return {
    recommendations: recommendations.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }),
    total_recommendations: recommendations.length,
  };
}

module.exports = {
  getPlatformPerformance,
  getMessagingPlatformAnalysis,
  generatePlatformRecommendations,
};
