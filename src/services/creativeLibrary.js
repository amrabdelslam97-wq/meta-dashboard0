/**
 * Creative Library / Timeline / Details — Creative Intelligence Engine
 * (Steps 8, 10, 11)
 *
 * Pure read-side aggregation over creative_analytics (already synced by
 * creativeAnalytics.js) plus the existing ads/ad_sets/campaigns tables and
 * creativeIntelligenceEngine.js's scoring/fatigue/comparison functions. No
 * new Meta API calls -- the one exception is getCreativeDetails(), which
 * reuses adIntelligence.runAdIntelligence() wholesale for the Rule
 * Engine/MAIFS/Diagnosis/Health bundle (a per-detail-view read, same
 * lazy-load convention adIntelligence.js itself already established for ad
 * previews -- never re-implemented here).
 */

const db = require('../db/database');
const { defaultRange } = require('./dateRangeHelper');
const { compareCreativesInAdSet, generateRecommendations } = require('./creativeIntelligenceEngine');
const { buildExecutiveSummary } = require('./executiveSummaryEngine');
const { runAdIntelligence } = require('./adIntelligence');

// ─────────────────────────────────────────────
// Step 8 — Creative Timeline (launch / peak / decline / fatigue / recovery / changes)
// ─────────────────────────────────────────────
const DECLINE_THRESHOLD_PCT = 15; // relative drop from peak score_overall
const RECOVERY_THRESHOLD_RATIO = 0.9; // recovered once back within 90% of peak
const CONTENT_CHANGE_FIELDS = ['headline', 'primary_text', 'cta_type', 'creative_type', 'destination_url'];

