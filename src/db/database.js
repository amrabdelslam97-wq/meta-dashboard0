/**
 * Database Layer — sql.js (pure JS SQLite) implementation, plus the driver
 * selector that decides whether this module's exports actually point here
 * or at databasePg.js (PostgreSQL/Neon).
 *
 * Driver selection (bottom of this file): if `DATABASE_URL` is set at
 * require-time, every export of this module delegates to databasePg.js
 * instead of the sql.js implementation below. This is evaluated exactly
 * once, when this module is first required (Node's module cache makes the
 * choice effectively for the life of the process) -- it is never
 * re-evaluated per call, and it never silently falls back to sql.js if the
 * Postgres driver was selected but its `initializeDatabase()` call later
 * fails (that failure propagates to the caller unchanged, same as a
 * misconfigured sql.js path already fails loudly today rather than silently
 * degrading -- see VERCEL_MIGRATION_ARCHITECTURE_DECISION.md §7 for why this
 * selector shape -- "wrapped behind a driver selector", sql.js logic "not
 * deleted or rewritten in place" -- was the specified design).
 *
 * The sql.js implementation below is completely unchanged from before this
 * selector existed; Railway/local behavior (no DATABASE_URL) is unaffected.
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
let dbPath = null;

/**
 * Initialize the database.
 * Creates the file if it doesn't exist, loads it if it does.
 */
async function initializeDatabase(filePath) {
  dbPath = path.resolve(filePath);

  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    console.log(`[DB] Loaded existing database from ${dbPath}`);
  } else {
    db = new SQL.Database();
    console.log(`[DB] Created new database at ${dbPath}`);
  }

  // Enable WAL-equivalent: foreign keys
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA journal_mode = MEMORY;');

  return db;
}

/**
 * Persist the in-memory database to disk.
 * Call after any write operation.
 */
function persist() {
  if (!db || !dbPath) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

/**
 * Execute a write statement (INSERT, UPDATE, DELETE, CREATE).
 * Automatically persists to disk after execution.
 */
function run(sql, params = undefined) {
  if (!db) throw new Error('Database not initialized');
  db.run(sql, params);
  persist();
}

/**
 * Execute a read query returning all matching rows.
 */
function all(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Execute a read query returning the first matching row.
 */
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

/**
 * Get the underlying database instance (for transactions).
 */
function getDb() {
  return db;
}

/**
 * Execute multiple statements in a transaction.
 * fn receives { run, all, get } scoped to the same db.
 *
 * `await fn(...)` (rather than a bare call) is the one deliberate change
 * this function has for the Postgres/async migration: it makes the
 * transaction correctly wait for an async callback's internal awaited work
 * (e.g. a caller that awaits an now-async helper per row) before COMMIT
 * runs, closing a real "transaction commits before its own writes finish"
 * risk an un-awaited async callback would otherwise create. This is
 * backward compatible with every existing synchronous callback in this
 * codebase: awaiting a plain (non-Promise) return value resolves
 * immediately, so every current `db.transaction(tx => { ...sync work... })`
 * call site keeps running fully synchronously inside this call, unchanged.
 */
async function transaction(fn) {
  if (!db) throw new Error('Database not initialized');
  db.run('BEGIN TRANSACTION;');
  try {
    await fn({ run: (sql, params) => db.run(sql, params), all, get });
    db.run('COMMIT;');
    persist();
  } catch (err) {
    db.run('ROLLBACK;');
    throw err;
  }
}

const sqliteDriver = {
  initializeDatabase,
  run,
  all,
  get,
  getDb,
  transaction,
  persist,
};

/**
 * Chooses the sql.js implementation above (default -- Railway/local, no
 * env var needed) or databasePg.js (PostgreSQL/Neon, only when DATABASE_URL
 * is explicitly set). Every existing caller of initializeDatabase() (app.js,
 * tests/helpers/testDb.js, scripts/seed.js, scripts/verify.js) always passes
 * a SQLite file path (DB_PATH) -- that contract is preserved unchanged for
 * the sql.js path. Under the Postgres path, the passed file-path argument is
 * intentionally ignored in favor of DATABASE_URL itself (the single source
 * of truth for the Postgres connection string, per
 * VERCEL_ENVIRONMENT_VARIABLES.md), so no caller needs to know which driver
 * is active -- the same `await initializeDatabase(DB_PATH)` call site works
 * unchanged either way.
 */
function selectDriver() {
  if (!process.env.DATABASE_URL) return sqliteDriver;

  const pg = require('./databasePg');
  return {
    ...pg,
    initializeDatabase: () => pg.initializeDatabase(process.env.DATABASE_URL),
  };
}

module.exports = selectDriver();
