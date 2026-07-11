'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');
const { encryptToken } = require('../../src/services/tokenCrypto');

describe('API: GET /api/v1/campaigns/:id/insights/diagnosis', () => {
  let testDb;
  let app;
  let accountId;
  let campaignId;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_diag_test', 'Diagnosis Test Account', ?, datetime('now'), datetime('now'))`,
      [accountId, encryptToken('fake-meta-token')]
    );

    campaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_diag_1', 'Diagnosis Test Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('returns 200 with a diagnosis for a real seeded campaign (mock data)', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/insights/diagnosis`)
      .query({ mock: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.campaign_id).toBe('camp_diag_1');
    expect(res.body.objective).toBe('sales');
    expect(res.body.is_mock).toBe(true);
    expect(res.body.diagnosis).toBeDefined();
    expect(['diagnosed', 'insufficient_data']).toContain(res.body.diagnosis.status);
    expect(res.body).toHaveProperty('health_score');
    expect(res.body).toHaveProperty('related_decisions');
    expect(Array.isArray(res.body.related_decisions)).toBe(true);

    // Phase 10 — MAIFS/MMS governance trace attached alongside the
    // existing Diagnosis fields (additive, does not replace anything above).
    expect(res.body._governance).toBeDefined();
    expect(res.body._governance.execution_order[0]).toBe('MF1');
    expect(res.body._governance.execution_order).not.toContain('MF9');
    expect(res.body._governance.self_check.overall).toBeDefined();
    expect(res.body._governance.decision_validations.overall).toBeDefined();
  });

  test('Product Completion Mode Milestone 1 — executive_summary is present on the diagnosis route too', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/insights/diagnosis`)
      .query({ mock: 'true' });

    expect(res.status).toBe(200);
    expect(typeof res.body.executive_summary).toBe('string');
    expect(res.body.executive_summary).toContain('sales campaign');
  });

  test('is also reachable by meta_campaign_id, not just internal id', async () => {
    const res = await request(app)
      .get('/api/v1/campaigns/camp_diag_1/insights/diagnosis')
      .query({ mock: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.campaign_id).toBe('camp_diag_1');
  });

  test('returns 404 for an unknown campaign id', async () => {
    const res = await request(app)
      .get('/api/v1/campaigns/does-not-exist/insights/diagnosis')
      .query({ mock: 'true' });
    expect(res.status).toBe(404);
  });

  test('Phase X.5 — exposes recommendation_findings/alert_findings and related_decisions\' Expected Result/Next Action columns, with zero new writes', async () => {
    const recCountBefore = testDb.db.get('SELECT COUNT(*) as c FROM recommendation_log').c;
    const alertCountBefore = testDb.db.get('SELECT COUNT(*) as c FROM active_alerts').c;

    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/insights/diagnosis`)
      .query({ mock: 'true' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recommendation_findings)).toBe(true);
    expect(Array.isArray(res.body.alert_findings)).toBe(true);
    if (res.body.related_decisions.length) {
      expect(res.body.related_decisions[0]).toHaveProperty('expected_impact');
      expect(res.body.related_decisions[0]).toHaveProperty('supporting_metrics');
      expect(res.body.related_decisions[0]).toHaveProperty('action_taken');
      expect(res.body.related_decisions[0]).toHaveProperty('action_notes');
    }

    // Proves loadActiveRecommendations()/loadActiveAlerts() are pure reads --
    // this route must not write to recommendation_log/active_alerts (it has
    // never run recommendationEngine.js/alertEngine.js, only read from them).
    const recCountAfter = testDb.db.get('SELECT COUNT(*) as c FROM recommendation_log').c;
    const alertCountAfter = testDb.db.get('SELECT COUNT(*) as c FROM active_alerts').c;
    expect(recCountAfter).toBe(recCountBefore);
    expect(alertCountAfter).toBe(alertCountBefore);
  });

  test('Phase X.5 — surfaces an active recommendation as a unified card-ready finding', async () => {
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          objective, severity, recommendation_title, recommendation_body,
          generated_at, last_generated_at)
       VALUES (?, 'LOW_CTR', ?, 'campaign', 'camp_diag_1', 'Diagnosis Test Campaign',
               'sales', 'warning', 'Low CTR', 'Refresh creative.', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );

    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/insights/diagnosis`)
      .query({ mock: 'true' });

    expect(res.status).toBe(200);
    const finding = res.body.findings.find(f => f.source === 'recommendation' && f.source_id === 'LOW_CTR');
    expect(finding).toBeDefined();
    expect(finding.decision_type).toBe('REFRESH_CREATIVE');
    expect(finding.suggested_action).toBe('Refresh creative.');
    expect(finding.framework).toBeNull();
    // No decision_history row exists yet for this finding -- Expected
    // Result/Next Action must be honestly null, not fabricated.
    expect(finding.expected_impact).toBeNull();
    expect(finding.next_action_status).toBeNull();
  });

  test('Phase X.5 — surfaces a real governance_state on a recommendation finding once persisted (Phase X.3)', async () => {
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          objective, severity, recommendation_title, recommendation_body, governance_state,
          generated_at, last_generated_at)
       VALUES (?, 'HIGH_FREQUENCY', ?, 'campaign', 'camp_diag_1', 'Diagnosis Test Campaign',
               'sales', 'warning', 'Audience fatigue', 'Expand audience.', 'warning',
               datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );

    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/insights/diagnosis`)
      .query({ mock: 'true' });

    const finding = res.body.findings.find(f => f.source === 'recommendation' && f.source_id === 'HIGH_FREQUENCY');
    expect(finding).toBeDefined();
    expect(finding.governance_state).toBe('warning');
  });

  test('Phase X.6 — surfaces historical_note on a recommendation finding after 2 ineffective prior attempts of the same decision_type', async () => {
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          objective, severity, recommendation_title, recommendation_body,
          generated_at, last_generated_at)
       VALUES (?, 'LOW_ROAS', ?, 'campaign', 'camp_diag_1', 'Diagnosis Test Campaign',
               'sales', 'critical', 'Losing money', 'Pause and review.', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );
    // LOW_ROAS maps to PAUSE_CAMPAIGN -- simulate 2 prior ineffective
    // attempts of that exact decision_type for this exact campaign.
    for (const outcome of ['worsened', 'no_change']) {
      const dhId = uuidv4();
      testDb.db.run(
        `INSERT INTO decision_history (id, ad_account_id, meta_campaign_id, campaign_name, objective, decision_type, priority, priority_score, reason, suggested_action, confidence, status, created_at, updated_at)
         VALUES (?, ?, 'camp_diag_1', 'Diagnosis Test Campaign', 'sales', 'PAUSE_CAMPAIGN', 'critical', 90, 'test', 'test action', 'high', 'completed', datetime('now'), datetime('now'))`,
        [dhId, accountId]
      );
      testDb.db.run(
        `INSERT INTO decision_outcomes (id, decision_history_id, meta_campaign_id, decision_type, metric_key, metric_before, metric_after, delta_pct, outcome, measured_at)
         VALUES (?, ?, 'camp_diag_1', 'PAUSE_CAMPAIGN', 'roas', 1, 1, 0, ?, datetime('now'))`,
        [uuidv4(), dhId, outcome]
      );
    }

    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/insights/diagnosis`)
      .query({ mock: 'true' });

    const finding = res.body.findings.find(f => f.source === 'recommendation' && f.source_id === 'LOW_ROAS');
    expect(finding).toBeDefined();
    expect(finding.decision_type).toBe('PAUSE_CAMPAIGN');
    expect(finding.historical_note).toMatch(/Tried twice before/);
    expect(finding.historical_effectiveness.lastTwoIneffective).toBe(true);
    // Confidence must be downgraded from what it would otherwise be
    // (severity 'critical' -> baseline 'high' per decisionShapeForGovernance's convention).
    expect(finding.confidence).toBe('medium');
  });

  test('Phase X.6 — surfaces historical_note on an ALERT-sourced finding after 2 ineffective prior attempts (verifies all 3 governed sources, not just recommendation)', async () => {
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label,
          severity, alert_message, status, first_detected_at, last_detected_at)
       VALUES (?, ?, 'CPM_SPIKE', 'campaign', 'camp_diag_1', 'Diagnosis Test Campaign',
               'warning', 'CPM spiked.', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );
    // CPM_SPIKE maps to REVIEW_PERFORMANCE -- simulate 2 prior ineffective
    // attempts of that exact decision_type for this exact campaign.
    for (const outcome of ['worsened', 'no_change']) {
      const dhId = uuidv4();
      testDb.db.run(
        `INSERT INTO decision_history (id, ad_account_id, meta_campaign_id, campaign_name, objective, decision_type, priority, priority_score, reason, suggested_action, confidence, status, created_at, updated_at)
         VALUES (?, ?, 'camp_diag_1', 'Diagnosis Test Campaign', 'sales', 'REVIEW_PERFORMANCE', 'medium', 50, 'test', 'test action', 'medium', 'completed', datetime('now'), datetime('now'))`,
        [dhId, accountId]
      );
      testDb.db.run(
        `INSERT INTO decision_outcomes (id, decision_history_id, meta_campaign_id, decision_type, metric_key, metric_before, metric_after, delta_pct, outcome, measured_at)
         VALUES (?, ?, 'camp_diag_1', 'REVIEW_PERFORMANCE', 'cpm', 100, 100, 0, ?, datetime('now'))`,
        [uuidv4(), dhId, outcome]
      );
    }

    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/insights/diagnosis`)
      .query({ mock: 'true' });

    const finding = res.body.findings.find(f => f.source === 'alert' && f.source_id === 'CPM_SPIKE');
    expect(finding).toBeDefined();
    expect(finding.decision_type).toBe('REVIEW_PERFORMANCE');
    expect(finding.historical_note).toMatch(/Tried twice before/);
    expect(finding.historical_effectiveness.lastTwoIneffective).toBe(true);
    // Baseline confidence for a 'warning'-severity alert is 'medium' (decisionShapeForGovernance's
    // convention) -> downgraded one band to 'low'.
    expect(finding.confidence).toBe('low');
  });
});
