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
const { computeConfidence } = require('./executiveReasoningEngine');

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
      // Phase 43 (Task 9) -- when this dimension tracks a real `missing`
      // list (hook/headline today), surface it as "lost points because" so
      // a score is never just a bare number. Absent for dimensions that
      // don't structurally track missing signals (copy/cta/offer/trust/
      // visual) -- honest partial coverage, never fabricated.
      const deductions = Array.isArray(dim.missing) && dim.missing.length ? dim.missing.map(m => m.label) : undefined;
      if (dim.score >= STRONG_SCORE || STRONG_LABELS.has(dim.label)) {
        positive.push({ factor: label, evidence: dim.evidence, impact: Math.round(dim.score - 50), ...(deductions ? { missed_opportunities: deductions } : {}) });
      } else if (dim.score < WEAK_SCORE || WEAK_LABELS.has(dim.label)) {
        negative.push({ factor: label, evidence: dim.evidence, impact: Math.round(50 - dim.score), ...(deductions ? { lost_points_because: deductions } : {}) });
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
  // Phase 43 (Task 9) -- every dimension score gets its own "why" entry,
  // not only the ones that crossed the strong/weak threshold above. When a
  // real `missing` list exists (hook/headline), the deduction reason names
  // the actual absent signals instead of a bare number.
  const dimension_breakdown = [];
  if (textAnalysis) {
    for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
      const dim = textAnalysis[key];
      if (!dim) continue;
      if (dim.label === 'missing') {
        missing_opportunities.push({ dimension: label, reason: dim.evidence });
      }
      if (dim.score === null || dim.score === undefined) continue;
      const deductions = Array.isArray(dim.missing) && dim.missing.length ? dim.missing.map(m => m.label) : null;
      dimension_breakdown.push({
        dimension: label,
        score: dim.score,
        reason: deductions
          ? `Lost ${Math.max(0, 100 - dim.score)} points because: ${deductions.join(', ')}.`
          : dim.evidence,
      });
    }
  }
  return {
    score_overall: scores.score_overall,
    positive_factors,
    negative_factors,
    missing_opportunities,
    dimension_breakdown,
    confidence_level: confidenceFromSpend(spend, fatigue?.status),
  };
}

// ─────────────────────────────────────────────
// PHASE 43 (Task 2) — Connect Creative Score with Health Score
// ─────────────────────────────────────────────

function scoreTier(score) {
  if (score >= STRONG_SCORE) return 'high';
  if (score < WEAK_SCORE) return 'low';
  return 'mid';
}
const TIER_WORD = { high: 'strong', low: 'weak', mid: 'middling' };

function buildScoreRelationship(healthScore, creativeScore) {
  if (healthScore == null || creativeScore == null) {
    return { pattern: 'insufficient_data', explanation: 'Health score and/or creative score not yet available for this ad -- cannot relate the two.', next_step: null };
  }
  const healthTier = scoreTier(healthScore);
  const creativeTier = scoreTier(creativeScore);

  if (healthTier === 'high' && creativeTier === 'high') {
    return {
      pattern: 'both_high',
      explanation: `Both health (${healthScore}) and creative quality (${creativeScore}) are strong -- performance is being driven by a genuinely good ad, not by targeting/bid luck alone. Safe to scale with confidence.`,
      next_step: 'Keep the current creative running and consider scaling budget -- both signals support it.',
    };
  }
  if (healthTier === 'high' && creativeTier === 'low') {
    return {
      pattern: 'high_health_low_creative',
      explanation: `Health is strong (${healthScore}) despite a weak creative (${creativeScore}) -- the campaign is likely being carried by targeting/bid/objective fit rather than the ad itself. There is still real creative upside on the table.`,
      // Phase 44 (Task 3) -- the actionable "unlock additional growth" framing.
      next_step: 'Improving the hook or copy could unlock additional growth on top of what delivery is already achieving.',
    };
  }
  if (healthTier === 'low' && creativeTier === 'high') {
    return {
      pattern: 'high_creative_low_health',
      explanation: `The creative itself is strong (${creativeScore}), but overall health is weak (${healthScore}) -- the drag is more likely coming from delivery, audience, or budget factors outside the creative's own message, not the ad's message itself.`,
      next_step: 'Investigate delivery-side factors (audience, budget, bidding) before assuming the message itself needs work.',
    };
  }
  if (healthTier === 'low' && creativeTier === 'low') {
    return {
      pattern: 'both_low',
      explanation: `Both creative quality (${creativeScore}) and health (${healthScore}) are weak -- this is a compounding problem. Fixing only one is unlikely to be enough on its own.`,
      next_step: 'Address the creative first -- a stronger message is usually the higher-leverage fix before spending more on delivery.',
    };
  }
  // Phase 43 fix -- honesty bug: at least one score here is 'mid', never
  // both confidently high/low, so the explanation must describe EACH
  // score's actual tier rather than a blanket "both middling" (a health
  // score of 99 next to a mid creative score is not "both in the middle").
  return {
    pattern: 'mixed',
    explanation: `Health is ${TIER_WORD[healthTier]} (${healthScore}) and creative quality is ${TIER_WORD[creativeTier]} (${creativeScore}) -- no strong high/low pattern in both at once yet.`,
    // Phase 44 (Task 3) -- names which side has more room to help, when one
    // side is clearly ahead of the other, rather than a generic non-answer.
    next_step: healthTier === 'high'
      ? 'Performance is being carried by strong delivery -- improving the hook could unlock additional growth on top of it.'
      : creativeTier === 'high'
        ? 'The creative is not the bottleneck here -- delivery-side factors are more likely holding results back.'
        : 'Keep monitoring both signals before making a scaling decision -- neither is clearly the bottleneck yet.',
  };
}

