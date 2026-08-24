'use strict';

/**
 * Unit tests for src/db/database.js's driver selector (Wave 7 Blocker 1):
 * DATABASE_URL absent -> sql.js path (existing Railway/local behavior,
 * unchanged); DATABASE_URL present -> databasePg.js path; a Postgres
 * initialization failure must propagate, never silently fall back to sql.js.
 *
 * Uses jest.resetModules() + jest.doMock() (same pattern as
 * tests/unit/statelessAuth.test.js) since the selector's choice is made once
 * at require-time based on process.env.DATABASE_URL.
 */

describe('database.js driver selector', () => {
  const OLD_DATABASE_URL = process.env.DATABASE_URL;

  beforeEach(() => {
    jest.resetModules();
  });

  afterAll(() => {
    if (OLD_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = OLD_DATABASE_URL;
  });

  test('no DATABASE_URL: exports the real sql.js implementation and never requires databasePg.js', () => {
    delete process.env.DATABASE_URL;
    const db = require('../../src/db/database');

    expect(typeof db.initializeDatabase).toBe('function');
    expect(typeof db.getDb).toBe('function');
    expect(typeof db.run).toBe('function');

    // databasePg.js is only ever required lazily, inside the DATABASE_URL
    // branch of selectDriver() -- with no DATABASE_URL set, it must never
    // enter the module cache at all (proves no eager/always-on Postgres
    // dependency was introduced).
    const pgPath = require.resolve('../../src/db/databasePg');
    expect(require.cache[pgPath]).toBeUndefined();
  });

  test('DATABASE_URL present: selects the PostgreSQL driver by delegation, not reimplementation', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
    const db = require('../../src/db/database');
    const pg = require('../../src/db/databasePg');

    // Identity checks (toBe, not toEqual): proves database.js delegates to
    // the exact same functions databasePg.js exports -- not a copy, not a
    // second competing implementation.
    expect(db.run).toBe(pg.run);
    expect(db.all).toBe(pg.all);
    expect(db.get).toBe(pg.get);
    expect(db.transaction).toBe(pg.transaction);
    expect(db.getDb).toBe(pg.getDb);
    expect(db.persist).toBe(pg.persist);
  });

  test('DATABASE_URL present: initializeDatabase() always connects using DATABASE_URL itself, ignoring any caller-supplied file path', async () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
    jest.doMock('../../src/db/databasePg', () => ({
      initializeDatabase: jest.fn().mockResolvedValue(undefined),
      run: jest.fn(), all: jest.fn(), get: jest.fn(), getDb: jest.fn(),
      transaction: jest.fn(), persist: jest.fn(), translateSql: jest.fn(),
    }));
    const db = require('../../src/db/database');
    const pgMock = require('../../src/db/databasePg');

    // Every existing caller (app.js, tests/helpers/testDb.js, scripts/seed.js,
    // scripts/verify.js) passes a SQLite file path here -- that must keep
    // working unchanged, with the Postgres driver ignoring it in favor of
    // DATABASE_URL.
    await db.initializeDatabase('./data/some/local/sqlite-looking/path.db');

    expect(pgMock.initializeDatabase).toHaveBeenCalledWith('postgres://user:pass@localhost:5432/testdb');
    expect(pgMock.initializeDatabase).not.toHaveBeenCalledWith('./data/some/local/sqlite-looking/path.db');
  });

  test('PostgreSQL initialization failure propagates to the caller -- no silent fallback to sql.js', async () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
    jest.doMock('../../src/db/databasePg', () => ({
      initializeDatabase: jest.fn().mockRejectedValue(new Error('connection refused')),
      run: jest.fn(), all: jest.fn(), get: jest.fn(), getDb: jest.fn(),
      transaction: jest.fn(), persist: jest.fn(), translateSql: jest.fn(),
    }));
    const db = require('../../src/db/database');
    const pgMock = require('../../src/db/databasePg');

    await expect(db.initializeDatabase('./data/meta_ads.db')).rejects.toThrow('connection refused');

    // Confirm the failure was not swallowed and silently retried against
    // sql.js: db.run must still be the (mocked) Postgres run, proving no
    // fallback swap to the sql.js implementation occurred after the failure.
    expect(db.run).toBe(pgMock.run);
  });
});
