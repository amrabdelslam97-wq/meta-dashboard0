'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const {
  classifyOutcome, measureOutcomes, getHistoricalEffectiveness, applyHistoricalLearning,
  DECISION_TYPE_TO_METRIC,
} = require('../../src/services/executiveMemory');

describe('executiveMemory.classifyOutcome (pure, no DB)', () => {
  test('REFRESH_CREATIVE metric (ctr): rising ctr is improved (falling is worse for ctr)', () => {
    expect(classifyOutcome('ctr', 1.0, 1.5)).toBe('improved'); // +50%
    expect(classifyOutcome('ctr', 1.0, 0.5)).toBe('worsened'); // -50%
    expect(classifyOutcome('ctr', 1.0, 1.02)).toBe('no_change'); // +2%, under threshold
  });

  test('PAUSE_CAMPAIGN metric (roas): rising is improved', () => {
    expect(classifyOutcome('roas', 1.0, 1.5)).toBe('improved');
    expect(classifyOutcome('roas', 1.0, 0.5)).toBe('worsened');
  });

  test('REVIEW_PERFORMANCE metric (cpm): falling is improved (rising cpm is worse -- cost metric)', () => {
    expect(classifyOutcome('cpm', 100, 80)).toBe('improved');
    expect(classifyOutcome('cpm', 100, 140)).toBe('worsened');
  });

  test('EXPAND_AUDIENCE metric (frequency): falling is improved (WORSE_DIRECTION_OVERRIDE, not covered by diagnosisEngine.classifyMetric)', () => {
    expect(classifyOutcome('frequency', 4.0, 3.0)).toBe('improved');
    expect(classifyOutcome('frequency', 4.0, 5.0)).toBe('worsened');
  });

  test('returns null (never fabricates) for an unclassifiable metric', () => {
    expect(classifyOutcome('spend', 100, 200)).toBeNull();
  });

  test('returns null when before or after is missing', () => {
    expect(classifyOutcome('ctr', null, 1.0)).toBeNull();
    expect(classifyOutcome('ctr', 1.0, null)).toBeNull();
  });

  test('DECISION_TYPE_TO_METRIC intentionally omits decision types with no single canonical metric', () => {
    expect(DECISION_TYPE_TO_METRIC.REALLOCATE_BUDGET).toBeUndefined();
    expect(DECISION_TYPE_TO_METRIC.FIX_TRACKING).toBeUndefined();
    expect(DECISION_TYPE_TO_METRIC.BUDGET_WARNING).toBeUndefined();
    expect(DECISION_TYPE_TO_METRIC.SCALE_CAMPAIGN).toBeUndefined();
  });
});

describe('executiveMemory.measureOutcomes (DB integration)', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_mem_test', 'Memory Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  function insertCompletedDecision({ metaCampaignId, decisionType, supportingMetrics, completedAt }) {
    const id = uuidv4();
    testDb.db.run(
      `INSERT INTO decision_history
         (id, ad_account_id, meta_campaign_id, campaign_name, objective, decision_type,
          priority, priority_score, reason, supporting_metrics, suggested_action,
          confidence, status, action_taken, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'Test Campaign', 'traffic', ?, 'medium', 50, 'test', ?, 'test action',
               'medium', 'completed', 1, ?, datetime('now'), datetime('now'))`,
      [id, accountId, metaCampaignId, decisionType, JSON.stringify(supportingMetrics), completedAt]
    );
    return id;
  }

  test('measures and persists an outcome for a completed decision older than the measurement window', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString();
    const decisionId = insertCompletedDecision({
      metaCampaignId: 'camp_mem_1', decisionType: 'REFRESH_CREATIVE',
      supportingMetrics: { ctr: 0.5 }, completedAt: eightDaysAgo,
    });

    const measured = measureOutcomes({ meta_campaign_id: 'camp_mem_1' }, { ctr: 1.2 });

    expect(measured).toHaveLength(1);
    expect(measured[0].decision_history_id).toBe(decisionId);
    expect(measured[0].outcome).toBe('improved');

    const row = testDb.db.get('SELECT * FROM decision_outcomes WHERE decision_history_id = ?', [decisionId]);
    expect(row).toBeDefined();
    expect(row.metric_key).toBe('ctr');
    expect(row.metric_before).toBe(0.5);
    expect(row.metric_after).toBe(1.2);
    expect(row.outcome).toBe('improved');
  });

  test('does not re-measure a decision that already has a decision_outcomes row', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString();
    insertCompletedDecision({
      metaCampaignId: 'camp_mem_1', decisionType: 'REFRESH_CREATIVE',
      supportingMetrics: { ctr: 0.5 }, completedAt: eightDaysAgo,
    });

    // First call measures the new one from this test + skips the already-measured one from the prior test.
    const measured = measureOutcomes({ meta_campaign_id: 'camp_mem_1' }, { ctr: 1.2 });
    expect(measured).toHaveLength(1);

    // Second call: nothing left to measure.
    const measuredAgain = measureOutcomes({ meta_campaign_id: 'camp_mem_1' }, { ctr: 1.2 });
    expect(measuredAgain).toHaveLength(0);
  });

  test('does NOT measure a decision younger than the measurement window (completed yesterday)', () => {
    const yesterday = new Date(Date.now() - 1 * 86400000).toISOString();
    insertCompletedDecision({
      metaCampaignId: 'camp_mem_2', decisionType: 'REFRESH_CREATIVE',
      supportingMetrics: { ctr: 0.5 }, completedAt: yesterday,
    });

    const measured = measureOutcomes({ meta_campaign_id: 'camp_mem_2' }, { ctr: 1.2 });
    expect(measured).toHaveLength(0);
  });

  test('skips decision types with no canonical metric (e.g. FIX_TRACKING) -- never fabricates an outcome', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString();
    insertCompletedDecision({
      metaCampaignId: 'camp_mem_3', decisionType: 'FIX_TRACKING',
      supportingMetrics: { ctr: 0.5 }, completedAt: eightDaysAgo,
    });

    const measured = measureOutcomes({ meta_campaign_id: 'camp_mem_3' }, { ctr: 1.2 });
    expect(measured).toHaveLength(0);
  });
});

