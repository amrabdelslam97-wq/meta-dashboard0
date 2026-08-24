/**
 * Vercel Cron trigger route — replaces autoSyncScheduler.js's setInterval,
 * which never fires under the serverless entrypoint (api/index.js only
 * calls initializeApp()+createApp(), never start(), so the interval is
 * simply never created — no code change needed to "disable" it).
 *
 * This route contains NO synchronization logic of its own. It only calls
 * syncRouter.refreshAllActiveAccounts('cron') (src/api/routes/sync.js), the
 * same function POST /api/v1/sync/refresh-active calls (with its own
 * default source, 'force_active') — which itself calls
 * smartSyncEngine.forceSyncActiveAccount() per account, completely
 * unmodified. The 'cron' vs 'force_active' distinction (AP-POS Sync
 * Architecture Audit) is what lets smartSyncEngine.runDueForAccount() tell
 * a genuinely-automatic recurring tick apart from an explicit manual button
 * click: 'cron' respects each entity tier's own due-check (incremental,
 * same as autoSyncScheduler.js's 'scheduler' source) instead of bypassing
 * cadence, and stays FULL (not active-only) until the account's initial
 * hierarchy sweep completes — see smartSyncEngine.js's doc comment on
 * runDueForAccount() for the full source-to-behavior mapping. The existing
 * DB-backed per-account in-flight guard (ad_accounts.last_sync_status,
 * checked inside both syncService.js and smartSyncEngine.js) is what makes
 * this safe to invoke even if a previous cron run is still in flight — this
 * route adds no new concurrency logic, it relies entirely on that
 * already-existing mechanism.
 *
 * Mounted directly in app.js (not under the session/cookie-gated /api/v1
 * router) since a cron invocation has no browser session — see
 * middleware/cronAuth.js.
 */

const express = require('express');
const router = express.Router();
const { requireCronAuth } = require('../../middleware/cronAuth');
const { asyncHandler } = require('../../middleware/errorHandler');
const syncRouter = require('./sync');

router.post('/sync', requireCronAuth, asyncHandler(async (req, res) => {
  const { accounts_synced, results } = await syncRouter.refreshAllActiveAccounts('cron');
  return res.json({ success: true, source: 'cron', accounts_synced, results });
}));

// Vercel Cron sends GET by default unless configured otherwise; accept
// both so the vercel.json crons entry doesn't need a non-default method.
router.get('/sync', requireCronAuth, asyncHandler(async (req, res) => {
  const { accounts_synced, results } = await syncRouter.refreshAllActiveAccounts('cron');
  return res.json({ success: true, source: 'cron', accounts_synced, results });
}));

module.exports = router;
