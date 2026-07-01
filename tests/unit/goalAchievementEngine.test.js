'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { evaluateGoalAchievement } = require('../../src/services/goalAchievementEngine');

describe('goalAchievementEngine.evaluateGoalAchievement', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [accountId, 'act_goal_test', 'Goal Test Account', 'enc:v1:placeholder']
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  function insertTargets(objective, overrides = {}) {
    testDb.db.run(
      `INSERT INTO account_targets
         (id, ad_account_id, objective, target_cpr, target_cpl, target_cpa, target_roas,
          target_ctr, target_cpm, target_frequency_max, effective_from)
       VALUES (?,?,?,?,?,?,?,?,?,?,date('now','-30 days'))`,
      [
        uuidv4(), accountId, objective,
        overrides.target_cpr ?? null, overrides.target_cpl ?? null, overrides.target_cpa ?? null,
        overrides.target_roas ?? null, overrides.target_ctr ?? null, overrides.target_cpm ?? null,
        overrides.target_frequency_max ?? null,
      ]
    );
  }

  test('no targets configured returns has_targets:false', () => {
    const result = evaluateGoalAchievement({ objective: 'traffic' }, {}, accountId);
    expect(result.has_targets).toBe(false);
    expect(result.composite_status).toBeNull();
  });

  test('lower-is-better target: actual below target is Exceeded', () => {
    insertTargets('messaging', { target_cpr: 10 });
    const result = evaluateGoalAchievement({ objective: 'messaging' }, { cpr: 5 }, accountId);
    expect(result.has_targets).toBe(true);
    expect(result.metric_results.cpr.status).toBe('Exceeded');
    expect(result.metric_results.cpr.achievement_pct).toBe(200); // 10/5*100
  });

  test('higher-is-better target: actual above target is Exceeded', () => {
    insertTargets('sales', { target_roas: 2 });
    const result = evaluateGoalAchievement({ objective: 'sales' }, { roas: 4 }, accountId);
    expect(result.metric_results.roas.status).toBe('Exceeded');
    expect(result.metric_results.roas.achievement_pct).toBe(200); // 4/2*100
  });

  // Regression test for T4-17: target_frequency_max is a ceiling, not a
  // "lower is better" target. Before the fix, frequency=0.5 against a
  // ceiling of 4.0 would compute achievement via the lower-is-better
  // formula (4.0/0.5*100 = 800%), producing a nonsensical "Exceeded"
  // status for a campaign that's actually under-delivering impressions
  // per user, not performing well. The fix caps achievement at 100% for
  // any value at or below the ceiling.
  test('ceiling target (frequency_max): value below the ceiling is capped at 100%, not treated as "exceeded" (T4-17)', () => {
    insertTargets('leads', { target_frequency_max: 4.0 });
    const result = evaluateGoalAchievement({ objective: 'leads' }, { frequency: 0.5 }, accountId);
    expect(result.metric_results.frequency.achievement_pct).toBe(100);
    expect(result.metric_results.frequency.status).toBe('On Track');
  });

  test('ceiling target: exceeding the ceiling degrades achievement below 100%', () => {
    insertTargets('awareness', { target_frequency_max: 4.0 });
    const result = evaluateGoalAchievement({ objective: 'awareness' }, { frequency: 8.0 }, accountId);
    expect(result.metric_results.frequency.achievement_pct).toBe(50); // 4/8*100
    expect(result.metric_results.frequency.status).toBe('Missed');
  });

  test('missing actual metric value yields "No Data" without crashing', () => {
    insertTargets('traffic', { target_ctr: 2 });
    const result = evaluateGoalAchievement({ objective: 'traffic' }, {}, accountId);
    expect(result.metric_results.ctr.status).toBe('No Data');
  });

  test('composite_status is the worst status across all evaluated metrics', () => {
    // Distinct fake objective string (this table has no CHECK constraint
    // on objective) so this insert's (ad_account_id, objective,
    // effective_from) tuple doesn't collide with the 'sales' target
    // already inserted by the earlier "higher-is-better" test above.
    insertTargets('sales_composite_test', { target_roas: 4, target_cpa: 20, target_ctr: 3 });
    const result = evaluateGoalAchievement(
      { objective: 'sales_composite_test' },
      { roas: 4, cpa: 20, ctr: 0.1 }, // ctr wildly missed
      accountId
    );
    expect(result.metric_results.ctr.status).toBe('Missed');
    expect(result.composite_status).toBe('Missed');
  });
});
