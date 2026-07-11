/**
 * Executive Memory — Phase X.6
 *
 * Rule-based (no LLM, no statistical model) outcome measurement and
 * historical-learning adjustment. Two responsibilities:
 *
 *   1. measureOutcomes() -- for a campaign being analyzed right now, finds
 *      any decision_history rows that are completed and old enough
 *      (OUTCOME_MEASUREMENT_WINDOW_DAYS), and haven't been measured yet,
 *      and computes whether the relevant metric improved/worsened/didn't
 *      change since the decision, using the metric snapshot already stored
 *      at decision time (supporting_metrics) plus the currentMetrics this
 *      same analysis run already fetched -- no new Meta API calls.
 *
 *   2. applyHistoricalLearning() -- before a new decision of a given type is
 *      finalized for a campaign, checks whether the same decision_type has
 *      already been tried on this campaign at least twice with no
 *      improvement, and if so, downgrades confidence one band and attaches
 *      an explicit, auditable note. This is a fixed counting rule, not a
 *      learned parameter -- see the Phase X.6 design doc's "what I cannot
 *      yet claim" section.
 *
 * DECISION_TYPE_TO_METRIC below is intentionally incomplete: REALLOCATE_BUDGET,
 * FIX_TRACKING, BUDGET_WARNING, and SCALE_CAMPAIGN have no single canonical
 * metric to compare, so outcome measurement is skipped for those decision
 * types rather than guessing one.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { pctChange } = require('./conditionComparator');
const { classifyMetric, getWorseDirection } = require('./diagnosisEngine');

const OUTCOME_MEASUREMENT_WINDOW_DAYS = 7; // matches campaigns.attribution_window_days' own default (schema.js)
const SIGNAL_THRESHOLD_PCT = 10; // matches diagnosisEngine.js's own SIGNAL_THRESHOLD_PCT convention

const DECISION_TYPE_TO_METRIC = {
  PAUSE_CAMPAIGN: 'roas',
  REFRESH_CREATIVE: 'ctr',
  EXPAND_AUDIENCE: 'frequency',
  REVIEW_PERFORMANCE: 'cpm',
};

// frequency isn't covered by diagnosisEngine.classifyMetric() (it's only
// ever a contributing factor there, never a headline metric with its own
// direction lookup) -- rising frequency is unambiguously worse (audience
// fatigue), matching diagnosisEngine.js's own decomposeVolume()/
// decomposeRate() treatment of the same signal.
const WORSE_DIRECTION_OVERRIDE = { frequency: 'rising' };

function resolveWorseDirection(metricKey) {
  if (WORSE_DIRECTION_OVERRIDE[metricKey]) return WORSE_DIRECTION_OVERRIDE[metricKey];
  const type = classifyMetric(metricKey);
  if (!type) return null;
  return getWorseDirection(metricKey, type);
}

// Classify a before/after metric pair as improved/no_change/worsened.
// Returns null when the direction can't be determined (unclassifiable
// metric) or either value is missing -- never fabricates a verdict.
function classifyOutcome(metricKey, before, after) {
  if (before == null || after == null) return null;
  const direction = resolveWorseDirection(metricKey);
  if (!direction) return null;
  const pct = pctChange(after, before, { denominator: 'abs' });
  if (pct == null) return null;

  const worseIfRising = direction === 'rising';
  const movedFavorably = worseIfRising ? pct <= -SIGNAL_THRESHOLD_PCT : pct >= SIGNAL_THRESHOLD_PCT;
  const movedUnfavorably = worseIfRising ? pct >= SIGNAL_THRESHOLD_PCT : pct <= -SIGNAL_THRESHOLD_PCT;

  if (movedFavorably) return 'improved';
  if (movedUnfavorably) return 'worsened';
  return 'no_change';
}

/**
 * Measures and persists outcomes for any of this campaign's completed
 * decisions that are old enough and haven't been measured yet. Pure
 * side-effect (writes decision_outcomes); returns what it measured for
 * visibility/testing, but callers are not required to use the return value.
 *
 * @param {object} campaign - { meta_campaign_id }
 * @param {object} currentMetrics - normalized metrics this analysis run already fetched
 */
