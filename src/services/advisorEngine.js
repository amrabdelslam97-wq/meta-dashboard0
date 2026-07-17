/**
 * AI Marketing Advisor — Phase 42 (Decision Intelligence)
 *
 * Pure logic layer on top of the already-fixed Creative Intelligence pipeline
 * (Phase 21 scoring in creativeIntelligenceEngine.js, Phase 40/41 real-data +
 * Arabic NLP fixes in creativeTextAnalysis.js/creativeLibrary.js). Does NOT
 * recompute any score, does NOT call the DB or Meta API, and does NOT change
 * any existing engine's output — it only reads the structures those engines
 * already produce (scores, fatigue, text_analysis, comparison, benchmark
 * averages, timeline) and synthesizes WHY a creative performs the way it
 * does, WHAT to do about it, and HOW confident that advice is.
 *
 * House rule (matching creativeTextAnalysis.js's own header): every factor,
 * risk verdict, and recommendation below must trace back to a real, already-
 * computed number or detected signal. Nothing here is a generative/LLM call
 * or a fabricated verdict — if there isn't enough evidence, the functions
 * below say so explicitly rather than guessing.
 */

const { MIN_SPEND_FOR_FATIGUE } = require('./creativeIntelligenceEngine');

const TOLERANCE_PCT = 10; // within +/-10% of a benchmark average counts as "average", not above/below
const STRONG_SCORE = 65;
const WEAK_SCORE = 40;

function round(n, dp = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

// ─────────────────────────────────────────────
// Benchmark classification (Phase 10)
// ─────────────────────────────────────────────

/** @param higherIsBetter true for ctr/roas/score_overall, false for cpa/cpm (cost metrics) */
function classifyVsAverage(value, avg, higherIsBetter) {
  if (value === null || value === undefined || avg === null || avg === undefined || avg === 0) return null;
  const diffPct = ((value - avg) / Math.abs(avg)) * 100;
  const better = higherIsBetter ? diffPct >= TOLERANCE_PCT : diffPct <= -TOLERANCE_PCT;
  const worse = higherIsBetter ? diffPct <= -TOLERANCE_PCT : diffPct >= TOLERANCE_PCT;
  return { status: better ? 'above_average' : worse ? 'below_average' : 'average', diff_pct: round(diffPct) };
}

const METRIC_DIRECTION = { ctr: true, roas: true, score_overall: true, cpa: false, cpm: false };

/**
 * @param benchmarkAverages - getCreativeBenchmarkAverages() output: { ad_set, campaign, account } each
 *   either { status: 'insufficient_data'|'not_applicable', ... } or { status:'ok', sample_size, averages:{ctr,cpa,cpm,frequency,roas,score_overall} }
 * @param latestRow - creative_analytics row (ctr, cpa, cpm, roas, score_overall)
 */
function buildBenchmarkComparison(benchmarkAverages, latestRow) {
  const grains = ['ad_set', 'campaign', 'account'];
  const result = {};
  for (const grain of grains) {
    const b = benchmarkAverages?.[grain];
    if (!b || b.status !== 'ok') {
      result[grain] = { status: b?.status || 'not_applicable', sample_size: b?.sample_size ?? 0, reason: b?.reason || 'No benchmark grain available.' };
      continue;
    }
    const perMetric = {};
    for (const [metric, higherIsBetter] of Object.entries(METRIC_DIRECTION)) {
      const cls = classifyVsAverage(latestRow[metric], b.averages[metric], higherIsBetter);
      if (cls) perMetric[metric] = { value: round(latestRow[metric], 2), average: round(b.averages[metric], 2), ...cls };
    }
    result[grain] = { status: 'ok', sample_size: b.sample_size, metrics: perMetric };
  }
  return result;
}

/** Rolls the 3-grain comparison into one overall verdict, preferring the ad_set grain (most direct peer comparison), falling back to campaign then account. */
function overallBenchmarkVerdict(benchmarkComparison) {
  for (const grain of ['ad_set', 'campaign', 'account']) {
    const g = benchmarkComparison[grain];
    if (g.status !== 'ok') continue;
    const statuses = Object.values(g.metrics).map(m => m.status);
    const aboveCount = statuses.filter(s => s === 'above_average').length;
    const belowCount = statuses.filter(s => s === 'below_average').length;
    let verdict = 'average';
    if (aboveCount > belowCount) verdict = 'above_average';
    else if (belowCount > aboveCount) verdict = 'below_average';
    return { grain, verdict, sample_size: g.sample_size };
  }
  return { grain: null, verdict: 'unknown', sample_size: 0 };
}

// ─────────────────────────────────────────────
// PHASE 1-2-3 — Root Cause / Success / Failure Factors
// ─────────────────────────────────────────────

const DIMENSION_LABELS = {
  hook: 'Hook / opening line', headline: 'Headline', copy: 'Copy length & readability',
  cta: 'Call-to-action', offer: 'Offer clarity', trust: 'Trust & social proof',
  psychology: 'Persuasion / psychology signals', visual: 'Visual metadata fit',
};
const WEAK_LABELS = new Set(['weak', 'missing', 'absent', 'vague', 'poor']);
const STRONG_LABELS = new Set(['strong', 'clear', 'present', 'good']);

function buildRootCause({ textAnalysis, fatigue, benchmarkComparison }) {
  const positive = [];
  const negative = [];

  if (textAnalysis) {
    for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
      const dim = textAnalysis[key];
      if (!dim || dim.score === null || dim.score === undefined) continue;
      if (dim.score >= STRONG_SCORE || STRONG_LABELS.has(dim.label)) {
        positive.push({ factor: label, evidence: dim.evidence, impact: Math.round(dim.score - 50) });
      } else if (dim.score < WEAK_SCORE || WEAK_LABELS.has(dim.label)) {
        negative.push({ factor: label, evidence: dim.evidence, impact: Math.round(50 - dim.score) });
      }
    }
  }

  if (fatigue?.signals?.length) {
    for (const s of fatigue.signals) {
      negative.push({ factor: `Fatigue signal: ${s.signal.replace(/_/g, ' ')}`, evidence: s.detail, impact: 20 });
    }
  }

  if (benchmarkComparison) {
    for (const grain of ['ad_set', 'campaign', 'account']) {
      const g = benchmarkComparison[grain];
      if (g.status !== 'ok') continue;
      for (const [metric, m] of Object.entries(g.metrics)) {
        if (m.status === 'above_average') {
          positive.push({ factor: `${metric.toUpperCase()} above ${grain.replace('_', ' ')} average`, evidence: `${m.value} vs. average ${m.average} across ${g.sample_size} other creatives (${m.diff_pct}%).`, impact: 15 });
        } else if (m.status === 'below_average') {
          negative.push({ factor: `${metric.toUpperCase()} below ${grain.replace('_', ' ')} average`, evidence: `${m.value} vs. average ${m.average} across ${g.sample_size} other creatives (${m.diff_pct}%).`, impact: 15 });
        }
      }
      break; // only the first available grain to avoid repeating the same story 3x
    }
  }

  positive.sort((a, b) => b.impact - a.impact);
  negative.sort((a, b) => b.impact - a.impact);

  return { positive_factors: positive.slice(0, 6), negative_factors: negative.slice(0, 6) };
}

