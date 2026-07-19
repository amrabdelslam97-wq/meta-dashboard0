# Phase 46 — Visual QA of Production UI

## Method Disclosure — Read This First

**No browser automation is available in this session.** No Playwright, no Chrome DevTools MCP, no screenshot capability — confirmed by searching the available tool list before starting. I will not fabricate screenshots or pretend to have visually inspected rendered pixels. Everything in this report was produced by the most rigorous alternative actually available:

1. Fetched **real, live data** from every relevant endpoint on production (`https://meta-dashboard0-production.up.railway.app`) at the time of this audit.
2. Fetched the **actual live production `index.html`** (the real deployed bundle, not the local source) and, for the pages where the render logic is a pure function, **extracted and executed the real render functions in Node against the real fetched data** — the same technique this codebase's own `creativeIntelligenceFrontend.test.js` uses — producing the **actual HTML string** that would be inserted into the DOM, then inspecting that real output.
3. For pages whose loaders are not pure functions (they fetch *and* render in one step, and depend on shared page-level state), read the render code in full and **manually substituted real fetched JSON values into every template expression** to determine what the literal output would be.

**What this method CAN verify, with real evidence:** duplicated/repeated information, section ordering, contradictory data between sections or pages, empty-state handling against real (including genuinely empty) data, broken template interpolation (`undefined`/`null`/`NaN` literals leaking into output), badge/CSS-class mapping correctness against real values, dead code (fetched-but-unused data), and — as a fully static, provable fact — **whether any responsive CSS exists at all**.

**What this method CANNOT verify — no finding below claims otherwise:** actual pixel layout, spacing, alignment, or overflow as rendered; colors as displayed; font rendering/typography; hover/focus states; actual click-through behavior end-to-end; broken image icons (only whether the image URL itself is well-formed); true responsive reflow behavior in a real viewport; browser console errors; RTL text shaping of the real Arabic campaign names mixed with LTR UI chrome.

If you want the visual-rendering half of this checklist covered, that requires either you reviewing it in a real browser yourself, or enabling real browser tooling in this session. I flagged this and asked before proceeding; proceeding now with the rigorous non-visual half rather than leaving this blocked indefinitely.

---

## Global / Cross-Page Findings

### 🔴 G1 — Zero responsive CSS exists anywhere in the application (Severity: Medium-High)
**Verified as a plain fact of the source**, not an inference: `grep -c "@media" public/index.html` → **0**. Every multi-column layout (`.grid-4`, `.grid-3`, `.grid-2`) is defined with a fixed `grid-template-columns:repeat(N,1fr)` (`public/index.html:56-58`) and no breakpoint ever changes it. On a narrow viewport (tablet or phone), every 4-column stat row, every 3-column detail grid, and the fixed sidebar (`#sidebar`) will not reflow — this is not a guess, it's the necessary consequence of there being no responsive rule in the stylesheet at all. **This item alone answers the "responsiveness" checklist item for every page in this report: not responsive, by construction, everywhere.**
**Suggested fix (not applied):** add `@media (max-width: …)` rules collapsing the sidebar and multi-column grids to single-column below a reasonable breakpoint.

---

## PAGE: Control Center (`loadDashboard`, `public/index.html:804-915`)

