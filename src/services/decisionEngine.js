/**
 * Decision Engine — Phase 5
 *
 * Orchestrates all Phase 5 engines to produce "Today's Priority Actions".
 * Each decision is a concrete, actionable instruction with full context.
 *
 * Decision types:
 *   SCALE_CAMPAIGN       — increase budget
 *   PAUSE_CAMPAIGN       — stop spend
 *   REFRESH_CREATIVE     — launch new ad variations
 *   EXPAND_AUDIENCE      — duplicate with wider targeting
 *   FIX_TRACKING         — attribution/pixel issue detected
 *   BUDGET_WARNING       — budget exhaustion approaching
 *   REVIEW_PERFORMANCE   — general degradation alert
 *   REALLOCATE_BUDGET    — shift spend from loser to winner
 *
 * Reuses:
 *   - topWinnersEngine (detectTrend)
 *   - opportunityEngine (drives REALLOCATE_BUDGET via its own
 *     Budget Reallocation opportunity type -- no direct call into
 *     topLosersEngine needed here)
 *   - prioritizationEngine
 *   - DB tables: health_score_history, recommendation_log, active_alerts
 */

const { v4: uuidv4 } = require('uuid');
const db                 = require('../db/database');
const { detectTrend }  = require('./topWinnersEngine');
const { detectAllOpportunities } = require('./opportunityEngine');
const { computePriorityScore } = require('./prioritizationEngine');
const { resolveProfile } = require('./kpiProfileResolver');

// ─────────────────────────────────────────────
// Map recommendation rule codes to decision types.
// Only rule_code/alert_code values that recommendationEngine.js/
// alertEngine.js can actually produce belong here -- those two engines
// only ever write a rule_code/alert_code sourced from a DB row in
// recommendation_rules/alert_rules, and seedIntelligence.js only ever
// seeds LOW_ROAS/LOW_CTR/HIGH_FREQUENCY and CPM_SPIKE/CTR_DROP/
// ROAS_BELOW_ONE, with no other code path inserting further rows. Entries
// for any other code (AD_FATIGUE, REAL_ROAS_DIVERGENCE, BUDGET_EXHAUSTION,
// FREQUENCY_SPIKE, AD_REJECTED) could never match a real row and were
// removed rather than kept as dead mappings for rules that don't exist.
// ─────────────────────────────────────────────
const REC_TO_DECISION = {
  LOW_ROAS:       { type: 'PAUSE_CAMPAIGN',   base_priority: 'critical' },
  LOW_CTR:        { type: 'REFRESH_CREATIVE', base_priority: 'warning'  },
  HIGH_FREQUENCY: { type: 'EXPAND_AUDIENCE',  base_priority: 'warning'  },
};

const ALERT_TO_DECISION = {
  ROAS_BELOW_ONE:   { type: 'PAUSE_CAMPAIGN',   base_priority: 'critical' },
  CPM_SPIKE:        { type: 'REVIEW_PERFORMANCE', base_priority: 'warning' },
  CTR_DROP:         { type: 'REFRESH_CREATIVE',  base_priority: 'warning'  },
};

// ─────────────────────────────────────────────
// Load recent health-score history for one entity and derive its trend,
// reusing topWinnersEngine's own detectTrend() rather than hardcoding
// 'stable' -- that hardcode meant the trend component of every
// recommendation-/alert-derived decision's priority score never reflected
// whether the campaign was actually improving or declining.
// ─────────────────────────────────────────────
function getTrendForEntity(entityMetaId) {
  const history = db.all(`
    SELECT health_score, calculated_at FROM health_score_history
    WHERE entity_meta_id = ? ORDER BY calculated_at DESC LIMIT 10
  `, [entityMetaId]);
  return detectTrend(history);
}

const OPPORTUNITY_TO_DECISION = {
  'Ready To Scale':          { type: 'SCALE_CAMPAIGN',     base_priority: 'high'   },
  'Audience Expansion':      { type: 'EXPAND_AUDIENCE',    base_priority: 'medium' },
  'Creative Testing':        { type: 'REFRESH_CREATIVE',   base_priority: 'medium' },
  'Budget Reallocation':     { type: 'REALLOCATE_BUDGET',  base_priority: 'low'    },
};

