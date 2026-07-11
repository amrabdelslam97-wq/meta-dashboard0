'use strict';

const { buildPortfolioTrace } = require('../../src/services/mmsOrchestrator');
const { resolveRequiredFrameworks } = require('../../src/services/maifsGovernance');

describe('maifsGovernance.resolveRequiredFrameworks with spansMultiple (Phase X.4)', () => {
  test('spansMultiple alone resolves to [MF1, MF10]', () => {
    expect(resolveRequiredFrameworks({ spansMultiple: true })).toEqual(['MF1', 'MF10']);
  });

  test('spansMultiple combined with other signals still resolves MF10 last (fixed rank order)', () => {
    const order = resolveRequiredFrameworks({ spansMultiple: true, touchesCampaign: true, touchesCreative: true });
    expect(order).toEqual(['MF1', 'MF2', 'MF4', 'MF10']);
  });
});

describe('mmsOrchestrator.buildPortfolioTrace (Phase X.4 — MMS Runtime Kernel)', () => {
  test('empty decisions array still returns a valid trace (MF1 + MF2, since cross-account reads always aggregate campaign-grain rows + MF10)', () => {
    const trace = buildPortfolioTrace({ decisions: [] });
    expect(trace.execution_order).toEqual(['MF1', 'MF2', 'MF10']);
    expect(trace.evidence_count).toBe(0);
    expect(trace.governance).toBe('not_applicable');
    expect(trace.governance_reason).toMatch(/no live/i);
  });

  test('derives touchesCreative from a REFRESH_CREATIVE decision_type', () => {
    const trace = buildPortfolioTrace({ decisions: [{ decision_type: 'REFRESH_CREATIVE' }] });
    expect(trace.execution_order).toContain('MF4');
    expect(trace.execution_order).toContain('MF10');
  });

  test('derives touchesAudience from an EXPAND_AUDIENCE decision_type, and touchesCreative from a rule-engine category', () => {
    const trace = buildPortfolioTrace({
      decisions: [{ decision_type: 'EXPAND_AUDIENCE' }, { decision_type: 'FIX_TRACKING', category: 'creative' }],
    });
    expect(trace.execution_order).toContain('MF5');
    expect(trace.execution_order).toContain('MF4');
    expect(trace.evidence_count).toBe(2);
  });

  test('never calls into MAIFS enforcement/validation gates -- no governance_state is computed or overwritten', () => {
    const decisions = [{ decision_type: 'REFRESH_CREATIVE', governance_state: 'failed' }];
    const trace = buildPortfolioTrace({ decisions });
    expect(trace.governance).toBe('not_applicable');
    // The input decision's own pre-existing governance_state (computed
    // earlier, at the per-entity grain) must be untouched by this function.
    expect(decisions[0].governance_state).toBe('failed');
  });

  test('frameworks array is fully resolved (name/status), matching buildGovernanceTrace()\'s shape', () => {
    const trace = buildPortfolioTrace({ decisions: [] });
    for (const fw of trace.frameworks) {
      expect(fw).toHaveProperty('code');
      expect(fw).toHaveProperty('name');
      expect(fw).toHaveProperty('status');
    }
    expect(trace.frameworks.find(f => f.code === 'MF10')).toBeDefined();
  });
});
