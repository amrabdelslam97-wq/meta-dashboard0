/**
 * Metrics Fetcher — Phase 4 (replaces Phase 2 version)
 *
 * Fetches real Meta Insights API data for campaigns, ad sets, and ads.
 * Supports: current period, prior period, daily trend, all entity levels.
 * Includes: in-memory cache, delta calculation, action parsing.
 *
 * Intelligence engines receive the same normalized object as before —
 * only the data source changed from mock to real.
 */

const { metaGet }      = require('./metaApiClient');
const cache            = require('./cacheService');
const { priorPeriod, defaultRange } = require('./dateRangeHelper');

// ─────────────────────────────────────────────
// Meta Insights fields — comprehensive set
// ─────────────────────────────────────────────
const CORE_FIELDS = [
  'spend', 'impressions', 'reach', 'clicks',
  'ctr', 'cpm', 'cpc', 'frequency',
  'actions', 'cost_per_action_type',
  'purchase_roas', 'website_purchase_roas',
  // unique_clicks/unique_ctr are standard, documented Meta Insights numeric
  // fields (deduplicated-by-person versions of clicks/ctr). outbound_clicks
  // is actions[]-shaped like `actions` itself (one entry per action_type,
  // typically just 'outbound_click') -- added for Creative Intelligence's
  // Outbound CTR / Unique CTR metrics (Executive Marketing Analytics Layer
  // follow-on). Flagged for live verification against a real Insights
  // response the same way action_values was, per this file's house rule.
  'unique_clicks', 'unique_ctr', 'outbound_clicks',
  // action_values is the correct Meta Insights field name for monetary
  // value per action_type (mirrors the actions[] structure). The
  // previously-used 'conversion_values' does not match Meta's documented
  // field taxonomy -- flagged in the Meta API audit for live verification
  // against a real Insights response before fully trusting this value in
  // production, since this environment has no real Meta credentials to
  // confirm it against.
  'action_values',
  // Video watched-actions fields, for the Awareness/Engagement "Video
  // Views" KPI profile (kpiProfileResolver.js). Each returns an array
  // shaped like actions[]/cost_per_action_type[] (one entry per
  // action_type, typically just 'video_view'), NOT a bare number --
  // confirmed against a real Insights response for a real campaign in
  // the connected account (real video_view data, e.g.
  // video_p25_watched_actions returning [{action_type:'video_view',
  // value:'2442'}]) before adding these, per this file's own established
  // house rule of never trusting an unverified field name.
  'video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p95_watched_actions', 'video_p100_watched_actions',
  'video_thruplay_watched_actions', 'video_avg_time_watched_actions',
].join(',');

// Meta does NOT automatically include an entity's identifying id/name
// fields in an Insights response for level=adset/level=ad -- they must be
// requested explicitly like any other field, confirmed against a real
// Insights call (requesting only CORE_FIELDS returns rows with no
// adset_id/ad_id at all). Without these, fetchAdSetMetrics/fetchAdMetrics
// could never attribute a row back to a specific ad set/ad, so every
// entity-level lookup silently found nothing.
const ADSET_FIELDS = CORE_FIELDS + ',adset_id,adset_name';
const AD_FIELDS     = CORE_FIELDS + ',ad_id,ad_name,adset_id';

