'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');

describe('placementAttributionEngine', () => {
  let testDb, engine, accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    engine = require('../../src/services/placementAttributionEngine');
  });

  afterAll(() => { testDb.cleanup(); });

  beforeEach(() => {
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, ?, 'Placement Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId, `act_${accountId.slice(0, 8)}`]
    );
  });

  afterEach(() => {
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM analytics_breakdown_history');
  });

  const range = { since: '2026-06-15', until: '2026-06-21' };

  function insertRow(breakdownType, value, spend, results, roas = null) {
    testDb.db.run(
      `INSERT INTO analytics_breakdown_history (id, ad_account_id, entity_type, entity_meta_id, breakdown_type, breakdown_value, date_since, date_until, spend, impressions, reach, clicks, ctr, cpm, cpc, frequency, results, cost_per_result, actions_json, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_place_1', ?, ?, ?, ?, ?, 1000, 500, 10, 1, 10, 1, 2, ?, ?, ?, datetime('now'))`,
      [uuidv4(), accountId, breakdownType, value, range.since, range.until, spend, results, results > 0 ? spend / results : null, JSON.stringify({ roas, leads: null, purchases: null })]
    );
  }

  describe('getPlacementAttribution (Step 3)', () => {
    test('enriches placement rows with ROAS (decoded from actions_json), quality_score, and contribution_pct/budget_pct that sum to 100', () => {
      insertRow('placement', 'facebook / feed', 100, 20, 3.5); // efficient: 0.2 results/$
      insertRow('placement', 'audience_network / classic', 100, 2, 0.5); // inefficient: 0.02 results/$

      const result = engine.getPlacementAttribution('camp_place_1', range);
      expect(result.current.length).toBe(2);

      const feed = result.current.find(r => r.breakdown_value === 'facebook / feed');
      expect(feed.roas).toBe(3.5);
      expect(feed.quality_score).toBeGreaterThan(50);
      expect(feed.recommendation).toMatch(/Scale|Maintain/);

      const audienceNetwork = result.current.find(r => r.breakdown_value === 'audience_network / classic');
      expect(audienceNetwork.quality_score).toBeLessThan(50);

      const totalContribution = result.current.reduce((s, r) => s + r.contribution_pct, 0);
      expect(Math.round(totalContribution)).toBe(100);
      // budget_pct is identical to contribution_pct -- no per-placement
      // budget concept exists in Meta, this is documented, not a bug.
      expect(feed.budget_pct).toBe(feed.contribution_pct);
    });
  });

  describe('getGeographicAttribution (Step 8)', () => {
    test('defaults to country level and documents unavailable deeper levels honestly', () => {
      insertRow('country', 'US', 100, 10);
      const result = engine.getGeographicAttribution('camp_place_1', 'country', range);
      expect(result.level).toBe('country');
      expect(result.current[0].breakdown_value).toBe('US');
      expect(result.not_available_levels).toEqual(['city', 'district', 'neighborhood', 'zip']);
      expect(result.not_available_reason).toMatch(/city\/district\/neighborhood\/zip/);
    });

    test('supports region and dma, falling back to country for an unrecognized level', () => {
      insertRow('region', 'Cairo Governorate', 50, 5);
      const region = engine.getGeographicAttribution('camp_place_1', 'region', range);
      expect(region.level).toBe('region');
      expect(region.current[0].breakdown_value).toBe('Cairo Governorate');

      const fallback = engine.getGeographicAttribution('camp_place_1', 'not_a_real_level', range);
      expect(fallback.level).toBe('country');
    });
  });

  describe('getDeviceAttribution (Step 10)', () => {
    test('reads impression_device by default and device_platform when requested', () => {
      insertRow('impression_device', 'android_smartphone', 100, 10);
      insertRow('device_platform', 'mobile', 100, 10);

      const device = engine.getDeviceAttribution('camp_place_1', undefined, range);
      expect(device.current[0].breakdown_value).toBe('android_smartphone');

      const platform = engine.getDeviceAttribution('camp_place_1', 'device_platform', range);
      expect(platform.current[0].breakdown_value).toBe('mobile');
    });
  });

  test('recommends "Reduce budget" for a high-spend-share, low-quality dimension value', () => {
    insertRow('placement', 'expensive_low_quality', 500, 2); // huge spend share, terrible efficiency
    insertRow('placement', 'small_share', 10, 5);
    const result = engine.getPlacementAttribution('camp_place_1', range);
    const bad = result.current.find(r => r.breakdown_value === 'expensive_low_quality');
    expect(bad.recommendation).toMatch(/Reduce budget/);
  });
});
