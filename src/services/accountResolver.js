/**
 * Account Resolver
 *
 * Resolves which ad_account a request is scoped to. Shared by every route
 * that needs "the account the dashboard currently has selected" -- extracted
 * because decisions.js and reports.js each had their own near-identical copy
 * (reports.js's copy ignored req.query.account_id entirely, always picking
 * whichever active account sorted first, so switching accounts in the
 * dashboard never changed its report data).
 *
 * Falls back to the first active account when no account_id is given, so
 * existing single-account callers keep working unchanged.
 */

const db = require('../db/database');

function resolveAccount(req) {
  const accountId = req.query?.account_id || req.body?.account_id;
  if (accountId) return db.get('SELECT id FROM ad_accounts WHERE id = ?', [accountId]);
  return db.get("SELECT id FROM ad_accounts WHERE status = 'active' LIMIT 1");
}

module.exports = { resolveAccount };
