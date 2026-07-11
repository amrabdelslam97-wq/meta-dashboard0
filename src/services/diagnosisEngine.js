/**
 * Diagnosis Engine — Phase 9
 *
 * Rule-based decomposition of *why* a campaign's primary KPI moved.
 * Pure logic, no DB access of its own — takes already-fetched data as
 * input (current/prior/deltas from metricsFetcher.fetchCampaignMetrics(),
 * profile from kpiProfileResolver.resolveProfile()), mirroring the
 * "presentation/logic layer only" style of comparisonEngine.js and
 * recommendationResolver.js. No LLM, no new Meta fields, no new schema —
 * every signal used here is already normalized by metricsFetcher.js.
 *
 * Output shape:
 *   {
 *     status: 'diagnosed' | 'insufficient_data',
 *     objective, primaryKey, primaryLabel, primaryDelta,
 *     category, confidence, priority, factors, summary,
 *   }
 */

const { pctChange } = require('./conditionComparator');

// ─────────────────────────────────────────────
// Thresholds (explicit, documented, not a black-box score)
// ─────────────────────────────────────────────

// Below this, there isn't enough traffic to say anything meaningful about
// *why* the primary KPI moved at all -- returns insufficient_data rather
// than a diagnosis built on noise.
const MIN_IMPRESSIONS_FOR_DIAGNOSIS = 100;

// The plan's volume floor for a "high" confidence diagnosis. Between this
// and MIN_IMPRESSIONS_FOR_DIAGNOSIS, a diagnosis is still produced but
// confidence is capped at 'medium'/'low' -- distinguishes "no usable
// signal at all" from "usable but thin" data.
const MIN_IMPRESSIONS_FOR_HIGH_CONFIDENCE = 1000;

// A metric must move by at least this percentage to count as a matched
// cascade factor (avoids treating normal day-to-day noise as a "cause").
const SIGNAL_THRESHOLD_PCT = 10;

// A metric within this band of zero delta is treated as "flat" for the
// saturation/fatigue cascade checks (e.g. flat frequency + stable spend).
const FLAT_BAND_PCT = 5;

// purchase_value must drop at least this much (with purchase count roughly
// stable) to flag a tracking anomaly for ROAS diagnoses, rather than a
// genuine sales decline.
const TRACKING_ANOMALY_DROP_PCT = -20;

const PRIORITY_TABLE = {
  severe:   { high: 'critical', medium: 'high',   low: 'medium' },
  moderate: { high: 'high',     medium: 'medium', low: 'low' },
  mild:     { high: 'low',      medium: 'low',    low: 'observation_only' },
};

// ─────────────────────────────────────────────
// Metric classification — which cascade a headline metric follows.
// Kept generic (keyed off the metric, not the objective) so this also
// works if a future caller passes an ad-set/ad-level headline metric.
// ─────────────────────────────────────────────
const COST_METRIC_KEYS = new Set([
  'cpa', 'cpl', 'cpi', 'cost_per_engagement', 'cpr',
  'cost_per_landing_page_view', 'cpm', 'cost_per_thruplay',
]);
const VOLUME_METRIC_KEYS = new Set([
  'reach', 'impressions', 'leads', 'results', 'app_installs',
  'landing_page_views', 'purchases', 'thruplays',
]);
const RATE_METRIC_KEYS = new Set(['ctr', 'cpc']);

function classifyMetric(key) {
  if (key === 'roas') return 'roas';
  if (COST_METRIC_KEYS.has(key)) return 'cost';
  if (VOLUME_METRIC_KEYS.has(key)) return 'volume';
  if (RATE_METRIC_KEYS.has(key)) return 'rate';
  return null;
}

// Which direction of movement is "worse" for a given headline metric.
// roas/volume: falling is bad. cost: rising is bad. rate mixes two
// opposite-direction metrics (ctr falling is bad, cpc rising is bad), so it
// can't share a single direction with the other three types.
function getWorseDirection(key, type) {
  if (type === 'roas' || type === 'volume') return 'falling';
  if (type === 'rate') return key === 'ctr' ? 'falling' : 'rising';
  return 'rising'; // cost
}

// ─────────────────────────────────────────────
// Signal helpers
// ─────────────────────────────────────────────
function isRising(delta, threshold = SIGNAL_THRESHOLD_PCT) {
  return !!delta && delta.delta_pct >= threshold;
}
function isFalling(delta, threshold = -SIGNAL_THRESHOLD_PCT) {
  return !!delta && delta.delta_pct <= threshold;
}
function isFlat(delta, band = FLAT_BAND_PCT) {
  return !!delta && Math.abs(delta.delta_pct) < band;
}

