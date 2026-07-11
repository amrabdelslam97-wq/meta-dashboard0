/**
 * Rule Registry Seed — Phase 11
 *
 * Registers every individually-named decision/diagnostic rule found in
 * Meta Frameworks 2-8 (docs/META_ADS_INTELLIGENCE_FRAMEWORK_SERIES.md) into
 * ruleEngine.js's registry, per the "never silently omit a rule" mandate.
 * Every rule below was extracted from the actual document text (via
 * targeted research passes, not invented), and is registered with an
 * honest status:
 *
 *   sourceType: 'existing_db_rule'          -- already executed by
 *     recommendationEngine.js/alertEngine.js against DB rows; NOT
 *     re-evaluated here (would duplicate business logic).
 *   sourceType: 'existing_diagnosis_cascade' -- already executed by
 *     diagnosisEngine.js's decompose* cascades or benchmarkEngine.js;
 *     NOT re-evaluated here.
 *   sourceType: 'existing_opportunity_rule' / 'existing_scoring_rule' --
 *     already executed by opportunityEngine.js / healthResolver.js's
 *     optimal-range scoring; NOT re-evaluated here.
 *   sourceType: 'rule_engine_native', implementable: true -- a genuinely
 *     new rule, not covered by any existing engine, executed by this
 *     ruleEngine using only metrics this system already captures.
 *   implementable: false -- the rule's trigger condition depends on data
 *     this system does not fetch today (documented per-rule below with
 *     notImplementableReason). Registered as a placeholder, never
 *     evaluated, never silently dropped from the inventory.
 *
 * Numbers cited (e.g. "MF2.10.1") are the document's own section numbers,
 * confirmed against the actual text, not assumed from the framework's
 * high-level table of contents.
 */

const { registerRule } = require('./ruleEngine');
const { WEAK_CTA_TYPES } = require('./creativeTextAnalysis');

// ─────────────────────────────────────────────
// Bulk registration helpers -- keep this file's ~117 entries scannable.
// ─────────────────────────────────────────────
function notImplementable(id, framework, name, reason) {
  registerRule({
    id, framework, name, version: 1,
    sourceType: 'rule_engine_native',
    implementable: false,
    notImplementableReason: reason,
    provenance: { docRule: id },
  });
}

function attributed(id, framework, name, sourceType, attribution) {
  registerRule({
    id, framework, name, version: 1,
    sourceType,
    implementable: null, // N/A -- not evaluated by ruleEngine, executed by the attributed engine instead
    attribution,
    provenance: { docRule: id },
  });
}

// ═══════════════════════════════════════════════════════════════
// MF2 — Campaign Framework: 9 Diagnostics (MF2.10) + 7 Decisions (MF2.12)
// ═══════════════════════════════════════════════════════════════
attributed('MF2.10.1', 'MF2', 'Performance Decline (General Model)', 'existing_scoring_rule',
  'topWinnersEngine.detectTrend() via decisionEngine.getTrendForEntity() approximates "3+ consecutive periods decline" using health_score_history trend, not a raw-metric 3-period check.');