// ─────────────────────────────────────────────
// Resolve a rule/alert/opportunity code to its decision mapping, checking
// the KPI Profile Resolver for an objective-specific override before
// falling back to the flat default map. No profile currently defines a
// decisionOverrides entry -- this is the hook, not invented per-objective
// business content (see kpiProfileResolver.js's opportunityThresholds
// comment for the same rationale) -- so behavior is unchanged today.
// ─────────────────────────────────────────────
function resolveDecisionMapping(objective, code, defaultMap) {
  const profile = resolveProfile(objective);
  return (profile.decisionOverrides && profile.decisionOverrides[code]) || defaultMap[code];
}

// Human-readable action labels
const DECISION_LABELS = {
  SCALE_CAMPAIGN:     '🚀 Scale Campaign',
  PAUSE_CAMPAIGN:     '⛔ Pause Campaign',
  REFRESH_CREATIVE:   '🎨 Refresh Creative',
  EXPAND_AUDIENCE:    '🌐 Expand Audience',
  FIX_TRACKING:       '🔧 Fix Tracking',
  BUDGET_WARNING:     '💸 Budget Warning',
  REVIEW_PERFORMANCE: '📉 Review Performance',
  REALLOCATE_BUDGET:  '💰 Reallocate Budget',
};

// ─────────────────────────────────────────────
// MAIFS Enforcement adapter (Phase X.3 -- MAIFS Enforcement). A
// recommendation/alert row doesn't carry the decision_type/priority/
// confidence/suggested_action shape maifsGovernance.runDecisionValidations()/
// enforceGovernance() actually read -- this builds the minimal shape from
// already-existing data, reusing REC_TO_DECISION/ALERT_TO_DECISION (the
// same maps decisionsFromRecommendations()/decisionsFromAlerts() use) rather
// than inventing a second mapping. `priority`/`confidence` here are
// governance-input approximations from severity (same severity->confidence
// convention already used in decisionsFromRecommendations()/
// decisionsFromAlerts() above) -- not the same as the priority_score
// computed for the Decision Center, which needs a health-score/trend
// lookup this adapter deliberately skips (governance only needs to know
// "does this decision's priority require high confidence").
// ─────────────────────────────────────────────
function decisionShapeForGovernance(source, row) {
  const map = source === 'recommendation' ? REC_TO_DECISION : ALERT_TO_DECISION;
  const code = source === 'recommendation' ? row.rule_code : row.alert_code;
  const mapping = map[code];
  return {
    decision_type: mapping ? mapping.type : null,
    priority: row.severity === 'critical' ? 'critical' : 'high',
    confidence: row.severity === 'critical' ? 'high' : 'medium',
    suggested_action: source === 'recommendation' ? row.recommendation_body : (row.alert_message || row.message),
  };
}