// Derived conversion rate = purchases/clicks, else results/clicks, else
// leads/clicks. Not a stored metric -- computed inline per the plan, since
// no `cvr` field exists in metricsFetcher's normalized output.
function conversionRate(metrics) {
  if (!metrics) return null;
  const clicks = metrics.clicks ?? metrics.link_clicks;
  if (!clicks) return null;
  const numerator = metrics.purchases ?? metrics.results ?? metrics.leads;
  if (numerator == null) return null;
  return numerator / clicks;
}

function conversionRateFalling(current, prior) {
  const cur = conversionRate(current);
  const prr = conversionRate(prior);
  const pct = pctChange(cur, prr, { denominator: 'abs' });
  if (pct == null) return false;
  return pct <= -SIGNAL_THRESHOLD_PCT;
}

// ─────────────────────────────────────────────
// Cascades — one per metric type, in the "check order" from the approved
// decomposition table. First match sets the category; every match is kept
// in `factors` for context.
// ─────────────────────────────────────────────
function decomposeCost(current, prior, deltas) {
  const factors = [];
  if (isRising(deltas.cpm)) {
    factors.push({ key: 'cpm_rising', category: 'competition', detail: 'Cost per 1,000 impressions (CPM) rose, indicating increased auction competition.' });
  }
  if (isFalling(deltas.ctr)) {
    factors.push({ key: 'ctr_falling', category: 'creative', detail: 'Click-through rate fell, suggesting creative fatigue or weaker ad relevance.' });
  }
  if (conversionRateFalling(current, prior)) {
    factors.push({ key: 'conversion_rate_falling', category: 'audience', detail: 'Conversion rate (results per click) fell, suggesting audience or landing experience mismatch.' });
  }
  return factors;
}

function decomposeRoas(current, prior, deltas) {
  const purchasesStable = !isFalling(deltas.purchases) && !isRising(deltas.purchases);
  const valueDroppedSharply = isFalling(deltas.purchase_value, TRACKING_ANOMALY_DROP_PCT);
  if (purchasesStable && valueDroppedSharply) {
    return [{ key: 'purchase_value_drop_with_stable_count', category: 'tracking', detail: 'Purchase count held steady but purchase value dropped sharply — check pixel/conversion value tracking before assuming a real sales decline.' }];
  }
  // Otherwise ROAS falling behaves like a cost-based decline (spend
  // efficiency worsened) -- reuse the same cascade.
  return decomposeCost(current, prior, deltas);
}

function decomposeVolume(current, prior, deltas) {
  const factors = [];
  if (isRising(deltas.frequency)) {
    factors.push({ key: 'frequency_rising', category: 'audience', detail: 'Frequency rose while the primary metric fell, indicating audience saturation — the same people are being reached repeatedly instead of new ones.' });
  }
  if (isRising(deltas.cpm)) {
    factors.push({ key: 'cpm_rising', category: 'competition', detail: 'CPM rose, indicating increased auction competition is reducing how far the budget reaches.' });
  }
  if (isFalling(deltas.spend)) {
    factors.push({ key: 'spend_falling', category: 'budget', detail: 'Spend fell, which alone can explain a lower volume metric.' });
  }
  return factors;
}

function decomposeRate(current, prior, deltas) {
  const factors = [];
  if (isRising(deltas.frequency)) {
    factors.push({ key: 'frequency_rising', category: 'audience', detail: 'Frequency rose, indicating audience saturation is driving the rate decline.' });
  } else if (isFlat(deltas.frequency) && isFlat(deltas.spend)) {
    factors.push({ key: 'creative_fatigue_proxy', category: 'creative', detail: 'Frequency and spend are both flat, so the rate decline is likely creative fatigue rather than audience or budget changes.' });
  }
  return factors;
}

function decompose(type, current, prior, deltas) {
  switch (type) {
    case 'cost':   return decomposeCost(current, prior, deltas);
    case 'roas':   return decomposeRoas(current, prior, deltas);
    case 'volume': return decomposeVolume(current, prior, deltas);
    case 'rate':   return decomposeRate(current, prior, deltas);
    default:       return [];
  }
}

