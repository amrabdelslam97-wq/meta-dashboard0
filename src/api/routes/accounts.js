/**
 * Accounts Router
 *
 * Manage Meta Ad Account connections: connect, edit metadata, refresh
 * token, enable/disable (PATCH status), soft-remove (DELETE), test
 * connection, and read sync status. No intelligence/metrics logic here --
 * that all lives under src/services and is scoped per-account via the
 * ad_account_id every intelligence table already carries.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../db/database');
const { encryptToken, decryptToken } = require('../../services/tokenCrypto');
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
        business_name, notes,
        last_sync_started_at, last_sync_completed_at, last_successful_sync_at,
        last_failed_sync_at, last_sync_status, last_sync_error, sync_progress_phase,
        auto_sync_enabled, auto_sync_interval_minutes, auto_sync_user_configured_at,
        lifecycle_backfill_completed_at,
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
        auto_sync_enabled: Boolean(account.auto_sync_enabled),
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
    const { meta_account_id, access_token, client_label, account_name, business_name, notes } = req.body || {};

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
        { fields: 'id,name,currency,timezone_name,business_name' },
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

    // Smart Auto Sync: a newly connected, verified account is managed by the
    // Scheduler automatically -- auto_sync_enabled=1 and the default 60-minute
    // interval (schema.phase14.js's column default) are set at creation, not
    // left for the user to opt into after the fact. auto_sync_user_configured_at
    // stays NULL (nothing has been explicitly chosen yet) so a later PATCH
    // that flips this off is recognized as a deliberate user choice and never
    // silently re-enabled (see PATCH /:id below and schema.phase18.js).
    db.run(
      `INSERT INTO ad_accounts (
        id, meta_account_id, account_name, client_label,
        currency, timezone, country_code, attribution_window_days,
        access_token_encrypted, token_is_valid, last_token_verified_at,
        status, business_name, notes, auto_sync_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        normalizedAccountId,
        account_name || metaAccountInfo.name || normalizedAccountId,
        client_label || null,
        metaAccountInfo.currency || 'USD',
        metaAccountInfo.timezone_name || 'UTC',
        metaAccountInfo.country || null,
        7, // default attribution window
        encryptToken(access_token),
        1,
        now,
        'active',
        business_name || metaAccountInfo.business_name || null,
        notes || null,
        1, // auto_sync_enabled -- on by default for a newly connected account
        now,
        now,
      ]
    );

    const created = db.get('SELECT * FROM ad_accounts WHERE id = ?', [id]);

    return res.status(201).json({
      data: {
        ...created,
        token_is_valid: Boolean(created.token_is_valid),
        auto_sync_enabled: Boolean(created.auto_sync_enabled),
        // Never return the token in responses
        access_token_encrypted: undefined,
      },
      message: 'Ad account connected and Auto Sync enabled — it is now managed by the Smart Scheduler.',
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
 * Update account metadata (name, label, business name, notes, currency,
 * timezone, attribution window, status, auto-sync config).
 * Does NOT update tokens — use POST /accounts/:id/token.
 */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
      client_label, attribution_window_days, status,
      account_name, business_name, notes, currency, timezone,
      auto_sync_enabled, auto_sync_interval_minutes,
    } = req.body || {};

    const account = db.get('SELECT id FROM ad_accounts WHERE id = ?', [id]);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const now = new Date().toISOString();

    if (account_name !== undefined) {
      db.run('UPDATE ad_accounts SET account_name = ?, updated_at = ? WHERE id = ?',
        [account_name, now, id]);
    }
    if (business_name !== undefined) {
      db.run('UPDATE ad_accounts SET business_name = ?, updated_at = ? WHERE id = ?',
        [business_name, now, id]);
    }
    if (notes !== undefined) {
      db.run('UPDATE ad_accounts SET notes = ?, updated_at = ? WHERE id = ?',
        [notes, now, id]);
    }
    if (currency !== undefined) {
      db.run('UPDATE ad_accounts SET currency = ?, updated_at = ? WHERE id = ?',
        [currency, now, id]);
    }
    if (timezone !== undefined) {
      db.run('UPDATE ad_accounts SET timezone = ?, updated_at = ? WHERE id = ?',
        [timezone, now, id]);
    }
    if (client_label !== undefined) {
      db.run('UPDATE ad_accounts SET client_label = ?, updated_at = ? WHERE id = ?',
        [client_label, now, id]);
    }
    if (attribution_window_days !== undefined) {
      db.run('UPDATE ad_accounts SET attribution_window_days = ?, updated_at = ? WHERE id = ?',
        [parseInt(attribution_window_days, 10), now, id]);
    }
    if (auto_sync_enabled !== undefined) {
      // Stamps auto_sync_user_configured_at -- marks this account as having
      // an explicit, deliberate user choice on record, so no future
      // "enable by default" migration or logic (schema.phase18.js, POST /
      // above) ever silently overrides it again.
      db.run('UPDATE ad_accounts SET auto_sync_enabled = ?, auto_sync_user_configured_at = ?, updated_at = ? WHERE id = ?',
        [auto_sync_enabled ? 1 : 0, now, now, id]);
    }
    if (auto_sync_interval_minutes !== undefined) {
      const minutes = parseInt(auto_sync_interval_minutes, 10);
      if (!Number.isFinite(minutes) || minutes < 5) {
        return res.status(400).json({ error: 'auto_sync_interval_minutes must be a number >= 5' });
      }
      db.run('UPDATE ad_accounts SET auto_sync_interval_minutes = ?, updated_at = ? WHERE id = ?',
        [minutes, now, id]);
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
              country_code, attribution_window_days, token_is_valid, status,
              business_name, notes, auto_sync_enabled, auto_sync_interval_minutes,
              auto_sync_user_configured_at, updated_at
       FROM ad_accounts WHERE id = ?`,
      [id]
    );

    return res.json({
      data: {
        ...updated,
        token_is_valid: Boolean(updated.token_is_valid),
        auto_sync_enabled: Boolean(updated.auto_sync_enabled),
      },
    });
  })
);

/**
 * DELETE /accounts/:id
 * "Remove" an account -- a soft remove, not a destructive cascade delete.
 * Sets status='disconnected' (hides it from the account selector and from
 * any 'active'-filtered query, stops auto-sync from picking it up) while
 * keeping every historical row (campaigns, decisions, alerts, recommendations)
 * intact and the account reconnectable later via PATCH status='active'.
 * A hard delete would need to cascade through a dozen ad_account_id-keyed
 * tables and is irreversible -- not worth the risk for a single-user system
 * where disk space isn't a real constraint.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const account = db.get('SELECT id, status FROM ad_accounts WHERE id = ?', [id]);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const now = new Date().toISOString();
    db.run(
      "UPDATE ad_accounts SET status = 'disconnected', auto_sync_enabled = 0, updated_at = ? WHERE id = ?",
      [now, id]
    );

    return res.json({
      success: true,
      message: 'Account disconnected. Historical data was kept and the account can be re-enabled later.',
    });
  })
);

/**
 * POST /accounts/:id/test-connection
 * Verifies the stored token against Meta Graph API in detail: account
 * existence, token validity, granted permissions, currency, timezone,
 * business name, and active status. Every check is attempted independently
 * so a failure in one (e.g. permissions) doesn't hide the result of another
 * (e.g. the account still existing) -- errors are collected, not thrown.
 */
router.post(
  '/:id/test-connection',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const account = db.get('SELECT id, meta_account_id, access_token_encrypted FROM ad_accounts WHERE id = ?', [id]);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const { metaGet } = require('../../services/metaApiClient');
    const accessToken = decryptToken(account.access_token_encrypted);

    const result = {
      account_exists: false,
      token_valid: false,
      permissions: [],
      currency: null,
      timezone: null,
      business_name: null,
      active_status: null,
      errors: [],
    };

    try {
      const info = await metaGet(
        account.meta_account_id,
        { fields: 'id,name,currency,timezone_name,business_name,account_status' },
        accessToken
      );
      result.account_exists = true;
      result.token_valid = true;
      result.currency = info.currency || null;
      result.timezone = info.timezone_name || null;
      result.business_name = info.business_name || null;
      // Meta's account_status: 1 = ACTIVE, everything else is some form of
      // disabled/unsettled/closed -- see Meta Marketing API docs.
      result.active_status = info.account_status === 1;
    } catch (err) {
      // metaGet() normalizes Meta API errors into a plain Error with
      // .code/.isMetaError set directly on it (see metaApiClient.js) --
      // not nested under err.response.data.error, which only exists for
      // errors metaGet() doesn't recognize (e.g. a raw network failure).
      result.token_valid = !(err.isMetaError && err.code === 190); // 190 = invalid/expired OAuth token
      result.errors.push({ check: 'account', message: err.message });
    }

    try {
      const perms = await metaGet('me/permissions', {}, accessToken);
      result.permissions = (perms.data || [])
        .filter(p => p.status === 'granted')
        .map(p => p.permission);
    } catch (err) {
      result.errors.push({ check: 'permissions', message: err.message });
    }

    const now = new Date().toISOString();
    db.run(
      'UPDATE ad_accounts SET token_is_valid = ?, last_token_verified_at = ?, updated_at = ? WHERE id = ?',
      [result.token_valid ? 1 : 0, now, now, id]
    );

    return res.json({ data: result });
  })
);

/**
 * GET /accounts/:id/sync-status
 * Thin read of the sync-tracking columns for one account -- powers polling
 * for "Current Sync Progress" without introducing a new sync mechanism;
 * the actual sync is still triggered via the existing POST /sync.
 */
router.get(
  '/:id/sync-status',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const account = db.get(
      `SELECT id, last_sync_started_at, last_sync_completed_at, last_successful_sync_at,
              last_failed_sync_at, last_sync_status, last_sync_error, sync_progress_phase,
              auto_sync_enabled, auto_sync_interval_minutes, auto_sync_user_configured_at,
              lifecycle_backfill_completed_at
       FROM ad_accounts WHERE id = ?`,
      [id]
    );
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    return res.json({ data: { ...account, auto_sync_enabled: Boolean(account.auto_sync_enabled) } });
  })
);

module.exports = router;