// ─────────────────────────────────────────────
// Executive Diagnosis Card adapter (Phase X.5). Unifies a rule-engine
// decision (already fully shaped by decisionsFromRuleEngine()/
// decisionsFromRuleEngineLog() above) with a raw recommendation/alert row
// (from recommendationEngine.loadActiveRecommendations()/alertEngine.
// loadActiveAlerts()) into ONE card-ready shape, so the dashboard can render
// Decision/Recommendation/Framework/Evidence/Governance identically
// regardless of source. Reuses REC_TO_DECISION/ALERT_TO_DECISION/
// DECISION_LABELS -- the exact same mapping tables decisionsFromRecommendations()/
// decisionsFromAlerts()/decisionShapeForGovernance() already use -- rather
// than inventing a second lookup. `framework`/`category` are honestly null
// for recommendation-/alert-sourced findings: those rules are not
// Framework-attributed (see ruleRegistrySeed.js's `attributed()` entries
// for the handful that document a cross-reference), and forcing a value
// here would be exactly the kind of fabrication this phase must not do.
// ─────────────────────────────────────────────
function findingShapeForCard(source, row) {
  if (source === 'rule_engine') {
    return {
      source: 'rule_engine',
      source_id: row.rule_id || row.source_id || null,
      decision_type: row.decision_type,
      decision_label: row.decision_label || DECISION_LABELS[row.decision_type] || null,
      priority: row.priority,
      confidence: row.confidence,
      suggested_action: row.suggested_action,
      framework: row.framework || null,
      framework_name: row.framework_name || null,
      category: row.category || null,
      evidence: row.evidence || null,
      governance_state: row.governance_state || null,
      // Phase X.6 -- Executive Memory: already computed inside
      // orchestrateIntelligence()'s applyHistoricalLearning() call for
      // rule-engine-sourced decisions -- passed through, never recomputed
      // here (recomputing would double-apply the confidence downgrade).
      historical_note: row.historical_note || null,
      historical_effectiveness: row.historical_effectiveness || null,
    };
  }

  const map = source === 'recommendation' ? REC_TO_DECISION : ALERT_TO_DECISION;
  const code = source === 'recommendation' ? row.rule_code : row.alert_code;
  const mapping = map[code];

  return {
    source,
    source_id: code,
    decision_type: mapping ? mapping.type : null,
    decision_label: mapping ? DECISION_LABELS[mapping.type] : null,
    priority: row.severity === 'critical' ? 'critical' : 'high',
    confidence: row.severity === 'critical' ? 'high' : 'medium',
    suggested_action: source === 'recommendation' ? row.recommendation_body : (row.alert_message || row.message),
    framework: null,
    framework_name: null,
    category: null,
    evidence: source === 'recommendation'
      ? { metric: row.metric_key, actual: row.evidence, threshold: row.threshold }
      : { detected_value: row.detected_value, threshold_value: row.threshold_value },
    governance_state: row.governance_state || null,
  };
}

// ─────────────────────────────────────────────
// Persist a governed decision's state back onto the row it came from, keyed
// by the same (code, entity_meta_id) pattern upsertRecommendation()/
// upsertAlert() already use for dedup -- computed once (inside
// orchestrateIntelligence(), where full currentMetrics/diagnosis context
// exists), read by every later caller (decisionsFromRecommendations()/
// decisionsFromAlerts() above, and any direct SELECT * against these
// tables) -- never recomputed.
// ─────────────────────────────────────────────
function persistGovernanceState(table, codeColumn, code, entityMetaId, governanceState, dbHandle = db) {
  const activeCondition = table === 'recommendation_log'
    ? 'dismissed_at IS NULL'
    : `status IN ('active','snoozed')`;
  dbHandle.run(
    `UPDATE ${table} SET governance_state = ? WHERE ${codeColumn} = ? AND entity_meta_id = ? AND ${activeCondition}`,
    [governanceState, code, entityMetaId]
  );
}