// ─────────────────────────────────────────────
// Deterministic action_type priority per generic metric bucket.
//
// ROOT CAUSE this fixes: several distinct Meta action_types legitimately
// share one of our generic buckets (e.g. 'onsite_conversion.messaging_
// conversation_started_7d' AND 'onsite_conversion.messaging_first_reply'
// both feed 'results'/'cpr' for a Conversations-optimized campaign). The
// previous code picked whichever one happened to appear FIRST in Meta's
// cost_per_action_type[] response array -- which Meta does not guarantee
// any stable ordering for. Confirmed against a real campaign's real Meta
// Insights response (spend=2773.67, ad set optimization_goal=CONVERSATIONS):
//   onsite_conversion.messaging_conversation_started_7d: value=185, cost=14.992811  (2773.67/185 = 14.9928..., i.e. Meta's own math)
//   onsite_conversion.messaging_first_reply:              value=184, cost=15.074293  (a narrower subset -- not every started conversation gets a first reply)
// Meta's response listed messaging_first_reply BEFORE messaging_conversation_
// started_7d, so the old "first array entry wins" logic silently used
// 15.074293 instead of the correct 14.992811 -- a real, reproducible ~0.5%
// overstatement in this example, and structurally *always* an overstatement
// (never an understatement) whenever it happens, because messaging_first_
// reply's count can never exceed messaging_conversation_started_7d's for the
// same campaign, so its cost-per-result mechanically can't be lower. That
// asymmetry is exactly why the discrepancy was reported as "consistently
// higher", not randomly higher-or-lower.
//
// Fix: pick by OUR fixed, documented priority order below (matching Meta's
// own official "which action_type is the real Result for this optimization
// goal" precedence), not by array position. Each list is ordered
// most-authoritative-first; the first action_type actually present in the
// response wins, regardless of where in the array it sits.
// ─────────────────────────────────────────────
const RESULT_ACTION_PRIORITY = {
  // 'results' (engagement objective's generic bucket, default when no
  // ad set optimization_goal is known -- see RESULT_ACTION_TYPES_BY_GOAL
  // below for the optimization_goal-exact path, which takes precedence).
  results:      ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.messaging_conversation_started', 'onsite_conversion.messaging_first_reply'],
  leads:        ['onsite_conversion.lead_grouped', 'lead', 'leadgen_grouped'],
  purchases:    ['omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'purchase'],
  app_installs: ['omni_app_install', 'mobile_app_install'],
};

// Meta's documented mapping from an ad set's optimization_goal to the
// SPECIFIC action_type it reports as "Results" in Ads Manager for that goal
// -- used when the caller knows the ad set's real optimization_goal (see
// fetchCampaignMetrics()'s optimizationGoal param), so the exact configured
// conversion event is used rather than the objective-level default above.
// Only goals we can back with an action_type already recognized by
// ACTION_MAP/CPA_MAP are listed -- an OFFSITE_CONVERSIONS ad set optimizing
// for a custom (non-purchase) pixel event would need the ad set's
// promoted_object.custom_event_type (not currently fetched) to resolve
// further; not fabricated here.
const RESULT_ACTION_TYPES_BY_GOAL = {
  CONVERSATIONS:      { bucket: 'results',      actionTypes: RESULT_ACTION_PRIORITY.results },
  LEAD_GENERATION:    { bucket: 'leads',         actionTypes: RESULT_ACTION_PRIORITY.leads },
  QUALITY_LEAD:       { bucket: 'leads',         actionTypes: RESULT_ACTION_PRIORITY.leads },
  OFFSITE_CONVERSIONS:{ bucket: 'purchases',     actionTypes: RESULT_ACTION_PRIORITY.purchases },
  VALUE:              { bucket: 'purchases',     actionTypes: RESULT_ACTION_PRIORITY.purchases },
  APP_INSTALLS:       { bucket: 'app_installs',  actionTypes: RESULT_ACTION_PRIORITY.app_installs },
};

/**
 * Pick the value for the first action_type (in priority order) actually
 * present in a Meta actions[]/cost_per_action_type[] array. Returns null
 * (never 0) when none of the priority list's action_types are present, so
 * callers can distinguish "genuinely no data" from "found, value 0".
 */
function pickByPriority(sourceArray, priorityList) {
  if (!Array.isArray(sourceArray)) return null;
  for (const actionType of priorityList) {
    const match = sourceArray.find(a => a.action_type === actionType);
    if (match) return parseFloat(match.value) || 0;
  }
  return null;
}

// ─────────────────────────────────────────────
// Parse Meta actions[] + cost_per_action_type[]
// Maps all known action_types to flat metric keys
//
// @param {string|null} optimizationGoal - the ad set's real Meta
//   optimization_goal (e.g. "CONVERSATIONS"), when known. When provided and
//   recognized, its exact configured conversion event (RESULT_ACTION_TYPES_
//   BY_GOAL) overrides the objective-level default bucket -- e.g. "never use
//   generic results when the optimization event is different."
// ─────────────────────────────────────────────
function parseActions(actions, costPerAction, actionValues, optimizationGoal = null) {
  const result = {};
  if (!Array.isArray(actions)) return result;

  // Action type → flat metric key mappings for the NON-ambiguous buckets
  // only (exactly one Meta action_type per bucket, so no duplicate-
  // counting/priority resolution is needed). results/leads/purchases/
  // app_installs are NOT listed here -- multiple action_types can each
  // legitimately represent them (see RESULT_ACTION_PRIORITY above), so
  // they're resolved deterministically below instead of by simple lookup.
  const ACTION_MAP = {
    // Traffic
    'link_click':       'link_clicks',
    'landing_page_view':'landing_page_views',
    // Engagement -- 'post_engagement'/'page_engagement'/'like' confirmed
    // present with real values against a real campaign in the connected
    // account (e.g. post_engagement=62239) before adding.
    'post_engagement':  'post_engagements',
    'page_engagement':  'page_engagements',
    'like':             'page_likes',
    // Individual reaction breakdown (Creative Intelligence Engine) --
    // Meta's documented standard action_types for post-level engagement.
    // 'comment' and 'post' (share) are well-established Marketing API
    // action_types; 'onsite_conversion.post_save' is Meta's documented save
    // action. Flagged for live verification against a real Insights
    // response the same way action_values was, per this file's house rule.
    'comment':                      'comments',
    'post':                         'shares',
    'onsite_conversion.post_save':  'saves',
  };

  for (const { action_type, value } of actions) {
    const key = ACTION_MAP[action_type];
    if (key) {
      result[key] = parseFloat(value) || 0;
    }
  }

  // Ambiguous buckets (results/leads/purchases/app_installs): several
  // distinct Meta action_types can each legitimately represent "the"
  // result count for these, and Meta does not report them as additive --
  // they're alternative attributions/countings of the same underlying
  // conversions. Resolve deterministically: prefer the ad set's actual
  // optimization_goal's exact configured action_type when known, otherwise
  // fall back to RESULT_ACTION_PRIORITY's documented order -- never by
  // Meta's arbitrary response array position (see this section's header
  // comment for the real-data proof of why that was wrong).
  const goalOverride = optimizationGoal
    ? RESULT_ACTION_TYPES_BY_GOAL[String(optimizationGoal).toUpperCase().trim()]
    : null;

  const bucketsToResolve = goalOverride
    ? [goalOverride]
    : Object.entries(RESULT_ACTION_PRIORITY).map(([bucket, actionTypes]) => ({ bucket, actionTypes }));

  for (const { bucket, actionTypes } of bucketsToResolve) {
    const value = pickByPriority(actions, actionTypes);
    if (value !== null) result[bucket] = value;
  }
  // When an optimization_goal override applies, the OTHER ambiguous buckets
  // (not the goal's own bucket) still fall back to their default priority
  // list -- e.g. a Conversations-optimized campaign may still have
  // incidental leads/purchases worth showing elsewhere on the dashboard,
  // even though `results`/`cpr` (not `leads`/`cpl` or `purchases`/`cpa`) is
  // its actual primary KPI. Conversely, when a campaign's real
  // optimization_goal has NO matching entry in RESULT_ACTION_TYPES_BY_GOAL
  // at all (goalOverride is null), every bucket already got resolved by the
  // `bucketsToResolve` loop above using its own default priority list --
  // this second loop only fires when goalOverride IS set, filling in the
  // buckets that loop skipped.
  if (goalOverride) {
    for (const bucket of Object.keys(RESULT_ACTION_PRIORITY)) {
      if (bucket !== goalOverride.bucket && result[bucket] === undefined) {
        const fallbackValue = pickByPriority(actions, RESULT_ACTION_PRIORITY[bucket]);
        if (fallbackValue !== null) result[bucket] = fallbackValue;
      }
    }
  }

  // Cost per action type → cost metrics.
  // Non-ambiguous costs (exactly one action_type per bucket).
  if (Array.isArray(costPerAction)) {
    const CPA_MAP = {
      'landing_page_view': 'cost_per_landing_page_view',
      // Confirmed present with a real value (e.g. post_engagement
      // cost=0.410191) against a real campaign in the connected account.
      'post_engagement':   'cost_per_engagement',
    };
    for (const { action_type, value } of costPerAction) {
      const key = CPA_MAP[action_type];
      if (key && !result[key]) {
        result[key] = parseFloat(value) || 0;
      }
    }

    // Ambiguous cost buckets: same priority-ordered resolution as the
    // values above, and using the SAME resolved action_type per bucket
    // (so e.g. cpr's cost always corresponds to the exact action_type
    // `results`'s value came from -- they can never silently disagree).
    const COST_BUCKET_KEY = { results: 'cpr', leads: 'cpl', purchases: 'cpa', app_installs: 'cpi' };
    const costBucketsToResolve = goalOverride
      ? [{ bucket: goalOverride.bucket, actionTypes: goalOverride.actionTypes }]
      : Object.entries(RESULT_ACTION_PRIORITY).map(([bucket, actionTypes]) => ({ bucket, actionTypes }));

    for (const { bucket, actionTypes } of costBucketsToResolve) {
      const cost = pickByPriority(costPerAction, actionTypes);
      if (cost !== null) result[COST_BUCKET_KEY[bucket]] = cost;
    }
    if (goalOverride) {
      for (const bucket of Object.keys(RESULT_ACTION_PRIORITY)) {
        const costKey = COST_BUCKET_KEY[bucket];
        if (bucket !== goalOverride.bucket && result[costKey] === undefined) {
          const fallbackCost = pickByPriority(costPerAction, RESULT_ACTION_PRIORITY[bucket]);
          if (fallbackCost !== null) result[costKey] = fallbackCost;
        }
      }
    }

    // 'mobile_app_install'/'omni_app_install' costs are already covered by
    // the app_installs priority resolution above (RESULT_ACTION_PRIORITY.
    // app_installs); no separate CPA_MAP entry needed -- kept unverified-
    // status note from the original mapping: Meta's documented standard
    // action_types for app installs, not yet checked against a real
    // App Promotion campaign (none exist in the connected accounts).
  }

  // Purchase value from action_values
  if (Array.isArray(actionValues)) {
    for (const { action_type, value } of actionValues) {
      if (['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'].includes(action_type)) {
        result.purchase_value = (result.purchase_value || 0) + (parseFloat(value) || 0);
      }
    }
  }

  return result;
}

// ─────────────────────────────────────────────
// Pick a ROAS value from Meta's purchase_roas/website_purchase_roas array.
// These are arrays of { action_type, value } and Meta does not guarantee
// ordering, so blindly taking index [0] can return whichever action_type
// happens to sort first rather than the one that actually matters. Prefer
// 'omni_purchase' (Meta's channel-agnostic, recommended metric since the
// iOS14/AEM changes), then the legacy pixel-based purchase action, falling
// back to the first entry only if neither known type is present.
// ─────────────────────────────────────────────
const PREFERRED_ROAS_ACTION_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];

