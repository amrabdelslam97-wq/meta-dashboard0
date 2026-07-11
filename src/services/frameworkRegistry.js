/**
 * Framework Registry — MAIFS/MMS Integration, Phase 10
 *
 * Codifies the Meta Ads Intelligence Framework Series (docs/
 * META_ADS_INTELLIGENCE_FRAMEWORK_SERIES.md) and MMS's routing/execution
 * rules (docs/META_MASTER_SYSTEM.md) as runtime-queryable metadata, and
 * attributes each Framework to the existing engine(s)/table(s) that already
 * implement its concerns. This does NOT duplicate the documents' content
 * (no domain-object definitions, no full concept catalogs are copied here)
 * -- it is an index: Framework number/name/purpose/attribution only, plus
 * the two genuinely mechanical rule sets MMS defines (the execution order
 * and the routing table), extracted verbatim from MMS.4/MMS.5.
 *
 * No DB access, no side effects -- pure config + lookup functions, matching
 * kpiProfileResolver.js's own "pure config + resolution function" style.
 */

// ─────────────────────────────────────────────
// Meta Framework registry (docs/META_ADS_INTELLIGENCE_FRAMEWORK_SERIES.md)
//
// Framework 9 does not exist -- the source document explicitly reserves it
// and closes the series at Framework 10 ("Meta Framework 9 -- [reserved,
// permanently unbuilt] -- skipped -- series closed at Framework 10"). It is
// listed here as status:'reserved' rather than omitted, so any code that
// iterates FRAMEWORKS sees the gap is intentional, not a missing entry.
// ─────────────────────────────────────────────
const FRAMEWORKS = {
  MF1: {
    number: 1,
    name: 'Domain Vocabulary Framework',
    status: 'documented',
    purpose: 'Defines the canonical vocabulary for every Meta Ads domain object (Business, Campaign, Objective, Optimization Goal, Ad Set, Audience, Placement, Creative, Auction, Budget, etc.) so every later Framework and this system\'s code consumes one definition by reference, never a restatement.',
    attribution: {
      services: ['objectiveMapper.js', 'objectiveKPIMap.js', 'kpiProfileResolver.js'],
      tables: ['campaigns', 'ad_sets', 'ads'],
    },
  },
  MF2: {
    number: 2,
    name: 'Campaign Framework',
    status: 'implemented (partial — Diagnostics Framework only)',
    purpose: 'Governs the Campaign layer: Objective selection, Budget/Bid Strategy, lifecycle, and a 9-model Diagnostics Framework (CPA increase, ROAS drop, CTR drop, Frequency increase, Delivery failure, Learning failure, Budget saturation, Auction competition).',
    attribution: {
      services: ['goalAchievementEngine.js', 'kpiProfileResolver.js', 'diagnosisEngine.js', 'decisionEngine.js'],
      tables: ['campaigns', 'account_targets'],
    },
    // MF2.12 "Campaign Decision Intelligence" documents named rules in a
    // fixed Observed Metrics -> Likely Cause -> Recommended Action shape.
    // Verified real correspondences to existing code (not every named MF2
    // rule has a code counterpart -- only the ones below were individually
    // traced and confirmed):
    verifiedRules: [
      {
        docRule: 'MF2.12.1 — Sustained Frequency Rise with CTR Decline → Audience Saturation → Audience Expansion',
        implementedBy: 'recommendation_rules row HIGH_FREQUENCY -> decisionEngine.js REC_TO_DECISION.HIGH_FREQUENCY -> EXPAND_AUDIENCE',
      },
      {
        docRule: 'MF2.9 Diagnostics Framework — "ROAS Drop" model',
        implementedBy: 'recommendation_rules row LOW_ROAS + alert_rules row ROAS_BELOW_ONE -> decisionEngine.js -> PAUSE_CAMPAIGN',
      },
      {
        docRule: 'MF2.9 Diagnostics Framework — "CTR Drop" model',
        implementedBy: 'recommendation_rules row LOW_CTR + alert_rules row CTR_DROP -> decisionEngine.js -> REFRESH_CREATIVE',
      },
      {
        docRule: 'MF2.9 Diagnostics Framework — "Auction Competition" model',
        implementedBy: 'alert_rules row CPM_SPIKE -> decisionEngine.js -> REVIEW_PERFORMANCE',
      },
    ],
  },
  MF3: {
    number: 3,
    name: 'Ad Set Framework',
    status: 'documented',
    purpose: 'Governs the Ad Set layer: Placement (14 options), Optimization Goal (14 options), Attribution, Budget/Scheduling, and a 15-issue Ad Set Diagnostics Framework with its own 7-rule AI Decision Framework.',
    attribution: {
      services: ['adSetIntelligence.js'],
      tables: ['ad_sets'],
    },
  },
  MF4: {
    number: 4,
    name: 'Creative Framework',
    status: 'partially implemented',
    purpose: 'Governs creative analysis: Hook Framework (16 hook types), CTA Framework (10 CTAs), Creative Fatigue taxonomy, and a 13-issue Creative Diagnostics Framework.',
    attribution: {
      services: ['adIntelligence.js', 'diagnosisEngine.js (category: creative)'],
      tables: ['ads'],
    },
  },
  MF5: {
    number: 5,
    name: 'Audience Framework',
    status: 'partially implemented',
    purpose: 'Governs audience construction: targeting/segmentation, Lookalikes, Audience Overlap and Audience Saturation, and a 12-issue Audience Diagnostics Framework.',
    attribution: {
      services: ['opportunityEngine.js (Audience Expansion opportunity)', 'diagnosisEngine.js (category: audience)'],
      tables: ['ad_sets'],
    },
  },
  MF6: {
    number: 6,
    name: 'Delivery Framework',
    status: 'partially implemented',
    purpose: 'Governs delivery mechanics: the Auction Ranking Formula (9 factors), Learning Phase, Delivery Status (10 statuses), Frequency, and a 13-issue Delivery Diagnostics Framework.',
    attribution: {
      services: ['diagnosisEngine.js (category: competition)', 'benchmarkEngine.js (cpm/frequency)'],
      tables: [],
    },
  },
  MF7: {
    number: 7,
    name: 'Optimization Framework',
    status: 'implemented',
    purpose: 'Governs the Optimization Decision Engine — "what should I do" once measurements already exist. Every documented action follows a Trigger -> Conditions -> Decision -> Expected Outcome -> Risk -> Validation shape; this system\'s recommendation/decision/opportunity engines are the direct code analog of that shape.',
    attribution: {
      services: ['recommendationEngine.js', 'decisionEngine.js', 'opportunityEngine.js'],
      tables: ['recommendation_rules', 'recommendation_log', 'decision_history'],
    },
    verifiedRules: [
      { docRule: 'MF7 Scaling Framework (budget-expansion actions)', implementedBy: 'opportunityEngine.js "Ready To Scale" -> decisionEngine.js -> SCALE_CAMPAIGN' },
      { docRule: 'MF7 Budget Optimization Engine', implementedBy: 'opportunityEngine.js "Budget Reallocation" -> decisionEngine.js -> REALLOCATE_BUDGET' },
      { docRule: 'MF7 Creative Optimization Engine', implementedBy: 'opportunityEngine.js "Creative Testing" -> decisionEngine.js -> REFRESH_CREATIVE' },
    ],
  },
  MF8: {
    number: 8,
    name: 'Intelligence Framework',
    status: 'implemented',
    purpose: 'Governs the Intelligence/Reasoning layer — turning Measurement + Optimization evidence into reasoned, confidence-scored decisions via Root Cause Analysis (12 factor categories) and a Confidence Engine. This system\'s health score, benchmark evaluation, and Diagnosis Engine are the direct code analog.',
    attribution: {
      services: ['healthScoreEngine.js', 'benchmarkEngine.js', 'diagnosisEngine.js'],
      tables: ['health_score_history', 'benchmark_metrics'],
    },
  },
  MF9: {
    number: 9,
    name: null,
    status: 'reserved',
    purpose: 'Reserved. The source document (META_ADS_INTELLIGENCE_FRAMEWORK_SERIES.md, line 11128 and its closing statement at line 11843) permanently closes the series at Framework 10 and explicitly documents Framework 9 as unbuilt by design, not a gap to fill.',
    attribution: { services: [], tables: [] },
  },
  MF10: {
    number: 10,
    name: 'Unified Meta Ads Knowledge Framework',
    status: 'documented (this registry is its code counterpart)',
    purpose: 'Cross-Framework, whole-account reference layer unifying MF1-MF8 into one dependency map and cross-reference index. This file (frameworkRegistry.js) is the direct code analog: an index of every Framework\'s purpose and attribution, not a new source of domain knowledge.',
    attribution: {
      services: ['portfolioEngine.js', 'comparisonEngine.js', 'frameworkRegistry.js (this file)'],
      tables: [],
    },
  },
};

