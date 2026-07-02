'use strict';

const { VALID_OBJECTIVES, PROFILES, resolveProfile } = require('../../src/services/kpiProfileResolver');

describe('kpiProfileResolver.VALID_OBJECTIVES', () => {
  test('lists exactly the 6 real Meta objectives (no "unknown")', () => {
    expect(VALID_OBJECTIVES.sort()).toEqual(
      ['app_promotion', 'awareness', 'engagement', 'leads', 'sales', 'traffic'].sort()
    );
  });
});

describe('kpiProfileResolver.resolveProfile', () => {
  test('returns the base profile for each real objective', () => {
    for (const obj of VALID_OBJECTIVES) {
      const profile = resolveProfile(obj);
      expect(profile.primaryKPI).toBeDefined();
      expect(profile.primaryKPI.key).toBeTruthy();
      expect(Array.isArray(profile.displayMetrics)).toBe(true);
      expect(profile.displayMetrics.length).toBeGreaterThan(0);
    }
  });

  test('falls back to the unknown profile for an unrecognized objective string, without throwing', () => {
    expect(() => resolveProfile('some_garbage_value')).not.toThrow();
    const profile = resolveProfile('some_garbage_value');
    expect(profile).toEqual(PROFILES.unknown);
  });

  test('falls back to the unknown profile for null/undefined objective', () => {
    expect(resolveProfile(null)).toEqual(PROFILES.unknown);
    expect(resolveProfile(undefined)).toEqual(PROFILES.unknown);
  });

  test('awareness without a video-related optimization_goal returns the base awareness profile', () => {
    const profile = resolveProfile('awareness');
    expect(profile.primaryKPI.key).toBe('reach');
    expect(profile.isVideoViewsVariant).toBeUndefined();
  });

  test('awareness with a non-video optimization_goal (e.g. REACH) still returns the base profile', () => {
    const profile = resolveProfile('awareness', 'REACH');
    expect(profile.primaryKPI.key).toBe('reach');
    expect(profile.isVideoViewsVariant).toBeUndefined();
  });

  test.each(['THRUPLAY', 'VIDEO_VIEWS', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS', 'thruplay'])(
    'awareness with optimization_goal=%s returns the Video Views variant',
    (goal) => {
      const profile = resolveProfile('awareness', goal);
      expect(profile.isVideoViewsVariant).toBe(true);
      expect(profile.primaryKPI.key).toBe('thruplays');
      expect(profile.primaryCostKPI.key).toBe('cost_per_thruplay');
    }
  );

  test('a video optimization_goal on a non-awareness objective does not trigger the Video Views variant', () => {
    const profile = resolveProfile('sales', 'THRUPLAY');
    expect(profile.isVideoViewsVariant).toBeUndefined();
    expect(profile.primaryKPI.key).toBe('roas');
  });

  test('every profile with scoringWeights sums its weights to ~1.0 (catches an authoring typo)', () => {
    for (const [objective, profile] of Object.entries(PROFILES)) {
      if (!profile.scoringWeights || profile.scoringWeights.length === 0) continue;
      const total = profile.scoringWeights.reduce((sum, w) => sum + w.weight, 0);
      expect(Math.round(total * 100) / 100).toBeCloseTo(1.0, 2);
      // eslint-disable-next-line no-unused-expressions
      objective; // referenced for clearer failure messages via test name context
    }
    const videoWeights = PROFILES.awareness.videoViews.scoringWeights;
    // Video Views sub-profile has no seeded objective_scoring_configs rows
    // of its own (stays a display/benchmark-level distinction within
    // 'awareness' per the approved plan) -- intentionally undefined/empty.
    expect(videoWeights === undefined || videoWeights.length === 0).toBe(true);
  });

  test('app_promotion profile exists with a distinct primary KPI (was previously folded into "unknown")', () => {
    const profile = resolveProfile('app_promotion');
    expect(profile.primaryKPI.key).toBe('app_installs');
    expect(profile.primaryCostKPI.key).toBe('cpi');
  });

  test('engagement profile preserves the old "messaging" behavior under the new name', () => {
    const profile = resolveProfile('engagement');
    expect(profile.primaryKPI.key).toBe('results');
    expect(profile.primaryKPI.label).toBe('Conversations');
    expect(profile.primaryCostKPI.key).toBe('cpr');
  });
});