// ─────────────────────────────────────────────
// Build a decision object from a recommendation
// ─────────────────────────────────────────────
function decisionsFromRecommendations(adAccountId) {
  const recs = db.all(`
    SELECT r.*, c.name as campaign_name, c.objective, c.status
    FROM recommendation_log r
    LEFT JOIN campaigns c ON c.meta_campaign_id = r.entity_meta_id
    WHERE r.ad_account_id = ? AND r.dismissed_at IS NULL AND r.action_taken IS NOT 1
    ORDER BY CASE r.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END
  `, [adAccountId]);

  const decisions = [];
  for (const rec of recs) {
    const mapping = resolveDecisionMapping(rec.objective, rec.rule_code, REC_TO_DECISION);
    if (!mapping) continue;

    const latestScore = db.get(`
      SELECT health_score FROM health_score_history
      WHERE entity_meta_id = ? ORDER BY calculated_at DESC LIMIT 1
    `, [rec.entity_meta_id]);

    const priorityResult = computePriorityScore({
      healthScore:     latestScore?.health_score || 50,
      alertSeverity:   rec.severity,
      alertCount:      1,
      trendDirection:  getTrendForEntity(rec.entity_meta_id),
      objectiveWeight: resolveProfile(rec.objective).priorityWeight ?? 1.0,
    });

    // MAIFS enforcement (Phase X.3): governance_state is persisted by
    // orchestrateIntelligence() at the point this recommendation was
    // generated (full currentMetrics/diagnosis context available there) --
    // read back here and applied the same way decisionsFromRuleEngineLog()
    // already downgrades rule-engine decisions, never recomputed.
    const governanceFailed = rec.governance_state === 'failed';

    decisions.push({
      id:              uuidv4(),
      source:          'recommendation',
      source_id:       rec.id,
      meta_campaign_id: rec.entity_meta_id,
      campaign_name:   rec.campaign_name || rec.entity_label,
      objective:       rec.objective,
      decision_type:   mapping.type,
      decision_label:  DECISION_LABELS[mapping.type],
      priority:        governanceFailed ? 'observation_only' : priorityResult.priority,
      priority_score:  governanceFailed ? 0 : priorityResult.priority_score,
      reason:          rec.recommendation_title,
      detail:          rec.recommendation_body,
      suggested_action: actionText(mapping.type, rec.campaign_name || rec.entity_label, rec.objective),
      supporting_metrics: rec.metric_snapshot ? JSON.parse(rec.metric_snapshot) : {},
      health_score:    latestScore?.health_score || null,
      confidence:      rec.severity === 'critical' ? 'high' : 'medium',
      governance_state: rec.governance_state || null,
    });
  }
  return decisions;
}

// ─────────────────────────────────────────────
// Build decisions from active alerts
// ─────────────────────────────────────────────
function decisionsFromAlerts(adAccountId) {
  const alerts = db.all(`
    SELECT a.*, c.name as campaign_name, c.objective
    FROM active_alerts a
    LEFT JOIN campaigns c ON c.meta_campaign_id = a.entity_meta_id
    WHERE a.ad_account_id = ? AND a.status = 'active'
      AND (a.snoozed_until IS NULL OR a.snoozed_until < datetime('now'))
    ORDER BY CASE a.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END
  `, [adAccountId]);

  const decisions = [];
  for (const alert of alerts) {
    const mapping = resolveDecisionMapping(alert.objective, alert.alert_code, ALERT_TO_DECISION);
    if (!mapping) continue;

    const latestScore = db.get(`
      SELECT health_score FROM health_score_history
      WHERE entity_meta_id = ? ORDER BY calculated_at DESC LIMIT 1
    `, [alert.entity_meta_id]);

    const priorityResult = computePriorityScore({
      healthScore:     latestScore?.health_score || 50,
      alertSeverity:   alert.severity,
      alertCount:      alert.occurrence_count || 1,
      trendDirection:  getTrendForEntity(alert.entity_meta_id),
      objectiveWeight: resolveProfile(alert.objective).priorityWeight ?? 1.0,
    });

    // MAIFS enforcement (Phase X.3) -- see decisionsFromRecommendations()'s
    // identical comment; same persisted-once, read-many pattern.
    const governanceFailed = alert.governance_state === 'failed';

    decisions.push({
      id:              uuidv4(),
      source:          'alert',
      source_id:       alert.id,
      meta_campaign_id: alert.entity_meta_id,
      campaign_name:   alert.campaign_name || alert.entity_label,
      objective:       alert.objective,
      decision_type:   mapping.type,
      decision_label:  DECISION_LABELS[mapping.type],
      priority:        governanceFailed ? 'observation_only' : priorityResult.priority,
      priority_score:  governanceFailed ? 0 : priorityResult.priority_score,
      reason:          alert.alert_message || alert.alert_code,
      detail:          `Alert detected ${alert.occurrence_count || 1} time(s). First detected: ${alert.first_detected_at?.slice(0,10)}`,
      suggested_action: actionText(mapping.type, alert.campaign_name || alert.entity_label, alert.objective),
      supporting_metrics: {
        detected_value:  alert.detected_value,
        threshold_value: alert.threshold_value,
        occurrence_count: alert.occurrence_count,
      },
      health_score:    latestScore?.health_score || null,
      confidence:      alert.severity === 'critical' ? 'high' : 'medium',
      governance_state: alert.governance_state || null,
    });
  }
  return decisions;
}