function pickRoasValue(roasArray) {
  if (!Array.isArray(roasArray) || roasArray.length === 0) return null;

  for (const actionType of PREFERRED_ROAS_ACTION_TYPES) {
    const match = roasArray.find(r => r.action_type === actionType);
    if (match) return parseFloat(match.value) || null;
  }

  return parseFloat(roasArray[0].value) || null;
}

// ─────────────────────────────────────────────
// Parse the video watched-actions fields for the Video Views KPI profile.
// Each field is an array shaped like actions[] (typically a single
// {action_type:'video_view', value} entry) rather than a bare number --
// confirmed against a real Insights response before relying on this shape.
// ─────────────────────────────────────────────
function parseVideoMetrics(d) {
  const pick = (field) => {
    const arr = d[field];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const value = parseFloat(arr[0].value);
    return Number.isNaN(value) ? null : value;
  };

  return {
    video_plays:          pick('video_play_actions'),
    video_p25_watched:    pick('video_p25_watched_actions'),
    video_p50_watched:    pick('video_p50_watched_actions'),
    video_p75_watched:    pick('video_p75_watched_actions'),
    video_p95_watched:    pick('video_p95_watched_actions'),
    video_p100_watched:   pick('video_p100_watched_actions'),
    thruplays:            pick('video_thruplay_watched_actions'),
    video_avg_watch_time: pick('video_avg_time_watched_actions'),
  };
}

