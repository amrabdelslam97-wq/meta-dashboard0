/**
 * Executive Reasoning Engine — Phase 43 (Task 1: root-cause reasoning;
 * Task 11: confidence system)
 *
 * Cross-signal root-cause reasoning for the one case diagnosisEngine.js
 * itself is honest about not being able to explain: `category ===
 * 'unexplained'` (its own cascade found no matching cause pattern, which
 * today surfaces to the user as "...investigate manually"). This module
 * never touches diagnosisEngine.js -- it is a second, additive reasoning
 * pass that takes its output plus whatever OTHER real signals the caller
 * already has on hand (creative score, fatigue status, frequency, CTR
 * delta) and attempts to explain the residual movement, always hedged
 * ("most probable explanation", never a specific unverifiable claim) and
 * always paired with a real, signal-counted confidence percentage. If a
 * diagnosis already has a real cause (`factors.length > 0`), or if there is
 * truly no cross-signal data to reason from, this module defers/says so
 * honestly rather than fabricating certainty either way.
 */

const MIN_CONFIDENCE_PCT = 15;
const MAX_CONFIDENCE_PCT = 90;
const FLAT_CTR_BAND_PCT = 10;
const HIGH_FREQUENCY_THRESHOLD = 2.5;
const HEALTHY_CREATIVE_SCORE_THRESHOLD = 55;

/**
 * Task 11 — Confidence System. Every AI conclusion in this system should be
 * able to point at how many real signals support it vs. conflict with it,
 * rather than an opaque percentage. Base 50%, +5 per supporting signal,
 * -12 per conflicting signal, clamped to [15, 90] -- capped at 40 whenever
 * the underlying data itself is thin, regardless of how the signal count
 * alone would score it (thin data should never present as high-confidence).
 */
function computeConfidence({ supportingSignals = 0, conflictingSignals = 0, dataSufficient = true } = {}) {
  let pct = 50 + supportingSignals * 5 - conflictingSignals * 12;
  if (!dataSufficient) pct = Math.min(pct, 40);
  pct = Math.max(MIN_CONFIDENCE_PCT, Math.min(MAX_CONFIDENCE_PCT, Math.round(pct)));

  const reason = dataSufficient
    ? `${supportingSignals} supporting signal(s), ${conflictingSignals} conflicting signal(s).`
    : `${supportingSignals} supporting signal(s), ${conflictingSignals} conflicting signal(s) -- capped due to insufficient historical data.`;

  return { confidence_pct: pct, supporting_signals: supportingSignals, conflicting_signals: conflictingSignals, reason };
}

/**
 * @param {object} diagnosis - diagnosisEngine.diagnoseCampaign() output
 * @param {object} crossSignals - real, already-computed signals the caller
 *   has on hand but diagnosisEngine.js itself never sees:
 *   { creativeScore: number|null, fatigueStatus: string|null,
 *     frequency: number|null, ctrDeltaPct: number|null }
 * @returns {object|null} null when there is nothing for this function to
 *   add (diagnosis already explained, or wasn't a real diagnosis at all) --
 *   the caller keeps using diagnosis.summary unchanged in that case.
 */
function buildRootCauseReasoning({ diagnosis, crossSignals = {} } = {}) {
  if (!diagnosis || diagnosis.status !== 'diagnosed') return null;
  if (diagnosis.factors && diagnosis.factors.length > 0) return null; // diagnosisEngine already found a real cause -- never compete with it
  if (diagnosis.category !== 'unexplained') return null; // only this exact "no matching cascade" fallback is this module's job

  const { creativeScore, fatigueStatus, frequency, ctrDeltaPct } = crossSignals;
  const ruledOut = [];
  const contributing = [];

  if (creativeScore != null) {
    if (creativeScore >= HEALTHY_CREATIVE_SCORE_THRESHOLD) ruledOut.push(`Creative quality remains strong (score ${creativeScore}/100).`);
    else contributing.push(`Creative score is weak (${creativeScore}/100) -- creative quality may be contributing.`);
  }
  if (fatigueStatus != null) {
    if (fatigueStatus === 'none') ruledOut.push('No fatigue detected.');
    else if (fatigueStatus !== 'insufficient_data') contributing.push(`Fatigue status is "${fatigueStatus}" -- audience fatigue may be contributing.`);
  }
  if (frequency != null) {
    if (frequency < HIGH_FREQUENCY_THRESHOLD) ruledOut.push(`Frequency is still low (${frequency}).`);
    else contributing.push(`Frequency is elevated (${frequency}) -- audience saturation may be contributing.`);
  }
  if (ctrDeltaPct != null) {
    if (Math.abs(ctrDeltaPct) < FLAT_CTR_BAND_PCT) ruledOut.push(`CTR is essentially unchanged (${ctrDeltaPct}%).`);
    else contributing.push(`CTR moved ${ctrDeltaPct}% -- ad relevance may be shifting.`);
  }

  const signalsAvailable = [creativeScore, fatigueStatus, frequency, ctrDeltaPct].filter(v => v != null).length;

  if (signalsAvailable === 0) {
    // Genuinely no cross-signal data to reason from -- the legitimate case
    // Task 1 explicitly carves out for staying at low, honest confidence
    // rather than fabricating a probable cause.
    return {
      probable_explanation: null,
      ruled_out: [],
      contributing: [],
      confidence: computeConfidence({ supportingSignals: 0, conflictingSignals: 0, dataSufficient: false }),
      note: 'No creative score, fatigue, or frequency/CTR signal available to cross-reference -- genuinely insufficient data for a probable explanation.',
    };
  }

  const probableExplanation = contributing.length === 0
    ? 'Most probable explanation: auction competition or audience demand fluctuation -- every internally-tracked signal (creative quality, fatigue, frequency, CTR) checks out healthy.'
    : `Most probable explanation: ${contributing.join(' ')}`;

  const confidence = computeConfidence({
    supportingSignals: ruledOut.length,
    conflictingSignals: contributing.length > 1 ? contributing.length - 1 : 0,
    dataSufficient: signalsAvailable >= 2,
  });

  return { probable_explanation: probableExplanation, ruled_out: ruledOut, contributing, confidence };
}

module.exports = { buildRootCauseReasoning, computeConfidence };