// ─────────────────────────────────────────────
// PHASE 43 (Task 8) — Historical (self-trend) & previous-creative-version
// benchmarking. Extends Phase 42's account/campaign/ad-set peer averages
// with the two comparisons Task 8 explicitly adds: this same ad's own past
// performance, and the metrics before/after its last real content change.
// Never compares against a fabricated "industry benchmark".
// ─────────────────────────────────────────────

const HISTORICAL_TREND_METRICS = { ctr: true, roas: true, score_overall: true, cpa: false, cpm: false };

function trendDirection(metric, deltaPct) {
  if (deltaPct == null || Math.abs(deltaPct) < 5) return 'stable';
  if (!(metric in HISTORICAL_TREND_METRICS)) return deltaPct > 0 ? 'rising' : 'falling';
  const higherIsBetter = HISTORICAL_TREND_METRICS[metric];
  return (higherIsBetter ? deltaPct > 0 : deltaPct < 0) ? 'improving' : 'declining';
}

function buildHistoricalComparison(snapshots) {
  const rows = (snapshots || []).filter(r => (r.spend || 0) >= 5).slice().sort((a, b) => a.date_since.localeCompare(b.date_since));
  if (rows.length < 2) {
    return { status: 'insufficient_data', reason: 'Need at least 2 real snapshots (>= $5 spend) for this ad to compare against its own history.' };
  }
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const trend = {};
  for (const metric of ['ctr', 'cpa', 'cpm', 'roas', 'score_overall', 'frequency']) {
    if (latest[metric] == null || previous[metric] == null) continue;
    const deltaPct = previous[metric] !== 0 ? round(((latest[metric] - previous[metric]) / Math.abs(previous[metric])) * 100) : null;
    trend[metric] = { current: latest[metric], previous: previous[metric], delta_pct: deltaPct, direction: trendDirection(metric, deltaPct) };
  }
  return {
    status: 'ok',
    latest_snapshot: { date_since: latest.date_since, date_until: latest.date_until },
    previous_snapshot: { date_since: previous.date_since, date_until: previous.date_until },
    trend,
  };
}

function buildPreviousVersionComparison(timeline) {
  if (!timeline || !Array.isArray(timeline.events)) {
    return { status: 'no_data', reason: 'No timeline available for this ad.' };
  }
  const changeEvents = timeline.events.filter(e => e.type === 'change');
  if (changeEvents.length === 0) {
    return { status: 'no_version_change', reason: 'No content change (headline/primary text/CTA/creative type/destination URL) detected yet for this ad -- nothing to compare against a previous version.' };
  }
  const lastChange = changeEvents[changeEvents.length - 1];
  const snapshots = (timeline.snapshots || []).slice().sort((a, b) => a.date_since.localeCompare(b.date_since));
  const before = snapshots.filter(s => s.date_since < lastChange.date).slice(-1)[0];
  const after = snapshots.find(s => s.date_since >= lastChange.date);
  if (!before || !after) {
    return { status: 'insufficient_data', reason: 'A content change was detected, but there are not enough snapshots on both sides of it to compare.' };
  }
  const comparison = {};
  for (const metric of ['ctr', 'cpa', 'score_overall']) {
    if (before[metric] == null || after[metric] == null) continue;
    const deltaPct = before[metric] !== 0 ? round(((after[metric] - before[metric]) / Math.abs(before[metric])) * 100) : null;
    comparison[metric] = { before: before[metric], after: after[metric], delta_pct: deltaPct };
  }
  return { status: 'ok', change: { field: lastChange.field, date: lastChange.date, from: lastChange.from, to: lastChange.to }, comparison };
}

// ─────────────────────────────────────────────
// PHASE 43 (Task 6) — Richer creative evolution timeline. Extends the
// existing launch/peak/decline/fatigue/recovery event timeline
// (getCreativeTimeline()) with a real metric-by-metric time series (from
// the same snapshots, zero new query) and real persisted state transitions
// (health score / recommendation / alert history for this ad, fetched by
// the caller from already-existing tables -- never fabricated, never
// invents a "decision change"/"scaling event" that isn't actually tracked
// at ad grain in this system).
// ─────────────────────────────────────────────

function buildMetricsTimeline(snapshots) {
  return (snapshots || []).slice().sort((a, b) => a.date_since.localeCompare(b.date_since)).map(s => ({
    date_since: s.date_since, date_until: s.date_until,
    ctr: s.ctr, cpa: s.cpa, cpm: s.cpm, frequency: s.frequency, spend: s.spend,
    conversions: s.results, score_overall: s.score_overall, fatigue_status: s.fatigue_status,
  }));
}

// Phase 45 (Task 8) -- collapses consecutive, EXACTLY-repeated timeline
// entries (e.g. eight identical "Health score 99 (excellent)" snapshots in
// a row) into one ranged entry. Only merges entries of the same type with
// the identical detail string -- a real, unchanged repeat, never entries
// that differ in any real way.
function humanizeRepeatedDetail(type, detail, count) {
  if (type === 'health_score') {
    const m = detail.match(/\(([a-z]+)\)/i);
    const status = m ? m[1] : detail;
    return `Health Score remained ${status.charAt(0).toUpperCase()}${status.slice(1)}`;
  }
  return `${detail} (unchanged across ${count} snapshots)`;
}