// ─────────────────────────────────────────────
// Normalize a single Meta insights data row
//
// @param {string|null} optimizationGoal - see parseActions()'s param doc.
// ─────────────────────────────────────────────
function normalizeRow(d, optimizationGoal = null) {
  if (!d) return null;

  const base = {
    spend:       parseFloat(d.spend       || 0),
    impressions: parseFloat(d.impressions || 0),
    reach:       parseFloat(d.reach       || 0),
    clicks:      parseFloat(d.clicks      || 0),
    ctr:         parseFloat(d.ctr         || 0),
    cpm:         parseFloat(d.cpm         || 0),
    cpc:         parseFloat(d.cpc         || 0),
    frequency:   parseFloat(d.frequency   || 0),
    unique_clicks: parseFloat(d.unique_clicks || 0),
    unique_ctr:    parseFloat(d.unique_ctr    || 0),
    date_start:  d.date_start || null,
    date_stop:   d.date_stop  || null,
  };

  // outbound_clicks is actions[]-shaped (one entry per action_type,
  // typically just 'outbound_click') -- same extraction pattern as
  // parseVideoMetrics() below, not a bare number.
  if (Array.isArray(d.outbound_clicks) && d.outbound_clicks.length > 0) {
    const outboundEntry = d.outbound_clicks.find(a => a.action_type === 'outbound_click') || d.outbound_clicks[0];
    const outboundValue = parseFloat(outboundEntry.value);
    if (!Number.isNaN(outboundValue)) base.outbound_clicks = outboundValue;
  }

  // ROAS from Meta's purchase_roas array
  const roasSource = d.purchase_roas || d.website_purchase_roas;
  const pickedRoas = pickRoasValue(roasSource);
  if (pickedRoas !== null) base.roas = pickedRoas;

  // Actions → objective-specific metrics
  const actionMetrics = parseActions(d.actions, d.cost_per_action_type, d.action_values, optimizationGoal);
  Object.assign(base, actionMetrics);

  // Derive missing cost metrics from volume + spend
  if (!base.cpr && base.results   > 0 && base.spend > 0) base.cpr = base.spend / base.results;
  if (!base.cpl && base.leads     > 0 && base.spend > 0) base.cpl = base.spend / base.leads;
  if (!base.cpa && base.purchases > 0 && base.spend > 0) base.cpa = base.spend / base.purchases;

  // Derive ROAS from purchase_value / spend when Meta doesn't provide it
  if (!base.roas && base.purchase_value > 0 && base.spend > 0) {
    base.roas = base.purchase_value / base.spend;
  }

  // Landing page view rate (%)
  if (base.landing_page_views > 0 && base.clicks > 0) {
    base.landing_page_view_rate = (base.landing_page_views / base.clicks) * 100;
  }

  // Outbound CTR (%) -- Meta reports outbound_clicks as a count, not a rate;
  // derived the same way ctr itself is (clicks/impressions), consistent
  // with this file's existing "derive when Meta doesn't supply it directly" pattern.
  if (base.outbound_clicks > 0 && base.impressions > 0) {
    base.outbound_ctr = (base.outbound_clicks / base.impressions) * 100;
  }

  // Video watched-actions (Video Views KPI sub-profile). Only merge keys
  // Meta actually returned data for -- matching the rest of this
  // function's convention (e.g. results/leads/purchases are left
  // genuinely absent, not null, when their action_type never appears) so
  // "no data returned" reads the same way (`undefined`) everywhere a
  // caller checks for it.
  const videoMetrics = parseVideoMetrics(d);
  for (const [key, value] of Object.entries(videoMetrics)) {
    if (value !== null) base[key] = value;
  }

  // Derived cost/rate metrics, following the same pattern as cpr/cpl/cpa
  // above -- only computed when the underlying volume + spend are real.
  if (base.thruplays > 0 && base.spend > 0) {
    base.cost_per_thruplay = base.spend / base.thruplays;
  }
  if (base.video_plays > 0 && base.video_p100_watched > 0) {
    base.video_retention_rate = (base.video_p100_watched / base.video_plays) * 100;
  }

  // Cost per engagement / cost per install, when Meta doesn't supply them
  // directly via CPA_MAP (mirrors the cpr/cpl/cpa fallback above).
  if (!base.cost_per_engagement && (base.post_engagements > 0 || base.page_engagements > 0) && base.spend > 0) {
    base.cost_per_engagement = base.spend / (base.post_engagements || base.page_engagements);
  }
  if (!base.cpi && base.app_installs > 0 && base.spend > 0) {
    base.cpi = base.spend / base.app_installs;
  }

  return base;
}

