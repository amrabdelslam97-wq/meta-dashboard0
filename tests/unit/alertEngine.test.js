'use strict';

const { createTestDb } = require('../helpers/testDb');
const { runAlertEngine } = require('../../src/services/alertEngine');

describe('alertEngine.runAlertEngine objective_scope (T5-01)', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  // Regression test: ROAS_BELOW_ONE was previously seeded with
  // objective_scope=NULL, so it fired on every objective even though ROAS
  // is never a real metric outside of 'sales' campaigns. seedIntelligence.js
  // now scopes it to 'sales' (both in the seed data and via an idempotent
  // repair UPDATE for rows seeded before this fix).
  test('ROAS_BELOW_ONE fires for a sales campaign with roas < 1.0', () => {
    const campaign = { meta_campaign_id: 'camp_alert_sales', name: 'Sales Campaign', objective: 'sales' };
    const alerts = runAlertEngine(campaign, { roas: 0.5 }, null, 'acct-alert', 'campaign');
    expect(alerts.some(a => a.alert_code === 'ROAS_BELOW_ONE')).toBe(true);
  });

  test('ROAS_BELOW_ONE does NOT fire for a non-sales objective, even if a roas-shaped value is present', () => {
    const campaign = { meta_campaign_id: 'camp_alert_engagement', name: 'Engagement Campaign', objective: 'engagement' };
    const alerts = runAlertEngine(campaign, { roas: 0.5 }, null, 'acct-alert', 'campaign');
    expect(alerts.some(a => a.alert_code === 'ROAS_BELOW_ONE')).toBe(false);
  });

  test('objective-unscoped rules (CPM_SPIKE, CTR_DROP) still fire for any objective', () => {
    const campaign = { meta_campaign_id: 'camp_alert_traffic', name: 'Traffic Campaign', objective: 'traffic' };
    const current = { cpm: 20, ctr: 1 };
    const prior = { cpm: 10, ctr: 2 }; // +100% CPM, -50% CTR
    const alerts = runAlertEngine(campaign, current, prior, 'acct-alert', 'campaign');
    const codes = alerts.map(a => a.alert_code);
    expect(codes).toContain('CPM_SPIKE');
    expect(codes).toContain('CTR_DROP');
  });
});