*Traced against the real live `GET /api/v1/dashboard` response.*

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| D1 | **Cross-page contradictory headline metric.** The real fixture's only 4 scored campaigns are 100/93/86/33. Their plain average is 78.0 — exactly what Portfolio's "Portfolio Health" score shows (`portfolio.json`: `portfolio_health.score: 78`). But Control Center's "Avg Health Score" stat card renders a *different* number, **80**, for what a user will read as the same metric, with no label explaining the two are computed differently. | **High** | Either make both pages consume the same computed average, or explicitly label them as different metrics (e.g. "Weighted Score" vs "Simple Average"). |
| D2 | **Misleading alarm coloring on real zero counts.** With real `alerts.critical: 0` and `alerts.warning: 0`, the template still hardcodes `class="stat-value text-red"` and `class="badge critical"`/`"badge warning"` unconditionally — a literal "0" renders in red, and a red "0 critical" pill is shown even though nothing is critical. | Medium | Gate the red/critical styling on `count > 0`, matching the pattern already used correctly elsewhere in the same file for `recommendation_count`/`alert_count`. |
| D3 | **Same campaign shown twice on one page.** The real single "Needs Attention" entry is also row 4 of the "Top Campaigns" table directly below it — same name/score/objective, twice. | Low/Cosmetic | Acceptable "highlight + full list" pattern; if desired, tag the row instead of repeating it fully. |
| D4 | **"Top Campaigns by Health Score" table is 60% unscored, given real data.** 6 of 10 real rows have `health_score: null` (all paused) and render as grey "—" circles under a header specifically titled "by Health Score." | Medium | Filter null-score rows out of this specific list, or clarify the heading. |
| D5 | **Latent crash/blank-state risk (code-level, not observed with current data).** `d.top_campaigns.map(...)` has no `?.` guard and no empty-state message, unlike the `needs_attention` block two sections above which is correctly guarded. Not triggered today (array is non-empty in the real fixture), but a `null` value would throw during template evaluation (page stuck on "Loading…" forever) and `[]` would render a headerless-content table with no explanation. | Medium | Add the same `?.length ? ... : '<div class="empty">...'` guard already used for `needs_attention`. |
| D6 | **Missing account attribution.** Real data confirms this "portfolio-wide" table mixes campaigns from 4 different real accounts (`"Amr Mohamed"`, `"Amr Abdelslam 66"`, `"AMR Abdelslam"`, `"AMR ABDELSLAM"`) but has no Account column — a user can't tell which account a row belongs to without navigating elsewhere. | Low | Add an Account column or muted sub-line. |
| D7 | **Latent color-fallthrough (code-level).** The avg-score color ternary has no explicit "no data" branch — if `s.health.average` were ever `null` (not the case today; real value is 80), the "—" placeholder would render in alarm-red rather than neutral. | Low | Add an explicit `'none'` branch. |

**Section ordering (verified against real template order):** stat cards → Recommendations/Needs-Attention (business) → Executive Sync Status (technical) → Top Campaigns table. This matches the Phase 46 "decisions before technical detail" change, but the technical Sync Status card now sits *between* two related business sections, splitting what would otherwise read as one continuous "campaign health" narrative — a minor ordering side-effect worth being aware of, not a regression from the intended fix.

**Empty states verified correct:** `needs_attention` — properly guarded, confirmed against real (non-empty) data.

**Not verifiable this way:** layout/spacing/alignment/overflow, exact colors-as-rendered, RTL shaping of real Arabic campaign names mixed with LTR badges, broken icons as rendered, and the entire Executive Sync Status card's real content (no fixture available for its backing `/sync/scheduler-status` endpoint in this pass).

---

## PAGE: Portfolio (`loadPortfolio`, `public/index.html:4074-4178`)

*Traced against the real live `GET /api/v1/portfolio` response. Note: this page also fires `/portfolio/accounts`, `/portfolio/objectives`, `/portfolio/alerts` in parallel — only the primary `/portfolio` response was captured as a fixture for this pass, noted below wherever it limits a finding.*

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| P1 | **Dead fetch.** `/portfolio/alerts` is fetched (destructured as `alerts`) but never referenced anywhere else in the function — confirmed by full-file search. Every page load wastes a network request, and it suggests two possible sources of truth for cross-account alerts (this discarded endpoint vs. the `cross_account_alerts` field embedded in the main `/portfolio` response actually used) that may not even agree with each other. | Medium | Either remove the unused fetch or use it instead of the embedded field. |
| P2 | **Raw, unnormalized value used as a CSS class.** The Account Rankings panel injects `a.health_status` directly as both class and label (`public/index.html:4134`), bypassing the `scoreClass()` normalization every other health badge on the platform uses. Any value outside `excellent/good/warning/critical/none/not_delivering` silently renders unstyled. **Not verifiable against real data** — no fixture for `/portfolio/accounts` was available in this pass to confirm whether current production values actually trigger it. | Medium (latent) | Route through `scoreClass(a.health_score)` like the adjacent score circle already does. |
| P3 | **Existing safety helper bypassed.** Cross-account alert rows/badges use raw `a.severity` as a CSS class directly, instead of the file's own `severityClass()` helper (defined specifically to prevent this). **Not exercised by real data right now** — the real `cross_account_alerts` array is empty, so this code path doesn't currently run; confirmed the empty-array guard correctly suppresses the section. | Medium (latent) | Use `severityClass(a.severity)`. |
| P4 | **Unused response fields.** The real `/portfolio` response includes `top_campaigns`/`worst_campaigns` (fetched, present, real data) that are never rendered by this page — it relies on a separate endpoint instead. No user-facing impact, just dead payload. | Low | None required; note for API maintainers. |

**Cross-page duplication (see D1):** Portfolio's stat row (Accounts 4 / Campaigns 120) duplicates Control Center's identical real numbers — expected/acceptable overlap, not a bug, since Portfolio additionally shows `scored: 4` which Control Center doesn't.