// ─────────────────────────────────────────────
// PHASE 11 — Score Explanation
// ─────────────────────────────────────────────

function confidenceFromSpend(spend, fatigueStatus) {
  if (fatigueStatus === 'insufficient_data') return 'low';
  if (spend == null || spend < MIN_SPEND_FOR_FATIGUE) return 'low';
  if (spend < 100) return 'medium';
  return 'high';
}

function buildScoreExplanation({ scores, textAnalysis, fatigue, spend }) {
  const { positive_factors, negative_factors } = buildRootCause({ textAnalysis, fatigue, benchmarkComparison: null });
  const missing_opportunities = [];
  if (textAnalysis) {
    for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
      const dim = textAnalysis[key];
      if (dim && dim.label === 'missing') {
        missing_opportunities.push({ dimension: label, reason: dim.evidence });
      }
    }
  }
  return {
    score_overall: scores.score_overall,
    positive_factors,
    negative_factors,
    missing_opportunities,
    confidence_level: confidenceFromSpend(spend, fatigue?.status),
  };
}

// ─────────────────────────────────────────────
// PHASE 4 & 15 — Priority Engine (top 3, each with why/how/impact/confidence)
// ─────────────────────────────────────────────

const HOW_TO = {
  'Rewrite Hook': 'Rewrite the first line to lead with a question, a curiosity trigger, or a concrete benefit within the first few words.',
  'Shorten Copy': 'Cut primary text/headline down and keep only the single strongest benefit or offer.',
  'Improve CTA': 'Replace the CTA with a specific, committing action (e.g. "Book Now"/"احجز الآن") that matches the campaign objective.',
  'Add Social Proof': 'Add a specific customer count, review, or guarantee to the copy.',
  'Use Better Offer': 'State a concrete price, discount percentage, or free-value offer.',
  'Replace Thumbnail': "Swap in an asset using one of Meta's recommended feed aspect ratios (1:1, 4:5, or 9:16).",
  'Reduce Text': 'Cut copy to under 40 words and add one urgency or curiosity element.',
  'Pause': 'Pause this ad in Ads Manager to stop further spend on a fatigued/underperforming creative.',
  'Refresh': 'Duplicate the ad and swap the hook/primary text while keeping the elements that are still working (offer, CTA).',
  'Scale': 'Increase daily budget by 20-30% and monitor CPA/frequency for 3-5 days before scaling further.',
  'Duplicate Winner': 'Duplicate this ad into the same or a new ad set to test creative variations while it is still fresh.',
  'Reallocate Budget': "Shift a portion of this ad set's budget toward its stronger sibling creative.",
  'Pause Loser': 'Pause this ad and reallocate its budget to the ad-set winner.',
  'Split Test': 'Keep running at current spend until it crosses the minimum-data threshold before making a scale/pause call.',
};

