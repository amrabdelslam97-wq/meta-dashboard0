# Phase 45 — AI Executive Decision Layer

Strict-continuation phase. Adds ONE new arbitration layer
(`executiveDecisionEngine.js`) above everything Phase 42-44 already built.
No existing engine was rewritten: the Rule Engine, Health Score Engine,
Creative Intelligence scoring, Advisor Engine's panel/priorities/root-cause/
benchmark, and the Learning Engine all compute exactly as before. This
phase's only job is to reconcile their outputs into one user-facing verdict
and enrich the existing recommendation objects with the new fields Tasks
2-11 require — every new field is additive, every existing field/route
response shape is untouched.

## Architecture additions

**New file: `src/services/executiveDecisionEngine.js`** (pure logic, no DB
access, no new Meta API calls). Exports the full decision/explanation/
formula/conflict/confidence toolkit; the caller (`creativeLibrary.js`)
passes in everything it already computed (the advisor panel, priorities,
root cause, benchmark comparison/verdict/historical trend, fatigue, health
status, and the real Rule Engine findings already on the `intelligence`
bundle).

**Wiring**: `creativeLibrary.getCreativeDetails()` calls
`buildExecutiveDecisionLayer()` once, after `advisor` is built, and attaches
the result as a new top-level `executive_decision` field on the same
response `GET /api/v1/creative-intelligence/:adId` and
`GET /api/v1/advisor/creative/:adId` already return. Neither route's
existing fields changed.

**Frontend**: 9 new render functions in `public/index.html`
(`ciRenderExecutiveDecision`, `ciRenderExecutivePriorityCard`,
`ciRenderWhyNot`, `ciRenderConsistencyAudit`, `ciRenderMarketingDirectorPlan`,
`ciRenderContributionFormula`, `ciRenderBusinessImpactRanking`, plus 2 small
color-mapping helpers), inserted into the existing `ciRenderDetails()`
function — no new page, no new route, no new nav item (Task 11/12).

## Decision flow (Task 1)

```
advisor.panel.current_status  ──┐
                                 ├──►  baseDecisionFromPanel()  ──►  base decision
health_status + fatigue + score ┘         (STOP/PAUSE split)

Rule Engine's real fired findings (already scope-filtered to this
entity grain by ruleEngine.js itself) ──► ruleEngineCandidateDecisions()
                                              │
                                              ▼
                        resolveExecutiveDecision()
                     "the more conservative signal always wins"
                                              │
                                              ▼
                              ONE of: STOP / PAUSE / TEST /
                                OPTIMIZE / MONITOR / SCALE
```

The panel's own `current_status` (Scale/Pause/Refresh/Rewrite/Leave
Unchanged/Monitor — Phase 43/44's already-vetted synthesis) maps onto the
canonical six-value vocabulary, with one added severity split: `Pause`
escalates to `STOP` only when health is `critical` OR fatigue is `severe`
combined with a very low score (a real compounding-failure signal, not a
new one this phase invents). Real Rule Engine firings (severity + `action.type`,
both already in this codebase's registry) can produce a MORE conservative
candidate decision; when they do, the more conservative one always wins —
documented once as the single conflict-resolution rule, applied uniformly.

## Conflict resolution logic

Two kinds of conflict this phase resolves, both automatically and both
recorded, never silently dropped:

1. **Decision conflicts** (Task 1/13) — see the flow above. Every override
   is recorded in `consistency_audit.overrides[]` with the real rule
   ID/name/reason that caused it. When every signal already agreed,
   `consistency_audit.agreement: "unanimous"` is reported just as honestly.
2. **Recommendation conflicts** (Task 9) — a small, explicit compatibility
   table (`GROWTH_ACTIONS` vs. `CREATIVE_FIX_ACTIONS` vs. `HALT_ACTIONS`).
   "Scale" and "Rewrite Hook" (or any halt action alongside a growth/fix
   action) are never shown together — the higher-priority one is kept, the
   conflicting one moved to `dropped_recommendations` with a real reason,
   surfaced on the dashboard as "Not shown (conflicted with a higher-
   priority action): ...".

## Confidence methodology (Task 10)

`computeExecutiveConfidence()` extends (never replaces)
`executiveReasoningEngine.computeConfidence()`'s existing signal-counting
formula with four additional real inputs this phase has access to:

- **Signal agreement** — the decision arbitration's own result: unanimous
  agreement is worth +2 supporting; each override is a conflicting signal.
- **Historical consistency** — do multiple real metrics (from Phase 43's
  `buildHistoricalComparison()`) agree on direction? Consistent
  improvement/decline is supporting; metrics genuinely pulling in opposite
  directions is conflicting.
- **Benchmark confidence** — a peer-average grain backed by >= 5 real other
  creatives adds support; a thin or absent benchmark does not fabricate
  support it doesn't have.
