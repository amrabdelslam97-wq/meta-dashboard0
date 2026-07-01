'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/alerts', () => {
  let testDb;
  let app;
  let accountId;
  let alertId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_alert_test', 'Alert Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );

    alertId = uuidv4();
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'CTR_DROP', 'campaign', 'camp_alert_1', 'Test Campaign', 'warning', 'CTR dropped 30%')`,
      [alertId, accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('GET /alerts returns the active alert by default', async () => {
    const res = await request(app).get('/api/v1/alerts');
    expect(res.status).toBe(200);
    expect(res.body.data.some(a => a.id === alertId)).toBe(true);
  });

  test('PATCH /alerts/:id action=dismiss dismisses the alert', async () => {
    const res = await request(app)
      .patch(`/api/v1/alerts/${alertId}`)
      .send({ action: 'dismiss' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('dismissed');
  });

  test('PATCH /alerts/:id action=snooze with snooze_hours pushes snoozed_until into the future', async () => {
    const alertId2 = uuidv4();
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'ROAS_BELOW_ONE', 'campaign', 'camp_alert_2', 'Test Campaign 2', 'critical', 'ROAS below 1.0')`,
      [alertId2, accountId]
    );

    const res = await request(app)
      .patch(`/api/v1/alerts/${alertId2}`)
      .send({ action: 'snooze', snooze_hours: 48 });

    expect(res.status).toBe(200);
    expect(new Date(res.body.data.snoozed_until).getTime()).toBeGreaterThan(Date.now());
  });

  // Regression test: snooze_until previously had no date validation at
  // all -- an invalid string would flow straight into the UPDATE and
  // produce a garbage snoozed_until value rather than a clear 400.
  test('PATCH /alerts/:id action=snooze rejects an invalid snooze_until date string', async () => {
    const alertId3 = uuidv4();
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'CPM_SPIKE', 'campaign', 'camp_alert_3', 'Test Campaign 3', 'warning', 'CPM spiked')`,
      [alertId3, accountId]
    );

    const res = await request(app)
      .patch(`/api/v1/alerts/${alertId3}`)
      .send({ action: 'snooze', snooze_until: 'not-a-real-date' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid date/);

    const row = testDb.db.get('SELECT snoozed_until FROM active_alerts WHERE id = ?', [alertId3]);
    expect(row.snoozed_until).toBeNull(); // unchanged, no garbage value written
  });

  test('PATCH /alerts/:id action=snooze accepts an explicit valid ISO snooze_until', async () => {
    const alertId4 = uuidv4();
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'CTR_DROP', 'campaign', 'camp_alert_4', 'Test Campaign 4', 'warning', 'CTR dropped')`,
      [alertId4, accountId]
    );

    const res = await request(app)
      .patch(`/api/v1/alerts/${alertId4}`)
      .send({ action: 'snooze', snooze_until: '2027-01-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.data.snoozed_until).toBe('2027-01-01T00:00:00.000Z');
  });

  test('PATCH /alerts/:id action=resolve sets status and resolved_at', async () => {
    const alertId5 = uuidv4();
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'CTR_DROP', 'campaign', 'camp_alert_5', 'Test Campaign 5', 'warning', 'CTR dropped')`,
      [alertId5, accountId]
    );
    const res = await request(app).patch(`/api/v1/alerts/${alertId5}`).send({ action: 'resolve' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('resolved');
    expect(res.body.data.resolved_at).not.toBeNull();
  });

  test('PATCH /alerts/:id rejects an invalid action', async () => {
    const res = await request(app).patch(`/api/v1/alerts/${alertId}`).send({ action: 'not-a-real-action' });
    expect(res.status).toBe(400);
  });

  test('PATCH /alerts/:id 404s for an unknown id', async () => {
    const res = await request(app)
      .patch('/api/v1/alerts/00000000-0000-0000-0000-000000000000')
      .send({ action: 'dismiss' });
    expect(res.status).toBe(404);
  });
});
