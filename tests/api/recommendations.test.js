'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/recommendations', () => {
  let testDb;
  let app;
  let accountId;
  let recId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_rec_test', 'Rec Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );

    recId = uuidv4();
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          severity, recommendation_title, recommendation_body)
       VALUES (?, 'LOW_CTR', ?, 'campaign', 'camp_rec_1', 'Test Campaign', 'warning', 'Low CTR', 'Body text')`,
      [recId, accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('GET /recommendations returns the seeded active recommendation', async () => {
    const res = await request(app).get('/api/v1/recommendations');
    expect(res.status).toBe(200);
    expect(res.body.data.some(r => r.id === recId)).toBe(true);
  });

  // Regression test for the recommendation_log has-no-updated_at-column
  // bug found during live verification: PATCH used to reference a
  // non-existent `updated_at` column in all three UPDATE branches, so
  // this endpoint failed with a SQL error for every request body shape.
  test('PATCH /recommendations/:id with dismiss:true succeeds (previously failed on every body shape)', async () => {
    const res = await request(app)
      .patch(`/api/v1/recommendations/${recId}`)
      .send({ dismiss: true });

    expect(res.status).toBe(200);
    expect(res.body.data.dismissed_at).not.toBeNull();
  });

  test('PATCH /recommendations/:id accepts dismiss as the string "true" (form-urlencoded coercion)', async () => {
    const recId2 = uuidv4();
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          severity, recommendation_title, recommendation_body)
       VALUES (?, 'HIGH_FREQUENCY', ?, 'campaign', 'camp_rec_2', 'Test Campaign 2', 'warning', 'High Freq', 'Body')`,
      [recId2, accountId]
    );

    const res = await request(app)
      .patch(`/api/v1/recommendations/${recId2}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('dismiss=true');

    expect(res.status).toBe(200);
    expect(res.body.data.dismissed_at).not.toBeNull();
  });

  test('PATCH /recommendations/:id can mark action_taken and set action_notes', async () => {
    const recId3 = uuidv4();
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          severity, recommendation_title, recommendation_body)
       VALUES (?, 'LOW_ROAS', ?, 'campaign', 'camp_rec_3', 'Test Campaign 3', 'critical', 'Low ROAS', 'Body')`,
      [recId3, accountId]
    );

    const res = await request(app)
      .patch(`/api/v1/recommendations/${recId3}`)
      .send({ action_taken: true, action_notes: 'Increased budget' });

    expect(res.status).toBe(200);
    expect(res.body.data.action_taken).toBe(true);
    expect(res.body.data.action_notes).toBe('Increased budget');
    expect(res.body.data.action_taken_at).not.toBeNull();
  });

  test('PATCH /recommendations/:id 404s for an unknown id', async () => {
    const res = await request(app)
      .patch('/api/v1/recommendations/00000000-0000-0000-0000-000000000000')
      .send({ dismiss: true });
    expect(res.status).toBe(404);
  });
});
