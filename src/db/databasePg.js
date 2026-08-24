/**
 * PostgreSQL driver — implements the exact same run/all/get/transaction/
 * getDb/persist/initializeDatabase interface as database.js's sql.js
 * implementation, so every existing caller (~50+ files, all requiring
 * './database' or '../db/database') works completely unchanged. Selected
 * by database.js itself when DATABASE_URL is set — see that file's header
 * comment. Never required directly by application code.
 *
 * Contains a small SQL-compatibility shim (translateSql()) so the existing
 * 25 schema*.js migration files and every existing query string keep
 * working verbatim against Postgres, rather than being forked/rewritten.
 * This shim exists because an exhaustive source audit (see
 * VERCEL_DATABASE_MIGRATION_PLAN.md, extended by the Wave 7 readiness audit
 * -- VERCEL_WAVE7_DBRAW_AUDIT.md §5 -- which found the two gaps below) found
 * every SQLite/Postgres difference in this codebase is a mechanical syntax
 * idiom, not a logic difference:
 *   - `?` positional placeholders -> `$1, $2, ...`
 *   - `<expr> IS [NOT] <integer literal>` -> `<expr> IS [NOT] DISTINCT FROM
 *     <integer literal>` (see the inline comment at the rule itself for the
 *     full explanation -- found live against Neon Development, Task 7,
 *     `GET /api/v1/decisions` 500ing with `syntax error at or near "1"`).
 *   - `datetime('now')` ->
 *     `to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.
 *     A bare `NOW()` (returning timestamptz) is wrong for the exact same
 *     reason documented just below for the modifier form: real call sites
 *     compare this against TEXT columns populated app-side via
 *     `new Date().toISOString()` (confirmed: src/api/routes/dashboard.js
 *     `snoozed_until < datetime('now')`, src/services/alertEngine.js same
 *     pattern), and Postgres has no implicit text<->timestamptz comparison
 *     operator. Discovered live against Neon Development (Vercel migration,
 *     Task 7): `/api/v1/dashboard` and `/api/v1/alerts` both 500'd with
 *     "operator does not exist: text < timestamp with time zone" until this
 *     bare form got the same to_char() treatment as the modifier form.
 *   - `datetime('now', <modifier>)` ->
 *     `to_char((NOW() + (<modifier>)::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.
 *     <modifier> is preserved completely unchanged (whether a quoted
 *     literal like '-30 days' or a `?` placeholder later renumbered to
 *     `$N`) -- Postgres's interval parser accepts the exact same
 *     "-N days"/"-N hours" text SQLite's datetime() modifier syntax uses.
 *     Confirmed against a real local Postgres instance that a naive
 *     `NOW() + interval` (left as timestamptz, or even cast to ::text) is
 *     wrong, not just untranslated: every real call site compares the
 *     result against a TEXT column populated app-side via
 *     `new Date().toISOString()` ('T'-separated, 'Z'-suffixed, UTC), and
 *     Postgres has no implicit text<->timestamptz comparison operator at
 *     all, while its own default timestamptz->text cast uses a
 *     space-separated, session-timezone-offset format that sorts
 *     incorrectly against toISOString()'s format under plain lexicographic
 *     TEXT comparison. to_char() with an explicit format string
 *     reproduces toISOString()'s exact byte format after normalizing to
 *     UTC. Confirmed by source audit: every real call site in this
 *     codebase uses this exact "-N days"/"-N hours" shape
 *     (src/api/routes/adRoutes.js, adsets.js, campaigns.js,
 *     healthHistory.js, src/services/autoSyncScheduler.js) -- no other
 *     datetime() modifier form exists anywhere in the codebase (re-verified
 *     by grep).
 *   - `date(<expr>)` -> `((<expr>::date)::text)`. SQLite's date() always
 *     returns a TEXT value in 'YYYY-MM-DD' form (SQLite has no distinct date
 *     type), and callers rely on that TEXT-comparison behavior directly --
 *     most tellingly src/services/billingService.js's
 *     `date(cancelled_at) >= ?` compared against a truncated 'YYYY-MM'
 *     (month-only) string, which only works as intended via SQLite's
 *     lexicographic TEXT comparison (a bare `<expr>::date` cast would
 *     instead produce a native Postgres `date` value, and comparing that
 *     against a 'YYYY-MM' string would throw
 *     "invalid input syntax for type date" -- a real semantic break, not
 *     just a syntax one). Casting back to ::text after ::date reproduces
 *     SQLite's exact TEXT-returning, 'YYYY-MM-DD'-formatted behavior, so
 *     every existing comparison (against a full date, a full ISO
 *     timestamp, a `?` parameter, or a truncated month-prefix) keeps
 *     working unchanged. `'now'::date` and `(<param>)::date` are both valid
 *     Postgres (`'now'` is one of Postgres's recognized special date/time
 *     input values), covering date('now') and date(?) alongside plain
 *     date(column).
 *   - `INSERT OR IGNORE INTO` -> `INSERT INTO ... ON CONFLICT DO NOTHING`
 *     (bare, no conflict target -- matches SQLite's "ignore ANY constraint
 *     violation" semantics exactly, not scoped to one specific constraint)
 *   - `PRAGMA foreign_keys` / `PRAGMA journal_mode` -> no-op (Postgres
 *     always enforces FKs; there is no journal-mode equivalent needed).
 *     `PRAGMA foreign_key_check` is deliberately NOT included in this
 *     no-op set -- see schema.phase8.js's header for why it's category C
 *     (structurally unnecessary under Postgres, not just untranslated) and
 *     is never called against this driver in the first place; if it ever
 *     is, it should fail loudly (a clear Postgres syntax error) rather than
 *     silently return a misleading result shape via the generic no-op path.
 *   - `PRAGMA table_info(table)` -> emulated via information_schema.columns,
 *     shaped to match SQLite's pragma output (existing migration files only
 *     ever read `.name` off each row -- confirmed by source audit)
 */

