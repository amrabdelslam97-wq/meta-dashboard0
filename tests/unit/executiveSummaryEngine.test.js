'use strict';

const { buildExecutiveSummary } = require('../../src/services/executiveSummaryEngine');

describe('executiveSummaryEngine.buildExecutiveSummary', () => {
  test('summarizes a healthy campaign with no findings', () => {
    const summary = buildExecutiveSummary({
      objective: 'sales', healthScore: 92, healthStatus: 'excellent',
      diagnosis: { status: 'diagnosed', primaryLabel: 'ROAS', primaryDelta: { delta_pct: 5 }, category: null, summary: 'ROAS did not move unfavorably.' },
    });
    expect(summary).toMatch(/sales campaign is currently excellent \(92\/100\)/);
    expect(summary).toMatch(/ROAS has increased 5%/);
    expect(summary).toMatch(/No active Decision, Recommendation, or Alert/);
  });

  test('summarizes a declining campaign with a diagnosed root cause and a top decision', () => {
    const summary = buildExecutiveSummary({
      objective: 'traffic', healthScore: 35, healthStatus: 'critical',
      diagnosis: { status: 'diagnosed', primaryLabel: 'Landing Page Views', primaryDelta: { delta_pct: -40 }, category: 'creative' },
      ruleEngineDecisions: [
        { suggested_action: 'Refresh creative.', priority: 'high', confidence: 'medium', priority_score: 70 },
        { suggested_action: 'Audit tracking.', priority: 'medium', confidence: 'low', priority_score: 30 },
      ],
      recommendations: [{}],
      alerts: [{}, {}],
    });
    expect(summary).toMatch(/traffic campaign is currently critical \(35\/100\)/);
    expect(summary).toMatch(/Landing Page Views has decreased 40%/);
    expect(summary).toMatch(/Root cause: creative/);
    expect(summary).toMatch(/Top priority action: Refresh creative\. \(high priority, medium confidence\)/);
    expect(summary).toMatch(/5 active finding\(s\) — 2 rule-based, 1 recommendation\(s\), 2 alert\(s\)/);
  });

  test('handles insufficient_data diagnosis honestly, without fabricating a root cause', () => {
    const summary = buildExecutiveSummary({
      objective: 'leads', healthScore: null, healthStatus: null,
      diagnosis: { status: 'insufficient_data' },
    });
    expect(summary).toMatch(/unscored \(no score yet\)/);
    expect(summary).toMatch(/Not enough traffic yet to diagnose/);
  });

  test('never throws with no arguments at all', () => {
    expect(() => buildExecutiveSummary()).not.toThrow();
    expect(buildExecutiveSummary()).toMatch(/This campaign is currently unscored/);
  });

  test('falls back to diagnosis.summary when category is unexplained/unclassified (never fabricates a root cause label)', () => {
    const summary = buildExecutiveSummary({
      objective: 'sales', healthScore: 50, healthStatus: 'warning',
      diagnosis: { status: 'diagnosed', primaryLabel: 'ROAS', primaryDelta: { delta_pct: -20 }, category: 'unexplained', summary: 'ROAS fell 20%, but no matching cause pattern was found.' },
    });
    expect(summary).not.toMatch(/Root cause: unexplained/);
    expect(summary).toMatch(/ROAS fell 20%, but no matching cause pattern was found\./);
  });
});
