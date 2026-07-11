/**
 * Phase 20 Schema Migration — Messaging Destination + Language Targeting
 * (Executive Marketing Analytics Layer, continued)
 *
 * Purpose: two small additive columns so Messaging Destination Analytics and
 * Language Analytics can be built from genuinely real Meta fields instead of
 * being skipped or faked:
 *   ads.destination_type            — real Meta Ad field (MESSENGER,
 *     WHATSAPP, INSTAGRAM_DIRECT, ON_AD, ...) identifying which surface a
 *     message-objective ad sends conversations to. Added to the SAME
 *     fetchAds() call metaApiClient.js already makes (one new field on an
 *     existing call -- zero new Meta API calls).
 *   creative_analytics.destination_type — denormalized copy so Messaging
 *     Destination Analytics can group creativeAnalytics' already-fetched
 *     per-ad results/cost data by destination without a second query join
 *     on every read.
 *   ad_sets.targeting_locales        — real Meta AdSet targeting.locales
 *     field (array of language IDs), added to the SAME fetchAdSets() call.
 *     Meta's Insights API has no performance-by-language breakdown, so this
 *     column intentionally supports "what languages is this ad set
 *     configured for" (Language Analytics' configuration view), not a
 *     fabricated performance-by-language split.
 *
 * Method: ALTER TABLE ADD COLUMN -- safe, additive, no data loss. Same
 * idempotent guard pattern as every other phaseN schema file.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase20_messaging_destination_and_language_targeting';

function addColumnIfMissing(table, column, type) {
  const existingCols = db.all(`PRAGMA table_info(${table})`).map(c => c.name);
  if (existingCols.includes(column)) return false;
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    return true;
  } catch (err) {
    console.warn(`[DB] Phase 20: could not add ${table}.${column}:`, err.message);
    return false;
  }
}

function runPhase20Migrations() {
  ensureMigrationsTable();

  let added = 0;
  if (addColumnIfMissing('ads', 'destination_type', 'TEXT')) added++;
  if (addColumnIfMissing('creative_analytics', 'destination_type', 'TEXT')) added++;
  if (addColumnIfMissing('ad_sets', 'targeting_locales', 'TEXT')) added++;

  markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    db.persist();
    console.log(`[DB] Phase 20 migration complete — added ${added} column(s).`);
  } else {
    console.log('[DB] Phase 20 schema: columns already present, skipping.');
  }
}

module.exports = { runPhase20Migrations };
