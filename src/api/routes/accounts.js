/**
 * Accounts Router
 *
 * Manage Meta Ad Account connections.
 * Phase 1 only — no intelligence, no metrics.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../db/database');
const { encryptToken } = require('../../services/tokenCrypto');
const { asyncHandler } = require('../../middleware/errorHandler');

/**
 * GET /accounts
 * List all connected ad accounts.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const accounts = db.all(
      `SELECT
        id, meta_account_id, account_name, client_label,
        currency, timezone, country_code, attribution_window_days,
        token_is_valid, last_token_verified_at, status,
        created_at, updated_at
      FROM ad_accounts
      ORDER BY account_name ASC`
    );

    // Include campaign count per account
    const accountsWithCounts = accounts.map(account => {
      const counts = db.get(
        `SELECT
          COUNT(*) as total_campaigns,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_campaigns
        FROM campaigns WHERE ad_account_id = ?`,
        [account.id]
      );
      return {
        ...account,
        token_is_valid: Boolean(account.token_is_valid),
        campaign_counts: {
          total: counts?.total_campaigns || 0,
          active: counts?.active_campaigns || 0,
        },
      };
    });

    return res.json({ data: accountsWithCounts });
  })
);

/**
 * POST /accounts
 * Connect a new Meta ad account.
 *
 * Body:
 *   meta_account_id  — Meta's act_xxxxxxxxx (required)
 *   access_token     — Meta user access token (required)
 *   client_label     — Your label for this account (optional)
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { meta_account_id, access_token, client_label } = req.body || {};

    if (!meta_account_id || !access_token) {
      return res.status(400).json({
        error: 'meta_account_id and access_token are required',
      });
    }

    // Normalize the Meta account ID format
    const normalizedAccountId = meta_account_id.startsWith('act_')
      ? meta_account_id
      : `act_${meta_account_id}`;

    // Check if already connected
    const existing = db.get(
      'SELECT id FROM ad_accounts WHERE meta_account_id = ?',
      [normalizedAccountId]
    );
    if (existing) {
      return res.status(409).json({
        error: 'This ad account is already connected',
        account_id: existing.id,
      });
    }

    // Verify the token works by calling Meta API
    let metaAccountInfo;
    try {
      // Fetch basic account info
      const { metaGet } = require('../../services/metaApiClient');
      metaAccountInfo = await metaGet(
        normalizedAccountId,
        { fields: 'id,name,currency,timezone_name' },
        access_token
      );
    } catch (err) {
      return res.status(400).json({
        error: 'Failed to verify Meta account access',
        message: err.message,
      });
    }

    const now = new Date().toISOString();
    const id = uuidv4();

    db.run(
      `INSERT INTO ad_accounts (
        id, meta_account_id, account_name, client_label,
        currency, timezone, country_code, attribution_window_days,
        access_token_encrypted, token_is_valid, last_token_verified_at,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        normalizedAccountId,
        metaAccountInfo.name || normalizedAccountId,
        client_label || null,
        metaAccountInfo.currency || 'USD',
        metaAccountInfo.timezone_name || 'UTC',
        metaAccountInfo.country || null,
        7, // default attribution window
        encryptToken(access_token),
        1,
        now,
        'active',
        now,
        now,
      ]
    );

    const created = db.get('SELECT * FROM ad_accounts WHERE id = ?', [id]);

    return res.status(201).json({
      data: {
        ...created,
        token_is_valid: Boolean(created.token_is_valid),
        // Never return the token in responses
        access_token_encrypted: undefined,
      },
      message: 'Ad account connected successfully. Run /sync to fetch campaigns.',
    });
  })
);

/**
 * POST /accounts/:id/token
 * Refresh (replace) the stored access token for an already-connected
 * account -- e.g. after the previous token expired or was rotated on
 * Meta's side. The new token is verified against Meta before being stored,
 * exactly like POST /accounts does for a new connection.
 *
 * Body:
 *   access_token — the new Meta user access token (required)
 */
router.post(
  '/:id/token',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { access_token } = req.body || {};

    if (!access_token) {
      return res.status(400).json({ error: 'access_token is required' });
    }

    const account = db.get('SELECT id, meta_account_id FROM ad_accounts WHERE id = ?', [id]);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    try {
      const { metaGet } = require('../../services/metaApiClient');
      await metaGet(account.meta_account_id, { fields: 'id' }, access_token);
    } catch (err) {
      return res.status(400).json({
        error: 'Failed to verify the new access token against Meta',
        message: err.message,
      });
    }

    const now = new Date().toISOString();
    db.run(
      `UPDATE ad_accounts
       SET access_token_encrypted = ?, token_is_valid = 1, last_token_verified_at = ?, updated_at = ?
       WHERE id = ?`,
      [encryptToken(access_token), now, now, id]
    );

    const updated = db.get(
      `SELECT id, meta_account_id, account_name, client_label, currency, timezone,
              country_code, attribution_window_days, token_is_valid, last_token_verified_at,
              status, updated_at
       FROM ad_accounts WHERE id = ?`,
      [id]
    );

    return res.json({
      data: { ...updated, token_is_valid: Boolean(updated.token_is_valid) },
      message: 'Access token refreshed successfully.',
    });
  })
);

/**
 * PATCH /accounts/:id
 * Update account metadata (label, attribution window).
 * Does NOT update tokens — use POST /accounts/:id/token.
 */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { client_label, attribution_window_days, status } = req.body || {};

    const account = db.get('SELECT id FROM ad_accounts WHERE id = ?', [id]);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const now = new Date().toISOString();

    if (client_label !== undefined) {
      db.run('UPDATE ad_accounts SET client_label = ?, updated_at = ? WHERE id = ?',
        [client_label, now, id]);
    }
    if (attribution_window_days !== undefined) {
      db.run('UPDATE ad_accounts SET attribution_window_days = ?, updated_at = ? WHERE id = ?',
        [parseInt(attribution_window_days, 10), now, id]);
    }
    if (status !== undefined) {
      const validStatuses = ['active', 'paused', 'disconnected'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status', valid_values: validStatuses });
      }
      db.run('UPDATE ad_accounts SET status = ?, updated_at = ? WHERE id = ?',
        [status, now, id]);
    }

    const updated = db.get(
      `SELECT id, meta_account_id, account_name, client_label, currency, timezone,
              country_code, attribution_window_days, token_is_valid, status, updated_at
       FROM ad_accounts WHERE id = ?`,
      [id]
    );

    return res.json({ data: { ...updated, token_is_valid: Boolean(updated.token_is_valid) } });
  })
);

module.exports = router;
