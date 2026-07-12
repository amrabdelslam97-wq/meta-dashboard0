# PHASE 35 — PROCESS EXIT ROOT CAUSE (Runtime-Verified)

**Date:** 2026-07-12
**Method:** Direct runtime reproduction only — no inference from reading code alone. Instrumented `src/app.js` temporarily, ran it under both a contested and an uncontested port, captured raw log output, then reverted the instrumentation.

---

## ROOT CAUSE

**A second server instance cannot bind port 3000 because a prior instance is already listening on it.** On this Windows machine, Node's `'listening'` callback on `app.listen()` fires *before* the OS-level port conflict is detected, so the full startup banner ("✓ Platform Ready") prints first — then a deferred `EADDRINUSE` error arrives on the `http.Server` object a few seconds later, and the process exits.

This is **not** a bug in migrations, the scheduler, the DB layer, or any business logic. It is a real OS-level port conflict, confirmed by direct reproduction (see Evidence).

---

## EVIDENCE (runtime, not inferred)

Instrumented `start()` in `src/app.js` with:
- `console.log` immediately before and after `app.listen()`
- a 5-second `setInterval` printing `process.getActiveResourcesInfo()` and `process.uptime()`
- listeners on `process.on('exit')`, `'beforeExit'`, `'uncaughtException'`, `'unhandledRejection'`

**Baseline finding:** a leftover instance from an earlier session (PID `9212`) was already bound to `0.0.0.0:3000` and `[::]:3000`, and answering `GET /api/v1/health` correctly. This process could not be killed from this sandboxed shell (`taskkill` returned `Access is denied` — a sandbox boundary, not evidence about the user's own terminal).

### Reproduction A — uncontested port (isolated `PORT=3001`, fresh `DB_PATH`)
Ran `node src/app.js` directly, backgrounded, log captured to file. Result: banner printed, then **8 consecutive 5-second ticks over 45+ seconds** with no exit:
```
[DEBUG-EXIT] tick ... activeResources= [ 'TCPServerWrap', 'Timeout' ] uptime= 42.9080556
[2026-07-12T05:06:21.511Z] GET /api/v1/health
```
`curl http://localhost:3001/api/v1/health` succeeded throughout. **No exit occurs when the port is free.**

### Reproduction B — contested port (`npm start`, default `PORT=3000`, already held by PID 9212)
```
✓ Platform Ready
✓ All Systems Online
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Fatal] Port 3000 is already in use — another instance of this server may still be running. Stop it first, or set PORT to a different value.
[DEBUG-EXIT] process "exit" event fired. code= 1 activeResourcesAtExit= [ 'TCPServerWrap', 'Timeout' ]
```
`netstat -ano | findstr :3000` immediately after: only the original PID `9212` remained listening — the second instance's process had fully terminated (not orphaned).

**This exactly reproduces the reported symptom**: banner prints, "Platform Ready" displays, then the process exits a few seconds later, and `curl` against that (now-dead) instance fails.

---

## EXIT EVENT

`process.on('exit')` fired. **No** `uncaughtException`, **no** `unhandledRejection`, **no** `beforeExit` handler with pending work — this is a direct, synchronous call to `process.exit(1)`.

## EXIT CODE

**`1`** — set explicitly by the `server.on('error', ...)` handler in `src/app.js`, not an OS/crash code.

## STACK TRACE

None. This is not an exception — it is the deferred `'error'` event on the `http.Server` object, with `err.code === 'EADDRINUSE'`. The full error object was printed via the existing handler in the non-`EADDRINUSE` branch; in this reproduction the code path taken was the explicit `EADDRINUSE` branch, which prints a purpose-built message instead of a raw stack (by design — see below).

## EXACT LOCATION

`src/app.js`, inside `start()`, the `server.on('error', (err) => { ... process.exit(1); })` block (immediately after `const server = app.listen(PORT, ...)`).

---

## MODIFIED FILES

**None, net.** This exact `server.on('error', ...)` handler already existed in the working tree before this investigation started (added in a prior session, per `PHASE_35_RUNTIME_INVESTIGATION.md`). For this investigation:
1. Temporarily added `console.log` instrumentation (before/after `listen()`, a 5s tick interval, and `exit`/`beforeExit`/`uncaughtException`/`unhandledRejection` listeners) to `src/app.js`.
2. Used that instrumentation to capture the runtime evidence above.
3. **Removed all instrumentation** after confirming the root cause — `src/app.js` is now byte-identical to its pre-investigation state (verified via `git diff`, which shows only the pre-existing `server.on('error', ...)` addition, nothing else).

No further code change was made because the existing handler already converts the previously-silent failure into an explicit, correctly-coded (`exit 1`), clearly-messaged failure — which is the correct fix for this root cause.

---

## WHY THE EXISTING FIX IS SAFE

- It is purely additive: attaches one `error` listener to an object (`server`) that already existed; nothing else in the startup path changed.
- On an uncontested port (the normal case), this listener never fires — confirmed by Reproduction A running cleanly for 45+ seconds with zero behavioral difference.
- It does not touch migrations, the scheduler, the DB layer, or routing.
- It turns an undiagnosable silent `exit code 0` into an explicit, actionable `exit code 1` with a human-readable message — strictly more correct than the prior (pre-fix) behavior.

## REGRESSION RISK

**None identified.** The only code path affected is the one that already terminates the process (a real, unavoidable OS-level port conflict) — the fix changes *how visibly* it fails, not *whether* it fails. `git diff` confirms the working tree contains no leftover debug code from this investigation.

## RESIDUAL RECOMMENDATION (not a code change — operational)

The actual recurring trigger is a **stale prior instance staying alive on port 3000** across sessions (observed directly: PID `9212` in this environment, unrelated to and unkillable from this sandboxed shell, but a normal locally-owned process from the user's own terminal). Before running `npm start`, check for and stop any existing instance:
```
netstat -ano | findstr :3000
taskkill /F /PID <pid>
```
With the existing fix in place, forgetting this step now produces a clear `[Fatal] Port 3000 is already in use` message and `exit code 1` instead of a silent, confusing death.

---

## CONFIDENCE

**95%.** Both the contested and uncontested cases were directly reproduced on this machine with raw instrumentation output, not inferred. The 5% margin accounts for the fact that the specific stale process (PID 9212) blocking port 3000 in this environment could not be terminated from this sandbox to test a fully clean run on the default port — the uncontested behavior was instead confirmed on an alternate port (3001), which exercises the identical code path (`app.listen` → `'listening'` callback → idle) and is not expected to differ by port number.
