'use strict';

/**
 * Characterization tests — Phase X.1 (Runtime Unification), Steps 5-6.
 *
 * Originally written against `runAdIntelligence()`'s pre-Step-6 output
 * shape (calling intelligenceOrchestrator.runScoringPipeline() directly),
 * before any test existed for this function's returned shape at all.
 * Updated after Step 6 rewired it to call mmsOrchestrator.
 * orchestrateIntelligence() instead.
 */

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');
const { runAdIntelligence } = require('../../src/services/adIntelligence');

describe('adIntelligence.runAdIntelligence — characterization', () => {
  let testDb;
  let accountId;
  let campaignId;
  let adSetId;
  let adId;
  const metaAdId = 'ad_char_1';

  beforeAll(async () => {
    testDb = await createTestDb();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_ad_char', 'Ad Characterization Test', ?, datetime('now'), datetime('now'))`,
      [accountId, encryptToken('fake-token')]
    );

    campaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_ad_char_1', 'Ad Characterization Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId]
    );

    adSetId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_ad_char_1', 'Ad Characterization Ad Set', 'active', datetime('now'), datetime('now'))`,
      [adSetId, campaignId, accountId]
    );

    adId = uuidv4();
    testDb.db.run(
      `INSERT INTO ads (id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Characterization Ad', 'active', datetime('now'), datetime('now'))`,
      [adId, adSetId, campaignId, accountId, metaAdId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('returns every pre-existing field plus the new Phase X.1 fields, and nothing else', async () => {
    const result = await runAdIntelligence(adId, { useMock: true });

    expect(result).not.toBeNull();
    expect(Object.keys(result).sort()).toEqual([
      '_governance', '_meta', 'account_name', 'ad_name', 'adset_name', 'alerts', 'benchmark',
      'campaign_name', 'creative', 'currency', 'data_freshness', 'date_range', 'deltas',
      'diagnosis', 'effective_status', 'framework_recommendations', 'health_breakdown', 'health_score',
      'health_status', 'health_trend', 'meta_ad_id', 'meta_adset_id', 'meta_campaign_id',
      'metrics', 'objective', 'prior_metrics', 'recommendations', 'rule_engine_conflicts', 'status',
    ].sort());
  });

  test('pre-existing field values are unchanged', async () => {
    const result = await runAdIntelligence(adId, { useMock: true });

    expect(result.meta_ad_id).toBe(metaAdId);
    expect(result.objective).toBe('sales');
    expect(typeof result.health_score).toBe('number');
    expect(result.creative).toEqual({ creative_id: null, thumbnail_url: null, image_url: null, preview_url: null });
    expect(result.data_freshness.source).toBe('mock');
  });

  test('Phase X.1: Diagnosis Engine and Rule Engine now run at ad grain, with grain filtering enforced', async () => {
    const result = await runAdIntelligence(adId, { useMock: true });

    expect(result.diagnosis).toBeDefined();
    expect(['diagnosed', 'insufficient_data']).toContain(result.diagnosis.status);
    // Some native rules are ad-scoped as of the Creative Intelligence Engine
    // phase (MF4.13.3/13.4/13.5/13.12/15.2/15.4), but none of their metrics
    // (video_p25_watched, post_engagements, cta_type) exist in mock ad
    // metrics or this test's creative_analytics-less fixture, so none fire.
    expect(result.framework_recommendations).toHaveLength(0);
    expect(result._governance).toBeDefined();
    expect(result._governance.frameworks.some(f => f.code === 'MF2')).toBe(false);
  });

  test('Phase X.1: does not write to rule_engine_log (persist:false at this grain)', async () => {
    await runAdIntelligence(adId, { useMock: true });
    const row = testDb.db.get(`SELECT * FROM rule_engine_log WHERE entity_meta_id = ?`, [metaAdId]);
    expect(row).toBeFalsy();
  });

  test('returns null for an unknown ad id', async () => {
    const result = await runAdIntelligence('does-not-exist', { useMock: true });
    expect(result).toBeNull();
  });

  test('Creative Intelligence Engine: MF4.13.12 (Weak CTA) fires when a synced creative_analytics row has a weak cta_type', async () => {
    testDb.db.run(
      `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, cta_type, date_since, date_until, calculated_at)
       VALUES (?, ?, ?, 'adset_ad_char_1', 'camp_ad_char_1', 'LEARN_MORE', '2026-06-01', '2026-06-07', datetime('now'))`,
      [uuidv4(), accountId, metaAdId]
    );

    const result = await runAdIntelligence(adId, { useMock: true });
    const ids = result.framework_recommendations.map(f => f.rule_id);
    expect(ids).toContain('MF4.13.12');
    const fired = result.framework_recommendations.find(f => f.rule_id === 'MF4.13.12');
    expect(fired.scope).toEqual({ campaign: false, ad_set: false, ad: true });
  });
});