const IMPACT = {
  'Rewrite Hook': 'Improves scroll-stop rate and hook retention.',
  'Shorten Copy': 'Reduces drop-off before the message/offer lands.',
  'Improve CTA': 'Raises click/conversion intent from an already-engaged viewer.',
  'Add Social Proof': 'Increases trust, typically lifting conversion rate more than CTR.',
  'Use Better Offer': 'Clarifies the value proposition, typically lifting CTR and conversion rate.',
  'Replace Thumbnail': 'Improves scroll-stop power and reduces cropping/placement mismatch.',
  'Reduce Text': 'Improves readability and message completion on mobile feed.',
  'Pause': 'Stops further budget loss on an underperforming/fatigued creative.',
  'Refresh': 'Resets audience fatigue while preserving proven elements.',
  'Scale': "Extends a proven performer's reach before fatigue sets in.",
  'Duplicate Winner': 'Extends a proven performer\'s reach/lifetime and de-risks reliance on a single ad.',
  'Reallocate Budget': 'Improves overall ad-set efficiency without touching a healthy creative.',
  'Pause Loser': 'Redirects budget away from the weakest performer in the ad set.',
  'Split Test': 'Avoids a premature scale/pause decision made on too little data.',
};

const PRIORITY_WEIGHT = { high: 0, medium: 1, low: 2 };

function buildPriorityEngine(recommendations, { spend, fatigueStatus }) {
  const seen = new Set();
  const unique = [];
  for (const r of (recommendations || []).slice().sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority])) {
    if (seen.has(r.action)) continue;
    seen.add(r.action);
    unique.push(r);
  }
  return unique.slice(0, 3).map((r, i) => ({
    priority: i + 1,
    action: r.action,
    why: r.reason,
    how: HOW_TO[r.action] || r.reason,
    expected_impact: IMPACT[r.action] || 'Impact depends on execution — not independently benchmarked in this system.',
    confidence: confidenceFromSpend(spend, fatigueStatus),
    evidence_used: [r.reason],
  }));
}

// ─────────────────────────────────────────────
// PHASE 5 — Strategic Advice
// ─────────────────────────────────────────────

function buildStrategicAdvice({ scores, fatigue, benchmarkVerdict, priorities, spend }) {
  if (spend == null || spend < 5) {
    return { headline: 'Not enough spend yet for a confident recommendation.', detail: 'Minimum $5 spend is required before this system will score a creative reliably.' };
  }
  if (fatigue.status === 'severe') {
    return { headline: 'Pause this creative now.', detail: `Severe fatigue detected: ${fatigue.evidence}` };
  }
  if (fatigue.status === 'moderate') {
    return { headline: 'Refresh this creative soon.', detail: `Moderate fatigue detected: ${fatigue.evidence}` };
  }
  if (scores.score_overall != null && scores.score_overall >= STRONG_SCORE && fatigue.status === 'none' && benchmarkVerdict.verdict !== 'below_average') {
    const grainText = benchmarkVerdict.grain ? ` its ${benchmarkVerdict.grain.replace('_', ' ')}` : '';
    return {
      headline: 'Do not change this creative yet.',
      detail: benchmarkVerdict.verdict === 'above_average'
        ? `It is still performing above${grainText} average with no fatigue signals.`
        : `It is performing at or above${grainText} average with no fatigue signals.`,
    };
  }
  if (priorities && priorities.length) {
    return {
      headline: `If you can improve only one thing: ${priorities[0].action}.`,
      detail: priorities[0].why,
    };
  }
  return { headline: 'No strong signal in either direction yet.', detail: 'Keep monitoring — neither a clear strength nor a clear weakness has emerged from the available data.' };
}