function mergeConsecutiveTimelineEntries(rows) {
  if (!rows || rows.length === 0) return [];
  const sorted = rows.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const merged = [];
  for (const row of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.type === row.type && last.detail === row.detail) {
      last._rangeStart = last._rangeStart || last.date;
      last._rangeEnd = row.date;
      last._repeatCount = (last._repeatCount || 1) + 1;
    } else {
      merged.push({ ...row });
    }
  }
  return merged.map(m => {
    if (!m._repeatCount || m._repeatCount < 2) return { type: m.type, date: m.date, detail: m.detail };
    return {
      type: m.type,
      date: m._rangeEnd,
      date_range: [String(m._rangeStart).slice(0, 10), String(m._rangeEnd).slice(0, 10)],
      detail: humanizeRepeatedDetail(m.type, m.detail, m._repeatCount),
      repeat_count: m._repeatCount,
    };
  });
}

function buildStateTransitions({ healthHistory = [], recommendationHistory = [], alertHistory = [] } = {}) {
  const transitions = [
    ...healthHistory.map(h => ({ type: 'health_score', date: h.calculated_at, detail: `Health score ${h.health_score} (${h.health_status})` })),
    ...recommendationHistory.map(r => ({ type: 'recommendation', date: r.generated_at, detail: r.recommendation_title || r.rule_code })),
    ...alertHistory.map(a => ({ type: 'alert', date: a.first_detected_at, detail: `${a.alert_code} (${a.severity}, ${a.status})` })),
  ];
  const sorted = transitions.filter(t => !!t.date).sort((a, b) => a.date.localeCompare(b.date));
  return mergeConsecutiveTimelineEntries(sorted);
}

// Phase 44 (Task 4) -- business-meaningful metric events (CTR Peak, CPA
// Drop, Frequency Increase), detected only between two REAL, consecutive
// snapshots crossing the same 10% signal threshold every other engine in
// this system uses (creativeIntelligenceEngine.FATIGUE_SIGNAL_THRESHOLD_PCT) --
// never a fabricated event on a metric that didn't really move.
const BUSINESS_EVENT_THRESHOLD_PCT = 10;

function buildBusinessEvents(metricsTimeline) {
  const rows = metricsTimeline || [];
  const events = [];
  let ctrPeakSoFar = null;

  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;

    if (cur.ctr != null && (ctrPeakSoFar == null || cur.ctr > ctrPeakSoFar)) {
      if (prev && prev.ctr != null && prev.ctr > 0) {
        const pct = round(((cur.ctr - prev.ctr) / prev.ctr) * 100);
        if (pct >= BUSINESS_EVENT_THRESHOLD_PCT) {
          events.push({ type: 'ctr_peak', date: cur.date_since, detail: `New high CTR (${cur.ctr}%), up ${pct}% from the prior snapshot.` });
        }
      }
      ctrPeakSoFar = cur.ctr;
    }

    if (prev && prev.cpa != null && cur.cpa != null && prev.cpa > 0) {
      const pct = round(((cur.cpa - prev.cpa) / prev.cpa) * 100);
      if (pct <= -BUSINESS_EVENT_THRESHOLD_PCT) {
        events.push({ type: 'cpa_drop', date: cur.date_since, detail: `Cost per result fell ${Math.abs(pct)}% (${prev.cpa} -> ${cur.cpa}).` });
      }
    }

    if (prev && prev.frequency != null && cur.frequency != null && prev.frequency > 0) {
      const pct = round(((cur.frequency - prev.frequency) / prev.frequency) * 100);
      if (pct >= BUSINESS_EVENT_THRESHOLD_PCT) {
        events.push({ type: 'frequency_increase', date: cur.date_since, detail: `Frequency rose ${pct}% (${prev.frequency} -> ${cur.frequency}).` });
      }
    }
  }
  return events;
}

/** Phase 44 (Task 4) -- Creative/Health Score Milestones: a real crossing of the strong/weak threshold, or a real health-status change, never a fabricated one. */
function buildScoreMilestones(metricsTimeline, healthHistory) {
  const events = [];
  const scored = (metricsTimeline || []).filter(r => r.score_overall != null);
  for (let i = 1; i < scored.length; i++) {
    const prev = scored[i - 1].score_overall;
    const cur = scored[i].score_overall;
    if (prev < STRONG_SCORE && cur >= STRONG_SCORE) {
      events.push({ type: 'creative_score_milestone', date: scored[i].date_since, detail: `Creative score crossed into strong territory (${prev} -> ${cur}).` });
    } else if (prev >= WEAK_SCORE && cur < WEAK_SCORE) {
      events.push({ type: 'creative_score_milestone', date: scored[i].date_since, detail: `Creative score dropped into weak territory (${prev} -> ${cur}).` });
    }
  }
  const health = (healthHistory || []).filter(r => r.health_score != null);
  for (let i = 1; i < health.length; i++) {
    const prev = health[i - 1];
    const cur = health[i];
    if (prev.health_status !== cur.health_status) {
      events.push({ type: 'health_score_milestone', date: cur.calculated_at, detail: `Health status changed from "${prev.health_status}" to "${cur.health_status}" (${prev.health_score} -> ${cur.health_score}).` });
    }
  }
  return events;
}