// ─────────────────────────────────────────────
// Rule provenance — structured lookup answering "which documented Framework
// rule produced this recommendation/alert/opportunity/decision?" Keyed by
// the exact rule_code/alert_code/opportunity-type/decision_type strings
// this codebase's own engines already use (recommendationEngine.js,
// alertEngine.js, opportunityEngine.js, decisionEngine.js) -- not a parsed
// re-derivation of FRAMEWORKS[x].verifiedRules' free text, so callers get a
// reliable object instead of a string search.
// ─────────────────────────────────────────────
const RULE_PROVENANCE = {
  LOW_ROAS:            { framework: 'MF2', docRule: 'MF2.9 Diagnostics Framework — ROAS Drop model' },
  LOW_CTR:             { framework: 'MF2', docRule: 'MF2.9 Diagnostics Framework — CTR Drop model' },
  HIGH_FREQUENCY:      { framework: 'MF2', docRule: 'MF2.12.1 — Sustained Frequency Rise with CTR Decline (Audience Saturation)' },
  ROAS_BELOW_ONE:      { framework: 'MF2', docRule: 'MF2.9 Diagnostics Framework — ROAS Drop model' },
  CPM_SPIKE:           { framework: 'MF2', docRule: 'MF2.9 Diagnostics Framework — Auction Competition model' },
  CTR_DROP:            { framework: 'MF2', docRule: 'MF2.9 Diagnostics Framework — CTR Drop model' },
  'Ready To Scale':      { framework: 'MF7', docRule: 'MF7 Scaling Framework' },
  'Audience Expansion':  { framework: 'MF7', docRule: 'MF7 Audience Optimization Engine' },
  'Creative Testing':    { framework: 'MF7', docRule: 'MF7 Creative Optimization Engine' },
  'Budget Reallocation': { framework: 'MF7', docRule: 'MF7 Budget Optimization Engine' },
};

