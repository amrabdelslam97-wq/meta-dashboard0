/**
 * Phase 11 Schema Extension — Rule Engine Log
 *
 * Adds rule_engine_log only. All prior-phase tables are untouched.
 *
 * Mirrors recommendation_log's shape/lifecycle (generated_at/
 * last_generated_at/dismissed_at, one active row per rule+entity) so that
 * decisionEngine.generateTodaysDecisions() can read persisted Rule Engine
 * firings the exact same way it already reads recommendation_log/
 * active_alerts -- closing the gap (found in the Framework Runtime
 * Evidence audit) where ruleEngine.js's firings only ever existed
 * on-the-fly inside a single /insights request and never reached the
 * Decision Center.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase11_rule_engine_log';

const PHASE11_SCHEMA = `

-- ─────────────────────────────────────────────
-- Rule Engine log — persists every Framework rule firing produced by
-- src/services/ruleEngine.js, so it can be read back by the Decision
-- Center the same way recommendation_log/active_alerts already are.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rule_engine_log (
  id                TEXT PRIMARY KEY,
  rule_id           TEXT NOT NULL,
  framework         TEXT NOT NULL,
  rule_name         TEXT NOT NULL,
  ad_account_id     TEXT NOT NULL REFERENCES ad_accounts(id),
  entity_type       TEXT NOT NULL DEFAULT 'campaign',
  entity_meta_id    TEXT NOT NULL,
  entity_label      TEXT NOT NULL,
  objective         TEXT,
  category          TEXT,
  severity          TEXT NOT NULL,
  reason            TEXT NOT NULL,
  evidence          TEXT,
  decision_type     TEXT NOT NULL,
  governance_state  TEXT,
  generated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_rule_engine_log_entity
  ON rule_engine_log(entity_meta_id, dismissed_at);

CREATE INDEX IF NOT EXISTS idx_rule_engine_log_account
  ON rule_engine_log(ad_account_id, dismissed_at);

`;

function runPhase11Migrations() {
  ensureMigrationsTable();
  console.log('[DB] Running Phase 11 schema migrations...');
  const stmts = PHASE11_SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of stmts) db.run(stmt + ';');
  markMigrationApplied(MIGRATION_NAME);
  console.log('[DB] Phase 11 schema complete.');
}

module.exports = { runPhase11Migrations };