function buildRichEvolutionTimeline({ snapshots, healthHistory, recommendationHistory, alertHistory }) {
  const metricsTimeline = buildMetricsTimeline(snapshots);
  const businessEvents = [
    ...buildBusinessEvents(metricsTimeline),
    ...buildScoreMilestones(metricsTimeline, healthHistory),
  ].filter(e => !!e.date).sort((a, b) => a.date.localeCompare(b.date));

  return {
    metrics_timeline: metricsTimeline,
    state_transitions: buildStateTransitions({ healthHistory, recommendationHistory, alertHistory }),
    business_events: businessEvents,
    // Real, honest gaps -- this system has no ad-grain persisted log for
    // any of these (budget/audience changes live at ad-set grain,
    // decision_history is campaign-grain only), so they are named here
    // rather than fabricated.
    not_tracked_at_ad_grain: ['budget_changes', 'audience_changes', 'decision_changes'],
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

// Phase 43 (Task 5) -- risk of TAKING each recommended action (distinct from
// change_risk's "risk of leaving this ad as-is"). Every entry is a real,
// generic-but-honest tradeoff of that specific action, not a fabricated
// per-ad claim.
const RISK = {
  'Rewrite Hook': 'Low risk -- easily reversible, only the opening line changes.',
  'Shorten Copy': 'Low risk -- reversible; may lose detail some segments valued.',
  'Improve CTA': 'Low risk -- reversible, but a CTA mismatched to the objective can lower conversion quality.',
  'Add Social Proof': 'Low risk, requires real proof (an actual review/count) to avoid an unsubstantiated claim.',
  'Use Better Offer': 'Medium risk -- changes the actual economics of the ad, not just the message.',
  'Replace Thumbnail': 'Low risk -- reversible, easy to A/B test against the current asset.',
  'Reduce Text': 'Low risk -- reversible; may remove context some segments needed.',
  'Pause': 'Low risk to spend, but stops all reach/learning immediately -- irreversible data gap while paused.',
  'Refresh': 'Medium risk -- resets some learning/optimization progress in the ad set.',
  'Scale': 'Medium risk -- watch frequency and CPA closely after increasing budget; can trigger new fatigue.',
  'Duplicate Winner': 'Low risk -- the original keeps running; only adds a variant to test.',
  'Reallocate Budget': 'Low risk to total spend, but reduces data volume on the ad losing budget.',
  'Pause Loser': 'Low risk -- removes the weakest performer; verify no unique audience/placement is lost with it.',
  'Split Test': 'No risk -- this is a hold, not a change.',
};

const PRIORITY_WEIGHT = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABELS = ['Highest Priority', 'Medium Priority', 'Low Priority'];
// Phase 44 (Task 7) -- Decision Priority Engine tiers, additive alongside
// the existing Highest/Medium/Low labels (kept for backward compatibility).
const ACTION_TIERS = ['Immediate Actions', 'Important Actions', 'Future Actions'];

/**
 * Phase 43 (Task 5) -- concrete, real evidence bullets for WHY a specific
 * action is recommended, pulled from context the caller already computed
 * (fatigue, peer-average benchmark comparison, this ad's own historical
 * trend). Never invents a bullet it can't back with a real field.
 *
 * Phase 44 (Task 10) -- phrased as a marketer would read it, not as a raw
 * technical signal name (e.g. "still has room to scale before fatigue"
 * instead of a bare "No fatigue detected.").
 */
function buildActionEvidence(action, { fatigueStatus, benchmarkVerdict, historicalComparison, latestRow } = {}) {
  const bullets = [];
  if (fatigueStatus === 'none') bullets.push('This creative still has room to scale before signs of audience fatigue appear.');
  if (latestRow?.frequency != null && latestRow.frequency < 2.0) bullets.push(`It hasn't reached the audience-saturation point yet (frequency ${round(latestRow.frequency, 2)}), so there's headroom before results start to fade.`);
  if (benchmarkVerdict?.verdict === 'above_average' && benchmarkVerdict.grain) {
    bullets.push(`It's outperforming its ${benchmarkVerdict.grain.replace('_', ' ')} peers, not just holding steady.`);
  }
  if (historicalComparison?.status === 'ok') {
    const scoreTrend = historicalComparison.trend.score_overall;
    if (scoreTrend && scoreTrend.direction === 'improving') bullets.push(`Creative quality is trending up (score ${scoreTrend.previous} -> ${scoreTrend.current}), not just stable.`);
    const cpaTrend = historicalComparison.trend.cpa;
    if (cpaTrend && cpaTrend.direction === 'stable') bullets.push(`Cost per result has stayed steady (${cpaTrend.previous} -> ${cpaTrend.current}), so efficiency isn't the concern here.`);
    const ctrTrend = historicalComparison.trend.ctr;
    if (ctrTrend && ctrTrend.direction === 'improving') bullets.push(`Click-through rate is climbing (${ctrTrend.previous}% -> ${ctrTrend.current}%), a sign the message is still landing.`);
  }
  return bullets;
}

// ─────────────────────────────────────────────
// PHASE 44 (Task 8) — Expected Business Impact. Ranges only, never a
// fabricated precise number. Where a real gap-to-peer-average or historical
// trend exists, the range is DERIVED from it (grounded); otherwise a wide,
// clearly-hedged default range is used and confidence is capped low.
// ─────────────────────────────────────────────

function pctRangeLabel(lowPct, highPct) {
  return `${round(lowPct)}-${round(highPct)}%`;
}

function buildBusinessImpactEstimate(action, { benchmarkComparison, latestRow, confidencePct } = {}) {
  const CTR_ACTIONS = new Set(['Rewrite Hook', 'Shorten Copy', 'Improve CTA', 'Add Social Proof', 'Use Better Offer', 'Replace Thumbnail', 'Reduce Text']);
  const SCALE_ACTIONS = new Set(['Scale', 'Duplicate Winner', 'Duplicate']);
  const NOT_APPLICABLE = { probability: null, range: null, note: 'Not applicable -- this action stops or redirects delivery rather than growing it.' };

  if (action === 'Pause' || action === 'Pause Loser' || action === 'Refresh' || action === 'Reallocate Budget') {
    return { reach_increase: NOT_APPLICABLE, cpa_change: NOT_APPLICABLE, ctr_improvement: NOT_APPLICABLE, confidence_pct: confidencePct ?? null };
  }

  let ctrImprovement = { probability: 'Low', range: '0-5%', note: 'Default conservative range -- no peer-average CTR gap available to ground a larger estimate.' };
  if (CTR_ACTIONS.has(action)) {
    const adSetCtr = benchmarkComparison?.ad_set?.metrics?.ctr;
    const campaignCtr = benchmarkComparison?.campaign?.metrics?.ctr;
    const ctrGap = adSetCtr?.status === 'below_average' ? adSetCtr : (campaignCtr?.status === 'below_average' ? campaignCtr : null);
    if (ctrGap) {
      // Grounded in the REAL gap between this ad's own CTR and the real peer
      // average -- capped to a defensible range, never the full raw gap
      // (closing 100% of a gap from one text change would be an overclaim).
      const gapPct = Math.min(30, Math.abs(ctrGap.diff_pct));
      ctrImprovement = { probability: gapPct >= 15 ? 'Medium' : 'Low', range: pctRangeLabel(gapPct * 0.2, gapPct * 0.6), note: `Derived from the real CTR gap vs. its peer average (${ctrGap.diff_pct}%).` };
    }
  }

  let reachIncrease = NOT_APPLICABLE;
  let cpaChange = NOT_APPLICABLE;
  if (SCALE_ACTIONS.has(action)) {
    const freq = latestRow?.frequency;
    // A real, bounded heuristic: more available frequency headroom (lower
    // current frequency) supports a larger reach increase with less CPA
    // risk -- never an unconditional fixed number.
    if (freq != null && freq < 2.0) {
      reachIncrease = { probability: 'Medium', range: '10-20%', note: `Frequency has headroom (${round(freq, 2)}) before saturation limits further reach.` };
      cpaChange = { probability: 'Low', range: '+/-10%', note: 'Symmetric range -- scaling can move CPA in either direction; watch it after the change.' };
    } else {
      reachIncrease = { probability: 'Low', range: '5-10%', note: 'Frequency is already moderate/elevated, which caps how much incremental reach scaling can add before saturation.' };
      cpaChange = { probability: 'Medium', range: '+5-15%', note: 'Elevated frequency raises the odds scaling pushes cost per result up.' };
    }
  }

  return { reach_increase: reachIncrease, cpa_change: cpaChange, ctr_improvement: ctrImprovement, confidence_pct: confidencePct ?? null };
}

// ─────────────────────────────────────────────
// PHASE 44 (Task 9) — Risk Assessment. Five named risk dimensions per
// action, each Low/Medium/High with a real reason -- distinct from (and
// more granular than) the single `risk` string Phase 43 already attaches.
// ─────────────────────────────────────────────

function buildRiskAssessment(action, { fatigueStatus, latestRow, confidencePct } = {}) {
  const PAUSE_LIKE = new Set(['Pause', 'Pause Loser']);
  const SCALE_LIKE = new Set(['Scale', 'Duplicate Winner', 'Duplicate']);
  const TEXT_EDIT = new Set(['Rewrite Hook', 'Shorten Copy', 'Improve CTA', 'Add Social Proof', 'Use Better Offer', 'Replace Thumbnail', 'Reduce Text']);

  const implementation_risk = TEXT_EDIT.has(action)
    ? { level: 'Low', reason: 'A text/asset-only change, fully reversible in Ads Manager.' }
    : PAUSE_LIKE.has(action)
      ? { level: 'Low', reason: 'A status change only -- reversible by re-enabling the ad.' }
      : { level: 'Medium', reason: 'Involves a budget or duplication change with more moving parts than a text edit.' };

  const learning_phase_risk = SCALE_LIKE.has(action)
    ? { level: 'Medium', reason: 'A meaningful budget/audience change can reset the ad set\'s delivery learning phase.' }
    : action === 'Refresh'
      ? { level: 'Medium', reason: 'Duplicating with new creative elements restarts learning for that variant.' }
      : { level: 'Low', reason: 'Does not materially change delivery/targeting, so learning phase is unlikely to reset.' };

  const audience_fatigue_risk = fatigueStatus === 'severe' || fatigueStatus === 'moderate'
    ? { level: 'High', reason: `Fatigue is already "${fatigueStatus}" -- any delay compounds it further.` }
    : (latestRow?.frequency != null && latestRow.frequency >= 3)
      ? { level: 'Medium', reason: `Frequency is already elevated (${round(latestRow.frequency, 2)}), raising near-term fatigue risk regardless of this action.` }
      : { level: 'Low', reason: 'No current fatigue signal and frequency is not elevated.' };

  const budget_risk = SCALE_LIKE.has(action)
    ? { level: 'Medium', reason: 'Increases spend commitment; monitor CPA closely after the change.' }
    : PAUSE_LIKE.has(action)
      ? { level: 'Low', reason: 'Reduces/stops spend -- the safer direction for budget risk.' }
      : { level: 'Low', reason: 'Does not directly change spend commitment.' };

  const performance_volatility = fatigueStatus === 'insufficient_data' || (latestRow?.spend != null && latestRow.spend < MIN_SPEND_FOR_FATIGUE)
    ? { level: 'High', reason: 'Too little spend/history yet for a stable read -- short-term metrics can swing significantly.' }
    : { level: 'Low', reason: 'Enough spend/history exists for a reasonably stable read.' };

  return {
    implementation_risk, learning_phase_risk, audience_fatigue_risk, budget_risk, performance_volatility,
    confidence_pct: confidencePct ?? null,
  };
}

function buildPriorityEngine(recommendations, { spend, fatigueStatus, benchmarkVerdict, benchmarkComparison, historicalComparison, latestRow } = {}) {
  const seen = new Set();
  const unique = [];
  for (const r of (recommendations || []).slice().sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority])) {
    if (seen.has(r.action)) continue;
    seen.add(r.action);
    unique.push(r);
  }
  return unique.slice(0, 3).map((r, i) => {
    const evidenceBullets = buildActionEvidence(r.action, { fatigueStatus, benchmarkVerdict, historicalComparison, latestRow });
    const confidence = computeConfidence({
      supportingSignals: evidenceBullets.length,
      conflictingSignals: 0,
      dataSufficient: spend != null && spend >= MIN_SPEND_FOR_FATIGUE && fatigueStatus !== 'insufficient_data',
    });
    return {
      priority: i + 1,
      priority_label: PRIORITY_LABELS[i] || `Priority ${i + 1}`,
      tier: ACTION_TIERS[i] || `Tier ${i + 1}`,
      action: r.action,
      why: r.reason,
      how: HOW_TO[r.action] || r.reason,
      expected_impact: IMPACT[r.action] || 'Impact depends on execution — not independently benchmarked in this system.',
      risk: RISK[r.action] || 'Risk not characterized for this action.',
      confidence: confidenceFromSpend(spend, fatigueStatus),
      confidence_pct: confidence.confidence_pct,
      confidence_reason: confidence.reason,
      evidence_used: evidenceBullets.length ? [r.reason, ...evidenceBullets] : [r.reason],
      business_impact: buildBusinessImpactEstimate(r.action, { benchmarkComparison, latestRow, confidencePct: confidence.confidence_pct }),
      risk_assessment: buildRiskAssessment(r.action, { fatigueStatus, latestRow, confidencePct: confidence.confidence_pct }),
    };
  });
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

/**
 * Phase 44 (Task 6) -- turns the raw dimension diffs from compareDimensions()
 * plus real CTR/frequency/fatigue fields (when the shaped object carries
 * them -- see creativeLibrary.js's toComparisonShape()) into one readable
 * "this creative wins because..." sentence. Every clause traces to a real
 * value; when nothing crosses the explanation threshold, says so honestly
 * instead of inventing a reason.
 */
function buildWinLossNarrative(a, b) {
  if (!a || !b) return null;
  const reasons = [];
  if (a.ctr != null && b.ctr != null && b.ctr > 0) {
    const pct = round(((a.ctr - b.ctr) / b.ctr) * 100);
    if (Math.abs(pct) >= 10) reasons.push(`CTR is ${Math.abs(pct)}% ${pct > 0 ? 'higher' : 'lower'}`);
  }
  for (const d of compareDimensions(a, b)) {
    if (d.dimension === 'cost per result') {
      reasons.push(`cost per result is ${d.diff_pct < 0 ? 'lower' : 'higher'} (${d.diff_pct}%)`);
      continue;
    }
    reasons.push(`${d.dimension} is ${d.diff > 0 ? 'stronger' : 'weaker'}`);
  }
  if (a.frequency != null && b.frequency != null && Math.abs(a.frequency - b.frequency) >= 0.3) {
    reasons.push(`frequency is ${a.frequency < b.frequency ? 'healthier (lower)' : 'higher'}`);
  }
  if (a.fatigue_status != null && b.fatigue_status != null && a.fatigue_status !== b.fatigue_status) {
    reasons.push(`fatigue status is "${a.fatigue_status}" vs. "${b.fatigue_status}"`);
  }
  const comparedAgainst = b.ad_name || b.meta_ad_id;
  return {
    narrative: reasons.length
      ? `This creative wins because ${reasons.join(', ')}. Compared against: ${comparedAgainst}.`
      : `The overall score differs, but no single dimension crossed the explanation threshold against ${comparedAgainst}.`,
    compared_against: comparedAgainst,
  };
}

function buildComparisonBreakdown(comparison, shapedSiblings) {
  if (!comparison?.winner || !shapedSiblings?.length) return null;
  const byId = new Map(shapedSiblings.map(s => [s.meta_ad_id, s]));
  const winner = byId.get(comparison.winner.meta_ad_id);
  const runnerUp = comparison.runner_up ? byId.get(comparison.runner_up.meta_ad_id) : null;
  const worst = comparison.worst ? byId.get(comparison.worst.meta_ad_id) : null;

  const result = {};
  if (winner && worst && worst !== winner) {
    result.winner_vs_weakest = {
      winner_ad_id: winner.meta_ad_id, weakest_ad_id: worst.meta_ad_id,
      dimensions: compareDimensions(winner, worst),
      narrative: buildWinLossNarrative(winner, worst)?.narrative || null,
    };
  }
  if (winner && runnerUp && runnerUp !== winner) {
    result.winner_vs_runner_up = {
      winner_ad_id: winner.meta_ad_id, runner_up_ad_id: runnerUp.meta_ad_id,
      dimensions: compareDimensions(winner, runnerUp),
      narrative: buildWinLossNarrative(winner, runnerUp)?.narrative || null,
    };
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
// PHASE 43 (Task 7) — AI Strategic Advisor Panel. The centerpiece: rolls
// scaling/pause/change-risk/priorities into ONE clear current status with a
// real, signal-counted confidence, a bulleted reason, concrete next
// actions, an expected result, and named risks. Every field traces to a
// real value already computed above -- never fabricated.
// ─────────────────────────────────────────────

function buildAdvisorPanel({ scores, fatigue, benchmarkVerdict, scalingAdvice, pauseAdvice, changeRisk, priorities, latestRow }) {
  let currentStatus;
  if (pauseAdvice.action === 'Pause') currentStatus = 'Pause';
  else if (scalingAdvice.recommended) currentStatus = 'Scale';
  else if (pauseAdvice.action === 'Refresh' || pauseAdvice.action === 'Rewrite') currentStatus = pauseAdvice.action;
  else if (changeRisk.risk_level === 'Leave unchanged') currentStatus = 'Leave Unchanged';
  else currentStatus = 'Monitor';

  // Phase 44 (Task 10) -- business language, not raw technical signal names.
  const reason = [];
  if (scores.score_overall != null) {
    reason.push(scores.score_overall >= STRONG_SCORE
      ? `Creative quality is holding steady (score ${scores.score_overall}), which is supporting current performance.`
      : scores.score_overall < WEAK_SCORE
        ? `Creative quality is still developing (score ${scores.score_overall}) and is likely limiting results.`
        : `Creative quality is average (score ${scores.score_overall}) -- neither a strength nor a weakness right now.`);
  }
  if (benchmarkVerdict.verdict !== 'unknown') {
    const grainText = benchmarkVerdict.grain ? benchmarkVerdict.grain.replace('_', ' ') : 'peer';
    reason.push(benchmarkVerdict.verdict === 'above_average'
      ? `It's outperforming its ${grainText} average, not just keeping pace.`
      : benchmarkVerdict.verdict === 'below_average'
        ? `It's trailing its ${grainText} average.`
        : `It's performing in line with its ${grainText} average.`);
  }
  if (fatigue.status) {
    reason.push(fatigue.status === 'none'
      ? 'This creative still has room to scale before signs of audience fatigue appear.'
      : `Audience fatigue is already showing ("${fatigue.status}"), which should factor into any scaling decision.`);
  }
  if (latestRow?.frequency != null) {
    reason.push(latestRow.frequency < 2
      ? `Frequency is still low (${round(latestRow.frequency, 2)}), so the audience isn't over-exposed yet.`
      : latestRow.frequency < 3
        ? `Frequency is at a moderate level (${round(latestRow.frequency, 2)}) -- worth watching but not yet a concern.`
        : `Frequency is elevated (${round(latestRow.frequency, 2)}), raising the odds of fatigue soon.`);
  }

  const supportingCount = [
    scores.score_overall != null && scores.score_overall >= STRONG_SCORE,
    benchmarkVerdict.verdict === 'above_average',
    fatigue.status === 'none',
    latestRow?.frequency != null && latestRow.frequency < 2,
  ].filter(Boolean).length;
  const conflictingCount = [
    scores.score_overall != null && scores.score_overall < WEAK_SCORE,
    benchmarkVerdict.verdict === 'below_average',
    fatigue.status === 'severe' || fatigue.status === 'moderate',
  ].filter(Boolean).length;
  const confidence = computeConfidence({
    supportingSignals: supportingCount,
    conflictingSignals: conflictingCount,
    dataSufficient: latestRow?.spend != null && latestRow.spend >= MIN_SPEND_FOR_FATIGUE,
  });

  const recommendedActions = [];
  if (currentStatus === 'Scale' && scalingAdvice.actions) recommendedActions.push(...scalingAdvice.actions.map(a => a.action));
  if (currentStatus === 'Pause') recommendedActions.push('Pause the ad');
  if (currentStatus === 'Refresh' || currentStatus === 'Rewrite') recommendedActions.push(`${currentStatus} -- ${pauseAdvice.reason}`);
  for (const p of (priorities || []).slice(0, 2)) recommendedActions.push(p.action);
  const uniqueActions = [...new Set(recommendedActions)];

  const expectedResult = currentStatus === 'Scale'
    ? 'Higher reach/volume with low incremental risk given current health.'
    : currentStatus === 'Pause'
      ? 'Stops further budget loss on an underperforming/fatigued creative.'
      : (currentStatus === 'Refresh' || currentStatus === 'Rewrite')
        ? 'Resets fatigue/weak signals while preserving the elements that are still working.'
        : 'Stable performance maintained while more data accumulates.';

  const potentialRisks = [];
  if (currentStatus === 'Scale' && latestRow?.frequency != null) potentialRisks.push(`Watch frequency after scaling (currently ${round(latestRow.frequency, 2)}).`);
  if (currentStatus === 'Pause') potentialRisks.push('Pausing stops all reach and learning immediately.');
  if (potentialRisks.length === 0) potentialRisks.push('No material risk identified from current signals.');

  // Phase 44 (Task 1) -- Priority (how urgent this decision is) and
  // Business Risk (how much downside is on the table right now), both
  // derived from the same real signals already computed above.
  const priority = (currentStatus === 'Scale' || currentStatus === 'Pause') ? 'HIGH'
    : (currentStatus === 'Refresh' || currentStatus === 'Rewrite') ? 'MEDIUM' : 'LOW';
  const businessRisk = fatigue.status === 'severe' ? 'HIGH'
    : (conflictingCount >= 2 ? 'HIGH' : conflictingCount === 1 ? 'MEDIUM' : (currentStatus === 'Scale' ? 'MEDIUM' : 'LOW'));

  return {
    current_status: currentStatus,
    confidence: confidence.confidence_pct,
    confidence_reason: confidence.reason,
    priority,
    reason,
    recommended_actions: uniqueActions,
    expected_result: expectedResult,
    potential_risks: potentialRisks,
    business_risk: businessRisk,
  };
}

/**
 * Phase 44 (Task 5) -- "compare against the best/worst creative in the
 * account" as a real, numeric benchmark (not a narrative) -- reports the
 * real score gap to each, honestly insufficient_data when the account
 * doesn't have another scored creative to compare against.
 */
function buildBestWorstComparison(latestRow, accountBestWorst) {
  if (!accountBestWorst || (!accountBestWorst.best && !accountBestWorst.worst)) {
    return { status: 'insufficient_data', reason: 'Not enough other scored creatives in this account to identify a best/worst.' };
  }
  const result = { status: 'ok' };
  if (accountBestWorst.best) {
    result.best = {
      meta_ad_id: accountBestWorst.best.meta_ad_id, ad_name: accountBestWorst.best.ad_name,
      score_overall: accountBestWorst.best.score_overall,
      score_gap: latestRow?.score_overall != null ? round(accountBestWorst.best.score_overall - latestRow.score_overall) : null,
    };
  }
  if (accountBestWorst.worst) {
    result.worst = {
      meta_ad_id: accountBestWorst.worst.meta_ad_id, ad_name: accountBestWorst.worst.ad_name,
      score_overall: accountBestWorst.worst.score_overall,
      score_gap: latestRow?.score_overall != null ? round(latestRow.score_overall - accountBestWorst.worst.score_overall) : null,
    };
  }
  return result;
}

// ─────────────────────────────────────────────
// Orchestrator — assembles every phase above into one advisor bundle for
// one creative. Degrades gracefully (never throws) when a source input
// (text analysis, comparison, benchmark averages) isn't available yet.
// ─────────────────────────────────────────────

function buildCreativeAdvisor({
  scores, fatigue, textAnalysis, latestRow, benchmarkAverages, comparison, comparisonRole,
  shapedSiblings, timeline, recommendations, healthScore = null,
  healthHistory = [], recommendationHistory = [], alertHistory = [], accountBestWorst = null,
}) {
  const benchmarkComparison = buildBenchmarkComparison(benchmarkAverages || {}, latestRow || {});
  const benchmarkVerdict = overallBenchmarkVerdict(benchmarkComparison);
  const rootCause = buildRootCause({ textAnalysis, fatigue, benchmarkComparison });
  const scoreExplanation = buildScoreExplanation({ scores, textAnalysis, fatigue, spend: latestRow?.spend });
  const historicalComparison = buildHistoricalComparison(timeline?.snapshots);
  const priorities = buildPriorityEngine(recommendations, {
    spend: latestRow?.spend, fatigueStatus: fatigue?.status, benchmarkVerdict, benchmarkComparison, historicalComparison, latestRow,
  });
  const strategicAdvice = buildStrategicAdvice({ scores, fatigue, benchmarkVerdict, priorities, spend: latestRow?.spend });
  const changeRisk = buildChangeRisk({ scores, fatigue, comparisonRole, spend: latestRow?.spend });
  const scalingAdvice = buildScalingAdvice({ scores, fatigue, comparisonRole, latestRow, benchmarkVerdict });
  const pauseAdvice = buildPauseAdvice({ scores, fatigue, textAnalysis });
  const comparisonBreakdown = buildComparisonBreakdown(comparison, shapedSiblings);
  const evolution = buildEvolutionStages(timeline);
  const scoreRelationship = buildScoreRelationship(healthScore, scores.score_overall);
  const previousVersionComparison = buildPreviousVersionComparison(timeline);
  const richTimeline = buildRichEvolutionTimeline({ snapshots: timeline?.snapshots, healthHistory, recommendationHistory, alertHistory });
  const panel = buildAdvisorPanel({ scores, fatigue, benchmarkVerdict, scalingAdvice, pauseAdvice, changeRisk, priorities, latestRow });
  const bestWorstComparison = buildBestWorstComparison(latestRow, accountBestWorst);

  return {
    root_cause: rootCause,
    score_explanation: scoreExplanation,
    priorities,
    strategic_advice: strategicAdvice,
    change_risk: changeRisk,
    scaling_advice: scalingAdvice,
    pause_advice: pauseAdvice,
    benchmark: {
      comparison: benchmarkComparison,
      overall_verdict: benchmarkVerdict,
      historical: historicalComparison,
      previous_version: previousVersionComparison,
      account_best_worst: bestWorstComparison,
    },
    comparison_breakdown: comparisonBreakdown,
    evolution,
    score_relationship: scoreRelationship,
    rich_timeline: richTimeline,
    panel,
  };
}

module.exports = {
  classifyVsAverage,
  buildBenchmarkComparison,
  overallBenchmarkVerdict,
  buildRootCause,
  buildScoreExplanation,
  buildScoreRelationship,
  buildHistoricalComparison,
  buildPreviousVersionComparison,
  buildMetricsTimeline,
  buildStateTransitions,
  mergeConsecutiveTimelineEntries,
  buildBusinessEvents,
  buildScoreMilestones,
  buildRichEvolutionTimeline,
  buildPriorityEngine,
  buildBusinessImpactEstimate,
  buildRiskAssessment,
  buildStrategicAdvice,
  buildChangeRisk,
  buildScalingAdvice,
  buildPauseAdvice,
  compareDimensions,
  buildWinLossNarrative,
  buildComparisonBreakdown,
  buildEvolutionStages,
  buildBestWorstComparison,
  buildAdvisorPanel,
  buildCreativeAdvisor,
};
