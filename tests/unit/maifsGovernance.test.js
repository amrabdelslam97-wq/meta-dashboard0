'use strict';

const {
  resolveRequiredFrameworks, runDecisionValidations, runSelfCheck, routeFailure,
  enforceGovernance,
} = require('../../src/services/maifsGovernance');

describe('maifsGovernance.resolveRequiredFrameworks (MMS.4.3)', () => {
  test('MF1 is always required, even with no signals set', () => {
    expect(resolveRequiredFrameworks({})).toEqual(['MF1']);
  });

  test('adds frameworks in MMS.4 fixed rank order, not the order signals were set', () => {
    // impliesDiagnosis and touchesCampaign are set in reverse of their rank
    // order below -- the result must still come back MF1, MF2, MF8.
    const result = resolveRequiredFrameworks({ impliesDiagnosis: true, touchesCampaign: true });
    expect(result).toEqual(['MF1', 'MF2', 'MF8']);
  });

  test('a full-signal run includes every framework in rank order, MF10 last', () => {
    const result = resolveRequiredFrameworks({
      touchesCampaign: true, touchesAdSet: true, touchesCreative: true,
      touchesAudience: true, touchesDelivery: true, impliesAction: true,
      impliesDiagnosis: true, spansMultiple: true,
    });
    expect(result).toEqual(['MF1', 'MF2', 'MF3', 'MF4', 'MF5', 'MF6', 'MF7', 'MF8', 'MF10']);
  });

  test('never includes the reserved MF9', () => {
    const result = resolveRequiredFrameworks({ impliesAction: true, impliesDiagnosis: true });
    expect(result).not.toContain('MF9');
  });
});

describe('maifsGovernance.runDecisionValidations (MMS.10)', () => {
  test('a well-formed context with no decision passes every gate', () => {
    const result = runDecisionValidations({
      objective: 'sales',
      currentMetrics: { impressions: 5000 },
      diagnosis: null,
      decision: null,
    });
    expect(result.overall).toBe('passed');
    expect(result.results.confidence.status).toBe('passed');
  });

  test('Metric Validation fails below the Data Sufficiency floor, and downstream gates are skipped (MMS.10.2)', () => {
    const result = runDecisionValidations({
      objective: 'sales',
      currentMetrics: { impressions: 10 },
      diagnosis: null,
      decision: null,
    });
    expect(result.results.metric.status).toBe('failed');
    expect(result.results.governance.status).toBe('skipped');
    expect(result.results.optimization.status).toBe('skipped');
    expect(result.results.intelligence.status).toBe('skipped');
    expect(result.results.confidence.status).toBe('skipped');
    expect(result.overall).toBe('failed');
  });

  test('Business Validation fails for an unrecognized objective', () => {
    const result = runDecisionValidations({
      objective: 'not_a_real_objective',
      currentMetrics: { impressions: 5000 },
    });
    expect(result.results.business.status).toBe('failed');
  });

  test('Framework Validation fails when the decision type does not match the diagnosed root-cause category', () => {
    const result = runDecisionValidations({
      objective: 'leads',
      currentMetrics: { impressions: 5000 },
      diagnosis: { status: 'diagnosed', category: 'audience' },
      decision: { decision_type: 'REFRESH_CREATIVE', priority: 'low', confidence: 'medium', suggested_action: 'do it' },
    });
    expect(result.results.framework.status).toBe('failed');
  });

  test('a "critical" priority decision requires at least medium confidence (final gate)', () => {
    const result = runDecisionValidations({
      objective: 'leads',
      currentMetrics: { impressions: 5000 },
      diagnosis: { status: 'diagnosed', category: 'audience' },
      decision: { decision_type: 'EXPAND_AUDIENCE', priority: 'critical', confidence: 'low', suggested_action: 'do it' },
    });
    expect(result.results.confidence.status).toBe('failed');
    expect(result.overall).toBe('failed');
  });

  test('Risk Validation fails when a decision has no suggested_action', () => {
    const result = runDecisionValidations({
      objective: 'leads',
      currentMetrics: { impressions: 5000 },
      decision: { decision_type: 'EXPAND_AUDIENCE', priority: 'low', confidence: 'medium', suggested_action: '' },
    });
    expect(result.results.risk.status).toBe('failed');
    expect(result.results.confidence.status).toBe('skipped');
  });
});