attributed('MF2.10.2', 'MF2', 'CPA Increase', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeCost() -- cpm/ctr/conversion-rate cascade.');
attributed('MF2.10.3', 'MF2', 'ROAS Drop', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRoas() -- tracking-anomaly check + cost cascade fallback.');
attributed('MF2.10.4', 'MF2', 'CTR Drop', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRate() -- frequency-rising / flat-frequency-fatigue cascade.');
attributed('MF2.10.5', 'MF2', 'Frequency Increase', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeVolume() -- frequency-rising factor.');
notImplementable('MF2.10.6', 'MF2', 'Delivery Failure', 'Requires Delivery Status / Bid Cap / Creative-rejection object fields -- not fetched by metricsFetcher.js (Insights-only).');
notImplementable('MF2.10.7', 'MF2', 'Learning Failure', "Requires Meta's learning_stage_info object field -- not part of this system's Insights fetch.");
registerRule({
  id: 'MF2.10.8', framework: 'MF2', name: 'Budget Saturation', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'budget', severity: 'warning',
  conditions: [
    { metric: 'spend', operator: 'delta_gt', value: 10 },
    { metric: 'reach', operator: 'delta_lt', value: 3 },
  ],
  reason: 'Spend rose but Reach barely moved -- a two-period proxy for "marginal delivery per additional budget dollar declining" (the document gives no numeric threshold; 10%/3% are this implementation\'s own calibration, not the document\'s).',
  action: { type: 'REALLOCATE_BUDGET' },
  provenance: { docRule: 'MF2.10.8 / MF2.12.6 (same underlying pattern, both cited)' },
  scope: { campaign: true, ad_set: false, ad: false },
});
attributed('MF2.12.1', 'MF2', 'Sustained Frequency Rise with CTR Decline', 'existing_db_rule', 'recommendation_rules row HIGH_FREQUENCY -> decisionEngine.js -> EXPAND_AUDIENCE (verified in frameworkRegistry.RULE_PROVENANCE).');
attributed('MF2.12.2', 'MF2', 'CTR Decline with Stable Frequency', 'existing_db_rule', 'recommendation_rules row LOW_CTR -> decisionEngine.js -> REFRESH_CREATIVE.');
attributed('MF2.12.3', 'MF2', 'ROAS Decline with Stable Spend and Purchase Volume', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRoas() tracking-anomaly branch (stable purchases + sharp purchase_value drop).');
notImplementable('MF2.12.4', 'MF2', 'Ad Set(s) Stuck in Learning Status', "Requires Meta's learning_stage_info object field -- not fetched.");
attributed('MF2.12.5', 'MF2', 'CPM Rising with No Internal Configuration Change', 'existing_diagnosis_cascade', 'diagnosisEngine.js cpm-rising factor (the "no config change" pre-check is not verified -- documented simplification, same as MF2.10.9).');
attributed('MF2.12.6', 'MF2', 'Marginal Delivery Declining Despite Budget Increases', 'rule_engine_native', 'Implemented as MF2.10.8 above (same underlying pattern).');
notImplementable('MF2.12.7', 'MF2', 'Campaign Budget vs Ad Set Budget Sibling Underperformance', 'Requires the campaign\'s is_campaign_budget_optimization (CBO/ABO) flag -- not confirmed synced by syncService.js.');
attributed('MF2.10.9', 'MF2', 'Auction Competition', 'existing_diagnosis_cascade', 'diagnosisEngine.js cpm-rising factor ("no config change" pre-check not verified, documented simplification).');

// ═══════════════════════════════════════════════════════════════
// MF3 — Ad Set Framework: 15 Diagnostics (MF3.12) + 7 Decisions (MF3.14)
// ═══════════════════════════════════════════════════════════════
notImplementable('MF3.12.1', 'MF3', 'Audience Too Small', "Requires Learning status + Audience Size estimate (Meta's separate reachestimate endpoint) -- not fetched.");
notImplementable('MF3.12.2', 'MF3', 'Audience Too Broad', 'Requires Advantage+ Signal presence / targeting-spec metadata -- not fetched (Insights-only integration).');
notImplementable('MF3.12.3', 'MF3', 'Audience Overlap', "Requires Meta's Audience Overlap reporting tool percentage -- not exposed via the standard Insights API this system uses.");
notImplementable('MF3.12.4', 'MF3', 'Learning Limited (Ad Set)', "Requires learning_stage_info object field -- not fetched.");
notImplementable('MF3.12.5', 'MF3', 'No Delivery (Ad Set)', 'Requires Delivery Status / Schedule / Creative-compliance object fields -- not fetched.');
attributed('MF3.12.6', 'MF3', 'High CPM (Ad Set)', 'existing_diagnosis_cascade', 'diagnosisEngine.js cpm-rising factor -- logic exists but diagnosisEngine is currently wired at campaign grain only, not yet called per ad set.');
attributed('MF3.12.7', 'MF3', 'High Frequency (Ad Set)', 'existing_scoring_rule', "kpiProfileResolver.js scoringWeights' optimal_range (opt_low/opt_high) frequency scoring, via healthScoreEngine.js.");
attributed('MF3.12.8', 'MF3', 'Low CTR (Ad Set)', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRate() -- not yet wired to ad-set-level analysis.');
attributed('MF3.12.9', 'MF3', 'High CPC (Ad Set)', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRate() -- not yet wired to ad-set-level analysis.');
attributed('MF3.12.10', 'MF3', 'Poor CVR (Ad Set)', 'existing_diagnosis_cascade', 'diagnosisEngine.js conversionRate() derived-metric check -- not yet wired to ad-set-level analysis.');
attributed('MF3.12.11', 'MF3', 'Poor ROAS (Ad Set)', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRoas() -- not yet wired to ad-set-level analysis.');
attributed('MF3.12.12', 'MF3', 'CPA Increase (Ad Set)', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeCost() -- not yet wired to ad-set-level analysis.');
notImplementable('MF3.12.13', 'MF3', 'Budget Restriction', 'Requires Bid Strategy / Cost Cap configuration object fields -- not fetched.');
notImplementable('MF3.12.14', 'MF3', 'Bid Restriction', 'Requires Bid Cap value + Auction Win Rate -- neither exposed by the standard Insights API.');
attributed('MF3.12.15', 'MF3', 'Auction Competition (Ad Set)', 'existing_diagnosis_cascade', 'diagnosisEngine.js cpm-rising factor -- "no config change" pre-check not verified.');
notImplementable('MF3.14.1', 'MF3', 'Bid Cap Severely Restricting Delivery', 'Requires Delivery Status + Bid Cap configuration -- not fetched.');
notImplementable('MF3.14.2', 'MF3', 'Unspent Budget Despite Adequate Audience Size', 'Requires Audience Size estimate + Cost Cap configuration -- not fetched.');
notImplementable('MF3.14.3', 'MF3', 'Sibling Ad Sets Showing Mutual Delivery Decline', "Requires Meta's Audience Overlap tool -- not exposed via Insights.");
notImplementable('MF3.14.4', 'MF3', 'Strong Delivery, Placement Configuration Still Manual', 'Requires Placement Breakdown + an internal brand-safety-justification record this system has no source for.');
attributed('MF3.14.5', 'MF3', 'Video Optimization Event with Weak Early Watch Percentage', 'rule_engine_native', 'Implemented once as MF4.13.4 (Low Hold Rate) below -- MF3.14.5, MF4.13.4, and MF4.15.1 all describe the identical 25%-to-50%-watch-percentage drop-off signature.');
attributed('MF3.14.6', 'MF3', 'Ad Set Approaching Budget Saturation During Vertical Scaling', 'rule_engine_native', 'Implemented as MF2.10.8 (Budget Saturation) above -- same underlying pattern.');
notImplementable('MF3.14.7', 'MF3', 'Calls Optimization Event Delivering Outside Business Hours', 'Requires hourly-breakdown Insights fetches + a documented staffed-hours business record -- neither exists in this system.');

// ═══════════════════════════════════════════════════════════════
// MF4 — Creative Framework: 13 Diagnostics (MF4.13) + 6 Decisions (MF4.15)
// ═══════════════════════════════════════════════════════════════
attributed('MF4.13.1', 'MF4', 'Low CTR (Creative)', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRate() -- not yet wired to creative/ad-level analysis.');
attributed('MF4.13.2', 'MF4', 'High CPC (Creative)', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRate() -- cpm-vs-ctr decomposition already implemented.');
registerRule({
  id: 'MF4.13.3', framework: 'MF4', name: 'Low Hook Rate', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'creative', severity: 'warning',
  conditions: [{ metric: 'video_p25_watched', operator: 'delta_lt', value: -15 }],
  reason: 'Meaningful decline in 3-second/25%-watch video retention -- MF4.9.4\'s Hook Rate proxy. Root-cause attribution to a specific Hook *type* mismatch is not implementable (no creative-content classification data source); this rule detects the symptom only.',
  action: { type: 'REFRESH_CREATIVE' },
  provenance: { docRule: 'MF4.13.3' },
  // ad:true (Creative Intelligence Engine phase): this is fundamentally a
  // per-creative signal -- video_p25_watched is captured at ad grain by
  // fetchAdMetrics(), so the rule can now fire per-ad, not just rolled up
  // to the campaign average, which could mask one bad creative among
  // several healthy ones in the same campaign.
  scope: { campaign: true, ad_set: false, ad: true },
});
registerRule({
  id: 'MF4.13.4', framework: 'MF4', name: 'Low Hold Rate', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'creative', severity: 'warning',
  conditions: [{ metricA: 'video_p50_watched', metricB: 'video_p25_watched', operator: 'ratio_lt', value: 0.5 }],
  reason: 'Steep drop-off between the 25% and 50% video watch-percentage breakpoints -- the creative\'s hook works but the body loses viewers immediately after. This single implementation covers three document citations of the identical signature: MF3.14.5, MF4.13.4, and MF4.15.1.',
  action: { type: 'REFRESH_CREATIVE' },
  provenance: { docRule: 'MF4.13.4 / MF3.14.5 / MF4.15.1' },
  // ad:true (Creative Intelligence Engine phase) -- same reasoning as
  // MF4.13.3 above: a per-creative video retention signal.
  scope: { campaign: true, ad_set: false, ad: true },
});
registerRule({
  id: 'MF4.15.2', framework: 'MF4', name: 'High Engagement, Low Conversion', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'creative', severity: 'warning',
  conditions: [
    { metric: 'post_engagements', operator: 'delta_gt', value: 10 },
    { metric: 'purchases', operator: 'delta_lt', value: -20 },
  ],
  reason: 'Engagement rising while purchases fall -- the document\'s explicit two-step recommendation (test CTA change before Offer change, never both at once) is preserved verbatim in the suggested_action text; the engine cannot itself isolate CTA vs Offer as the cause (no creative-copy data source).',
  action: { type: 'REFRESH_CREATIVE', suggestedActionOverride: 'Test a CTA change first; only test an Offer change if a CTA-only test does not resolve it (changing both at once prevents isolating which fix worked).' },
  provenance: { docRule: 'MF4.15.2' },
  appliesToObjectives: ['sales'],
  // ad:true (Creative Intelligence Engine phase) -- post_engagements/
  // purchases are both captured at ad grain, so a single engaging-but-
  // unconverting creative can be isolated instead of only surfacing when
  // it drags the whole campaign average.
  scope: { campaign: true, ad_set: false, ad: true },
});
// Correction (Framework Runtime Completion audit): previously left
// unwired ("existing_scoring_rule" pointing at a benchmarkMetrics list
// that doesn't include this metric). Rather than modify
// kpiProfileResolver.js's benchmarkMetrics (risking existing benchmark
// evaluation behavior), implemented as its own native rule against
// post_engagements, which metricsFetcher.js already captures and
// delta-computes -- no new data source needed.
registerRule({
  id: 'MF4.13.5', framework: 'MF4', name: 'Poor Engagement', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'creative', severity: 'warning',
  conditions: [{ metric: 'post_engagements', operator: 'delta_lt', value: -20 }],
  reason: 'Post-engagement rate (reactions/comments/shares/saves) fell sharply -- MF4.13.5\'s "low Engagement Rate relative to Benchmark" signature. Root-cause attribution to a specific psychological-principle mismatch is not implementable (no creative-content classification data source); this rule detects the symptom only.',
  action: { type: 'REFRESH_CREATIVE' },
  provenance: { docRule: 'MF4.13.5' },
  // ad:true (Creative Intelligence Engine phase) -- same reasoning as
  // MF4.13.3/MF4.15.2 above: a per-creative engagement signal.
  scope: { campaign: true, ad_set: false, ad: true },
});
attributed('MF4.13.6', 'MF4', 'Poor Conversion', 'existing_diagnosis_cascade', 'diagnosisEngine.js conversionRate() derived-metric check.');
attributed('MF4.13.7', 'MF4', 'Creative Fatigue', 'existing_diagnosis_cascade', "diagnosisEngine.js's category system covers the concept generically; no dedicated Creative Fatigue Score exists (the document itself gives no formula for one -- MAIFS.14 explicitly excludes it, per MF4.9.18).");
notImplementable('MF4.13.8', 'MF4', 'Negative Feedback', 'Hide/report/"see less" rates are not exposed by the current standard Ads Insights API (deprecated for privacy reasons circa 2018).');
attributed('MF4.13.9', 'MF4', 'Poor ROAS (Creative)', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRoas().');
notImplementable('MF4.13.10', 'MF4', 'Low Trust', 'Requires Engagement Rate Ranking / Conversion Rate Ranking categorical fields -- not fetched (separate Marketing API ad-level fields, not part of Insights).');
notImplementable('MF4.13.11', 'MF4', 'Offer Mismatch', 'Requires comparing ad creative copy text against landing-page content -- no such data source exists in this system.');
// Correction (Creative Intelligence Engine phase): previously
// notImplementable -- cta_type was not fetched. Now genuinely available:
// metaApiClient.fetchAdCreativeDetail() fetches object_story_spec's
// call_to_action.type, and creativeAnalytics.js persists it to
// creative_analytics.cta_type per ad. Classification reuses
// creativeTextAnalysis.js's WEAK_CTA_TYPES set (the same vocabulary the
// Creative Score's score_cta dimension is built from) rather than
// duplicating a second weak/strong CTA list.
registerRule({
  id: 'MF4.13.12', framework: 'MF4', name: 'Weak CTA', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'creative', severity: 'info',
  conditions: [{ metric: 'cta_type', operator: 'in_set', value: [...WEAK_CTA_TYPES] }],
  reason: "The ad's configured call-to-action button is a generic/low-intent type (e.g. Learn More, See More, Contact Us) rather than an action-oriented one -- MF4.13.12's Weak CTA signature.",
  action: { type: 'REFRESH_CREATIVE', suggestedActionOverride: 'Replace the call-to-action button with an action-oriented type matched to the campaign objective (e.g. Shop Now, Sign Up, Get Offer) instead of a generic one.' },
  provenance: { docRule: 'MF4.13.12' },
  // ad:true only -- CTA is configured per-ad-creative, not a metric that
  // aggregates meaningfully to campaign/ad_set grain.
  scope: { campaign: false, ad_set: false, ad: true },
});
notImplementable('MF4.13.13', 'MF4', 'Weak Branding', 'Requires Estimated Ad Recall Lift (a dedicated brand-lift study, rarely running) and creative-asset brand-consistency analysis -- neither available.');
attributed('MF4.15.1', 'MF4', 'Strong Impressions Volume, Weak Video Retention', 'rule_engine_native', 'Implemented as MF4.13.4 (Low Hold Rate) above -- identical signature.');
registerRule({
  id: 'MF4.15.3', framework: 'MF4', name: 'Rising Frequency, Declining All Creative KPIs Uniformly (Frequency Fatigue)', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'audience', severity: 'warning',
  conditions: [
    { metric: 'frequency', operator: 'delta_gt', value: 10 },
    { metric: 'reach', operator: 'flat', band: 5 },
    { metric: 'ctr', operator: 'delta_lt', value: -10 },
  ],
  reason: 'Rising Frequency at a plateaued Reach with falling CTR -- the document\'s named "Frequency Fatigue" signature, explicitly distinguished from Visual Fatigue (MF4.15.4) by being a pure-repetition pattern, not a content-quality one. Per the document, this should be fixed with Audience Expansion, never a Creative Refresh.',
  action: { type: 'EXPAND_AUDIENCE' },
  provenance: { docRule: 'MF4.15.3' },
  scope: { campaign: true, ad_set: false, ad: false },
});
registerRule({
  id: 'MF4.15.4', framework: 'MF4', name: 'Declining Hook Rate Specifically, Frequency and CVR Stable (Visual Fatigue)', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'creative', severity: 'warning',
  conditions: [
    { metric: 'video_p25_watched', operator: 'delta_lt', value: -15 },
    { metric: 'frequency', operator: 'flat', band: 10 },
  ],
  reason: 'Hook Rate declining while Frequency stays flat -- isolates a content-quality (Visual Fatigue) cause from a saturation (Frequency Fatigue, MF4.15.3) cause. Per the document, this is fixed with a genuinely new Creative concept, explicitly NOT an audience-side action.',
  action: { type: 'REFRESH_CREATIVE' },
  provenance: { docRule: 'MF4.15.4' },
  // ad:true (Creative Intelligence Engine phase) -- same reasoning as
  // MF4.13.3/MF4.13.4 above: a per-creative video retention signal.
  scope: { campaign: true, ad_set: false, ad: true },
});
notImplementable('MF4.15.5', 'MF4', 'Rising Negative Feedback on a High-Urgency Creative', 'Requires Negative Feedback rate (deprecated from the API) and creative-copy urgency-tactic classification -- neither available.');
notImplementable('MF4.15.6', 'MF4', 'Strong Performance, Approaching Estimated Fatigue Window', 'Requires a Creative Fatigue Score formula the document itself explicitly declines to specify (MF4.9.18, per MAIFS.14) -- any threshold here would be pure invention, not a ported rule.');

// ═══════════════════════════════════════════════════════════════
// MF5 — Audience Framework: 12 Diagnostics (MF5.13) + 6 Decisions (MF5.16)
// ═══════════════════════════════════════════════════════════════
notImplementable('MF5.13.1', 'MF5', 'Audience Too Small', 'Requires Learning status + Audience Size estimate -- not fetched.');
notImplementable('MF5.13.2', 'MF5', 'Audience Too Broad', 'Requires Advantage+ Signal / targeting-spec metadata -- not fetched.');
notImplementable('MF5.13.3', 'MF5', 'Poor Quality (Audience Source)', 'Requires Custom Audience Matching Quality / Seed identity -- Marketing API audience-object fields, not fetched.');
attributed('MF5.13.4', 'MF5', 'High CPM (Audience)', 'existing_diagnosis_cascade', 'diagnosisEngine.js cpm-rising factor -- distinguishing "audience too narrow" from genuine external competition is not implementable (no Audience Size estimate).');
attributed('MF5.13.5', 'MF5', 'Low CTR (Audience)', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRate() -- audience-vs-creative attribution not distinguishable with current data.');
notImplementable('MF5.13.6', 'MF5', 'High CPA (Audience — Value Segmentation)', 'Requires customer LTV/value data joined to audience segments -- no CRM/LTV integration exists.');
notImplementable('MF5.13.7', 'MF5', 'Low ROAS (Audience — Buying Stage)', 'Requires Lookalike seed composition + audience Buying-Stage classification -- neither available.');
registerRule({
  id: 'MF5.13.8', framework: 'MF5', name: 'High Frequency / Reach Exhaustion (Audience Saturation)', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'audience', severity: 'warning',
  conditions: [
    { metric: 'reach', operator: 'flat', band: 3 },
    { metric: 'frequency', operator: 'delta_gt', value: 5 },
  ],
  reason: 'MF5.11.3\'s explicit "Reach Exhaustion" signature: "Reach growth rate approaching zero despite continued or increased Budget," co-occurring with rising Frequency. Tighter Reach-flat band (3%) than Frequency Fatigue (MF4.15.3, 5%) since this is the document\'s "early warning" stage, not the fuller-blown pattern.',
  action: { type: 'EXPAND_AUDIENCE' },
  provenance: { docRule: 'MF5.13.8 / MF5.11.3 (Reach Exhaustion) / MF5.16.1' },
  scope: { campaign: true, ad_set: false, ad: false },
});
attributed('MF5.13.9', 'MF5', 'Audience Saturation', 'rule_engine_native', 'Implemented as MF5.13.8 above (same underlying pattern, MF5.11 cross-reference).');
notImplementable('MF5.13.10', 'MF5', 'Audience Overlap', "Requires Meta's Audience Overlap tool percentage -- not exposed via standard Insights.");
notImplementable('MF5.13.11', 'MF5', 'Weak Purchase Intent (Buying Stage Mismatch)', 'Requires TOF/MOF/BOF funnel-stage classification of an audience -- a framework construct with no corresponding Meta API field.');
notImplementable('MF5.13.12', 'MF5', 'Weak Engagement (Audience-Attributed)', 'Requires audience psychographic-profile data and a "staleness" signal beyond simple creation-date heuristics -- not available.');
notImplementable('MF5.16.1', 'MF5', 'Rising Frequency with Plateaued Reach on a Lookalike-Based Ad Set', 'The underlying signal is implemented (MF5.13.8); the specific Lookalike-tier-expansion action requires targeting-spec metadata (lookalike_spec) -- not fetched.');
notImplementable('MF5.16.2', 'MF5', 'Strong Delivery, Weak Conversion on an Advantage+ Audience Ad Set', "Requires knowing whether Advantage+ Audience is enabled with no supplied Signal -- targeting-spec metadata not fetched.");
notImplementable('MF5.16.3', 'MF5', 'Two Sibling Ad Sets Showing Declining Combined Efficiency', "Requires Meta's Audience Overlap tool / Custom Audience source identity -- not fetched.");
notImplementable('MF5.16.4', 'MF5', 'New Lookalike Seed Available from Recently-Matured CRM Data', 'Depends entirely on external CRM integration status and Customer List LTV metadata -- not a metric-driven rule at all, no corresponding data source exists.');
notImplementable('MF5.16.5', 'MF5', 'TOF Audience Segment Directly Targeted with a BOF Optimization Event', 'Requires TOF/MOF/BOF audience classification -- no corresponding data source (same gap as MF5.13.11).');
attributed('MF5.16.6', 'MF5', 'Audience Approaching Estimated Saturation During a Scaling Push', 'rule_engine_native', 'Implemented as MF2.10.8 (Budget Saturation) above -- same underlying "diminishing marginal delivery per spend" pattern.');

// ═══════════════════════════════════════════════════════════════
// MF6 — Delivery Framework: 13 Diagnostics (MF6.13) + 6 Decisions (MF6.14)
// ═══════════════════════════════════════════════════════════════
notImplementable('MF6.13.1', 'MF6', 'No Delivery', 'Requires Delivery Status / effective_status object fields -- not fetched (though zero-impressions itself is detectable, the document\'s full diagnostic needs the status field to distinguish causes).');
notImplementable('MF6.13.2', 'MF6', 'Limited Delivery', 'Requires theoretical Inventory size -- no Meta API surfaces total addressable inventory.');
attributed('MF6.13.3', 'MF6', 'High CPM (Delivery)', 'existing_diagnosis_cascade', 'diagnosisEngine.js cpm-rising factor; Ad Quality/Engagement/Conversion Rate Ranking decomposition not implementable (categorical fields not fetched).');
notImplementable('MF6.13.4', 'MF6', 'Learning Limited (Pipeline-Level)', 'Requires learning_stage_info -- not fetched.');
notImplementable('MF6.13.5', 'MF6', 'Budget Not Spending', 'Requires Bid Cap/Cost Cap configuration comparison -- object fields not fetched.');
// Correction (Framework Runtime Completion audit): this was previously
// registered via attributed(..., 'rule_engine_native', ...) as if its
// logic already ran elsewhere, but the note itself said "not separately
// implemented" -- a self-contradicting registration. Genuinely not
// implementable today: it needs a stored historical pacing baseline this
// system does not maintain (MF2.10.8's spend/reach pattern only detects
// the opposite direction -- spend rising with flat reach -- not
// overspending against an expected pacing curve).
notImplementable('MF6.13.6', 'MF6', 'Budget Overspending', 'Requires a stored historical budget-pacing baseline to detect "much earlier than expected pacing curve" -- this system has no pacing-baseline tracking. MF2.10.8\'s spend/reach pattern only covers the opposite direction (spend rising, reach flat), not this one.');
attributed('MF6.13.7', 'MF6', 'Frequency Too High', 'existing_scoring_rule', "kpiProfileResolver.js's optimal_range frequency scoring, via healthScoreEngine.js.");
attributed('MF6.13.8', 'MF6', 'Auction Competition (Delivery-Level)', 'existing_diagnosis_cascade', 'diagnosisEngine.js cpm-rising factor.');
notImplementable('MF6.13.9', 'MF6', 'Weak Estimated Action Rate', "Requires Auction Win Rate -- explicitly not exposed by any public Meta API (internal to Meta's ad-ranking system).");
notImplementable('MF6.13.10', 'MF6', 'Weak Ad Quality', 'Requires Quality/Engagement/Conversion Rate Ranking categorical fields -- not fetched.');
notImplementable('MF6.13.11', 'MF6', 'Low Reach', "Requires Meta's Audience Size estimate (reachestimate endpoint) -- not fetched.");
notImplementable('MF6.13.12', 'MF6', 'Low Impressions', "Requires Auction Win Rate and theoretical Placements Inventory size -- neither exposed.");
notImplementable('MF6.13.13', 'MF6', 'Poor Delivery Stability', "Requires a self-maintained configuration/version-control change log -- this system does not track config-change history.");
notImplementable('MF6.14.1', 'MF6', 'Low Auction Win Rate with Competitive Bid', "Requires Auction Win Rate -- not implementable (confirmed not exposed by any Meta API).");
// Correction (Framework Runtime Completion audit): previously registered
// implementable:false because ad_sets.daily_budget/lifetime_budget wasn't
// plumbed into the rule context. Now wired: src/api/routes/insights.js
// computes `budget_utilization_pct` (spend vs. the campaign's aggregate
// ad_sets budget over the period) and injects it into `current` before
// calling executeRules() -- see insights.js's `attachBudgetUtilization()`.
registerRule({
  id: 'MF6.14.2', framework: 'MF6', name: 'Budget Fully Utilized but Cost Efficiency Declining', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'budget', severity: 'warning',
  conditions: [
    { metric: 'budget_utilization_pct', operator: 'gte', value: 90 },
    { metric: 'cpm', operator: 'delta_gt', value: 15 },
  ],
  reason: 'Budget is nearly fully utilized (>=90% of the campaign\'s aggregate ad-set budget for the period) while CPM is rising -- MF6.14.2\'s "Budget Fully Utilized but Cost Efficiency Declining" signature (Inventory Saturation). CPM is used as the cost-efficiency proxy since it applies across every objective; a per-objective CPA/ROAS check was judged out of scope for a single generic rule.',
  action: { type: 'REALLOCATE_BUDGET' },
  provenance: { docRule: 'MF6.14.2' },
  scope: { campaign: true, ad_set: false, ad: false },
});
notImplementable('MF6.14.3', 'MF6', 'Stable Delivery Suddenly Destabilizes', 'Requires a self-maintained configuration/version-control change log -- not tracked.');
notImplementable('MF6.14.4', 'MF6', 'Ad Set Approaching Learning Limited Near Optimization Window Close', 'Requires Learning Progress / Optimization Window position -- not fetched.');
attributed('MF6.14.5', 'MF6', 'High-Performing Ad Set Nearing Frequency Saturation During Active Scaling', 'existing_scoring_rule', "kpiProfileResolver.js's optimal_range frequency scoring (self-benchmarked ceiling), via healthScoreEngine.js.");
attributed('MF6.14.6', 'MF6', 'Consistently Winning Auctions at Unexpectedly Low Realized Cost', 'existing_opportunity_rule', 'opportunityEngine.js "Ready To Scale" opportunity type -> decisionEngine.js -> SCALE_CAMPAIGN.');

// ═══════════════════════════════════════════════════════════════
// MF7 — Optimization Framework: 6 Decision Trees (MF7.4) + 17 Triggers (MF7.10)
// ═══════════════════════════════════════════════════════════════
attributed('MF7.4.1', 'MF7', 'CTR Decision Tree', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRate() + benchmarkEngine.js.');
attributed('MF7.4.2', 'MF7', 'CPA Decision Tree', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeCost().');
attributed('MF7.4.3', 'MF7', 'ROAS Decision Tree', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRoas().');
attributed('MF7.4.4', 'MF7', 'CPM Decision Tree', 'existing_diagnosis_cascade', 'diagnosisEngine.js cpm-rising factor + benchmarkEngine.js.');
attributed('MF7.4.5', 'MF7', 'CPC Decision Tree', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRate().');
attributed('MF7.4.6', 'MF7', 'CVR Decision Tree', 'existing_diagnosis_cascade', 'diagnosisEngine.js conversionRate() derived-metric check.');
attributed('MF7.10.1', 'MF7', 'Trigger: High CPA', 'existing_diagnosis_cascade', 'diagnosisEngine.js / benchmarkEngine.js.');
attributed('MF7.10.2', 'MF7', 'Trigger: Low ROAS', 'existing_db_rule', 'alert_rules row ROAS_BELOW_ONE + recommendation_rules row LOW_ROAS.');
attributed('MF7.10.3', 'MF7', 'Trigger: High Frequency', 'existing_db_rule', 'recommendation_rules row HIGH_FREQUENCY.');
attributed('MF7.10.4', 'MF7', 'Trigger: Low CTR', 'existing_db_rule', 'recommendation_rules row LOW_CTR + alert_rules row CTR_DROP.');
attributed('MF7.10.5', 'MF7', 'Trigger: High CPC', 'existing_diagnosis_cascade', 'diagnosisEngine.js decomposeRate().');
attributed('MF7.10.6', 'MF7', 'Trigger: High CPM', 'existing_db_rule', 'alert_rules row CPM_SPIKE.');
attributed('MF7.10.7', 'MF7', 'Trigger: Low CVR', 'existing_diagnosis_cascade', 'diagnosisEngine.js conversionRate() derived-metric check.');
attributed('MF7.10.8', 'MF7', 'Trigger: Poor Hook Rate', 'rule_engine_native', 'Implemented as MF4.13.3 (Low Hook Rate) above.');
attributed('MF7.10.9', 'MF7', 'Trigger: Poor Hold Rate', 'rule_engine_native', 'Implemented as MF4.13.4 (Low Hold Rate) above.');
registerRule({
  id: 'MF7.10.10', framework: 'MF7', name: 'Trigger: High Bounce', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'tracking', severity: 'warning',
  conditions: [{ metricA: 'landing_page_views', metricB: 'link_clicks', operator: 'ratio_lt', value: 0.5 }],
  reason: 'A high proportion of Link Clicks fail to register a matching Landing Page View -- MF7.10.10\'s explicit trigger. Both fields are standard Meta actions already normalized by metricsFetcher.js.',
  action: { type: 'FIX_TRACKING' },
  provenance: { docRule: 'MF7.10.10' },
  scope: { campaign: true, ad_set: false, ad: false },
});
registerRule({
  id: 'MF7.10.11', framework: 'MF7', name: 'Trigger: Poor Landing Page (Conversion Collapse)', version: 1,
  sourceType: 'rule_engine_native', implementable: true,
  category: 'landing_page', severity: 'warning',
  conditions: [
    { metric: 'purchases', operator: 'delta_lt', value: -30 },
    { metric: 'clicks', operator: 'delta_gt', value: -10 },
  ],
  reason: 'Healthy upstream traffic (clicks not falling much) with a sharp drop in purchases -- MF7.10.11\'s "healthy CTR/LPV, weak downstream CVR" signature and MF8\'s Pattern #7 "Conversion Collapse." The document itself says this is "out of this Framework\'s remediation scope" (landing-page fixes are outside the ad account), so the action is a review flag, not an ad-account-side fix. Scoped to the sales objective (purchases as the conversion metric) -- the leads/results equivalent for other objectives is not yet wired.',
  action: { type: 'REVIEW_PERFORMANCE' },
  provenance: { docRule: 'MF7.10.11 / MF8 Pattern #7 (Conversion Collapse)' },
  appliesToObjectives: ['sales'],
  scope: { campaign: true, ad_set: false, ad: false },
});
attributed('MF7.10.12', 'MF7', 'Trigger: Creative Fatigue', 'existing_diagnosis_cascade', "diagnosisEngine.js's category system covers the concept generically; no dedicated Fatigue Score (document gives none, per MAIFS.14).");
notImplementable('MF7.10.13', 'MF7', 'Trigger: Audience Fatigue', 'Requires tracking "successive Creative-side fixes already attempted" -- a workflow-state concept this system does not model.');
attributed('MF7.10.14', 'MF7', 'Trigger: Auction Competition', 'existing_diagnosis_cascade', 'diagnosisEngine.js cpm-rising factor.');
notImplementable('MF7.10.15', 'MF7', 'Trigger: Delivery Problems', "Requires Delivery Rate against theoretical inventory -- not available.");
notImplementable('MF7.10.16', 'MF7', 'Trigger: Learning Limited', 'Requires learning_stage_info -- not fetched.');
notImplementable('MF7.10.17', 'MF7', 'Trigger: Limited Budget', "Requires Bid Strategy confirmation as the binding constraint -- object field not fetched (Budget Utilization itself is computable, per MF6.14.2's note above).");
attributed('MF7.11.3', 'MF7', 'Priority Escalation Rule (3+ consecutive cycles)', 'existing_scoring_rule', "prioritizationEngine.computePriorityScore()'s alertCount compounding (+3/extra occurrence, capped) already implements an escalation-by-persistence mechanism, sourced from active_alerts.occurrence_count.");

// ═══════════════════════════════════════════════════════════════
// MF8 — Intelligence Framework: taxonomy, not independently-firing rules.
// Already codified in frameworkRegistry.js's ROOT_CAUSE_CATEGORIES /
// normalizeRootCause() (the 9 causal-factor categories of MF8.5's 12) and
// diagnosisEngine.js's PRIORITY_TABLE (MF8.7's 5-level Decision
// Prioritization matrix). MF8.6's Confidence Engine and MF8.11's Anomaly
// Detection explicitly, deliberately give no formula (confirmed via direct
// quotes citing MAIFS.14) -- diagnosisEngine.js's own confidence logic is
// this system's implementer-supplied answer to that intentional gap, not a
// missing port.
// ═══════════════════════════════════════════════════════════════

module.exports = {}; // side-effect module: registers rules into ruleEngine.js on require()
