'use strict';

const { compare, pctChange } = require('../../src/services/conditionComparator');

describe('conditionComparator.compare', () => {
  test('gt/gte/lt/lte/eq operate as expected', () => {
    expect(compare(4.5, 'gt', 4)).toBe(true);
    expect(compare(4.5, 'lt', 4)).toBe(false);
    expect(compare(4, 'gte', 4)).toBe(true);
    expect(compare(4, 'lte', 4)).toBe(true);
    expect(compare(4.5, 'eq', 4.5)).toBe(true);
  });

  test('returns false (never throws) for null/undefined actual or threshold', () => {
    expect(compare(null, 'gt', 4)).toBe(false);
    expect(compare(undefined, 'gt', 4)).toBe(false);
    expect(compare(4, 'gt', null)).toBe(false);
  });

  test('returns false for a non-numeric actual value', () => {
    expect(compare('not-a-number', 'gt', 4)).toBe(false);
  });

  test('returns false for an unknown operator', () => {
    expect(compare(4.5, 'between', 4)).toBe(false);
  });

  test('accepts string-numeric actual values (matches DB row shape)', () => {
    expect(compare('4.5', 'gt', 4)).toBe(true);
  });
});

describe('conditionComparator.pctChange', () => {
  test('default (abs) denominator matches diagnosisEngine.conversionRateFalling\'s pre-existing formula', () => {
    // ((cur - prior) / Math.abs(prior)) * 100
    expect(pctChange(8, 10)).toBeCloseTo(-20);
    expect(pctChange(8, -10, { denominator: 'abs' })).toBeCloseTo(180);
  });

  test('raw denominator matches alertEngine.evaluateAlertRule\'s pre-existing formula', () => {
    // ((current - prior) / prior) * 100
    expect(pctChange(13, 10, { denominator: 'raw' })).toBeCloseTo(30);
    expect(pctChange(8, -10, { denominator: 'raw' })).toBeCloseTo(-180); // same sign here; divergence only shows for negative prior
  });

  test('abs vs raw diverge only when prior is negative', () => {
    // prior = -10, current = -8: raw => ((-8)-(-10))/-10*100 = -20; abs => ((-8)-(-10))/10*100 = 20
    expect(pctChange(-8, -10, { denominator: 'raw' })).toBeCloseTo(-20);
    expect(pctChange(-8, -10, { denominator: 'abs' })).toBeCloseTo(20);
  });

  test('returns null for null/undefined/zero-prior inputs', () => {
    expect(pctChange(null, 10)).toBeNull();
    expect(pctChange(10, null)).toBeNull();
    expect(pctChange(10, 0)).toBeNull();
  });
});
