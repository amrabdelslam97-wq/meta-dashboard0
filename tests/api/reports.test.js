'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/reports', () => {
  let testDb;
  let app;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_report_test', 'Report Test Account', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [accountId]
    );

    // A health score row whose entity_label starts with "=" -- if opened
    // in Excel/Sheets unescaped, this would execute as a formula
    // (CSV/formula injection). generateCSV must neutralize it.
    testDb.db.run(
      `INSERT INTO health_score_history
         (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
          health_score, health_status, score_reference, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_injection', '=cmd|"/c calc"!A1', 'sales', 75, 'good', 'platform_default', datetime('now'))`,
      [uuidv4(), accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('GET /reports/summary with a valid period returns 200', async () => {
    const res = await request(app).get('/api/v1/reports/summary?period=weekly');
    expect(res.status).toBe(200);
    expect(res.body.health).toBeDefined();
  });

  test('GET /reports/summary rejects an invalid period (not one of daily/weekly/monthly)', async () => {
    const res = await request(app).get('/api/v1/reports/summary?period=yearly');
    expect(res.status).toBe(400);
  });

  // Regression test for the path-traversal gap: `period` used to only be
  // validated inside the preset branch, but flows into the export
  // filename/header regardless of whether since/until override it.
  test('GET /reports/export rejects a path-traversal-style period even when since/until are valid', async () => {
    const res = await request(app)
      .get('/api/v1/reports/export')
      .query({ period: '../../etc/passwd', since: '2026-01-01', until: '2026-01-07', format: 'csv' });
    expect(res.status).toBe(400);
  });

  test('GET /reports/export rejects a malformed since/until date', async () => {
    const res = await request(app)
      .get('/api/v1/reports/export')
      .query({ period: 'weekly', since: '01/01/2026', until: '2026-01-07', format: 'csv' });
    expect(res.status).toBe(400);
  });

  test('GET /reports/export rejects an unsupported format', async () => {
    const res = await request(app)
      .get('/api/v1/reports/export')
      .query({ format: 'exe', period: 'weekly' });
    expect(res.status).toBe(400);
  });

  test('GET /reports/export?format=csv neutralizes a formula-injection payload in campaign names', async () => {
    // period=daily so the seeded health_score_history row (calculated_at
    // = right now) falls inside the resolved range -- weekly's range ends
    // at yesterday, which would exclude a row timestamped "now".
    const res = await request(app)
      .get('/api/v1/reports/export')
      .query({ format: 'csv', period: 'daily' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    // The raw formula-triggering cell must never start a CSV field with a
    // bare "=" -- generateCSV must prefix it with a leading apostrophe so
    // spreadsheet software treats it as inert text, not an executable
    // formula. The cell is also double-quoted per standard CSV escaping
    // (it contains a comma-adjacent quote character), so check for the
    // apostrophe immediately after the opening quote rather than an
    // exact raw string match.
    expect(res.text).toMatch(/"'=cmd/);
    expect(res.text).not.toMatch(/[^'"]=cmd\|/); // never appears as a bare unescaped formula
  });

  test('GET /reports/export?format=csv sets a safe, non-traversable filename header', async () => {
    const res = await request(app)
      .get('/api/v1/reports/export')
      .query({ format: 'csv', period: 'daily' });
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="meta-ads-report-daily-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/);
  });

  test('GET /reports/export?format=xlsx streams a valid xlsx file', async () => {
    const res = await request(app)
      .get('/api/v1/reports/export')
      .query({ format: 'xlsx', period: 'weekly' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(/\.xlsx"$/);
  });
});
