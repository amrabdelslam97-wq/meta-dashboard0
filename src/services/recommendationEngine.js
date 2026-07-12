/**
 * Recommendation Engine (Phase 2 — Minimal)
 *
 * Evaluates active recommendation_rules against campaign metrics.
 * Writes results to recommendation_log with deduplication (one per rule+entity per day).
 *
 * Phase 2 rules:
 *   LOW_ROAS       — ROAS < 1.0   (sales)
 *   LOW_CTR        — CTR < 1%     (all objectives)
 *   HIGH_FREQUENCY — Frequency > 4 (all objectives)
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
// evaluateCondition()/loadApplicableRules() now live in
// recommendationResolver.js (the single source of truth for "which rules
// apply to this objective and do they fire") -- re-exported below for
// backward compatibility with existing importers of this module.
const { evaluateCondition, loadApplicableRules } = require('./recommendationResolver');

// ─────────────────────────────────────────────
// Confidence: how far past the threshold the actual value is.
// A metric just barely past the threshold = lower confidence.
// A metric far past the threshold = higher confidence.
// Presentation-only — does not affect whether the rule fires.
// ─────────────────────────────────────────────
function computeConfidence(condition, actualValue) {
  if (actualValue === null || actualValue === undefined) return null;
  // Bug fix (Phase 7B): condition objects use { metric, operator, value }, not { threshold }.
  // The previous destructure of `threshold` was always undefined, causing every call to
  // hit the early-return neutral baseline of 70 regardless of actual deviation.
  const threshold = condition.value;
  if (threshold === null || threshold === undefined || threshold === 0) return 70; // neutral baseline when threshold is 0/unset

  const v = parseFloat(actualValue);
  const deviation = Math.abs(v - threshold) / Math.abs(threshold); // relative distance from threshold

  // Map deviation to a confidence band: 60% (just crossed) -> 98% (far past threshold)
  const confidence = 60 + Math.min(deviation * 100, 38);
  return Math.round(confidence);
}

// ─────────────────────────────────────────────
// Resolve (auto-dismiss) a recommendation that no longer applies (FIX 3)
// Called when a rule's condition is no longer met during an Analyze run.
// ─────────────────────────────────────────────
function resolveRecommendation(ruleCode, entityMetaId) {
  const now = new Date().toISOString();
  // recommendation_log has dismissed_at but no updated_at column
  db.run(
    `UPDATE recommendation_log
     SET dismissed_at = ?
     WHERE rule_code = ? AND entity_meta_id = ? AND dismissed_at IS NULL`,
    [now, ruleCode, entityMetaId]
  );
}

// ─────────────────────────────────────────────
// Write or update a recommendation log entry.
// Dedup is handled inline in upsertRecommendation() by checking for an
// existing non-dismissed row for the same rule+entity and updating it
// in place, rather than a separate once-per-day check.
// ─────────────────────────────────────────────
function upsertRecommendation(rule, campaign, adAccountId, metrics, healthScore, entityType = 'campaign') {
  const now = new Date().toISOString();

  // Look up by the SAME grain as idx_recommendation_log_dedup (rule_code,
  // entity_meta_id, date(generated_at)) -- not just "non-dismissed" -- so a
  // rule re-firing after being dismissed earlier the same day updates that
  // row in place instead of attempting a second INSERT for the same day,
  // which violated the unique index and crashed the insights endpoint.
  const existing = db.get(
    `SELECT id FROM recommendation_log
     WHERE rule_code = ?
       AND entity_meta_id = ?
       AND date(generated_at) = date(?)`,
    [rule.rule_code, campaign.meta_campaign_id, now]
  );

  if (existing) {
    // FIX 1 (Phase 9): Also refresh metric_snapshot, health_score, and evidence fields
    // so that displayed evidence always reflects the CURRENT analysis, not the first one.
    // Root cause of stale evidence bug: previously only last_generated_at was updated.
    db.run(
      `UPDATE recommendation_log
       SET last_generated_at = ?,
           metric_snapshot = ?,
           health_score_at_generation = ?
       WHERE id = ?`,
      [
        now,
        JSON.stringify({
          ctr:       metrics.ctr       ?? null,
          roas:      metrics.roas      ?? null,
          frequency: metrics.frequency ?? null,
          cpm:       metrics.cpm       ?? null,
          cpr:       metrics.cpr       ?? null,
          cpl:       metrics.cpl       ?? null,
          spend:     metrics.spend     ?? null,
        }),
        healthScore ?? null,
        existing.id,
      ]
    );
    return existing.id;
  }

  // Insert new entry
  const id = uuidv4();
  db.run(
    `INSERT INTO recommendation_log
       (id, rule_id, rule_code, ad_account_id, entity_type, entity_meta_id,
        entity_label, objective, severity, recommendation_title, recommendation_body,
        metric_snapshot, health_score_at_generation, reference_type,
        generated_at, last_generated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      rule.id,
      rule.rule_code,
      adAccountId,
      entityType,
      campaign.meta_campaign_id,
      campaign.name,
      campaign.objective,
      rule.severity,
      rule.recommendation_title,
      rule.recommendation_body,
      JSON.stringify({
        ctr:       metrics.ctr       ?? null,
        roas:      metrics.roas      ?? null,
        frequency: metrics.frequency ?? null,
        cpm:       metrics.cpm       ?? null,
        cpr:       metrics.cpr       ?? null,
        cpl:       metrics.cpl       ?? null,
        spend:     metrics.spend     ?? null,
      }),
      healthScore ?? null,
      'platform_default',
      now,
      now,
    ]
  );

  return id;
}

// ─────────────────────────────────────────────
// MAIN: Run recommendation engine for one campaign
// Returns array of fired recommendations
// ─────────────────────────────────────────────
function runRecommendationEngine(campaign, metrics, adAccountId, healthScore = null, entityType = 'campaign') {
  const rules = loadApplicableRules(campaign.objective);
  const fired = [];
  const suppressedCodes = new Set();

  for (const rule of rules) {
    // Skip suppressed rules
    if (suppressedCodes.has(rule.rule_code)) continue;

    // Parse condition
    let condition;
    try {
      condition = typeof rule.condition_logic === 'string'
        ? JSON.parse(rule.condition_logic)
        : rule.condition_logic;
    } catch {
      console.warn(`[Recommendations] Invalid condition_logic for rule ${rule.rule_code}`);
      continue;
    }

    // Defend against syntactically-valid JSON that's still the wrong shape
    // (e.g. missing `metric`) -- condition.metric.toUpperCase() below would
    // otherwise throw and abort the whole engine run for every remaining
    // rule and campaign in this pass. There is currently no write path
    // that can create such a row (no POST route for recommendation_rules),
    // but nothing enforces that invariant at read time either.
    if (typeof condition?.metric !== 'string' || !condition.metric) {
      console.warn(`[Recommendations] condition_logic for rule ${rule.rule_code} is missing a valid "metric" field`);
      continue;
    }

    // Evaluate
    const fires = evaluateCondition(condition, metrics);
    if (!fires) {
      // FIX 3 (Phase 9): auto-dismiss stale recommendations.
      // If a rule no longer meets its condition, close any open recommendation
      // so the user isn't shown advice that contradicts current metrics.
      resolveRecommendation(rule.rule_code, campaign.meta_campaign_id);
      continue;
    }

    // Write to DB
    upsertRecommendation(rule, campaign, adAccountId, metrics, healthScore, entityType);

    fired.push({
      rule_code:            rule.rule_code,
      recommendation_title: rule.recommendation_title,
      recommendation_body:  rule.recommendation_body,
      recommendation_type:  rule.recommendation_type,
      severity:             rule.severity,
      // Problem / Evidence / Threshold (Phase 7B — presentation fields, same condition data)
      problem:   `${condition.metric.toUpperCase()} ${condition.operator==='lt'?'below':condition.operator==='gt'?'above':'at'} expected range`,
      evidence:  metrics[condition.metric] ?? null,
      threshold: condition.value,
      confidence_pct: computeConfidence(condition, metrics[condition.metric]),
      triggered_by: {
        metric:    condition.metric,
        operator:  condition.operator,
        threshold: condition.value,
        actual:    metrics[condition.metric] ?? null,
      },
    });

    // Mark suppressed rules
    if (rule.suppresses_rule_codes) {
      const toSuppress = rule.suppresses_rule_codes.split(',').map(s => s.trim());
      toSuppress.forEach(code => suppressedCodes.add(code));
    }
  }

  return fired;
}

// ─────────────────────────────────────────────
// Load existing (non-dismissed) recommendations
// for a campaign from the log
// ─────────────────────────────────────────────
function loadActiveRecommendations(metaCampaignId, entityType = 'campaign') {
  const rows = db.all(
    `SELECT
       r.rule_code, r.recommendation_title, r.recommendation_body,
       r.severity, r.generated_at, r.last_generated_at,
       r.action_taken, r.action_notes, r.metric_snapshot, r.governance_state,
       rr.condition_logic
     FROM recommendation_log r
     LEFT JOIN recommendation_rules rr ON rr.rule_code = r.rule_code
     WHERE r.entity_meta_id = ?
       AND r.dismissed_at IS NULL
     ORDER BY
       CASE r.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
       r.last_generated_at DESC
     LIMIT 5`,
    [metaCampaignId]
  );

  // Enrich with Problem / Evidence / Threshold / Confidence (Phase 7B — Part 5)
  // Reuses already-stored metric_snapshot + the rule's own condition_logic.
  // No recalculation of whether the rule fires — purely presentational enrichment.
  return rows.map(row => {
    let evidenceValue = null;
    let threshold     = null;
    let metricKey      = null;
    let confidencePct  = null;

    try {
      const condition = row.condition_logic ? JSON.parse(row.condition_logic) : null;
      const snapshot   = row.metric_snapshot ? JSON.parse(row.metric_snapshot) : null;
      if (condition) {
        metricKey  = condition.metric;
        threshold  = condition.value;
        evidenceValue = snapshot ? snapshot[metricKey] ?? null : null;
        confidencePct = computeConfidence(condition, evidenceValue);
      }
    } catch { /* malformed snapshot/condition — leave fields null, never throws */ }

    return {
      rule_code:            row.rule_code,
      recommendation_title: row.recommendation_title,
      recommendation_body:  row.recommendation_body,
      severity:             row.severity,
      generated_at:         row.generated_at,
      last_generated_at:    row.last_generated_at,
      action_taken:         row.action_taken,
      action_notes:         row.action_notes,
      governance_state:     row.governance_state,
      problem:    metricKey ? `${metricKey.toUpperCase()} outside expected range` : null,
      evidence:   evidenceValue,
      threshold:  threshold,
      metric_key: metricKey,
      confidence_pct: confidencePct,
    };
  });
}

module.exports = {
  runRecommendationEngine,
  loadActiveRecommendations,
  computeConfidence,
  evaluateCondition,
  loadApplicableRules,
};
