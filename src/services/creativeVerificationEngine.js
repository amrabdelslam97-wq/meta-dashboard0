/**
 * Creative Verification Engine — AP-POS Intelligence Layer
 *
 * Additive, read-only synthesis over data this system ALREADY persists --
 * creativeLibrary.getCreativeTimeline()'s real content-change events (real
 * diffs between consecutive creative_analytics snapshots) and this ad's real
 * recommendation history -- to answer "did performance change after the
 * last real creative edit, and was that edit plausibly a response to a
 * logged recommendation." No new table, no new sync, no new score.
 *
 * Never asserts causality: a content change followed by a metric change is
 * reported as a correlation ("since this change"), and a recommendation
 * logged shortly before a change is reported as "consistent with, but not
 * proof that" the change was made in response to it -- the same discipline
 * diagnosisEngine.js/rootCauseTaxonomy.js already apply to correlation vs.
 * causation elsewhere in this system.
 */

// Same 10% real-signal threshold this codebase already uses everywhere
// (diagnosisEngine.js's SIGNAL_THRESHOLD_PCT, creativeIntelligenceEngine.js's
// FATIGUE_SIGNAL_THRESHOLD_PCT) -- reused, not re-derived, so this module
// never disagrees with the rest of the system about what counts as a real
// move vs. noise.
const SIGNAL_THRESHOLD_PCT = 10;
// A recommendation logged within this many days before a real content
// change is treated as a plausible (not proven) trigger for that change.
const RECOMMENDATION_LOOKBACK_DAYS = 21;

function pctChange(current, prior) {
  if (current == null || prior == null || prior === 0) return null;
  return Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10;
}

function daysBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24);
}

/**
 * @param {object} timeline - creativeLibrary.getCreativeTimeline() output ({status, events, snapshots})
 * @param {object[]} [recommendationHistory] - creativeLibrary.getCreativeStateHistory()'s recommendationHistory
 */
function verifyCreativeChange(timeline, recommendationHistory = []) {
  if (!timeline || timeline.status === 'no_data') {
    return { status: 'not_enough_data', reason: 'No creative_analytics history for this ad yet.' };
  }

  const changeEvents = (timeline.events || []).filter(e => e.type === 'change').sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (changeEvents.length === 0) {
    return { status: 'no_change_detected_yet', reason: 'No real content change (headline/primary_text/CTA/creative_type/destination_url) has been detected between any two synced snapshots yet -- nothing to verify.' };
  }

  const lastChange = changeEvents[changeEvents.length - 1];
  const snapshots = (timeline.snapshots || []).slice().sort((a, b) => String(a.date_since).localeCompare(String(b.date_since)));

  const before = [...snapshots].reverse().find(s => String(s.date_since) < String(lastChange.date));
  const after = snapshots[snapshots.length - 1];
  const afterIsPostChange = after && String(after.date_since) >= String(lastChange.date);

  if (!before || !afterIsPostChange) {
    return {
      status: 'not_enough_post_change_data',
      reason: `A real ${lastChange.field} change was detected on ${lastChange.date}, but there isn't yet a snapshot with both a clear before- and after-period to compare.`,
      last_change: lastChange,
    };
  }

  const deltas = {
    score_overall: { before: before.score_overall, after: after.score_overall, delta_pct: pctChange(after.score_overall, before.score_overall) },
    ctr: { before: before.ctr, after: after.ctr, delta_pct: pctChange(after.ctr, before.ctr) },
    cpa: { before: before.cpa, after: after.cpa, delta_pct: pctChange(after.cpa, before.cpa) },
    roas: { before: before.roas, after: after.roas, delta_pct: pctChange(after.roas, before.roas) },
  };

  const scoreUp = deltas.score_overall.delta_pct != null && deltas.score_overall.delta_pct >= SIGNAL_THRESHOLD_PCT;
  const scoreDown = deltas.score_overall.delta_pct != null && deltas.score_overall.delta_pct <= -SIGNAL_THRESHOLD_PCT;
  const ctrUp = deltas.ctr.delta_pct != null && deltas.ctr.delta_pct >= SIGNAL_THRESHOLD_PCT;
  const ctrDown = deltas.ctr.delta_pct != null && deltas.ctr.delta_pct <= -SIGNAL_THRESHOLD_PCT;
  const cpaUp = deltas.cpa.delta_pct != null && deltas.cpa.delta_pct >= SIGNAL_THRESHOLD_PCT; // cpa rising is bad
  const cpaDown = deltas.cpa.delta_pct != null && deltas.cpa.delta_pct <= -SIGNAL_THRESHOLD_PCT; // cpa falling is good

  let verdict;
  if ((scoreUp || ctrUp || cpaDown) && !(scoreDown || ctrDown || cpaUp)) verdict = 'improved';
  else if ((scoreDown || ctrDown || cpaUp) && !(scoreUp || ctrUp || cpaDown)) verdict = 'declined';
  else if (!scoreUp && !scoreDown && !ctrUp && !ctrDown && !cpaUp && !cpaDown) verdict = 'no_clear_change';
  else verdict = 'mixed_signals';

  const plausibleTrigger = (recommendationHistory || [])
    .filter(r => r.generated_at && String(r.generated_at) <= String(lastChange.date) && daysBetween(r.generated_at, lastChange.date) <= RECOMMENDATION_LOOKBACK_DAYS)
    .sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)))[0] || null;

  return {
    status: 'verified',
    verdict,
    last_change: lastChange,
    compared_period: { before: before.date_until, after: after.date_until },
    deltas,
    plausible_trigger: plausibleTrigger
      ? { recommendation_title: plausibleTrigger.recommendation_title || plausibleTrigger.rule_code, generated_at: plausibleTrigger.generated_at, disclosure: 'Logged before this change and within the lookback window -- consistent with, but not proof that, this change was made in response to it.' }
      : null,
    disclosure: 'Reports what changed and what happened afterward using this ad\'s own real, already-synced snapshots -- never asserts the content change caused the metric change, only that it preceded it.',
  };
}

module.exports = { verifyCreativeChange, SIGNAL_THRESHOLD_PCT, RECOMMENDATION_LOOKBACK_DAYS };
