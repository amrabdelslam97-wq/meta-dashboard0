/**
 * Creative Intelligence Engine — Steps 4-7
 *
 * Creative Score (0-100, 14 sub-dimensions), Fatigue Detection (trend-based
 * on real historical creative_analytics rows), Creative Comparison
 * (winner/runner-up/worst with explicit WHY, not just a ranking), and AI
 * Recommendations (actionable text). Pure logic -- no DB access, no Meta API
 * calls; takes already-fetched/persisted rows in (creativeAnalytics.js owns
 * fetching+persistence; this module only computes on top of it), matching
 * the pure-logic pattern established by diagnosisEngine.js/analyticsInsight.js.
 */

const { analyzeCreative } = require('./creativeTextAnalysis');

// Minimum spend before a fatigue verdict or score is treated as reliable --
// mirrors diagnosisEngine.js's own MIN_IMPRESSIONS_FOR_DIAGNOSIS reasoning
// (don't diagnose on noise).
const MIN_SPEND_FOR_FATIGUE = 20;
// A metric must move by at least this percentage between consecutive
// snapshots to count as a real trend signal, not day-to-day noise --
// matches diagnosisEngine.js's own SIGNAL_THRESHOLD_PCT value/reasoning exactly.
const FATIGUE_SIGNAL_THRESHOLD_PCT = 10;