// ─────────────────────────────────────────────
// Normalize full Meta insights API response
// Returns single aggregated metrics object
// ─────────────────────────────────────────────
function normalizeInsights(raw, optimizationGoal = null) {
  if (!raw?.data?.length) return null;
  return normalizeRow(raw.data[0], optimizationGoal);
}

// ─────────────────────────────────────────────
// Normalize daily trend response
// Returns array of { date, ...metrics }
// ─────────────────────────────────────────────
function normalizeTrend(raw) {
  if (!raw?.data?.length) return [];
  return raw.data.map(d => normalizeRow(d)).filter(Boolean);
}

// ─────────────────────────────────────────────
// Calculate deltas between current and prior period
// ─────────────────────────────────────────────
const NUMERIC_METRICS = [
  'spend','impressions','reach','clicks','ctr','cpm','cpc','frequency',
  'results','leads','purchases','purchase_value','roas',
  'cpr','cpl','cpa','link_clicks','landing_page_views',
  'cost_per_landing_page_view',
  'post_engagements','page_engagements','cost_per_engagement',
  'app_installs','cpi',
  'video_plays','video_p25_watched','video_p50_watched','video_p75_watched',
  'video_p95_watched','video_p100_watched','thruplays','video_avg_watch_time',
  'cost_per_thruplay','video_retention_rate',
  'unique_clicks','unique_ctr','outbound_clicks','outbound_ctr',
  'comments','shares','saves','page_likes',
];

