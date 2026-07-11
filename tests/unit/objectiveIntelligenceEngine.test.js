'use strict';

const { createTestDb } = require('../helpers/testDb');
const { evaluateBenchmarks } = require('../../src/services/benchmarkEngine');
const {
  buildObjectiveIntelligence, mapStatusToVerdict, resolveFormulaUsed,
} = require('../../src/services/objectiveIntelligenceEngine');

describe('objectiveIntelligenceEngine.mapStatusToVerdict (pure)', () => {
  test('above/optimal -> success, below -> warning, critical -> failure, else unknown', () => {
    expect(mapStatusToVerdict('above')).toBe('success');
    expect(mapStatusToVerdict('optimal')).toBe('success');
    expect(mapStatusToVerdict('below')).toBe('warning');
    expect(mapStatusToVerdict('critical')).toBe('failure');
    expect(mapStatusToVerdict('no_data')).toBe('unknown');
    expect(mapStatusToVerdict('no_benchmark')).toBe('unknown');
    expect(mapStatusToVerdict(undefined)).toBe('unknown');
  });
});

describe('objectiveIntelligenceEngine.resolveFormulaUsed (pure)', () => {
  test('arithmetic aggregation rules are shown as-is', () => {
    expect(resolveFormulaUsed('spend/impressions*1000')).toBe('spend/impressions*1000');
    expect(resolveFormulaUsed('revenue/spend')).toBe('revenue/spend');
  });
  test('non-arithmetic aggregation rules (sum, spend_weighted_avg) fall back to an honest label', () => {
    expect(resolveFormulaUsed('sum')).toBe('Direct metric (from Meta Insights API)');
    expect(resolveFormulaUsed('spend_weighted_avg')).toBe('Direct metric (from Meta Insights API)');
  });
  test('null/undefined aggregation rule falls back to the same honest label', () => {
    expect(resolveFormulaUsed(null)).toBe('Direct metric (from Meta Insights API)');
    expect(resolveFormulaUsed(undefined)).toBe('Direct metric (from Meta Insights API)');
  });
});

describe('objectiveIntelligenceEngine.buildObjectiveIntelligence (integration, real thresholds via createTestDb seed)', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('engagement objective: exactly the 4 required KPIs (cpr, ctr, frequency, reach), each with a real threshold-derived verdict', () => {
    const objective = 'engagement';
    const currentMetrics = { cpr: 5, ctr: 0.3, frequency: 2.5, reach: 5000 };
    const benchmark = evaluateBenchmarks({ objective }, currentMetrics, 'test-account');

    const result = buildObjectiveIntelligence({
      objective, adAccountId: 'test-account', currentMetrics,
      healthScore: 60, healthStatus: 'good',
      benchmark,
    });

    expect(result.detected_objective).toBe('engagement');
    expect(result.kpis.map(k => k.metric_key).sort()).toEqual(['cpr', 'ctr', 'frequency', 'reach']);

    const cprRow = result.kpis.find(k => k.metric_key === 'cpr');
    expect(cprRow.metric_name).toBe('Cost Per Conversation');
    expect(cprRow.current_value).toBe(5);
    expect(cprRow.status).toBe('success'); // cpr<=excellent(5) -> 'above' -> success
    expect(cprRow.success_threshold).toBe(5); // excellent_threshold
    expect(cprRow.warning_threshold).toBe(30);
    expect(cprRow.failure_threshold).toBe(60);

    const ctrRow = result.kpis.find(k => k.metric_key === 'ctr');
    expect(ctrRow.status).toBe('failure'); // ctr=0.3 < critical(0.5) -> 'critical' -> failure
    expect(ctrRow.reason).toMatch(/below the benchmark target/);

    const freqRow = result.kpis.find(k => k.metric_key === 'frequency');
    expect(freqRow.status).toBe('success'); // within optimal range 1.5-3.5
  });

  test('formula_used reflects the real per-objective aggregation rule (arithmetic vs. direct metric)', () => {
    const objective = 'sales';
    const currentMetrics = { roas: 2, cpa: 60, purchases: 5, ctr: 2 };
    const benchmark = evaluateBenchmarks({ objective }, currentMetrics, 'test-account');
    const result = buildObjectiveIntelligence({ objective, adAccountId: 'test-account', currentMetrics, benchmark });

    const cpaRow = result.kpis.find(k => k.metric_key === 'cpa');
    expect(cpaRow.formula_used).toBe('spend/purchases'); // arithmetic, from kpiProfileResolver PROFILES.sales.aggregation
    const ctrRow = result.kpis.find(k => k.metric_key === 'ctr');
    expect(ctrRow.formula_used).toBe('Direct metric (from Meta Insights API)'); // aggregation rule is 'spend_weighted_avg', not arithmetic
  });

  test('root_cause and executive_interpretation pass through unchanged when supplied', () => {
    const diagnosis = { status: 'diagnosed', category: 'creative', primaryKey: 'ctr', primaryLabel: 'CTR', summary: 'CTR fell 25%.' };
    const result = buildObjectiveIntelligence({
      objective: 'traffic', adAccountId: 'test-account', currentMetrics: {},
      benchmark: { metrics: {}, summary: {} }, diagnosis, executiveSummary: 'Some summary text.',
    });
    expect(result.root_cause).toEqual({ status: 'diagnosed', category: 'creative', primary_key: 'ctr', primary_label: 'CTR', summary: 'CTR fell 25%.' });
    expect(result.executive_interpretation).toBe('Some summary text.');

    const ctrRow = result.kpis.find(k => k.metric_key === 'ctr');
    expect(ctrRow.reason).toBe('CTR fell 25%.'); // diagnosis.summary used since primaryKey matches this metric
  });

  test('related_rules cross-references a fired rule whose evidence touches this metric', () => {
    const objective = 'traffic';
    const ruleEngineFired = [{
      rule_id: 'MF7.10.10', framework: 'MF7', governance_state: 'passed',
      evidence: [{ metric: 'landing_page_views/link_clicks', operator: 'ratio_lt', threshold: 0.5, actual: 0.2 }],
    }];
    const result = buildObjectiveIntelligence({
      objective, adAccountId: 'test-account', currentMetrics: {},
      benchmark: { metrics: {}, summary: {} }, ruleEngineFired,
    });
    const lpvRow = result.kpis.find(k => k.metric_key === 'landing_page_views');
    expect(lpvRow.related_rules).toHaveLength(1);
    expect(lpvRow.related_rules[0].rule_id).toBe('MF7.10.10');
    expect(lpvRow.framework_reference).toEqual(['MF7']);
    expect(lpvRow.maifs_governance_status).toBe('passed');
  });

  test('never throws with no arguments at all', () => {
    expect(() => buildObjectiveIntelligence()).not.toThrow();
    const result = buildObjectiveIntelligence();
    expect(Array.isArray(result.kpis)).toBe(true);
  });
});