const { Pool } = require('pg');

let pool = null;

const PRAGMA_TABLE_INFO_RE = /^\s*PRAGMA\s+table_info\(\s*['"]?(\w+)['"]?\s*\)/i;
const PRAGMA_NOOP_RE = /^\s*PRAGMA\s+(foreign_keys|journal_mode)/i;

/**
 * Mechanical SQLite -> Postgres SQL text translation. Pure function, no DB
 * access -- unit-testable in isolation (see tests/unit/databasePg.test.js).
 */
function translateSql(sql) {
  if (PRAGMA_NOOP_RE.test(sql)) return 'SELECT 1';

  let out = sql;

  const hasOrIgnore = /INSERT\s+OR\s+IGNORE\s+INTO/i.test(out);
  if (hasOrIgnore) {
    out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    out = out.replace(/;\s*$/, '');
    out = `${out} ON CONFLICT DO NOTHING;`;
  }

  // `<expr> IS NOT <literal>` / `<expr> IS <literal>` -> IS [NOT] DISTINCT
  // FROM <literal>. SQLite's IS/IS NOT accept ANY right-hand operand with
  // NULL-safe semantics (`x IS NOT 1` is true whenever x is NULL or != 1),
  // but Postgres's IS/IS NOT grammar only accepts NULL/TRUE/FALSE/UNKNOWN --
  // any other literal is a syntax error at that exact token. Discovered
  // live against Neon Development (Vercel migration, Task 7): `GET
  // /api/v1/decisions` 500'd with `syntax error at or near "1"`, traced to
  // `action_taken IS NOT 1` (recommendation_log.action_taken is an INTEGER
  // 0/1 flag) -- confirmed by grep at 4 real call sites (decisionEngine.js,
  // opportunityEngine.js, topWinnersEngine.js, recommendations.js), all the
  // same shape. Postgres's IS DISTINCT FROM / IS NOT DISTINCT FROM have the
  // identical NULL-safe semantics SQLite's IS/IS NOT already provide, so
  // this preserves behavior exactly rather than merely avoiding the syntax
  // error. Restricted to a trailing integer literal (`\d+`) specifically so
  // `IS NOT NULL`/`IS NOT TRUE`/`IS NOT FALSE` (already valid Postgres,
  // used throughout this codebase) are never matched.
  out = out.replace(/\bIS\s+NOT\s+(\d+)\b/gi, 'IS DISTINCT FROM $1');
  out = out.replace(/\bIS\s+(\d+)\b/gi, 'IS NOT DISTINCT FROM $1');

  // REAL -> DOUBLE PRECISION. Same type NAME, different actual precision:
  // SQLite has exactly one floating-point storage class (internally always
  // an 8-byte IEEE 754 double, regardless of which of REAL/FLOAT/DOUBLE
  // column-type keyword was declared), but Postgres's `real` type is a true
  // 4-byte single-precision float (~7 significant decimal digits) distinct
  // from its own 8-byte `double precision` type. Translating REAL -> REAL
  // verbatim (the assumption every other rule in this file safely makes)
  // silently rounds any value with more precision than that on every write
  // -- confirmed against a real local Neon database: creative_analytics.cpm
  // stored as 47.547108 instead of the source's 47.547106, and
  // outbound_ctr's 0.08544087491455912 truncated to 0.085440874. Every
  // REAL-typed column in this schema (108 across all schema*.js files —
  // spend, ctr, cpm, roas, every score_* column, etc.) is a real business
  // metric where that precision loss is a genuine, silent data-quality bug,
  // not cosmetic. \bREAL\b is safe to replace unconditionally: confirmed by
  // source audit that "REAL" never appears as a substring of a longer
  // identifier or inside a quoted SQL string value anywhere in this codebase
  // (only as a bare column-type keyword, generated either directly in a
  // schema file's SQL text or via a `{ name, type: 'REAL' }` descriptor
  // object interpolated into one).
  out = out.replace(/\bREAL\b/g, 'DOUBLE PRECISION');

  // Two-argument form first (datetime('now', <modifier>)) -- must run
  // before the bare-form replacement below, since a bare `datetime('now')`
  // regex could not match here anyway (a comma precedes the closing paren),
  // but ordering this first keeps the two rules unambiguous to read.
  //
  // Confirmed against a real local Postgres instance that a naive
  // `NOW() + interval` (left as timestamptz) breaks every real caller here:
  // all 5 real call sites compare the result against a TEXT column
  // (health_score_history.calculated_at, sync_execution_log.started_at),
  // and Postgres has no implicit text<->timestamptz comparison operator at
  // all ("operator does not exist: text >= timestamp with time zone").
  // Casting the computed value to ::text (the same approach used for
  // date() below) is ALSO wrong here, not just untranslated: Postgres's
  // default timestamptz->text cast uses the session's local timezone and a
  // space-separated, offset-suffixed format (e.g.
  // '2026-08-20 09:37:29.083+03'), while every real value in these TEXT
  // columns is written app-side via new Date().toISOString() (confirmed:
  // smartSyncEngine.js, healthScoreEngine.js) -- 'T'-separated,
  // 'Z'-suffixed, UTC (e.g. '2026-08-20T09:37:29.083Z'). A same-date,
  // different-separator pair sorts incorrectly under lexicographic TEXT
  // comparison (' ' < 'T' in ASCII, so the separator character alone can
  // decide the comparison before the actual time-of-day digits are ever
  // compared) -- a silent correctness bug, not just a formatting nit.
  // to_char() with an explicit format string reproduces toISOString()'s
  // exact format after normalizing to UTC, so comparisons against real
  // app-written values are byte-for-byte apples-to-apples.
  out = out.replace(
    /datetime\(\s*'now'\s*,\s*([^)]+?)\s*\)/gi,
    `to_char((NOW() + ($1)::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
  );
  out = out.replace(
    /datetime\(\s*'now'\s*\)/gi,
    `to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
  );

  // date(<expr>) -> TEXT 'YYYY-MM-DD', matching SQLite's actual return type
  // (see this file's header for why a bare ::date cast would silently
  // change comparison semantics for at least one real caller) -- EXCEPT
  // inside a CREATE INDEX expression, where Postgres requires every function
  // used to be marked IMMUTABLE. Confirmed against a real local Postgres
  // instance (schema.phase2.js's idx_recommendation_log_dedup) that BOTH
  // `(<expr>::date)::text` AND a bare `<expr>::date` are rejected there with
  // "functions in index expression must be marked IMMUTABLE" -- every
  // date/timestamp column in this schema is declared TEXT (not a native
  // Postgres date/timestamp type), so even the first `::date` cast step is a
  // text-parse, which Postgres's built-in cast classifies as STABLE (session
  // DateStyle-dependent), never IMMUTABLE, regardless of what follows it.
  // The genuinely immutable fix: every real caller stores ISO-8601 text
  // (`new Date().toISOString()` app-side, or NOW()'s default text
  // representation under Postgres) where the first 10 characters are always
  // 'YYYY-MM-DD' by construction -- substring() on TEXT is a pure,
  // locale-independent string operation, IMMUTABLE, and produces the exact
  // same grouping key date() would have, with no date-type cast at all.
  const isIndexExpression = /^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(out);
  out = out.replace(/\bdate\(\s*([^)]+?)\s*\)/gi, isIndexExpression ? 'substring($1 from 1 for 10)' : '(($1::date)::text)');

  // Positional `?` -> `$1, $2, ...`, sequential, in appearance order --
  // matches how params arrays are already passed by every existing caller.
  // Runs last so any `?` captured inside a datetime()/date() modifier above
  // is still renumbered correctly, in the same left-to-right order it
  // already appeared in before translation.
  let n = 0;
  out = out.replace(/\?/g, () => `$${++n}`);

  return out;
}

