/**
 * Sync Router
 *
 * POST /sync — triggers a manual sync from Meta API to database.
 * Phase 1: sync campaigns, ad sets, ads for all active accounts.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const cache = require('../../services/cacheService');
const { syncAccount, syncAllAccounts } = require('../../services/syncService');
const { asyncHandler } = require('../../middleware/errorHandler');

/**
 * POST /sync
 *
 * Triggers sync for all active ad accounts.
 *
 * Optional body:
 *   { account_id: "uuid" } — sync only this account
 *   { sync_ad_sets: false } — skip ad sets and ads
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { account_id, sync_ad_sets = true, sync_ads = true } = req.body || {};

    if (account_id) {
      // Sync a specific account
      const account = db.get(
        "SELECT * FROM ad_accounts WHERE id = ? AND status = 'active' AND token_is_valid = 1",
        [account_id]
      );

      if (!account) {
        return res.status(404).json({
          error: 'Account not found or not active',
          account_id,
        });
      }

      const result = await syncAccount(account, {
        syncAdSets: sync_ad_sets,
        syncAds: sync_ads,
      });

      return res.json({
        success: true,
        results: [result],
      });
    }

    // Sync all active accounts
    const results = await syncAllAccounts({
      syncAdSets: sync_ad_sets,
      syncAds: sync_ads,
    });

    return res.json({
      success: true,
      accounts_synced: results.length,
      results,
    });
  })
);

/**
 * GET /sync/status
 * Returns a summary of what's currently in the database.
 */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const accounts = db.get('SELECT COUNT(*) as count FROM ad_accounts');
    const campaigns = db.get('SELECT COUNT(*) as count FROM campaigns');
    const adSets = db.get('SELECT COUNT(*) as count FROM ad_sets');
    const ads = db.get('SELECT COUNT(*) as count FROM ads');

    const activeCampaigns = db.get(
      "SELECT COUNT(*) as count FROM campaigns WHERE status = 'active'"
    );

    const latestCampaign = db.get(
      'SELECT updated_at FROM campaigns ORDER BY updated_at DESC LIMIT 1'
    );

    return res.json({
      database: {
        ad_accounts: accounts?.count || 0,
        campaigns: campaigns?.count || 0,
        ad_sets: adSets?.count || 0,
        ads: ads?.count || 0,
        active_campaigns: activeCampaigns?.count || 0,
      },
      last_sync: latestCampaign?.updated_at || null,
    });
  })
);


/**
 * POST /sync/cache/flush — Phase 4
 * Clears all cached insights data (forces fresh Meta API calls).
 */
router.post('/cache/flush', asyncHandler(async (req, res) => {
  const { account_id } = req.body || {};
  let count;
  if (account_id) {
    const acct = db.get('SELECT meta_account_id FROM ad_accounts WHERE id = ?', [account_id]);
    count = acct ? cache.invalidateAccount(acct.meta_account_id) : 0;
  } else {
    count = cache.flush();
  }
  return res.json({ success: true, entries_cleared: count });
}));

/**
 * GET /sync/cache/stats — Phase 4
 * Internal diagnostics (cache size/hit/miss counts) -- not needed by the
 * shipped frontend and not appropriate to expose in production. Unlike
 * POST /cache/flush (a real operator action the frontend actually uses),
 * this is pure debug output, so it's disabled outside development rather
 * than left permanently public.
 */
router.get('/cache/stats', asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.json(cache.stats());
}));

module.exports = router;