function getRuleProvenance(code) {
  return RULE_PROVENANCE[code] || null;
}

// ─────────────────────────────────────────────
// MMS.4 — Mandatory Execution Order.
// "The Execution Order always follows the actual Framework Dependency
// Chain... MF1 before MF2, MF2 before MF3, and so on through MF7->MF8,
// regardless of which single Framework's content the final answer will
// mostly draw from." (MMS.4.1). MF9 is never part of the chain (reserved).
// MF10 is consulted last, only when a request spans multiple Frameworks.
// ─────────────────────────────────────────────
const EXECUTION_ORDER = ['MF1', 'MF2', 'MF3', 'MF4', 'MF5', 'MF6', 'MF7', 'MF8', 'MF10'];

// ─────────────────────────────────────────────
// MMS.5.1 — Primary Routing Table (verbatim mapping, condensed to code).
// Keys are the "concern" categories this system's own engines already
// classify signals into -- not free-text topics, since nothing in this
// codebase parses natural language. See maifsGovernance.js for how a
// concrete pipeline run's signals are translated into these concern keys.
// ─────────────────────────────────────────────
const ROUTING_TABLE = {
  vocabulary:        'MF1', // Objectives, core terminology, Metric definitions -- always the base layer
  campaign:          'MF2', // Campaign structure, Objective selection, Campaign Budget
  ad_set:            'MF3', // Ad Sets, Placement, Scheduling, Attribution settings
  creative:          'MF4', // Creative analysis, Hooks, CTAs, creative fatigue
  audience:          'MF5', // Audience analysis, targeting, Lookalikes, segmentation
  delivery:          'MF6', // Delivery problems, Auction, Learning Phase, Frequency
  optimization_action: 'MF7', // "What should I do" / Optimization action
  diagnosis:         'MF8', // "Why" / diagnosis / root cause / Confidence-scored recommendation
  cross_account:     'MF10', // Whole-account, cross-Framework, enterprise-wide questions
};

// ─────────────────────────────────────────────
// MF8.5 Root Cause Analysis category taxonomy, as cited at MMS.9.5:
// External, Platform, Creative, Audience, Budget, Competition,
// Landing Page, Tracking, Business Factor.
//
// diagnosisEngine.js (this codebase's Root Cause implementation) already
// produces a subset of these ('competition','creative','audience','budget',
// 'tracking') plus two system-specific statuses that aren't part of MF8.5's
// enum ('unexplained' -- no cascade factor matched; 'unclassified' -- the
// headline metric has no defined cause cascade). normalizeRootCause() maps
// diagnosisEngine's output onto the canonical MF8.5 enum without requiring
// any change to diagnosisEngine.js itself.
// ─────────────────────────────────────────────
const ROOT_CAUSE_CATEGORIES = [
  'external', 'platform', 'creative', 'audience', 'budget',
  'competition', 'landing_page', 'tracking', 'business_factor',
];

function normalizeRootCause(diagnosisCategory) {
  if (diagnosisCategory == null) return null;
  if (ROOT_CAUSE_CATEGORIES.includes(diagnosisCategory)) return diagnosisCategory;
  // diagnosisEngine-specific statuses with no MF8.5 equivalent -- mapped to
  // the closest canonical bucket rather than silently dropped.
  if (diagnosisCategory === 'unexplained')  return 'business_factor';
  if (diagnosisCategory === 'unclassified') return 'business_factor';
  return null;
}

function getFramework(code) {
  return FRAMEWORKS[code] || null;
}

function routeConcern(concern) {
  return ROUTING_TABLE[concern] || null;
}

module.exports = {
  FRAMEWORKS,
  EXECUTION_ORDER,
  ROUTING_TABLE,
  ROOT_CAUSE_CATEGORIES,
  RULE_PROVENANCE,
  normalizeRootCause,
  getFramework,
  routeConcern,
  getRuleProvenance,
};
