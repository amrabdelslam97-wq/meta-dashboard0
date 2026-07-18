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
const { compareCreativesInAdSet, generateRecommendations, detectFatigue } = require('./creativeIntelligenceEngine');
const { buildExecutiveSummary } = require('./executiveSummaryEngine');
const { runAdIntelligence } = require('./adIntelligence');
const { buildCreativeAdvisor } = require('./advisorEngine');
const { buildRootCauseReasoning } = require('./executiveReasoningEngine');
const { buildExecutiveDecisionLayer } = require('./executiveDecisionEngine');
const { loadActiveRecommendations } = require('./recommendationEngine');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ─────────────────────────────────────────────
// Phase 42 — real peer-average benchmarks (ad set / campaign / account grain)
// for the AI Marketing Advisor's benchmarking phase. Excludes the creative
// itself, restricted to the SAME date range so it's an apples-to-apples
// comparison, and requires >= $5 spend (matching scoreCreative()'s own
// reliability floor) -- reports insufficient_data honestly rather than
// averaging over a near-empty or noisy peer set.
// ─────────────────────────────────────────────
const BENCHMARK_MIN_SAMPLE = 2;

function getCreativeBenchmarkAverages(latestRow) {
  const grains = [
    { level: 'ad_set', column: 'meta_adset_id', value: latestRow.meta_adset_id },
    { level: 'campaign', column: 'meta_campaign_id', value: latestRow.meta_campaign_id },
    { level: 'account', column: 'ad_account_id', value: latestRow.ad_account_id },
  ];

  const result = {};
  for (const grain of grains) {
    if (!grain.value) {
      result[grain.level] = { status: 'not_applicable', sample_size: 0, reason: `No ${grain.level.replace('_', ' ')} on this creative.` };
      continue;
    }
    const row = db.get(
      `SELECT AVG(ctr) as avg_ctr, AVG(cpa) as avg_cpa, AVG(cpm) as avg_cpm,
              AVG(frequency) as avg_frequency, AVG(roas) as avg_roas,
              AVG(score_overall) as avg_score, COUNT(*) as n
       FROM creative_analytics
       WHERE ${grain.column} = ? AND meta_ad_id != ? AND date_since = ? AND date_until = ? AND spend >= 5`,
      [grain.value, latestRow.meta_ad_id, latestRow.date_since, latestRow.date_until]
    );
    if (!row || row.n < BENCHMARK_MIN_SAMPLE) {
      result[grain.level] = {
        status: 'insufficient_data', sample_size: row ? row.n : 0,
        reason: `Fewer than ${BENCHMARK_MIN_SAMPLE} other creatives at the ${grain.level.replace('_', ' ')} grain with >= $5 spend in this date range.`,
      };
      continue;
    }
    result[grain.level] = {
      status: 'ok',
      sample_size: row.n,
      averages: {
        ctr: round(row.avg_ctr, 2), cpa: round(row.avg_cpa, 2), cpm: round(row.avg_cpm, 2),
        frequency: round(row.avg_frequency, 2), roas: round(row.avg_roas, 2), score_overall: round(row.avg_score, 1),
      },
    };
  }
  return result;
}

// ─────────────────────────────────────────────
// Phase 43 (Task 6) — this ad's own real, already-persisted health score /
// recommendation / alert history (health_score_history, recommendation_log,
// active_alerts -- all Phase 2 tables, entity_type='ad' rows written by the
// existing orchestrator, no new table). Read-only, no new writes.
// ─────────────────────────────────────────────
function getCreativeStateHistory(metaAdId) {
  const healthHistory = db.all(
    `SELECT health_score, health_status, calculated_at FROM health_score_history
     WHERE entity_type = 'ad' AND entity_meta_id = ? ORDER BY calculated_at ASC`,
    [metaAdId]
  );
  const recommendationHistory = db.all(
    `SELECT rule_code, recommendation_title, severity, generated_at, dismissed_at FROM recommendation_log
     WHERE entity_type = 'ad' AND entity_meta_id = ? ORDER BY generated_at ASC`,
    [metaAdId]
  );
  const alertHistory = db.all(
    `SELECT alert_code, severity, alert_message, status, first_detected_at, resolved_at FROM active_alerts
     WHERE entity_type = 'ad' AND entity_meta_id = ? ORDER BY first_detected_at ASC`,
    [metaAdId]
  );
  return { healthHistory, recommendationHistory, alertHistory };
}

