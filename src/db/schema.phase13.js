/**
 * Phase 13 Schema Extension — Executive Memory
 *
 * Adds diagnosis_history and decision_outcomes only. All prior-phase tables
 * are untouched.
 *
 * diagnosis_history persists diagnosisEngine.diagnoseCampaign()'s output,
 * which was previously computed fresh on every call and discarded --
 * mirrors health_score_history's shape/lifecycle (one row per analysis run,
 * entity_meta_id-keyed).
 *
 * decision_outcomes is a third, distinct lifecycle stage for a past
 * decision -- decision_history already owns "what was decided" (decision_type,
 * priority, reason) and "what the user did" (status, action_taken,
 * completed_at); this table owns "what resulted" (a measured before/after
 * metric comparison). Kept separate rather than adding columns to
 * decision_history so every existing decision_history reader is unaffected.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase13_executive_memory';

const PHASE13_SCHEMA = `

-- ─────────────────────────────────────────────
-- Diagnosis history — persists every diagnosisEngine.diagnoseCampaign()
-- result, so past root-cause findings survive beyond a single request.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diagnosis_history (
  id                TEXT PRIMARY KEY,
  ad_account_id     TEXT NOT NULL REFERENCES ad_accounts(id),
  entity_type       TEXT NOT NULL DEFAULT 'campaign',
  entity_meta_id    TEXT NOT NULL,
  objective         TEXT,
  status            TEXT NOT NULL,
  primary_key       TEXT,
  primary_label     TEXT,
  delta_pct         REAL,
  category          TEXT,
  confidence        TEXT,
  priority          TEXT,
  factors           TEXT,
  summary           TEXT,
  calculated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_diagnosis_history_entity
  ON diagnosis_history(entity_meta_id, calculated_at);

-- ─────────────────────────────────────────────
-- Decision outcomes — one row per MEASURED outcome of a past decision_history
-- row (before/after metric comparison), read by executiveMemory.js's
-- getHistoricalEffectiveness() to adjust future decisions of the same type
-- for the same campaign.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS decision_outcomes (
  id                  TEXT PRIMARY KEY,
  decision_history_id TEXT NOT NULL REFERENCES decision_history(id),
  meta_campaign_id    TEXT NOT NULL,
  decision_type       TEXT NOT NULL,
  metric_key          TEXT NOT NULL,
  metric_before       REAL,
  metric_after        REAL,
  delta_pct           REAL,
  outcome             TEXT NOT NULL CHECK(outcome IN ('improved','no_change','worsened')),
  measured_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_outcomes_campaign_type
  ON decision_outcomes(meta_campaign_id, decision_type, measured_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_outcomes_unique
  ON decision_outcomes(decision_history_id);

`;

function runPhase13Migrations() {
  ensureMigrationsTable();
  console.log('[DB] Running Phase 13 schema migrations...');
  const stmts = PHASE13_SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of stmts) db.run(stmt + ';');
  markMigrationApplied(MIGRATION_NAME);
  console.log('[DB] Phase 13 schema complete.');
}

module.exports = { runPhase13Migrations };
