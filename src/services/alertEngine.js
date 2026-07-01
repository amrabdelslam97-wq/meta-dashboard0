/**
 * Alert Engine (Phase 2 — Minimal)
 *
 * Evaluates active alert_rules against current metrics (and prior period metrics).
 * Writes to / updates active_alerts with persistence tracking.
 *
 * Phase 2 alerts:
 *   CPM_SPIKE    — CPM increased > 30% vs prior period
 *   CTR_DROP     — CTR dropped > 30% vs prior period
 *   ROAS_BELOW_ONE — ROAS < 1.0 (absolute threshold)
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

// ─────────────────────────────────────────────
// Load all active alert rules
// ─────────────────────────────────────────────
function loadAlertRules() {
  return db.all(`SELECT * FROM alert_rules WHERE is_active = 1`);
}

// ─────────────────────────────────────────────
// Check if an alert condition is triggered
// Returns { triggered: bool, detectedValue, thresholdValue, message }
// ─────────────────────────────────────────────
function evaluateAlertRule(rule, currentMetrics, priorMetrics) {
  const { metric_key, trigger_type, trigger_value } = rule;

  const current = currentMetrics[metric_key] !== undefined
    ? parseFloat(currentMetrics[metric_key])
    : null;

  // Absolute threshold (e.g. ROAS < 1.0)
  if (trigger_type === 'threshold_absolute') {
    if (current === null) return { triggered: false };

    // trigger_value is the threshold — alert when current is BELOW it
    const triggered = current < trigger_value;
    return {
      triggered,
      detectedValue:  Math.round(current * 100) / 100,
      thresholdValue: trigger_value,
      message: triggered
        ? `${metric_key.toUpperCase()} is ${current.toFixed(2)}, below threshold of ${trigger_value}`
        : null,
    };
  }

  // Percentage change vs prior period
  if (trigger_type === 'threshold_pct_change') {
    if (current === null) return { triggered: false };
    if (!priorMetrics) return { triggered: false };

    const prior = priorMetrics[metric_key] !== undefined
      ? parseFloat(priorMetrics[metric_key])
      : null;

    if (prior === null || prior === 0) return { triggered: false };

    const changePct = ((current - prior) / prior) * 100;

    // trigger_value can be positive (spike) or negative (drop)
    // Positive trigger_value: alert when change > threshold (e.g. CPM spike +30%)
    // Negative trigger_value: alert when change < threshold (e.g. CTR drop -30%)
    const triggered = trigger_value >= 0
      ? changePct > trigger_value
      : changePct < trigger_value;

    return {
      triggered,
      detectedValue:  Math.round(changePct * 10) / 10, // the pct change
      thresholdValue: trigger_value,
      currentValue:   Math.round(current * 100) / 100,
      priorValue:     Math.round(prior * 100) / 100,
      message: triggered
        ? `${metric_key.toUpperCase()} changed by ${changePct.toFixed(1)}% ` +
          `(from ${prior.toFixed(2)} to ${current.toFixed(2)}), ` +
          `threshold: ${trigger_value > 0 ? '+' : ''}${trigger_value}%`
        : null,
    };
  }

  return { triggered: false };
}

// ─────────────────────────────────────────────
// Upsert alert state
// If active alert exists for same entity+code → update last_detected_at + count
// If not → insert new record
// If condition clears → resolve existing alert
// ─────────────────────────────────────────────
function upsertAlert(rule, campaign, adAccountId, evalResult, entityType = 'campaign') {
  const now = new Date().toISOString();
  const { detectedValue, thresholdValue, message } = evalResult;

  // Check for existing active/snoozed alert
  const existing = db.get(
    `SELECT id, occurrence_count FROM active_alerts
     WHERE alert_code = ? AND entity_meta_id = ?
       AND status IN ('active','snoozed')`,
    [rule.alert_code, campaign.meta_campaign_id]
  );

  if (existing) {
    db.run(
      `UPDATE active_alerts
       SET last_detected_at  = ?,
           occurrence_count  = ?,
           detected_value    = ?,
           alert_message     = ?
       WHERE id = ?`,
      [
        now,
        (existing.occurrence_count || 1) + 1,
        detectedValue,
        message,
        existing.id,
      ]
    );
    return existing.id;
  }

  // Check for previously resolved alert (to carry occurrence_count forward)
  const lastResolved = db.get(
    `SELECT occurrence_count FROM active_alerts
     WHERE alert_code = ? AND entity_meta_id = ?
       AND status = 'resolved'
     ORDER BY resolved_at DESC LIMIT 1`,
    [rule.alert_code, campaign.meta_campaign_id]
  );

  const id = uuidv4();
  db.run(
    `INSERT INTO active_alerts
       (id, ad_account_id, alert_rule_id, alert_code, entity_type,
        entity_meta_id, entity_label, severity, detected_value, threshold_value,
        alert_message, status, first_detected_at, last_detected_at,
        occurrence_count, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      adAccountId,
      rule.id,
      rule.alert_code,
      entityType,
      campaign.meta_campaign_id,
      campaign.name,
      rule.severity,
      detectedValue,
      thresholdValue,
      message,
      'active',
      now,
      now,
      lastResolved ? (lastResolved.occurrence_count + 1) : 1,
      now,
    ]
  );

  return id;
}

// ─────────────────────────────────────────────
// Resolve alerts that no longer apply
// ─────────────────────────────────────────────
function resolveAlert(alertCode, entityMetaId) {
  const now = new Date().toISOString();
  db.run(
    `UPDATE active_alerts
     SET status = 'resolved', resolved_at = ?
     WHERE alert_code = ? AND entity_meta_id = ?
       AND status IN ('active','snoozed')`,
    [now, alertCode, entityMetaId]
  );
}

// ─────────────────────────────────────────────
// MAIN: Run alert engine for one campaign
// Returns array of active alerts
// ─────────────────────────────────────────────
function runAlertEngine(campaign, currentMetrics, priorMetrics, adAccountId, entityType = 'campaign') {
  const rules = loadAlertRules();
  const activeAlerts = [];

  for (const rule of rules) {
    // Check objective scope (null = all objectives)
    if (rule.objective_scope) {
      const scopes = rule.objective_scope.split(',').map(s => s.trim());
      if (!scopes.includes(campaign.objective)) continue;
    }

    const evalResult = evaluateAlertRule(rule, currentMetrics, priorMetrics);

    if (evalResult.triggered) {
      upsertAlert(rule, campaign, adAccountId, evalResult, entityType);
      activeAlerts.push({
        alert_code:    rule.alert_code,
        alert_name:    rule.alert_name,
        severity:      rule.severity,
        message:       evalResult.message,
        detected_value:  evalResult.detectedValue,
        threshold_value: evalResult.thresholdValue,
      });
    } else {
      // Condition cleared — resolve any existing alert for this rule+entity
      resolveAlert(rule.alert_code, campaign.meta_campaign_id);
    }
  }

  return activeAlerts;
}

// ─────────────────────────────────────────────
// Load active (non-snoozed, non-resolved) alerts
// for a campaign from DB
// ─────────────────────────────────────────────
function loadActiveAlerts(metaCampaignId, entityType = 'campaign') {
  return db.all(
    `SELECT
       a.alert_code,
       r.alert_name,
       a.severity,
       a.alert_message,
       a.detected_value,
       a.threshold_value,
       a.first_detected_at,
       a.last_detected_at,
       a.occurrence_count,
       a.status
     FROM active_alerts a
     LEFT JOIN alert_rules r ON a.alert_rule_id = r.id
     WHERE a.entity_meta_id = ?
       AND a.status = 'active'
       AND (a.snoozed_until IS NULL OR a.snoozed_until < datetime('now'))
     ORDER BY
       CASE a.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
       a.last_detected_at DESC`,
    [metaCampaignId]
  );
}

module.exports = {
  runAlertEngine,
  loadActiveAlerts,
  evaluateAlertRule,
};