// ─────────────────────────────────────────────
// Phase 44 (Task 5) — best/worst scored creative in the account (latest
// snapshot per ad, >= $5 spend, excluding this ad itself). Real read, no
// fabricated "industry" comparison.
// ─────────────────────────────────────────────
function getAccountBestWorstCreative(adAccountId, excludeMetaAdId) {
  if (!adAccountId) return { best: null, worst: null };
  const rows = db.all(
    `SELECT ca.meta_ad_id, ca.score_overall, a.name as ad_name FROM creative_analytics ca
     LEFT JOIN ads a ON a.meta_ad_id = ca.meta_ad_id
     INNER JOIN (
       SELECT meta_ad_id, MAX(date_until) as max_until FROM creative_analytics
       WHERE ad_account_id = ? GROUP BY meta_ad_id
     ) latest ON latest.meta_ad_id = ca.meta_ad_id AND latest.max_until = ca.date_until
     WHERE ca.ad_account_id = ? AND ca.spend >= 5 AND ca.score_overall IS NOT NULL AND ca.meta_ad_id != ?
     ORDER BY ca.score_overall DESC`,
    [adAccountId, adAccountId, excludeMetaAdId || '']
  );
  if (rows.length === 0) return { best: null, worst: null };
  return { best: rows[0], worst: rows[rows.length - 1] };
}

