'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

function insertAccount(testDb) {
  const id = uuidv4();
  const metaId = `act_budget_${id.slice(0, 8)}`;
  testDb.db.run(
    `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, attribution_window_days, created_at, updated_at)
     VALUES (?, ?, 'Budget Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
    [id, metaId, encryptToken('fake-token')]
  );
  return { id, meta_account_id: metaId };
}

function insertCampaignWithBudget(testDb, accountId, metaCampaignId, dailyBudget) {
  const campaignId = uuidv4();
  testDb.db.run(
    `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'engagement', 'active', datetime('now'), datetime('now'))`,
    [campaignId, accountId, metaCampaignId, `Campaign ${metaCampaignId}`]
  );
  testDb.db.run(
    `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, daily_budget, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Ad Set', 'active', ?, datetime('now'), datetime('now'))`,
    [uuidv4(), campaignId, accountId, `adset_${metaCampaignId}`, dailyBudget]
  );
  return campaignId;
}

describe('budgetDistributionAnalytics', () => {
  let testDb;
  let budgetAnalytics;

  beforeAll(async () => {
    testDb = await createTestDb();
    budgetAnalytics = require('../../src/services/budgetDistributionAnalytics');
  });

  afterAll(() => { testDb.cleanup(); });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM ad_sets');
    testDb.db.run('DELETE FROM budget_distribution_snapshots');
  });

  describe('computeDistribution (pure logic)', () => {
    test('computes allocation percentages that sum to 100 and an account rollup', () => {
      const rows = [
        { level: 'campaign', entity_meta_id: 'c1', entity_label: 'A', budget: 100, spend: 60, results: 12 },
        { level: 'campaign', entity_meta_id: 'c2', entity_label: 'B', budget: 100, spend: 40, results: 4 },
      ];
      const { rows: enriched, account } = budgetAnalytics.computeDistribution(rows);
      const totalSpendPct = enriched.reduce((s, r) => s + r.spend_pct, 0);
      expect(Math.round(totalSpendPct)).toBe(100);
      expect(account.spend).toBe(100);
      expect(account.results).toBe(16);
    });

    test('flags a high-spend, low-efficiency campaign as waste', () => {
      const rows = [
        { level: 'campaign', entity_meta_id: 'good', entity_label: 'Good', budget: 100, spend: 50, results: 50 }, // 1 result/$
        { level: 'campaign', entity_meta_id: 'bad', entity_label: 'Bad', budget: 100, spend: 500, results: 5 },   // 0.01 result/$, huge spend share
      ];
      const { rows: enriched } = budgetAnalytics.computeDistribution(rows);
      const bad = enriched.find(r => r.entity_meta_id === 'bad');
      expect(bad.is_waste).toBe(true);
      expect(bad.efficiency_score).toBeLessThan(budgetAnalytics.WASTE_EFFICIENCY_THRESHOLD);
    });

    test('flags a high-efficiency, budget-constrained campaign as a scaling opportunity', () => {
      const rows = [
        { level: 'campaign', entity_meta_id: 'star', entity_label: 'Star', budget: 55, spend: 50, results: 100 }, // 2.0 results/$, 91% of budget spent
        { level: 'campaign', entity_meta_id: 'avg1', entity_label: 'Average 1', budget: 100, spend: 50, results: 10 }, // 0.2 results/$
        { level: 'campaign', entity_meta_id: 'avg2', entity_label: 'Average 2', budget: 100, spend: 50, results: 10 }, // 0.2 results/$
      ];
      const { rows: enriched } = budgetAnalytics.computeDistribution(rows);
      const star = enriched.find(r => r.entity_meta_id === 'star');
      expect(star.is_scaling_opportunity).toBe(true);
      expect(star.efficiency_score).toBeGreaterThanOrEqual(budgetAnalytics.SCALING_EFFICIENCY_THRESHOLD);
    });

    test('a campaign with zero spend gets a null efficiency score, never flagged waste or scaling', () => {
      const rows = [{ level: 'campaign', entity_meta_id: 'idle', entity_label: 'Idle', budget: 100, spend: 0, results: 0 }];
      const { rows: enriched } = budgetAnalytics.computeDistribution(rows);
      expect(enriched[0].efficiency_score).toBeNull();
      expect(enriched[0].is_waste).toBe(false);
      expect(enriched[0].is_scaling_opportunity).toBe(false);
    });
  });

  describe('syncAccountBudgetDistribution + getBudgetDistribution (integration)', () => {
    test('fetches spend/results per active campaign, persists a snapshot, and the read side matches it with no further Meta calls', async () => {
      const account = insertAccount(testDb);
      insertCampaignWithBudget(testDb, account.id, 'camp_budget_1', 50);
      insertCampaignWithBudget(testDb, account.id, 'camp_budget_2', 30);

      const range = { since: '2026-06-15', until: '2026-06-21' };
      // fetchCampaignMetrics fetches BOTH current and prior period per campaign.
      for (const campId of ['camp_budget_1', 'camp_budget_2']) {
        nock(BASE).get(`/${VERSION}/${campId}/insights`).query(q => q.time_range && q.time_range.includes('2026-06-15'))
          .reply(200, { data: [{ spend: campId.endsWith('1') ? '80' : '20', impressions: '1000', actions: [{ action_type: 'link_click', value: '10' }] }] });
        nock(BASE).get(`/${VERSION}/${campId}/insights`).query(q => q.time_range && !q.time_range.includes('2026-06-15'))
          .reply(200, { data: [] });
      }

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const syncResult = await budgetAnalytics.syncAccountBudgetDistribution(fullAccount, range);

      expect(syncResult.campaignsProcessed).toBe(2);
      expect(syncResult.errors).toEqual([]);

      const read = budgetAnalytics.getBudgetDistribution(account.id, range);
      expect(read.campaigns.length).toBe(2);
      expect(read.account_totals.spend_amount).toBe(100); // 80 + 20
      const camp1 = read.campaigns.find(c => c.entity_meta_id === 'camp_budget_1');
      expect(camp1.spend_amount).toBe(80);
      expect(camp1.budget_amount).toBe(50);
    });
  });
});
