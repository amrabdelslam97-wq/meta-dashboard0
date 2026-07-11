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
const { runPhase8Migrations } = require('../../src/db/schema.phase8');
const { runUniqueConstraintsMigration } = require('../../src/db/schema.uniqueConstraints');
const { runPhase11Migrations } = require('../../src/db/schema.phase11');
const { runPhase12Migrations } = require('../../src/db/schema.phase12');
const { runPhase13Migrations } = require('../../src/db/schema.phase13');
const { runPhase14Migrations } = require('../../src/db/schema.phase14');
const { runPhase15Migrations } = require('../../src/db/schema.phase15');
const { runPhase16Migrations } = require('../../src/db/schema.phase16');
const { runPhase17Migrations } = require('../../src/db/schema.phase17');
const { runPhase18Migrations } = require('../../src/db/schema.phase18');
const { runPhase19Migrations } = require('../../src/db/schema.phase19');
const { runPhase20Migrations } = require('../../src/db/schema.phase20');
const { runPhase21Migrations } = require('../../src/db/schema.phase21');
const { runPhase22Migrations } = require('../../src/db/schema.phase22');
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
  runPhase8Migrations();
  runUniqueConstraintsMigration();
  runPhase11Migrations();
  runPhase12Migrations();
  runPhase13Migrations();
  runPhase14Migrations();
  runPhase15Migrations();
  runPhase16Migrations();
  runPhase17Migrations();
  runPhase18Migrations();
  runPhase19Migrations();
  runPhase20Migrations();
  runPhase21Migrations();
  runPhase22Migrations();
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
