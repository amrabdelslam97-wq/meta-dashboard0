'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

describe('audienceAttributionEngine', () => {
  let testDb;
  let engine;

  beforeAll(async () => {
    testDb = await createTestDb();
    engine = require('../../src/services/audienceAttributionEngine');
  });

  afterAll(() => { testDb.cleanup(); });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM ad_sets');
    testDb.db.run('DELETE FROM audience_attribution');
  });

  describe('classifyAudienceType (pure logic)', () => {
    test('classifies advantage+ from targeting_automation.advantage_audience', () => {
      expect(engine.classifyAudienceType({ targeting_automation: { advantage_audience: 1 } })).toBe('advantage_plus');
    });

    test('classifies lookalike from lookalike_spec presence, even without resolving a custom audience subtype', () => {
      expect(engine.classifyAudienceType({ lookalike_spec: { ratio: 0.01, country: 'US' } })).toBe('lookalike');
    });

    test('classifies lookalike from a referenced custom audience whose real subtype is LOOKALIKE', () => {
      const targeting = { custom_audiences: [{ id: 'aud_1' }] };
      expect(engine.classifyAudienceType(targeting, { aud_1: 'LOOKALIKE' })).toBe('lookalike');
    });

    test('classifies remarketing from WEBSITE/ENGAGEMENT/APP custom audience subtypes', () => {
      const targeting = { custom_audiences: [{ id: 'aud_1' }] };
      expect(engine.classifyAudienceType(targeting, { aud_1: 'WEBSITE' })).toBe('remarketing');
      expect(engine.classifyAudienceType(targeting, { aud_1: 'ENGAGEMENT' })).toBe('remarketing');
      expect(engine.classifyAudienceType(targeting, { aud_1: 'APP' })).toBe('remarketing');
    });

    test('classifies custom_audience when the subtype is CUSTOM or unresolvable', () => {
      const targeting = { custom_audiences: [{ id: 'aud_1' }] };
      expect(engine.classifyAudienceType(targeting, { aud_1: 'CUSTOM' })).toBe('custom_audience');
      expect(engine.classifyAudienceType(targeting, {})).toBe('custom_audience'); // unresolved subtype
    });

    test('classifies interest from flexible_spec presence with no custom/lookalike audience', () => {
      expect(engine.classifyAudienceType({ flexible_spec: [{ interests: [{ id: '1', name: 'Fitness' }] }] })).toBe('interest');
    });

    test('classifies broad when no targeting signal is present', () => {
      expect(engine.classifyAudienceType({})).toBe('broad');
      expect(engine.classifyAudienceType(null)).toBe('unknown');
    });

    test('advantage+ takes priority even if custom_audiences/interests are also present', () => {
      const targeting = { targeting_automation: { advantage_audience: true }, flexible_spec: [{ interests: [{ id: '1' }] }] };
      expect(engine.classifyAudienceType(targeting)).toBe('advantage_plus');
    });
  });

  describe('syncAccountAudienceAttribution + getAudienceAttribution (integration)', () => {
    test('groups ad-set performance by real audience_type and persists a per-campaign snapshot', async () => {
      const accountId = uuidv4();
      testDb.db.run(
        `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, attribution_window_days, created_at, updated_at)
         VALUES (?, 'act_aud_1', 'Audience Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
        [accountId, encryptToken('fake-token')]
      );
      const campaignId = uuidv4();
      testDb.db.run(
        `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
         VALUES (?, ?, 'camp_aud_1', 'Audience Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
        [campaignId, accountId]
      );
      testDb.db.run(
        `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, audience_type, created_at, updated_at)
         VALUES (?, ?, ?, 'adset_broad', 'Broad AdSet', 'active', 'broad', datetime('now'), datetime('now'))`,
        [uuidv4(), campaignId, accountId]
      );
      testDb.db.run(
        `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, audience_type, created_at, updated_at)
         VALUES (?, ?, ?, 'adset_lookalike', 'Lookalike AdSet', 'active', 'lookalike', datetime('now'), datetime('now'))`,
        [uuidv4(), campaignId, accountId]
      );

      const range = { since: '2026-06-15', until: '2026-06-21' };
      nock(BASE).get(`/${VERSION}/camp_aud_1/insights`).query(q => q.level === 'adset').reply(200, {
        data: [
          { adset_id: 'adset_broad', spend: '100', impressions: '1000', clicks: '10', frequency: '1.5', actions: [{ action_type: 'omni_purchase', value: '5' }], action_values: [{ action_type: 'omni_purchase', value: '150' }] },
          { adset_id: 'adset_lookalike', spend: '200', impressions: '2000', clicks: '40', frequency: '2.1', actions: [{ action_type: 'omni_purchase', value: '20' }], action_values: [{ action_type: 'omni_purchase', value: '800' }] },
        ],
      });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [accountId]);
      const result = await engine.syncAccountAudienceAttribution(fullAccount, range);
      expect(result.errors).toEqual([]);
      expect(result.campaignsProcessed).toBe(1);

      const read = engine.getAudienceAttribution('camp_aud_1', range);
      expect(read.audience_types.length).toBe(2);

      const lookalike = read.audience_types.find(r => r.audience_type === 'lookalike');
      expect(lookalike.spend).toBe(200);
      expect(lookalike.roas).toBe(4); // 800/200
      expect(lookalike.contribution_pct).toBeCloseTo(66.7, 0); // 200/300

      const broad = read.audience_types.find(r => r.audience_type === 'broad');
      expect(broad.spend).toBe(100);
      expect(broad.roas).toBe(1.5); // 150/100

      expect(read.not_classifiable).toEqual(['saved_audience', 'dynamic_audience']);
    });
  });
});
