/**
 * Phase 7B Schema Migration
 *
 * Purpose: Add creative preview columns to `ads` table (Part 7).
 * Method: ALTER TABLE ADD COLUMN — safe, additive, no data loss.
 * SQLite supports ADD COLUMN without a table-replace migration.
 *
 * Existing tables modified: ads (4 new nullable columns)
 * New tables: NONE
 * Existing data: fully preserved — new columns default to NULL
 */

const db = require('./database');

const NEW_COLUMNS = [
  { name: 'creative_id',  type: 'TEXT' },
  { name: 'thumbnail_url', type: 'TEXT' },
  { name: 'image_url',    type: 'TEXT' },
  { name: 'preview_url',  type: 'TEXT' },
];

function runPhase7BMigrations() {
  const existingCols = db.all("PRAGMA table_info(ads)").map(c => c.name);

  let added = 0;
  for (const col of NEW_COLUMNS) {
    if (existingCols.includes(col.name)) continue; // idempotent guard
    try {
      db.run(`ALTER TABLE ads ADD COLUMN ${col.name} ${col.type}`);
      added++;
    } catch (err) {
      console.warn(`[DB] Phase 7B: could not add column ${col.name}:`, err.message);
    }
  }

  if (added > 0) {
    db.persist();
    console.log(`[DB] Phase 7B migration complete — added ${added} creative preview column(s) to ads.`);
  } else {
    console.log('[DB] Phase 7B schema: creative preview columns already present, skipping.');
  }
}

module.exports = { runPhase7BMigrations };