async function pragmaTableInfo(queryFn, tableName) {
  const res = await queryFn(
    `SELECT column_name AS name, data_type AS type,
            CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
            column_default AS dflt_value
     FROM information_schema.columns
     WHERE table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  return res.rows;
}

async function initializeDatabase(connectionString) {
  pool = new Pool({
    connectionString,
    // Neon issues certificates from a publicly-trusted CA (not
    // self-signed), so full certificate verification (Node's default,
    // rejectUnauthorized: true) works without any extra CA bundle --
    // deliberately NOT weakened to rejectUnauthorized:false, which would
    // silently accept a MITM'd connection carrying real Meta tokens/
    // decrypted intelligence data. Only disabled for a local Postgres
    // (no TLS in that case at all), matching how every other local-dev
    // Postgres setup is normally run.
    ssl: connectionString && connectionString.includes('localhost') ? false : true,
  });
  await pool.query('SELECT 1'); // fail fast on a bad connection string at boot, same fail-fast spirit as the sql.js path
}

async function run(sql, params) {
  if (!pool) throw new Error('Database not initialized');
  const m = PRAGMA_TABLE_INFO_RE.exec(sql);
  if (m) { await pragmaTableInfo((s, p) => pool.query(s, p), m[1]); return; }
  const translated = translateSql(sql);
  if (translated.trim().toUpperCase() === 'SELECT 1' && PRAGMA_NOOP_RE.test(sql)) return;
  await pool.query(translated, params);
}

async function all(sql, params) {
  if (!pool) throw new Error('Database not initialized');
  const m = PRAGMA_TABLE_INFO_RE.exec(sql);
  if (m) return pragmaTableInfo((s, p) => pool.query(s, p), m[1]);
  const translated = translateSql(sql);
  const res = await pool.query(translated, params);
  return res.rows;
}

async function get(sql, params) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

/**
 * Matches database.js's transaction(fn) contract exactly: fn receives
 * { run, all, get } bound to ONE connection for the life of the
 * transaction, commits once at the end, rolls back on any thrown error.
 */
async function transaction(fn) {
  if (!pool) throw new Error('Database not initialized');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRun = async (sql, params) => {
      const m = PRAGMA_TABLE_INFO_RE.exec(sql);
      if (m) { await pragmaTableInfo((s, p) => client.query(s, p), m[1]); return; }
      const translated = translateSql(sql);
      if (translated.trim().toUpperCase() === 'SELECT 1' && PRAGMA_NOOP_RE.test(sql)) return;
      await client.query(translated, params);
    };
    const txAll = async (sql, params) => {
      const m = PRAGMA_TABLE_INFO_RE.exec(sql);
      if (m) return pragmaTableInfo((s, p) => client.query(s, p), m[1]);
      const translated = translateSql(sql);
      const res = await client.query(translated, params);
      return res.rows;
    };
    const txGet = async (sql, params) => {
      const rows = await txAll(sql, params);
      return rows[0] || null;
    };

    await fn({ run: txRun, all: txAll, get: txGet });
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may already be dead */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Used in exactly one place in the existing codebase (schema.phase6.js's
 * one-time table-rename migration, which manually sequences BEGIN/CREATE/
 * COPY/DROP/RENAME/COMMIT itself to get a single persist() under sql.js).
 * Under Postgres, each statement here runs and commits independently via
 * the pool (no persist() concept exists -- Postgres commits durably per
 * statement/transaction on its own) -- this loses strict all-or-nothing
 * atomicity for that ONE legacy bootstrap migration specifically, which is
 * acceptable because it only ever runs once, against a freshly-created
 * (not-yet-live) schema, before any real data import -- see
 * VERCEL_DATABASE_MIGRATION_PLAN.md §"getDb() compatibility note".
 */
function getDb() {
  if (!pool) throw new Error('Database not initialized');
  return {
    run: (sql) => {
      const translated = translateSql(sql);
      if (translated.trim().toUpperCase() === 'SELECT 1' && PRAGMA_NOOP_RE.test(sql)) return;
      return pool.query(translated);
    },
  };
}

// No-op: Postgres commits durably per statement/transaction on its own;
// there is no whole-database export/rewrite step to perform. Kept as a
// same-shape export so no caller needs an `if (isPg)` branch.
function persist() {}

module.exports = {
  initializeDatabase,
  run,
  all,
  get,
  getDb,
  transaction,
  persist,
  translateSql, // exported for unit testing only
};
