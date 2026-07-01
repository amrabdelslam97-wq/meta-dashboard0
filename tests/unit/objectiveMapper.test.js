'use strict';

const { mapObjective, isValidObjective } = require('../../src/services/objectiveMapper');

describe('objectiveMapper.mapObjective', () => {
  test.each([
    ['MESSAGES', 'messaging'],
    ['OUTCOME_ENGAGEMENT', 'messaging'],
    ['LEAD_GENERATION', 'leads'],
    ['OUTCOME_LEADS', 'leads'],
    ['CONVERSIONS', 'sales'],
    ['OUTCOME_SALES', 'sales'],
    ['PRODUCT_CATALOG_SALES', 'sales'],
    ['LINK_CLICKS', 'traffic'],
    ['OUTCOME_TRAFFIC', 'traffic'],
    ['BRAND_AWARENESS', 'awareness'],
    ['REACH', 'awareness'],
    ['VIDEO_VIEWS', 'awareness'],
    ['APP_INSTALLS', 'unknown'],
    ['STORE_VISITS', 'unknown'],
  ])('maps %s -> %s', (input, expected) => {
    expect(mapObjective(input)).toBe(expected);
  });

  test('is case-insensitive and trims whitespace', () => {
    expect(mapObjective('  messages  ')).toBe('messaging');
    expect(mapObjective('link_clicks')).toBe('traffic');
  });

  test('unrecognized objective strings map to unknown', () => {
    expect(mapObjective('SOME_FUTURE_META_OBJECTIVE')).toBe('unknown');
  });

  test('null/undefined/empty map to unknown', () => {
    expect(mapObjective(null)).toBe('unknown');
    expect(mapObjective(undefined)).toBe('unknown');
    expect(mapObjective('')).toBe('unknown');
  });
});

describe('objectiveMapper.isValidObjective', () => {
  test('accepts every internal objective enum value', () => {
    for (const obj of ['messaging', 'leads', 'sales', 'traffic', 'awareness', 'unknown']) {
      expect(isValidObjective(obj)).toBe(true);
    }
  });

  test('rejects raw Meta objective strings and garbage input', () => {
    expect(isValidObjective('MESSAGES')).toBe(false);
    expect(isValidObjective('not_a_real_objective')).toBe(false);
    expect(isValidObjective(null)).toBe(false);
  });
});
