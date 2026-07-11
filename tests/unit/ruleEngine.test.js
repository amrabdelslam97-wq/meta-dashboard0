'use strict';

// NOTE: this file deliberately does NOT require ruleRegistrySeed.js --
// Jest gives each test file its own fresh module registry, so registering
// synthetic test-only rules here never touches (and is never touched by)
// the real Framework rules seeded in ruleRegistrySeed.js, which has its
// own dedicated test file (ruleRegistrySeed.test.js).
const {
  registerRule, listRules, getRule, listUnimplementedRules,
  evaluateCondition, executeRules, resolveConflicts,
} = require('../../src/services/ruleEngine');

describe('ruleEngine.evaluateCondition', () => {
  test('gt/lt/gte/lte/eq operate on current metric values', () => {
    const current = { frequency: 4.5 };
    expect(evaluateCondition({ metric: 'frequency', operator: 'gt', value: 4 }, current, {}).matched).toBe(true);
    expect(evaluateCondition({ metric: 'frequency', operator: 'lt', value: 4 }, current, {}).matched).toBe(false);
    expect(evaluateCondition({ metric: 'frequency', operator: 'eq', value: 4.5 }, current, {}).matched).toBe(true);
  });

  test('delta_gt/delta_lt operate on deltas[metric].delta_pct', () => {
    const deltas = { ctr: { delta_pct: -20 } };
    expect(evaluateCondition({ metric: 'ctr', operator: 'delta_lt', value: -10 }, {}, deltas).matched).toBe(true);
    expect(evaluateCondition({ metric: 'ctr', operator: 'delta_gt', value: -10 }, {}, deltas).matched).toBe(false);
  });

  test('flat checks |delta_pct| within a band', () => {
    const deltas = { reach: { delta_pct: 2 } };
    expect(evaluateCondition({ metric: 'reach', operator: 'flat', band: 5 }, {}, deltas).matched).toBe(true);
    expect(evaluateCondition({ metric: 'reach', operator: 'flat', band: 1 }, {}, deltas).matched).toBe(false);
  });

  test('in_set/not_in_set check categorical membership against current[metric]', () => {
    const current = { cta_type: 'LEARN_MORE' };
    expect(evaluateCondition({ metric: 'cta_type', operator: 'in_set', value: ['LEARN_MORE', 'SEE_MORE'] }, current, {}).matched).toBe(true);
    expect(evaluateCondition({ metric: 'cta_type', operator: 'in_set', value: ['SHOP_NOW'] }, current, {}).matched).toBe(false);
    expect(evaluateCondition({ metric: 'cta_type', operator: 'not_in_set', value: ['SHOP_NOW'] }, current, {}).matched).toBe(true);
    expect(evaluateCondition({ metric: 'cta_type', operator: 'in_set', value: new Set(['LEARN_MORE']) }, current, {}).matched).toBe(true);
    expect(evaluateCondition({ metric: 'cta_type', operator: 'in_set', value: ['X'] }, {}, {}).matched).toBe(false);
  });

  test('ratio_lt/ratio_gt compare two current metric values', () => {
    const current = { video_p25_watched: 1000, video_p50_watched: 400 };
    const r = evaluateCondition({ metricA: 'video_p50_watched', metricB: 'video_p25_watched', operator: 'ratio_lt', value: 0.5 }, current, {});
    expect(r.matched).toBe(true);
    expect(r.evidence).toBeCloseTo(0.4);
  });

  test('returns matched:false (never throws) when the referenced metric is missing', () => {
    expect(evaluateCondition({ metric: 'roas', operator: 'gt', value: 1 }, {}, {}).matched).toBe(false);
    expect(evaluateCondition({ metric: 'roas', operator: 'delta_gt', value: 1 }, {}, {}).matched).toBe(false);
    expect(evaluateCondition({ metricA: 'a', metricB: 'b', operator: 'ratio_lt', value: 1 }, {}, {}).matched).toBe(false);
  });
});