function computeDeltas(current, prior) {
  if (!current || !prior) return {};
  const deltas = {};

  for (const key of NUMERIC_METRICS) {
    const cur = current[key];
    const prr = prior[key];
    if (cur == null || prr == null) continue;

    const delta_abs = Math.round((cur - prr) * 100) / 100;
    const delta_pct = prr !== 0
      ? Math.round(((cur - prr) / Math.abs(prr)) * 1000) / 10   // 1 decimal
      : (cur > 0 ? 100 : 0);

    deltas[key] = { delta_abs, delta_pct };
  }
  return deltas;
}

// ─────────────────────────────────────────────
// Build the action_attribution_windows param from the account's configured
// attribution_window_days. Previously this value was stored, editable via
// the API, and displayed in the UI, but never actually sent to Meta --
// every Insights call used whichever attribution setting Meta defaults to
// for the ad account, regardless of what was configured here. Matches the
// same JSON-array-as-string convention Meta's API already uses for
// time_range in this file.
// ─────────────────────────────────────────────
function attributionWindowParams(attributionWindowDays) {
  if (!attributionWindowDays) return {};
  return { action_attribution_windows: JSON.stringify([`${attributionWindowDays}d_click`]) };
}

// ─────────────────────────────────────────────
// Core fetch helper: one Meta Insights API call
// ─────────────────────────────────────────────
async function fetchInsights(entityId, accessToken, since, until, extraParams = {}) {
  return metaGet(
    `${entityId}/insights`,
    {
      fields:     CORE_FIELDS,
      time_range: JSON.stringify({ since, until }),
      ...extraParams,
    },
    accessToken
  );
}

// ─────────────────────────────────────────────
// CAMPAIGN METRICS
//
// @param {string|null} optimizationGoal - the campaign's ad set's real Meta
//   optimization_goal (e.g. "CONVERSATIONS"), when the caller can resolve
//   one -- see parseActions()'s param doc. Passed through to both the
//   current and prior period so a delta is always comparing the same
//   resolved action_type on both sides.
// ─────────────────────────────────────────────
async function fetchCampaignMetrics(metaCampaignId, accessToken, dateRange, attributionWindowDays, optimizationGoal = null) {
  const range = dateRange || defaultRange();
  const { since, until } = range;
  const prior  = priorPeriod(since, until);
  const fetchedAt = new Date().toISOString();

  // ── Current period ──
  // A real Meta API failure here (bad token, invalid API version, rate
  // limit, etc.) is intentionally NOT caught -- it must propagate to the
  // caller (insights.js already has a try/catch that returns the real
  // "Meta API error: <message>" reason with HTTP 502). Swallowing it here
  // used to collapse every failure mode into the same generic "No Meta
  // insights available for the selected period" message that's meant for
  // the genuinely-different case of Meta returning 200 with zero rows --
  // which normalizeInsights() already turns into `null` on its own,
  // without needing a catch block, so nothing is lost by removing this one.
  const currentKey = cache.keyInsights(metaCampaignId, since, until);
  let currentMetrics = cache.get(currentKey);

  if (!currentMetrics) {
    const raw = await fetchInsights(metaCampaignId, accessToken, since, until, attributionWindowParams(attributionWindowDays));
    currentMetrics = normalizeInsights(raw, optimizationGoal);
    if (currentMetrics) cache.set(currentKey, currentMetrics, 'current');
  }

  // ── Prior period ──
  const priorKey = cache.keyPrior(metaCampaignId, prior.since, prior.until);
  let priorMetrics = cache.get(priorKey);

  if (!priorMetrics) {
    try {
      const raw = await fetchInsights(metaCampaignId, accessToken, prior.since, prior.until, attributionWindowParams(attributionWindowDays));
      priorMetrics = normalizeInsights(raw, optimizationGoal);
      if (priorMetrics) cache.set(priorKey, priorMetrics, 'prior'); // 24h TTL
    } catch (err) {
      console.warn(`[Metrics] Prior period fetch failed for ${metaCampaignId}:`, err.message);
      priorMetrics = null;
    }
  }

  const deltas = computeDeltas(currentMetrics, priorMetrics);

  return {
    current:     currentMetrics,
    prior:       priorMetrics,
    deltas,
    date_range:  range,
    prior_range: { since: prior.since, until: prior.until },
    fetched_at:  fetchedAt,
    source:      'meta_api',
  };
}

