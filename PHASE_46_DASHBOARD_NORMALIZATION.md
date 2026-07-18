# Phase 46 — Dashboard Normalization & Consistency (Foundation Stabilization)

**Status:** Strict-continuation normalization phase. No architecture rewrite, no schema change, no route change, no change to Health Score/Rule Engine/Campaign Intelligence calculations. Every change below is either a presentation/labeling/hierarchy fix, or one explicitly-approved additive wiring of an already-real signal into an already-existing arbitration function. This is Foundation Stabilization for a possible future AP-POS effort — nothing AP-POS-shaped was designed or implemented, per your explicit instruction.

## Architecture Audit Summary

This phase began with a full architectural consistency audit (two targeted Explore passes across the backend reasoning engines and every non-Creative-Intelligence dashboard page, on top of the two full-platform audits already produced this session — `PROJECT_FORENSIC_AUDIT.md` and `PHASE_46_PRODUCTION_HARDENING.md`). The audit's headline finding: every individual engine computes correctly and honestly, but the platform had drifted into showing the same fact multiple times with different wording, using different vocabulary for the same concept on different pages, and — in one real case — computing a rule-driven verdict that the "single" Executive Decision never saw. The plan approved before implementation (`C:\Users\Amrab\.claude\plans\noble-sprouting-leaf.md`) scoped exactly what would and wouldn't be touched; this report follows that scope precisely.

## Normalizations Applied

### 1. Decision hierarchy (Goals 1, 5, 6)

**1a. Advisor Panel relabeled as supporting input, not a competing verdict.** `ciRenderAdvisorPanel()` (`public/index.html`) previously showed a field labeled *"Current Decision"* with the same badge styling as the Executive Decision card above it — even though Phase 45's `executiveDecisionEngine.js` already arbitrates the panel's status into the one canonical decision, a user could reasonably read two decisions on the same page. Relabeled to *"Advisor's Read"*, with a new one-line note directly under the section title: *"Supports the Executive Decision above — this is input to that decision, not a separate verdict."* Same underlying value (`panel.current_status`), same badge — label and framing only.

