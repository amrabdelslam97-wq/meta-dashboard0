'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const database = require('../../src/db/database');
const { runMigrations } = require('../../src/db/schema');
const { runPhase2Migrations } = require('../../src/db/schema.phase2');
const { runPhase5Migrations } = require('../../src/db/schema.phase5');
const { runPhase6Migrations } = require('../../src/db/schema.phase6');
const { runPhase7BMigrations } = require('../../src/db/schema.phase7b');
const { runUniqueConstraintsMigration } = require('../../src/db/schema.uniqueConstraints');
const { seedIntelligenceConfig } = require('../../src/db/seedIntelligence');

/**
 * Create a fresh temp SQLite file, run the exact same migration set
 * app.js runs on boot, and return the path + a cleanup function.
 * Each test file should call this once in beforeAll and clean up in
 * afterAll -- the underlying `database` module is a singleton, so
 * concurrent DBs within one test file aren't supported (matches how
 * the real app only ever runs against one DB at a time).
 */
async function createTestDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `meta-ads-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`
  );

  await database.initializeDatabase(dbPath);
  runMigrations();
  runPhase2Migrations();
  runPhase5Migrations();
  runPhase6Migrations();
  runPhase7BMigrations();
  runUniqueConstraintsMigration();
  seedIntelligenceConfig();

  return {
    dbPath,
    db: database,
    cleanup() {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    },
  };
}

module.exports = { createTestDb };
