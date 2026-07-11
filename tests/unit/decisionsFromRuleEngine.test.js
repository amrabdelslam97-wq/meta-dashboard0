'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { decisionsFromRuleEngine, persistRuleEngineFirings, DECISION_LABELS } = require('../../src/services/decisionEngine');
const { executeRules } = require('../../src/services/ruleEngine');
require('../../src/services/ruleRegistrySeed');

describe('decisionEngine.decisionsFromRuleEngine', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_rule_decision_test', 'Rule Decision Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  const campaign = { meta_campaign_id: 'camp_rule_1', name: 'Rule Engine Test Campaign', objective: 'traffic' };

  test('converts a fired Rule Engine result into a Decision with full Framework/Rule attribution', () => {
    const { fired } = executeRules({
      objective: 'traffic',
      current: { link_clicks: 1000, landing_page_views: 200 },
      deltas: {},
    });
    expect(fired.length).toBeGreaterThan(0); // High Bounce should have fired

    const decisions = decisionsFromRuleEngine(campaign, accountId, fired);
    expect(decisions).toHaveLength(fired.length);

    const d = decisions.find(x => x.rule_id === 'MF7.10.10');
    expect(d).toBeDefined();
    expect(d.source).toBe('rule_engine');
    expect(d.framework).toBe('MF7');
    expect(d.decision_type).toBe('FIX_TRACKING');
    expect(d.decision_label).toBe(DECISION_LABELS.FIX_TRACKING);
    expect(d.meta_campaign_id).toBe('camp_rule_1');
    expect(typeof d.priority).toBe('string');
    expect(typeof d.priority_score).toBe('number');
    expect(d.suggested_action).toBeTruthy();
    expect(d.evidence).toBeDefined();
  });

  test('returns an empty array when no rules fired', () => {
    const decisions = decisionsFromRuleEngine(campaign, accountId, []);
    expect(decisions).toEqual([]);
  });

  test('a higher-severity fired rule produces a higher priority_score than a lower-severity one, all else equal', () => {
    const warningFired = [{
      rule_id: 'X1', framework: 'MF7', framework_name: 'Optimization Framework', rule_name: 'Test',
      version: 1, category: 'tracking', severity: 'warning',
      evidence: [], reason: 'test', action: { type: 'FIX_TRACKING' }, provenance: {},
    }];
    const criticalFired = [{ ...warningFired[0], rule_id: 'X2', severity: 'critical' }];

    const [warningDecision] = decisionsFromRuleEngine(campaign, accountId, warningFired);
    const [criticalDecision] = decisionsFromRuleEngine(campaign, accountId, criticalFired);
    expect(criticalDecision.priority_score).toBeGreaterThan(warningDecision.priority_score);
  });
});

describe('decisionEngine.persistRuleEngineFirings (Phase X.1 — entity_type correctness)', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_persist_test', 'Persist Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  const syntheticFired = [{
    rule_id: 'MF-TEST-PERSIST', framework: 'MF7', rule_name: 'Test Rule', category: 'tracking',
    severity: 'warning', reason: 'test', evidence: [], action: { type: 'FIX_TRACKING' }, governance_state: 'passed',
  }];

  test('defaults to entity_type "campaign" when omitted (backward compatible)', () => {
    const campaign = { meta_campaign_id: 'camp_persist_1', name: 'Campaign A', objective: 'traffic' };
    persistRuleEngineFirings(accountId, campaign, syntheticFired);
    const row = testDb.db.get(`SELECT entity_type FROM rule_engine_log WHERE entity_meta_id = ?`, ['camp_persist_1']);
    expect(row.entity_type).toBe('campaign');
  });

  test('records the correct entity_type for an ad_set-grain firing (was hardcoded to "campaign" before Phase X.1)', () => {
    const adSet = { meta_campaign_id: 'adset_persist_1', name: 'Ad Set A', objective: 'traffic' };
    persistRuleEngineFirings(accountId, adSet, syntheticFired, 'ad_set');
    const row = testDb.db.get(`SELECT entity_type FROM rule_engine_log WHERE entity_meta_id = ?`, ['adset_persist_1']);
    expect(row.entity_type).toBe('ad_set');
  });

  test('records the correct entity_type for an ad-grain firing', () => {
    const ad = { meta_campaign_id: 'ad_persist_1', name: 'Ad A', objective: 'traffic' };
    persistRuleEngineFirings(accountId, ad, syntheticFired, 'ad');
    const row = testDb.db.get(`SELECT entity_type FROM rule_engine_log WHERE entity_meta_id = ?`, ['ad_persist_1']);
    expect(row.entity_type).toBe('ad');
  });
});
