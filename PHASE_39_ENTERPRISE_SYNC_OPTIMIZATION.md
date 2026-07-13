# Phase 39 — Enterprise Smart Sync Optimization

**Goal:** eliminate "User request limit reached" in production by making synchronization *smart*, not faster — without redesigning the architecture, rewriting the sync engine, removing any feature, or renaming any API.

> **Naming note:** `PHASE_39_FINAL_SYSTEM_AUDIT.md` and `PHASE_39_FULL_REGRESSION_REPORT.md` already exist in this repo from a prior QA audit pass over Phases 31–38 (unrelated implementation work, coincidentally also numbered 39). This document is the feature work requested under the new "Phase 39 — Enterprise Smart Sync Optimization" brief. The two are independent; no content here supersedes or invalidates the earlier audit.

---

## 1. Starting point

Before writing any code, the existing sync stack was read in full (`syncService.js`, `metaApiClient.js`, `smartSyncEngine.js`, `autoSyncScheduler.js`, `src/api/routes/sync.js`, and the Phase 14/16/17/18 schema files). Most of what a "smart sync" brief asks for already existed, built across Phases 14–19 and 36:

- A tiered, per-entity-type scheduler (`smartSyncEngine.js`) with durable checkpoints (`sync_entity_state`) and execution logging (`sync_execution_log`).
- A 2-minute in-process scheduler (`autoSyncScheduler.js`), sequential multi-account queue, per-account cooldown.
- Rate-limit-aware retry in `metaApiClient.js` (HTTP 429 + Meta error codes 4/17/32/613/80000–80014).
- A rate-limit circuit breaker inside a single account's sync run (`syncService.js`).
- Multi-account support baked into the schema since Phase 1.
- Sync overlap guards and interrupted-sync recovery on startup.

What was genuinely missing, confirmed by reading the code rather than assuming:

1. No "active campaigns only" filtering anywhere — every sync (scheduled or manual) re-fetched every campaign/ad set/ad regardless of status.
2. No persisted rate-limit backoff — cooldown lived in an in-memory `Map`, forgotten on every restart/redeploy.
3. No proactive pacing between Meta API calls — only reactive backoff after a 429.
4. No distinction between "routine incremental sync" and "full historical reload" — Force Sync always did both at once.
5. A latent gap where a corrupted token or unexpected exception for one account could, in principle, abort the whole `syncAllAccounts()` batch.
6. `smartSyncEngine.js` carried its own hand-duplicated copy of `metaApiClient.js`'s rate-limit code set.

Phase 39 extends the existing stack to close exactly these gaps. Nothing below replaces an existing table, route, or exported function signature — every change is additive.

---

## 2. Architecture (unchanged shape, extended behavior)

```
Scheduler (2-min tick)  ──┐
Force Sync (manual)      ─┼──► smartSyncEngine.runDueForAccount(account, source, onEntityStart)
Refresh Active Data       │        │  (single choke point — wrapped in syncLock, requirement 16)
Full Rebuild / Full Sync ─┘        │
                                    ├─ Tier 1: insights        (metricsFetcher, cache-only, unchanged)
                                    ├─ Tiers 2-5: campaigns/adsets/ads/creatives
                                    │     └─ syncService.syncAccount(account, { activeOnly })
                                    │           └─ metaApiClient.fetch{Campaigns,AdSets,Ads}(..., { activeOnly })
                                    ├─ Tier 6: metadata         (unchanged)
                                    └─ Tier 7: analytics        (unchanged)

metaApiClient.metaGet()  ── adaptive delay + error classification + rate-limit retry (all requests, every tier)
rateLimitMemory.js       ── persists next_allowed_sync (ad_accounts.rate_limit_backoff_until)
syncLock.js               ── in-process per-account mutex (prevents any two triggers racing the same account)
```

Dashboard routes (`dashboard.js`, `campaigns.js`, `insights.js`, etc.) were re-confirmed to read exclusively from SQLite via `src/db/database.js`'s `run/all/get` helpers — none of them import `metaApiClient.js` or call Meta directly. This was already true before Phase 39 and remains true; no route changes were needed to satisfy requirement 11.