function round(n, dp = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

function pctChange(current, prior) {
  if (current == null || prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

// ─────────────────────────────────────────────
// Step 4 — Creative Score
// ─────────────────────────────────────────────

/**
 * @param {object} creative - a creative_analytics row (already has spend/
 *   ctr/results/video metrics/hold_rate/drop_off_pct persisted by
 *   creativeAnalytics.js) plus headline/primary_text/description/cta_type.
 * @param {object} [fatigueResult] - detectFatigue()'s output, if already
 *   computed (avoids re-deriving fatigue score twice).
 */
function computeCreativeScore(creative, fatigueResult = null) {
  const text = analyzeCreative(creative);

  // Conversion Potential -- performance-derived, not text-derived: does
  // this creative actually convert once seen? Uses real ctr/cost metrics
  // when available, capped so a creative with zero data doesn't score 0
  // (that would conflate "no data" with "bad creative").
  let conversionPotential = null;
  if (creative.spend > 0 && creative.results != null) {
    const hasResults = creative.results > 0;
    const ctrScore = creative.ctr != null ? Math.min(100, (creative.ctr / 3) * 100) : 50; // 3% CTR ~ ceiling
    conversionPotential = hasResults ? Math.min(100, ctrScore * 0.5 + 50) : ctrScore * 0.6;
  }

  // Scroll Stop Power -- real thumb-stop signal: video hook retention
  // (video_p25_pct) if video, else CTR-based proxy for static/carousel.
  let scrollStop;
  if (creative.video_p25_pct != null) {
    scrollStop = Math.min(100, creative.video_p25_pct * 1.2);
  } else if (creative.thumb_stop_rate != null) {
    scrollStop = Math.min(100, creative.thumb_stop_rate * 20);
  } else {
    scrollStop = text.hook.score; // fall back to the text-hook proxy when no real thumb-stop data exists
  }

  // Retention -- real video hold-rate/drop-off when available; otherwise
  // not applicable (never fabricated for a static image).
  let retention = null;
  if (creative.hold_rate != null) {
    retention = creative.hold_rate;
  } else if (creative.video_p100_pct != null) {
    retention = creative.video_p100_pct;
  }

  const fatigueScore = fatigueResult
    ? { none: 100, early: 70, moderate: 40, severe: 10 }[fatigueResult.status] ?? 50
    : null;

  const scores = {
    score_hook: text.hook.score,
    score_headline: text.headline.score,
    score_copy: text.copy.score,
    score_visual: text.visual.score,
    score_cta: text.cta.score,
    score_offer: text.offer.score,
    score_trust: text.trust.score,
    score_psychology: text.psychology.score,
    score_conversion_potential: conversionPotential !== null ? round(conversionPotential) : null,
    score_scroll_stop: round(scrollStop),
    score_retention: retention !== null ? round(retention) : null,
    score_brand: null, // not available -- see creativeTextAnalysis.js's brand_consistency
    score_fatigue: fatigueScore,
  };

  const numericScores = Object.values(scores).filter(v => v !== null && v !== undefined);
  const overall = numericScores.length > 0
    ? round(numericScores.reduce((s, v) => s + v, 0) / numericScores.length)
    : null;

  return { ...scores, score_overall: overall, text_analysis: text };
}

// ─────────────────────────────────────────────
// Step 5 — Creative Fatigue Detection
// ─────────────────────────────────────────────

/**
 * @param {object[]} historyRows - creative_analytics rows for ONE ad,
 *   ordered by date_since ASCENDING (oldest first). Needs at least 2 rows
 *   with real spend to detect a trend; fewer returns status:'insufficient_data'.
 */
function detectFatigue(historyRows) {
  const eligible = (historyRows || []).filter(r => (r.spend || 0) >= MIN_SPEND_FOR_FATIGUE);
  if (eligible.length < 2) {
    return {
      status: 'insufficient_data',
      recommendation: null,
      signals: [],
      evidence: `Only ${eligible.length} snapshot(s) with >= ${MIN_SPEND_FOR_FATIGUE} spend -- need at least 2 to detect a trend.`,
    };
  }

  const latest = eligible[eligible.length - 1];
  const previous = eligible[eligible.length - 2];

  const freqChange = pctChange(latest.frequency, previous.frequency);
  const ctrChange = pctChange(latest.ctr, previous.ctr);
  const cpcChange = pctChange(latest.cpc, previous.cpc);
  const cpmChange = pctChange(latest.cpm, previous.cpm);
  const convChange = pctChange(latest.conversion_rate, previous.conversion_rate);

  const signals = [];
  if (freqChange !== null && freqChange >= FATIGUE_SIGNAL_THRESHOLD_PCT) signals.push({ signal: 'increasing_frequency', detail: `Frequency rose ${round(freqChange)}%` });
  if (ctrChange !== null && ctrChange <= -FATIGUE_SIGNAL_THRESHOLD_PCT) signals.push({ signal: 'ctr_decline', detail: `CTR fell ${round(Math.abs(ctrChange))}%` });
  if (cpcChange !== null && cpcChange >= FATIGUE_SIGNAL_THRESHOLD_PCT) signals.push({ signal: 'rising_cpc', detail: `CPC rose ${round(cpcChange)}%` });
  if (cpmChange !== null && cpmChange >= FATIGUE_SIGNAL_THRESHOLD_PCT) signals.push({ signal: 'rising_cpm', detail: `CPM rose ${round(cpmChange)}%` });
  if (convChange !== null && convChange <= -FATIGUE_SIGNAL_THRESHOLD_PCT) signals.push({ signal: 'falling_conversion', detail: `Conversion rate fell ${round(Math.abs(convChange))}%` });
  // Audience saturation proxy: frequency rising while reach stays flat --
  // same signature diagnosisEngine.js/MF4.15.3 use for "Frequency Fatigue".
  const reachChange = pctChange(latest.reach, previous.reach);
  if (freqChange !== null && freqChange >= FATIGUE_SIGNAL_THRESHOLD_PCT && reachChange !== null && Math.abs(reachChange) < 5) {
    signals.push({ signal: 'audience_saturation', detail: 'Frequency rising while reach is flat -- the same audience is being shown this creative repeatedly.' });
  }

  let status;
  if (signals.length >= 4) status = 'severe';
  else if (signals.length === 3) status = 'moderate';
  else if (signals.length >= 1) status = 'early';
  else status = 'none';

  return {
    status,
    recommendation: recommendFromFatigue(status, latest),
    signals,
    evidence: signals.length ? signals.map(s => s.detail).join('; ') : 'No fatigue signals detected between the two most recent snapshots.',
    latest_snapshot: { date_since: latest.date_since, date_until: latest.date_until },
  };
}

/** Maps fatigue status + current performance into exactly one of the four spec'd recommendations: Duplicate, Refresh, Pause, Scale. */
function recommendFromFatigue(status, latest) {
  if (status === 'severe') return 'pause';
  if (status === 'moderate') return 'refresh';
  if (status === 'early') return 'refresh';
  // status === 'none' -- creative is healthy; distinguish a strong performer
  // worth scaling from one worth duplicating (testing variations while fresh).
  const efficient = latest.cost_per_result || latest.cpa;
  if (latest.results > 0 && efficient != null) return 'scale';
  return 'duplicate';
}

// ─────────────────────────────────────────────
// Step 6 — Creative Comparison (winner / runner-up / worst, WITH why)
// ─────────────────────────────────────────────

/**
 * @param {object[]} creatives - array of { meta_ad_id, ad_name, ...creative_analytics row, scores: computeCreativeScore() output }
 *   for every ad in ONE ad set, same date range.
 */
function compareCreativesInAdSet(creatives) {
  const ranked = creatives
    .filter(c => c.scores && c.scores.score_overall !== null)
    .sort((a, b) => b.scores.score_overall - a.scores.score_overall);

  if (ranked.length === 0) {
    return { winner: null, runner_up: null, worst: null, ranking: [], comparisons: [] };
  }

  const winner = ranked[0];
  const runnerUp = ranked.length > 1 ? ranked[1] : null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  const explainDiff = (a, b) => {
    if (!a || !b || a === b) return [];
    const reasons = [];
    const dims = [
      ['score_hook', 'hook'], ['score_headline', 'headline'], ['score_copy', 'copy quality'],
      ['score_cta', 'CTA strength'], ['score_offer', 'offer clarity'], ['score_trust', 'trust/social proof'],
      ['score_visual', 'visual metadata fit'],
    ];
    for (const [key, label] of dims) {
      const diff = (a.scores[key] ?? 0) - (b.scores[key] ?? 0);
      if (Math.abs(diff) >= 20) {
        reasons.push(`${diff > 0 ? 'stronger' : 'weaker'} ${label} (${a.scores[key]} vs ${b.scores[key]})`);
      }
    }
    if (a.cost_per_result != null && b.cost_per_result != null && b.cost_per_result > 0) {
      const costDiffPct = round(((a.cost_per_result - b.cost_per_result) / b.cost_per_result) * 100);
      if (Math.abs(costDiffPct) >= 15) {
        reasons.push(`${costDiffPct < 0 ? 'lower' : 'higher'} cost per result (${a.cost_per_result} vs ${b.cost_per_result}, ${costDiffPct}%)`);
      }
    }
    return reasons;
  };

  const comparisons = [];
  if (worst && worst !== winner) {
    const reasons = explainDiff(winner, worst);
    comparisons.push({
      winner_ad_id: winner.meta_ad_id, worst_ad_id: worst.meta_ad_id,
      why: reasons.length ? reasons : ['Overall score differs, but no single dimension crossed the explanation threshold -- the gap is a blend of smaller factors.'],
    });
  }

  return {
    winner: { meta_ad_id: winner.meta_ad_id, ad_name: winner.ad_name, score: winner.scores.score_overall },
    runner_up: runnerUp ? { meta_ad_id: runnerUp.meta_ad_id, ad_name: runnerUp.ad_name, score: runnerUp.scores.score_overall } : null,
    worst: worst ? { meta_ad_id: worst.meta_ad_id, ad_name: worst.ad_name, score: worst.scores.score_overall } : null,
    ranking: ranked.map((c, i) => ({ rank: i + 1, meta_ad_id: c.meta_ad_id, ad_name: c.ad_name, score: c.scores.score_overall })),
    comparisons,
  };
}

// ─────────────────────────────────────────────
// Step 7 — AI Recommendations
// ─────────────────────────────────────────────

const WEAK_THRESHOLD = 50;

/**
 * @param {object} scored - computeCreativeScore() output
 * @param {object} fatigue - detectFatigue() output
 * @param {object} [comparisonRole] - { isWinner, isWorst } if this creative
 *   was ranked in an ad-set comparison (Step 6)
 */
function generateRecommendations(scored, fatigue, comparisonRole = {}) {
  const recs = [];
  const text = scored.text_analysis;

  if (scored.score_hook < WEAK_THRESHOLD) {
    recs.push({ action: 'Rewrite Hook', reason: text.hook.evidence, priority: scored.score_hook < 25 ? 'high' : 'medium' });
  }
  if (scored.score_headline < WEAK_THRESHOLD) {
    recs.push({ action: text.headline.evidence.includes('too long') ? 'Shorten Copy' : 'Rewrite Hook', reason: text.headline.evidence, priority: 'medium' });
  }
  if (text.copy.length_category === 'long') {
    recs.push({ action: 'Shorten Copy', reason: text.copy.evidence, priority: 'medium' });
  }
  if (scored.score_cta < WEAK_THRESHOLD) {
    recs.push({ action: 'Improve CTA', reason: text.cta.evidence, priority: 'medium' });
  }
  if (scored.score_trust < 40) {
    recs.push({ action: 'Add Social Proof', reason: 'No trust or social-proof language detected in the copy.', priority: 'low' });
  }
  if (scored.score_offer < WEAK_THRESHOLD) {
    recs.push({ action: 'Use Better Offer', reason: text.offer.evidence, priority: 'medium' });
  }
  if (scored.score_visual < WEAK_THRESHOLD) {
    recs.push({ action: 'Replace Thumbnail', reason: `${text.visual.evidence} (metadata-based signal, not a pixel-content judgment)`, priority: 'low' });
  }
  if (text.copy.word_count > 40 && text.psychology.score < 40) {
    recs.push({ action: 'Reduce Text', reason: 'Long copy with little urgency/curiosity/benefit framing -- likely to lose readers before the message lands.', priority: 'low' });
  }

  if (fatigue) {
    if (fatigue.status === 'severe') {
      recs.push({ action: 'Pause', reason: `Severe fatigue: ${fatigue.evidence}`, priority: 'high' });
    } else if (fatigue.status === 'moderate' || fatigue.status === 'early') {
      recs.push({ action: 'Refresh', reason: `${fatigue.status === 'moderate' ? 'Moderate' : 'Early'} fatigue signals: ${fatigue.evidence}`, priority: fatigue.status === 'moderate' ? 'high' : 'medium' });
    } else if (fatigue.status === 'none' && scored.score_overall >= 70) {
      recs.push({ action: 'Scale', reason: 'No fatigue signals and a strong overall creative score -- a good candidate for increased budget.', priority: 'medium' });
    }
  }

  if (comparisonRole.isWinner) {
    recs.push({ action: 'Duplicate Winner', reason: 'This creative is the top performer in its ad set -- duplicate it to test new variations while it is still working.', priority: 'medium' });
  }
  if (comparisonRole.isWorst) {
    recs.push({ action: 'Pause Loser', reason: 'This creative is the weakest performer in its ad set.', priority: 'medium' });
  }

  if ((scored.raw_spend ?? 0) < MIN_SPEND_FOR_FATIGUE) {
    recs.push({ action: 'Split Test', reason: 'Not enough spend yet for a reliable verdict -- keep testing before making a scale/pause decision.', priority: 'low' });
  }

  return recs;
}

module.exports = {
  computeCreativeScore,
  detectFatigue,
  compareCreativesInAdSet,
  generateRecommendations,
  MIN_SPEND_FOR_FATIGUE,
  FATIGUE_SIGNAL_THRESHOLD_PCT,
};