- **Data sufficiency** — same real spend/fatigue-status gate every other
  confidence calculation in this system already uses, still capping
  confidence at a conservative ceiling when data is thin.

No arbitrary percentages: every point added or subtracted traces to a real,
named signal.

## Files changed

New: `src/services/executiveDecisionEngine.js`,
`tests/unit/executiveDecisionEngine.test.js`. Modified (additive only):
`src/services/advisorEngine.js` (Task 8 — `buildStateTransitions()` now
merges consecutive, exactly-repeated entries via the new
`mergeConsecutiveTimelineEntries()`), `src/services/creativeLibrary.js`
(wiring), `public/index.html` (9 new render functions + insertion points),
`tests/unit/advisorEngine.test.js` (+7 tests),
`tests/unit/creativeLibrary.test.js` (+1 assertion block),
`tests/unit/creativeIntelligenceFrontend.test.js` (extended extraction list
+ 1 new dedicated test).

## Production verification

Deployed to Railway production (`meta-dashboard0`, deployment `6d7895f9`).
Verified against the real, previously-synced ad `120250345364600170`:

- **API**: `executive_decision.decision: "MONITOR"`, `why_not` populated
  for all 5 non-chosen decisions (e.g. *"Why not SCALE? Creative score (57)
  is below the scaling threshold (65)."* — a direct, real-data match to the
  spec's own example format), `consistency_audit.agreement: "unanimous"`
  (no Rule Engine override needed for this ad right now),
  `priority_card.action: "Rewrite Hook"`, and a real 4-step
  `marketing_director_plan`.
- **Browser (Playwright, headless Chromium)**: navigated the live
  production dashboard to this ad. Zero console errors. Screenshot confirms
  the Executive Decision card (Task 12's visual-hierarchy requirement) as
  the largest, most prominent, color-bordered card on the page — MONITOR in
  blue, 60% confidence, the "If you do only one thing today" card, all 5
  why-not explanations, and "If I were managing this account..." below it.
- **Local pre-deploy verification** used a temporarily-seeded local ad
  history (deleted after the check) to exercise the SCALE path end-to-end,
  including a deliberately-repeated 5-row identical health-score history —
  confirmed the Task 8 fix live: the timeline now shows one merged
  "HEALTH SCORE | 2026-07-13 → 2026-07-17 | Health Score remained
  Excellent" entry instead of 5 duplicate rows.
- Regression spot-check post-deploy: `/dashboard`, `/creative-intelligence/library`,
  `/sync/status`, `/accounts`, `/campaigns`, `/advisor/creative/:id`, and
  `/advisor/account/:id/learning` all returned 200 with unaffected shapes.

## Regression summary

Full local suite: **942/942 passing** (918 pre-Phase-45 + 24 new/extended).
Zero pre-existing assertions changed.

## Performance impact

`buildExecutiveDecisionLayer()` runs entirely over data the `advisor`
bundle already computed (panel, priorities, root cause, benchmark) plus the
`intelligence.framework_recommendations` array already fetched by
`runAdIntelligence()` — no new DB query, no new Meta API call, no LLM call.
The frontend additions are pure string-template rendering of data already
present in the JSON response. Within the existing <10% overhead budget
carried since Phase 42.

## Known limitations (honestly disclosed)

- The Rule Engine → decision mapping in `ruleEngineCandidateDecisions()`
  covers the `action.type` vocabulary that actually exists in this
  codebase's registry today (`FIX_TRACKING`, `REALLOCATE_BUDGET`,
  `REVIEW_PERFORMANCE`, `REFRESH_CREATIVE`, `EXPAND_AUDIENCE`) — a future
  rule with a new `action.type` would fall through to "no override
  candidate" until this mapping is extended.
- `buildBusinessImpactRanking()`'s Revenue Impact is a directional estimate
  (reach + CTR movement weighted by real ROAS when available), not a
  currency figure — this system has no forecasting model, and fabricating
  one would violate this project's own house rule.
- The Winning/Loss Formula (Tasks 5/6) can only decompose contribution
  across dimensions this system actually tracks (hook, headline, copy,
  CTA, offer, trust, psychology) — it does not include "Audience Quality"
  or "Creative Timing" from the task brief's illustrative example, since
  neither is a real signal this platform computes yet.

## Future roadmap

- If a future phase adds real audience-quality or delivery-timing signals,
  wire them into `buildContributionFormula()`'s input list — the function
  already normalizes any set of real, impact-scored factors into
  percentages, so no structural change would be needed.
- Extend `ruleEngineCandidateDecisions()`'s mapping table as new Rule
  Engine `action.type` values are added to the registry.
- Consider surfacing the Executive Decision badge on the Creative Library
  grid view itself (one-line summary per card), not just the detail page.