describe('ruleEngine registry + execution (synthetic test-only rules)', () => {
  beforeAll(() => {
    registerRule({
      id: 'TEST-1', framework: 'TEST', name: 'High Frequency Test Rule', version: 1,
      sourceType: 'rule_engine_native', implementable: true,
      category: 'audience', severity: 'warning',
      conditions: [{ metric: 'frequency', operator: 'gt', value: 4 }],
      reason: 'test reason', action: { type: 'EXPAND_AUDIENCE' },
      provenance: { docRule: 'TEST-1' },
    });
    registerRule({
      id: 'TEST-2', framework: 'TEST', name: 'Objective-Scoped Test Rule', version: 1,
      sourceType: 'rule_engine_native', implementable: true,
      category: 'creative', severity: 'info',
      conditions: [{ metric: 'ctr', operator: 'lt', value: 1 }],
      reason: 'scoped test reason', action: { type: 'REFRESH_CREATIVE' },
      provenance: { docRule: 'TEST-2' },
      appliesToObjectives: ['sales'],
    });
    registerRule({
      id: 'TEST-NOT-IMPL', framework: 'TEST', name: 'Not Implementable Test Rule', version: 1,
      sourceType: 'rule_engine_native', implementable: false,
      notImplementableReason: 'needs data this system does not have',
      provenance: { docRule: 'TEST-NOT-IMPL' },
    });
    registerRule({
      id: 'TEST-ATTRIBUTED', framework: 'TEST', name: 'Attributed Test Rule', version: 1,
      sourceType: 'existing_diagnosis_cascade', implementable: null,
      attribution: 'diagnosisEngine.js', provenance: { docRule: 'TEST-ATTRIBUTED' },
    });
  });

  test('getRule/listRules find registered rules by id/framework/sourceType', () => {
    expect(getRule('TEST-1').name).toBe('High Frequency Test Rule');
    expect(getRule('NOPE')).toBeNull();
    expect(listRules({ framework: 'TEST' }).length).toBe(4);
    expect(listRules({ framework: 'TEST', sourceType: 'rule_engine_native', implementable: true }).length).toBe(2);
  });

  test('listUnimplementedRules includes only implementable:false, never attributed (null) rules', () => {
    const unimpl = listUnimplementedRules().filter(r => r.framework === 'TEST');
    expect(unimpl.map(r => r.id)).toEqual(['TEST-NOT-IMPL']);
  });

  test('executeRules fires a rule whose conditions match', () => {
    const result = executeRules({ current: { frequency: 5 }, deltas: {}, objective: 'leads', framework: 'TEST' });
    expect(result.fired.map(f => f.rule_id)).toContain('TEST-1');
    const fired = result.fired.find(f => f.rule_id === 'TEST-1');
    expect(fired.framework).toBe('TEST');
    expect(fired.category).toBe('audience');
    expect(fired.action.type).toBe('EXPAND_AUDIENCE');
    expect(fired.evidence[0]).toMatchObject({ metric: 'frequency', operator: 'gt', threshold: 4, actual: 5 });
  });

  test('does not fire when conditions are not met', () => {
    const result = executeRules({ current: { frequency: 1 }, deltas: {}, objective: 'leads', framework: 'TEST' });
    expect(result.fired.map(f => f.rule_id)).not.toContain('TEST-1');
    expect(result.skipped.some(s => s.rule_id === 'TEST-1')).toBe(true);
  });

  test('objective-aware gating: a rule scoped to "sales" does not fire for other objectives', () => {
    const forLeads = executeRules({ current: { ctr: 0.5 }, deltas: {}, objective: 'leads', framework: 'TEST' });
    expect(forLeads.fired.map(f => f.rule_id)).not.toContain('TEST-2');
    expect(forLeads.skipped.find(s => s.rule_id === 'TEST-2').reason).toMatch(/does not apply to objective/);

    const forSales = executeRules({ current: { ctr: 0.5 }, deltas: {}, objective: 'sales', framework: 'TEST' });
    expect(forSales.fired.map(f => f.rule_id)).toContain('TEST-2');
  });

  test('never evaluates implementable:false or attributed (non-native) rules', () => {
    // Conditions that would trivially "match" if evaluated (no conditions
    // array at all) -- if the engine tried to evaluate these it would
    // either throw or fire incorrectly; it must skip them entirely.
    const result = executeRules({ current: { frequency: 100, ctr: 0.1 }, deltas: {}, objective: 'sales', framework: 'TEST' });
    expect(result.fired.map(f => f.rule_id)).not.toContain('TEST-NOT-IMPL');
    expect(result.fired.map(f => f.rule_id)).not.toContain('TEST-ATTRIBUTED');
  });

  test('grain filtering (Phase X.1): omitting entityType defaults to "campaign" -- unchanged behavior for every existing caller', () => {
    const result = executeRules({ current: { frequency: 5 }, deltas: {}, objective: 'leads', framework: 'TEST' });
    expect(result.fired.map(f => f.rule_id)).toContain('TEST-1'); // TEST-1 has no explicit scope -> defaults to campaign:true
  });

  test('grain filtering (Phase X.1): a rule with no scope field is treated as campaign-only and is skipped at ad_set/ad grain', () => {
    const adSetResult = executeRules({ current: { frequency: 5 }, deltas: {}, objective: 'leads', framework: 'TEST', entityType: 'ad_set' });
    expect(adSetResult.fired.map(f => f.rule_id)).not.toContain('TEST-1');
    expect(adSetResult.skipped.find(s => s.rule_id === 'TEST-1').reason).toMatch(/scope excludes entityType "ad_set"/);

    const adResult = executeRules({ current: { frequency: 5 }, deltas: {}, objective: 'leads', framework: 'TEST', entityType: 'ad' });
    expect(adResult.fired.map(f => f.rule_id)).not.toContain('TEST-1');
  });

  test('grain filtering (Phase X.1): a rule explicitly scoped to ad_set fires only at ad_set grain', () => {
    registerRule({
      id: 'TEST-ADSET-SCOPED', framework: 'TEST', name: 'Ad Set Scoped Test Rule', version: 1,
      sourceType: 'rule_engine_native', implementable: true,
      category: 'audience', severity: 'warning',
      conditions: [{ metric: 'frequency', operator: 'gt', value: 4 }],
      reason: 'test', action: { type: 'EXPAND_AUDIENCE' }, provenance: { docRule: 'TEST-ADSET-SCOPED' },
      scope: { campaign: false, ad_set: true, ad: false },
    });

    const campaignResult = executeRules({ current: { frequency: 5 }, deltas: {}, objective: 'leads', framework: 'TEST', entityType: 'campaign' });
    expect(campaignResult.fired.map(f => f.rule_id)).not.toContain('TEST-ADSET-SCOPED');

    const adSetResult = executeRules({ current: { frequency: 5 }, deltas: {}, objective: 'leads', framework: 'TEST', entityType: 'ad_set' });
    expect(adSetResult.fired.map(f => f.rule_id)).toContain('TEST-ADSET-SCOPED');
  });
});

describe('ruleEngine.resolveConflicts', () => {
  test('suppresses the lower-severity rule when two fired rules recommend mutually exclusive actions', () => {
    const fired = [
      { rule: { id: 'A', severity: 'warning', action: { type: 'SCALE_CAMPAIGN' } } },
      { rule: { id: 'B', severity: 'critical', action: { type: 'PAUSE_CAMPAIGN' } } },
    ];
    const { kept, conflicts } = resolveConflicts(fired);
    expect(kept.map(k => k.rule.id)).toEqual(['B']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].suppressed_rule_id).toBe('A');
    expect(conflicts[0].kept_rule_id).toBe('B');
  });

  test('keeps both fired rules when their actions are not mutually exclusive', () => {
    const fired = [
      { rule: { id: 'A', severity: 'warning', action: { type: 'EXPAND_AUDIENCE' } } },
      { rule: { id: 'B', severity: 'warning', action: { type: 'REFRESH_CREATIVE' } } },
    ];
    const { kept, conflicts } = resolveConflicts(fired);
    expect(kept).toHaveLength(2);
    expect(conflicts).toHaveLength(0);
  });
});