---

## 3. What changed, file by file

### `src/db/schema.phase31.js` (new)
Three additive columns on `ad_accounts`, wired into `src/app.js`'s `initializeApp()` after Phase 30:
- `rate_limit_backoff_until TEXT` — "next_allowed_sync" (requirement 9).
- `rate_limit_fail_count INTEGER NOT NULL DEFAULT 0` — drives exponential backoff growth.
- `last_full_sync_at TEXT` — when this account was last genuinely reloaded end-to-end (requirement 4), distinct from `last_sync_completed_at` (which every mode updates).

`ALTER TABLE ... ADD COLUMN`, idempotent via `PRAGMA table_info` check — same pattern as every prior phase schema file. Also wired into `tests/helpers/testDb.js` so the test suite exercises the same schema.

### `src/services/metaApiClient.js`
- **Active-only filtering** (requirement 1): `fetchCampaigns/fetchAdSets/fetchAds` accept an `options.activeOnly` flag. When true, a Meta `filtering=[{field:"effective_status",operator:"IN",value:["ACTIVE"]}]` param is sent — Meta filters server-side, so non-active objects never cross the wire at all. Defaults to `false`, so every existing caller is unaffected unless it opts in.
- **Adaptive delay** (requirement 8): a process-wide pacing level (`none`/`light`/`heavy`/`repeated` → 200/500/1000/3000ms), applied before every `metaGet()` call. Escalates on an actual rate-limit hit, and pre-emptively on Meta's own `X-Business-Use-Case-Usage`/`X-App-Usage`/`X-Ad-Account-Usage` response headers (≥90% utilization → `repeated`, ≥75% → at least `light`). Recovers gradually — 10 consecutive clean calls step the level back down one notch. A single process-wide level is correct here because accounts are always synced strictly sequentially (Smart Account Queue, requirement 7) — never two accounts' Meta calls in flight at once. Disabled under `NODE_ENV=test` (same precedent as `app.js`'s rate limiters and the scheduler itself) so the Jest suite isn't slowed by delays nock-mocked responses never actually need.
- **Error Classification** (requirement 14): every thrown error is now tagged with exactly one of `isRateLimit` (existing), `isAuthError` (Meta code 190/102/2500 or type `OAuthException`), `isPermissionError` (code 10/200 family), `isValidationError` (code 100/2635), `isTimeout` (existing), or `isNetworkError` (a real Node/libuv connectivity code — `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`ENOTFOUND`/etc., deliberately **not** "any error with no HTTP response," which also matches non-network failures). Each category gets its own retry strategy: rate-limit retries with exponential backoff (unchanged), network errors get a short 2-attempt retry, auth/permission/validation errors never retry (a bad token or malformed request won't fix itself).

### `src/services/rateLimitMemory.js` (new)
Reads/writes `ad_accounts.rate_limit_backoff_until`/`rate_limit_fail_count`. Replaces `autoSyncScheduler.js`'s old in-memory `cooldownUntil`/`cooldownFailCount` Maps — this is the concrete fix for requirement 9 ("Backoff Memory"): before this, a Railway redeploy or crash silently forgot every in-flight cooldown, so a just-throttled account would be hammered again immediately once the process came back up. Same exponential formula as before (1m, 2m, 4m, ... capped at 60m), just durable now.

### `src/services/syncLock.js` (new)
A tiny in-process `Set`-backed mutex keyed by `ad_account_id`, wrapping `smartSyncEngine.runDueForAccount()` — the single entry point every trigger (Scheduler tick, Force Sync, Refresh Active Data, Full Rebuild) funnels through. Whichever trigger gets there first for an account wins; a concurrent second trigger for the same account returns immediately (`{ skipped: true }`) instead of racing it. This is requirement 16 in full: there is no separate "startup sync" trigger in this codebase (only interrupted-sync *recovery*, which just marks stuck rows failed — it doesn't itself sync), so the lock at this one choke point covers every trigger that exists now or is added later.

### `src/services/syncService.js`
- `syncAccount(adAccount, options)` gained `activeOnly` (default `false`, backward compatible), threaded into all three Meta fetch calls.
- **Campaign Priority** (requirement 12): fetched campaigns are sorted in place (preserving `metaGetAll`'s `.incomplete` flag) — ACTIVE first, then most-recently-updated — so if a rate limit trips mid-account, the campaigns most likely to matter were already synced.
- **Error Classification follow-through**: an `isAuthError` on the initial campaign fetch now sets `ad_accounts.token_is_valid = 0`, so `syncAllAccounts()`'s and the scheduler's `WHERE token_is_valid = 1` filters stop repeatedly re-attempting a doomed sync every cycle until the user reconnects the account.
- **Automatic Recovery hardening** (requirement 15): `decryptToken()` is now wrapped in try/catch (a corrupted key previously threw uncaught, out of `syncAccount()` entirely), and `syncAllAccounts()`'s per-account loop is wrapped in try/catch so a genuinely unexpected exception for one account can never abort the accounts queued behind it.

### `src/services/smartSyncEngine.js`
- `runDueForAccount(account, source, onEntityStart)` now accepts `source ∈ {'scheduler', 'force', 'force_active'}`:
  - `'scheduler'` — the *only* mode the background scheduler ever uses. Always `activeOnly: true` (requirement 5).
  - `'force'` — Full Sync mode / Full Rebuild (requirement 4/6B). The *only* mode that ever reloads non-active objects. Never automatic. Sets `last_full_sync_at` on completion. Unchanged in every other respect — existing `forceSyncAccount()` callers and tests see identical behavior.
  - `'force_active'` (new) — Refresh Active Data (requirement 6A): bypasses cadence like Force Sync, but stays `activeOnly: true`. New exported `forceSyncActiveAccount()`.
  - A pending legacy `effective_status` backfill (Phase 15/17's one-time migration) temporarily overrides `activeOnly` to `false` for that one pass, so it can still genuinely backfill non-active rows; this never applies again once the account is marked complete.
- **Incremental Insights** (requirement 3): new `incrementalInsightsRange()` reads the insights tier's `sync_entity_state.last_success_at` watermark and requests only `[max(last_synced_date, 7_days_ago), today]` instead of always re-requesting the same fixed 7-day window — "detect latest synchronized date, request only missing periods, always include today, include yesterday for settling data." Applies only to `source === 'scheduler'`; Force Sync/Refresh Active still warm the familiar full default window on demand.
- **Campaign Priority for the insights tier**: `orderByPriority()` sorts by active-status then recency before warming the Insights cache, so the campaigns most likely to matter get warmed first if the cycle is cut short.
- `isRateLimitError` now imports directly from `metaApiClient.js` instead of a hand-duplicated local copy of the rate-limit code set (removes a real, if minor, drift risk between the two).

### `src/services/autoSyncScheduler.js`
- **Scheduler Priority** (requirement 10): the queue query's `ORDER BY` now encodes never-synced-first, then accounts with at least one ACTIVE campaign (tiebroken by staleness), then everything else, in one query — replacing the old flat oldest-synced-first ordering.
- Cooldown checks/writes now go through `rateLimitMemory.js` instead of the old in-memory Maps (see above).
- `getPerAccountStatus()`/`getSchedulerStatus()` read the persisted `rate_limit_backoff_until` column instead of the removed Maps, so the dashboard's "accounts in cooldown" view is accurate immediately after a restart, not just mid-process-lifetime.

### `src/api/routes/sync.js`
Two new, fully additive routes — `POST /sync` is completely unchanged:
- `POST /sync/refresh-active` — Refresh Active Data (Force Refresh A). `{ account_id? }`.
- `POST /sync/full` — Full Sync mode / Full Rebuild (Force Refresh B). `{ account_id? }`.

Both accept an omitted `account_id` to run sequentially across every active, token-valid account (same queue discipline as the scheduler, never parallel).

---

## 4. API call reduction

The concrete levers, in order of expected impact on a real multi-account, mixed-status portfolio:

1. **Active-only filtering** — the routine incremental cycle (the vast majority of all sync activity) now asks Meta to filter server-side to `effective_status=ACTIVE` on campaigns, ad sets, *and* ads. A portfolio with, say, 40% paused/archived campaigns sees a proportional drop in objects returned and written — those rows are never touched, never re-fetched, and never deleted; they simply aren't part of the incremental cycle's request.
2. **Incremental Insights windows** — the insights tier's date range shrinks from an unconditional 7-day re-fetch to `[days since last watermark, today]`, capped at 7 days. For an account synced regularly (the common case), this is typically a 1–2 day window instead of 7.
3. **Adaptive delay** — proactive pacing based on Meta's own usage headers means fewer calls hit an actual 429 in the first place (each 429 previously cost up to 3 retries × exponential backoff before surfacing).
4. **Persisted backoff memory** — an account already known to be in cooldown is skipped before any network call is attempted, every cycle, across restarts — previously this protection reset to zero on every redeploy.

**Explicitly not implemented:** real Meta Batch API request coalescing. This would be a materially larger, higher-risk change (a new request/response shape, new error semantics per sub-request) that cannot be safely validated without live Meta credentials in this environment. Given the "no rewrite, no regressions" constraint, this is documented as a follow-up rather than attempted blind. Field lists were audited but not trimmed — every currently-requested field is already load-bearing for an existing feature (confirmed via the Phase 39 research pass); removing any would violate "do not remove any feature."

---

## 5. Synchronization flow (after this phase)

**Routine (automatic, every 2 minutes, scheduler-only):**
1. Query due accounts, ordered by priority (never-synced → has-active-campaigns/stale → rest).
2. Skip any account still in persisted backoff.
3. `runDueForAccount(account, 'scheduler')` — acquires the per-account lock, runs whichever tiers are due, **active-only**, incremental insights window.
4. On success: clear backoff. On rate-limit: persist a new backoff window for *that account only*; the loop continues to the next account (requirement 15 — one throttled account never stops the cycle).

**Manual — Refresh Active Data:** `POST /sync/refresh-active` → `forceSyncActiveAccount()` → every tier, bypassing cadence, still active-only. Cheap, safe to click often.

**Manual — Full Sync / Full Rebuild:** `POST /sync/full` (or the pre-existing `POST /sync` with `account_id`) → `forceSyncAccount()` → every tier, bypassing cadence, **all statuses**. The only path that ever reloads paused/archived/deleted objects. Records `last_full_sync_at`.

In every path, historical data already in SQLite is never deleted — sync is strictly additive/upsert, as it always was.

---

## 6. Recovery flow

- **Per-request:** rate-limit → exponential backoff retry (unchanged); network blip → short fixed retry; auth/permission/validation → fail fast, no wasted retries.
- **Per-account, mid-cycle:** a rate limit on one account persists a backoff window for that account and moves on to the next — never blocks the queue (requirement 15).
- **Per-account, token failure:** an auth error marks `token_is_valid=0`, which removes the account from every future automatic cycle until the user reconnects it (existing `accounts.js` reconnect flow already clears this flag).
- **Process-level, on restart:** `recoverInterruptedSyncs()` (unchanged, Phase 14) marks any row stuck `last_sync_status='running'` as failed. Backoff state now *also* survives the restart (it's a DB column, not memory), so a just-throttled account doesn't get hammered again the moment the process comes back up.
- **Concurrency:** `syncLock` guarantees at most one sync per account regardless of which trigger fired it.

---

## 7. Regression validation

Full suite: `npx jest` — **815 / 816 tests passing.**

The one failure (`smartSyncEngine.test.js` › analytics tier › "runs breakdowns/creative/budget sync ... checkpoints the analytics tier", expecting `status: 'success'` but getting `'partial'`) was verified via `git stash` to fail **identically on the pre-Phase-39 codebase** — it is a pre-existing, deterministic (not flaky — reproduced 3/3 runs) bug unrelated to this phase's changes, most likely one of the Phase 17 analytics sub-steps (customer journey / attribution window / language attribution) hitting an endpoint not covered by that test's `/insights`-only nock mock. Left untouched as out of scope for this phase; worth a follow-up ticket.

One real regression was caught and fixed during this phase's own testing: the first draft of the network-error retry classification matched on "any error with no `err.response`," which incidentally also matched the test suite's own HTTP-mocking library rejecting an unmatched request — turning a fast, clear test failure into a 15-second timeout in two test files. Fixed by scoping the retry to a specific set of real Node/libuv connectivity error codes (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, etc.) instead. Verified clean afterward.

Manual verification (against a private copy of the real local `data/meta_ads.db`, on an isolated port, without touching the already-running dev instance or making any live Meta API calls against real, currently-rate-limited credentials):
- Server boots cleanly, Phase 31 migration applies idempotently.
- `GET /sync/status`, `GET /sync/scheduler-status`, `GET /sync/freshness/:id` all return correctly shaped data, including the new `last_full_sync_at`/`rate_limit_backoff_until`-derived fields.
- `POST /sync/refresh-active` and `POST /sync/full` are correctly wired (verified via 404-on-unknown-account-id, without triggering a real Meta call against the account already showing "User request limit reached" in production data — exactly the failure mode this phase targets).

---

## 8. Railway deployment status

**Not deployed as part of this pass.** A live server on the local dev machine (port 3000, real `data/meta_ads.db`, 8 real connected Meta ad accounts) was already running when this work started; it was left untouched throughout — no destructive or side-effecting action was taken against it or against Railway. Deployment requires explicit sign-off before proceeding (git push / `railway up` affects a shared, externally-reachable production environment), per this session's operating rules for actions with real external blast radius.

---

## 9. Production readiness

| Requirement | Status |
|---|---|
| 1. Active-only scheduled sync | ✅ `activeOnly` filtering, scheduler always `'scheduler'` source |
| 2. Preserve historical data | ✅ unchanged — sync was already strictly upsert, never delete |
| 3. Incremental sync | ✅ active-only tree + incremental insights date window |
| 4. Full Sync mode (manual only) | ✅ `source: 'force'`, `last_full_sync_at` |
| 5. Daily scheduled sync = incremental only | ✅ scheduler never passes `'force'` |
| 6. Force Refresh split (Active / Full Rebuild) | ✅ `/sync/refresh-active`, `/sync/full` |
| 7. Smart Account Queue (sequential) | ✅ pre-existing, confirmed unchanged |
| 8. Adaptive delay | ✅ 200/500/1000/3000ms, usage-header-aware |
| 9. Backoff memory | ✅ persisted `rate_limit_backoff_until` |
| 10. Scheduler priority | ✅ never-synced → active-campaign/stale → rest |
| 11. Dashboard reads SQLite only | ✅ confirmed, no route changes needed |
| 12. Campaign priority | ✅ active + recency proxy (see §4 caveat on "spending today") |
| 13. Meta API optimization | ✅ active filtering + incremental windows; batch API explicitly deferred (see §4) |
| 14. Error classification | ✅ 6 categories, distinct retry policy each |
| 15. Automatic recovery | ✅ per-account isolation hardened in `syncAllAccounts`/`syncAccount` |
| 16. Prevent concurrent sync | ✅ `syncLock` around the single shared entry point |
| 17. Railway deploy | ⏸ pending explicit go-ahead |
| 18. Regression validation | ✅ 815/816 (1 pre-existing, unrelated, documented) |
| 19. Documentation | ✅ this file |

Everything is backward compatible: every existing export, route, and table is unchanged in shape; all additions are opt-in parameters, new columns, or new routes.
