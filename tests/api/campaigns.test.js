'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/campaigns objective filter (new 6-value taxonomy)', () => {
  let testDb;
  let app;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_camp_filter_test', 'Campaign Filter Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );

    for (const objective of ['awareness', 'traffic', 'engagement', 'leads', 'app_promotion', 'sales']) {
      testDb.db.run(
        `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
        [uuidv4(), accountId, `camp_${objective}`, `${objective} campaign`, objective]
      );
    }
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test.each(['awareness', 'traffic', 'engagement', 'leads', 'app_promotion', 'sales'])(
    'accepts objective=%s and returns only matching campaigns',
    async (objective) => {
      const res = await request(app).get('/api/v1/campaigns').query({ objective });
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.every(c => c.objective === objective)).toBe(true);
    }
  );

  // Regression test: the old 'messaging' value must now be rejected, since
  // the taxonomy fix renamed it to 'engagement' and the DB CHECK
  // constraint (schema.phase8.js) no longer accepts it either.
  test('rejects the old "messaging" objective value', async () => {
    const res = await request(app).get('/api/v1/campaigns').query({ objective: 'messaging' });
    expect(res.status).toBe(400);
    expect(res.body.valid_values).not.toContain('messaging');
    expect(res.body.valid_values).toContain('engagement');
    expect(res.body.valid_values).toContain('app_promotion');
  });

  test('rejects a garbage objective value', async () => {
    const res = await request(app).get('/api/v1/campaigns').query({ objective: 'not_a_real_objective' });
    expect(res.status).toBe(400);
  });
});
