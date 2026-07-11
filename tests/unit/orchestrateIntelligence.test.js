'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { orchestrateIntelligence } = require('../../src/services/mmsOrchestrator');
const { generateTodaysDecisions } = require('../../src/services/decisionEngine');

describe('mmsOrchestrator.orchestrateIntelligence (Phase 5 — MMS as real orchestrator)', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_orch_test', 'Orchestrator Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  function insertCampaign(objective, metaCampaignId) {
    const campaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId, metaCampaignId, `${objective} campaign`, objective]
    );
    return campaignId;
  }

  test('sequences Diagnosis -> Rule Engine -> Decision Engine -> Governance in one call', () => {
    const campaignId = insertCampaign('traffic', 'camp_orch_1');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_1', name: 'Traffic Campaign', objective: 'traffic' };

    const result = orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
      priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
      deltas: {},
      intelligence: {},
      relatedDecisions: [],
      persist: true,
    });

    expect(result.diagnosis).toBeDefined();
    expect(result.ruleEngineResult.fired.length).toBeGreaterThan(0); // High Bounce should fire
    expect(result.ruleEngineDecisions.length).toBe(result.ruleEngineResult.fired.length);
    expect(result.governance).toBeDefined();
    expect(result.governance.execution_order[0]).toBe('MF1');

    // Every decision carries a governance_state -- enforcement ran (Phase 4).
    for (const d of result.ruleEngineDecisions) {
      expect(['passed', 'warning', 'failed']).toContain(d.governance_state);
    }
  });

  test('persists fired rules to rule_engine_log, which generateTodaysDecisions() then reads back (closes the Decision Engine/Rule Engine disconnect)', () => {
    const campaignId = insertCampaign('traffic', 'camp_orch_2');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_2', name: 'Traffic Campaign 2', objective: 'traffic' };

    orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
      priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
      deltas: {},
      persist: true,
    });

    const row = testDb.db.get(
      `SELECT * FROM rule_engine_log WHERE entity_meta_id = ? AND dismissed_at IS NULL`,
      ['camp_orch_2']
    );
    expect(row).toBeDefined();
    expect(row.rule_id).toBe('MF7.10.10');
    expect(row.ad_account_id).toBe(accountId);

    // The Decision Center's own data source must now include this firing.
    const decisionsResult = generateTodaysDecisions(accountId);
    const fromRuleEngine = decisionsResult.decisions.find(d => d.source === 'rule_engine' && d.meta_campaign_id === 'camp_orch_2');
    expect(fromRuleEngine).toBeDefined();
    expect(fromRuleEngine.rule_id).toBe('MF7.10.10');
    expect(fromRuleEngine.framework).toBe('MF7');
  });

  test('persist:false does not write to rule_engine_log', () => {
    const campaignId = insertCampaign('traffic', 'camp_orch_3');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_3', name: 'Traffic Campaign 3', objective: 'traffic' };

    orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
      priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
      deltas: {},
      persist: false,
    });

    const row = testDb.db.get(
      `SELECT * FROM rule_engine_log WHERE entity_meta_id = ?`,
      ['camp_orch_3']
    );
    expect(row).toBeFalsy();
  });

  test('MF6.14.2 fires when budgetUtilizationPct is supplied and CPM is rising', () => {
    const campaignId = insertCampaign('sales', 'camp_orch_4');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_4', name: 'Budget Test Campaign', objective: 'sales' };

    const result = orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, cpm: 20, purchases: 10, clicks: 500 },
      priorMetrics: { impressions: 5000, cpm: 15, purchases: 10, clicks: 500 },
      deltas: { cpm: { delta_pct: 33 } },
      budgetUtilizationPct: 95,
      persist: false,
    });

    expect(result.ruleEngineResult.fired.map(f => f.rule_id)).toContain('MF6.14.2');
  });

  test('does not fire MF6.14.2 when budgetUtilizationPct is null (no ad-set budget data)', () => {
    const campaignId = insertCampaign('sales', 'camp_orch_5');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_5', name: 'No Budget Data Campaign', objective: 'sales' };

    const result = orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, cpm: 20, purchases: 10, clicks: 500 },
      priorMetrics: { impressions: 5000, cpm: 15, purchases: 10, clicks: 500 },
      deltas: { cpm: { delta_pct: 33 } },
      budgetUtilizationPct: null,
      persist: false,
    });

    expect(result.ruleEngineResult.fired.map(f => f.rule_id)).not.toContain('MF6.14.2');
  });

  test('Phase X.3 — governs recommendation-/alert-sourced findings and persists governance_state onto their rows', () => {
    const campaignId = insertCampaign('traffic', 'camp_orch_6');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_6', name: 'Governance Test Campaign', objective: 'traffic' };

    // ctr=0.5 (< 1) fires the DB-driven LOW_CTR recommendation (-> REFRESH_CREATIVE).
    // ctr only drops 16.7% (prior 0.6 -> current 0.5), below CTR_DROP's -30%
    // threshold, so it doesn't also fire an alert mapped to the same
    // REFRESH_CREATIVE decision_type (which would collide with LOW_CTR's
    // decision in generateTodaysDecisions()'s pre-existing meta_campaign_id:
    // decision_type dedup -- unrelated to this test's governance assertions).
    // cpm 100->140 (+40% > 30% threshold) fires the DB-driven CPM_SPIKE alert
    // (-> REVIEW_PERFORMANCE, a different decision_type, so both survive dedup).
    const result = orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, clicks: 25, ctr: 0.5, cpm: 140, link_clicks: 25, spend: 100 },
      priorMetrics: { impressions: 5000, clicks: 42, ctr: 0.6, cpm: 100, link_clicks: 42, spend: 100 },
      deltas: {},
      persist: true,
    });

    expect(result.intelligence.recommendations.some(r => r.rule_code === 'LOW_CTR')).toBe(true);
    expect(result.intelligence.alerts.some(a => a.alert_code === 'CPM_SPIKE')).toBe(true);

    for (const r of result.intelligence.recommendations) {
      expect(['passed', 'warning', 'failed']).toContain(r.governance_state);
    }
    for (const a of result.intelligence.alerts) {
      expect(['passed', 'warning', 'failed']).toContain(a.governance_state);
    }

    const recRow = testDb.db.get(
      `SELECT governance_state FROM recommendation_log WHERE rule_code = 'LOW_CTR' AND entity_meta_id = ?`,
      ['camp_orch_6']
    );
    expect(recRow.governance_state).toBeTruthy();

    const alertRow = testDb.db.get(
      `SELECT governance_state FROM active_alerts WHERE alert_code = 'CPM_SPIKE' AND entity_meta_id = ?`,
      ['camp_orch_6']
    );
    expect(alertRow.governance_state).toBeTruthy();

    // The Decision Center reads the same persisted verdict, never recomputes.
    const decisionsResult = generateTodaysDecisions(accountId);
    const fromRec = decisionsResult.decisions.find(d => d.source === 'recommendation' && d.meta_campaign_id === 'camp_orch_6');
    expect(fromRec.governance_state).toBe(recRow.governance_state);
    const fromAlert = decisionsResult.decisions.find(d => d.source === 'alert' && d.meta_campaign_id === 'camp_orch_6');
    expect(fromAlert.governance_state).toBe(alertRow.governance_state);
  });

  test('Phase X.3 — persist:false does not write governance_state onto recommendation_log/active_alerts', () => {
    const campaignId = insertCampaign('traffic', 'camp_orch_7');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_7', name: 'No Persist Governance Campaign', objective: 'traffic' };

    orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, clicks: 25, ctr: 0.5, cpm: 140, link_clicks: 25, spend: 100 },
      priorMetrics: { impressions: 5000, clicks: 50, ctr: 1, cpm: 100, link_clicks: 50, spend: 100 },
      deltas: {},
      persist: false,
    });

    const recRow = testDb.db.get(
      `SELECT governance_state FROM recommendation_log WHERE rule_code = 'LOW_CTR' AND entity_meta_id = ?`,
      ['camp_orch_7']
    );
    // The row itself is still written by recommendationEngine.js (Step 0
    // always persists the finding) -- only the governance_state write is
    // gated by `persist`, matching rule_engine_log's own persist:false behavior.
    expect(recRow).toBeTruthy();
    expect(recRow.governance_state).toBeFalsy();
  });

  test('Phase X.6 — persists diagnosisEngine\'s output to diagnosis_history', () => {
    const campaignId = insertCampaign('traffic', 'camp_orch_8');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_8', name: 'Memory Test Campaign', objective: 'traffic' };

    orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
      priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
      deltas: {},
      persist: true,
    });

    const row = testDb.db.get(
      `SELECT * FROM diagnosis_history WHERE entity_meta_id = ? ORDER BY calculated_at DESC LIMIT 1`,
      ['camp_orch_8']
    );
    expect(row).toBeDefined();
    expect(row.ad_account_id).toBe(accountId);
    expect(['diagnosed', 'insufficient_data']).toContain(row.status);
  });

  test('Phase X.6 — persist:false does not write to diagnosis_history', () => {
    const campaignId = insertCampaign('traffic', 'camp_orch_9');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_9', name: 'No Persist Memory Campaign', objective: 'traffic' };

    orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
      priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
      deltas: {},
      persist: false,
    });

    const row = testDb.db.get(`SELECT * FROM diagnosis_history WHERE entity_meta_id = ?`, ['camp_orch_9']);
    expect(row).toBeFalsy();
  });

  test('Phase X.6 — measureOutcomes is invoked and persists a decision_outcomes row for an old completed decision', () => {
    const campaignId = insertCampaign('traffic', 'camp_orch_10');
    const campaign = { id: campaignId, meta_campaign_id: 'camp_orch_10', name: 'Outcome Test Campaign', objective: 'traffic' };

    const decisionId = uuidv4();
    const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString();
    testDb.db.run(
      `INSERT INTO decision_history
         (id, ad_account_id, meta_campaign_id, campaign_name, objective, decision_type,
          priority, priority_score, reason, supporting_metrics, suggested_action,
          confidence, status, action_taken, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'Outcome Test Campaign', 'traffic', 'REFRESH_CREATIVE',
               'medium', 50, 'test', ?, 'test action', 'medium', 'completed', 1, ?, datetime('now'), datetime('now'))`,
      [decisionId, accountId, 'camp_orch_10', JSON.stringify({ ctr: 0.5 }), eightDaysAgo]
    );

    orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100, ctr: 1.5 },
      priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90, ctr: 1.4 },
      deltas: {},
      persist: true,
    });

    const outcomeRow = testDb.db.get('SELECT * FROM decision_outcomes WHERE decision_history_id = ?', [decisionId]);
    expect(outcomeRow).toBeDefined();
    expect(outcomeRow.metric_key).toBe('ctr');
    expect(outcomeRow.outcome).toBe('improved'); // 0.5 -> 1.5 is a big favorable move for ctr
  });

  test('Phase X.6 — historical learning downgrades confidence and attaches historical_note after 2 ineffective prior attempts of the same rule/campaign', () => {
    const campaignIdBaseline = insertCampaign('traffic', 'camp_orch_11a');
    const campaignBaseline = { id: campaignIdBaseline, meta_campaign_id: 'camp_orch_11a', name: 'Baseline Campaign', objective: 'traffic' };
    const baselineResult = orchestrateIntelligence({
      campaign: campaignBaseline,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
      priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
      deltas: {},
      persist: false,
    });
    const baselineFired = baselineResult.ruleEngineResult.fired.find(f => f.rule_id === 'MF7.10.10');
    expect(baselineFired).toBeDefined();
    expect(baselineFired.historical_note).toBeNull(); // no history yet for this campaign

    const campaignIdHistory = insertCampaign('traffic', 'camp_orch_11b');
    const campaignHistory = { id: campaignIdHistory, meta_campaign_id: 'camp_orch_11b', name: 'History Campaign', objective: 'traffic' };
    // FIX_TRACKING is MF7.10.10's decision_type (see decisionsFromRuleEngine.test.js) --
    // simulate 2 prior ineffective attempts of this exact decision_type for this exact campaign.
    for (const outcome of ['worsened', 'no_change']) {
      const dhId = uuidv4();
      testDb.db.run(
        `INSERT INTO decision_history (id, ad_account_id, meta_campaign_id, campaign_name, objective, decision_type, priority, priority_score, reason, suggested_action, confidence, status, created_at, updated_at)
         VALUES (?, ?, 'camp_orch_11b', 'History Campaign', 'traffic', 'FIX_TRACKING', 'medium', 50, 'test', 'test action', 'medium', 'completed', datetime('now'), datetime('now'))`,
        [dhId, accountId]
      );
      testDb.db.run(
        `INSERT INTO decision_outcomes (id, decision_history_id, meta_campaign_id, decision_type, metric_key, metric_before, metric_after, delta_pct, outcome, measured_at)
         VALUES (?, ?, 'camp_orch_11b', 'FIX_TRACKING', 'ctr', 1, 1, 0, ?, datetime('now'))`,
        [uuidv4(), dhId, outcome]
      );
    }

    const historyResult = orchestrateIntelligence({
      campaign: campaignHistory,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
      priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
      deltas: {},
      persist: false,
    });
    const historyFired = historyResult.ruleEngineResult.fired.find(f => f.rule_id === 'MF7.10.10');
    expect(historyFired).toBeDefined();
    expect(historyFired.historical_note).toMatch(/Tried twice before/);
    expect(historyFired.historical_effectiveness.lastTwoIneffective).toBe(true);

    const CONFIDENCE_DOWNGRADE = { high: 'medium', medium: 'low', low: 'low' };
    const historyDecision = historyResult.ruleEngineDecisions.find(d => d.rule_id === 'MF7.10.10');
    const baselineDecision = baselineResult.ruleEngineDecisions.find(d => d.rule_id === 'MF7.10.10');
    expect(historyDecision.confidence).toBe(CONFIDENCE_DOWNGRADE[baselineDecision.confidence]);
  });

  test('Phase X.6 — historical learning applies to recommendation-/alert-sourced findings INSIDE orchestrateIntelligence() itself (Step 3.5/4b), not just the diagnosis route\'s separate second-pass call', () => {
    const campaignId = insertCampaign('traffic', 'camp_orch_12');
    const campaignMetaId = 'camp_orch_12';

    // Simulate 2 prior ineffective attempts for BOTH the recommendation's
    // decision_type (REFRESH_CREATIVE, from LOW_CTR) and the alert's
    // decision_type (REVIEW_PERFORMANCE, from CPM_SPIKE).
    for (const decisionType of ['REFRESH_CREATIVE', 'REVIEW_PERFORMANCE']) {
      for (const outcome of ['worsened', 'no_change']) {
        const dhId = uuidv4();
        testDb.db.run(
          `INSERT INTO decision_history (id, ad_account_id, meta_campaign_id, campaign_name, objective, decision_type, priority, priority_score, reason, suggested_action, confidence, status, created_at, updated_at)
           VALUES (?, ?, ?, 'Test', 'traffic', ?, 'medium', 50, 'test', 'test action', 'medium', 'completed', datetime('now'), datetime('now'))`,
          [dhId, accountId, campaignMetaId, decisionType]
        );
        testDb.db.run(
          `INSERT INTO decision_outcomes (id, decision_history_id, meta_campaign_id, decision_type, metric_key, metric_before, metric_after, delta_pct, outcome, measured_at)
           VALUES (?, ?, ?, ?, 'x', 1, 1, 0, ?, datetime('now'))`,
          [uuidv4(), dhId, campaignMetaId, decisionType, outcome]
        );
      }
    }

    const campaign = { id: campaignId, meta_campaign_id: campaignMetaId, name: 'History Rec/Alert Campaign', objective: 'traffic' };
    // Same fixture as the Phase X.3 test above: fires LOW_CTR (-> REFRESH_CREATIVE)
    // and CPM_SPIKE (-> REVIEW_PERFORMANCE) without colliding via dedup.
    const result = orchestrateIntelligence({
      campaign,
      adAccountId: accountId,
      currentMetrics: { impressions: 5000, clicks: 25, ctr: 0.5, cpm: 140, link_clicks: 25, spend: 100 },
      priorMetrics: { impressions: 5000, clicks: 42, ctr: 0.6, cpm: 100, link_clicks: 42, spend: 100 },
      deltas: {},
      persist: true,
    });

    const recFinding = result.intelligence.recommendations.find(r => r.rule_code === 'LOW_CTR');
    const alertFinding = result.intelligence.alerts.find(a => a.alert_code === 'CPM_SPIKE');
    expect(recFinding).toBeDefined();
    expect(alertFinding).toBeDefined();
    expect(recFinding.historical_note).toMatch(/Tried twice before/);
    expect(recFinding.historical_effectiveness.lastTwoIneffective).toBe(true);
    expect(alertFinding.historical_note).toMatch(/Tried twice before/);
    expect(alertFinding.historical_effectiveness.lastTwoIneffective).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle gate (Meta status awareness): a non-delivering entity must
  // never get the normal performance pipeline (Health Score, Diagnosis,
  // Recommendations, Rule Engine, Decisions) -- only a lifecycle-only
  // bundle, and any stale performance findings from before it stopped
  // delivering must be retired, not left showing.
  // ═══════════════════════════════════════════════════════════════════
  describe('lifecycle gate (effectiveStatus)', () => {
    test('a PAUSED campaign short-circuits to a lifecycle-only bundle: no health score, no diagnosis, no rule engine, no decisions', () => {
      const campaignId = insertCampaign('sales', 'camp_lifecycle_1');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_lifecycle_1', name: 'Paused Sales Campaign', objective: 'sales' };

      const result = orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        // Metrics that WOULD normally fire rules/recommendations if the
        // pipeline ran (very low ROAS) -- proves the gate, not the data, is
        // what prevents them.
        currentMetrics: { impressions: 5000, purchases: 1, roas: 0.2, spend: 500, cpm: 140, clicks: 25, ctr: 0.5 },
        priorMetrics: { impressions: 5000, purchases: 10, roas: 3, spend: 500, cpm: 100, clicks: 50, ctr: 1 },
        deltas: {},
        persist: true,
        effectiveStatus: 'PAUSED',
      });

      expect(result.intelligence.health.score).toBeNull();
      expect(result.intelligence.health.status).toBe('not_delivering');
      expect(result.diagnosis.status).toBe('not_delivering');
      expect(result.diagnosis.summary).toBe('This entity is currently not delivering.');
      expect(result.ruleEngineResult.fired).toEqual([]);
      expect(result.ruleEngineDecisions).toEqual([]);

      // No health score persisted for a non-delivering entity -- would be
      // fabricated data (there is no "not delivering" value the numeric/
      // CHECK-constrained health_score_history table can honestly hold).
      const healthRow = testDb.db.get(`SELECT * FROM health_score_history WHERE entity_meta_id = ?`, ['camp_lifecycle_1']);
      expect(healthRow).toBeFalsy();
    });

    test('the one recommendation returned is a lifecycle action, never Increase Budget/Scale/Creative Refresh/Audience Expansion', () => {
      const campaignId = insertCampaign('sales', 'camp_lifecycle_2');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_lifecycle_2', name: 'Disapproved Campaign', objective: 'sales' };

      const result = orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        currentMetrics: { impressions: 5000, purchases: 1, roas: 0.2, spend: 500 },
        priorMetrics: { impressions: 5000, purchases: 10, roas: 3, spend: 500 },
        deltas: {},
        persist: true,
        effectiveStatus: 'DISAPPROVED',
      });

      expect(result.intelligence.recommendations.length).toBe(1);
      const rec = result.intelligence.recommendations[0];
      expect(rec.rule_code).toBe('LIFECYCLE_FIX_POLICY');
      expect(rec.recommendation_title).toMatch(/Fix Policy/);
      const forbidden = /increase budget|scale|creative refresh|audience expansion/i;
      expect(rec.recommendation_title).not.toMatch(forbidden);
      expect(rec.recommendation_body).not.toMatch(forbidden);
    });

    test('retires stale performance recommendations/alerts from before the entity stopped delivering', () => {
      const campaignId = insertCampaign('traffic', 'camp_lifecycle_3');
      const metaCampaignId = 'camp_lifecycle_3';
      const now = new Date().toISOString();

      testDb.db.run(
        `INSERT INTO recommendation_log (id, rule_code, ad_account_id, entity_type, entity_meta_id, entity_label, objective, severity, recommendation_title, recommendation_body, generated_at, last_generated_at)
         VALUES (?, 'LOW_CTR', ?, 'campaign', ?, 'Stale Campaign', 'traffic', 'warning', 'Refresh Creative', 'CTR is low, refresh your creative.', ?, ?)`,
        [uuidv4(), accountId, metaCampaignId, now, now]
      );
      testDb.db.run(
        `INSERT INTO active_alerts (id, ad_account_id, alert_code, entity_type, entity_meta_id, entity_label, severity, alert_message, status, first_detected_at, last_detected_at)
         VALUES (?, ?, 'CPM_SPIKE', 'campaign', ?, 'Stale Campaign', 'warning', 'CPM spiked', 'active', ?, ?)`,
        [uuidv4(), accountId, metaCampaignId, now, now]
      );

      const campaign = { id: campaignId, meta_campaign_id: metaCampaignId, name: 'Stale Campaign', objective: 'traffic' };
      orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
        priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
        deltas: {},
        persist: true,
        effectiveStatus: 'CAMPAIGN_PAUSED',
      });

      const staleRec = testDb.db.get(
        `SELECT dismissed_at FROM recommendation_log WHERE rule_code = 'LOW_CTR' AND entity_meta_id = ?`,
        [metaCampaignId]
      );
      expect(staleRec.dismissed_at).not.toBeNull();

      const staleAlert = testDb.db.get(
        `SELECT status FROM active_alerts WHERE alert_code = 'CPM_SPIKE' AND entity_meta_id = ?`,
        [metaCampaignId]
      );
      expect(staleAlert.status).toBe('resolved');

      const lifecycleRec = testDb.db.get(
        `SELECT dismissed_at FROM recommendation_log WHERE rule_code = 'LIFECYCLE_RESUME' AND entity_meta_id = ?`,
        [metaCampaignId]
      );
      expect(lifecycleRec).toBeTruthy();
      expect(lifecycleRec.dismissed_at).toBeNull();
    });

    test('persist:false does not touch recommendation_log/active_alerts (ad_set/ad grain reads)', () => {
      const campaignId = insertCampaign('traffic', 'camp_lifecycle_4');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_lifecycle_4', name: 'Ad Set Grain', objective: 'traffic' };

      const result = orchestrateIntelligence({
        campaign,
        entityType: 'ad_set',
        adAccountId: accountId,
        currentMetrics: { impressions: 5000, spend: 100 },
        priorMetrics: { impressions: 5000, spend: 90 },
        deltas: {},
        persist: false,
        effectiveStatus: 'ADSET_PAUSED',
      });

      // ad_set/ad-shape intelligence (healthResult, not health)
      expect(result.intelligence.healthResult.health_score).toBeNull();
      expect(result.intelligence.healthResult.health_status).toBe('not_delivering');
      expect(result.intelligence.recommendations[0].rule_code).toBe('LIFECYCLE_RESUME');

      const row = testDb.db.get(`SELECT * FROM recommendation_log WHERE entity_meta_id = ?`, ['camp_lifecycle_4']);
      expect(row).toBeFalsy();
    });

    test('ACTIVE effective_status runs the normal pipeline unchanged (no regression)', () => {
      const campaignId = insertCampaign('traffic', 'camp_lifecycle_5');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_lifecycle_5', name: 'Active Campaign', objective: 'traffic' };

      const result = orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
        priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
        deltas: {},
        persist: true,
        effectiveStatus: 'ACTIVE',
      });

      expect(result.diagnosis.status).not.toBe('not_delivering');
      expect(typeof result.intelligence.health.score === 'number' || result.intelligence.health.score === null).toBe(true);
    });

    test('an ARCHIVED campaign gets a Duplicate lifecycle recommendation, not a scale/budget suggestion', () => {
      const campaignId = insertCampaign('sales', 'camp_lifecycle_archived');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_lifecycle_archived', name: 'Archived Campaign', objective: 'sales' };

      const result = orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        currentMetrics: { impressions: 5000, purchases: 20, roas: 4, spend: 500 },
        priorMetrics: { impressions: 5000, purchases: 18, roas: 3.8, spend: 480 },
        deltas: {},
        persist: true,
        effectiveStatus: 'ARCHIVED',
      });

      expect(result.intelligence.health.status).toBe('not_delivering');
      expect(result.diagnosis.status).toBe('not_delivering');
      expect(result.intelligence.recommendations[0].rule_code).toBe('LIFECYCLE_DUPLICATE');
      expect(result.intelligence.recommendations[0].recommendation_title).toMatch(/Duplicate/);
      expect(result.ruleEngineResult.fired).toEqual([]);
      expect(result.ruleEngineDecisions).toEqual([]);
    });

    test('DELETED effective_status short-circuits to a lifecycle-only bundle with no scale/budget/creative recommendation', () => {
      const campaignId = insertCampaign('sales', 'camp_lifecycle_deleted');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_lifecycle_deleted', name: 'Deleted Campaign', objective: 'sales' };

      const result = orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        currentMetrics: { impressions: 5000, purchases: 1, roas: 0.2, spend: 500 },
        priorMetrics: { impressions: 5000, purchases: 10, roas: 3, spend: 500 },
        deltas: {},
        persist: true,
        effectiveStatus: 'DELETED',
      });

      expect(result.intelligence.health.status).toBe('not_delivering');
      expect(result.diagnosis.status).toBe('not_delivering');
      expect(result.intelligence.recommendations[0].rule_code).toBe('LIFECYCLE_NO_ACTION_REQUIRED');
      expect(result.ruleEngineResult.fired).toEqual([]);
      expect(result.ruleEngineDecisions).toEqual([]);
    });

    test('an unknown/legacy effective_status (not yet synced) falls back to the normal pipeline, not a lifecycle short-circuit', () => {
      const campaignId = insertCampaign('traffic', 'camp_lifecycle_6');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_lifecycle_6', name: 'Pre-Phase-15 Campaign', objective: 'traffic' };

      const result = orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100 },
        priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90 },
        deltas: {},
        persist: false,
        effectiveStatus: null, // not yet synced
      });

      expect(result.diagnosis.status).not.toBe('not_delivering');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Governance contradiction fix (Task 1): the top-level Governance
  // Self-Check must never disagree with the decision(s) this same execution
  // actually produced. Regression fixture below is the exact real-world
  // case that exposed the bug: a real "engagement" campaign whose spend
  // fell sharply (Diagnosis Engine -> category "budget") while MF4.13.5
  // ("Poor Engagement", a CREATIVE-category rule) also fired on the same
  // post_engagements collapse -- a genuine Framework-gate mismatch. Before
  // the fix, `_governance.decision_validations`/`self_check` validated
  // `relatedDecisions[0]` (historical, empty for a first-time finding) and
  // trivially reported "passed" while `ruleEngineDecisions[0].
  // governance_validations` correctly reported "failed" -- the exact
  // contradiction this test locks in as fixed.
  // ═══════════════════════════════════════════════════════════════════
  describe('governance contradiction fix (Task 1)', () => {
    test('top-level governance trace matches the current execution\'s own decision, not historical relatedDecisions', () => {
      const campaignId = insertCampaign('engagement', 'camp_governance_fix');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_governance_fix', name: 'New Engagement Campaign', objective: 'engagement' };

      const result = orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        // Real production values (spend/results/post_engagements all fell
        // sharply) that reproduce: diagnosis.category === 'budget' AND
        // MF4.13.5 (category 'creative', -> REFRESH_CREATIVE) fires.
        currentMetrics: {
          impressions: 831, reach: 766, clicks: 41, ctr: 4.933815, cpm: 31.624549,
          cpc: 0.640976, frequency: 1.084856, link_clicks: 16, page_engagements: 18,
          post_engagements: 18, results: 3, spend: 26.28,
        },
        priorMetrics: {
          impressions: 7015, reach: 5491, clicks: 332, ctr: 4.732716, cpm: 41.650748,
          cpc: 0.88006, frequency: 1.277545, link_clicks: 87, page_engagements: 129,
          post_engagements: 122, results: 33, spend: 292.18,
        },
        deltas: {
          spend: { delta_pct: -91 },
          results: { delta_pct: -90.9 },
          post_engagements: { delta_pct: -85.2 },
        },
        relatedDecisions: [], // no history yet -- exactly what triggered the bug
        persist: false,
      });

      expect(result.diagnosis.category).toBe('budget');

      const creativeDecision = result.ruleEngineDecisions.find(d => d.rule_id === 'MF4.13.5');
      expect(creativeDecision).toBeDefined();
      expect(creativeDecision.decision_type).toBe('REFRESH_CREATIVE');
      // The per-decision gate must still correctly catch the mismatch
      // (root cause "budget" vs. action "creative") -- this was already
      // correct before the fix; asserted here as the ground truth the
      // top-level trace must now agree with.
      expect(creativeDecision.governance_validations.results.framework.status).toBe('failed');
      expect(creativeDecision.governance_validations.overall).toBe('failed');

      // THE FIX: the top-level trace must reflect that same failure, never
      // a trivial "passed" from validating an empty historical list.
      expect(result.governance.decision_validations.overall).toBe('failed');
      expect(result.governance.self_check.overall).toBe('failed');
      expect(result.governance.self_check.checks.correct_governance_compliance.status).toBe('failed');
    });

    test('multiple decisions in one execution are all validated and aggregated into one overall state', () => {
      const campaignId = insertCampaign('traffic', 'camp_governance_multi');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_governance_multi', name: 'Multi-Decision Campaign', objective: 'traffic' };

      // Fires both a rule-engine decision (MF7.10.10, High Bounce) and a
      // recommendation-sourced one (LOW_CTR, ctr < 1) in the same execution.
      const result = orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 200, clicks: 1000, spend: 100, ctr: 0.5 },
        priorMetrics: { impressions: 5000, link_clicks: 900, landing_page_views: 850, clicks: 900, spend: 90, ctr: 1.5 },
        deltas: {},
        relatedDecisions: [],
        persist: false,
      });

      expect(result.ruleEngineDecisions.length).toBeGreaterThanOrEqual(1);
      expect(result.intelligence.recommendations.some(r => r.rule_code === 'LOW_CTR')).toBe(true);

      const allCurrentGovernanceStates = [
        ...result.ruleEngineDecisions.map(d => d.governance_state),
        ...result.intelligence.recommendations.map(r => r.governance_state),
      ];
      const anyNotPassed = allCurrentGovernanceStates.some(s => s !== 'passed');
      expect(result.governance.decision_validations.overall).toBe(anyNotPassed ? 'failed' : 'passed');
      // Aggregated shape for >1 decision: per-decision detail must be present.
      if (result.ruleEngineDecisions.length + result.intelligence.recommendations.length > 1) {
        expect(Array.isArray(result.governance.decision_validations.per_decision)).toBe(true);
      }
    });

    test('zero decisions this execution -> governance trace is vacuously clean regardless of any historical decisions the caller has', () => {
      const campaignId = insertCampaign('traffic', 'camp_governance_none');
      const campaign = { id: campaignId, meta_campaign_id: 'camp_governance_none', name: 'Quiet Campaign', objective: 'traffic' };

      const result = orchestrateIntelligence({
        campaign,
        adAccountId: accountId,
        currentMetrics: { impressions: 5000, link_clicks: 1000, landing_page_views: 900, clicks: 1000, spend: 100, ctr: 5 },
        priorMetrics: { impressions: 5000, link_clicks: 950, landing_page_views: 900, clicks: 950, spend: 95, ctr: 5 },
        deltas: {},
        // A historical decision that WOULD fail validation if it were (wrongly) consulted.
        relatedDecisions: [{ decision_type: 'NOT_A_REAL_DECISION_TYPE' }],
        persist: false,
      });

      expect(result.ruleEngineDecisions).toEqual([]);
      expect(result.governance.decision_validations.overall).toBe('passed');
      expect(result.governance.self_check.overall).toBe('passed');
    });
  });
});