// ─────────────────────────────────────────────
// AD SET METRICS (for campaign detail breakdown)
// ─────────────────────────────────────────────
async function fetchAdSetMetrics(metaCampaignId, accessToken, since, until, attributionWindowDays) {
  const key = `${metaCampaignId}:adsets:${since}:${until}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // AUDIT LOG — full outgoing request details
  console.log('[MetricsFetcher][AdSet] ── Outgoing Meta Request ──');
  console.log('[MetricsFetcher][AdSet] Campaign ID:', metaCampaignId);
  console.log('[MetricsFetcher][AdSet] Level: adset');
  console.log('[MetricsFetcher][AdSet] Date range:', since, '->', until);
  console.log('[MetricsFetcher][AdSet] Token length:', accessToken?.length ?? 0);
  console.log('[MetricsFetcher][AdSet] Fields:', ADSET_FIELDS);

  let raw;
  try {
    raw = await metaGet(
      `${metaCampaignId}/insights`,
      {
        fields:     ADSET_FIELDS,
        time_range: JSON.stringify({ since, until }),
        level:      'adset',
        ...attributionWindowParams(attributionWindowDays),
      },
      accessToken
    );
  } catch (err) {
    // Log the full error, then RE-THROW it -- adSetIntelligence.js's
    // runAdSetIntelligence() already has a try/catch around this call
    // specifically built to surface the real Meta error message
    // ("Meta API error: <message>"), but that code path only fires if
    // this function actually throws. Swallowing to `[]` here defeated
    // that already-correct caller and made every real API failure look
    // identical to "no ad sets have data for this period."
    console.error('[MetricsFetcher][AdSet] ── Meta API ERROR ──');
    console.error('[MetricsFetcher][AdSet] Message:', err.message);
    console.error('[MetricsFetcher][AdSet] Code:', err.code);
    console.error('[MetricsFetcher][AdSet] Type:', err.type);
    console.error('[MetricsFetcher][AdSet] HTTP Status:', err.httpStatus);
    throw err;
  }

  // Log the raw response before any parsing
  console.log('[MetricsFetcher][AdSet] ── Raw Meta Response ──');
  console.log('[MetricsFetcher][AdSet] data.length:', raw?.data?.length ?? 0);
  if (!raw?.data?.length) {
    console.warn('[MetricsFetcher][AdSet] data[] IS EMPTY — Meta returned no rows for this campaign/period');
    console.log('[MetricsFetcher][AdSet] Full raw response:', JSON.stringify(raw));
  }

  const adsets = (raw?.data || []).map(d => {
    // Mapping audit: log adset_id field presence
    if (!d.adset_id) {
      console.warn('[MetricsFetcher][AdSet] WARNING: row missing adset_id:', JSON.stringify(d));
    }
    return {
      meta_adset_id: d.adset_id,
      name:          d.adset_name,
      ...normalizeRow(d),
    };
  });

  console.log('[MetricsFetcher][AdSet] Parsed', adsets.length, 'ad set rows');
  cache.set(key, adsets, 'current');
  return adsets;
}

// ─────────────────────────────────────────────
// AD METRICS
// ─────────────────────────────────────────────
async function fetchAdMetrics(metaCampaignId, accessToken, since, until, attributionWindowDays) {
  const key = `${metaCampaignId}:ads:${since}:${until}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // AUDIT LOG — full outgoing request details
  console.log('[MetricsFetcher][Ad] ── Outgoing Meta Request ──');
  console.log('[MetricsFetcher][Ad] Campaign ID:', metaCampaignId);
  console.log('[MetricsFetcher][Ad] Level: ad');
  console.log('[MetricsFetcher][Ad] Date range:', since, '->', until);
  console.log('[MetricsFetcher][Ad] Token length:', accessToken?.length ?? 0);
  console.log('[MetricsFetcher][Ad] Fields:', AD_FIELDS);

  let raw;
  try {
    raw = await metaGet(
      `${metaCampaignId}/insights`,
      {
        fields:     AD_FIELDS,
        time_range: JSON.stringify({ since, until }),
        level:      'ad',
        ...attributionWindowParams(attributionWindowDays),
      },
      accessToken
    );
  } catch (err) {
    // Log the full error, then RE-THROW it -- adIntelligence.js's
    // runAdIntelligence() already has a try/catch around this call
    // specifically built to surface the real Meta error message, but
    // that only fires if this function actually throws. Swallowing to
    // `[]` here defeated that already-correct caller.
    console.error('[MetricsFetcher][Ad] ── Meta API ERROR ──');
    console.error('[MetricsFetcher][Ad] Message:', err.message);
    console.error('[MetricsFetcher][Ad] Code:', err.code);
    console.error('[MetricsFetcher][Ad] Type:', err.type);
    console.error('[MetricsFetcher][Ad] HTTP Status:', err.httpStatus);
    throw err;
  }

  // Log the raw response before any parsing
  console.log('[MetricsFetcher][Ad] ── Raw Meta Response ──');
  console.log('[MetricsFetcher][Ad] data.length:', raw?.data?.length ?? 0);
  if (!raw?.data?.length) {
    console.warn('[MetricsFetcher][Ad] data[] IS EMPTY — Meta returned no rows for this campaign/period');
    console.log('[MetricsFetcher][Ad] Full raw response:', JSON.stringify(raw));
  }

  const ads = (raw?.data || []).map(d => {
    // Mapping audit: log ad_id field presence
    if (!d.ad_id) {
      console.warn('[MetricsFetcher][Ad] WARNING: row missing ad_id:', JSON.stringify(d));
    }
    return {
      meta_ad_id:    d.ad_id,
      name:          d.ad_name,
      meta_adset_id: d.adset_id,
      ...normalizeRow(d),
    };
  });

  console.log('[MetricsFetcher][Ad] Parsed', ads.length, 'ad rows');
  cache.set(key, ads, 'current');
  return ads;
}