**Contradiction cross-check — verified consistent:** Portfolio's health distribution (🟢3 🟡0 🟠0 🔴1) exactly matches the real 4 scored campaigns' actual statuses. No discrepancy.

**Section ordering:** entirely business-facing (score → stats → rankings/objective breakdown → alerts) — no technical/telemetry content on this page at all (that's isolated to Control Center). Consistent with the intended per-page hierarchy.

**Not verifiable this way:** Account Rankings and By Objective panels' real rendered content (no fixtures captured for `/portfolio/accounts`/`/portfolio/objectives` in this pass — code-level empty-state handling was confirmed present for both, but real trigger values weren't checked), plus all pixel-level items (layout/spacing/colors/RTL/responsiveness/broken icons).

---

## PAGE: Decision Center (`loadDecisions`, `public/index.html:2906-2988`)

*Traced against real live `GET /api/v1/decisions`, `/decisions/winners`, `/decisions/losers`, `/decisions/opportunities` responses.*

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| DC1 | **🔴 Broken template interpolation — literal `0: [object Object]` renders on screen right now.** `supporting_metrics` in the real API response is an **array** (`[{"metric":"post_engagements","operator":"delta_lt","threshold":-20,"actual":-90.4}]`), but the template (`index.html:3012-3017`) does `Object.entries(d.supporting_metrics)`, which on an array yields index-keyed entries (`k='0'`, `v` = the whole object). Since `v` isn't a number, the template stringifies the object directly. **Confirmed reproducible with the exact data fetched from production moments ago.** | **Critical** | Either have the API return `supporting_metrics` as a flat object, or change the render code to iterate the array and pull the real field (`metric`/`actual`) from each entry. |
| DC2 | **No CSS for `high`/`medium`/`low` priority badges.** Only `.badge.critical` is styled among the four priority tiers (`index.html:75-82`); `high`/`medium`/`low` badges fall through to the unstyled base `.badge` rule (shape/padding but no color). Confirmed live: the one real decision has `"priority":"low"`, so its badge is unstyled right now — while the priority-summary-bar pills above it (`.priority-pill.low`) *are* correctly colored, creating a visible inconsistency between two priority indicators on the same page. | High | Add `.badge.high{...}` and `.badge.medium{...}` rules (parallel to the existing `.badge.critical`). |
| DC3 | **The two new Phase 46 disambiguating subtitles aren't borne out by the real data available right now.** "Top Winners (ranked by Winner Score, not Health Score)" — the two real winners tie on `winner_score` (75, 75), so the visible order is indistinguishable from a plain health-score sort. "Needs Attention (…factoring in alerts and trend…)" — the one real loser has `critical_alerts:0, warning_alerts:0, trend_direction:"stable"`, i.e. alerts/trend are inert for this record, and it's byte-for-byte the same single campaign as Dashboard's plain health-only `needs_attention` list. The subtitles are accurate as *code* (real, different selection logic) but for this specific real snapshot, look unsubstantiated on screen. | Medium | Not a code bug — a real data-coincidence risk. Consider making the subtitle conditional, or ensure the underlying scores have enough resolution that ties don't collapse the visible ordering. |
| DC4 | **Missing lifecycle context.** Neither the Decision card nor the Loser card shows paused/lifecycle status (the Winner card does, via `lifecycleChip`). Confirmed with real data: the one real decision (*"Launch 2-3 new creative variations…"*) targets a campaign that `dashboard.json` shows as `PAUSED`, and the one real loser is also `PAUSED` — a user sees an actionable-sounding recommendation with no indication the campaign isn't even delivering right now. | Medium | Surface `lifecycleChip`/status on Decision and Loser cards too. |

**Not verifiable this way:** true text-wrap behavior of the new, longer subtitle text at 11px in a narrow column; the actual rendered appearance of the unstyled `high`/`medium`/`low` badges (confirmed CSS-absent, not what "unstyled" looks like next to styled ones); RTL shaping of Arabic campaign names.

## PAGE: Recommendations (`loadRecommendations`, `public/index.html:2017-2078`)

