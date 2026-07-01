/**
 * Phase 5 Schema Extension
 * Adds decision_history table only.
 * All Phase 1–4 tables are untouched.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase5_decision_history';

const PHASE5_SCHEMA = `

-- ─────────────────────────────────────────────
-- Decision history — stores every generated decision
-- and tracks whether the operator acted on it.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS decision_history (
  id                TEXT PRIMARY KEY,
  ad_account_id     TEXT NOT NULL REFERENCES ad_accounts(id),
  meta_campaign_id  TEXT NOT NULL,
  campaign_name     TEXT NOT NULL,
  objective         TEXT,
  decision_type     TEXT NOT NULL,
  priority          TEXT NOT NULL
                      CHECK(priority IN ('critical','high','medium','low')),
  priority_score    REAL NOT NULL DEFAULT 0,
  reason            TEXT NOT NULL,
  supporting_metrics TEXT,
  suggested_action  TEXT NOT NULL,
  expected_impact   TEXT,
  confidence        TEXT CHECK(confidence IN ('high','medium','low')),
  health_score      INTEGER,
  alert_severity    TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','completed','dismissed','snoozed')),
  action_taken      INTEGER DEFAULT 0,
  action_notes      TEXT,
  completed_at      TEXT,
  dismissed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_history_account
  ON decision_history(ad_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_history_campaign
  ON decision_history(meta_campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_history_priority
  ON decision_history(priority_score DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_history_status
  ON decision_history(status, created_at DESC);

`;

function runPhase5Migrations() {
  ensureMigrationsTable();
  console.log('[DB] Running Phase 5 schema migrations...');
  const stmts = PHASE5_SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of stmts) db.run(stmt + ';');
  markMigrationApplied(MIGRATION_NAME);
  console.log('[DB] Phase 5 schema complete.');
}

module.exports = { runPhase5Migrations };
