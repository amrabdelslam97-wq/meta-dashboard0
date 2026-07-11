/**
 * SaaS Operations Service — Phase 29
 *
 * Usage tracking, licensing, API keys, webhooks, and billing.
 */

const db = require('../db/database');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ─────────────────────────────────────────────
// USAGE TRACKING
// ─────────────────────────────────────────────

/**
 * Track API call for tenant
 */
function trackApiCall(tenantId) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const existing = db.get(
    'SELECT id FROM usage_tracking WHERE tenant_id = ? AND tracking_month = ?',
    [tenantId, currentMonth]
  );

  if (existing) {
    db.run(
      'UPDATE usage_tracking SET api_calls_count = api_calls_count + 1 WHERE id = ?',
      [existing.id]
    );
  } else {
    const trackingId = generateId('utk');
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO usage_tracking (
        id, tenant_id, tracking_month, api_calls_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [trackingId, tenantId, currentMonth, 1, now, now]);
  }
}

/**
 * Track AI request for tenant
 */
function trackAiRequest(tenantId) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const existing = db.get(
    'SELECT id FROM usage_tracking WHERE tenant_id = ? AND tracking_month = ?',
    [tenantId, currentMonth]
  );

  if (existing) {
    db.run(
      'UPDATE usage_tracking SET ai_requests_count = ai_requests_count + 1 WHERE id = ?',
      [existing.id]
    );
  } else {
    const trackingId = generateId('utk');
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO usage_tracking (
        id, tenant_id, tracking_month, ai_requests_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [trackingId, tenantId, currentMonth, 1, now, now]);
  }
}

/**
 * Track sync job for tenant
 */
function trackSyncJob(tenantId) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const existing = db.get(
    'SELECT id FROM usage_tracking WHERE tenant_id = ? AND tracking_month = ?',
    [tenantId, currentMonth]
  );

  if (existing) {
    db.run(
      'UPDATE usage_tracking SET sync_jobs_count = sync_jobs_count + 1 WHERE id = ?',
      [existing.id]
    );
  }
}

/**
 * Get current month usage for tenant
 */
function getCurrentMonthUsage(tenantId) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const usage = db.get(
    'SELECT * FROM usage_tracking WHERE tenant_id = ? AND tracking_month = ?',
    [tenantId, currentMonth]
  );

  return usage || {
    api_calls_count: 0,
    ai_requests_count: 0,
    sync_jobs_count: 0,
    storage_bytes_used: 0,
    users_count: 0,
    reports_generated: 0,
    exports_count: 0,
  };
}

// ─────────────────────────────────────────────
// LICENSE MANAGEMENT
// ─────────────────────────────────────────────

/**
 * Create license key
 */
