/**
 * Metric Resolver
 *
 * Given a resolved KPI profile (from kpiProfileResolver.resolveProfile())
 * and a raw normalized metrics object (from metricsFetcher.normalizeRow()),
 * decides -- in exactly one place -- which metrics are relevant to the
 * entity's objective, whether each is actually present in the real Meta
 * data, and what human-readable label it should carry.
 *
 * This is what eliminates the "0 vs No Data vs Not available for this
 * objective" ambiguity: a metric that isn't part of an objective's profile
 * at all (e.g. ROAS on a Traffic campaign) is `applicable: false`; a metric
 * that IS part of the profile but Meta genuinely didn't return data for
 * (e.g. a brand-new campaign with zero spend yet) is `applicable: true,
 * available: false`. Callers render "Not available for this objective"
 * only for the former, never for the latter -- and never fabricate a 0.
 *
 * Also absorbs objectiveKPIMap.js's formatMetricValue()/METRIC_LABELS and
 * scoreBreakdownService.js's separate duplicate METRIC_LABELS -- both
 * become callers of this module's label/applicability output rather than
 * maintaining independent copies (see kpiProfileResolver.js's header for
 * the same "single source of truth" rationale).
 *
 * No DB reads, no side effects.
 */

// ─────────────────────────────────────────────
// Canonical human-readable labels for every metric key this app knows
// about. Single source of truth -- replaces the two independent
// METRIC_LABELS maps previously in objectiveKPIMap.js and
// scoreBreakdownService.js (which had drifted to different wording for
// the same keys).
// ─────────────────────────────────────────────
const METRIC_LABELS = {
  results:                     'Conversations',
  cpr:                         'Cost Per Conversation',
  leads:                       'Leads',
  cpl:                         'Cost Per Lead',
  roas:                        'ROAS',
  purchases:                   'Purchases',
  purchase_value:              'Purchase Value',
  cpa:                         'Cost Per Purchase',
  landing_page_views:          'Landing Page Views',
  cost_per_landing_page_view:  'Cost Per LPV',
  link_clicks:                 'Link Clicks',
  ctr:                         'CTR',
  cpm:                         'CPM',
  cpc:                         'CPC',
  frequency:                   'Frequency',
  reach:                       'Reach',
  impressions:                 'Impressions',
  spend:                       'Spend',
  clicks:                      'Clicks',
  landing_page_view_rate:      'LPV Rate',
  app_installs:                'App Installs',
  cpi:                         'Cost Per Install',
  video_plays:                 '3-Second Video Plays',
  thruplays:                   'ThruPlays',
  cost_per_thruplay:           'Cost Per ThruPlay',
  video_p25_watched:           '25% Video Watched',
  video_p50_watched:           '50% Video Watched',
  video_p75_watched:           '75% Video Watched',
  video_p95_watched:           '95% Video Watched',
  video_p100_watched:          '100% Video Watched',
  video_avg_watch_time:        'Avg. Watch Time',
  video_retention_rate:        'Video Retention',
  post_engagements:            'Post Engagements',
  page_engagements:            'Page Engagements',
  cost_per_engagement:         'Cost Per Engagement',
};

function formatMetricLabel(metricKey) {
  return METRIC_LABELS[metricKey] || metricKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Resolve every display metric a profile defines against a raw metrics
 * object, returning applicability/availability/value for each.
 *
 * @param {object} profile - a resolved profile from kpiProfileResolver.resolveProfile()
 * @param {object|null} rawMetrics - normalized metrics (metricsFetcher.normalizeRow() output), or null/undefined if none were fetched
 * @returns {Array<{key, label, value, applicable, available, reason}>}
 */
function resolveMetrics(profile, rawMetrics) {
  const displayMetrics = profile?.displayMetrics || [];
  return displayMetrics.map((metricKey) => {
    const value = rawMetrics ? rawMetrics[metricKey] : undefined;
    const available = value !== null && value !== undefined && !Number.isNaN(parseFloat(value));
    return {
      key: metricKey,
      label: formatMetricLabel(metricKey),
      value: available ? value : null,
      applicable: true, // this metric IS part of the resolved objective's profile
      available,
      reason: available ? null : 'no_data_returned',
    };
  });
}

/**
 * Whether a given metric key is part of the resolved profile's display set
 * at all -- distinct from `available` (whether Meta actually returned
 * data). Used by callers checking a specific ad hoc metric key (e.g. a
 * frontend card asking "should I even show a ROAS card for this entity")
 * without needing the full resolveMetrics() list.
 */
function isApplicable(profile, metricKey) {
  return (profile?.displayMetrics || []).includes(metricKey);
}

/**
 * Resolve a single metric by key against a profile + raw metrics object,
 * returning the same shape resolveMetrics() would for that key -- but also
 * correctly returning `applicable: false` for a metric that isn't part of
 * the profile at all (resolveMetrics() only ever iterates applicable keys,
 * so it can't express this case; this function is for exactly that check).
 */
function resolveMetric(profile, metricKey, rawMetrics) {
  if (!isApplicable(profile, metricKey)) {
    return {
      key: metricKey,
      label: formatMetricLabel(metricKey),
      value: null,
      applicable: false,
      available: false,
      reason: 'not_applicable_to_objective',
    };
  }
  const [resolved] = resolveMetrics(profile, rawMetrics).filter(m => m.key === metricKey);
  return resolved;
}

module.exports = { resolveMetrics, resolveMetric, isApplicable, formatMetricLabel, METRIC_LABELS };
