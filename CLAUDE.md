# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Single-user internal system for syncing and analyzing Meta (Facebook) Ads campaigns. Node.js + Express 5, SQLite via `sql.js` (WASM), server-rendered API consumed by a static dashboard in `public/`. The codebase has grown through numbered "phases" (Phase 1 → Phase 7B), each adding a schema migration file and/or a slice of routes/services. Phase markers in comments and `src/api/router.js` indicate when a piece was added, not a subsystem you need to run separately.

## Commands

```bash
npm install         # install dependencies
cp .env.example .env  # configure — see Environment below
npm run seed         # insert mock data directly into SQLite (no Meta API needed)
npm start            # run the server (node src/app.js)
npm run dev          # run with --watch (auto-reload)
npm test             # == npm run verify — runs scripts/verify.js
npm run verify        # end-to-end HTTP test against a *running* server
```

There is no separate lint command and no per-test-file runner — `scripts/verify.js` is a single script that boots against `http://localhost:{PORT}` and walks through the Phase 1 flow (DB init → seed → `GET /campaigns` → filters → `GET /campaigns/:id` → `GET /sync/status`). The server must already be running (`npm start`) in another terminal before running `npm run verify`/`npm test`.

To exercise a single endpoint manually, curl it directly against the running dev server rather than trying to isolate a test — e.g. `curl http://localhost:3000/api/v1/campaigns?status=active`.

## Environment

Config is loaded via `dotenv` from `.env` (see `.env.example` for the full list): `PORT`, `NODE_ENV`, `META_APP_ID`, `META_APP_SECRET`, `META_API_VERSION` (default `v21.0`), `DB_PATH` (default `./data/meta_ads.db`), plus single-user `USER_EMAIL`/`USER_PASSWORD`. Real Meta API calls need `META_APP_ID`/`META_APP_SECRET` and a valid access token on the connected ad account; seeded/mock data works without any Meta credentials.

## Architecture

### Request flow
`src/app.js` boots the DB, runs schema migrations in sequence, mounts `express.static(public/)`, then mounts the API router at `/api/v1`, then falls back to `public/index.html` for any non-API path (SPA). `src/api/router.js` wires each route module under a path prefix; route modules live in `src/api/routes/` and are thin — they parse params, call into `src/services/`, and shape the JSON response. Business/intelligence logic lives entirely in `src/services/`.

**Migration wiring is manual and additive**: every new phase's schema file exports a `run<Phase>Migrations()` function that must be explicitly called from `src/app.js` in order. When adding a new schema file, remember to both create the migration function *and* wire it into `src/app.js` — it will not run otherwise. (Note: `schema.phase7b.js` exists but as of now is not called from `app.js` — check before assuming its columns exist on a fresh DB.)

### Database (`src/db/database.js`)
`sql.js` is a WASM build of SQLite that operates fully in memory — there is no real file-backed journaling. `run()` and `transaction()` call `persist()` after every write, which re-serializes the *entire* database and rewrites `data/meta_ads.db` from scratch (`db.export()` → `fs.writeFileSync`). This means:
- Writes get progressively more expensive as the DB grows — batch writes inside `transaction()` where possible instead of many individual `run()` calls.
- There is no real concurrent-writer story; this is a single-process, single-user system by design.
- Query helpers (`run`, `all`, `get`, `transaction`, `getDb`) are the only sanctioned way to touch the DB — no ORM.

Schema is split by phase (`schema.js`, `schema.phase2.js`, `schema.phase5.js`, `schema.phase6.js`, `schema.phase7b.js`), each additive (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN` guarded with try/catch for idempotency across repeated boots).

### Intelligence pipeline
The core domain logic is a per-campaign pipeline orchestrated by `src/services/intelligenceOrchestrator.js`, which runs in this fixed order and returns one enriched object per campaign:
1. `healthScoreEngine` — computes and persists a health score (`health_score_history`)
2. `benchmarkEngine` — compares metrics against `benchmark_industries`/`benchmark_metrics`
3. `goalAchievementEngine` — evaluates progress against `account_targets`
4. `recommendationEngine` — evaluates `recommendation_rules`, writes deduplicated rows to `recommendation_log`
5. `alertEngine` — evaluates `alert_rules` against current vs. prior metrics, writes/resolves rows in `active_alerts`

The orchestrator takes metrics as input and never calls the Meta API itself — metrics come from `metricsFetcher.js` (real Meta Insights data, phase 4+) or from mock generators such as `adIntelligence.js`/`adSetIntelligence.js` (which derive a stable pseudo-random "variance index" from the entity ID so mock values are consistent across calls for the same entity, rather than truly random). Parallel per-entity intelligence exists for ad sets (`adSetIntelligence.js`) and ads (`adIntelligence.js`), plus roll-ups in `portfolioEngine.js`, `comparisonEngine.js`, `topWinnersEngine.js`/`topLosersEngine.js`, and `opportunityEngine.js`.

### Meta API integration
`metaApiClient.js` is the only module that talks to `graph.facebook.com` — it's a thin, business-logic-free wrapper handling pagination and a single retry on HTTP 429 (60s backoff). `syncService.js` uses it to fetch campaigns/ad sets/ads and upsert them into the DB (idempotent — safe to call repeatedly). `metricsFetcher.js` uses it to fetch Insights data (spend, actions, ROAS, etc.) and normalizes Meta's `actions[]`/`cost_per_action_type[]` arrays into flat metric keys via an internal `ACTION_MAP` (e.g. mapping various Meta action_types to `leads`, `purchases`, `link_clicks`, `results`). `objectiveMapper.js`/`objectiveKPIMap.js` translate Meta's campaign `objective` enum into this system's internal objective/KPI vocabulary — that vocabulary is what the intelligence engines key off of, not Meta's raw objective strings.

`cacheService.js` provides in-memory caching for Insights fetches (Meta rate limits are the constraint being managed, not general performance).

### Adding a new engine or route
Follow the existing phase pattern: a service in `src/services/` that's pure logic taking DB rows/metrics in and returning a result (persisting via the shared `db` helpers itself if it needs to), a thin route in `src/api/routes/` that calls it, and register the route in `src/api/router.js` grouped under the correct phase comment block. If it needs new tables, add a new `schema.phaseN.js` with a `runPhaseNMigrations()` export and wire it into `src/app.js`.
