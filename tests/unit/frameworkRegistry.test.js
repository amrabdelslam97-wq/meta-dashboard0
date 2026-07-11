'use strict';

const {
  FRAMEWORKS, EXECUTION_ORDER, getFramework, routeConcern,
  normalizeRootCause, getRuleProvenance,
} = require('../../src/services/frameworkRegistry');

describe('frameworkRegistry.getFramework', () => {
  test('returns Framework 1 metadata', () => {
    const mf1 = getFramework('MF1');
    expect(mf1.number).toBe(1);
    expect(mf1.name).toBe('Domain Vocabulary Framework');
  });

  test('Framework 9 is explicitly reserved, not missing', () => {
    const mf9 = getFramework('MF9');
    expect(mf9).not.toBeNull();
    expect(mf9.status).toBe('reserved');
    expect(mf9.name).toBeNull();
  });

  test('returns null for an unknown framework code', () => {
    expect(getFramework('MF99')).toBeNull();
  });

  test('every FRAMEWORKS entry 1-10 exists', () => {
    for (let i = 1; i <= 10; i++) {
      expect(FRAMEWORKS[`MF${i}`]).toBeDefined();
    }
  });
});

describe('frameworkRegistry.EXECUTION_ORDER', () => {
  test('starts with MF1 and never includes the reserved MF9', () => {
    expect(EXECUTION_ORDER[0]).toBe('MF1');
    expect(EXECUTION_ORDER).not.toContain('MF9');
  });

  test('MF10 is last (cross-framework layer consulted only after all others)', () => {
    expect(EXECUTION_ORDER[EXECUTION_ORDER.length - 1]).toBe('MF10');
  });
});

describe('frameworkRegistry.routeConcern', () => {
  test.each([
    ['creative', 'MF4'],
    ['audience', 'MF5'],
    ['delivery', 'MF6'],
    ['optimization_action', 'MF7'],
    ['diagnosis', 'MF8'],
    ['cross_account', 'MF10'],
  ])('routes %s to %s per MMS.5.1', (concern, expected) => {
    expect(routeConcern(concern)).toBe(expected);
  });

  test('returns null for an unrecognized concern', () => {
    expect(routeConcern('not_a_real_concern')).toBeNull();
  });
});

describe('frameworkRegistry.normalizeRootCause', () => {
  test('passes through a category already in the MF8.5 canonical enum', () => {
    expect(normalizeRootCause('creative')).toBe('creative');
    expect(normalizeRootCause('audience')).toBe('audience');
    expect(normalizeRootCause('competition')).toBe('competition');
  });

  test('maps diagnosisEngine-specific statuses onto the closest canonical bucket', () => {
    expect(normalizeRootCause('unexplained')).toBe('business_factor');
    expect(normalizeRootCause('unclassified')).toBe('business_factor');
  });

  test('returns null for null input (no diagnosis category)', () => {
    expect(normalizeRootCause(null)).toBeNull();
  });
});

describe('frameworkRegistry.getRuleProvenance', () => {
  test('resolves a known rule_code to its documented Framework rule', () => {
    const prov = getRuleProvenance('HIGH_FREQUENCY');
    expect(prov).not.toBeNull();
    expect(prov.framework).toBe('MF2');
    expect(prov.docRule).toMatch(/MF2\.12\.1/);
  });

  test('resolves a known opportunity type', () => {
    expect(getRuleProvenance('Ready To Scale').framework).toBe('MF7');
  });

  test('returns null for an unknown code', () => {
    expect(getRuleProvenance('NOT_A_REAL_RULE_CODE')).toBeNull();
  });
});
