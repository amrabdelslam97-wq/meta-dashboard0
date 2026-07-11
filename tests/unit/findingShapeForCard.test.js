'use strict';

const { findingShapeForCard, DECISION_LABELS } = require('../../src/services/decisionEngine');

describe('decisionEngine.findingShapeForCard (Phase X.5 — Executive Diagnosis Card)', () => {
  test('rule_engine source passes through an already-fully-shaped decision unchanged', () => {
    const ruleEngineDecision = {
      rule_id: 'MF7.10.10', framework: 'MF7', framework_name: 'Optimization Framework',
      decision_type: 'FIX_TRACKING', decision_label: DECISION_LABELS.FIX_TRACKING,
      priority: 'high', confidence: 'medium', suggested_action: 'Audit tracking.',
      category: 'tracking', evidence: [{ metric: 'landing_page_views' }],
      governance_state: 'passed',
    };
    const shape = findingShapeForCard('rule_engine', ruleEngineDecision);
    expect(shape.source).toBe('rule_engine');
    expect(shape.source_id).toBe('MF7.10.10');
    expect(shape.framework).toBe('MF7');
    expect(shape.category).toBe('tracking');
    expect(shape.governance_state).toBe('passed');
    expect(shape.evidence).toEqual([{ metric: 'landing_page_views' }]);
  });

  test('recommendation source maps rule_code -> decision_type via REC_TO_DECISION, framework/category honestly null', () => {
    const rec = {
      rule_code: 'LOW_ROAS', severity: 'critical', recommendation_body: 'Pause and review.',
      metric_key: 'roas', evidence: 0.5, threshold: 1, governance_state: 'failed',
    };
    const shape = findingShapeForCard('recommendation', rec);
    expect(shape.source).toBe('recommendation');
    expect(shape.decision_type).toBe('PAUSE_CAMPAIGN');
    expect(shape.decision_label).toBe(DECISION_LABELS.PAUSE_CAMPAIGN);
    expect(shape.priority).toBe('critical');
    expect(shape.confidence).toBe('high');
    expect(shape.suggested_action).toBe('Pause and review.');
    expect(shape.framework).toBeNull();
    expect(shape.category).toBeNull();
    expect(shape.evidence).toEqual({ metric: 'roas', actual: 0.5, threshold: 1 });
    expect(shape.governance_state).toBe('failed');
  });

  test('alert source maps alert_code -> decision_type via ALERT_TO_DECISION, framework/category honestly null', () => {
    const alert = {
      alert_code: 'CPM_SPIKE', severity: 'warning', alert_message: 'CPM spiked.',
      detected_value: 40, threshold_value: 30, governance_state: 'warning',
    };
    const shape = findingShapeForCard('alert', alert);
    expect(shape.source).toBe('alert');
    expect(shape.decision_type).toBe('REVIEW_PERFORMANCE');
    expect(shape.priority).toBe('high');
    expect(shape.confidence).toBe('medium');
    expect(shape.suggested_action).toBe('CPM spiked.');
    expect(shape.framework).toBeNull();
    expect(shape.evidence).toEqual({ detected_value: 40, threshold_value: 30 });
    expect(shape.governance_state).toBe('warning');
  });

  test('never throws on an unmapped code -- decision_type/decision_label are honestly null, not fabricated', () => {
    const rec = { rule_code: 'SOME_CUSTOM_RULE', severity: 'info', recommendation_body: 'Custom.' };
    const shape = findingShapeForCard('recommendation', rec);
    expect(shape.decision_type).toBeNull();
    expect(shape.decision_label).toBeNull();
  });
});
