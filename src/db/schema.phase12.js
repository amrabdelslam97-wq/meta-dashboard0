/**
 * Phase 12 Schema Migration — MAIFS Enforcement for Recommendations/Alerts
 *
 * Purpose: Add governance_state to recommendation_log and active_alerts,
 * mirroring rule_engine_log.governance_state (phase 11). Lets MAIFS
 * enforcement (maifsGovernance.enforceGovernance()) persist its verdict for
 * recommendation-/alert-sourced decisions the same way it already does for
 * Rule Engine findings, so every read path (Insights, GET /recommendations,
 * GET /alerts, GET /decisions) sees one governed value instead of
 * recomputing or -- as today -- never checking at all.
 *
 * Method: ALTER TABLE ADD COLUMN — safe, additive, no data loss.
 *
 * Existing tables modified: recommendation_log, active_alerts (1 new
 * nullable column each)
 * New tables: NONE
 * Existing data: fully preserved — new column defaults to NULL, treated as
 * "not yet governed" (no downgrade) by every read path.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase12_governance_state_columns';

function addColumnIfMissing(table, column, type) {
  const existingCols = db.all(`PRAGMA table_info(${table})`).map(c => c.name);
  if (existingCols.includes(column)) return false;
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    return true;
  } catch (err) {
    console.warn(`[DB] Phase 12: could not add column ${column} to ${table}:`, err.message);
    return false;
  }
}

function runPhase12Migrations() {
  ensureMigrationsTable();

  let added = 0;
  if (addColumnIfMissing('recommendation_log', 'governance_state', 'TEXT')) added++;
  if (addColumnIfMissing('active_alerts', 'governance_state', 'TEXT')) added++;

  markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    db.persist();
    console.log(`[DB] Phase 12 migration complete — added governance_state to ${added} table(s).`);
  } else {
    console.log('[DB] Phase 12 schema: governance_state columns already present, skipping.');
  }
}

module.exports = { runPhase12Migrations };
