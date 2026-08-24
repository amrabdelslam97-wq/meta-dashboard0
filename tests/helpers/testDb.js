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
const { runPhase23Migrations } = require('../../src/db/schema.phase23');
const { runPhase24Migrations } = require('../../src/db/schema.phase24');
const { runPhase28Migrations } = require('../../src/db/schema.phase28');
const { runPhase29Migrations } = require('../../src/db/schema.phase29');
const { runPhase30Migrations } = require('../../src/db/schema.phase30');
const { runPhase31Migrations } = require('../../src/db/schema.phase31');
const { runPhase32Migrations } = require('../../src/db/schema.phase32');
const { runPhase33Migrations } = require('../../src/db/schema.phase33');
const { runPhase34Migrations } = require('../../src/db/schema.phase34');
const { runPhase35Migrations } = require('../../src/db/schema.phase35');
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
  await runMigrations();
  await runPhase2Migrations();
  await runPhase5Migrations();
  await runPhase6Migrations();
  await runPhase7BMigrations();
  await runPhase8Migrations();
  await runUniqueConstraintsMigration();
  await runPhase11Migrations();
  await runPhase12Migrations();
  await runPhase13Migrations();
  await runPhase14Migrations();
  await runPhase15Migrations();
  await runPhase16Migrations();
  await runPhase17Migrations();
  await runPhase18Migrations();
  await runPhase19Migrations();
  await runPhase20Migrations();
  await runPhase21Migrations();
  await runPhase22Migrations();
  await runPhase23Migrations();
  await runPhase24Migrations();
  await runPhase28Migrations();
  await runPhase29Migrations();
  await runPhase30Migrations();
  await runPhase31Migrations();
  await runPhase32Migrations();
  await runPhase33Migrations();
  await runPhase34Migrations();
  await runPhase35Migrations();
  await seedIntelligenceConfig();

  return {
    dbPath,
    db: database,
    cleanup() {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    },
  };
}

module.exports = { createTestDb };
