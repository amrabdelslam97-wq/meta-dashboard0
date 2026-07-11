'use strict';

/**
 * Characterization tests — Phase X.1 (Runtime Unification), Steps 5-6.
 *
 * Originally written against `runAdSetIntelligence()`'s pre-Step-6 output
 * shape (calling intelligenceOrchestrator.runScoringPipeline() directly),
 * before any test existed for this function's returned shape at all.
 * Updated after Step 6 rewired it to call mmsOrchestrator.
 * orchestrateIntelligence() instead -- every pre-existing field's presence
 * and meaning is asserted unchanged; the new Diagnosis/Rule Engine/
 * Governance fields (never present before Step 6) are asserted present.
 */

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');
const { runAdSetIntelligence } = require('../../src/services/adSetIntelligence');

describe('adSetIntelligence.runAdSetIntelligence — characterization', () => {
  let testDb;
  let accountId;
  let campaignId;
  let adSetId;
  const metaAdsetId = 'adset_char_1';

  beforeAll(async () => {
    testDb = await createTestDb();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_adset_char', 'Ad Set Characterization Test', ?, datetime('now'), datetime('now'))`,
      [accountId, encryptToken('fake-token')]
    );

    campaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_char_1', 'Characterization Campaign', 'leads', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId]
    );

    adSetId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Characterization Ad Set', 'active', datetime('now'), datetime('now'))`,
      [adSetId, campaignId, accountId, metaAdsetId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('returns every pre-existing field plus the new Phase X.1 fields, and nothing else', async () => {
    const result = await runAdSetIntelligence(adSetId, { useMock: true });

    expect(result).not.toBeNull();
    expect(Object.keys(result).sort()).toEqual([
      '_governance', '_meta', 'account_name', 'adset_name', 'alerts', 'benchmark',
      'campaign_name', 'currency', 'data_freshness', 'date_range', 'deltas', 'diagnosis',
      'effective_status', 'framework_recommendations', 'health_breakdown', 'health_score', 'health_status',
      'health_trend', 'meta_adset_id', 'meta_campaign_id', 'metrics', 'objective',
      'prior_metrics', 'recommendations', 'rule_engine_conflicts', 'status',
    ].sort());
  });

  test('pre-existing field values are unchanged (health_score is a number, objective matches parent campaign)', async () => {
    const result = await runAdSetIntelligence(adSetId, { useMock: true });

    expect(result.meta_adset_id).toBe(metaAdsetId);
    expect(result.objective).toBe('leads');
    expect(typeof result.health_score).toBe('number');
    expect(['excellent', 'good', 'warning', 'critical']).toContain(result.health_status);
    expect(result.data_freshness.source).toBe('mock');
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(Array.isArray(result.alerts)).toBe(true);
    expect(result.benchmark).toHaveProperty('summary');
    expect(result.benchmark).toHaveProperty('metrics');
  });

  test('Phase X.1: Diagnosis Engine and Rule Engine now run at ad_set grain, with grain filtering enforced', async () => {
    const result = await runAdSetIntelligence(adSetId, { useMock: true });

    expect(result.diagnosis).toBeDefined();
    expect(['diagnosed', 'insufficient_data']).toContain(result.diagnosis.status);
    expect(Array.isArray(result.framework_recommendations)).toBe(true);
    // Every currently-registered native rule is campaign-scoped -- none
    // should fire at ad_set grain (proves grain filtering, not just that
    // no rule's conditions happened to match).
    expect(result.framework_recommendations).toHaveLength(0);
    expect(result._governance).toBeDefined();
    expect(result._governance.execution_order[0]).toBe('MF1');
    expect(result._governance.frameworks.some(f => f.code === 'MF2')).toBe(false); // touchesCampaign is false at ad_set grain
  });

  test('Phase X.1: does not write to rule_engine_log (persist:false at this grain)', async () => {
    await runAdSetIntelligence(adSetId, { useMock: true });
    const row = testDb.db.get(`SELECT * FROM rule_engine_log WHERE entity_meta_id = ?`, [metaAdsetId]);
    expect(row).toBeFalsy();
  });

  test('returns null for an unknown ad set id', async () => {
    const result = await runAdSetIntelligence('does-not-exist', { useMock: true });
    expect(result).toBeNull();
  });
});
