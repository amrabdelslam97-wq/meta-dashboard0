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

    decisions.push({
      id:              uuidv4(),
      source:          'recommendation',
      source_id:       rec.id,
      meta_campaign_id: rec.entity_meta_id,
      campaign_name:   rec.campaign_name || rec.entity_label,
      objective:       rec.objective,
      decision_type:   mapping.type,
      decision_label:  DECISION_LABELS[mapping.type],
      priority:        priorityResult.priority,
      priority_score:  priorityResult.priority_score,
      reason:          rec.recommendation_title,
      detail:          rec.recommendation_body,
      suggested_action: actionText(mapping.type, rec.campaign_name || rec.entity_label, rec.objective),
      supporting_metrics: rec.metric_snapshot ? JSON.parse(rec.metric_snapshot) : {},
      health_score:    latestScore?.health_score || null,
      confidence:      rec.severity === 'critical' ? 'high' : 'medium',
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

    decisions.push({
      id:              uuidv4(),
      source:          'alert',
      source_id:       alert.id,
      meta_campaign_id: alert.entity_meta_id,
      campaign_name:   alert.campaign_name || alert.entity_label,
      objective:       alert.objective,
      decision_type:   mapping.type,
      decision_label:  DECISION_LABELS[mapping.type],
      priority:        priorityResult.priority,
      priority_score:  priorityResult.priority_score,
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
  const fromRecs     = decisionsFromRecommendations(adAccountId);
  const fromAlerts   = decisionsFromAlerts(adAccountId);
  const fromOpps     = decisionsFromOpportunities();

  // Filter opportunities to this account's campaigns
  const accountCampaignIds = new Set(
    db.all('SELECT meta_campaign_id FROM campaigns WHERE ad_account_id = ?', [adAccountId])
      .map(c => c.meta_campaign_id)
  );
  const filteredOpps = fromOpps.filter(d => accountCampaignIds.has(d.meta_campaign_id));

  const allDecisions = [...fromAlerts, ...fromRecs, ...filteredOpps];
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
  DECISION_LABELS,
};
