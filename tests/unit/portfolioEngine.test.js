'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { getPortfolioHealth, getAccountRankings, getPortfolioSummary, getPortfolioObjectiveSummary } = require('../../src/services/portfolioEngine');

describe('portfolioEngine', () => {
  let testDb;
  let accountA, accountB;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountA = uuidv4();
    accountB = uuidv4();

    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_portfolio_a', 'Portfolio A', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [accountA]
    );
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
       VALUES (?, 'act_portfolio_b', 'Portfolio B', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
      [accountB]
    );

    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_pf_a1', 'A1', 'sales', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountA]
    );
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_pf_b1', 'B1', 'sales', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountB]
    );

    // Account A: one excellent campaign with a known spend (for spend weighting)
    testDb.db.run(
      `INSERT INTO health_score_history
         (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
          health_score, health_status, score_reference, score_breakdown, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_pf_a1', 'A1', 'sales', 90, 'excellent', 'platform_default', ?, datetime('now'))`,
      [uuidv4(), accountA, JSON.stringify({ spend: { value: 1000 } })]
    );
    // Account B: one critical campaign
    testDb.db.run(
      `INSERT INTO health_score_history
         (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
          health_score, health_status, score_reference, score_breakdown, calculated_at)
       VALUES (?, ?, 'campaign', 'camp_pf_b1', 'B1', 'sales', 30, 'critical', 'platform_default', ?, datetime('now'))`,
      [uuidv4(), accountB, JSON.stringify({ spend: { value: 500 } })]
    );

    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'ROAS_BELOW_ONE', 'campaign', 'camp_pf_b1', 'B1', 'critical', 'ROAS below 1')`,
      [uuidv4(), accountB]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('getPortfolioHealth computes a spend-weighted score across all accounts', () => {
    const result = getPortfolioHealth();
    // Weighted: (90*1000 + 30*500) / 1500 = 70
    expect(result.score).toBe(70);
    expect(result.weighting).toBe('spend_weighted');
    expect(result.status).toBe('good'); // uses the shared scoreToStatus from healthScoreEngine.js (T4-09)
  });

  test('getAccountRankings sorts accounts by health score descending and attaches alert/campaign counts', () => {
    const rankings = getAccountRankings();
    expect(rankings[0].meta_account_id).toBe('act_portfolio_a'); // 90 > 30
    expect(rankings[0].health_score).toBe(90);
    expect(rankings[0].active_alerts).toBe(0);

    const b = rankings.find(r => r.meta_account_id === 'act_portfolio_b');
    expect(b.health_score).toBe(30);
    expect(b.active_alerts).toBe(1);
    expect(b.total_campaigns).toBe(1);
  });

  test('getAccountRankings excludes snoozed alerts from active_alerts, matching dashboard.js/alerts.js', () => {
    // Phase 38 -- this query previously counted status='active' alone, so a
    // snoozed alert (still status='active', just temporarily silenced)
    // inflated this count relative to the Dashboard's own alert count for
    // the same account, which already excluded snoozed alerts.
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message, snoozed_until)
       VALUES (?, ?, 'LOW_CTR', 'campaign', 'camp_pf_b1', 'B1', 'warning', 'CTR low', datetime('now', '+1 day'))`,
      [uuidv4(), accountB]
    );

    const rankings = getAccountRankings();
    const b = rankings.find(r => r.meta_account_id === 'act_portfolio_b');
    expect(b.active_alerts).toBe(1); // still 1, not 2 -- the snoozed alert must not count
  });

  test('getPortfolioSummary aggregates health distribution and top/worst campaigns across accounts', () => {
    const summary = getPortfolioSummary();
    expect(summary.campaigns.total).toBe(2);
    expect(summary.health_distribution.excellent).toBe(1); // camp_pf_a1 (90)
    expect(summary.health_distribution.critical).toBe(1);  // camp_pf_b1 (30)
    expect(summary.top_campaigns[0].entity_meta_id).toBe('camp_pf_a1');
    expect(summary.worst_campaigns[0].entity_meta_id).toBe('camp_pf_b1');
    // Same spend-weighted score as getPortfolioHealth, computed inline
    // from the already-collected campaign list (T4-09 cleanup removed
    // the redundant second getPortfolioHealth() call here).
    expect(summary.portfolio_health.score).toBe(70);
  });

  // Regression test (T8-01): getPortfolioObjectiveSummary's hardcoded
  // objectives list still held the pre-taxonomy 'messaging' value (renamed
  // to 'engagement' by schema.phase8.js) and lacked 'app_promotion' --
  // real health_score_history rows written for an 'engagement' campaign
  // were silently excluded from this summary because the query filtered on
  // `objective = 'messaging'`, which no live row could ever match again.
  describe('getPortfolioObjectiveSummary (T8-01)', () => {
    let engagementAccount;

    beforeAll(() => {
      engagementAccount = uuidv4();
      testDb.db.run(
        `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, created_at, updated_at)
         VALUES (?, 'act_portfolio_engagement', 'Portfolio Engagement', 'enc:v1:x', 'active', datetime('now'), datetime('now'))`,
        [engagementAccount]
      );
      testDb.db.run(
        `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
         VALUES (?, ?, 'camp_pf_engagement1', 'Engagement 1', 'engagement', 'active', datetime('now'), datetime('now'))`,
        [uuidv4(), engagementAccount]
      );
      testDb.db.run(
        `INSERT INTO health_score_history
           (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
            health_score, health_status, score_reference, score_breakdown, calculated_at)
         VALUES (?, ?, 'campaign', 'camp_pf_engagement1', 'Engagement 1', 'engagement', 75, 'good', 'platform_default', ?, datetime('now'))`,
        [uuidv4(), engagementAccount, JSON.stringify({ spend: { value: 200 } })]
      );
    });

    test('includes a real engagement campaign (not silently dropped under the old "messaging" key)', () => {
      const summary = getPortfolioObjectiveSummary();
      expect(summary.engagement).toBeDefined();
      expect(summary.engagement.campaign_count).toBe(1);
      expect(summary.engagement.health_score).toBe(75);
      expect(summary.messaging).toBeUndefined();
    });

    test('primary_kpi for engagement/sales is sourced correctly (Conversations/ROAS, not a generic fallback)', () => {
      const summary = getPortfolioObjectiveSummary();
      expect(summary.engagement.primary_kpi).toEqual({ key: 'results', label: 'Conversations', costKey: 'cpr', costLabel: 'Cost Per Conversation' });
      expect(summary.sales.primary_kpi).toEqual({ key: 'roas', label: 'ROAS', costKey: 'cpa', costLabel: 'Cost Per Purchase' });
    });
  });
});