// ─────────────────────────────────────────────
// PHASE 6 — Change Risk
// ─────────────────────────────────────────────

function buildChangeRisk({ scores, fatigue, comparisonRole, spend }) {
  if (spend == null || spend < MIN_SPEND_FOR_FATIGUE || fatigue.status === 'insufficient_data') {
    return { risk_level: 'Monitor first', reason: 'Not enough spend/history yet to judge whether this creative is winning or failing.' };
  }
  if (fatigue.status === 'severe' || (scores.score_overall != null && scores.score_overall < 30)) {
    return { risk_level: 'Safe to edit', reason: 'Already severely fatigued or critically scored — there is little downside to changing it.' };
  }
  if (fatigue.status === 'moderate' || (scores.score_overall != null && scores.score_overall < WEAK_SCORE)) {
    return { risk_level: 'Safe to edit', reason: 'Underperforming with moderate fatigue or a weak score — editing carries low risk since the current version is already struggling.' };
  }
  if (comparisonRole?.isWinner && fatigue.status === 'none' && scores.score_overall != null && scores.score_overall >= STRONG_SCORE) {
    return { risk_level: 'Leave unchanged', reason: 'Top performer in its ad set with no fatigue signals — editing risks losing a proven result.' };
  }
  if (fatigue.status === 'none' && scores.score_overall != null && scores.score_overall >= STRONG_SCORE) {
    return { risk_level: 'High risk', reason: 'Currently a solid, healthy performer — there is no underperformance signal to justify the risk of changing it.' };
  }
  return { risk_level: 'Monitor first', reason: 'Performance is mixed/average with no strong signal to justify either editing or leaving it alone.' };
}

// ─────────────────────────────────────────────
// PHASE 7 — Scaling Advisor
// ─────────────────────────────────────────────

function buildScalingAdvice({ scores, fatigue, comparisonRole, latestRow, benchmarkVerdict }) {
  const spend = latestRow?.spend;
  if (fatigue.status !== 'none') {
    return { recommended: false, reason: `Fatigue status is "${fatigue.status}" — never recommend scaling a fatigued creative.` };
  }
  if (scores.score_overall == null || scores.score_overall < STRONG_SCORE) {
    return { recommended: false, reason: `Overall score (${scores.score_overall ?? 'n/a'}) is below the ${STRONG_SCORE} threshold used for scaling — not a strong enough performer yet.` };
  }
  if (spend == null || spend < MIN_SPEND_FOR_FATIGUE) {
    return { recommended: false, reason: 'Not enough spend yet to justify a scaling decision.' };
  }

  const actions = [];
  if (comparisonRole?.isWinner) {
    actions.push({ action: 'Duplicate', reason: 'Top performer in its ad set — duplicate to test variations while it is still winning.' });
  }
  if (scores.score_overall >= 75 && benchmarkVerdict.verdict !== 'below_average') {
    actions.push({ action: 'Increase Budget', reason: `Strong overall score (${scores.score_overall}) with cost metrics at or above ${benchmarkVerdict.grain ? benchmarkVerdict.grain.replace('_', ' ') : 'peer'} average.` });
  }
  if (latestRow?.frequency != null && latestRow.frequency < 2.0) {
    actions.push({ action: 'Expand Audience', reason: `Frequency is low (${round(latestRow.frequency, 2)}) — room to reach more of the audience before saturation sets in.` });
  }
  if (actions.length === 0) {
    actions.push({ action: 'Keep Running', reason: 'Healthy and above the scaling score threshold, but no specific signal (winner role, strong cost efficiency, or low frequency) points to a stronger action yet.' });
  }
  return { recommended: true, actions };
}

// ─────────────────────────────────────────────
// PHASE 8 — Pause Advisor
// ─────────────────────────────────────────────

function weakestTextDimension(textAnalysis) {
  if (!textAnalysis) return null;
  let weakest = null;
  for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
    const dim = textAnalysis[key];
    if (!dim || dim.score === null || dim.label === 'missing') continue;
    if (!weakest || dim.score < weakest.score) weakest = { key, label, score: dim.score, evidence: dim.evidence };
  }
  return weakest;
}

