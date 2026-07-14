'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

function insertAccount(testDb, overrides = {}) {
  const id = uuidv4();
  const metaId = overrides.meta_account_id || `act_journey_${id.slice(0, 8)}`;
  testDb.db.run(
    `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, attribution_window_days, created_at, updated_at)
     VALUES (?, ?, 'Customer Journey Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
    [id, metaId, encryptToken('fake-token')]
  );
  return { id, meta_account_id: metaId };
}

function insertCampaign(testDb, accountId, metaCampaignId) {
  const id = uuidv4();
  testDb.db.run(
    `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Journey Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
    [id, accountId, metaCampaignId]
  );
  return id;
}

describe('customerJourneyEngine', () => {
  let testDb;
  let engine;

  beforeAll(async () => {
    testDb = await createTestDb();
    engine = require('../../src/services/customerJourneyEngine');
  });

  afterAll(() => { testDb.cleanup(); });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM customer_journey_funnel');
  });

  describe('syncAccountCustomerJourney', () => {
    test('fetches real Meta campaign metrics and persists a real funnel (no phantom cache table)', async () => {
      const account = insertAccount(testDb);
      insertCampaign(testDb, account.id, 'camp_journey_1');
      const range = { since: '2026-06-01', until: '2026-06-07' };

      // fetchCampaignMetrics fetches current AND prior period -- both must
      // be mocked even though only current feeds the persisted funnel row.
      nock(BASE).get(`/${VERSION}/camp_journey_1/insights`).query(true).times(2).reply(200, {
        data: [{
          spend: '500', impressions: '10000', reach: '4000', clicks: '300', ctr: '3', cpm: '50', cpc: '1.67', frequency: '2.5',
          actions: [
            { action_type: 'landing_page_view', value: '200' }, // -> landing_page_views
            { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '40' }, // -> results (conversations)
            { action_type: 'omni_purchase', value: '15' }, // -> purchases (independent bucket)
          ],
          action_values: [{ action_type: 'purchase', value: '750' }], // -> purchase_value (revenue)
        }],
      });

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await engine.syncAccountCustomerJourney(fullAccount, range);

      expect(summary.campaignsProcessed).toBe(1);
      expect(summary.errors).toEqual([]);

      const row = testDb.db.get(
        `SELECT * FROM customer_journey_funnel WHERE meta_campaign_id = ?`,
        ['camp_journey_1']
      );
      expect(row.impressions).toBe(10000);
      expect(row.reach).toBe(4000);
      expect(row.clicks).toBe(300);
      expect(row.landing_page_views).toBe(200);
      expect(row.conversations).toBe(40); // real 'results' bucket, not a duplicate of purchases
      expect(row.purchases).toBe(15); // real, independently-resolved 'purchases' bucket
      expect(row.revenue).toBe(750);
    });
  });

  describe('getCustomerJourney (read side, no Meta calls)', () => {
    test('computes real conversion rates between stages from a persisted funnel row', () => {
      const account = insertAccount(testDb);
      const range = { since: '2026-06-01', until: '2026-06-07' };
      testDb.db.run(
        `INSERT INTO customer_journey_funnel (id, ad_account_id, meta_campaign_id, date_since, date_until, impressions, reach, clicks, landing_page_views, conversations, purchases, revenue, calculated_at)
         VALUES (?, ?, 'camp_journey_read', ?, ?, 10000, 4000, 300, 200, 40, 15, 750, datetime('now'))`,
        [uuidv4(), account.id, range.since, range.until]
      );

      const result = engine.getCustomerJourney('camp_journey_read', range);
      expect(result.funnel.conversations).toBe(40);
      expect(result.funnel.purchases).toBe(15);
      const clicksStage = result.stages.find(s => s.stage === 'clicks');
      expect(clicksStage.conversion_rate).toBeCloseTo((300 / 4000) * 100, 2);
    });
  });
});
