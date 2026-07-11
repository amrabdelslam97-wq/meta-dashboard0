/**
 * Phase 29 — Enterprise SaaS Platform & Multi-Tenant Architecture
 *
 * Complete multi-tenant architecture with subscription system, billing,
 * license management, white label support, API platform, and observability.
 *
 * Key Principle: Tenant isolation WITHOUT data duplication
 * - All existing tables extended with tenant_id
 * - New tables for SaaS infrastructure (subscriptions, licenses, usage, etc.)
 * - Tenant context flows through middleware
 * - All queries automatically scoped by tenant_id
 *
 * Tables:
 *   1. tenants                    — Organization/Agency/Enterprise profiles
 *   2. tenant_memberships         — Users per tenant
 *   3. tenant_settings            — Branding, localization, configuration
 *   4. subscription_plans         — Plan definitions (Free, Starter, Pro, Business, Enterprise)
 *   5. tenant_subscriptions       — Active subscriptions per tenant
 *   6. feature_flags              — Feature enable/disable per tenant/plan/user
 *   7. usage_tracking             — API calls, storage, AI requests, syncs
 *   8. billing_history            — Invoices, payments, refunds
 *   9. license_keys               — Enterprise license tracking
 *  10. api_keys                   — Tenant API keys for integrations
 *  11. webhook_subscriptions      — Webhook configurations
 *  12. tenant_quotas              — Storage/API/user limits per tenant
 *  13. audit_log_extended         — Tenant-scoped audit events
 *  14. notification_preferences   — Email, notification settings per user
 *  15. storage_usage              — Per-tenant storage tracking
 *  16. background_jobs            — Async job queue for SaaS operations
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase29_enterprise_saas_platform';

const SCHEMA_SQL = `

-- ─────────────────────────────────────────────
-- TABLE: tenants
-- Multi-tenant organization/agency/enterprise profiles
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id                    TEXT PRIMARY KEY,
  owner_user_id         TEXT NOT NULL REFERENCES users(id),
  tenant_type           TEXT NOT NULL CHECK(tenant_type IN (
    'agency','company','brand','enterprise','franchise','holding_company','personal'
  )),
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL UNIQUE,
  logo_url              TEXT,
  logo_dark_url         TEXT,
  industry              TEXT,
  country               TEXT,
  timezone              TEXT DEFAULT 'UTC',
  currency              TEXT DEFAULT 'USD',
  language              TEXT DEFAULT 'en',
  custom_domain         TEXT UNIQUE,
  primary_color         TEXT DEFAULT '#667eea',
  secondary_color       TEXT DEFAULT '#764ba2',
  billing_email         TEXT,
  billing_name          TEXT,
  billing_address       TEXT,
  billing_city          TEXT,
  billing_country       TEXT,
  billing_zip           TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
    'active','trial','paused','suspended','cancelled'
  )),
  trial_ends_at         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tenants_owner
  ON tenants(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_tenants_slug
  ON tenants(slug);

CREATE INDEX IF NOT EXISTS idx_tenants_custom_domain
  ON tenants(custom_domain);

CREATE INDEX IF NOT EXISTS idx_tenants_status
  ON tenants(status);

-- ─────────────────────────────────────────────
-- TABLE: tenant_memberships
-- Users assigned to tenants
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_memberships (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  role                  TEXT NOT NULL CHECK(role IN (
    'owner','admin','manager','member','viewer','custom'
  )),
  status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
    'active','invited','suspended','removed'
  )),
  invited_at            TEXT,
  joined_at             TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant
  ON tenant_memberships(tenant_id);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user
  ON tenant_memberships(user_id);

-- ─────────────────────────────────────────────
-- TABLE: tenant_settings
-- Per-tenant branding, localization, configuration
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_settings (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  theme                 TEXT DEFAULT 'light' CHECK(theme IN ('light','dark','auto')),
  date_format           TEXT DEFAULT 'MM/DD/YYYY',
  number_format         TEXT DEFAULT 'en-US',
  week_starts_on        TEXT DEFAULT 'monday',
  custom_login_html     TEXT,
  custom_email_template TEXT,
  custom_report_footer  TEXT,
  custom_favicon_url    TEXT,
  hide_branding         INTEGER DEFAULT 0,
  analytics_enabled     INTEGER DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_settings_tenant
  ON tenant_settings(tenant_id);

-- ─────────────────────────────────────────────
-- TABLE: subscription_plans
-- Plan definitions available on platform
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plans (
  id                    TEXT PRIMARY KEY,
  plan_name             TEXT NOT NULL UNIQUE,
  plan_slug             TEXT NOT NULL UNIQUE,
  description           TEXT,
  price_monthly         REAL NOT NULL,
  price_yearly          REAL NOT NULL,
  currency              TEXT DEFAULT 'USD',
  max_users             INTEGER,
  max_clients           INTEGER,
  max_ad_accounts       INTEGER,
  max_ai_requests       INTEGER DEFAULT 1000,
  max_storage_gb        INTEGER DEFAULT 10,
  max_api_calls_monthly INTEGER DEFAULT 10000,
  max_reports           INTEGER DEFAULT 100,
  max_exports           INTEGER DEFAULT 50,
  max_dashboards        INTEGER DEFAULT 10,
  max_workspaces        INTEGER DEFAULT 1,
  features_json         TEXT NOT NULL,
  tier                  INTEGER NOT NULL,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_slug
  ON subscription_plans(plan_slug);

-- ─────────────────────────────────────────────
-- TABLE: tenant_subscriptions
-- Active subscription per tenant
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  plan_id               TEXT NOT NULL REFERENCES subscription_plans(id),
  billing_cycle         TEXT NOT NULL CHECK(billing_cycle IN ('monthly','yearly','custom')),
  current_period_start  TEXT NOT NULL,
  current_period_end    TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
    'active','trialing','paused','past_due','cancelled'
  )),
  auto_renew            INTEGER NOT NULL DEFAULT 1,
  cancel_at             TEXT,
  cancelled_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_tenant
  ON tenant_subscriptions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_plan
  ON tenant_subscriptions(plan_id);

CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_status
  ON tenant_subscriptions(status);

-- ─────────────────────────────────────────────
-- TABLE: feature_flags
-- Enable/disable features per tenant/plan/user
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  id                    TEXT PRIMARY KEY,
  feature_key           TEXT NOT NULL,
  feature_name          TEXT NOT NULL,
  description           TEXT,
  scope                 TEXT NOT NULL CHECK(scope IN ('global','plan','tenant','user')),
  scope_id              TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(feature_key, scope, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_key
  ON feature_flags(feature_key);

CREATE INDEX IF NOT EXISTS idx_feature_flags_scope
  ON feature_flags(scope, scope_id);

-- ─────────────────────────────────────────────
-- TABLE: usage_tracking
-- API calls, storage, AI usage, syncs per tenant
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_tracking (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  tracking_month        TEXT NOT NULL,
  api_calls_count       INTEGER DEFAULT 0,
  sync_jobs_count       INTEGER DEFAULT 0,
  ai_requests_count     INTEGER DEFAULT 0,
  storage_bytes_used    INTEGER DEFAULT 0,
  users_count           INTEGER DEFAULT 0,
  reports_generated     INTEGER DEFAULT 0,
  exports_count         INTEGER DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, tracking_month)
);

CREATE INDEX IF NOT EXISTS idx_usage_tracking_tenant
  ON usage_tracking(tenant_id);

CREATE INDEX IF NOT EXISTS idx_usage_tracking_month
  ON usage_tracking(tracking_month);

-- ─────────────────────────────────────────────
-- TABLE: billing_history
-- Invoices, payments, refunds per tenant
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_history (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  invoice_number        TEXT NOT NULL,
  subscription_id       TEXT REFERENCES tenant_subscriptions(id),
  amount_cents          INTEGER NOT NULL,
  currency              TEXT DEFAULT 'USD',
  billing_reason        TEXT CHECK(billing_reason IN (
    'subscription_cycle','upgrade','downgrade','proration','manual','refund'
  )),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','paid','failed','refunded','cancelled'
  )),
  payment_method        TEXT,
  payment_date          TEXT,
  refund_date           TEXT,
  refund_reason         TEXT,
  description           TEXT,
  pdf_url               TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_billing_history_tenant
  ON billing_history(tenant_id);

CREATE INDEX IF NOT EXISTS idx_billing_history_status
  ON billing_history(status);

CREATE INDEX IF NOT EXISTS idx_billing_history_invoice
  ON billing_history(invoice_number);

-- ─────────────────────────────────────────────
-- TABLE: license_keys
-- Enterprise license tracking
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS license_keys (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  license_key           TEXT NOT NULL UNIQUE,
  license_type          TEXT NOT NULL CHECK(license_type IN (
    'trial','starter','professional','business','enterprise','custom'
  )),
  max_campaigns         INTEGER,
  max_users             INTEGER,
  activated_at          TEXT,
  expires_at            TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
    'active','expired','revoked','suspended'
  )),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_license_keys_tenant
  ON license_keys(tenant_id);

CREATE INDEX IF NOT EXISTS idx_license_keys_key
  ON license_keys(license_key);

CREATE INDEX IF NOT EXISTS idx_license_keys_status
  ON license_keys(status);

-- ─────────────────────────────────────────────
-- TABLE: api_keys
-- Tenant API keys for integrations
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  api_key               TEXT NOT NULL UNIQUE,
  key_name              TEXT NOT NULL,
  description           TEXT,
  last_used_at          TEXT,
  rate_limit_per_minute INTEGER DEFAULT 60,
  scopes_json           TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant
  ON api_keys(tenant_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_key
  ON api_keys(api_key);

-- ─────────────────────────────────────────────
-- TABLE: webhook_subscriptions
-- Webhook configurations per tenant
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  event_type            TEXT NOT NULL CHECK(event_type IN (
    'campaign.updated','sync.completed','recommendation.generated',
    'approval.requested','decision.created','alert.triggered',
    'report.generated','export.completed'
  )),
  webhook_url           TEXT NOT NULL,
  webhook_secret        TEXT NOT NULL,
  is_active             INTEGER NOT NULL DEFAULT 1,
  retry_count           INTEGER DEFAULT 3,
  last_delivery_at      TEXT,
  last_delivery_status  TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_tenant
  ON webhook_subscriptions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_event
  ON webhook_subscriptions(event_type);

-- ─────────────────────────────────────────────
-- TABLE: tenant_quotas
-- Storage/API/user limits tracking per tenant
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_quotas (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  max_storage_gb        INTEGER NOT NULL,
  max_users             INTEGER NOT NULL,
  max_api_calls_monthly INTEGER NOT NULL,
  max_ad_accounts       INTEGER NOT NULL,
  max_dashboards        INTEGER NOT NULL,
  reset_date            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_quotas_tenant
  ON tenant_quotas(tenant_id);

-- ─────────────────────────────────────────────
-- TABLE: audit_log_extended
-- Tenant-scoped audit events
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log_extended (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  user_id               TEXT REFERENCES users(id),
  action                TEXT NOT NULL,
  entity_type           TEXT,
  entity_id             TEXT,
  old_value             TEXT,
  new_value             TEXT,
  ip_address            TEXT,
  user_agent            TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_extended_tenant
  ON audit_log_extended(tenant_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_extended_user
  ON audit_log_extended(user_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_extended_created
  ON audit_log_extended(created_at);

-- ─────────────────────────────────────────────
-- TABLE: notification_preferences
-- Email/notification settings per user/tenant
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  email_invitations     INTEGER DEFAULT 1,
  email_reports         INTEGER DEFAULT 1,
  email_notifications   INTEGER DEFAULT 1,
  email_approvals       INTEGER DEFAULT 1,
  in_app_notifications  INTEGER DEFAULT 1,
  slack_notifications   INTEGER DEFAULT 0,
  teams_notifications   INTEGER DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_tenant_user
  ON notification_preferences(tenant_id, user_id);

-- ─────────────────────────────────────────────
-- TABLE: storage_usage
-- Per-tenant storage usage tracking
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_usage (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  entity_type           TEXT NOT NULL,
  entity_count          INTEGER DEFAULT 0,
  bytes_used            INTEGER DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_storage_usage_tenant
  ON storage_usage(tenant_id);

-- ─────────────────────────────────────────────
-- TABLE: background_jobs
-- Async job queue for SaaS operations
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS background_jobs (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  job_type              TEXT NOT NULL CHECK(job_type IN (
    'send_email','export_report','generate_invoice','sync_accounts',
    'clean_storage','process_webhook','generate_analytics'
  )),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','processing','completed','failed','cancelled'
  )),
  priority              TEXT DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')),
  payload_json          TEXT,
  result_json           TEXT,
  error_message         TEXT,
  retry_count           INTEGER DEFAULT 0,
  max_retries           INTEGER DEFAULT 3,
  scheduled_for         TEXT,
  started_at            TEXT,
  completed_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_background_jobs_tenant
  ON background_jobs(tenant_id);

CREATE INDEX IF NOT EXISTS idx_background_jobs_status
  ON background_jobs(status);

CREATE INDEX IF NOT EXISTS idx_background_jobs_scheduled
  ON background_jobs(scheduled_for);

`;

function runPhase29Migrations() {
  try {
    ensureMigrationsTable();
    if (process.env.SKIP_MIGRATIONS) return;
    const migrationApplied = db.get(
      'SELECT 1 FROM migrations WHERE migration_name = ?',
      [MIGRATION_NAME]
    );
    if (migrationApplied) return;

    db.run(SCHEMA_SQL);
    markMigrationApplied(MIGRATION_NAME);
    console.log('✓ Phase 29 (Enterprise SaaS Platform) migrations applied');
  } catch (e) {
    console.error(`Phase 29 migration error: ${e.message}`);
  }
}

module.exports = {
  runPhase29Migrations,
};
