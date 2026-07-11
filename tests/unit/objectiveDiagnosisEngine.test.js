'use strict';

const { enrichKpiWithDiagnosis, enrichObjectiveIntelligence, OBJECTIVE_RECOMMENDATION_FOCUS } = require('../../src/services/objectiveDiagnosisEngine');

function baseKpi(overrides = {}) {
  return {
    metric_key: 'ctr', metric_name: 'CTR', current_value: 1.2, formula_used: 'Direct metric (from Meta Insights API)',
    calculated_result: 1.2, benchmark: 2, success_threshold: 3, warning_threshold: 1, failure_threshold: 0.5,
    status: 'warning', reason: '40% below the benchmark target.', related_rules: [], framework_reference: [],
    maifs_governance_status: 'not_applicable',
    ...overrides,
  };
}

describe('objectiveDiagnosisEngine.enrichKpiWithDiagnosis', () => {
  test('a success-status KPI gets positive, honest defaults -- no fabricated root cause', () => {
    const kpi = baseKpi({ status: 'success' });
    const enriched = enrichKpiWithDiagnosis(kpi, { objective: 'traffic' });
    expect(enriched.root_cause).toBeNull();
    expect(enriched.business_impact).toMatch(/Contributing positively/);
    expect(enriched.executive_recommendation).toMatch(/No action needed/);
    expect(enriched.severity).toBe('none');
    expect(enriched.confidence).toBe('high');
    // Pre-existing fields from objectiveIntelligenceEngine must be untouched.
    expect(enriched.metric_key).toBe('ctr');
    expect(enriched.benchmark).toBe(2);
  });

  test('the objective\'s PRIMARY KPI reuses diagnosisEngine\'s own summary/confidence/priority directly', () => {
    const kpi = baseKpi({ metric_key: 'landing_page_views', metric_name: 'Landing Page Views', status: 'failure' });
    const diagnosis = {
      status: 'diagnosed', primaryKey: 'landing_page_views', category: 'creative',
      confidence: 'high', priority: 'critical', summary: 'Landing Page Views fell 40%, likely due to creative fatigue.',
      factors: [{ key: 'ctr_falling', category: 'creative', detail: 'Click-through rate fell, suggesting creative fatigue.' }],
    };
    const enriched = enrichKpiWithDiagnosis(kpi, { objective: 'traffic', diagnosis });
    expect(enriched.root_cause).toBe('Landing Page Views fell 40%, likely due to creative fatigue.');
    expect(enriched.confidence).toBe('high');
    expect(enriched.severity).toBe('critical');
    expect(enriched.evidence.factors).toHaveLength(1);
  });

  test('a NON-primary KPI matched to a diagnosis factor reuses that factor\'s detail verbatim', () => {
    const kpi = baseKpi({ metric_key: 'cpm', metric_name: 'CPM', status: 'warning' });
    const diagnosis = {
      status: 'diagnosed', primaryKey: 'landing_page_views', category: 'competition',
      confidence: 'medium', priority: 'high', summary: 'LPV fell because of rising competition.',
      factors: [{ key: 'cpm_rising', category: 'competition', detail: 'Cost per 1,000 impressions (CPM) rose, indicating increased auction competition.' }],
    };
    const enriched = enrichKpiWithDiagnosis(kpi, { objective: 'traffic', diagnosis });
    expect(enriched.root_cause).toBe('Cost per 1,000 impressions (CPM) rose, indicating increased auction competition.');
    expect(enriched.confidence).toBe('medium');
    expect(enriched.severity).toBe('high');
  });

  test('a NON-primary KPI matched to a fired rule-engine decision reuses its real suggested_action/confidence', () => {
    const kpi = baseKpi({
      metric_key: 'landing_page_views', metric_name: 'Landing Page Views', status: 'failure',
      related_rules: [{ rule_id: 'MF7.10.10', framework: 'MF7', governance_state: 'passed', source: 'rule_engine' }],
    });
    const ruleEngineDecisions = [{
      rule_id: 'MF7.10.10', decision_type: 'FIX_TRACKING', decision_label: 'Fix Tracking',
      priority: 'medium', confidence: 'medium', suggested_action: 'Audit the conversion events and pixel setup.',
      framework: 'MF7', framework_name: 'Optimization Framework', category: 'tracking',
      evidence: [{ metric: 'landing_page_views/link_clicks', operator: 'ratio_lt', threshold: 0.5, actual: 0.2 }],
      governance_state: 'passed',
    }];
    const enriched = enrichKpiWithDiagnosis(kpi, { objective: 'traffic', diagnosis: null, ruleEngineDecisions });
    expect(enriched.executive_recommendation).toBe('Audit the conversion events and pixel setup.');
    expect(enriched.confidence).toBe('medium');
    expect(enriched.severity).toBe('medium');
    expect(enriched.evidence).toEqual([{ metric: 'landing_page_views/link_clicks', operator: 'ratio_lt', threshold: 0.5, actual: 0.2 }]);
  });

  test('a KPI with no diagnosis/rule match falls back to an honest, metric-type-based template (never fabricates specifics)', () => {
    const kpi = baseKpi({ metric_key: 'cpa', metric_name: 'Cost Per Purchase', status: 'warning' });
    const enriched = enrichKpiWithDiagnosis(kpi, { objective: 'sales' });
    expect(enriched.root_cause).toMatch(/Cost Per Purchase is worse than expected/);
    expect(enriched.business_impact).toMatch(/Increases cost per outcome/);
    expect(enriched.executive_recommendation).toMatch(/checkout \/ ROAS optimization/);
    expect(enriched.confidence).toBe('medium');
    expect(enriched.severity).toBe('medium'); // status: warning
  });

  test.each(Object.entries(OBJECTIVE_RECOMMENDATION_FOCUS))('objective "%s" recommendation fallback mentions "%s"', (objective, focus) => {
    const kpi = baseKpi({ status: 'failure' });
    const enriched = enrichKpiWithDiagnosis(kpi, { objective });
    expect(enriched.executive_recommendation).toContain(focus);
  });

  test('never throws with minimal/missing context', () => {
    expect(() => enrichKpiWithDiagnosis(baseKpi())).not.toThrow();
    expect(() => enrichKpiWithDiagnosis(baseKpi({ status: 'failure' }), {})).not.toThrow();
  });
});

describe('objectiveDiagnosisEngine.enrichObjectiveIntelligence', () => {
  test('enriches every KPI without touching top-level fields', () => {
    const oi = {
      detected_objective: 'traffic', objective_health: 'good', objective_health_score: 68,
      kpis: [baseKpi(), baseKpi({ metric_key: 'cpc', status: 'success' })],
      root_cause: { status: 'diagnosed', category: 'creative' },
      executive_interpretation: 'Some summary.',
    };
    const enriched = enrichObjectiveIntelligence(oi, { objective: 'traffic' });
    expect(enriched.detected_objective).toBe('traffic');
    expect(enriched.executive_interpretation).toBe('Some summary.');
    expect(enriched.kpis).toHaveLength(2);
    expect(enriched.kpis[0]).toHaveProperty('root_cause');
    expect(enriched.kpis[1].business_impact).toMatch(/Contributing positively/);
  });

  test('returns falsy input unchanged', () => {
    expect(enrichObjectiveIntelligence(null, {})).toBeNull();
  });
});
