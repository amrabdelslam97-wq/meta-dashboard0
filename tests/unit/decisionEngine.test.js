'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { generateTodaysDecisions } = require('../../src/services/decisionEngine');

describe('decisionEngine.generateTodaysDecisions', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_decision_test', 'Decision Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  function insertHistory(entityMetaId, score, calculatedAt) {
    testDb.db.run(
      `INSERT INTO health_score_history
         (id, ad_account_id, entity_type, entity_meta_id, entity_label, objective,
          health_score, health_status, score_reference, calculated_at)
       VALUES (?, ?, 'campaign', ?, ?, 'sales', ?, 'good', 'platform_default', ?)`,
      [uuidv4(), accountId, entityMetaId, entityMetaId, score, calculatedAt]
    );
  }

  // Regression test for T4-04: getTrendForEntity() used to be hardcoded to
  // 'stable' everywhere, so the trend component of every decision's
  // priority score was always the same regardless of whether the campaign
  // was actually improving or declining. Two campaigns with identical
  // health score, alert severity, and rule -- differing ONLY in whether
  // their score history is trending down or up -- must now produce
  // different priority scores (declining should score exactly 15 points
  // higher, the full trend component swing, since improving contributes 0
  // and declining contributes 15 per prioritizationEngine.js).
  test('trend direction (declining vs improving) is correctly reflected in priority_score, not hardcoded', () => {
    insertHistory('camp_declining', 90, '2026-05-01T00:00:00.000Z');
    insertHistory('camp_declining', 70, '2026-06-28T00:00:00.000Z');
    insertHistory('camp_declining', 70, '2026-06-29T00:00:00.000Z');
    insertHistory('camp_declining', 70, '2026-06-30T00:00:00.000Z');

    insertHistory('camp_improving', 50, '2026-05-01T00:00:00.000Z');
    insertHistory('camp_improving', 70, '2026-06-28T00:00:00.000Z');
    insertHistory('camp_improving', 70, '2026-06-29T00:00:00.000Z');
    insertHistory('camp_improving', 70, '2026-06-30T00:00:00.000Z');

    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_declining', 'Declining Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_improving', 'Improving Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );

    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          severity, recommendation_title, recommendation_body)
       VALUES (?, 'LOW_ROAS', ?, 'campaign', 'camp_declining', 'Declining Campaign', 'critical', 'Low ROAS', 'Body')`,
      [uuidv4(), accountId]
    );
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          severity, recommendation_title, recommendation_body)
       VALUES (?, 'LOW_ROAS', ?, 'campaign', 'camp_improving', 'Improving Campaign', 'critical', 'Low ROAS', 'Body')`,
      [uuidv4(), accountId]
    );

    const result = generateTodaysDecisions(accountId);
    const declining = result.decisions.find(d => d.meta_campaign_id === 'camp_declining');
    const improving = result.decisions.find(d => d.meta_campaign_id === 'camp_improving');

    expect(declining).toBeDefined();
    expect(improving).toBeDefined();
    expect(declining.priority_score - improving.priority_score).toBe(15);
  });

  // Phase 48 — Blocker 4: confidence is now computed via the shared
  // executiveReasoningEngine.computeConfidence() primitive instead of a
  // crude inline ternary, but the emitted qualitative string must stay
  // exactly 'high'/'medium'/'low' (maifsGovernance.js's hardcoded gate
  // depends on it) and a new confidence_pct field should be present
  // alongside it.
  test('confidence is a real percentage (confidence_pct) backing the existing high/medium/low string', () => {
    const result = generateTodaysDecisions(accountId);
    const declining = result.decisions.find(d => d.meta_campaign_id === 'camp_declining');
    expect(declining.confidence).toBe('high'); // critical severity, unchanged from before
    expect(typeof declining.confidence_pct).toBe('number');
    expect(declining.confidence_pct).toBeGreaterThanOrEqual(15);
    expect(declining.confidence_pct).toBeLessThanOrEqual(90);
  });

  // Regression test for T4-19: REC_TO_DECISION/ALERT_TO_DECISION used to
  // carry entries for rule/alert codes (AD_FATIGUE, REAL_ROAS_DIVERGENCE,
  // BUDGET_EXHAUSTION, FREQUENCY_SPIKE, AD_REJECTED) that no seeded rule
  // or alert row can ever actually produce -- dead mappings that could
  // never match a real row. Confirm a recommendation/alert carrying one
  // of those codes produces NO decision (mapping is genuinely gone, not
  // just untested).
  test('a recommendation with a dead/never-seeded rule_code produces no decision', () => {
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_dead_code', 'Dead Code Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );
    testDb.db.run(
      `INSERT INTO recommendation_log
         (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label,
          severity, recommendation_title, recommendation_body)
       VALUES (?, 'AD_FATIGUE', ?, 'campaign', 'camp_dead_code', 'Dead Code Campaign', 'warning', 'X', 'Y')`,
      [uuidv4(), accountId]
    );

    const result = generateTodaysDecisions(accountId);
    expect(result.decisions.some(d => d.meta_campaign_id === 'camp_dead_code')).toBe(false);
  });

  test('an alert with a dead/never-seeded alert_code produces no decision', () => {
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_dead_alert', 'Dead Alert Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'BUDGET_EXHAUSTION', 'campaign', 'camp_dead_alert', 'Dead Alert Campaign', 'warning', 'X')`,
      [uuidv4(), accountId]
    );

    const result = generateTodaysDecisions(accountId);
    expect(result.decisions.some(d => d.meta_campaign_id === 'camp_dead_alert')).toBe(false);
  });

  test('a live alert code (ROAS_BELOW_ONE) does produce a PAUSE_CAMPAIGN decision', () => {
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_live_alert', 'Live Alert Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'ROAS_BELOW_ONE', 'campaign', 'camp_live_alert', 'Live Alert Campaign', 'critical', 'ROAS below 1')`,
      [uuidv4(), accountId]
    );

    const result = generateTodaysDecisions(accountId);
    const decision = result.decisions.find(d => d.meta_campaign_id === 'camp_live_alert');
    expect(decision).toBeDefined();
    expect(decision.decision_type).toBe('PAUSE_CAMPAIGN');
  });

  // T6-01: decisionEngine now resolves REC_TO_DECISION/ALERT_TO_DECISION
  // through the KPI Profile Resolver (an objective-specific override would
  // win, none exist yet) instead of a flat lookup -- this proves the
  // resolver-driven mapping still resolves correctly end to end for a
  // non-'sales' objective, and that the objectiveWeight=1.0 default leaves
  // priority scoring unaffected (same score a flat 1.0 multiplier would
  // produce).
  test('mapping resolution and objectiveWeight=1.0 default work correctly for a non-sales objective', () => {
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_engagement_alert', 'Engagement Alert Campaign', 'engagement', 'active', datetime('now'), datetime('now'))`,
      [uuidv4(), accountId]
    );
    testDb.db.run(
      `INSERT INTO active_alerts
         (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message)
       VALUES (?, ?, 'CTR_DROP', 'campaign', 'camp_engagement_alert', 'Engagement Alert Campaign', 'warning', 'CTR dropped')`,
      [uuidv4(), accountId]
    );

    const result = generateTodaysDecisions(accountId);
    const decision = result.decisions.find(d => d.meta_campaign_id === 'camp_engagement_alert');
    expect(decision).toBeDefined();
    expect(decision.decision_type).toBe('REFRESH_CREATIVE');
    // healthScore defaults to 50 (no history) -> healthUrgency=17.5, alert warning=18,
    // trend 'stable' (no history) = 5, goal neutral = 4, spend 0 = 0 -> 44.5 -> round 45,
    // objectiveWeight 1.0 leaves it unchanged.
    expect(decision.priority_score).toBe(45);
  });
});
