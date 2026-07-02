/**
 * KPI Profile Resolver
 *
 * Single source of truth for "what does objective X (optionally + an ad
 * set's optimization_goal Y) need" -- primary/secondary KPIs, display
 * metrics, health-score weights/thresholds, and benchmark metric lists.
 *
 * This consolidates content that was previously hand-duplicated across
 * three independent places (and already documented in-code as needing to
 * be "kept in sync," which is exactly how they'd already drifted):
 *   - src/services/objectiveKPIMap.js's KPI_MAP (display/trend/scoring
 *     metrics, aggregation rules, primary KPI)
 *   - src/services/benchmarkEngine.js's metricsByObjective (which metrics
 *     get benchmark-evaluated)
 *   - src/db/seedIntelligence.js's SCORING_CONFIGS (health-score weights
 *     and thresholds seeded into objective_scoring_configs)
 *
 * Those three files are refactored (in a later commit of this same
 * rollout) to source their content from PROFILES here instead of
 * maintaining independent copies -- this file does not remove them, it
 * becomes what they import from.
 *
 * No DB reads, no side effects -- pure config + a resolution function,
 * mirroring objectiveKPIMap.js's original "presentation layer only"
 * design intent.
 */

const VALID_OBJECTIVES = ['awareness', 'traffic', 'engagement', 'leads', 'app_promotion', 'sales'];

// Shared fallback thresholds for opportunityEngine.js's four opportunity
// types (Ready To Scale / Audience Expansion / Creative Testing / Budget
// Reallocation) -- these were previously hardcoded literals inside
// opportunityEngine.js itself with no objective awareness at all. A profile
// may override any of these via its own `opportunityThresholds` (merged on
// top of this default); none do yet -- there's no real per-objective data
// in this account to justify divergent thresholds (see Decisions Made in
// the plan: ship the override mechanism, not invented content), so every
// objective currently gets the exact literals opportunityEngine.js already
// used, unchanged.
const DEFAULT_OPPORTUNITY_THRESHOLDS = {
  readyToScaleHealthMin:          70,
  readyToScaleFrequencyMax:       3.5,
  audienceExpansionHealthMin:     65,
  audienceExpansionFrequencyMin:  3.5,
  audienceExpansionFrequencyMax:  6.0,
  creativeTestingHealthMin:       40,
  budgetReallocationHealthMin:    75,
};

