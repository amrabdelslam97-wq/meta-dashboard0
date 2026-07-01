'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { runRecommendationEngine, loadActiveRecommendations, computeConfidence } = require('../../src/services/recommendationEngine');

describe('recommendationEngine.computeConfidence', () => {
  test('returns a neutral 70 when threshold is 0 or unset', () => {
    expect(computeConfidence({ value: 0 }, 5)).toBe(70);
    expect(computeConfidence({ value: null }, 5)).toBe(70);
  });

  test('confidence rises with distance past the threshold', () => {
    const near = computeConfidence({ value: 1 }, 1.05);  // just past
    const far  = computeConfidence({ value: 1 }, 5);      // far past
    expect(far).toBeGreaterThan(near);
  });

  test('returns null when the actual value is null/undefined', () => {
    expect(computeConfidence({ value: 1 }, null)).toBeNull();
  });
});

describe('recommendationEngine.runRecommendationEngine', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_rec_engine', 'Rec Engine Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('fires the seeded LOW_ROAS rule when roas is below 1.0 for a sales campaign', () => {
    const campaign = { meta_campaign_id: 'camp_low_roas', name: 'Low ROAS Campaign', objective: 'sales' };
    const fired = runRecommendationEngine(campaign, { roas: 0.5 }, accountId);
    expect(fired.some(f => f.rule_code === 'LOW_ROAS')).toBe(true);

    const active = loadActiveRecommendations('camp_low_roas');
    expect(active.some(r => r.rule_code === 'LOW_ROAS')).toBe(true);
  });

  test('does not fire LOW_ROAS when roas is healthy', () => {
    const campaign = { meta_campaign_id: 'camp_healthy_roas', name: 'Healthy Campaign', objective: 'sales' };
    const fired = runRecommendationEngine(campaign, { roas: 4.0 }, accountId);
    expect(fired.some(f => f.rule_code === 'LOW_ROAS')).toBe(false);
  });

  test('auto-dismisses a previously-fired recommendation once the condition no longer holds', () => {
    const campaign = { meta_campaign_id: 'camp_recovers', name: 'Recovering Campaign', objective: 'sales' };
    runRecommendationEngine(campaign, { roas: 0.3 }, accountId); // fires
    expect(loadActiveRecommendations('camp_recovers').some(r => r.rule_code === 'LOW_ROAS')).toBe(true);

    runRecommendationEngine(campaign, { roas: 5.0 }, accountId); // recovers
    expect(loadActiveRecommendations('camp_recovers').some(r => r.rule_code === 'LOW_ROAS')).toBe(false);
  });

  // Regression test for T4-03: a rule row with condition_logic missing a
  // valid "metric" field used to throw inside the loop (condition.metric
  // .toUpperCase() on undefined), aborting the entire engine run for every
  // remaining rule AND campaign in that pass. Insert exactly such a
  // malformed rule and confirm the engine skips it gracefully instead of
  // crashing, and still evaluates the other valid rules.
  test('skips a rule with malformed condition_logic (missing metric) instead of crashing the whole run', () => {
    const malformedRuleId = uuidv4();
    testDb.db.run(
      `INSERT INTO recommendation_rules
         (id, rule_code, objective, rule_name, priority, condition_logic,
          recommendation_title, recommendation_body, recommendation_type, severity)
       VALUES (?, 'MALFORMED_RULE', 'sales', 'Malformed', 1, ?, 'Bad Rule', 'Bad Body', 'budget', 'warning')`,
      [malformedRuleId, JSON.stringify({ operator: 'lt', value: 1 })] // no "metric" key
    );

    const campaign = { meta_campaign_id: 'camp_malformed_test', name: 'Malformed Test', objective: 'sales' };
    let fired;
    expect(() => {
      fired = runRecommendationEngine(campaign, { roas: 0.2, ctr: 0.1 }, accountId);
    }).not.toThrow();

    // The malformed rule itself never fires, but valid rules (LOW_ROAS,
    // LOW_CTR) for the same campaign still evaluate normally afterward.
    expect(fired.some(f => f.rule_code === 'MALFORMED_RULE')).toBe(false);
    expect(fired.some(f => f.rule_code === 'LOW_ROAS')).toBe(true);
  });

  test('invalid JSON condition_logic is skipped without crashing', () => {
    const badJsonId = uuidv4();
    testDb.db.run(
      `INSERT INTO recommendation_rules
         (id, rule_code, objective, rule_name, priority, condition_logic,
          recommendation_title, recommendation_body, recommendation_type, severity)
       VALUES (?, 'BAD_JSON_RULE', 'leads', 'Bad JSON', 1, 'not valid json {{{', 'X', 'Y', 'budget', 'warning')`,
      [badJsonId]
    );

    const campaign = { meta_campaign_id: 'camp_bad_json', name: 'Bad JSON Test', objective: 'leads' };
    expect(() => runRecommendationEngine(campaign, { cpl: 200 }, accountId)).not.toThrow();
  });
});
