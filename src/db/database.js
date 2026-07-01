/**
 * Database Layer
 * Uses sql.js (pure JS SQLite) with file persistence.
 * Swap-ready for postgres: replace this module's query interface only.
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
function run(sql, params = []) {
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
 */
function transaction(fn) {
  if (!db) throw new Error('Database not initialized');
  db.run('BEGIN TRANSACTION;');
  try {
    fn({ run: (sql, params) => db.run(sql, params), all, get });
    db.run('COMMIT;');
    persist();
  } catch (err) {
    db.run('ROLLBACK;');
    throw err;
  }
}

module.exports = {
  initializeDatabase,
  run,
  all,
  get,
  getDb,
  transaction,
  persist,
};
