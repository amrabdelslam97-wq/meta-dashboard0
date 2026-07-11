/**
 * Phase 15 Schema Migration — Meta Lifecycle Status Awareness
 *
 * Purpose: capture Meta's `effective_status` (the actual delivery state,
 * accounting for parent-entity pausing, ad review, policy issues, billing,
 * and account-level restrictions) alongside the existing `status` column,
 * for campaigns/ad_sets/ads.
 *
 * `status` (already stored) is what the advertiser/API directly set at that
 * level (e.g. "ACTIVE" = "I didn't pause this"). It is NOT the same as
 * whether the entity is actually delivering right now -- an ad set can have
 * status=ACTIVE while its real effective_status is CAMPAIGN_PAUSED (parent
 * campaign paused), and an ad can have status=ACTIVE while its real
 * effective_status is ADSET_PAUSED/CAMPAIGN_PAUSED, or DISAPPROVED/
 * PENDING_REVIEW/WITH_ISSUES from Meta's ad review pipeline. This is the
 * root cause of the Dashboard treating paused/inactive entities as active.
 *
 * Stored VERBATIM as Meta returns it (uppercase, e.g. "CAMPAIGN_PAUSED"),
 * never reduced/normalized to our existing 4-value status enum -- see
 * src/services/metaLifecycle.js for the single source of truth on what each
 * value means and whether it counts as "delivering".
 *
 * Method: ALTER TABLE ADD COLUMN -- safe, additive, no data loss. Same
 * idempotent guard pattern as schema.phase7b.js/schema.phase14.js.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase15_meta_lifecycle_status';

const TABLES_WITH_NEW_COLUMN = ['campaigns', 'ad_sets', 'ads'];

function runPhase15Migrations() {
  ensureMigrationsTable();

  let added = 0;
  for (const table of TABLES_WITH_NEW_COLUMN) {
    const existingCols = db.all(`PRAGMA table_info(${table})`).map(c => c.name);
    if (existingCols.includes('effective_status')) continue; // idempotent guard
    try {
      db.run(`ALTER TABLE ${table} ADD COLUMN effective_status TEXT`);
      added++;
    } catch (err) {
      console.warn(`[DB] Phase 15: could not add effective_status to ${table}:`, err.message);
    }
  }

  markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    db.persist();
    console.log(`[DB] Phase 15 migration complete — added effective_status to ${added} table(s).`);
  } else {
    console.log('[DB] Phase 15 schema: effective_status columns already present, skipping.');
  }
}

module.exports = { runPhase15Migrations };