describe('executiveMemory.getHistoricalEffectiveness + applyHistoricalLearning', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_mem_test2', 'Memory Test 2', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  function insertOutcome(metaCampaignId, decisionType, outcome) {
    const dhId = uuidv4();
    testDb.db.run(
      `INSERT INTO decision_history
         (id, ad_account_id, meta_campaign_id, campaign_name, objective, decision_type,
          priority, priority_score, reason, suggested_action, confidence, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Test Campaign', 'traffic', ?, 'medium', 50, 'test', 'test action', 'medium', 'completed', datetime('now'), datetime('now'))`,
      [dhId, accountId, metaCampaignId, decisionType]
    );
    testDb.db.run(
      `INSERT INTO decision_outcomes (id, decision_history_id, meta_campaign_id, decision_type, metric_key, metric_before, metric_after, delta_pct, outcome, measured_at)
       VALUES (?, ?, ?, ?, 'ctr', 1, 1, 0, ?, datetime('now'))`,
      [uuidv4(), dhId, metaCampaignId, decisionType, outcome]
    );
  }

  test('getHistoricalEffectiveness returns zero counts for a campaign/type with no history', () => {
    const eff = getHistoricalEffectiveness('camp_no_history', 'REFRESH_CREATIVE');
    expect(eff.attempts).toBe(0);
    expect(eff.lastTwoIneffective).toBe(false);
    expect(eff.lastOutcome).toBeNull();
  });

  test('lastTwoIneffective is true after 2 consecutive worsened/no_change outcomes', () => {
    insertOutcome('camp_mem_4', 'REFRESH_CREATIVE', 'worsened');
    insertOutcome('camp_mem_4', 'REFRESH_CREATIVE', 'no_change');

    const eff = getHistoricalEffectiveness('camp_mem_4', 'REFRESH_CREATIVE');
    expect(eff.attempts).toBe(2);
    expect(eff.lastTwoIneffective).toBe(true);
  });

  test('lastTwoIneffective is false if the most recent outcome was improved', () => {
    insertOutcome('camp_mem_5', 'REFRESH_CREATIVE', 'worsened');
    insertOutcome('camp_mem_5', 'REFRESH_CREATIVE', 'improved');

    const eff = getHistoricalEffectiveness('camp_mem_5', 'REFRESH_CREATIVE');
    expect(eff.lastTwoIneffective).toBe(false);
    expect(eff.lastOutcome).toBe('improved');
  });

  test('applyHistoricalLearning downgrades confidence and attaches historical_note when the rule fires', () => {
    insertOutcome('camp_mem_6', 'REFRESH_CREATIVE', 'worsened');
    insertOutcome('camp_mem_6', 'REFRESH_CREATIVE', 'no_change');

    const decisions = [{ meta_campaign_id: 'camp_mem_6', decision_type: 'REFRESH_CREATIVE', confidence: 'high' }];
    const [adjusted] = applyHistoricalLearning(decisions);

    expect(adjusted.confidence).toBe('medium'); // downgraded from high
    expect(adjusted.historical_note).toMatch(/Tried twice before/);
    expect(adjusted.historical_effectiveness.lastTwoIneffective).toBe(true);
  });

  test('applyHistoricalLearning leaves confidence unchanged and attaches effectiveness data when the rule does not fire', () => {
    const decisions = [{ meta_campaign_id: 'camp_no_history', decision_type: 'REFRESH_CREATIVE', confidence: 'high' }];
    const [adjusted] = applyHistoricalLearning(decisions);

    expect(adjusted.confidence).toBe('high');
    expect(adjusted.historical_note).toBeUndefined();
    expect(adjusted.historical_effectiveness.attempts).toBe(0);
  });

  test('applyHistoricalLearning never throws on a decision missing meta_campaign_id/decision_type', () => {
    const decisions = [{ confidence: 'high' }];
    expect(() => applyHistoricalLearning(decisions)).not.toThrow();
  });
});
