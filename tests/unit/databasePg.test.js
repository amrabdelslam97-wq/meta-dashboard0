'use strict';

/**
 * Unit tests for databasePg.js's SQL-compatibility shim (translateSql()).
 * Pure-function tests, no live Postgres connection required -- exercised
 * against real query text patterns pulled from the existing 25 schema*.js
 * files and services/routes call sites (see VERCEL_DATABASE_MIGRATION_PLAN.md
 * for the source audit these patterns are drawn from). Live-connection
 * behavior (run/all/get/transaction/getDb against a real Postgres instance)
 * cannot be unit-tested until Neon is provisioned -- see that same document
 * for the integration-test plan to run once it is.
 */

const { translateSql } = require('../../src/db/databasePg');

describe('databasePg.translateSql', () => {
  test('converts sequential ? placeholders to $1, $2, ...', () => {
    expect(translateSql('SELECT * FROM ad_accounts WHERE id = ?'))
      .toBe('SELECT * FROM ad_accounts WHERE id = $1');
    expect(translateSql('UPDATE ad_accounts SET name = ?, status = ? WHERE id = ?'))
      .toBe('UPDATE ad_accounts SET name = $1, status = $2 WHERE id = $3');
  });

  test('converts INSERT OR IGNORE INTO to INSERT INTO ... ON CONFLICT DO NOTHING', () => {
    const out = translateSql('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)');
    expect(out).toBe('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING;');
  });

  test('converts INSERT OR IGNORE with a trailing semicolon without duplicating it', () => {
    const out = translateSql('INSERT OR IGNORE INTO foo (a) VALUES (?);');
    expect(out).toBe('INSERT INTO foo (a) VALUES ($1) ON CONFLICT DO NOTHING;');
    expect((out.match(/;/g) || []).length).toBe(1);
  });

  test("converts datetime('now') in a DDL column default to a UTC-normalized TEXT-returning expression", () => {
    expect(translateSql("applied_at TEXT NOT NULL DEFAULT (datetime('now'))"))
      .toBe(`applied_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`);
  });

  test("converts datetime('now') in a query predicate to a UTC-normalized TEXT-returning expression -- Neon Development live bug (dashboard/alerts 500s)", () => {
    expect(translateSql("WHERE snoozed_until IS NULL OR snoozed_until < datetime('now')"))
      .toBe(`WHERE snoozed_until IS NULL OR snoozed_until < to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  });

  test("does not let the bare datetime('now') pattern swallow the two-argument modifier form", () => {
    const out = translateSql("datetime('now', '-30 days')");
    expect(out).toBe(`to_char((NOW() + ('-30 days')::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  });

  test('neutralizes PRAGMA foreign_keys / journal_mode to a harmless no-op', () => {
    expect(translateSql('PRAGMA foreign_keys = ON;')).toBe('SELECT 1');
    expect(translateSql('PRAGMA journal_mode = MEMORY;')).toBe('SELECT 1');
  });

  test('leaves an already-Postgres-style ON CONFLICT...DO UPDATE clause\'s structure intact, only translating placeholders', () => {
    const input = 'INSERT INTO x (a,b) VALUES (?,?) ON CONFLICT(a) DO UPDATE SET b = excluded.b';
    const out = translateSql(input);
    expect(out).toBe('INSERT INTO x (a,b) VALUES ($1,$2) ON CONFLICT(a) DO UPDATE SET b = excluded.b');
  });

  test('leaves ordinary CREATE TABLE / CREATE INDEX IF NOT EXISTS syntax unchanged (already Postgres-compatible)', () => {
    const ddl = 'CREATE TABLE IF NOT EXISTS foo (id TEXT PRIMARY KEY, name TEXT)';
    expect(translateSql(ddl)).toBe(ddl);
    const idx = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_foo ON foo(name)';
    expect(translateSql(idx)).toBe(idx);
  });

  test('does not alter a plain SELECT with no placeholders or SQLite idioms', () => {
    const sql = 'SELECT COUNT(*) as n FROM campaigns WHERE status = $status_never_used';
    expect(translateSql(sql)).toBe(sql);
  });

  describe('IS [NOT] <integer literal> -> IS [NOT] DISTINCT FROM -- Neon Development migration', () => {
    // Postgres's IS/IS NOT grammar only accepts NULL/TRUE/FALSE/UNKNOWN;
    // SQLite's IS/IS NOT accept any RHS with NULL-safe semantics. Live bug
    // against Neon Development: GET /api/v1/decisions 500'd with
    // "syntax error at or near \"1\"" from `action_taken IS NOT 1`
    // (recommendation_log.action_taken, an INTEGER 0/1 flag).
    test('converts "IS NOT <int>" to "IS DISTINCT FROM <int>"', () => {
      const out = translateSql("WHERE dismissed_at IS NULL AND action_taken IS NOT 1");
      expect(out).toBe('WHERE dismissed_at IS NULL AND action_taken IS DISTINCT FROM 1');
    });

    test('converts "IS <int>" to "IS NOT DISTINCT FROM <int>"', () => {
      expect(translateSql('WHERE action_taken IS 1')).toBe('WHERE action_taken IS NOT DISTINCT FROM 1');
    });

    test('leaves "IS NOT NULL" / "IS NULL" / "IS NOT TRUE" untouched (already valid Postgres)', () => {
      expect(translateSql('WHERE dismissed_at IS NOT NULL')).toBe('WHERE dismissed_at IS NOT NULL');
      expect(translateSql('WHERE dismissed_at IS NULL')).toBe('WHERE dismissed_at IS NULL');
      expect(translateSql('WHERE active IS NOT TRUE')).toBe('WHERE active IS NOT TRUE');
    });
  });

  describe('REAL -> DOUBLE PRECISION -- Neon Development migration', () => {
    // SQLite's REAL is always 8-byte double precision internally; Postgres's
    // `real` type is a true 4-byte single-precision float. Translating
    // REAL -> REAL verbatim silently rounds values to ~7 significant digits
    // on write -- confirmed against a real local Neon database
    // (creative_analytics.cpm/outbound_ctr lost precision on import).
    test('converts a REAL column type in CREATE TABLE', () => {
      const out = translateSql('CREATE TABLE IF NOT EXISTS ad_sets (id TEXT PRIMARY KEY, daily_budget REAL, lifetime_budget REAL)');
      expect(out).toBe('CREATE TABLE IF NOT EXISTS ad_sets (id TEXT PRIMARY KEY, daily_budget DOUBLE PRECISION, lifetime_budget DOUBLE PRECISION)');
    });

    test('converts a REAL column type in ALTER TABLE ADD COLUMN', () => {
      const out = translateSql('ALTER TABLE creative_analytics ADD COLUMN cpm REAL');
      expect(out).toBe('ALTER TABLE creative_analytics ADD COLUMN cpm DOUBLE PRECISION');
    });

    test('does not alter unrelated SQL with no REAL keyword', () => {
      const sql = 'SELECT id, name FROM campaigns WHERE status = ?';
      expect(translateSql(sql)).toBe('SELECT id, name FROM campaigns WHERE status = $1');
    });

    test('does not match "real" as a substring of a longer word (case-sensitive, word-boundary)', () => {
      const sql = "-- the real average calculation\nCREATE TABLE x (id TEXT)";
      expect(translateSql(sql)).toBe(sql);
    });
  });

  describe('datetime(\'now\', <modifier>) -- Wave 7 Blocker 3', () => {
    // Format matches new Date().toISOString() exactly (confirmed real app
    // callers -- smartSyncEngine.js, healthScoreEngine.js -- write TEXT
    // columns this way), verified correct against a real local Postgres
    // instance where a naive timestamptz-or-::text approach both failed
    // (type error, then a silent wrong-comparison risk from a format
    // mismatch -- see databasePg.js's header for the full explanation).
    const TO_CHAR = `to_char((NOW() + (MODIFIER)::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

    test('converts a literal "-N days" modifier to UTC-normalized, toISOString()-formatted interval arithmetic', () => {
      const out = translateSql("AND calculated_at >= datetime('now', '-30 days')");
      expect(out).toBe(`AND calculated_at >= ${TO_CHAR.replace('MODIFIER', "'-30 days'")}`);
    });

    test('converts a literal "-N hours" modifier the same way', () => {
      const out = translateSql("WHERE started_at >= datetime('now', '-24 hours')");
      expect(out).toBe(`WHERE started_at >= ${TO_CHAR.replace('MODIFIER', "'-24 hours'")}`);
    });

    test('preserves a ? placeholder modifier (translated to $N by the later placeholder pass), matching adRoutes.js/adsets.js', () => {
      const out = translateSql("WHERE entity_meta_id = ? AND calculated_at >= datetime('now', ?)");
      expect(out).toBe(`WHERE entity_meta_id = $1 AND calculated_at >= ${TO_CHAR.replace('MODIFIER', '$2')}`);
    });

    test('leaves the bare datetime(\'now\') (no modifier) form handled by its own rule, unaffected by the modifier-form rule', () => {
      expect(translateSql("WHERE snoozed_until < datetime('now')"))
        .toBe(`WHERE snoozed_until < to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
    });
  });

  describe('date(<expr>) -- Wave 7 Blocker 3', () => {
    test('converts date(column) to a TEXT-returning ::date cast, not a bare date cast', () => {
      const out = translateSql('WHERE date(created_at) = ?');
      // Deliberately NOT `created_at::date` -- see databasePg.js header for
      // why the TEXT round-trip is required to preserve SQLite's actual
      // return type and downstream comparison semantics.
      expect(out).toBe('WHERE ((created_at::date)::text) = $1');
    });

    test('converts date(\'now\') -- Postgres recognizes \'now\' as a special date/time input value', () => {
      const out = translateSql("AND date(created_at) = date('now') AND status = 'pending'");
      expect(out).toBe("AND ((created_at::date)::text) = (('now'::date)::text) AND status = 'pending'");
    });

    test('converts date(?) alongside another date(<column>) in the same predicate, matching recommendationEngine.js', () => {
      const out = translateSql('WHERE rule_code = ? AND date(generated_at) = date(?)');
      expect(out).toBe('WHERE rule_code = $1 AND ((generated_at::date)::text) = (($2::date)::text)');
    });

    test('preserves month-prefix TEXT comparison semantics (billingService.js): a truncated "YYYY-MM" string still compares correctly against the TEXT-cast result', () => {
      const out = translateSql("WHERE status = 'cancelled' AND date(cancelled_at) >= ?");
      expect(out).toBe("WHERE status = 'cancelled' AND ((cancelled_at::date)::text) >= $1");
    });

    test('converts a date(<expr>) used as a CREATE INDEX expression key to an IMMUTABLE text substring, not a date cast, matching schema.phase2.js', () => {
      // Postgres requires every function in an index expression to be marked
      // IMMUTABLE. Confirmed against a real local Postgres instance that
      // BOTH `(<expr>::date)::text` and a bare `<expr>::date` are rejected
      // here with "functions in index expression must be marked IMMUTABLE"
      // -- every date/timestamp column in this schema is TEXT, not a native
      // Postgres date/timestamp type, so even a bare ::date cast is a
      // text-parse (STABLE, not IMMUTABLE). substring() on TEXT is a pure,
      // locale-independent string operation and IS immutable -- every real
      // caller stores ISO-8601 text where the first 10 characters are always
      // 'YYYY-MM-DD' by construction.
      const out = translateSql('CREATE UNIQUE INDEX IF NOT EXISTS idx_x ON recommendation_log(rule_code, entity_meta_id, date(generated_at))');
      expect(out).toBe('CREATE UNIQUE INDEX IF NOT EXISTS idx_x ON recommendation_log(rule_code, entity_meta_id, substring(generated_at from 1 for 10))');
    });

    test('still uses the TEXT round-trip for date(<expr>) outside a CREATE INDEX statement, even in a CREATE TABLE default', () => {
      const out = translateSql("SELECT date(created_at) FROM campaigns");
      expect(out).toBe('SELECT ((created_at::date)::text) FROM campaigns');
    });

    test('does not match "date" embedded inside a longer identifier (e.g. updated_at) as a function call', () => {
      const sql = 'SELECT updated_at FROM campaigns WHERE status = ?';
      expect(translateSql(sql)).toBe('SELECT updated_at FROM campaigns WHERE status = $1');
    });
  });
});
