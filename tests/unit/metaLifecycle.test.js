'use strict';

const { resolveLifecycle, isDelivering, LIFECYCLE } = require('../../src/services/metaLifecycle');

describe('metaLifecycle.isDelivering', () => {
  test('ACTIVE is the only status considered delivering', () => {
    expect(isDelivering('ACTIVE')).toBe(true);
    expect(isDelivering('active')).toBe(true); // case-insensitive
  });

  test('every other documented Meta effective_status is NOT delivering', () => {
    const nonDelivering = [
      'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED',
      'IN_PROCESS', 'WITH_ISSUES', 'DISAPPROVED', 'PENDING_REVIEW',
      'PREAPPROVED', 'PENDING_BILLING_INFO', 'ACCOUNT_DISABLED',
    ];
    for (const status of nonDelivering) {
      expect(isDelivering(status)).toBe(false);
    }
  });

  test('null/undefined/empty resolves to UNKNOWN, never assumed delivering', () => {
    expect(isDelivering(null)).toBe(false);
    expect(isDelivering(undefined)).toBe(false);
    expect(isDelivering('')).toBe(false);
  });

  test('an unrecognized future Meta value is NOT assumed delivering (safe default)', () => {
    expect(isDelivering('SOME_NEW_META_STATUS_NOT_YET_MAPPED')).toBe(false);
  });
});

describe('metaLifecycle.resolveLifecycle', () => {
  test('ACTIVE has no lifecycle recommendation action (normal pipeline runs)', () => {
    const info = resolveLifecycle('ACTIVE');
    expect(info.isDelivering).toBe(true);
    expect(info.recommendationAction).toBeNull();
  });

  test.each([
    ['PAUSED', 'Resume'],
    ['CAMPAIGN_PAUSED', 'Resume'],
    ['ADSET_PAUSED', 'Resume'],
    ['ARCHIVED', 'Duplicate'],
    ['DELETED', 'No Action Required'],
    ['WITH_ISSUES', 'Review'],
    ['DISAPPROVED', 'Fix Policy'],
    ['PENDING_REVIEW', 'No Action Required'],
    ['PREAPPROVED', 'No Action Required'],
    ['PENDING_BILLING_INFO', 'Review'],
    ['ACCOUNT_DISABLED', 'Review'],
    ['IN_PROCESS', 'No Action Required'],
  ])('%s maps to lifecycle action "%s", never a performance/scale action', (status, expectedAction) => {
    const info = resolveLifecycle(status);
    expect(info.recommendationAction).toBe(expectedAction);
    // None of the lifecycle actions are performance-scaling suggestions.
    expect(info.recommendationAction).not.toMatch(/Increase Budget|Scale|Creative Refresh|Audience Expansion/i);
    expect(info.message).toEqual(expect.any(String));
    expect(info.label).toEqual(expect.any(String));
  });

  test('is case-insensitive and trims whitespace', () => {
    expect(resolveLifecycle(' paused ').code).toBe('PAUSED');
    expect(resolveLifecycle('Campaign_Paused').code).toBe('CAMPAIGN_PAUSED');
  });

  test('every LIFECYCLE entry has a label and isDelivering boolean', () => {
    for (const [code, entry] of Object.entries(LIFECYCLE)) {
      expect(entry.label).toEqual(expect.any(String));
      expect(typeof entry.isDelivering).toBe('boolean');
      if (!entry.isDelivering) {
        expect(entry.recommendationAction).toEqual(expect.any(String));
      }
    }
  });
});
