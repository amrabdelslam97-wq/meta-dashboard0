'use strict';

const { createTestDb } = require('../helpers/testDb');
const { runScoringPipeline } = require('../../src/services/intelligenceOrchestrator');

describe('intelligenceOrchestrator.runScoringPipeline optimization_goal threading', () => {
  let testDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  // Only ad sets carry a real optimization_goal today (adSetIntelligence.js
  // attaches it to the synthetic entity it builds); campaigns/ads never set
  // it, so their entity.optimization_goal is undefined and every resolver
  // call falls back to the base objective profile -- this is what proves
  // that fallback is safe and non-breaking.
  test('a campaign-shaped entity (no optimization_goal) scores against the base objective profile', () => {
    const entity = { meta_campaign_id: 'camp_orch_1', name: 'Campaign', objective: 'awareness' };
    const metrics = { reach: 20000, cpm: 5, frequency: 2, impressions: 40000 };
    const { healthResult, benchmarkResult } = runScoringPipeline(entity, metrics, null, 'acct-orch', 'campaign');
    expect(healthResult.profile_key).toBe('awareness');
    expect(Object.keys(benchmarkResult.metrics).sort()).toEqual(['cpm', 'frequency', 'impressions', 'reach']);
  });

  test('an ad-set-shaped entity with a Video Views optimization_goal activates the sub-profile end to end', () => {
    const entity = {
      meta_campaign_id: 'adset_orch_1',
      name: 'Video Ad Set',
      objective: 'awareness',
      optimization_goal: 'THRUPLAY',
    };
    const metrics = { cost_per_thruplay: 1, video_retention_rate: 50, ctr: 1, frequency: 2 };
    const { healthResult, benchmarkResult } = runScoringPipeline(entity, metrics, null, 'acct-orch', 'ad_set');
    expect(healthResult.profile_key).toBe('awareness.videoViews');
    expect(Object.keys(benchmarkResult.metrics).sort()).toEqual(['cost_per_thruplay', 'ctr', 'frequency', 'video_retention_rate']);
  });
});
