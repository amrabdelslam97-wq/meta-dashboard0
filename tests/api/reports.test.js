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

    // A sales campaign whose score_breakdown includes 'roas' (sales'
    // primary KPI, and part of its scoringWeights) -- primary_kpi should
    // resolve to a real value, not "Not available".
    testDb.db.run(
      `INSERT INTO health_score_history
         (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
          health_score, health_status, score_reference, score_breakdown, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_sales_kpi', 'Sales KPI Campaign', 'sales', 80, 'excellent', 'platform_default', ?, datetime('now'))`,
      [uuidv4(), accountId, JSON.stringify({ roas: { value: 3.2, normalized: 90, weight: 0.35 } })]
    );

    // An engagement campaign -- primary KPI is 'results', which is NOT one
    // of engagement's scoringWeights (cpr/ctr/frequency/reach), so it is
    // never captured in score_breakdown. primary_kpi.display must say so
    // honestly rather than showing a fabricated 0.
    testDb.db.run(
      `INSERT INTO health_score_history
         (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
          health_score, health_status, score_reference, score_breakdown, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_engagement_kpi', 'Engagement KPI Campaign', 'engagement', 70, 'good', 'platform_default', ?, datetime('now'))`,
      [uuidv4(), accountId, JSON.stringify({ cpr: { value: 8, normalized: 70, weight: 0.4 } })]
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

  // Regression coverage for the KPI Profile Resolver-driven primary_kpi
  // enrichment (Commit 9): each campaign row must carry its objective's
  // real primary KPI, correctly distinguishing "resolved from the stored
  // score_breakdown" from "genuinely wasn't captured in that snapshot".
  describe('primary_kpi enrichment (T9-01)', () => {
    test('GET /reports/summary resolves a real value for a sales campaign (roas is in its score_breakdown)', async () => {
      const res = await request(app).get('/api/v1/reports/summary').query({ period: 'daily' });
      expect(res.status).toBe(200);
      const row = res.body.top_campaigns.find(c => c.entity_meta_id === 'camp_sales_kpi');
      expect(row).toBeDefined();
      expect(row.primary_kpi).toEqual({ label: 'ROAS', value: 3.2, display: 3.2 });
    });

    test('GET /reports/summary honestly reports "No data for period" for an engagement campaign whose primary KPI (results) was never scored', async () => {
      const res = await request(app).get('/api/v1/reports/summary').query({ period: 'daily' });
      const row = res.body.top_campaigns.find(c => c.entity_meta_id === 'camp_engagement_kpi');
      expect(row).toBeDefined();
      expect(row.primary_kpi).toEqual({ label: 'Conversations', value: null, display: 'No data for period' });
    });

    test('GET /reports/export?format=csv includes the Primary KPI columns', async () => {
      const res = await request(app)
        .get('/api/v1/reports/export')
        .query({ format: 'csv', period: 'daily' });
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/Primary KPI,Primary KPI Value/);
      expect(res.text).toMatch(/ROAS,3\.2/);
    });
  });

  describe('objective filter (T9-02)', () => {
    test('GET /reports/summary?objective=sales scopes top_campaigns to only sales campaigns', async () => {
      const res = await request(app).get('/api/v1/reports/summary').query({ period: 'daily', objective: 'sales' });
      expect(res.status).toBe(200);
      expect(res.body.objective).toBe('sales');
      expect(res.body.top_campaigns.every(c => c.objective === 'sales')).toBe(true);
      expect(res.body.top_campaigns.some(c => c.entity_meta_id === 'camp_sales_kpi')).toBe(true);
      expect(res.body.top_campaigns.some(c => c.entity_meta_id === 'camp_engagement_kpi')).toBe(false);
    });

    test('GET /reports/summary rejects an invalid objective', async () => {
      const res = await request(app).get('/api/v1/reports/summary').query({ period: 'daily', objective: 'not_a_real_objective' });
      expect(res.status).toBe(400);
    });

    test('GET /reports/export rejects an invalid objective', async () => {
      const res = await request(app)
        .get('/api/v1/reports/export')
        .query({ format: 'csv', period: 'daily', objective: 'not_a_real_objective' });
      expect(res.status).toBe(400);
    });

    test('GET /reports/summary with no objective returns campaigns across all objectives', async () => {
      const res = await request(app).get('/api/v1/reports/summary').query({ period: 'daily' });
      expect(res.body.objective).toBeNull();
      const objectives = new Set(res.body.top_campaigns.map(c => c.objective));
      expect(objectives.size).toBeGreaterThan(1);
    });
  });

  // Multi-account scoping (Multi Meta Ad Account Management milestone):
  // getDefaultAccount() in this route previously always picked "the first
  // active account", completely ignoring any account_id the dashboard had
  // selected -- switching accounts in the UI never changed the report.
  describe('account_id scoping (reports previously ignored the selected account)', () => {
    let secondAccountId;

    beforeAll(() => {
      secondAccountId = uuidv4();
      testDb.db.run(
        `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
         VALUES (?, 'act_report_second', 'Second Report Account', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
        [secondAccountId]
      );
      testDb.db.run(
        `INSERT INTO health_score_history
           (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
            health_score, health_status, score_reference, calculated_at)
         VALUES (?, ?, 'campaign', 'camp_second_account', 'Second Account Campaign', 'traffic', 65, 'good', 'platform_default', datetime('now'))`,
        [uuidv4(), secondAccountId]
      );
    });

    test('GET /reports/summary?account_id=<second account> reports on that account, not the first active one', async () => {
      const res = await request(app).get('/api/v1/reports/summary').query({ period: 'daily', account_id: secondAccountId });
      expect(res.status).toBe(200);
      expect(res.body.top_campaigns.some(c => c.entity_meta_id === 'camp_second_account')).toBe(true);
      expect(res.body.top_campaigns.some(c => c.entity_meta_id === 'camp_sales_kpi')).toBe(false);
    });

    test('GET /reports/summary with no account_id keeps reporting on the first active account (unchanged default)', async () => {
      const res = await request(app).get('/api/v1/reports/summary').query({ period: 'daily' });
      expect(res.body.top_campaigns.some(c => c.entity_meta_id === 'camp_second_account')).toBe(false);
    });
  });
});
