'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

function insertAccount(testDb, overrides = {}) {
  const id = uuidv4();
  const metaId = overrides.meta_account_id || `act_attrwin_${id.slice(0, 8)}`;
  testDb.db.run(
    `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, attribution_window_days, created_at, updated_at)
     VALUES (?, ?, 'Attribution Window Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
    [id, metaId, encryptToken('fake-token')]
  );
  return { id, meta_account_id: metaId };
}

function insertCampaign(testDb, accountId, metaCampaignId) {
  const id = uuidv4();
  testDb.db.run(
    `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Attribution Window Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
    [id, accountId, metaCampaignId]
  );
  return id;
}

function replyForWindow(campaignId, window, spend, results) {
  nock(BASE).get(`/${VERSION}/${campaignId}/insights`)
    .query(q => JSON.parse(q.action_attribution_windows || '[]')[0] === window)
    .times(2) // fetchCampaignMetrics fetches both current AND prior period per call
    .reply(200, {
      data: [{
        spend: String(spend), impressions: '1000', clicks: '10', ctr: '1', cpm: '10', cpc: '1',
        frequency: '1', reach: '500',
        // 'results' bucket's default (no optimization_goal known) priority
        // list is messaging action_types -- see metricsFetcher.js's
        // RESULT_ACTION_PRIORITY.results.
        actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(results) }],
        action_values: [{ action_type: 'purchase', value: '250' }],
      }],
    });
}

describe('attributionWindowEngine', () => {
  let testDb;
  let engine;

  beforeAll(async () => {
    testDb = await createTestDb();
    engine = require('../../src/services/attributionWindowEngine');
  });

  afterAll(() => { testDb.cleanup(); });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM attribution_window_comparison');
  });

  describe('syncAccountAttributionWindows', () => {
    test('fetches real Meta metrics under each real attribution window and persists genuinely different results per window (no phantom cache table)', async () => {
      const account = insertAccount(testDb);
      insertCampaign(testDb, account.id, 'camp_attrwin_1');
      const range = { since: '2026-06-01', until: '2026-06-07' };

      // Genuinely different purchase counts per window -- proves this reads
      // real per-window Meta responses, not one static row reused three times.
      replyForWindow('camp_attrwin_1', '1d_click', 100, 5);
      replyForWindow('camp_attrwin_1', '7d_click', 100, 9);
      replyForWindow('camp_attrwin_1', '1d_view', 100, 3);

      const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [account.id]);
      const summary = await engine.syncAccountAttributionWindows(fullAccount, range);

      expect(summary.campaignsProcessed).toBe(3); // one per window
      expect(summary.errors).toEqual([]);

      const rows = testDb.db.all(
        `SELECT attribution_window, spend, results FROM attribution_window_comparison
         WHERE meta_campaign_id = ? ORDER BY attribution_window`,
        ['camp_attrwin_1']
      );
      const byWindow = Object.fromEntries(rows.map(r => [r.attribution_window, r.results]));
      expect(byWindow['1d_click']).toBe(5);
      expect(byWindow['7d_click']).toBe(9);
      expect(byWindow['1d_view']).toBe(3);
    });
  });

  describe('getAttributionWindowComparison (read side, no Meta calls)', () => {
    test('ranks the most/least aggressive window from real persisted rows', () => {
      const account = insertAccount(testDb);
      const range = { since: '2026-06-01', until: '2026-06-07' };
      const now = new Date().toISOString();
      const insertRow = (window, results) => testDb.db.run(
        `INSERT INTO attribution_window_comparison (id, ad_account_id, meta_campaign_id, attribution_window, date_since, date_until, spend, results, cpa, roas, calculated_at)
         VALUES (?, ?, 'camp_attrwin_read', ?, ?, ?, 100, ?, ?, ?, ?)`,
        [uuidv4(), account.id, window, range.since, range.until, results, results > 0 ? 100 / results : null, 2.5, now]
      );
      insertRow('1d_click', 5);
      insertRow('7d_click', 9);
      insertRow('1d_view', 3);

      const result = engine.getAttributionWindowComparison('camp_attrwin_read', range);
      expect(result.most_aggressive_window).toBe('7d_click');
      expect(result.most_conservative_window).toBe('1d_view');
      expect(result.windows).toHaveLength(3);
    });
  });
});