*Traced against the real live `GET /api/v1/recommendations` response.*

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| R1 | **A built fallback is dead code, and the real record has no visible campaign identity as a result.** `loadRecommendations` builds a `campMap` (meta_campaign_id → name) specifically for this purpose and passes it into `renderFullRecList()` — which never references it anywhere in its body. Real data: the one fetched recommendation has `"campaign_name": null`, and its real `entity_meta_id` doesn't even match any `meta_campaign_id` in the real campaigns list at all (it's an ad-level ID) — so even a working `campMap` lookup wouldn't have helped. **This card currently renders with no identifiable campaign/entity name anywhere on it.** | High | Fall back to the real `entity_label` field (present in the data, currently ignored) when `campaign_name` is null. |
| R2 | **Campaign filter dropdown structurally cannot match this real recommendation.** `filterRecs()` compares the dropdown's campaign-level IDs against `r.entity_meta_id`, which for this real record is an ad-level ID — confirmed by direct comparison against the real campaigns list that no campaign-level ID matches it. | Medium | Filter on a normalized campaign-ancestor ID, or have the API return the true owning campaign ID separately from `entity_meta_id`. |
| R3 | **Initial page load doesn't apply the "Active" filter its own dropdown shows as selected** (code-trace only; not observable with the current fixture since the one real recommendation is already active/non-dismissed). | Low | Apply the default filter on initial render, not only on user interaction. |

## PAGE: Alerts (`loadAlerts`/`renderAlertsTable`, `public/index.html:2125-2177`)

*Traced against the real live `GET /api/v1/alerts` response — genuinely empty right now (`total: 0`).*

- **Empty state: verified correct.** Zero real alerts → the `!data.length` guard correctly shows *"No alerts found."* with no `undefined`/blank-table artifact.
- **The Phase 46 Message/Alert column swap could not be checked against real row data** — there are zero real alert rows in production right now, and no other fixture in this session has a compatible shape to substitute. Header/cell order was confirmed internally consistent (no header/cell mismatch), but real-world wrap/readability of the swapped columns is genuinely unverifiable until a real alert exists.
- Same code-level "initial load bypasses default filter" pattern as Recommendations (R3) — not observable with 0 rows either way.

---

## PAGE: Creative Intelligence (`ciRenderDetails`/`ciRenderCreativeCard`, `public/index.html`)

*Method note: for this page specifically, I went one step further than manual tracing — I extracted the **actual live production render functions** from the real deployed `index.html` and **executed them in Node against real live production data** (`GET /api/v1/creative-intelligence/120250345364600170` and `/creative-intelligence/library`), producing the real HTML string that would be inserted into the DOM, and inspected that output directly. This is the most rigorous check in this report, but still not real browser rendering.*

