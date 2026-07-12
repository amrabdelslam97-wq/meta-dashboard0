# PHASE 38 — REAL-TIME DATA CONSISTENCY (NO REWRITE • NO NEW ARCHITECTURE)

**Date:** 2026-07-12
**Scope:** Improve consistency and freshness-transparency of the existing SQLite + Meta Graph API dual-data architecture. No redesign, no new data models, no SQLite migration, no Sync Engine replacement. Every change is the smallest possible additive compatibility layer.

*(Note: this report's regression/performance figures were finalized alongside Phase 39, which independently re-verified everything below against the real production database and confirmed zero regressions — see `PHASE_39_FINAL_SYSTEM_AUDIT.md` for the cross-phase verification pass.)*

---

## CURRENT ARCHITECTURE

Two data sources, unchanged this phase:
- **Local SQLite (via sql.js)**, populated by the Sync Engine (`syncService.js`/`smartSyncEngine.js`, stabilized in Phase 36). Holds campaign/ad-set/ad metadata, health scores, alerts, recommendations, analytics breakdowns.
- **Live Meta Graph API**, called directly (never persisted) for real-time Insights data by `metricsFetcher.js`/`metaApiClient.js`, protected by an in-memory TTL cache (`cacheService.js`: 10 min for current metrics/breakdowns/trend, 24h for prior-period, 30 min for metadata).

No architectural change was made to either side. The only new code this phase is a small, additive **freshness compatibility layer** (`src/services/freshnessHelper.js`) that reads the Sync Engine's *existing* tracking columns (`ad_accounts.last_successful_sync_at`/`last_sync_completed_at` — both already written by every sync, no new columns) and exposes a standardized shape.

---

## EVERY ENDPOINT CLASSIFIED

Full audit performed via systematic cross-reference of every `fetch()`/`api()` call in `public/index.html` against `src/api/router.js`'s 18 mounted routers, down to each route's actual DB/Meta calls.

| Route | Data Source | Cached? | Category |
|---|---|---|---|
| `/campaigns`, `/campaigns/:id`, `/campaigns/:id/history`, `/campaigns/:id/score-breakdown` | SQLite-only | No | A (historical/metadata) |
| `/campaigns/:id/insights`, `/insights/trend`, `/insights/breakdowns`, `/insights/diagnosis` | **Mixed** — DB metadata + live Meta Insights | Yes (10min current, 24h prior) | **C** (hybrid) |
| `/adsets`, `/adsets/:id`, `/adsets/:id/score-breakdown` | SQLite-only | No | A |
| `/adsets/:id/insights` | Mixed — DB metadata + live Meta Insights | Yes (10min) | C |
| `/ads`, `/ads/:id`, `/ads/:id/score-breakdown` | SQLite-only | No | A |
| `/ads/:id/insights` | Mixed — DB metadata + live Meta Insights | Yes (10min) | C |
| `/dashboard` | SQLite-only | No | **C** (cards combine historical health scores + current alert/rec state) |
| `/portfolio`, `/portfolio/accounts`, `/portfolio/objectives`, `/portfolio/alerts` | SQLite-only | No | C |
| `/accounts` (GET) | SQLite-only (incl. sync-freshness columns) | No | B-adjacent (surfaces sync status) |
| `/accounts` (POST), `/accounts/:id/token`, `/accounts/:id/test-connection` | **Meta-live** (token/permission verification) + DB write | No | B |
| `/sync` (POST) | Meta-live, writes DB | No | — (the Sync Engine itself) |
| `/sync/scheduler-status`, `/sync/history` | SQLite-only | No | B (operational status, sourced from last sync) |
| `/recommendations`, `/alerts` | SQLite-only | No | C |
| `/decisions`, `/decisions/winners`, `/losers`, `/opportunities` | SQLite-only | No | C |
| `/health-history`, `/reports/summary` | SQLite-only | No | A |
| `/rule-engine/inventory` | SQLite-only | No | — (config, not data) |
| `/analytics/*`, `/attribution/*`, `/budget/*`, `/intelligence/*` | SQLite-only | No | A — **not currently called by any UI button** (built, unused) |
| `/creative-intelligence/*` | SQLite-only | No | A/C — two frontend calls (`/library`, bare `/:adId`) hit non-existent routes (404), pre-existing, documented Phase 33/34 |

---

## DATA STRATEGY — CATEGORY CLASSIFICATION

**Category A (historical — SQLite, unchanged):** `/health-history`, `/reports/summary`, campaign/ad-set/ad metadata list endpoints, analytics breakdown history. All already SQLite-only; no change needed or made.

**Category B (live operational status):** `effective_status`/`status` on campaigns/ad-sets/ads are populated *from* Meta at sync time (not live per-request) — this is the existing, intentional design (CLAUDE.md/Phase 15). Making these truly live-per-request would mean a new Meta call on every dashboard load for every entity, directly violating this phase's own "Live Data Policy" (avoid rate limits, never pull data SQLite already has). **No live-merge was added for Category B fields** — instead, the freshness layer (below) makes the *staleness of the existing synced copy* visible, which is the correct minimal fix given the sync engine (Phase 36) already keeps this reasonably fresh when auto-sync is enabled, and the real risk (accounts with auto-sync *disabled*, which is all 8 real accounts today) is now surfaced honestly instead of hidden.

**Category C (hybrid):** Dashboard cards, recommendations, alerts, health scores — already combine historical metrics (health score history) with current state (active alert/recommendation counts) exactly as intended. No architectural change needed; the freshness layer was added here since these are the highest-traffic, most-trusted widgets.

---

## IMPLEMENTATION — SMALLEST POSSIBLE COMPATIBILITY LAYER

New file: `src/services/freshnessHelper.js` — two pure functions, zero Meta calls, zero new DB columns:
- `buildFreshness(account, thresholdMinutes)` — single-account freshness from existing sync columns.
- `buildPortfolioFreshness(accounts, thresholdMinutes)` — portfolio-wide, using the **oldest** synced account (errs toward flagging staleness, never hides it).

Wired additively into `dashboard.js` and `campaigns.js` — one new top-level `freshness` field appended to each response; **zero existing fields changed, removed, or restructured.** This is the `if (fresh_data_needed) { attachFreshness() }` pattern the phase brief asked for, applied to the two highest-value endpoints rather than every endpoint (a deliberate scope decision — see Remaining Limitations).

Frontend: the Dashboard's "Updated {time}" label previously showed the *browser's page-load time* (always looked fresh regardless of actual data age) — now reads the real `freshness.sync_age_minutes`/`stale` fields and renders "Updated 5m ago" / "Updated 2h ago (stale)", exactly matching the phase's required "Dashboard Indicators" behavior.

---

## STALE DATA DETECTION

`last_sync_at`, `data_source`, `sync_age_minutes`, `stale` are now present on `/dashboard` and `/campaigns` responses, live-verified:

```
GET /campaigns?account_id=X&preset=last_3_days → freshness: {"last_sync_at":"2026-07-12T06:10:40.483Z","data_source":"sqlite","sync_age_minutes":313,"stale":true}
GET /dashboard (no account_id, portfolio-wide)  → freshness: {"last_sync_at":"2026-07-07T13:37:53.992Z", ..., "sync_age_minutes":7066,"stale":true}
```
Confirmed: identical across different date presets for the same account (freshness tracks sync recency, correctly decoupled from the requested date window), and correctly reports the *oldest* account when scoped to "All Accounts."

---

## FORCE REFRESH

**Confirmed bug found and fixed:** `refreshData()` (fired by the Refresh button, and by every date-range/account change) always called `POST /sync/cache/flush` with an **empty body** — even though the backend already supported a scoped `{account_id}` flush (`cache.invalidateAccount()`), the frontend never used it, so *every* refresh flushed the *entire* cache for *all* accounts. Fixed: now sends `{account_id: window._accountId}` when a specific account is selected (verified live: scoped flush cleared 0 of 3 unrelated entries; unscoped flush cleared all 3 — two genuinely distinct, correctly-routed code paths). "All Accounts" view still does a full flush, which is correct for that view. Dashboard content is not cleared during this (the existing loading-spinner behavior during `navigate()` was left untouched — a UX characteristic, not a data-loss bug).

---

## CONSISTENCY AUDIT

Checked every named pairing for possible disagreement:

| Pair | Result |
|---|---|
| Dashboard `campaigns.active` vs Campaigns list active count | Same `status='active'` filter, same semantics — consistent in current data (verified: 0 campaigns where `status='active'` but `effective_status != 'ACTIVE'`) |
| Dashboard `alerts` vs Alerts list default filter | Identical `status='active' AND (snoozed_until IS NULL OR < now)` clause — consistent |
| Dashboard `recommendations` vs Recommendations list default filter | Identical `dismissed_at IS NULL` clause — consistent |
| **Dashboard alert count vs Portfolio per-account alert count** | **CONFIRMED BUG, FIXED** — `portfolioEngine.js`'s `getAccountRankings()` counted `active_alerts WHERE status='active'` only, omitting the snooze exclusion that `dashboard.js`/`alerts.js` already both apply. Currently dormant (0 snoozed alerts in production today) but would surface the instant anyone used the existing Snooze feature. Fixed by adding the identical `(snoozed_until IS NULL OR snoozed_until < datetime('now'))` clause; regression test added that fails without the fix (confirmed by reverting and re-running) and passes with it. |
| `/campaigns` list ignoring the date params the frontend attaches to it | Noted, not fixed — campaigns are metadata (not date-bound metrics), so this is a dead parameter, not a data-correctness bug; flagged for awareness only. |

---

## MINIMAL FIXES APPLIED

1. `src/services/freshnessHelper.js` (new file) — additive staleness computation, zero Meta calls.
2. `src/api/routes/dashboard.js`, `src/api/routes/campaigns.js` — one new `freshness` field each, no existing fields touched.
3. `src/services/portfolioEngine.js` — one-line query fix (snooze exclusion), matching existing sibling query logic.
4. `public/index.html` — `refreshData()` now passes `account_id` to the cache-flush call when one is selected; "Updated N ago" label now reflects real sync age instead of page-load time.

## LIVE META VERIFICATION

Live account-level check (`GET /accounts` → decrypt real token → `metaGet('me/permissions', ...)`) was already performed as part of Phase 36; not repeated here since no token/permission-handling code was touched this phase. Freshness computation itself makes zero Meta calls by design (verified via code read — `freshnessHelper.js` has no `require` of `metaApiClient.js`).

## REGRESSION RESULTS

Full suite (`CI=true npx jest`) after all four fixes: **2 failed suites / 13 failed tests** — identical to the documented Phase 34/36/37 baseline, plus 7 new passing tests (`freshnessHelper.test.js` ×6, `portfolioEngine` snooze-regression ×1). The two failing suites (`creativeIntelligence.test.js`, `smartSyncEngine.test.js`) are pre-existing and unrelated (confirmed in Phase 39's follow-up audit, which additionally proved this test suite has inherent run-to-run flakiness *independent* of any Phase 38 change — see that report for the full investigation).

## PERFORMANCE COMPARISON (before / after)

| Endpoint | Before | After |
|---|---|---|
| `/dashboard` (avg of 5) | ~56ms | ~54ms |
| `/campaigns?limit=200` (avg of 5) | ~17ms | ~16ms |

Measured via a disposable side-instance against the real production database, using `git stash`/`stash pop` to get a true before/after on the exact same data. Difference is within normal run-to-run noise — the one added indexed `SELECT` per request has no measurable cost. Zero new Meta API calls added (confirmed by code: `freshnessHelper.js` never imports `metaApiClient.js`).

## REMAINING KNOWN LIMITATIONS

1. **Freshness metadata was added to `/dashboard` and `/campaigns` only**, not to every endpoint. This was a deliberate minimal-scope decision — propagating it to all ~15 route files in one pass would be a much larger, riskier change than "the smallest possible compatibility layer." These two are the highest-traffic, most-representative widgets; extending the same pattern to `/adsets`, `/ads`, `/portfolio` is a natural, low-risk follow-up using the exact same helper.
2. **No live-merge (`if(live_available){ mergeLiveFields() }`) was implemented for Category B fields** (effective_status, budget remaining, etc.). Given the "avoid rate limits" / "never pull data SQLite already has" constraints, and that the real gap (accounts with auto-sync disabled) is now honestly surfaced via `stale=true` rather than silently masked, adding new per-request Meta calls was judged higher-risk than valuable for this pass. Flagged for a future phase if live-merge for specific fields becomes a confirmed product need.
3. No browser automation tool was available to visually confirm the "Updated N ago" label's rendering — verified via served-HTML code presence and the underlying API field, not a screenshot.