// ─────────────────────────────────────────────
// Build decisions from opportunities
// ─────────────────────────────────────────────
function decisionsFromOpportunities() {
  const opportunities = detectAllOpportunities(20);
  return opportunities.map(opp => {
    const mapping = resolveDecisionMapping(opp.objective, opp.type, OPPORTUNITY_TO_DECISION)
      || { type: 'REVIEW_PERFORMANCE', base_priority: 'low' };
    const priorityResult = computePriorityScore({
      healthScore:     opp.health_score || 50,
      alertSeverity:   null,
      alertCount:      0,
      trendDirection:  opp.supporting_metrics?.trend_direction || 'stable',
      objectiveWeight: resolveProfile(opp.objective).priorityWeight ?? 1.0,
    });

    return {
      id:              uuidv4(),
      source:          'opportunity',
      source_id:       null,
      meta_campaign_id: opp.meta_campaign_id,
      campaign_name:   opp.campaign_name,
      objective:       opp.objective,
      decision_type:   mapping.type,
      decision_label:  DECISION_LABELS[mapping.type],
      priority:        opp.priority,
      priority_score:  priorityResult.priority_score,
      reason:          opp.reason,
      detail:          opp.expected_impact,
      suggested_action: opp.suggested_action,
      supporting_metrics: opp.supporting_metrics || {},
      health_score:    opp.health_score,
      confidence:      opp.confidence,
      expected_impact: opp.expected_impact,
    };
  });
}

// ─────────────────────────────────────────────
// Build decisions from Rule Engine output (Phase 11 — Framework Rule-Based
// Intelligence). Takes an already-computed ruleEngine.executeRules().fired
// array for ONE campaign (the caller already has current/deltas from its
// own insights fetch) -- this function does no metric evaluation of its
// own, it only maps a fired native rule onto the same Decision shape every
// other decisionsFromX() function here produces, so the Decision Center/
// dashboard render Rule Engine findings identically to every other
// decision source, with the addition of rule_id/framework/rule_name/
// evidence fields for full Framework/Rule traceability.
// ─────────────────────────────────────────────
function decisionsFromRuleEngine(campaign, adAccountId, ruleEngineFired = []) {
  const latestScore = db.get(`
    SELECT health_score FROM health_score_history
    WHERE entity_meta_id = ? ORDER BY calculated_at DESC LIMIT 1
  `, [campaign.meta_campaign_id]);

  return ruleEngineFired.map(fired => {
    const priorityResult = computePriorityScore({
      healthScore:     latestScore?.health_score || 50,
      alertSeverity:   fired.severity,
      alertCount:      1,
      trendDirection:  getTrendForEntity(campaign.meta_campaign_id),
      objectiveWeight: resolveProfile(campaign.objective).priorityWeight ?? 1.0,
    });

    return {
      id:              uuidv4(),
      source:          'rule_engine',
      source_id:       fired.rule_id,
      meta_campaign_id: campaign.meta_campaign_id,
      campaign_name:   campaign.name,
      objective:       campaign.objective,
      decision_type:   fired.action.type,
      decision_label:  DECISION_LABELS[fired.action.type],
      priority:        priorityResult.priority,
      priority_score:  priorityResult.priority_score,
      reason:          fired.reason,
      detail:          fired.rule_name,
      suggested_action: fired.action.suggestedActionOverride || actionText(fired.action.type, campaign.name, campaign.objective),
      supporting_metrics: {},
      health_score:    latestScore?.health_score || null,
      confidence:      fired.severity === 'critical' ? 'high' : 'medium',
      // Framework/Rule attribution -- not present on other decision
      // sources, additive fields only.
      rule_id:         fired.rule_id,
      framework:       fired.framework,
      framework_name:  fired.framework_name,
      rule_name:       fired.rule_name,
      category:        fired.category,
      evidence:        fired.evidence,
      governance_state: fired.governance_state || null,
    };
  });
}