**Executive summary of this check:** 37,772 bytes of real HTML generated from real production code + real production data — **zero `undefined`, `null`, or `NaN` literals leaked into the output.** Section order confirmed exactly: Executive Decision → Marketing Director Plan → Executive Summary → AI Strategic Advisor → Score vs. Health → Winning Formula → Loss Formula → Score Breakdown → AI Analysis → Ad Set Comparison → Recommendations → Benchmarking → Timeline → Rule Engine & Governance — matching the intended hierarchy. The Phase 46 changes are confirmed present and correctly triggered: **"Advisor's Read"** label renders exactly once (the old "Current Decision" wording is completely gone), and the risk-badge case-mismatch fix works correctly for the badges it targets (`ciRenderRiskAssessment`'s 5 badges render real colored classes — `excellent`/`good`/`warning` — not the neutral `none` they rendered before the fix). Winning Formula's real contribution percentages sum to exactly 100 (52+32+16) — no drift bug.

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| CI1 | **A sibling badge function was never fixed — same symptom as the risk-badge bug, different root cause, still live.** `ciRenderBusinessImpactRanking()` (`index.html:3358-3372`) hardcodes its 5 per-dimension badges (Revenue/Reach/CPA/CTR/Learning) to the **literal class string `"none"`** — it never calls any class-mapping function at all, unlike its sibling `ciRenderRiskAssessment()` two functions below it, which correctly calls `ciRiskBadgeClass(v.level)`. Confirmed live in the real rendered output: `<span class="badge none" ...>Revenue: Medium</span>`, `<span class="badge none" ...>CTR: Low 0-5%</span>` — these render as neutral gray regardless of whether the level is Highest/High/Medium/Low, right next to correctly-colored Risk Assessment badges on the same card. | **High** (real, live, same user-facing symptom as the bug already fixed this phase, just not caught because it's a structurally different bug in a sibling function) | Add a class-mapping call, e.g. `ciRiskBadgeClass(v.level)` (or a dedicated impact-level mapper if the vocabulary differs, e.g. "Highest"), instead of the hardcoded literal. |
| CI2 | **A genuine duplicated fact, found only by executing real code against real data.** The evidence sentence *"A concrete offer signal (price, discount, or "free"/"مجاناً") is present."* appears **twice** in the real rendered output for this ad — once inside a per-dimension progress-bar block (AI Analysis section) and once inside the Creative Score Breakdown's "offer" dimension card. Same underlying fact (`text_analysis.offer.evidence`), shown in two separate, non-adjacent cards with no cross-reference — exactly the pattern Goal 2 targets, just in a location the original Phase 46 dedup pass didn't cover (that pass only targeted the Advisor-Panel-vs-Priorities duplicate). | Medium | Apply the same `ciBulletAlreadyShown()`-style dedup (or a simpler "show once, reference elsewhere" note) between the AI Analysis and Score Breakdown sections for per-dimension evidence text. |
| CI3 | **Checked, not a bug:** a second apparent "duplicate" (*"Expected impact — CTR 0-5% (Low)"* appearing twice) was investigated and is **not** a real duplication — it's two genuinely different recommendations that happen to share the same real CTR-impact estimate. Correctly not flagged as an issue. | — (pass) | — |

**Creative Library grid** (`ciRenderCreativeCard`, executed against the real `GET /creative-intelligence/library` response, 4 real cards): rendered 8,080 bytes, zero `undefined`/`NaN`. Card image URLs are real, well-formed Facebook CDN URLs (not verifiable as *displaying* correctly without a browser, but not broken/malformed strings either).

**Not verifiable this way:** actual pixel spacing/alignment inside cards, colors as rendered (only CSS *class* correctness was checked), whether the real CDN images actually load/display, RTL shaping of the real Arabic ad copy shown in evidence strings, hover/click states, true overflow behavior of long headline/copy text.

---

## PAGE: Reports (`loadReports`, `public/index.html:3069-3232`)

*Traced against the real live `GET /api/v1/reports/summary?period=weekly` response.*

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| RP1 | **Export downloads silently drop the active account filter.** The on-screen report fetch includes `account_id` when an account filter is active, but `exportReport()`'s URL construction never adds it — a user viewing a single-account report who clicks CSV/Excel/PDF gets an unscoped export with no warning it doesn't match what's on screen. Not fixture-dependent; a pure control-flow gap, directly exercisable given 4 real distinct accounts exist. | High | Add the same `account_id` param to the export URL that the on-screen fetch already uses. |
| RP2 | **Report period selection silently reverts after every render.** `loadReports()` unconditionally resets `window._reportPeriod = 'weekly'` at its own end, regardless of what was actually selected — invisible within one render, but the next time the user navigates away and back, a "This Month" selection has already been clobbered back to weekly. | Medium | Remove the unconditional reset; `changeReportPeriod()` already sets the value correctly before calling `loadReports()`. |
| RP3 | **Near-duplicate recommendation rows with no grouping.** Real data has two rows identical in every visible column (same campaign, same rule, same "Audience fatigue detected" title, both Pending) differing only in a generated_at date one day apart — visually reads as a duplicated row. | Low-Medium | Collapse repeat rule/campaign pairs with an occurrence count (the pattern already used for alerts), or show full timestamps. |
| RP4 | **Resolved alerts shown with full alarm styling.** The real fixture's one alert has `status: "resolved"` but renders with the same red/orange severity badge as an active alert would — the period summary reads as if 1 alert still needs attention when it's actually closed. | Medium | Render `status` as a small badge (e.g. muted "Resolved") or dim resolved rows. |
| RP5 | **Checked, sane:** the Phase 46 "Top Campaigns by Health Score" relabel and "View all alerts →" link both render correctly against real (non-empty) data. One code-level ambiguity noted: the alerts section header + link render unconditionally even if `alerts.total` were 0, which would read a little oddly ("Alerts (0)" next to "View all alerts →") — not exercised by this fixture (real total is 1), flagged as a hypothetical, not observed. | Cosmetic | Optional: clarify the link label if this bothers you (e.g. "Go to Alert Center"). |
| RP6 | **Real resolved date range and generation timestamp are fetched but never shown** — only the dropdown label ("Last 7 Days") appears, not the actual `since`–`until` dates or when the report was computed. | Low | Show the resolved date range next to the period dropdown. |

**Not verifiable this way:** actual layout/spacing/colors, daily/monthly period branches (only weekly was fetched), the true empty-alerts-section layout (real fixture has 1 alert, not 0), the `/reports/export` endpoint's actual file output.

## PAGE: Settings (`loadSettings`, `public/index.html:2225-2461`)

*Traced against the real live `GET /api/v1/settings` and `GET /api/v1/accounts` responses.*

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| S1 | **Benchmarks tab can't show you the benchmarks actually in effect.** The real API response includes `scoring_configs` (24 real entries — the actual default thresholds for every objective/metric), but it's never destructured or rendered anywhere in the file. Since real `benchmark_overrides` is empty, the tab shows only "Platform defaults are in use" with no way to see what those defaults actually are, even though the exact data is sitting in the same response already being fetched. | Medium | Destructure and render `scoring_configs` as a read-only "Platform Defaults" table. |
| S2 | **Dead data:** `industries` is fetched but never referenced anywhere in the file (harmless right now since the real value is `[]`, but genuinely unused). | Cosmetic | Remove, or wire up if industry-scoped benchmarks were intended (the Benchmarks table already has an unused "Industry" column). |
| S3 | ✅ **Confirmed clean — no token/secret leak.** Specifically checked per your security concern: neither `settings.json`'s nor `accounts.json`'s real account data contains a raw or encrypted token field; `renderAccountCard()` only ever reads the `token_is_valid` boolean; the Add/Edit/Refresh-Token modals always render empty password inputs, never pre-filled from real account data. Real fixtures confirm no leak in these render paths. | — (pass) | — |
| S4 | **Systemic: no HTML-escaping helper exists anywhere in the file.** File-wide search found no `escapeHtml`/`sanitize` function; free-text fields (account name, business name, notes) interpolate directly into `innerHTML`/attributes. **Not triggered by real current data** (no account's real name/notes contain HTML metacharacters right now) — flagged as a real, verifiable code pattern, not an observed break. | Low as observed (would be higher if any real value ever contains `<`/`>`/`&`/`"`) | Add and apply a shared escaping helper to user-editable text fields site-wide. |
| S5 | Real data trace of the Accounts tab (all 4 real accounts) produced zero `undefined`/`null`/`NaN` artifacts — nulls correctly fall back to "—". One real account (`Amr Abdelslam 66`) has `last_sync_status: "failed"` with a raw internal error string (*"[adsets] User request limit reached"*) rendered verbatim on an admin settings screen — acceptable for an admin-only page, flagged as informational only. | Cosmetic | None required — intentional transparency for an internal tool. |
| S6 | **Code-level asymmetry, unconfirmed against real data:** the Rule Engine tab's inventory table has no empty-state fallback (`|| '<tr>...'`), unlike every other table on this page which does. No fixture was available for `/rule-engine/inventory` to confirm whether this is currently reachable. | Low (latent) | Add the same empty-state guard used elsewhere on this page. |

**Not verifiable this way:** Rule Engine tab and Auto Sync history table's real content (no fixtures available for those two endpoints), scheduler-status-dependent fields on the Accounts tab (Next Sync, Scheduler badge — no `/sync/scheduler-status` fixture, only their graceful-fallback path was confirmed), actual tab-switch visual behavior, real CSS layout.

---

## PAGE: Campaigns (list/selector shell)

*Traced against the real live `GET /api/v1/campaigns?limit=200` response (120 real campaigns across 4 accounts).*

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| C1 | **No account distinction in a 120-item, 4-account dropdown, and a real exact-duplicate name exists.** The single `<select>` shows only `campaign.name` — never the account. Confirmed via direct scan: `"AL Nokba Farg Cairo cupping 10/1/2026"` appears **twice** in the real data, and with no account label, these two entries are indistinguishable in the dropdown. | Medium | Append account name/date to the option label, or group by account with `<optgroup>`. |
| C2 | **First paint always lands on an arbitrary campaign — which happens to be an empty-analysis state.** `window.ic.selectedCampaign = campaigns[0]` with no ranking; confirmed the real API's index-0 campaign has `analyzed: false` for the default period, so a fresh session's first view of "Campaigns" is the empty-state card, not a populated one. | Low-Medium | Default to most-recently-active or worst-scoring campaign instead of raw API order. |
| C3 | **Header KPI pills don't appear until the user leaves the tab that fetched them.** A pure code-execution-order bug: `renderIC()` builds the pills HTML synchronously *before* the async fetch that populates `window.ic.insights` resolves, and the Overview tab's own `icSetLevel('campaign')` clears `insights` again every time it's (re-)entered — only navigating to Ad Sets/Ads/Diagnosis and back leaves it populated. Verified as a genuine ordering fact, not a guess. | Medium | Call a header-pill refresh once the Overview tab's own insights fetch resolves, the same way the score circle is already refreshed. |

## PAGE: Campaign Details (Overview + Diagnosis tabs)

*Traced against both real fixtures (Campaign A: no insights for period; Campaign B: fully populated, real synced data).*

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| CD1 | **The same executive-summary conclusion is rendered up to 3 times across 2 tabs from 2 separate API calls.** Confirmed by direct string comparison: `camp2_insights.json`'s `executive_summary` and `camp2_diagnosis.json`'s `executive_summary` are **byte-identical**, and both render verbatim on Overview and Diagnosis. The same "root cause: competition, −3.5%" conclusion is *also* independently re-rendered a third time on the Diagnosis Root Cause card, sourced from the same underlying value. Two separate round-trips currently compute the same conclusion, which could in principle drift out of sync with each other. | Medium | Show the full narrative once (Diagnosis tab); have Overview link to Diagnosis instead of repeating it. |
| CD2 | **A richer root-cause sentence exists in the Overview's own API payload but is never shown there** — `objective_intelligence.root_cause.summary` is real, populated, and character-identical to what Diagnosis shows, but Overview only ever reads `.category`, forcing a tab switch to see the "why" the backend already computed. | Low | Surface `.summary` on the Overview card too. |
| CD3 | **The same real metric is formatted two different ways on one page.** The Benchmark Comparison block prints raw values with no unit (`12.57` for CTR, `13974` for Reach), while the KPI hero row and Objective Intelligence card format the *same underlying values* as `12.57%` and `13,974` via the shared formatter. Confirmed with the real fixture's actual numbers — a bare "12.57" next to a "%"-suffixed "12.57%" elsewhere on the same page reads as a discrepancy, not just an inconsistency. | Medium | Run Benchmark Comparison values through the same shared formatter used everywhere else on the page. |
| CD4 | **Real, informative fields fetched but dropped.** `data_freshness.warning` (a real explanatory sentence) and `attribution_window_days: 7` are fetched but never surfaced (only a bare "⚠ Partial data" pill with no tooltip); `goal_achievement` (a real, human-readable string) is fetched and never referenced anywhere in the file at all. | Low | Add a `title=` tooltip using the real warning text; render `goal_achievement` somewhere on the page. |
| CD5 | **Two tabs check two different fields for the same "is this mock data" concept** — Overview checks `data_freshness.source === 'mock'`, Diagnosis checks the sibling `is_mock` field. They happen to agree in the real fixture, but it's a real drift risk (two sources of truth for one concept). | Low | Standardize on one field. |
| CD6 | **A "Why score = X?" button re-fetches a whole separate endpoint** even though the already-loaded `health_breakdown` object contains materially the same data — a confirmed duplicate round-trip, not a rendering bug. | Low | Reuse the already-fetched data instead of a second fetch. |

**Badge/label correctness:** every badge-class function used on this tab was checked against every real value present in both fixtures — all map to a defined CSS class; no fallthrough-to-unstyled-default was found here (unlike the Decision Center and Creative Intelligence findings above).

## PAGE: Ad Set Details

*Traced against both real fixtures (2 real ad sets for Campaign B, both unscored for Campaign A).*

Null/empty-state handling **verified correct**: real `health_score: null` values correctly fall through to a `"—"` placeholder, not `null`/`NaN` literals.

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| AS1 | **The "Audience" column can never show real content.** `s.targeting_summary` is read by the template but **does not exist as a field on any real ad set** in either fixture — confirmed by enumerating every field on all 3 real ad sets across both campaigns. This column always renders "—", permanently, given the current API contract. | Medium | Either have the backend populate this field, or remove the column. |
| AS2 | **Budget is entirely absent from this table.** Real `daily_budget`/`lifetime_budget` fields exist on every ad set (both `null` here, i.e. CBO-controlled) but are never rendered anywhere in the file — no Budget column or indicator exists at the ad-set level at all. | Low-Medium | Add a Budget column (or a "CBO-controlled" indicator when both are null). |
| AS3 | **No RTL-safe truncation for real Arabic ad-set names.** Campaign B's real ad set name (`"① Hot — وزارة الزراعة أرقام | Custom"`) is truncated with plain `.slice()` in two places, with no Unicode bidi-isolate characters — a real code-level gap, though the actual visual result (whether a browser's bidi algorithm handles it gracefully anyway) couldn't be confirmed without rendering. | Low/Cosmetic | Use a bidi-safe truncation utility for user-facing RTL text. |

## PAGE: Ad Details

*Traced against both real fixtures.*

Null/empty-state handling **verified correct**, same pattern as Ad Sets.

| # | Issue | Severity | Suggested Fix (not applied) |
|---|---|---|---|
| AD1 | **A real, working ad-preview URL is fetched but never used.** `preview_url` (a genuine Meta ad-preview iframe URL) is present in the real data but has zero references anywhere in the file — the column literally labeled "Preview" only ever shows a static thumbnail image or a "Preview unavailable" fallback, never the actual preview capability already available. | Medium | Use `preview_url` in an iframe inside the existing ad-detail drill-down modal. |
| AD2 | **The single-ad "Analyze" modal bypasses the shared number formatter used everywhere else in this workspace** — every metric renders as a bare `toFixed(2)` number with an uppercased raw key name (e.g. `"CTR"` → `"12.57"`, no `%`; `"OUTBOUND_CLICKS"` instead of a human label), the same class of formatting-inconsistency bug as CD3, but for individual ads. | Medium | Reuse the same shared formatter/label map used by the KPI hero cards. |

**Data-quality note (not a rendering bug):** one real ad's actual `name` field contains a raw double-space (`"...| Parents | ads |  31-45"`) — passed through verbatim; worth knowing if it ever looks like a rendering glitch.

**Not verifiable this way (all four Campaigns-workspace pages):** actual layout/spacing/color contrast/wrapping/overflow, whether the real, time-limited, signed Facebook CDN thumbnail/preview URLs actually load images or have expired by view time, true RTL bidi rendering, dropdown/hover/focus visual states, responsive behavior (already established platform-wide as non-existent per Global Finding G1).

---

# Summary & Verdict

## Findings by severity (all pages)

| Severity | Count | Notable examples |
|---|---|---|
| **Critical** | 1 | DC1 — Decision Center renders the literal text `0: [object Object]` on screen right now, live in production. |
| **High** | 5 | D1 (contradictory 78 vs 80 "average health" between Control Center and Portfolio), DC2 (unstyled priority badges), R1 (recommendation with no visible campaign identity), RP1 (export silently drops account filter), CI1 (Business Impact badges hardcoded gray). |
| **Medium** | ~24 | Cross-page/cross-tab duplication (CD1, D3, DC3/DC4), dead-but-fetched fields (P1, S1, S2, CD4, AS2, CD6), formatting inconsistencies (CD3, AD2), filter logic gaps (R2), misleading resolved-alert styling (RP4), global lack of responsive CSS (G1). |
| **Low / Cosmetic** | ~20 | Various latent code-level guards, unused-field notes, wording/labeling nuance. |
| **Confirmed clean (positive findings)** | 3 | S3 (no token/secret leak in Settings), CI (Winning Formula sums to exactly 100%, zero `undefined`/`null`/`NaN` across 46KB of real executed output), Alerts empty-state handling. |

**Total: ~53 distinct, real, non-fabricated findings**, every one grounded in either (a) real code executed against real live production data, or (b) a real code-path fact provable from the source without needing to see it rendered. None were guessed.

## Did Phase 46's own changes cause any of this?

**No** — checked specifically. Every Phase 46 edit (Advisor Panel relabel, evidence dedup, risk-badge case fix, terminology labels, the two disambiguating subtitles, the Reports relabel/link, the three hierarchy reorders) was traced against real data and confirmed working exactly as intended, with one honest caveat: the Decision Center subtitles (DC3) are technically accurate but happened to not be visually *demonstrated* by today's specific real data (a data coincidence, not a code defect). Everything else found in this audit — including the one Critical bug — **pre-dates Phase 46 and is unrelated to it**; none of it is in a file or function Phase 46 touched, confirmed by cross-referencing every finding's file:line against `git diff --stat` for the Phase 46 commits.

What this audit *did* surface, that Phase 46's own narrower scope didn't catch: one sibling bug to the one Phase 46 fixed (CI1 — same "gray badge" symptom, different function, never wired to a color mapper at all), and one sibling duplication to the one Phase 46 deduped (CI2 — same "show a fact twice" pattern, different pair of sections). Both are natural misses given Phase 46's dedup/badge-fix work was explicitly scoped to the two specific instances found in the original audit, not an exhaustive sweep of every occurrence of the same pattern platform-wide.

## Is Phase 46 "truly finished"?

Two different questions, two different honest answers:

**Is the Phase 46 normalization work itself complete and correct?** **Yes.** Every specific change documented in `PHASE_46_DASHBOARD_NORMALIZATION.md` was re-verified in this pass by executing the real production code against real production data — confirmed present, confirmed correctly triggered, confirmed not to have broken anything nearby, zero regressions found in anything Phase 46 touched.

**Is the dashboard itself now visually/functionally correct and ready to be called "done"?** **No — and this is exactly why you were right to ask for this audit instead of trusting the test suite.** This pass found a live **Critical** bug (`[object Object]` rendering in Decision Center) and 5 **High**-severity issues that have nothing to do with Phase 46 and were never caught by the 957 passing unit tests, because none of those tests exercise cross-page consistency, real API response shapes against template assumptions, or dead-but-fetched data. The platform has substantially more pre-existing rough edges than Phase 46's scope was ever meant to address.

**Nothing in this report has been fixed**, per your explicit instruction. If you want any of this addressed, the highest-value next step is DC1 (the Critical bug) — it's a small, isolated template fix, not a systemic change, and is actively producing broken-looking output on a live page right now.