// ─────────────────────────────────────────────
// Phase 45 (Task 13) — real, already-persisted Budget Intelligence
// (budget_analysis_history) and Audience Intelligence (audience_score_
// history) signals for this ad's campaign, so the Executive Decision Engine
// can cross-check against them. Both are single, cheap indexed lookups
// (same query shape as every other Phase 42-44 benchmark read in this
// file) -- absence of a row is reported as `null`, never fabricated.
// ─────────────────────────────────────────────
function getCrossModuleSignals(adAccountId, metaCampaignId) {
  if (!metaCampaignId) return { budget: null, audience: null };

  const budgetRow = db.get(
    `SELECT waste_detected, waste_amount, efficiency_status FROM budget_analysis_history
     WHERE ad_account_id = ? AND level = 'campaign' AND entity_meta_id = ?
     ORDER BY calculated_at DESC LIMIT 1`,
    [adAccountId, metaCampaignId]
  );

  // Real average saturation across this campaign's most recently-scored
  // audience dimensions (age/gender/region/placement etc.) -- not a single
  // dimension cherry-picked, and not fabricated when no row exists yet.
  const audienceRow = db.get(
    `SELECT AVG(saturation_score) as avg_saturation, COUNT(*) as n FROM audience_score_history
     WHERE ad_account_id = ? AND meta_campaign_id = ? AND saturation_score IS NOT NULL
     AND date_until = (SELECT MAX(date_until) FROM audience_score_history WHERE ad_account_id = ? AND meta_campaign_id = ?)`,
    [adAccountId, metaCampaignId, adAccountId, metaCampaignId]
  );

  return {
    budget: budgetRow ? { waste_detected: !!budgetRow.waste_detected, waste_amount: budgetRow.waste_amount, efficiency_status: budgetRow.efficiency_status } : null,
    audience: (audienceRow && audienceRow.n > 0) ? { saturation_score: round(audienceRow.avg_saturation, 1) } : null,
  };
}

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
    // Phase 44 (Task 6) -- real CTR/frequency/fatigue fields alongside the
    // sub-scores, so advisorEngine.buildWinLossNarrative() can cite real
    // metrics ("CTR is 26% higher") on top of the score-dimension diffs.
    ctr: row.ctr, frequency: row.frequency, fatigue_status: row.fatigue_status,
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

  const ad = db.get(`SELECT id, meta_ad_id, name FROM ads WHERE id = ? OR meta_ad_id = ?`, [adIdOrMetaAdId, adIdOrMetaAdId]);
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
  let shapedSiblings = [];
  if (latest.meta_adset_id) {
    const siblings = db.all(
      `SELECT * FROM creative_analytics WHERE meta_adset_id = ? AND date_since = ? AND date_until = ?`,
      [latest.meta_adset_id, latest.date_since, latest.date_until]
    );
    shapedSiblings = siblings.map(toComparisonShape);
    comparison = compareCreativesInAdSet(shapedSiblings);
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
  // Phase 41 (Step 8): recomputed LIVE from this ad's real snapshot history
  // (timeline.snapshots, already fetched above -- no extra query) rather
  // than trusting the two bare fatigue_status/fatigue_recommendation DB
  // columns. Those columns never carried the real evidence/requirements
  // detectFatigue() computes -- it was calculated once at sync time and
  // silently discarded, so "insufficient_data" always read as an
  // unexplained label with no way to show what's actually missing.
  // Recomputing live also means older, already-persisted snapshots get the
  // richer explanation immediately, without waiting for a re-sync.
  const fatigue = detectFatigue(timeline.snapshots || []);
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

  // Phase 43 (Task 1) — cross-signal root-cause reasoning for the one case
  // diagnosisEngine.js's own cascade can't explain (category==='unexplained').
  // Every input here is already computed above (creative score, live-
  // recomputed fatigue) or already on the intelligence bundle (frequency via
  // the raw metrics, CTR delta) -- no new calculation, just wiring real
  // signals diagnosisEngine.js itself never sees into the existing summary.
  const rootCauseReasoning = (intelligence && intelligence.analyzed !== false)
    ? buildRootCauseReasoning({
        diagnosis: intelligence.diagnosis,
        crossSignals: {
          creativeScore: scores.score_overall,
          fatigueStatus: fatigue.status,
          frequency: latest.frequency ?? intelligence.metrics?.frequency ?? null,
          ctrDeltaPct: intelligence.deltas?.ctr?.delta_pct ?? null,
        },
      })
    : null;

  const executiveSummary = intelligence && intelligence.analyzed !== false
    ? buildExecutiveSummary({
        objective: intelligence.objective,
        healthScore: intelligence.health_score,
        healthStatus: intelligence.health_status,
        diagnosis: intelligence.diagnosis,
        ruleEngineDecisions: [],
        recommendations: intelligence.recommendations,
        alerts: intelligence.alerts,
        rootCauseReasoning,
      })
    : null;

  // Phase 42 — AI Marketing Advisor (Decision Intelligence). Pure synthesis
  // over everything already computed above (scores/fatigue/text analysis/
  // comparison/timeline) plus real peer-average benchmarks -- no new score,
  // no rewrite of any existing engine. See advisorEngine.js's own header.
  // Phase 43 additionally wires in the real health score (Task 2) and this
  // ad's real persisted health/recommendation/alert history (Task 6) --
  // both already-existing tables, no schema change, no fabricated events.
  const benchmarkAverages = getCreativeBenchmarkAverages(latest);
  const { healthHistory, recommendationHistory, alertHistory } = getCreativeStateHistory(ad.meta_ad_id);
  const accountBestWorst = getAccountBestWorstCreative(latest.ad_account_id, ad.meta_ad_id);
  const advisor = buildCreativeAdvisor({
    scores, fatigue, textAnalysis: aiAnalysis, latestRow: latest, benchmarkAverages,
    comparison, comparisonRole: role, shapedSiblings, timeline, recommendations,
    healthScore: intelligence && intelligence.analyzed !== false ? intelligence.health_score : null,
    healthHistory, recommendationHistory, alertHistory, accountBestWorst,
  });

  // Phase 45 — Executive Decision Layer. The single arbitration point over
  // everything already computed above (advisor panel, priorities, root
  // cause, benchmark, plus the real Rule Engine findings already on
  // `intelligence`) -- never a second, competing verdict; see
  // executiveDecisionEngine.js's own header for the conflict-resolution rule.
  // Dashboard Normalization (Phase 46) -- also passes this ad's campaign's
  // real, currently-active DB-rule-driven recommendations (recommendationEngine.js's
  // loadActiveRecommendations(), already exported and used by the /recommendations
  // route -- reused as-is, no new query) so the arbitration is aware of them too.
  const crossModuleSignals = getCrossModuleSignals(latest.ad_account_id, latest.meta_campaign_id);
  const recommendationLogRows = latest.meta_campaign_id ? loadActiveRecommendations(latest.meta_campaign_id) : [];
  const executiveDecision = buildExecutiveDecisionLayer({
    panel: advisor.panel,
    priorities: advisor.priorities,
    fatigue,
    scores,
    healthStatus: intelligence && intelligence.analyzed !== false ? intelligence.health_status : null,
    ruleEngineFindings: (intelligence && intelligence.analyzed !== false) ? (intelligence.framework_recommendations || []) : [],
    benchmarkVerdict: advisor.benchmark.overall_verdict,
    benchmarkComparison: advisor.benchmark.comparison,
    historicalComparison: advisor.benchmark.historical,
    rootCause: advisor.root_cause,
    latestRow: latest,
    crossModuleSignals,
    recommendationLogRows,
  });

  return {
    meta_ad_id: ad.meta_ad_id,
    analyzed: true,
    // ad_name is the ad's own Meta name (always set) -- a fallback for
    // creatives where headline is genuinely absent (e.g. a boosted Page
    // post has no headline field in Meta at all), matching the same
    // headline-or-ad_name fallback the Creative Library card view already
    // uses (searchCreativeLibrary's ads join).
    snapshot: { ...latest, ad_name: ad.name },
    ai_analysis: aiAnalysis,
    scores,
    fatigue,
    timeline,
    comparison,
    recommendations,
    intelligence,
    executive_summary: executiveSummary,
    root_cause_reasoning: rootCauseReasoning,
    benchmark_averages: benchmarkAverages,
    advisor,
    executive_decision: executiveDecision,
  };
}

module.exports = {
  getCreativeTimeline,
  searchCreativeLibrary,
  getAdSetComparison,
  getCreativeDetails,
  getCreativeBenchmarkAverages,
  getCreativeStateHistory,
  getAccountBestWorstCreative,
  getCrossModuleSignals,
};