function createLicenseKey(tenantId, licenseData) {
  const licenseId = generateId('lic');
  const licenseKey = `lic_${crypto.randomBytes(32).toString('hex')}`;
  const now = new Date().toISOString();

  let expiresAt = null;
  if (licenseData.duration_days) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + licenseData.duration_days);
    expiresAt = expiry.toISOString();
  }

  db.run(`
    INSERT INTO license_keys (
      id, tenant_id, license_key, license_type, max_campaigns, max_users,
      expires_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    licenseId,
    tenantId,
    licenseKey,
    licenseData.license_type || 'trial',
    licenseData.max_campaigns || null,
    licenseData.max_users || null,
    expiresAt,
    'active',
    now,
    now,
  ]);

  return getLicenseKey(licenseId);
}

/**
 * Get license key
 */
function getLicenseKey(licenseId) {
  return db.get(`
    SELECT * FROM license_keys WHERE id = ?
  `, [licenseId]);
}

/**
 * Validate license key
 */
function validateLicenseKey(licenseKey) {
  const license = db.get(`
    SELECT * FROM license_keys WHERE license_key = ?
  `, [licenseKey]);

  if (!license) return { valid: false, reason: 'License not found' };
  if (license.status !== 'active') return { valid: false, reason: 'License inactive' };

  if (license.expires_at) {
    const expiryDate = new Date(license.expires_at);
    if (expiryDate < new Date()) {
      return { valid: false, reason: 'License expired' };
    }
  }

  return { valid: true, license };
}

/**
 * Get tenant's active license
 */
function getTenantLicense(tenantId) {
  return db.get(`
    SELECT * FROM license_keys
    WHERE tenant_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `, [tenantId]);
}

// ─────────────────────────────────────────────
// API KEYS
// ─────────────────────────────────────────────

/**
 * Create API key for tenant
 */
function createApiKey(tenantId, keyData) {
  const apiKeyId = generateId('key');
  const apiKey = `sk_${crypto.randomBytes(32).toString('hex')}`;
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO api_keys (
      id, tenant_id, api_key, key_name, description,
      rate_limit_per_minute, scopes_json, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    apiKeyId,
    tenantId,
    apiKey,
    keyData.key_name,
    keyData.description || null,
    keyData.rate_limit_per_minute || 60,
    JSON.stringify(keyData.scopes || []),
    1,
    now,
    now,
  ]);

  return getApiKey(apiKeyId);
}

/**
 * Get API key (only first time, for security)
 */
function getApiKey(apiKeyId) {
  const key = db.get(`
    SELECT id, tenant_id, key_name, description, rate_limit_per_minute,
           scopes_json, is_active, last_used_at, created_at
    FROM api_keys WHERE id = ?
  `, [apiKeyId]);

  if (key) {
    key.scopes = key.scopes_json ? JSON.parse(key.scopes_json) : [];
  }

  return key;
}

/**
 * List API keys for tenant
 */
function listApiKeys(tenantId) {
  const keys = db.all(`
    SELECT id, tenant_id, key_name, description, rate_limit_per_minute,
           is_active, last_used_at, created_at
    FROM api_keys WHERE tenant_id = ? AND is_active = 1
    ORDER BY created_at DESC
  `, [tenantId]);

  return keys;
}

/**
 * Revoke API key
 */
function revokeApiKey(apiKeyId) {
  const now = new Date().toISOString();
  db.run(
    'UPDATE api_keys SET is_active = 0, updated_at = ? WHERE id = ?',
    [now, apiKeyId]
  );
  return { success: true };
}

/**
 * Validate and track API key usage
 */
function validateApiKey(apiKey) {
  const key = db.get(`
    SELECT id, tenant_id, rate_limit_per_minute, is_active
    FROM api_keys WHERE api_key = ?
  `, [apiKey]);

  if (!key || !key.is_active) {
    return { valid: false, reason: 'Invalid API key' };
  }

  // Update last used
  const now = new Date().toISOString();
  db.run(
    'UPDATE api_keys SET last_used_at = ? WHERE id = ?',
    [now, key.id]
  );

  return {
    valid: true,
    tenant_id: key.tenant_id,
    rate_limit_per_minute: key.rate_limit_per_minute,
  };
}

// ─────────────────────────────────────────────
// WEBHOOKS
// ─────────────────────────────────────────────

/**
 * Subscribe to webhook event
 */
function subscribeToWebhook(tenantId, eventType, webhookUrl) {
  const webhookId = generateId('wh');
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO webhook_subscriptions (
      id, tenant_id, event_type, webhook_url, webhook_secret,
      is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    webhookId,
    tenantId,
    eventType,
    webhookUrl,
    webhookSecret,
    1,
    now,
    now,
  ]);

  return getWebhookSubscription(webhookId);
}

/**
 * Get webhook subscription
 */
function getWebhookSubscription(webhookId) {
  return db.get(`
    SELECT * FROM webhook_subscriptions WHERE id = ?
  `, [webhookId]);
}

/**
 * List webhook subscriptions for tenant
 */
function listWebhooks(tenantId, eventType = null) {
  let query = 'SELECT * FROM webhook_subscriptions WHERE tenant_id = ?';
  const params = [tenantId];

  if (eventType) {
    query += ' AND event_type = ?';
    params.push(eventType);
  }

  query += ' AND is_active = 1 ORDER BY created_at DESC';

  return db.all(query, params);
}

/**
 * Get webhooks for event delivery
 */
function getWebhooksForEvent(tenantId, eventType) {
  return db.all(`
    SELECT * FROM webhook_subscriptions
    WHERE tenant_id = ? AND event_type = ? AND is_active = 1
  `, [tenantId, eventType]);
}

/**
 * Queue webhook for delivery
 */
function queueWebhook(tenantId, eventType, payload) {
  const jobId = generateId('job');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO background_jobs (
      id, tenant_id, job_type, status, priority, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    jobId,
    tenantId,
    'process_webhook',
    'pending',
    'normal',
    JSON.stringify({ event_type: eventType, payload }),
    now,
    now,
  ]);

  return { job_id: jobId };
}

module.exports = {
  trackApiCall,
  trackAiRequest,
  trackSyncJob,
  getCurrentMonthUsage,
  createLicenseKey,
  getLicenseKey,
  validateLicenseKey,
  getTenantLicense,
  createApiKey,
  getApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKey,
  subscribeToWebhook,
  getWebhookSubscription,
  listWebhooks,
  getWebhooksForEvent,
  queueWebhook,
};