function measureOutcomes(campaign, currentMetrics) {
  if (!currentMetrics || !campaign?.meta_campaign_id) return [];

  const cutoff = new Date(Date.now() - OUTCOME_MEASUREMENT_WINDOW_DAYS * 86400000).toISOString();
  const candidates = db.all(
    `SELECT dh.* FROM decision_history dh
     LEFT JOIN decision_outcomes do ON do.decision_history_id = dh.id
     WHERE dh.meta_campaign_id = ? AND dh.status = 'completed'
       AND dh.completed_at IS NOT NULL AND dh.completed_at <= ?
       AND do.id IS NULL`,
    [campaign.meta_campaign_id, cutoff]
  );

  const measured = [];
  for (const row of candidates) {
    const metricKey = DECISION_TYPE_TO_METRIC[row.decision_type];
    if (!metricKey) continue;

    let before = null;
    try {
      const snapshot = row.supporting_metrics ? JSON.parse(row.supporting_metrics) : null;
      before = snapshot ? (snapshot[metricKey] ?? null) : null;
    } catch { /* malformed snapshot -- skip this row, never throws */ }

    const after = currentMetrics[metricKey] ?? null;
    const outcome = classifyOutcome(metricKey, before, after);
    if (!outcome) continue;

    const deltaPct = pctChange(after, before, { denominator: 'abs' });
    const id = uuidv4();
    db.run(
      `INSERT INTO decision_outcomes
         (id, decision_history_id, meta_campaign_id, decision_type, metric_key,
          metric_before, metric_after, delta_pct, outcome, measured_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, row.id, campaign.meta_campaign_id, row.decision_type, metricKey,
        before, after, deltaPct, outcome, new Date().toISOString()]
    );

    measured.push({ decision_history_id: row.id, decision_type: row.decision_type, metric_key: metricKey, before, after, outcome });
  }

  return measured;
}

/**
 * @returns {{attempts:number, improved:number, worsened:number, no_change:number, lastOutcome:string|null, lastTwoIneffective:boolean}}
 */
function getHistoricalEffectiveness(metaCampaignId, decisionType) {
  const rows = db.all(
    `SELECT outcome FROM decision_outcomes
     WHERE meta_campaign_id = ? AND decision_type = ?
     ORDER BY measured_at DESC`,
    [metaCampaignId, decisionType]
  );

  const attempts = rows.length;
  const improved = rows.filter(r => r.outcome === 'improved').length;
  const worsened = rows.filter(r => r.outcome === 'worsened').length;
  const noChange = rows.filter(r => r.outcome === 'no_change').length;
  const lastTwo = rows.slice(0, 2).map(r => r.outcome);
  const lastTwoIneffective = lastTwo.length === 2 && lastTwo.every(o => o === 'worsened' || o === 'no_change');

  return {
    attempts, improved, worsened, no_change: noChange,
    lastOutcome: rows[0]?.outcome || null,
    lastTwoIneffective,
  };
}

const CONFIDENCE_DOWNGRADE = { high: 'medium', medium: 'low', low: 'low' };

/**
 * Rule: if the last 2 attempts of this exact decision_type for this exact
 * campaign both resulted in 'worsened' or 'no_change', downgrade confidence
 * one band and attach an explicit note. Fixed threshold, not a learned
 * parameter -- every decision this touches gets `historical_effectiveness`
 * attached regardless, so the underlying counts are always inspectable even
 * when no downgrade applies.
 *
 * @param {object[]} decisions - Decision-shaped objects with meta_campaign_id, decision_type, confidence
 */
function applyHistoricalLearning(decisions = []) {
  return decisions.map(d => {
    if (!d.meta_campaign_id || !d.decision_type) return d;
    const eff = getHistoricalEffectiveness(d.meta_campaign_id, d.decision_type);

    if (!eff.lastTwoIneffective) {
      return { ...d, historical_effectiveness: eff };
    }

    return {
      ...d,
      confidence: CONFIDENCE_DOWNGRADE[d.confidence] || d.confidence,
      historical_effectiveness: eff,
      historical_note: 'Tried twice before with no improvement (see Decision History).',
    };
  });
}

module.exports = {
  OUTCOME_MEASUREMENT_WINDOW_DAYS,
  DECISION_TYPE_TO_METRIC,
  classifyOutcome,
  measureOutcomes,
  getHistoricalEffectiveness,
  applyHistoricalLearning,
};
