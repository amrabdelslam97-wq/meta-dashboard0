'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { detectAllOpportunities, resolveOpportunityThresholds } = require('../../src/services/opportunityEngine');
const { DEFAULT_OPPORTUNITY_THRESHOLDS } = require('../../src/services/kpiProfileResolver');

describe('opportunityEngine.resolveOpportunityThresholds', () => {
  test('no objective currently overrides opportunityThresholds -- every objective gets the shared default (T6-01)', () => {
    for (const objective of ['awareness', 'traffic', 'engagement', 'leads', 'app_promotion', 'sales', 'unknown']) {
      expect(resolveOpportunityThresholds(objective)).toEqual(DEFAULT_OPPORTUNITY_THRESHOLDS);
    }
  });
});

describe('opportunityEngine.detectAllOpportunities (resolver-driven thresholds, T6-01 regression)', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_opp_test', 'Opportunity Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  function insertCampaign(metaId, objective) {
    const id = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
      [id, accountId, metaId, `${objective} campaign`, objective]
    );
    return id;
  }

  function insertHealthScore(metaId, objective, healthScore, frequency) {
    testDb.db.run(
      `INSERT INTO health_score_history
        (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
         health_score, health_status, score_reference, score_breakdown, calculated_at)
       VALUES (?, ?, 'campaign', ?, ?, ?, ?, 'good', 'platform_default', ?, datetime('now'))`,
      [
        uuidv4(), accountId, metaId, `${objective} campaign`, objective,
        healthScore,
        JSON.stringify({ frequency: { value: frequency, normalized: 100, weight: 0.2 } }),
      ]
    );
  }

  // Exactly the old hardcoded literals (health >= 70, frequency < 3.5) --
  // this proves the resolver-driven default preserves identical behavior
  // to what opportunityEngine.js used before this refactor.
  test('a campaign at the exact old Ready To Scale boundary still qualifies', () => {
    insertCampaign('camp_opp_scale', 'traffic');
    insertHealthScore('camp_opp_scale', 'traffic', 70, 3.4);

    const opportunities = detectAllOpportunities(50);
    const found = opportunities.find(o => o.meta_campaign_id === 'camp_opp_scale' && o.type === 'Ready To Scale');
    expect(found).toBeDefined();
  });

  test('a campaign just below the Ready To Scale health boundary does not qualify', () => {
    insertCampaign('camp_opp_no_scale', 'traffic');
    insertHealthScore('camp_opp_no_scale', 'traffic', 69, 3.0);

    const opportunities = detectAllOpportunities(50);
    const found = opportunities.find(o => o.meta_campaign_id === 'camp_opp_no_scale' && o.type === 'Ready To Scale');
    expect(found).toBeUndefined();
  });

  test('a campaign with frequency 4.0 (between 3.5 and 6.0) qualifies for Audience Expansion, not Ready To Scale', () => {
    insertCampaign('camp_opp_expand', 'leads');
    insertHealthScore('camp_opp_expand', 'leads', 68, 4.0);

    const opportunities = detectAllOpportunities(50);
    const types = opportunities.filter(o => o.meta_campaign_id === 'camp_opp_expand').map(o => o.type);
    expect(types).toContain('Audience Expansion');
    expect(types).not.toContain('Ready To Scale');
  });
});
