'use strict';

const { createTestDb } = require('../helpers/testDb');
const { resolveHealthScore, scoreToStatus, normalizeMetric } = require('../../src/services/healthResolver');
const { calculateHealthScore } = require('../../src/services/healthScoreEngine');

describe('healthResolver.resolveHealthScore', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  // Same exact numeric assertions as healthScoreEngine.test.js's
  // calculateHealthScore suite -- proving the refactor (math moved here,
  // healthScoreEngine.calculateHealthScore is now a thin wrapper around
  // this function) is bit-for-bit behavior-preserving.
  test('all engagement metrics present and excellent -> perfect score, identical to calculateHealthScore', () => {
    const campaign = { meta_campaign_id: 'camp_hr_1', name: 'Test Campaign', objective: 'engagement' };
    const metrics = { cpr: 5, ctr: 3, frequency: 2.5, reach: 5000 };
    const viaResolver = resolveHealthScore(campaign, metrics, 'test-account-id');
    const viaWrapper  = calculateHealthScore(campaign, metrics, 'test-account-id');
    expect(viaResolver.health_score).toBe(100);
    expect(viaResolver.health_status).toBe('excellent');
    expect(viaResolver).toEqual(viaWrapper);
  });

  test('no scoring config for an unrecognized objective returns neutral score with profile_key set', () => {
    const campaign = { meta_campaign_id: 'camp_hr_2', name: 'Unknown Objective', objective: 'not_a_real_objective' };
    const result = resolveHealthScore(campaign, { ctr: 5 }, 'test-account-id');
    expect(result.health_score).toBe(50);
    expect(result.health_status).toBe('warning');
    expect(result.profile_key).toBe('not_a_real_objective');
  });

  test('profile_key reflects the base objective when no optimization_goal is passed', () => {
    const campaign = { meta_campaign_id: 'camp_hr_3', name: 'Awareness Campaign', objective: 'awareness' };
    const result = resolveHealthScore(campaign, { reach: 20000, cpm: 5, frequency: 2, impressions: 40000 }, 'test-account-id');
    expect(result.profile_key).toBe('awareness');
  });

  test('profile_key reflects the Video Views sub-profile when a matching optimization_goal is passed', () => {
    const campaign = { meta_campaign_id: 'camp_hr_4', name: 'Video Awareness Campaign', objective: 'awareness' };
    // Video Views has no separate scoringWeights (per the approved plan --
    // display/benchmark-level distinction only), so the health score itself
    // still comes from the base awareness scoring config, unchanged.
    const result = resolveHealthScore(campaign, { reach: 20000, cpm: 5, frequency: 2, impressions: 40000 }, 'test-account-id', 'THRUPLAY');
    expect(result.profile_key).toBe('awareness.videoViews');
  });

  test('an ad-set optimization_goal that is not a Video Views goal does not activate the sub-profile', () => {
    const campaign = { meta_campaign_id: 'camp_hr_5', name: 'Reach Awareness Campaign', objective: 'awareness' };
    const result = resolveHealthScore(campaign, { reach: 20000, cpm: 5, frequency: 2, impressions: 40000 }, 'test-account-id', 'REACH');
    expect(result.profile_key).toBe('awareness');
  });

  test('re-exports scoreToStatus and normalizeMetric identical to healthScoreEngine', () => {
    expect(scoreToStatus(90)).toBe('excellent');
    expect(normalizeMetric(5, { comparison_direction: 'lower_is_better', excellent_threshold: 5, critical_threshold: 60 })).toBe(100);
  });
});