function buildPauseAdvice({ scores, fatigue, textAnalysis }) {
  if (fatigue.status === 'severe') {
    return { action: 'Pause', reason: `Severe fatigue: ${fatigue.evidence}` };
  }
  if (fatigue.status === 'moderate') {
    if (scores.score_overall != null && scores.score_overall < 35) {
      return { action: 'Pause', reason: `Moderate fatigue combined with a critical creative score (${scores.score_overall}): ${fatigue.evidence}` };
    }
    return { action: 'Refresh', reason: `Moderate fatigue but the creative itself still scores acceptably (${scores.score_overall ?? 'n/a'}): ${fatigue.evidence}` };
  }
  if (fatigue.status === 'early') {
    const weakest = weakestTextDimension(textAnalysis);
    if (weakest && weakest.score < WEAK_SCORE) {
      return { action: 'Rewrite', reason: `Early fatigue signals plus a weak ${weakest.label.toLowerCase()} (${weakest.score}): ${weakest.evidence}` };
    }
    return { action: 'Wait', reason: `Early fatigue signals only — not yet strong enough to justify pausing or rewriting: ${fatigue.evidence}` };
  }
  if (fatigue.status === 'insufficient_data') {
    return { action: 'Wait', reason: fatigue.evidence };
  }
  return { action: null, reason: 'No fatigue or decline signals detected — no pause action needed.' };
}

// ─────────────────────────────────────────────
// PHASE 9 — Compare Creatives (dimension-by-dimension, real scores only)
// ─────────────────────────────────────────────

const COMPARISON_DIMENSIONS = [
  ['score_hook', 'hook quality'], ['score_headline', 'headline'], ['score_copy', 'copy'],
  ['score_cta', 'CTA strength'], ['score_offer', 'offer clarity'], ['score_trust', 'trust/social proof'],
  ['score_visual', 'visual metadata fit'],
];

function compareDimensions(a, b) {
  if (!a?.scores || !b?.scores) return [];
  const diffs = [];
  for (const [key, label] of COMPARISON_DIMENSIONS) {
    const av = a.scores[key];
    const bv = b.scores[key];
    if (av == null || bv == null) continue;
    const diff = av - bv;
    if (Math.abs(diff) < 5) continue; // real but negligible difference — not worth narrating
    diffs.push({ dimension: label, a_score: av, b_score: bv, diff: round(diff) });
  }
  if (a.cost_per_result != null && b.cost_per_result != null && b.cost_per_result > 0) {
    const costDiffPct = round(((a.cost_per_result - b.cost_per_result) / b.cost_per_result) * 100);
    if (Math.abs(costDiffPct) >= 10) {
      diffs.push({ dimension: 'cost per result', a_score: a.cost_per_result, b_score: b.cost_per_result, diff_pct: costDiffPct });
    }
  }
  return diffs.sort((x, y) => Math.abs(y.diff ?? y.diff_pct) - Math.abs(x.diff ?? x.diff_pct));
}

function buildComparisonBreakdown(comparison, shapedSiblings) {
  if (!comparison?.winner || !shapedSiblings?.length) return null;
  const byId = new Map(shapedSiblings.map(s => [s.meta_ad_id, s]));
  const winner = byId.get(comparison.winner.meta_ad_id);
  const runnerUp = comparison.runner_up ? byId.get(comparison.runner_up.meta_ad_id) : null;
  const worst = comparison.worst ? byId.get(comparison.worst.meta_ad_id) : null;

  const result = {};
  if (winner && worst && worst !== winner) {
    result.winner_vs_weakest = { winner_ad_id: winner.meta_ad_id, weakest_ad_id: worst.meta_ad_id, dimensions: compareDimensions(winner, worst) };
  }
  if (winner && runnerUp && runnerUp !== winner) {
    result.winner_vs_runner_up = { winner_ad_id: winner.meta_ad_id, runner_up_ad_id: runnerUp.meta_ad_id, dimensions: compareDimensions(winner, runnerUp) };
  }
  return result;
}

// ─────────────────────────────────────────────
// PHASE 14 — Creative Evolution stages (derived from getCreativeTimeline()'s
// already-computed events; never invents a stage that has no backing event)
// ─────────────────────────────────────────────

