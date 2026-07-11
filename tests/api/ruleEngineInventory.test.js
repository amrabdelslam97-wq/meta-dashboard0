'use strict';

const request = require('supertest');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: GET /api/v1/rule-engine/inventory', () => {
  let testDb;
  let app;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('returns the full merged business-logic registry, tagged by owner', async () => {
    const res = await request(app).get('/api/v1/rule-engine/inventory');

    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.total).toBe(data.entries.length);
    expect(Array.isArray(data.entries)).toBe(true);

    const owners = new Set(data.entries.map(e => e.owner));
    expect(owners.has('ruleEngine')).toBe(true);
    expect(owners.has('alertEngine')).toBe(true);
    expect(owners.has('recommendationEngine')).toBe(true);
    expect(owners.has('diagnosisEngine')).toBe(true);
    expect(owners.has('opportunityEngine')).toBe(true);

    expect(data.byOwner.ruleEngine).toBeGreaterThan(0);
    expect(data.byOwner.diagnosisEngine).toBe(5);
    expect(data.byOwner.opportunityEngine).toBe(4);
  });

  test('DB-driven entries (alert/recommendation rules) are marked editableAtRuntime, native/attributed entries are not', async () => {
    const res = await request(app).get('/api/v1/rule-engine/inventory');
    const { entries } = res.body.data;

    const alertEntry = entries.find(e => e.owner === 'alertEngine');
    const nativeEntry = entries.find(e => e.owner === 'ruleEngine');
    const diagnosisEntry = entries.find(e => e.owner === 'diagnosisEngine');

    expect(alertEntry.editableAtRuntime).toBe(true);
    expect(nativeEntry.editableAtRuntime).toBe(false);
    expect(diagnosisEntry.editableAtRuntime).toBe(false);
  });

  test('reflects a newly-added DB alert_rule immediately (no boot-time caching)', async () => {
    const before = await request(app).get('/api/v1/rule-engine/inventory');
    const countBefore = before.body.data.byOwner.alertEngine;

    testDb.db.run(
      `INSERT INTO alert_rules (id, alert_code, alert_name, metric_key, trigger_type, trigger_value, severity)
       VALUES ('inv-test-1', 'INVENTORY_TEST_ALERT', 'Inventory Test Alert', 'ctr', 'threshold_absolute', 1.0, 'info')`
    );

    const after = await request(app).get('/api/v1/rule-engine/inventory');
    expect(after.body.data.byOwner.alertEngine).toBe(countBefore + 1);
    expect(after.body.data.entries.some(e => e.id === 'INVENTORY_TEST_ALERT')).toBe(true);
  });
});
