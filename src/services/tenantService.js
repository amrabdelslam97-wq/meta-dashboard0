/**
 * Tenant Service — Phase 29
 *
 * Multi-tenant isolation, context management, and tenant operations.
 * Critical for ensuring complete data separation across all services.
 */

const db = require('../db/database');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ─────────────────────────────────────────────
// TENANT MANAGEMENT
// ─────────────────────────────────────────────

/**
 * Create a new tenant
 */
function createTenant(userId, tenantData) {
  const tenantId = generateId('ten');
  const now = new Date().toISOString();

  // Generate slug from name
  const slug = tenantData.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || crypto.randomBytes(4).toString('hex');

  db.run(`
    INSERT INTO tenants (
      id, owner_user_id, tenant_type, name, slug, logo_url,
      industry, country, timezone, currency, language,
      billing_email, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    tenantId,
    userId,
    tenantData.tenant_type || 'agency',
    tenantData.name,
    slug,
    tenantData.logo_url || null,
    tenantData.industry || null,
    tenantData.country || null,
    tenantData.timezone || 'UTC',
    tenantData.currency || 'USD',
    tenantData.language || 'en',
    tenantData.billing_email || null,
    'trial',
    now,
    now,
  ]);

  // Add owner as tenant member
  const memberId = generateId('tm');
  db.run(`
    INSERT INTO tenant_memberships (
      id, tenant_id, user_id, role, status, joined_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [memberId, tenantId, userId, 'owner', 'active', now, now, now]);

  // Create default tenant settings
  const settingsId = generateId('ts');
  db.run(`
    INSERT INTO tenant_settings (
      id, tenant_id, theme, date_format, number_format, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [settingsId, tenantId, 'light', 'MM/DD/YYYY', 'en-US', now, now]);

  // Create default quotas from Free plan
  createTenantQuotas(tenantId);

  return getTenant(tenantId);
}

/**
 * Get tenant details
 */
function getTenant(tenantId) {
  const tenant = db.get(`
    SELECT t.* FROM tenants t WHERE t.id = ?
  `, [tenantId]);

  if (!tenant) return null;

  const subscription = db.get(`
    SELECT ts.*, sp.plan_name FROM tenant_subscriptions ts
    LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
    WHERE ts.tenant_id = ?
  `, [tenantId]);

  const settings = db.get(`
    SELECT * FROM tenant_settings WHERE tenant_id = ?
  `, [tenantId]);

  return {
    ...tenant,
    subscription: subscription || null,
    settings: settings || null,
  };
}

/**
 * List tenants for user
 */
function getUserTenants(userId) {
  return db.all(`
    SELECT t.* FROM tenants t
    INNER JOIN tenant_memberships tm ON t.id = tm.tenant_id
    WHERE tm.user_id = ? AND tm.status = 'active'
    ORDER BY t.updated_at DESC
  `, [userId]);
}

/**
 * Update tenant
 */
function updateTenant(tenantId, tenantData) {
  const now = new Date().toISOString();
  const updates = [];
  const params = [];

  const fields = [
    'name', 'logo_url', 'logo_dark_url', 'industry', 'country',
    'timezone', 'currency', 'language', 'custom_domain',
    'primary_color', 'secondary_color', 'billing_email', 'billing_name',
    'billing_address', 'billing_city', 'billing_country', 'billing_zip', 'status',
  ];

  for (const field of fields) {
    if (field in tenantData) {
      updates.push(`${field} = ?`);
      params.push(tenantData[field] || null);
    }
  }

  if (updates.length === 0) return getTenant(tenantId);

  updates.push('updated_at = ?');
  params.push(now);
  params.push(tenantId);

  db.run(
    `UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`,
    params
  );

  return getTenant(tenantId);
}

// ─────────────────────────────────────────────
// TENANT CONTEXT (Critical for isolation)
// ─────────────────────────────────────────────

/**
 * Create tenant context from request (for middleware)
 * Used to scope all queries automatically
 */
function createTenantContext(userId, tenantIdOrApiKey) {
  if (!tenantIdOrApiKey) {
    throw new Error('Tenant context required');
  }

  let tenantId = tenantIdOrApiKey;

  // If API key provided, resolve to tenant
  if (tenantIdOrApiKey.startsWith('sk_') || tenantIdOrApiKey.length > 50) {
    const apiKey = db.get(
      'SELECT tenant_id FROM api_keys WHERE api_key = ?',
      [tenantIdOrApiKey]
    );
    if (!apiKey) throw new Error('Invalid API key');
    tenantId = apiKey.tenant_id;
  }

  // Verify user has access to tenant
  const membership = db.get(`
    SELECT * FROM tenant_memberships
    WHERE tenant_id = ? AND user_id = ? AND status = 'active'
  `, [tenantId, userId]);

  if (!membership) {
    throw new Error('Access denied to tenant');
  }

  return {
    tenant_id: tenantId,
    user_id: userId,
    role: membership.role,
    permissions: getPermissionsForRole(membership.role),
  };
}

/**
 * Verify user has access to entity in tenant
 * Usage: verifyTenantAccess(tenantId, userId, 'edit')
 */
function verifyTenantAccess(tenantId, userId, requiredAction = 'view') {
  const membership = db.get(`
    SELECT role FROM tenant_memberships
    WHERE tenant_id = ? AND user_id = ? AND status = 'active'
  `, [tenantId, userId]);

  if (!membership) {
    throw new Error('Access denied');
  }

  const permissions = getPermissionsForRole(membership.role);
  if (!permissions.includes(requiredAction)) {
    throw new Error(`Permission denied: ${requiredAction}`);
  }

  return membership;
}

/**
 * Scope query to tenant (used by all services)
 * Example: scopeQuery('SELECT * FROM campaigns', tenantId)
 * Returns: 'SELECT * FROM campaigns WHERE tenant_id = ?', [tenantId]
 */
function scopeQuery(query, tenantId) {
  // Insert tenant scoping
  if (query.toUpperCase().includes('WHERE')) {
    return [query.replace(/WHERE/i, `WHERE tenant_id = '${tenantId}' AND`), []];
  }
  return [query + ` WHERE tenant_id = '${tenantId}'`, []];
}

// ─────────────────────────────────────────────
// ROLE-BASED PERMISSIONS
// ─────────────────────────────────────────────

function getPermissionsForRole(role) {
  const rolePermissions = {
    owner: ['view', 'create', 'edit', 'delete', 'admin', 'billing', 'export', 'api_keys', 'webhooks'],
    admin: ['view', 'create', 'edit', 'delete', 'export', 'api_keys', 'webhooks'],
    manager: ['view', 'create', 'edit', 'export'],
    member: ['view', 'create', 'edit'],
    viewer: ['view'],
    custom: [], // Handled separately
  };

  return rolePermissions[role] || [];
}

function canUserPerform(tenantId, userId, action) {
  const membership = db.get(`
    SELECT role FROM tenant_memberships
    WHERE tenant_id = ? AND user_id = ? AND status = 'active'
  `, [tenantId, userId]);

  if (!membership) return false;

  const permissions = getPermissionsForRole(membership.role);
  return permissions.includes(action);
}

// ─────────────────────────────────────────────
// TENANT QUOTAS
// ─────────────────────────────────────────────

/**
 * Create default quotas from Free plan
 */
function createTenantQuotas(tenantId) {
  const quotasId = generateId('tq');
  const freePlan = db.get('SELECT * FROM subscription_plans WHERE plan_slug = ?', ['free']);

  if (!freePlan) return;

  const now = new Date().toISOString();
  const resetDate = new Date();
  resetDate.setMonth(resetDate.getMonth() + 1);

  db.run(`
    INSERT INTO tenant_quotas (
      id, tenant_id, max_storage_gb, max_users, max_api_calls_monthly,
      max_ad_accounts, max_dashboards, reset_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    quotasId,
    tenantId,
    freePlan.max_storage_gb || 10,
    freePlan.max_users || 3,
    freePlan.max_api_calls_monthly || 10000,
    freePlan.max_ad_accounts || 1,
    freePlan.max_dashboards || 10,
    resetDate.toISOString(),
    now,
    now,
  ]);
}

/**
 * Update tenant quotas from subscription plan
 */
function updateTenantQuotasFromPlan(tenantId, planId) {
  const plan = db.get('SELECT * FROM subscription_plans WHERE id = ?', [planId]);
  if (!plan) return null;

  const now = new Date().toISOString();
  const resetDate = new Date();
  resetDate.setMonth(resetDate.getMonth() + 1);

  db.run(`
    UPDATE tenant_quotas
    SET max_storage_gb = ?, max_users = ?, max_api_calls_monthly = ?,
        max_ad_accounts = ?, max_dashboards = ?, reset_date = ?, updated_at = ?
    WHERE tenant_id = ?
  `, [
    plan.max_storage_gb,
    plan.max_users,
    plan.max_api_calls_monthly,
    plan.max_ad_accounts,
    plan.max_dashboards,
    resetDate.toISOString(),
    now,
    tenantId,
  ]);

  return db.get('SELECT * FROM tenant_quotas WHERE tenant_id = ?', [tenantId]);
}

/**
 * Get tenant quotas and current usage
 */
function getTenantQuotasWithUsage(tenantId) {
  const quotas = db.get('SELECT * FROM tenant_quotas WHERE tenant_id = ?', [tenantId]);
  if (!quotas) return null;

  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  const usage = db.get(
    'SELECT * FROM usage_tracking WHERE tenant_id = ? AND tracking_month = ?',
    [tenantId, currentMonth]
  );

  return {
    quotas,
    usage: usage || {},
    remaining: {
      storage_gb: quotas.max_storage_gb - ((usage?.storage_bytes_used || 0) / (1024 * 1024 * 1024)),
      users: quotas.max_users - (usage?.users_count || 0),
      api_calls: quotas.max_api_calls_monthly - (usage?.api_calls_count || 0),
      ad_accounts: quotas.max_ad_accounts,
      dashboards: quotas.max_dashboards,
    },
  };
}

module.exports = {
  createTenant,
  getTenant,
  getUserTenants,
  updateTenant,
  createTenantContext,
  verifyTenantAccess,
  scopeQuery,
  getPermissionsForRole,
  canUserPerform,
  createTenantQuotas,
  updateTenantQuotasFromPlan,
  getTenantQuotasWithUsage,
};