function getCreativeTimeline(metaAdId) {
  const rows = db.all(
    `SELECT * FROM creative_analytics WHERE meta_ad_id = ? ORDER BY date_since ASC`,
    [metaAdId]
  );

  if (rows.length === 0) return { status: 'no_data', events: [], snapshots: [] };
  if (rows.length === 1) {
    return {
      status: 'insufficient_data',
      events: [{ type: 'launch', date: rows[0].date_since, score_overall: rows[0].score_overall, fatigue_status: rows[0].fatigue_status }],
      snapshots: rows,
    };
  }

  const events = [{ type: 'launch', date: rows[0].date_since, score_overall: rows[0].score_overall, fatigue_status: rows[0].fatigue_status }];

  // Peak: the snapshot with the highest score_overall (first occurrence wins ties).
  let peakIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].score_overall == null) continue;
    if (peakIdx === -1 || rows[i].score_overall > rows[peakIdx].score_overall) peakIdx = i;
  }
  if (peakIdx !== -1) {
    events.push({ type: 'peak', date: rows[peakIdx].date_since, score_overall: rows[peakIdx].score_overall });
  }

  // Decline: first snapshot after the peak whose score_overall has dropped
  // >=DECLINE_THRESHOLD_PCT relative to the peak -- a real, computed
  // threshold against actually-stored scores, not a per-point derivative
  // (which would flag ordinary week-to-week noise as "decline").
  let declineIdx = -1;
  const peakScore = peakIdx !== -1 ? rows[peakIdx].score_overall : null;
  if (peakScore != null) {
    for (let i = peakIdx + 1; i < rows.length; i++) {
      if (rows[i].score_overall == null) continue;
      const dropPct = ((peakScore - rows[i].score_overall) / peakScore) * 100;
      if (dropPct >= DECLINE_THRESHOLD_PCT) { declineIdx = i; break; }
    }
  }
  if (declineIdx !== -1) {
    events.push({
      type: 'decline', date: rows[declineIdx].date_since, score_overall: rows[declineIdx].score_overall,
      drop_from_peak_pct: Math.round(((peakScore - rows[declineIdx].score_overall) / peakScore) * 1000) / 10,
    });
  }

  // Fatigue: first snapshot whose stored fatigue_status verdict (computed at
  // sync time by creativeAnalytics.js, per Step 5) reached moderate/severe.
  const fatigueIdx = rows.findIndex(r => r.fatigue_status === 'moderate' || r.fatigue_status === 'severe');
  if (fatigueIdx !== -1) {
    events.push({ type: 'fatigue', date: rows[fatigueIdx].date_since, fatigue_status: rows[fatigueIdx].fatigue_status, recommendation: rows[fatigueIdx].fatigue_recommendation });
  }

  // Recovery: after the worse of decline/fatigue, the first snapshot where
  // BOTH the score has recovered to within RECOVERY_THRESHOLD_RATIO of peak
  // AND fatigue_status is no longer moderate/severe -- requiring both avoids
  // calling a purely coincidental score bounce a real "recovery".
  const worstIdx = Math.max(declineIdx, fatigueIdx);
  if (worstIdx !== -1 && peakScore != null) {
    for (let i = worstIdx + 1; i < rows.length; i++) {
      const recoveredScore = rows[i].score_overall != null && rows[i].score_overall >= peakScore * RECOVERY_THRESHOLD_RATIO;
      const recoveredFatigue = rows[i].fatigue_status !== 'moderate' && rows[i].fatigue_status !== 'severe';
      if (recoveredScore && recoveredFatigue) {
        events.push({ type: 'recovery', date: rows[i].date_since, score_overall: rows[i].score_overall });
        break;
      }
    }
  }

  // Changes: real content diffs between consecutive snapshots -- a genuine
  // creative refresh event (headline/copy/CTA/type/destination actually
  // changed in Meta), not a metric fluctuation.
  for (let i = 1; i < rows.length; i++) {
    for (const field of CONTENT_CHANGE_FIELDS) {
      if (rows[i][field] !== rows[i - 1][field] && (rows[i][field] || rows[i - 1][field])) {
        events.push({ type: 'change', date: rows[i].date_since, field, from: rows[i - 1][field], to: rows[i][field] });
      }
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  return { status: 'ok', events, snapshots: rows };
}

// ─────────────────────────────────────────────
// Step 6/11 helper — shape one creative_analytics row for
// compareCreativesInAdSet(), which expects a `scores` sub-object.
// ─────────────────────────────────────────────
function toComparisonShape(row) {
  return {
    meta_ad_id: row.meta_ad_id,
    ad_name: row.ad_name || row.headline || row.meta_ad_id,
    cost_per_result: row.cpa,
    scores: {
      score_overall: row.score_overall, score_hook: row.score_hook, score_headline: row.score_headline,
      score_copy: row.score_copy, score_cta: row.score_cta, score_offer: row.score_offer,
      score_trust: row.score_trust, score_visual: row.score_visual,
    },
  };
}

// ─────────────────────────────────────────────
// Step 11 — Creative Library (search + filter)
// ─────────────────────────────────────────────
function searchCreativeLibrary(filters = {}) {
  const {
    account_id, campaign_id, adset_id, objective, creative_type,
    min_score, max_score, fatigue_status, is_winner, is_loser,
    search, date_since, date_until, platform, language,
  } = filters;

  const range = (date_since && date_until) ? { since: date_since, until: date_until } : defaultRange();

  // Meta's Insights API exposes no language breakdown at all (confirmed in
  // breakdownsFetcher.js's own header) -- honestly reported as unsupported
  // rather than silently ignored or fabricated.
  const warnings = [];
  if (language) {
    warnings.push('The "language" filter was not applied: Meta\'s Ads Insights API exposes no language breakdown for any entity grain, so this system has no real data to filter by.');
  }

  const conditions = ['ca.date_since = ?', 'ca.date_until = ?'];
  const params = [range.since, range.until];

  if (account_id) { conditions.push('ca.ad_account_id = ?'); params.push(account_id); }
  if (campaign_id) {
    const camp = db.get('SELECT meta_campaign_id FROM campaigns WHERE id = ? OR meta_campaign_id = ?', [campaign_id, campaign_id]);
    conditions.push('ca.meta_campaign_id = ?'); params.push(camp ? camp.meta_campaign_id : campaign_id);
  }
  if (adset_id) {
    const as = db.get('SELECT meta_adset_id FROM ad_sets WHERE id = ? OR meta_adset_id = ?', [adset_id, adset_id]);
    conditions.push('ca.meta_adset_id = ?'); params.push(as ? as.meta_adset_id : adset_id);
  }
  if (creative_type) { conditions.push('ca.creative_type = ?'); params.push(creative_type); }
  if (fatigue_status) { conditions.push('ca.fatigue_status = ?'); params.push(fatigue_status); }
  if (min_score != null) { conditions.push('ca.score_overall >= ?'); params.push(min_score); }
  if (max_score != null) { conditions.push('ca.score_overall <= ?'); params.push(max_score); }
  if (search) { conditions.push('(ca.headline LIKE ? OR ca.primary_text LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (objective) { conditions.push('c.objective = ?'); params.push(objective); }
  if (platform) {
    // Real, already-persisted publisher_platform breakdown data (Placement
    // Analytics, Phase 17) -- a campaign-grain join, since placement isn't
    // synced per-creative; never a fabricated per-creative platform field.
    conditions.push(`EXISTS (
      SELECT 1 FROM analytics_breakdown_history bh
      WHERE bh.entity_type = 'campaign' AND bh.entity_meta_id = ca.meta_campaign_id
        AND bh.breakdown_type = 'publisher_platform' AND bh.breakdown_value = ?
    )`);
    params.push(platform);
  }

  const rows = db.all(
    `SELECT ca.*, c.name as campaign_name, c.objective as campaign_objective,
            s.name as adset_name, a.status as ad_status, a.name as ad_name
     FROM creative_analytics ca
     LEFT JOIN campaigns c ON c.meta_campaign_id = ca.meta_campaign_id
     LEFT JOIN ad_sets s ON s.meta_adset_id = ca.meta_adset_id
     LEFT JOIN ads a ON a.meta_ad_id = ca.meta_ad_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY (ca.score_overall IS NULL), ca.score_overall DESC, ca.spend DESC`,
    params
  );

  // Winner/loser (Step 6/11): computed per ad set, reusing
  // creativeIntelligenceEngine.compareCreativesInAdSet() -- never a second
  // ranking implementation.
  const byAdset = new Map();
  for (const row of rows) {
    const key = row.meta_adset_id || `_no_adset_${row.meta_ad_id}`;
    if (!byAdset.has(key)) byAdset.set(key, []);
    byAdset.get(key).push(row);
  }
  const roleByAdId = new Map();
  for (const group of byAdset.values()) {
    const comparison = compareCreativesInAdSet(group.map(toComparisonShape));
    if (comparison.winner) roleByAdId.set(comparison.winner.meta_ad_id, 'winner');
    if (comparison.worst) roleByAdId.set(comparison.worst.meta_ad_id, 'loser');
  }

  let creatives = rows.map(r => ({ ...r, is_dynamic_creative: !!r.is_dynamic_creative, library_role: roleByAdId.get(r.meta_ad_id) || null }));

  if (is_winner) creatives = creatives.filter(r => r.library_role === 'winner');
  if (is_loser) creatives = creatives.filter(r => r.library_role === 'loser');

  return { date_range: range, total: creatives.length, warnings, creatives };
}

// ─────────────────────────────────────────────
// Step 6 (standalone) — Ad Set Creative Comparison. The same comparison
// getCreativeDetails() computes for one ad's own siblings, exposed directly
// for a whole-ad-set view (e.g. the Ranking chart, Step 9).
// ─────────────────────────────────────────────
function getAdSetComparison(metaAdsetId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT ca.*, a.name as ad_name FROM creative_analytics ca
     LEFT JOIN ads a ON a.meta_ad_id = ca.meta_ad_id
     WHERE ca.meta_adset_id = ? AND ca.date_since = ? AND ca.date_until = ?`,
    [metaAdsetId, dateRange.since, dateRange.until]
  );
  return { date_range: dateRange, ...compareCreativesInAdSet(rows.map(toComparisonShape)) };
}

// ─────────────────────────────────────────────
// Step 10 — Creative Details Page
// ─────────────────────────────────────────────
async function getCreativeDetails(adIdOrMetaAdId, options = {}) {
  const { useMock = false } = options;

  const ad = db.get(`SELECT id, meta_ad_id FROM ads WHERE id = ? OR meta_ad_id = ?`, [adIdOrMetaAdId, adIdOrMetaAdId]);
  if (!ad) return null;

  const latest = db.get(
    `SELECT * FROM creative_analytics WHERE meta_ad_id = ? ORDER BY date_until DESC LIMIT 1`,
    [ad.meta_ad_id]
  );
  if (!latest) {
    return {
      meta_ad_id: ad.meta_ad_id, analyzed: false,
      reason: 'No creative_analytics snapshot yet for this ad -- run a Creative Analytics sync for this account first.',
    };
  }

  const timeline = getCreativeTimeline(ad.meta_ad_id);

  // Step 6 — comparison against siblings in the same ad set, same date range.
  let comparison = { winner: null, runner_up: null, worst: null, ranking: [], comparisons: [] };
  let role = { isWinner: false, isWorst: false };
  if (latest.meta_adset_id) {
    const siblings = db.all(
      `SELECT * FROM creative_analytics WHERE meta_adset_id = ? AND date_since = ? AND date_until = ?`,
      [latest.meta_adset_id, latest.date_since, latest.date_until]
    );
    comparison = compareCreativesInAdSet(siblings.map(toComparisonShape));
    role = {
      isWinner: comparison.winner?.meta_ad_id === ad.meta_ad_id,
      isWorst: comparison.worst?.meta_ad_id === ad.meta_ad_id,
    };
  }

  let aiAnalysis = null;
  try {
    aiAnalysis = latest.ai_analysis_json ? JSON.parse(latest.ai_analysis_json) : null;
  } catch {
    aiAnalysis = null;
  }

  const scores = {
    score_hook: latest.score_hook, score_headline: latest.score_headline, score_copy: latest.score_copy,
    score_visual: latest.score_visual, score_cta: latest.score_cta, score_offer: latest.score_offer,
    score_trust: latest.score_trust, score_psychology: latest.score_psychology,
    score_conversion_potential: latest.score_conversion_potential, score_scroll_stop: latest.score_scroll_stop,
    score_retention: latest.score_retention, score_brand: latest.score_brand,
    score_fatigue: latest.score_fatigue, score_overall: latest.score_overall,
  };
  const fatigue = { status: latest.fatigue_status, recommendation: latest.fatigue_recommendation };
  // generateRecommendations() reads scored.text_analysis (computeCreativeScore()'s
  // own output shape) -- ai_analysis_json IS that exact object, persisted
  // verbatim by creativeAnalytics.js at sync time. A snapshot synced before
  // this field existed (or a parse failure) degrades to no text-based
  // recommendations rather than throwing.
  const recommendations = aiAnalysis
    ? generateRecommendations({ ...scores, raw_spend: latest.spend, text_analysis: aiAnalysis }, fatigue, role)
    : [];

  // Step 10's explicit "Rule Engine Results, MAIFS, Executive Summary"
  // requirement -- reuses adIntelligence.js's existing per-ad pipeline
  // wholesale (Health/Diagnosis/Rule Engine/MAIFS), never re-implemented.
  const intelligence = await runAdIntelligence(ad.id, { useMock });

  const executiveSummary = intelligence && intelligence.analyzed !== false
    ? buildExecutiveSummary({
        objective: intelligence.objective,
        healthScore: intelligence.health_score,
        healthStatus: intelligence.health_status,
        diagnosis: intelligence.diagnosis,
        ruleEngineDecisions: [],
        recommendations: intelligence.recommendations,
        alerts: intelligence.alerts,
      })
    : null;

  return {
    meta_ad_id: ad.meta_ad_id,
    analyzed: true,
    snapshot: latest,
    ai_analysis: aiAnalysis,
    scores,
    fatigue,
    timeline,
    comparison,
    recommendations,
    intelligence,
    executive_summary: executiveSummary,
  };
}

module.exports = {
  getCreativeTimeline,
  searchCreativeLibrary,
  getAdSetComparison,
  getCreativeDetails,
};