function hasSufficientData(current, prior) {
  return !!current && !!prior
    && current.impressions >= MIN_IMPRESSIONS_FOR_DIAGNOSIS
    && prior.impressions >= MIN_IMPRESSIONS_FOR_DIAGNOSIS;
}

function magnitudeBand(pct) {
  const abs = Math.abs(pct);
  if (abs >= 30) return 'severe';
  if (abs >= 15) return 'moderate';
  return 'mild';
}

function insufficientData(objective, primaryKey, primaryLabel, primaryDelta) {
  return {
    status: 'insufficient_data',
    objective,
    primaryKey,
    primaryLabel,
    primaryDelta: primaryDelta || null,
    category: null,
    confidence: 'low',
    priority: 'observation_only',
    factors: [],
    summary: 'Not enough traffic in this period to diagnose what is driving the change.',
  };
}

/**
 * @param {object} campaign - { id, meta_campaign_id, name, objective }
 * @param {object} profile - resolved KPI profile (kpiProfileResolver.resolveProfile())
 * @param {object} current - normalized current-period metrics (metricsFetcher)
 * @param {object} prior - normalized prior-period metrics (metricsFetcher), or null
 * @param {object} deltas - metricsFetcher.computeDeltas(current, prior) output
 */
function diagnoseCampaign(campaign, profile, current, prior, deltas) {
  const objective = campaign?.objective || null;
  const primaryKey = profile.primaryKPI.key;
  const primaryLabel = profile.primaryKPI.label;
  const primaryDelta = deltas ? deltas[primaryKey] : null;

  if (!primaryDelta || !hasSufficientData(current, prior)) {
    return insufficientData(objective, primaryKey, primaryLabel, primaryDelta);
  }

  const type = classifyMetric(primaryKey);

  if (!type) {
    // Unclassified headline metric (e.g. 'spend' for the 'unknown'
    // objective fallback) -- there's no known "bad direction" for it, so
    // this can never be more than a neutral observation.
    return {
      status: 'diagnosed',
      objective,
      primaryKey,
      primaryLabel,
      primaryDelta,
      category: 'unclassified',
      confidence: 'low',
      priority: 'observation_only',
      factors: [],
      summary: `${primaryLabel} moved ${Math.abs(primaryDelta.delta_pct)}%, but this objective has no defined cause cascade for it.`,
    };
  }

  const worseDirection = getWorseDirection(primaryKey, type);
  const isWorse = worseDirection === 'falling' ? primaryDelta.delta_pct < 0 : primaryDelta.delta_pct > 0;

  if (!isWorse) {
    // The primary KPI actually improved -- nothing to diagnose as a problem.
    return {
      status: 'diagnosed',
      objective,
      primaryKey,
      primaryLabel,
      primaryDelta,
      category: null,
      confidence: 'low',
      priority: 'observation_only',
      factors: [],
      summary: `${primaryLabel} did not move unfavorably in this period.`,
    };
  }

  const factors = decompose(type, current, prior, deltas);
  const category = factors.length > 0 ? factors[0].category : 'unexplained';

  const dataIsRich = current.impressions >= MIN_IMPRESSIONS_FOR_HIGH_CONFIDENCE
    && prior.impressions >= MIN_IMPRESSIONS_FOR_HIGH_CONFIDENCE;

  let confidence;
  if (factors.length === 0) confidence = 'low';
  else if (factors.length === 1 && dataIsRich) confidence = 'high';
  else if (dataIsRich || factors.length === 1) confidence = 'medium';
  else confidence = 'low';

  const priority = PRIORITY_TABLE[magnitudeBand(primaryDelta.delta_pct)][confidence];

  const summary = factors.length > 0
    ? `${primaryLabel} ${worseDirection} ${Math.abs(primaryDelta.delta_pct)}% — most likely cause: ${category} (${factors[0].detail})`
    : `${primaryLabel} ${worseDirection} ${Math.abs(primaryDelta.delta_pct)}%, but no matching cause pattern was found — investigate manually.`;

  return {
    status: 'diagnosed',
    objective,
    primaryKey,
    primaryLabel,
    primaryDelta,
    category,
    confidence,
    priority,
    factors,
    summary,
  };
}

// classifyMetric/getWorseDirection additionally exported (Phase X.6 —
// Executive Memory) so executiveMemory.js's outcome-direction classification
// reuses the exact same metric-type/worse-direction logic diagnoseCampaign()
// itself uses, rather than a second copy. No change to either function.
module.exports = { diagnoseCampaign, classifyMetric, getWorseDirection };