function buildEvolutionStages(timeline) {
  if (!timeline || timeline.status === 'no_data') return { stages: [], note: 'No snapshots synced yet for this ad.' };
  if (timeline.status === 'insufficient_data') return { stages: [], note: 'Only one snapshot so far — not enough history for a lifecycle view.' };

  const events = timeline.events || [];
  const launch = events.find(e => e.type === 'launch');
  const peak = events.find(e => e.type === 'peak');
  const decline = events.find(e => e.type === 'decline');
  const fatigueEv = events.find(e => e.type === 'fatigue');
  const recovery = events.find(e => e.type === 'recovery');

  const stages = [];
  if (launch) stages.push({ stage: 'Launch', date: launch.date, evidence: `Score ${launch.score_overall ?? 'n/a'} at the first synced snapshot.` });

  if (peak && launch && peak.date !== launch.date) {
    if (peak.score_overall != null && launch.score_overall != null && peak.score_overall > launch.score_overall * 1.1) {
      stages.push({ stage: 'Growth', date_range: [launch.date, peak.date], evidence: `Score rose from ${launch.score_overall} to ${peak.score_overall}.` });
    }
    stages.push({ stage: 'Peak', date: peak.date, evidence: `Highest recorded score_overall (${peak.score_overall}).` });
  }

  if (peak && !decline && !fatigueEv) {
    stages.push({ stage: 'Stable', evidence: 'No decline or fatigue signals recorded since peak.' });
  }

  if (decline) stages.push({ stage: 'Decline', date: decline.date, evidence: `Score dropped ${decline.drop_from_peak_pct}% from its peak.` });
  if (fatigueEv) stages.push({ stage: 'Fatigue', date: fatigueEv.date, evidence: `Fatigue status reached "${fatigueEv.fatigue_status}".` });
  if (recovery) stages.push({ stage: 'Recovery', date: recovery.date, evidence: `Score recovered to ${recovery.score_overall}, back near peak with fatigue cleared.` });

  return { stages };
}

// ─────────────────────────────────────────────
// Orchestrator — assembles every phase above into one advisor bundle for
// one creative. Degrades gracefully (never throws) when a source input
// (text analysis, comparison, benchmark averages) isn't available yet.
// ─────────────────────────────────────────────

function buildCreativeAdvisor({ scores, fatigue, textAnalysis, latestRow, benchmarkAverages, comparison, comparisonRole, shapedSiblings, timeline, recommendations }) {
  const benchmarkComparison = buildBenchmarkComparison(benchmarkAverages || {}, latestRow || {});
  const benchmarkVerdict = overallBenchmarkVerdict(benchmarkComparison);
  const rootCause = buildRootCause({ textAnalysis, fatigue, benchmarkComparison });
  const scoreExplanation = buildScoreExplanation({ scores, textAnalysis, fatigue, spend: latestRow?.spend });
  const priorities = buildPriorityEngine(recommendations, { spend: latestRow?.spend, fatigueStatus: fatigue?.status });
  const strategicAdvice = buildStrategicAdvice({ scores, fatigue, benchmarkVerdict, priorities, spend: latestRow?.spend });
  const changeRisk = buildChangeRisk({ scores, fatigue, comparisonRole, spend: latestRow?.spend });
  const scalingAdvice = buildScalingAdvice({ scores, fatigue, comparisonRole, latestRow, benchmarkVerdict });
  const pauseAdvice = buildPauseAdvice({ scores, fatigue, textAnalysis });
  const comparisonBreakdown = buildComparisonBreakdown(comparison, shapedSiblings);
  const evolution = buildEvolutionStages(timeline);

  return {
    root_cause: rootCause,
    score_explanation: scoreExplanation,
    priorities,
    strategic_advice: strategicAdvice,
    change_risk: changeRisk,
    scaling_advice: scalingAdvice,
    pause_advice: pauseAdvice,
    benchmark: { comparison: benchmarkComparison, overall_verdict: benchmarkVerdict },
    comparison_breakdown: comparisonBreakdown,
    evolution,
  };
}

module.exports = {
  classifyVsAverage,
  buildBenchmarkComparison,
  overallBenchmarkVerdict,
  buildRootCause,
  buildScoreExplanation,
  buildPriorityEngine,
  buildStrategicAdvice,
  buildChangeRisk,
  buildScalingAdvice,
  buildPauseAdvice,
  compareDimensions,
  buildComparisonBreakdown,
  buildEvolutionStages,
  buildCreativeAdvisor,
};