// ─────────────────────────────────────────────
// DAILY TREND DATA (time_increment=1)
// ─────────────────────────────────────────────
async function fetchTrendData(metaCampaignId, accessToken, since, until, attributionWindowDays) {
  const key = cache.keyTrend(metaCampaignId, since, until);
  const cached = cache.get(key);
  if (cached) return cached;

  // No try/catch here, matching the campaign/ad-set/ad fetchers above: a
  // real Meta API failure must propagate to the route (GET /insights/trend
  // in insights.js has no try/catch either, so asyncHandler forwards it to
  // errorHandler, which returns a proper 502 with the real reason via
  // err.isMetaError) instead of silently resolving to an empty trend array
  // that looks identical to "this campaign genuinely has no daily data."
  const raw = await metaGet(
    `${metaCampaignId}/insights`,
    {
      fields:         CORE_FIELDS,
      time_range:     JSON.stringify({ since, until }),
      time_increment: 1,
      ...attributionWindowParams(attributionWindowDays),
    },
    accessToken
  );

  const trend = normalizeTrend(raw);
  cache.set(key, trend, 'trend');
  return trend;
}

module.exports = {
  fetchCampaignMetrics,
  fetchAdSetMetrics,
  fetchAdMetrics,
  fetchTrendData,
  normalizeInsights,
  normalizeTrend,
  normalizeRow,
  parseActions,
  pickByPriority,
  pickRoasValue,
  attributionWindowParams,
  computeDeltas,
  defaultDateRange: defaultRange,
  getPriorPeriod: priorPeriod,
  RESULT_ACTION_PRIORITY,
  RESULT_ACTION_TYPES_BY_GOAL,
};