// ─────────────────────────────────────────────
// Per-objective profiles
// ─────────────────────────────────────────────
const PROFILES = {
  awareness: {
    primaryKPI:     { key: 'reach', label: 'Reach' },
    primaryCostKPI: { key: 'cpm',   label: 'CPM' },
    priorityWeight: 1.0,
    displayMetrics: ['reach', 'impressions', 'cpm', 'frequency', 'ctr', 'spend'],
    trendMetrics:   ['reach', 'cpm', 'frequency'],
    scoringMetrics: ['reach', 'cpm', 'frequency', 'impressions'],
    benchmarkMetrics: ['reach', 'cpm', 'frequency', 'impressions'],
    aggregation: {
      reach:       'sum',
      impressions: 'sum',
      cpm:         'spend/impressions*1000',
      frequency:   'spend_weighted_avg',
      ctr:         'spend_weighted_avg',
      spend:       'sum',
    },
    scoringWeights: [
      { metric_key: 'reach',       weight: 0.40, direction: 'higher_is_better', excellent: 50000, good: 10000, warning: 2000, critical: 300 },
      { metric_key: 'cpm',         weight: 0.30, direction: 'lower_is_better',  excellent: 3,      good: 8,     warning: 20,   critical: 50 },
      { metric_key: 'frequency',   weight: 0.20, direction: 'optimal_range',   opt_low: 1.5, opt_high: 4.0 },
      { metric_key: 'impressions', weight: 0.10, direction: 'higher_is_better', excellent: 100000, good: 20000, warning: 3000, critical: 500 },
    ],
    // Video Views sub-profile: selected when an ad set's optimization_goal
    // indicates it's actually optimizing for video views, within an
    // Awareness campaign. Meta doesn't expose this as its own campaign
    // objective -- only via optimization_goal, hence the sub-profile
    // mechanism rather than a 7th top-level objective (per the approved
    // plan). Display metrics here depend on video field/action parsing
    // added in a later commit of this rollout (metricsFetcher.js); until
    // that lands, the Metric Resolver correctly reports these as
    // "applicable but no data yet" rather than fabricating values.
    videoViews: {
      optimizationGoals: ['THRUPLAY', 'VIDEO_VIEWS', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'],
      primaryKPI:     { key: 'thruplays', label: 'ThruPlays' },
      primaryCostKPI: { key: 'cost_per_thruplay', label: 'Cost per ThruPlay' },
      displayMetrics: [
        'video_plays', 'thruplays',
        'video_p25_watched', 'video_p50_watched', 'video_p75_watched', 'video_p95_watched', 'video_p100_watched',
        'video_avg_watch_time', 'cost_per_thruplay', 'video_retention_rate',
        'reach', 'frequency', 'ctr',
      ],
      trendMetrics: ['thruplays', 'cost_per_thruplay', 'video_retention_rate'],
      scoringMetrics: ['cost_per_thruplay', 'video_retention_rate', 'ctr', 'frequency'],
      benchmarkMetrics: ['cost_per_thruplay', 'video_retention_rate', 'ctr', 'frequency'],
    },
  },

  traffic: {
    primaryKPI:     { key: 'landing_page_views', label: 'Landing Page Views' },
    primaryCostKPI: { key: 'cost_per_landing_page_view', label: 'Cost Per LPV' },
    priorityWeight: 1.0,
    displayMetrics: ['landing_page_views', 'cost_per_landing_page_view', 'link_clicks', 'ctr', 'cpc', 'cpm', 'frequency', 'spend'],
    trendMetrics:   ['landing_page_views', 'cost_per_landing_page_view', 'ctr'],
    scoringMetrics: ['cpc', 'ctr', 'landing_page_views', 'frequency'],
    benchmarkMetrics: ['cpc', 'ctr', 'landing_page_views', 'frequency'],
    aggregation: {
      landing_page_views:         'sum',
      cost_per_landing_page_view: 'spend/landing_page_views',
      link_clicks:                'sum',
      ctr:                        'spend_weighted_avg',
      cpc:                        'spend_weighted_avg',
      cpm:                        'spend_weighted_avg',
      frequency:                  'spend_weighted_avg',
      spend:                      'sum',
    },
    scoringWeights: [
      { metric_key: 'cpc',                weight: 0.30, direction: 'lower_is_better',  excellent: 0.5,  good: 1.5,  warning: 3,  critical: 6 },
      { metric_key: 'ctr',                weight: 0.30, direction: 'higher_is_better', excellent: 3,    good: 2,    warning: 1,  critical: 0.5 },
      { metric_key: 'landing_page_views', weight: 0.25, direction: 'higher_is_better', excellent: 1000, good: 300,  warning: 50, critical: 5 },
      { metric_key: 'frequency',          weight: 0.15, direction: 'optimal_range',    opt_low: 1.5, opt_high: 3.5 },
    ],
  },

  // Renamed from the old 'messaging' bucket -- Meta's OUTCOME_ENGAGEMENT
  // objective covers Messages/Video Views/Post Engagement/Conversions as
  // sub-optimization-goals; the campaign-level default here preserves
  // today's exact "Conversations" behavior (see Decisions Made in the plan
  // -- finer-grained differentiation within engagement follows the same
  // optimization_goal sub-profile mechanism as Video Views, as a follow-on).
  engagement: {
    primaryKPI:     { key: 'results', label: 'Conversations' },
    primaryCostKPI: { key: 'cpr',     label: 'Cost Per Conversation' },
    priorityWeight: 1.0,
    displayMetrics: ['results', 'cpr', 'ctr', 'cpm', 'frequency', 'reach', 'spend', 'impressions', 'clicks'],
    trendMetrics:   ['results', 'cpr', 'ctr'],
    scoringMetrics: ['cpr', 'ctr', 'frequency', 'reach'],
    benchmarkMetrics: ['cpr', 'ctr', 'frequency', 'reach'],
    aggregation: {
      results:     'sum',
      cpr:         'spend/results',
      ctr:         'spend_weighted_avg',
      cpm:         'spend_weighted_avg',
      frequency:   'spend_weighted_avg',
      reach:       'sum',
      spend:       'sum',
      impressions: 'sum',
      clicks:      'sum',
    },
    scoringWeights: [
      { metric_key: 'cpr',       weight: 0.40, direction: 'lower_is_better',  excellent: 5,    good: 15,   warning: 30,  critical: 60 },
      { metric_key: 'ctr',       weight: 0.30, direction: 'higher_is_better', excellent: 3,    good: 2,    warning: 1,   critical: 0.5 },
      { metric_key: 'frequency', weight: 0.20, direction: 'optimal_range',   opt_low: 1.5, opt_high: 3.5 },
      { metric_key: 'reach',     weight: 0.10, direction: 'higher_is_better', excellent: 5000, good: 1000, warning: 300, critical: 50 },
    ],
  },

  leads: {
    primaryKPI:     { key: 'leads', label: 'Leads' },
    primaryCostKPI: { key: 'cpl',   label: 'Cost Per Lead' },
    priorityWeight: 1.0,
    displayMetrics: ['leads', 'cpl', 'ctr', 'cpm', 'frequency', 'reach', 'spend', 'impressions', 'clicks'],
    trendMetrics:   ['leads', 'cpl', 'ctr'],
    scoringMetrics: ['cpl', 'leads', 'ctr', 'frequency'],
    benchmarkMetrics: ['cpl', 'leads', 'ctr', 'frequency'],
    aggregation: {
      leads:       'sum',
      cpl:         'spend/leads',
      ctr:         'spend_weighted_avg',
      cpm:         'spend_weighted_avg',
      frequency:   'spend_weighted_avg',
      reach:       'sum',
      spend:       'sum',
      impressions: 'sum',
      clicks:      'sum',
    },
    scoringWeights: [
      { metric_key: 'cpl',       weight: 0.40, direction: 'lower_is_better',  excellent: 5,  good: 20,  warning: 50, critical: 100 },
      { metric_key: 'leads',     weight: 0.30, direction: 'higher_is_better', excellent: 50, good: 20,  warning: 5,  critical: 1 },
      { metric_key: 'ctr',       weight: 0.20, direction: 'higher_is_better', excellent: 3,  good: 2,   warning: 1,  critical: 0.5 },
      { metric_key: 'frequency', weight: 0.10, direction: 'optimal_range',   opt_low: 1.5, opt_high: 3.5 },
    ],
  },

  // NEW objective -- was previously folded into 'unknown'. Scoring weights
  // are provisional (modeled on 'leads'' shape -- cost metric + volume
  // metric + CTR + frequency) since there's no existing real cpi/
  // app_installs history in this codebase to calibrate against. Explicitly
  // not presented as tuned, real numbers -- see Decisions Made in the plan.
  app_promotion: {
    primaryKPI:     { key: 'app_installs', label: 'App Installs' },
    primaryCostKPI: { key: 'cpi',          label: 'Cost Per Install' },
    priorityWeight: 1.0,
    displayMetrics: ['app_installs', 'cpi', 'ctr', 'cpm', 'frequency', 'reach', 'spend', 'impressions', 'clicks'],
    trendMetrics:   ['app_installs', 'cpi', 'ctr'],
    scoringMetrics: ['cpi', 'app_installs', 'ctr', 'frequency'],
    benchmarkMetrics: ['cpi', 'app_installs', 'ctr', 'frequency'],
    aggregation: {
      app_installs: 'sum',
      cpi:          'spend/app_installs',
      ctr:          'spend_weighted_avg',
      cpm:          'spend_weighted_avg',
      frequency:    'spend_weighted_avg',
      reach:        'sum',
      spend:        'sum',
      impressions:  'sum',
      clicks:       'sum',
    },
    // PROVISIONAL -- not yet tuned against real account data.
    scoringWeights: [
      { metric_key: 'cpi',          weight: 0.40, direction: 'lower_is_better',  excellent: 1,   good: 3,   warning: 6,  critical: 12 },
      { metric_key: 'app_installs', weight: 0.30, direction: 'higher_is_better', excellent: 100, good: 30,  warning: 5,  critical: 0 },
      { metric_key: 'ctr',          weight: 0.20, direction: 'higher_is_better', excellent: 3,   good: 2,   warning: 1,  critical: 0.5 },
      { metric_key: 'frequency',    weight: 0.10, direction: 'optimal_range',   opt_low: 1.5, opt_high: 3.5 },
    ],
  },

  sales: {
    primaryKPI:     { key: 'roas', label: 'ROAS' },
    primaryCostKPI: { key: 'cpa',  label: 'Cost Per Purchase' },
    priorityWeight: 1.0,
    displayMetrics: ['roas', 'purchases', 'purchase_value', 'cpa', 'ctr', 'cpm', 'frequency', 'spend'],
    trendMetrics:   ['roas', 'cpa', 'purchases'],
    scoringMetrics: ['roas', 'cpa', 'purchases', 'ctr'],
    benchmarkMetrics: ['roas', 'cpa', 'purchases', 'ctr'],
    aggregation: {
      roas:           'revenue/spend',
      purchases:      'sum',
      purchase_value: 'sum',
      cpa:            'spend/purchases',
      ctr:            'spend_weighted_avg',
      cpm:            'spend_weighted_avg',
      frequency:      'spend_weighted_avg',
      spend:          'sum',
    },
    scoringWeights: [
      { metric_key: 'roas',      weight: 0.35, direction: 'higher_is_better', excellent: 4,  good: 2,  warning: 1,   critical: 0.5 },
      { metric_key: 'cpa',       weight: 0.35, direction: 'lower_is_better',  excellent: 20, good: 60, warning: 120, critical: 250 },
      { metric_key: 'purchases', weight: 0.20, direction: 'higher_is_better', excellent: 20, good: 5,  warning: 1,   critical: 0 },
      { metric_key: 'ctr',       weight: 0.10, direction: 'higher_is_better', excellent: 3,  good: 2,  warning: 1,   critical: 0.5 },
    ],
  },

  unknown: {
    primaryKPI:     { key: 'spend', label: 'Spend' },
    primaryCostKPI: { key: 'cpm',   label: 'CPM' },
    priorityWeight: 1.0,
    displayMetrics: ['spend', 'ctr', 'cpm', 'frequency', 'reach', 'impressions'],
    trendMetrics:   ['spend', 'ctr', 'cpm'],
    scoringMetrics: ['ctr', 'cpm', 'frequency'],
    benchmarkMetrics: ['ctr', 'cpm', 'frequency'],
    aggregation: {
      spend:       'sum',
      ctr:         'spend_weighted_avg',
      cpm:         'spend_weighted_avg',
      frequency:   'spend_weighted_avg',
      reach:       'sum',
      impressions: 'sum',
    },
    scoringWeights: [], // no seeded weights -- healthScoreEngine's existing
                        // fallback (neutral 50/"No scoring config found")
                        // applies unchanged, matching pre-existing behavior.
  },
};

/**
 * Resolve the effective KPI profile for an entity.
 *
 * @param {string} objective - internal objective enum value
 * @param {string|null} optimizationGoal - an ad set's raw Meta
 *   optimization_goal string, if known (only ad sets carry this; campaigns
 *   and ads resolve without it and get the base objective profile)
 * @returns {object} the resolved profile, merged with its sub-profile
 *   (e.g. Video Views) when applicable. Always returns a usable profile
 *   object, falling back to PROFILES.unknown for any unrecognized objective
 *   -- never throws, matching the existing icKPI()/getKPIMap() fallback
 *   convention this replaces.
 */
function resolveProfile(objective, optimizationGoal = null) {
  const base = PROFILES[objective] || PROFILES.unknown;

  if (objective === 'awareness' && base.videoViews && optimizationGoal) {
    const goal = String(optimizationGoal).toUpperCase().trim();
    if (base.videoViews.optimizationGoals.includes(goal)) {
      const { videoViews, ...baseWithoutSubProfile } = base;
      return { ...baseWithoutSubProfile, ...videoViews, isVideoViewsVariant: true };
    }
  }

  return base;
}

module.exports = { VALID_OBJECTIVES, PROFILES, resolveProfile, DEFAULT_OPPORTUNITY_THRESHOLDS };
