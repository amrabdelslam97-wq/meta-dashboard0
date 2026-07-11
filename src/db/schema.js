/**
 * Schema Definition — Phase 1 Core Tables Only
 *
 * Tables:
 *   1. users          — single operator account
 *   2. ad_accounts    — connected Meta ad accounts
 *   3. campaigns      — fetched from Meta, upserted on sync
 *   4. ad_sets        — fetched from Meta, upserted on sync
 *   5. ads            — fetched from Meta, upserted on sync
 *
 * No intelligence tables. No metrics tables. No analytics.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase1_core_tables';

const SCHEMA_SQL = `

-- ─────────────────────────────────────────────
-- TABLE: users
-- Single operator. One row only.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────
-- TABLE: ad_accounts
-- Root entity. Every campaign belongs to one.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_accounts (
  id                      TEXT PRIMARY KEY,
  meta_account_id         TEXT NOT NULL UNIQUE,
  account_name            TEXT NOT NULL,
  client_label            TEXT,
  currency                TEXT NOT NULL DEFAULT 'USD',
  timezone                TEXT NOT NULL DEFAULT 'UTC',
  country_code            TEXT,
  attribution_window_days INTEGER NOT NULL DEFAULT 7,
  access_token_encrypted  TEXT NOT NULL,
  token_expires_at        TEXT,
  token_is_valid          INTEGER NOT NULL DEFAULT 1,
  last_token_verified_at  TEXT,
  status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK(status IN ('active','paused','disconnected','error')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ad_accounts_meta_id
  ON ad_accounts(meta_account_id);

CREATE INDEX IF NOT EXISTS idx_ad_accounts_status
  ON ad_accounts(status);

-- ─────────────────────────────────────────────
-- TABLE: campaigns
-- Fetched from Meta API and upserted on sync.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                      TEXT PRIMARY KEY,
  ad_account_id           TEXT NOT NULL REFERENCES ad_accounts(id),
  meta_campaign_id        TEXT NOT NULL UNIQUE,
  name                    TEXT NOT NULL,
  objective               TEXT NOT NULL
                            -- schema.phase8.js migrates existing databases to this same 7-value list
                            -- (kept in sync here so a fresh DB matches the post-migration shape exactly)
                            CHECK(objective IN (
                              'awareness','traffic','engagement','leads','app_promotion','sales','unknown'
                            )),
  objective_effective_from TEXT,
  status                  TEXT NOT NULL
                            CHECK(status IN ('active','paused','archived','deleted')),
  meta_created_time       TEXT,
  meta_updated_time       TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaigns_ad_account_id
  ON campaigns(ad_account_id);

CREATE INDEX IF NOT EXISTS idx_campaigns_meta_id
  ON campaigns(meta_campaign_id);

CREATE INDEX IF NOT EXISTS idx_campaigns_status
  ON campaigns(status);

CREATE INDEX IF NOT EXISTS idx_campaigns_objective
  ON campaigns(objective);

-- ─────────────────────────────────────────────
-- TABLE: ad_sets
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_sets (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL REFERENCES campaigns(id),
  ad_account_id       TEXT NOT NULL REFERENCES ad_accounts(id),
  meta_adset_id       TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL
                        CHECK(status IN ('active','paused','archived','deleted')),
  daily_budget        REAL,
  lifetime_budget     REAL,
  meta_created_time   TEXT,
  meta_updated_time   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ad_sets_campaign_id
  ON ad_sets(campaign_id);

CREATE INDEX IF NOT EXISTS idx_ad_sets_ad_account_id
  ON ad_sets(ad_account_id);

CREATE INDEX IF NOT EXISTS idx_ad_sets_meta_id
  ON ad_sets(meta_adset_id);

CREATE INDEX IF NOT EXISTS idx_ad_sets_status
  ON ad_sets(status);

-- ─────────────────────────────────────────────
-- TABLE: ads
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads (
  id                  TEXT PRIMARY KEY,
  ad_set_id           TEXT NOT NULL REFERENCES ad_sets(id),
  campaign_id         TEXT NOT NULL REFERENCES campaigns(id),
  ad_account_id       TEXT NOT NULL REFERENCES ad_accounts(id),
  meta_ad_id          TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL
                        CHECK(status IN ('active','paused','archived','deleted')),
  meta_created_time   TEXT,
  meta_updated_time   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ads_ad_set_id
  ON ads(ad_set_id);

CREATE INDEX IF NOT EXISTS idx_ads_campaign_id
  ON ads(campaign_id);

CREATE INDEX IF NOT EXISTS idx_ads_ad_account_id
  ON ads(ad_account_id);

CREATE INDEX IF NOT EXISTS idx_ads_meta_id
  ON ads(meta_ad_id);

CREATE INDEX IF NOT EXISTS idx_ads_status
  ON ads(status);

`;

/**
 * Run the schema against the database.
 * Safe to run multiple times — uses CREATE IF NOT EXISTS.
 */
function runMigrations() {
  ensureMigrationsTable();
  console.log('[DB] Running schema migrations...');

  // Split on semicolons and run each statement individually
  // (sql.js doesn't support multiple statements in one run call)
  const statements = SCHEMA_SQL
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    db.run(statement + ';');
  }

  markMigrationApplied(MIGRATION_NAME);
  console.log('[DB] Schema migrations complete.');
}

module.exports = { runMigrations };