**1b. `recommendation_log` (the DB-rule-driven recommendation system) wired into the Executive Decision arbitration — the one approved behavior-affecting change.** Before this phase, a real, currently-active rule (e.g. `LOW_ROAS`: *"Campaign is losing money... Pause and review"*, critical severity, seeded in `src/db/seedIntelligence.js`) on an ad's own campaign was never consulted by `executiveDecisionEngine.resolveExecutiveDecision()` — the Executive Decision could say SCALE while a real, currently-firing rule on the same campaign said Pause, with zero reconciliation. Fixed additively:
- New `recommendationLogCandidateDecisions()` in `executiveDecisionEngine.js`, structurally identical to the existing `ruleEngineCandidateDecisions()`/`crossModuleCandidateDecisions()` — critical severity → `PAUSE` candidate, warning severity → `OPTIMIZE` candidate, `info` never moves the decision (same convention the native Rule Engine mapping already uses).
- Wired into `resolveExecutiveDecision()` as a third candidate source, through the exact same, already-existing "more conservative signal wins" resolution and `consistency_audit.overrides[]` recording — no new conflict-resolution rule invented.
- `creativeLibrary.js` now reuses `recommendationEngine.js`'s already-exported `loadActiveRecommendations(metaCampaignId)` (the same function the `/recommendations` route already calls) to fetch this ad's campaign's active rules — **zero new SQL**, pure reuse.
- `buildExecutiveDecisionLayer()` gained one new optional parameter (`recommendationLogRows`); every existing caller that doesn't pass it is unaffected, matching this codebase's own established optional-parameter precedent (Phase 43's `buildExecutiveSummary()`).
- As a direct side effect, also fixed the `why_not.PAUSE` explanation's hardcoded, factually-backwards claim of *"not critical"* regardless of the real health status passed in — it now states the real status honestly instead of asserting something that could be false. This is a text-accuracy fix only (Goal 6); it does **not** change what `baseDecisionFromPanel()` computes for non-Pause panel statuses (see "Deliberately Deferred" below).
- `why_not.OPTIMIZE` now also cites a real active rule by name when one exists, instead of claiming nothing is active when something in fact is.

### 2. Duplicated reasoning (Goal 2)

**2a.** `ciRenderPriorities()` now filters a recommendation's `evidence_used` bullets against the Advisor Panel's `reason[]` bullets already shown directly above it on the same page — an exact-match check plus one narrow, explicitly-scoped pattern match for the one known paraphrase pair the audit found (`advisorEngine.js`'s two independently-worded "outperforming its peer average" sentences). The backend fields (`panel.reason`, `priority.evidence_used`) are completely unchanged — both API fields still return exactly as before; only the rendered page now shows each fact once instead of twice. New helper: `ciBulletAlreadyShown()`.

**2b.** The rarer case (root-cause reasoning vs. Advisor Panel reason overlapping only when `diagnosisEngine`'s own cascade found nothing — the "unexplained" path) was evaluated and **deliberately not automated**: it's prose-level paraphrase across two different card types (a single paragraph vs. a bulleted list), not exact-match, and building fuzzy text matching for it would risk hiding a genuinely new point. Documented here as a known, narrow, low-frequency residual case rather than force a fragile fix.

### 3. Terminology (Goal 7)

- **3a.** The `expected_impact` field's on-screen label standardized to **"Expected Impact:"** everywhere it's rendered (previously *"🎯 Expected Result:"* on the Campaign Diagnosis tab, an unlabeled *"→ ..."* arrow in Decision Center's Opportunities card, *"Expected:"* in Decision Center's decision cards, and *"Expected impact:"* — lowercase — in Creative Intelligence). The genuinely distinct `panel.expected_result` field (Advisor Panel, a different field entirely) keeps its own correctly-matching *"Expected Result"* label — the fix removes the accidental collision between two different fields that used to share the same displayed word, without touching either field's data.
- **3b.** Fixed a real label collision on the Campaign Diagnosis tab where *"Business Impact"* meant two different things on the same page: a bare metric name (e.g. "ROAS") in one card, and a real narrative sentence in another. The metric-name usage is now labeled *"Primary Metric:"*; *"Business Impact:"* is reserved for the real narrative field only.
- **3c.** Decision Center's `winner_score` — previously an unexplained third number next to Health Score with no legend — now has an explicit label (*"Winner Score:"*) and a `title` tooltip clarifying it's a distinct composite ranking metric, not a variant of Health Score.
- **3d.** Fixed a real, always-reproducible, independently-confirmed bug: `ciRiskBadgeClass()` compared risk levels against `'HIGH'/'MEDIUM'/'LOW'` while `advisorEngine.buildRiskAssessment()` actually returns Title Case (`'High'/'Medium'/'Low'`) — every one of the 5 per-action Risk Assessment badges (Implementation/Learning Phase/Audience Fatigue/Budget/Volatility) silently fell through to the neutral gray "none" class, 100% of the time, hiding real severity. Now normalizes case before comparing.
- **3e. Deliberately not unified:** `severity` (3-value: critical/warning/info — Rule/Alert Engine's own taxonomy) vs. `priority` (4-value: critical/high/medium/low — Diagnosis/Decision Center's own taxonomy) remain two separate scales. Inventing a value mapping between two protected engines' own vocabularies would itself be exactly the kind of fabricated logic your rules forbid — documented here as a real, known terminology gap for a future phase to resolve deliberately, not patched over.
- **3f. Deliberately not merged:** `confidence` shown as both a percentage (`confidence_pct`) and a category (High/Medium/Low) on the same Campaign Diagnosis Overview tab was left as-is — the two render sites don't share both values in the same response object, so combining them would require a new data fetch, which is out of scope for a normalization-only pass.

### 4. Redundant panels — disambiguated, not merged (Goal 9)

Verified first that the apparent duplicates are genuinely **not** the same underlying data (different endpoints, different selection criteria) — per your own goal statement, merging them would misrepresent distinct information as identical and risk reading as removed functionality. Instead:
- The two identically-titled *"Needs Attention"* panels (Dashboard: health-score-threshold campaigns from `/dashboard`; Decision Center: a more sophisticated loser-ranking from `/decisions/losers` that also factors in alerts and score trend, not just current health) now each carry a short subtitle stating their real, different selection criteria.
- Decision Center's *"Top Winners"* now states it's ranked by Winner Score, not Health Score (confirmed via `topLosersEngine.js`/the winners equivalent that this really is a different ranking).
- Reports' *"Top Campaigns"* was confirmed to use the **same** ranking (health score, `ORDER BY h.health_score DESC` in `reportEngine.js`) as Dashboard's list — relabeled to match Dashboard's exact wording (*"Top Campaigns by Health Score"*) for consistency, since these two really are the same concept, just different report scope.
- Added a *"View all alerts →"* link (to the existing Alerts nav tab — no new route) on both the Reports and Portfolio pages' partial alert tables, so users understand these are previews of one dataset rather than three independent, unlinked lists.

### 5. Information hierarchy (Goals 3, 8)

- **5a.** Dashboard: the technical `sync-status-card` (queue/tier/retry/rate-limit telemetry) previously rendered *before* the business-facing Recommendations/Needs-Attention row — moved to render *after* it, so business decisions come before operational technical detail on the platform's primary landing page.
- **5b.** Campaign Diagnosis tab: *"Decisions & Recommendations"* previously rendered *last*, after three raw/evidence blocks (Root Cause card, Evidence — Contributing Factors, raw Health Score card). Moved to render immediately after the Executive Summary, before those raw blocks — decision-bearing content now leads, technical evidence follows.
- **5c.** Alerts table: the raw `alert_code` column previously preceded the human-readable `alert_message` column. Swapped so the plain-language message comes first.

### 6. Timeline (Goal 4) — verified, no gap found

Read the full timeline-merge call chain (`advisorEngine.buildStateTransitions()` → `mergeConsecutiveTimelineEntries()`, `buildBusinessEvents()`, `buildScoreMilestones()`, and the frontend's `ciMergedTimelineRows()`). Confirmed: `mergeConsecutiveTimelineEntries()` already covers the one source that genuinely needs it (`state_transitions`, built from `health_score_history`/`recommendation_log`/`active_alerts` rows, which log every sync unconditionally and can repeat identically for many consecutive snapshots). `business_events` (CTR Peak/CPA Drop/Frequency Increase) and `score_milestones` are edge-triggered by construction — they only get generated *at the moment* of a real threshold crossing or status change, so they cannot produce consecutive identical entries regardless of dedup logic. No code change was needed here; extending the merge function to cover something that structurally can't repeat would have been a no-op change for its own sake.

## Deliberately Deferred (documented, not fixed this pass)

Per your strict rules, none of the following were touched — each requires either a calculation-layer decision (forbidden this phase) or is scoped to a separate, dedicated phase per the prior hardening audit:

- **The two independently-computed Creative Score formulas** (`creativeScoringEngine.js`, weighted with 15% ROAS, vs. `creativeIntelligenceEngine.js`, an unweighted mean that never reads ROAS at all). Reconciling requires picking a canonical formula — a calculation decision, not a normalization.
- **`baseDecisionFromPanel()`'s health-blindness on non-Pause paths** (a critically unhealthy ad can still reach SCALE/MONITOR/OPTIMIZE/TEST with no health check at all, unlike the Pause path which does check health). This changes real decision *output*, not just its explanation text — the `why_not.PAUSE` text-accuracy fix in item 1b above stops it from *lying* about this, but doesn't change the underlying decision logic. Left for a dedicated, reviewed phase per the prior hardening audit's own recommendation.
- **Authentication** — the entire API remains unauthenticated on the public production URL. Explicitly out of scope for a UI/reasoning normalization phase; unchanged.
- **Frontend error handling** — `api()` still has no `.catch`/`r.ok` check anywhere. Unchanged; a systemic fix, not a normalization.
- **`severity` vs. `priority`** (3.e above) and **`confidence_pct` vs. categorical confidence co-display** (3.f above) — documented terminology gaps, deliberately not patched with an invented mapping.

## Files Modified

- `src/services/executiveDecisionEngine.js` — new `recommendationLogCandidateDecisions()`, wired into `resolveExecutiveDecision()` and `buildExecutiveDecisionLayer()`; `buildWhyNot()`'s PAUSE/OPTIMIZE reasoning made honest and rule-aware.
- `src/services/creativeLibrary.js` — reuses `recommendationEngine.loadActiveRecommendations()` (already exported, zero new SQL) and passes the result into the Executive Decision layer.
- `public/index.html` — Advisor Panel relabel; new `ciBulletAlreadyShown()` + evidence dedup in `ciRenderPriorities()`; `ciRiskBadgeClass()` case-normalization fix; `expected_impact`/`Business Impact`/`winner_score` label standardization; Needs-Attention/Top-Winners/Top-Campaigns disambiguating subtitles; "View all alerts →" cross-links; Dashboard/Campaign-Diagnosis/Alerts-table reordering.

## Files Added

- `PHASE_46_DASHBOARD_NORMALIZATION.md` (this report).

*(`PROJECT_FORENSIC_AUDIT.md` and `PHASE_46_PRODUCTION_HARDENING.md`, produced earlier this session, remain in the repo root as untracked deliverables from the two prior audit-only phases.)*

## Tests

- `tests/unit/executiveDecisionEngine.test.js` — +7 tests: `recommendationLogCandidateDecisions()` (critical→PAUSE, warning→OPTIMIZE, info/empty/null→no candidate), full arbitration override + unanimous-agreement cases, and the honest `why_not` text assertions.
- `tests/unit/creativeLibrary.test.js` — +1 end-to-end integration test: a real `LOW_ROAS`-shaped `recommendation_log` row on a dedicated test campaign genuinely overrides an otherwise-healthy ad's decision to PAUSE/STOP through the full `getCreativeDetails()` → `executiveDecisionEngine` path, with the override correctly attributed to "Recommendation Rules" in `consistency_audit`.
- `tests/unit/creativeIntelligenceFrontend.test.js` — extraction list extended (`ciBulletAlreadyShown`); +1 test confirming a duplicated evidence bullet renders exactly once while a genuinely distinct bullet on the same card is untouched.

**Full regression: 957/957 passing** (948 baseline + 9 new, zero failures, zero reduction — satisfies "do not lower test coverage"). Also syntax-checked the full inline JS bundle after every batch of frontend edits (zero errors throughout), and boot-tested the real server against an isolated scratch database (not the local dev DB) to confirm it starts cleanly and every touched route responds correctly with no data — `scripts/seed.js` has a pre-existing, unrelated bug (still-hardcoded old `'messaging'` objective value, rejected by the current CHECK constraint) that blocked the full `npm run verify` flow locally; confirmed via `git diff --stat scripts/seed.js` that this file was never touched by this phase, so it's a known, pre-existing gap, not a regression introduced here.

## Deployment

Committed as `6f4158c` and pushed to `fix/phase28-30-migration-multi-statement`. Railway's GitHub auto-deploy picked it up automatically — new deployment `5e3bf1a8-7d41-4a28-b42f-59b2678f24ef` came online `RUNNING`, confirmed via `railway status --json`'s `meta.commitHash` matching `6f4158c7d86365b972d04e65d9918c7784975e16` exactly.

**Live production verification, post-deploy:**
- Regression spot-check: `/api/v1/health`, `/api/v1/sync/status`, `/api/v1/accounts`, `/api/v1/campaigns`, `/dashboard`, `/creative-intelligence/library`, `/api/v1/decisions/losers`, `/api/v1/decisions/winners`, `/api/v1/recommendations`, `/api/v1/alerts` — all return **200**.
- `GET /api/v1/creative-intelligence/120250345364600170` — confirmed the new honest `why_not.PAUSE` text is live: *"Health status is 'excellent' -- no fatigue or health signal currently escalates this to a Pause."* (no more hardcoded, potentially-false "not critical" claim), and the new rule-aware `why_not.OPTIMIZE` wording is live.
- Fetched the live `/dashboard` HTML and confirmed every frontend change actually shipped: `"Advisor's Read"` present, the old `"Current Decision"` label fully gone, `ciBulletAlreadyShown` present, `"Expected Impact"` and `"Winner Score"` labels present, `"View all alerts"` cross-links present.
- Extracted and `node --check`'d the live production JS bundle — zero syntax errors.
- `railway logs` post-deploy shows normal traffic and a real, successful Meta API call for the Creative Intelligence detail endpoint — no errors, no crashes.

## Confirmation: No Existing Functionality, Route, Schema, or Protected Calculation Was Removed or Altered

- **Routes:** zero routes added, removed, or renamed. `recommendation_log` data reaches the existing `/creative-intelligence/:adId` and `/advisor/creative/:adId` responses as one new optional field-chain, nothing removed.
- **Schema:** zero migrations, zero new tables, zero altered columns.
- **Protected calculations:** Health Score Engine, native Rule Engine (`ruleEngine.js`/`ruleRegistrySeed.js`), and Campaign Intelligence scoring are byte-for-byte unchanged — confirmed by `git diff --stat` showing no touch to `healthScoreEngine.js`, `healthResolver.js`, `ruleEngine.js`, `ruleRegistrySeed.js`, `creativeIntelligenceEngine.js`, or `creativeScoringEngine.js`.
- **Backward compatibility:** every existing field in every touched API response is unchanged; the one new field (`recommendationLogRows` as an internal parameter) is optional with existing callers unaffected, matching this codebase's own established pattern.
- **Test coverage:** increased (948 → 957), never decreased.

## Readiness for AP-POS (Foundation Stabilization only — no AP-POS content designed or built)

This phase's job was to make the existing platform internally consistent before any Agency Performance Operating System work begins — not to design or scope AP-POS itself, per your explicit instruction, and nothing AP-POS-shaped (playbooks, SOPs, knowledge base, decision trees, frameworks) was touched. What this phase leaves in place that a future AP-POS effort could build on without further foundation work: one canonical, arbitrated decision per ad (now aware of three real signal sources instead of two); consistent `Expected Impact`/`Business Impact`/risk-severity vocabulary across the pages that share those concepts; a documented, honest map of exactly which terminology gaps (severity/priority, the two Creative Score formulas) and calculation-layer gaps (health-blind decision paths) remain open and why they were deliberately left alone rather than patched. Any AP-POS design should treat those documented gaps as known inputs, not surprises.