// ─────────────────────────────────────────────
// Persist Rule Engine firings (Phase 11) to rule_engine_log, mirroring
// upsertRecommendation()'s own dedup lifecycle (one active row per
// rule+entity, refreshed in place on repeat firings, dismissed when a
// rule that previously fired no longer does). This is what lets
// generateTodaysDecisions() -- the Decision Center's data source -- see
// Rule Engine findings from campaigns it isn't actively re-analyzing this
// moment, exactly like it already does for recommendation_log/
// active_alerts.
// ─────────────────────────────────────────────
function persistRuleEngineFirings(adAccountId, campaign, ruleEngineFired = [], entityType = 'campaign') {
  const now = new Date().toISOString();

  // Phase X.1 (Runtime Unification) fix: entity_type was previously
  // hardcoded to the literal 'campaign' regardless of what entity this was
  // actually called for -- harmless while only campaign grain ever called
  // this function, but would have mislabeled every ad_set/ad rule firing
  // once that grain was wired in (and, since decisionsFromRuleEngineLog()
  // doesn't filter by entity_type, an ad set's own meta_adset_id would have
  // been exposed as `meta_campaign_id` in the Decision Center feed).
  //
  // Phase X.1 also wraps every write in one transaction instead of one
  // db.run() per fired rule -- database.js's persist() re-serializes and
  // rewrites the entire DB file on every write outside a transaction
  // (see CLAUDE.md), so this was previously up to (fired-rules + 1)
  // full-DB rewrites per request; now it's one.
  db.transaction(tx => {
    for (const fired of ruleEngineFired) {
      const existing = tx.get(
        `SELECT id FROM rule_engine_log WHERE rule_id = ? AND entity_meta_id = ? AND dismissed_at IS NULL`,
        [fired.rule_id, campaign.meta_campaign_id]
      );
      if (existing) {
        tx.run(
          `UPDATE rule_engine_log
           SET last_generated_at = ?, evidence = ?, category = ?, governance_state = ?
           WHERE id = ?`,
          [now, JSON.stringify(fired.evidence || []), fired.category || null, fired.governance_state || null, existing.id]
        );
      } else {
        tx.run(
          `INSERT INTO rule_engine_log
             (id, rule_id, framework, rule_name, ad_account_id, entity_type, entity_meta_id,
              entity_label, objective, category, severity, reason, evidence, decision_type,
              governance_state, generated_at, last_generated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            uuidv4(), fired.rule_id, fired.framework, fired.rule_name, adAccountId, entityType,
            campaign.meta_campaign_id, campaign.name, campaign.objective, fired.category || null,
            fired.severity, fired.reason, JSON.stringify(fired.evidence || []), fired.action.type,
            fired.governance_state || null, now, now,
          ]
        );
      }
    }

    // Resolve (dismiss) any previously-fired rule for this entity that did
    // not fire this time -- mirrors resolveRecommendation()'s own
    // auto-dismiss behavior so stale findings don't linger indefinitely.
    const firedIds = ruleEngineFired.map(f => f.rule_id);
    if (firedIds.length > 0) {
      tx.run(
        `UPDATE rule_engine_log SET dismissed_at = ?
         WHERE entity_meta_id = ? AND dismissed_at IS NULL AND rule_id NOT IN (${firedIds.map(() => '?').join(',')})`,
        [now, campaign.meta_campaign_id, ...firedIds]
      );
    } else {
      tx.run(
        `UPDATE rule_engine_log SET dismissed_at = ? WHERE entity_meta_id = ? AND dismissed_at IS NULL`,
        [now, campaign.meta_campaign_id]
      );
    }
  });
}

// ─────────────────────────────────────────────
// Read persisted Rule Engine firings back as Decision-shaped objects, for
// generateTodaysDecisions() (the Decision Center's data source) -- the
// same read-then-shape pattern decisionsFromRecommendations()/
// decisionsFromAlerts() already use against their own DB tables.
// ─────────────────────────────────────────────
function decisionsFromRuleEngineLog(adAccountId) {
  const rows = db.all(
    `SELECT * FROM rule_engine_log WHERE ad_account_id = ? AND dismissed_at IS NULL
     ORDER BY last_generated_at DESC`,
    [adAccountId]
  );

  return rows.map(row => {
    const latestScore = db.get(
      `SELECT health_score FROM health_score_history WHERE entity_meta_id = ? ORDER BY calculated_at DESC LIMIT 1`,
      [row.entity_meta_id]
    );
    const priorityResult = computePriorityScore({
      healthScore:     latestScore?.health_score || 50,
      alertSeverity:   row.severity,
      alertCount:      1,
      trendDirection:  getTrendForEntity(row.entity_meta_id),
      objectiveWeight: resolveProfile(row.objective).priorityWeight ?? 1.0,
    });

    // MAIFS enforcement (Phase 4): a rule whose own governance check failed
    // is downgraded to observation_only regardless of its computed
    // priority score -- governance changes runtime behavior here, not
    // just a reported field.
    const priority = row.governance_state === 'failed' ? 'observation_only' : priorityResult.priority;

    return {
      id:              uuidv4(),
      source:          'rule_engine',
      source_id:       row.rule_id,
      meta_campaign_id: row.entity_meta_id,
      campaign_name:   row.entity_label,
      objective:       row.objective,
      decision_type:   row.decision_type,
      decision_label:  DECISION_LABELS[row.decision_type],
      priority,
      priority_score:  row.governance_state === 'failed' ? 0 : priorityResult.priority_score,
      reason:          row.reason,
      detail:          row.rule_name,
      suggested_action: actionText(row.decision_type, row.entity_label, row.objective),
      supporting_metrics: row.evidence ? JSON.parse(row.evidence) : {},
      health_score:    latestScore?.health_score || null,
      confidence:      row.severity === 'critical' ? 'high' : 'medium',
      rule_id:         row.rule_id,
      framework:       row.framework,
      rule_name:       row.rule_name,
      category:        row.category,
      governance_state: row.governance_state,
    };
  });
}

// ─────────────────────────────────────────────
// Action text templates
// ─────────────────────────────────────────────
const DEFAULT_ACTION_TEXT_TEMPLATES = {
  SCALE_CAMPAIGN:     (name) => `Increase budget for "${name}" by 20–50%.`,
  PAUSE_CAMPAIGN:     (name) => `Pause "${name}" and review performance before re-enabling.`,
  REFRESH_CREATIVE:   (name) => `Launch 2–3 new creative variations in "${name}".`,
  EXPAND_AUDIENCE:    (name) => `Duplicate ad sets in "${name}" with expanded or lookalike audiences.`,
  FIX_TRACKING:       (name) => `Audit the conversion events and pixel setup for "${name}".`,
  BUDGET_WARNING:     (name) => `Check remaining budget for "${name}" — may exhaust before day end.`,
  REVIEW_PERFORMANCE: (name) => `Review recent performance changes in "${name}" and identify root cause.`,
  REALLOCATE_BUDGET:  (name) => `Consider moving budget from underperformers into "${name}".`,
};

// `objective` is optional -- when provided, a profile's own
// actionTextOverrides[type] (if any) wins over the default template. No
// profile currently defines one (same "hook, not invented content"
// rationale as resolveDecisionMapping above).
function actionText(type, name, objective = null) {
  const override = objective ? resolveProfile(objective).actionTextOverrides?.[type] : null;
  const template = override || DEFAULT_ACTION_TEXT_TEMPLATES[type];
  return template ? template(name) : `Review campaign "${name}".`;
}

// ─────────────────────────────────────────────
// Dedup: one decision per campaign per type
// ─────────────────────────────────────────────
function deduplicateDecisions(decisions) {
  const seen = new Set();
  return decisions.filter(d => {
    const key = `${d.meta_campaign_id}:${d.decision_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────────
// MAIN: Generate today's priority actions
// ─────────────────────────────────────────────
function generateTodaysDecisions(adAccountId) {
  const fromRecs       = decisionsFromRecommendations(adAccountId);
  const fromAlerts     = decisionsFromAlerts(adAccountId);
  const fromOpps       = decisionsFromOpportunities();
  // Phase 11 — Rule Engine findings persisted by insights.js's routes via
  // persistRuleEngineFirings(), read back here so the Decision Center
  // reflects Framework rule activity even for campaigns not being viewed
  // in this exact moment (closing the Decision Engine/Rule Engine
  // disconnect the Framework Runtime Evidence audit found).
  const fromRuleEngine = decisionsFromRuleEngineLog(adAccountId);

  // Filter opportunities to this account's campaigns
  const accountCampaignIds = new Set(
    db.all('SELECT meta_campaign_id FROM campaigns WHERE ad_account_id = ?', [adAccountId])
      .map(c => c.meta_campaign_id)
  );
  const filteredOpps = fromOpps.filter(d => accountCampaignIds.has(d.meta_campaign_id));

  const allDecisions = [...fromAlerts, ...fromRecs, ...fromRuleEngine, ...filteredOpps];
  const deduped = deduplicateDecisions(allDecisions);

  // Sort by priority_score descending
  deduped.sort((a, b) => b.priority_score - a.priority_score);

  return {
    decisions:          deduped,
    total:              deduped.length,
    by_priority: {
      critical: deduped.filter(d => d.priority === 'critical').length,
      high:     deduped.filter(d => d.priority === 'high').length,
      medium:   deduped.filter(d => d.priority === 'medium').length,
      low:      deduped.filter(d => d.priority === 'low').length,
    },
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// Persist decisions to decision_history
// ─────────────────────────────────────────────
function persistDecisions(adAccountId, decisions) {
  const now = new Date().toISOString();
  // Only persist if table exists
  try {
    db.get('SELECT id FROM decision_history LIMIT 1');
  } catch {
    return; // table not yet created
  }

  for (const d of decisions) {
    // Skip if already persisted today (same campaign + type)
    const existing = db.get(`
      SELECT id FROM decision_history
      WHERE meta_campaign_id = ? AND decision_type = ?
        AND date(created_at) = date('now') AND status = 'pending'
    `, [d.meta_campaign_id, d.decision_type]);

    if (existing) continue;

    db.run(`
      INSERT INTO decision_history (
        id, ad_account_id, meta_campaign_id, campaign_name, objective,
        decision_type, priority, priority_score, reason, supporting_metrics,
        suggested_action, expected_impact, confidence, health_score,
        status, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      uuidv4(), adAccountId, d.meta_campaign_id, d.campaign_name, d.objective || null,
      d.decision_type, d.priority, d.priority_score, d.reason,
      JSON.stringify(d.supporting_metrics || {}),
      d.suggested_action, d.expected_impact || null, d.confidence || null,
      d.health_score || null, 'pending', now, now,
    ]);
  }
}

// ─────────────────────────────────────────────
// Load decision history from DB
// ─────────────────────────────────────────────
function getDecisionHistory(adAccountId, limit = 50, status = null) {
  const params = [adAccountId];
  let where = 'WHERE dh.ad_account_id = ?';
  if (status) { where += ' AND dh.status = ?'; params.push(status); }
  return db.all(`
    SELECT dh.*
    FROM decision_history dh
    ${where}
    ORDER BY dh.priority_score DESC, dh.created_at DESC
    LIMIT ?
  `, [...params, limit]);
}

module.exports = {
  generateTodaysDecisions,
  persistDecisions,
  getDecisionHistory,
  decisionsFromRuleEngine,
  persistRuleEngineFirings,
  decisionsFromRuleEngineLog,
  decisionsFromRecommendations,
  decisionsFromAlerts,
  decisionShapeForGovernance,
  persistGovernanceState,
  findingShapeForCard,
  DECISION_LABELS,
};
