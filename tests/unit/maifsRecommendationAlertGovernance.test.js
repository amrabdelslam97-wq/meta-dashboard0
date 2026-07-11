'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const {
  decisionShapeForGovernance, persistGovernanceState,
  decisionsFromRecommendations, decisionsFromAlerts,
} = require('../../src/services/decisionEngine');
const { enforceGovernance } = require('../../src/services/maifsGovernance');

describe('decisionEngine.decisionShapeForGovernance', () => {
  test('maps a known recommendation rule_code to its decision_type via REC_TO_DECISION', () => {
    const shape = decisionShapeForGovernance('recommendation', {
      rule_code: 'LOW_ROAS', severity: 'critical', recommendation_body: 'Pause and review.',
    });
    expect(shape.decision_type).toBe('PAUSE_CAMPAIGN');
    expect(shape.priority).toBe('critical');
    expect(shape.confidence).toBe('high');
    expect(shape.suggested_action).toBe('Pause and review.');
  });

  test('maps a known alert_code to its decision_type via ALERT_TO_DECISION', () => {
    const shape = decisionShapeForGovernance('alert', {
      alert_code: 'CPM_SPIKE', severity: 'warning', alert_message: 'CPM spiked.',
    });
    expect(shape.decision_type).toBe('REVIEW_PERFORMANCE');
    expect(shape.priority).toBe('high');
    expect(shape.confidence).toBe('medium');
    expect(shape.suggested_action).toBe('CPM spiked.');
  });

  test('returns decision_type:null (never throws) for an unmapped code', () => {
    const shape = decisionShapeForGovernance('recommendation', {
      rule_code: 'SOME_CUSTOM_RULE', severity: 'info', recommendation_body: 'Custom.',
    });
    expect(shape.decision_type).toBeNull();
  });
});

describe('decisionEngine + maifsGovernance integration: recommendation/alert governance', () => {
  test('a critical-priority, low-confidence recommendation shape fails the Confidence gate and gets downgraded', () => {
    const shape = decisionShapeForGovernance('recommendation', {
      rule_code: 'LOW_ROAS', severity: 'critical', recommendation_body: 'Pause and review.',
    });
    // Force low confidence to fail MMS.10.2's final gate for a critical decision.
    shape.confidence = 'low';

    const [enforced] = enforceGovernance([shape], {
      objective: 'sales', currentMetrics: { impressions: 500 }, diagnosis: null,
    });
    expect(enforced.governance_state).toBe('failed');
    expect(enforced.priority).toBe('observation_only');
    expect(enforced.priority_score).toBe(0);
  });

  test('a well-formed recommendation shape with sufficient data passes governance', () => {
    const shape = decisionShapeForGovernance('recommendation', {
      rule_code: 'LOW_CTR', severity: 'warning', recommendation_body: 'Refresh creative.',
    });
    const [enforced] = enforceGovernance([shape], {
      objective: 'traffic', currentMetrics: { impressions: 5000 }, diagnosis: null,
    });
    expect(enforced.governance_state).toBe('passed');
  });
});

describe('decisionEngine.persistGovernanceState', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_gov_test', 'Governance Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('persists governance_state onto the matching recommendation_log row, keyed by rule_code + entity_meta_id', () => {
    const recId = uuidv4();
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          objective, severity, recommendation_title, recommendation_body,
          generated_at, last_generated_at)
       VALUES (?, 'LOW_ROAS', ?, 'campaign', 'camp_gov_1', 'Gov Test Campaign',
               'sales', 'critical', 'Losing money', 'Pause and review.',
               datetime('now'), datetime('now'))`,
      [recId, accountId]
    );

    persistGovernanceState('recommendation_log', 'rule_code', 'LOW_ROAS', 'camp_gov_1', 'failed');

    const row = testDb.db.get('SELECT governance_state FROM recommendation_log WHERE id = ?', [recId]);
    expect(row.governance_state).toBe('failed');
  });

  test('persists governance_state onto the matching active_alerts row, keyed by alert_code + entity_meta_id', () => {
    const alertId = uuidv4();
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label,
          severity, alert_message, status, first_detected_at, last_detected_at)
       VALUES (?, ?, 'CPM_SPIKE', 'campaign', 'camp_gov_2', 'Gov Test Campaign 2',
               'warning', 'CPM spiked.', 'active', datetime('now'), datetime('now'))`,
      [alertId, accountId]
    );

    persistGovernanceState('active_alerts', 'alert_code', 'CPM_SPIKE', 'camp_gov_2', 'passed');

    const row = testDb.db.get('SELECT governance_state FROM active_alerts WHERE id = ?', [alertId]);
    expect(row.governance_state).toBe('passed');
  });

  test('decisionsFromRecommendations() downgrades priority to observation_only when governance_state is failed', () => {
    const recId = uuidv4();
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          objective, severity, recommendation_title, recommendation_body,
          governance_state, generated_at, last_generated_at)
       VALUES (?, 'LOW_CTR', ?, 'campaign', 'camp_gov_3', 'Gov Test Campaign 3',
               'traffic', 'warning', 'Low CTR', 'Refresh creative.',
               'failed', datetime('now'), datetime('now'))`,
      [recId, accountId]
    );

    const decisions = decisionsFromRecommendations(accountId);
    const d = decisions.find(x => x.meta_campaign_id === 'camp_gov_3');
    expect(d).toBeDefined();
    expect(d.priority).toBe('observation_only');
    expect(d.priority_score).toBe(0);
    expect(d.governance_state).toBe('failed');
  });

  test('decisionsFromAlerts() downgrades priority to observation_only when governance_state is failed', () => {
    const alertId = uuidv4();
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label,
          severity, alert_message, status, governance_state, first_detected_at, last_detected_at)
       VALUES (?, ?, 'CTR_DROP', 'campaign', 'camp_gov_4', 'Gov Test Campaign 4',
               'warning', 'CTR dropped.', 'active', 'failed', datetime('now'), datetime('now'))`,
      [alertId, accountId]
    );

    const decisions = decisionsFromAlerts(accountId);
    const d = decisions.find(x => x.meta_campaign_id === 'camp_gov_4');
    expect(d).toBeDefined();
    expect(d.priority).toBe('observation_only');
    expect(d.priority_score).toBe(0);
    expect(d.governance_state).toBe('failed');
  });
});
