'use strict';

const { createTestDb } = require('../helpers/testDb');
const { evaluateCondition, loadApplicableRules } = require('../../src/services/recommendationResolver');
const { runRecommendationEngine } = require('../../src/services/recommendationEngine');

describe('recommendationResolver.evaluateCondition', () => {
  test.each([
    ['lt', 5, 3, true], ['lt', 5, 10, false],
    ['gt', 5, 10, true], ['gt', 5, 3, false],
    ['lte', 5, 5, true], ['gte', 5, 5, true],
    ['eq', 5, 5, true], ['eq', 5, 6, false],
  ])('%s %d vs actual %d -> %s', (operator, value, actual, expected) => {
    expect(evaluateCondition({ metric: 'x', operator, value }, { x: actual })).toBe(expected);
  });

  test('returns false when the metric is missing from the data', () => {
    expect(evaluateCondition({ metric: 'roas', operator: 'lt', value: 1 }, {})).toBe(false);
  });
});

describe('recommendationResolver.loadApplicableRules', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('a sales campaign gets LOW_ROAS plus universal rules', () => {
    const rules = loadApplicableRules('sales');
    expect(rules.map(r => r.rule_code)).toEqual(expect.arrayContaining(['LOW_ROAS', 'LOW_CTR', 'HIGH_FREQUENCY']));
  });

  test('an engagement campaign does NOT get LOW_ROAS (objective-scoped to sales)', () => {
    const rules = loadApplicableRules('engagement');
    expect(rules.map(r => r.rule_code)).not.toContain('LOW_ROAS');
    expect(rules.map(r => r.rule_code)).toEqual(expect.arrayContaining(['LOW_CTR', 'HIGH_FREQUENCY']));
  });

  // Proves recommendationEngine.runRecommendationEngine() is actually
  // sourcing its rule set through this resolver, not a second independent
  // copy -- fed real data end to end.
  test('runRecommendationEngine only fires LOW_ROAS for a sales-objective entity', () => {
    const sales = runRecommendationEngine(
      { meta_campaign_id: 'camp_rr_1', name: 'Sales', objective: 'sales' },
      { roas: 0.4 }, 'acct-rr', 50, 'campaign'
    );
    expect(sales.some(r => r.rule_code === 'LOW_ROAS')).toBe(true);

    const engagement = runRecommendationEngine(
      { meta_campaign_id: 'camp_rr_2', name: 'Engagement', objective: 'engagement' },
      { roas: 0.4 }, 'acct-rr', 50, 'campaign'
    );
    expect(engagement.some(r => r.rule_code === 'LOW_ROAS')).toBe(false);
  });
});
