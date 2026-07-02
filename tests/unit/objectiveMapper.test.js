'use strict';

const { mapObjective, isValidObjective } = require('../../src/services/objectiveMapper');

describe('objectiveMapper.mapObjective', () => {
  test.each([
    // Awareness
    ['OUTCOME_AWARENESS', 'awareness'],
    ['BRAND_AWARENESS', 'awareness'],
    ['REACH', 'awareness'],
    ['VIDEO_VIEWS', 'awareness'],
    ['OUTCOME_VIDEO_VIEWS', 'awareness'],
    // Traffic
    ['OUTCOME_TRAFFIC', 'traffic'],
    ['LINK_CLICKS', 'traffic'],
    // Engagement (was 'messaging' pre-taxonomy-fix)
    ['OUTCOME_ENGAGEMENT', 'engagement'],
    ['MESSAGES', 'engagement'],
    // Leads
    ['OUTCOME_LEADS', 'leads'],
    ['LEAD_GENERATION', 'leads'],
    // App Promotion (was 'unknown' pre-taxonomy-fix)
    ['OUTCOME_APP_PROMOTION', 'app_promotion'],
    ['APP_INSTALLS', 'app_promotion'],
    // Sales
    ['OUTCOME_SALES', 'sales'],
    ['CONVERSIONS', 'sales'],
    ['PRODUCT_CATALOG_SALES', 'sales'],
    // Genuinely out of scope
    ['STORE_VISITS', 'unknown'],
  ])('maps %s -> %s', (input, expected) => {
    expect(mapObjective(input)).toBe(expected);
  });

  test('is case-insensitive and trims whitespace', () => {
    expect(mapObjective('  messages  ')).toBe('engagement');
    expect(mapObjective('link_clicks')).toBe('traffic');
  });

  // Regression test for the taxonomy fix: these two raw Meta strings used
  // to incorrectly collapse into 'messaging'/'unknown' respectively,
  // hiding Engagement and App Promotion as their own distinct objectives.
  test('MESSAGES and OUTCOME_ENGAGEMENT no longer map to the old "messaging" bucket', () => {
    expect(mapObjective('MESSAGES')).not.toBe('messaging');
    expect(mapObjective('OUTCOME_ENGAGEMENT')).not.toBe('messaging');
    expect(mapObjective('MESSAGES')).toBe('engagement');
  });

  test('APP_INSTALLS and OUTCOME_APP_PROMOTION no longer map to "unknown"', () => {
    expect(mapObjective('APP_INSTALLS')).not.toBe('unknown');
    expect(mapObjective('OUTCOME_APP_PROMOTION')).not.toBe('unknown');
    expect(mapObjective('APP_INSTALLS')).toBe('app_promotion');
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
    for (const obj of ['awareness', 'traffic', 'engagement', 'leads', 'app_promotion', 'sales', 'unknown']) {
      expect(isValidObjective(obj)).toBe(true);
    }
  });

  test('rejects the old "messaging" bucket now that it has been renamed to "engagement"', () => {
    expect(isValidObjective('messaging')).toBe(false);
  });

  test('rejects raw Meta objective strings and garbage input', () => {
    expect(isValidObjective('MESSAGES')).toBe(false);
    expect(isValidObjective('not_a_real_objective')).toBe(false);
    expect(isValidObjective(null)).toBe(false);
  });
});
