/**
 * Subscription Service — Phase 29
 *
 * Subscription plans, plan management, and subscription lifecycle.
 */

const db = require('../db/database');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ─────────────────────────────────────────────
// SUBSCRIPTION PLANS
// ─────────────────────────────────────────────

/**
 * Create subscription plan (admin only)
 */
function createPlan(planData) {
  const planId = generateId('plan');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO subscription_plans (
      id, plan_name, plan_slug, description, price_monthly, price_yearly,
      currency, max_users, max_clients, max_ad_accounts, max_ai_requests,
      max_storage_gb, max_api_calls_monthly, max_reports, max_exports,
      max_dashboards, max_workspaces, features_json, tier, is_active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    planId,
    planData.plan_name,
    planData.plan_slug,
    planData.description || null,
    planData.price_monthly || 0,
    planData.price_yearly || 0,
    planData.currency || 'USD',
    planData.max_users || null,
    planData.max_clients || null,
    planData.max_ad_accounts || null,
    planData.max_ai_requests || 1000,
    planData.max_storage_gb || 10,
    planData.max_api_calls_monthly || 10000,
    planData.max_reports || 100,
    planData.max_exports || 50,
    planData.max_dashboards || 10,
    planData.max_workspaces || 1,
    JSON.stringify(planData.features || []),
    planData.tier || 1,
    planData.is_active !== false ? 1 : 0,
    now,
    now,
  ]);

  return getPlan(planId);
}

/**
 * Get plan by ID
 */
function getPlan(planId) {
  const plan = db.get(`
    SELECT * FROM subscription_plans WHERE id = ?
  `, [planId]);

  if (!plan) return null;

  return {
    ...plan,
    features: plan.features_json ? JSON.parse(plan.features_json) : [],
  };
}

/**
 * Get plan by slug
 */
function getPlanBySlug(slug) {
  const plan = db.get(`
    SELECT * FROM subscription_plans WHERE plan_slug = ?
  `, [slug]);

  if (!plan) return null;

  return {
    ...plan,
    features: plan.features_json ? JSON.parse(plan.features_json) : [],
  };
}

/**
 * List all active plans
 */
function listPlans(includeInactive = false) {
  let query = 'SELECT * FROM subscription_plans';
  const params = [];

  if (!includeInactive) {
    query += ' WHERE is_active = 1';
  }

  query += ' ORDER BY tier ASC';

  const plans = db.all(query, params);
  return plans.map(p => ({
    ...p,
    features: p.features_json ? JSON.parse(p.features_json) : [],
  }));
}

// ─────────────────────────────────────────────
// TENANT SUBSCRIPTIONS
// ─────────────────────────────────────────────

/**
 * Subscribe tenant to plan
 */
function subscribeTenantToPlan(tenantId, planId, billingCycle = 'monthly') {
  const subscriptionId = generateId('sub');
  const now = new Date().toISOString();

  const currentPeriodStart = new Date();
  const currentPeriodEnd = new Date();

  if (billingCycle === 'monthly') {
    currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
  } else if (billingCycle === 'yearly') {
    currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1);
  }

  // Remove existing subscription
  db.run('DELETE FROM tenant_subscriptions WHERE tenant_id = ?', [tenantId]);

  // Create new subscription
  db.run(`
    INSERT INTO tenant_subscriptions (
      id, tenant_id, plan_id, billing_cycle, current_period_start,
      current_period_end, status, auto_renew, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    subscriptionId,
    tenantId,
    planId,
    billingCycle,
    currentPeriodStart.toISOString(),
    currentPeriodEnd.toISOString(),
    'active',
    1,
    now,
    now,
  ]);

  // Update tenant quotas based on plan
  const tenantService = require('./tenantService');
  tenantService.updateTenantQuotasFromPlan(tenantId, planId);

  return getSubscription(tenantId);
}

/**
 * Get tenant's current subscription
 */
function getSubscription(tenantId) {
  return db.get(`
    SELECT ts.*, sp.plan_name, sp.plan_slug, sp.features_json
    FROM tenant_subscriptions ts
    LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
    WHERE ts.tenant_id = ?
  `, [tenantId]);
}

/**
 * Cancel subscription
 */
function cancelSubscription(tenantId, reason = null) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE tenant_subscriptions
    SET status = 'cancelled', cancelled_at = ?, cancel_at = ?, updated_at = ?
    WHERE tenant_id = ?
  `, [now, now, now, tenantId]);

  return getSubscription(tenantId);
}

/**
 * Pause subscription
 */
function pauseSubscription(tenantId) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE tenant_subscriptions
    SET status = 'paused', updated_at = ?
    WHERE tenant_id = ?
  `, [now, tenantId]);

  return getSubscription(tenantId);
}

/**
 * Resume subscription
 */
function resumeSubscription(tenantId) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE tenant_subscriptions
    SET status = 'active', updated_at = ?
    WHERE tenant_id = ?
  `, [now, tenantId]);

  return getSubscription(tenantId);
}

/**
 * Check if subscription is expiring soon
 */
function isExpiringInDays(tenantId, days = 7) {
  const subscription = getSubscription(tenantId);
  if (!subscription || subscription.status !== 'active') return false;

  const expiryDate = new Date(subscription.current_period_end);
  const daysFromNow = (expiryDate - new Date()) / (1000 * 60 * 60 * 24);

  return daysFromNow <= days && daysFromNow > 0;
}

/**
 * Check if tenant can use feature (based on plan)
 */
function canAccessFeature(tenantId, featureKey) {
  const subscription = getSubscription(tenantId);
  if (!subscription) return false;

  const features = JSON.parse(subscription.features_json || '[]');
  return features.includes(featureKey);
}

/**
 * Get subscription statistics
 */
function getSubscriptionStats() {
  const totalTenants = db.get(
    'SELECT COUNT(*) as count FROM tenants'
  )?.count || 0;

  const activeSubscriptions = db.get(
    'SELECT COUNT(*) as count FROM tenant_subscriptions WHERE status = "active"'
  )?.count || 0;

  const byStatus = db.all(`
    SELECT status, COUNT(*) as count
    FROM tenant_subscriptions
    GROUP BY status
  `);

  const byPlan = db.all(`
    SELECT sp.plan_name, COUNT(*) as count
    FROM tenant_subscriptions ts
    LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
    GROUP BY sp.plan_name
  `);

  const mrr = db.get(`
    SELECT SUM(sp.price_monthly) as total
    FROM tenant_subscriptions ts
    LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
    WHERE ts.status = 'active' AND ts.billing_cycle = 'monthly'
  `)?.total || 0;

  return {
    total_tenants: totalTenants,
    active_subscriptions: activeSubscriptions,
    by_status: byStatus,
    by_plan: byPlan,
    mrr: mrr,
  };
}

module.exports = {
  createPlan,
  getPlan,
  getPlanBySlug,
  listPlans,
  subscribeTenantToPlan,
  getSubscription,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  isExpiringInDays,
  canAccessFeature,
  getSubscriptionStats,
};