describe('maifsGovernance.routeFailure (MMS.10.3)', () => {
  test('routes each named gate to its documented failure destination', () => {
    expect(routeFailure('metric')).toBe('return_to_evidence_collection');
    expect(routeFailure('confidence')).toBe('route_to_observation_only');
  });

  test('returns null for an unknown gate name', () => {
    expect(routeFailure('not_a_gate')).toBeNull();
  });
});

describe('maifsGovernance.runSelfCheck (MMS.19)', () => {
  test('terminology and reasoning fidelity checks are reported not_applicable (no NL output exists)', () => {
    const result = runSelfCheck({ frameworksApplied: ['MF1', 'MF2'] });
    expect(result.checks.correct_terminology.status).toBe('not_applicable');
    expect(result.checks.correct_reasoning.status).toBe('not_applicable');
  });

  test('passes when frameworks are in MMS.4 rank order and MF1 is present', () => {
    const result = runSelfCheck({ frameworksApplied: ['MF1', 'MF2', 'MF7', 'MF8'] });
    expect(result.checks.correct_framework.status).toBe('passed');
    expect(result.overall).toBe('passed');
  });

  test('fails when frameworks are out of MMS.4 rank order', () => {
    const result = runSelfCheck({ frameworksApplied: ['MF1', 'MF8', 'MF2'] });
    expect(result.checks.correct_framework.status).toBe('failed');
    expect(result.overall).toBe('failed');
  });

  test('fails when MF1 is missing entirely', () => {
    const result = runSelfCheck({ frameworksApplied: ['MF2', 'MF7'] });
    expect(result.checks.correct_framework.status).toBe('failed');
  });
});

describe('maifsGovernance.enforceGovernance (MAIFS Enforcement — Phase 4)', () => {
  test('a well-formed decision passes and is returned unchanged (plus governance_state)', () => {
    const decisions = [{
      decision_type: 'EXPAND_AUDIENCE', priority: 'medium', confidence: 'medium', suggested_action: 'do it',
    }];
    const [enforced] = enforceGovernance(decisions, {
      objective: 'leads',
      currentMetrics: { impressions: 5000 },
      diagnosis: { status: 'diagnosed', category: 'audience' },
    });
    expect(enforced.governance_state).toBe('passed');
    expect(enforced.priority).toBe('medium'); // unchanged
    expect(enforced.governance_downgraded).toBeUndefined();
  });

  test('a decision that fails the Confidence gate is downgraded to observation_only -- governance changes behavior, not just a report', () => {
    const decisions = [{
      decision_type: 'EXPAND_AUDIENCE', priority: 'critical', confidence: 'low', suggested_action: 'do it',
    }];
    const [enforced] = enforceGovernance(decisions, {
      objective: 'leads',
      currentMetrics: { impressions: 5000 },
      diagnosis: { status: 'diagnosed', category: 'audience' },
    });
    expect(enforced.governance_state).toBe('failed');
    expect(enforced.priority).toBe('observation_only');
    expect(enforced.priority_score).toBe(0);
    expect(enforced.governance_downgraded).toBe(true);
  });

  test('a decision that fails a non-Confidence gate is flagged "warning" without being downgraded', () => {
    const decisions = [{
      decision_type: 'REFRESH_CREATIVE', priority: 'low', confidence: 'medium', suggested_action: 'do it',
    }];
    // Framework Validation will fail: category 'audience' expects EXPAND_AUDIENCE, not REFRESH_CREATIVE.
    const [enforced] = enforceGovernance(decisions, {
      objective: 'leads',
      currentMetrics: { impressions: 5000 },
      diagnosis: { status: 'diagnosed', category: 'audience' },
    });
    expect(enforced.governance_state).toBe('warning');
    expect(enforced.priority).toBe('low'); // unchanged -- flagged, not blocked
  });

  test('processes multiple decisions independently', () => {
    const decisions = [
      { decision_type: 'EXPAND_AUDIENCE', priority: 'critical', confidence: 'low', suggested_action: 'a' },
      { decision_type: 'EXPAND_AUDIENCE', priority: 'medium', confidence: 'high', suggested_action: 'b' },
    ];
    const enforced = enforceGovernance(decisions, {
      objective: 'leads', currentMetrics: { impressions: 5000 }, diagnosis: { status: 'diagnosed', category: 'audience' },
    });
    expect(enforced[0].governance_state).toBe('failed');
    expect(enforced[1].governance_state).toBe('passed');
  });
});
