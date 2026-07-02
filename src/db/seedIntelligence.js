/**
 * Intelligence Config Seeder
 *
 * Seeds:
 *  - objective_scoring_configs  (weights + default thresholds per objective)
 *  - recommendation_rules       (Phase 2 minimal: 3 rules)
 *  - alert_rules                (Phase 2 minimal: 3 rules)
 *
 * Does NOT seed benchmark_metrics or benchmark_industries -- those remain
 * empty until an operator explicitly configures account- or
 * industry-specific overrides via POST /settings/benchmarks. This is
 * intentional, not an oversight: benchmarkEngine/healthScoreEngine's
 * 3-tier resolution (account benchmark -> global benchmark -> platform
 * default) already falls back to objective_scoring_configs when no
 * benchmark_metrics row exists, so scoring works correctly with these
 * tables empty. (An earlier version of this comment claimed
 * benchmark_metrics was seeded here -- it never was; fixed to describe
 * what this file actually does.)
 *
 * Safe to run multiple times — uses INSERT OR IGNORE.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const { PROFILES } = require('../services/kpiProfileResolver');

// ─────────────────────────────────────────────────────────────────────
// DEFAULT SCORING CONFIGS
// Weights must sum to 1.0 per objective.
// Thresholds are platform defaults (fallback when no benchmark exists).
//
// Sourced from kpiProfileResolver.PROFILES's scoringWeights instead of a
// hand-duplicated copy here (this array used to drift from that resolver's
// content, which is exactly the "kept in sync by hand" problem the resolver
// layer exists to eliminate). 'unknown' has no scoringWeights (flatMap
// yields nothing for it), matching its existing "no seeded config" fallback
// behavior in healthResolver.js unchanged.
// ─────────────────────────────────────────────────────────────────────
const SCORING_CONFIGS = Object.entries(PROFILES).flatMap(([objective, profile]) =>
  (profile.scoringWeights || []).map(w => ({
    objective,
    metric_key: w.metric_key,
    weight:     w.weight,
    direction:  w.direction,
    excellent:  w.excellent ?? null,
    good:       w.good ?? null,
    warning:    w.warning ?? null,
    critical:   w.critical ?? null,
    opt_low:    w.opt_low ?? null,
    opt_high:   w.opt_high ?? null,
  }))
);

// ─────────────────────────────────────────────────────────────────────
// RECOMMENDATION RULES (Phase 2 minimal: 3 rules)
// ─────────────────────────────────────────────────────────────────────
const RECOMMENDATION_RULES = [
  {
    rule_code: 'LOW_ROAS',
    objective: 'sales',
    rule_name: 'ROAS Below Break-Even',
    priority: 1,
    condition_logic: JSON.stringify({ metric: 'roas', operator: 'lt', value: 1.0 }),
    recommendation_title: 'Campaign is losing money',
    recommendation_body: 'Your ROAS is below 1.0, meaning you are spending more than you are earning. Pause and review your audience targeting, creative quality, and landing page conversion before increasing budget.',
    recommendation_type: 'budget',
    severity: 'critical',
  },
  {
    rule_code: 'LOW_CTR',
    objective: null,
    rule_name: 'Low Click-Through Rate',
    priority: 2,
    condition_logic: JSON.stringify({ metric: 'ctr', operator: 'lt', value: 1.0 }),
    recommendation_title: 'Creative or targeting issue likely',
    recommendation_body: 'Your CTR is below 1%. This means your ad is being shown but people are not clicking. Consider refreshing the creative, testing a new hook or headline, or reviewing your audience targeting.',
    recommendation_type: 'creative',
    severity: 'warning',
  },
  {
    rule_code: 'HIGH_FREQUENCY',
    objective: null,
    rule_name: 'High Ad Frequency',
    priority: 3,
    condition_logic: JSON.stringify({ metric: 'frequency', operator: 'gt', value: 4.0 }),
    recommendation_title: 'Audience fatigue detected',
    recommendation_body: 'Your frequency has exceeded 4. The same people are seeing your ad too many times, which typically leads to declining CTR and rising costs. Introduce new creative variations or expand your audience.',
    recommendation_type: 'fatigue',
    severity: 'warning',
  },
];

// ─────────────────────────────────────────────────────────────────────
// ALERT RULES (Phase 2 minimal: 3 rules)
// ─────────────────────────────────────────────────────────────────────
const ALERT_RULES = [
  {
    alert_code: 'CPM_SPIKE',
    alert_name: 'CPM Spike Detected',
    description: 'CPM increased more than 30% compared to the previous equivalent period',
    metric_key: 'cpm',
    trigger_type: 'threshold_pct_change',
    trigger_value: 30,
    comparison_period: 'vs_prior_period',
    severity: 'warning',
  },
  {
    alert_code: 'CTR_DROP',
    alert_name: 'CTR Drop Detected',
    description: 'CTR dropped more than 30% compared to the previous equivalent period',
    metric_key: 'ctr',
    trigger_type: 'threshold_pct_change',
    trigger_value: -30,
    comparison_period: 'vs_prior_period',
    severity: 'warning',
  },
  {
    alert_code: 'ROAS_BELOW_ONE',
    alert_name: 'ROAS Below Break-Even',
    description: 'ROAS dropped below 1.0 — campaign is spending more than it earns',
    metric_key: 'roas',
    trigger_type: 'threshold_absolute',
    trigger_value: 1.0,
    comparison_period: null,
    severity: 'critical',
    // ROAS is only a meaningful signal for revenue-tracking (sales)
    // campaigns -- unscoped, this fired on every objective, including ones
    // where 'roas' is never a real metric at all.
    objective_scope: 'sales',
  },
];

function seedIntelligenceConfig() {
  console.log('[Seed] Seeding intelligence configuration...');
  const now = new Date().toISOString();

  // Idempotent repair: real production data (and any DB seeded before the
  // ODAX taxonomy fix) has objective_scoring_configs rows keyed by the old
  // 'messaging' objective. schema.phase8.js already remapped campaigns.
  // objective='messaging' -> 'engagement', but INSERT OR IGNORE below can't
  // rename an already-seeded row -- without this, healthResolver's
  // `WHERE objective = ?` lookup for real engagement campaigns would find
  // nothing and silently fall back to a neutral score. The weights/
  // thresholds are unchanged (kpiProfileResolver.js's engagement profile
  // preserves the old messaging values exactly), so a straight rename is
  // correct. No-ops once already applied (finds zero 'messaging' rows).
  db.run(`UPDATE objective_scoring_configs SET objective = 'engagement' WHERE objective = 'messaging'`);

  // Idempotent repair: ROAS_BELOW_ONE was originally seeded with
  // objective_scope=NULL (fires on every objective). INSERT OR IGNORE can't
  // fix an already-seeded row's column, so scope it to 'sales' directly --
  // ROAS is only ever a real metric for revenue-tracking campaigns. No-ops
  // once already applied (finds zero remaining NULL-scoped rows).
  db.run(`UPDATE alert_rules SET objective_scope = 'sales' WHERE alert_code = 'ROAS_BELOW_ONE' AND objective_scope IS NULL`);

  // ── Scoring Configs ──
  for (const cfg of SCORING_CONFIGS) {
    db.run(
      `INSERT OR IGNORE INTO objective_scoring_configs
        (id, objective, metric_key, weight, comparison_direction,
         excellent_threshold, good_threshold, warning_threshold, critical_threshold,
         optimal_low, optimal_high, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uuidv4(), cfg.objective, cfg.metric_key, cfg.weight, cfg.direction,
        cfg.excellent ?? null, cfg.good ?? null, cfg.warning ?? null, cfg.critical ?? null,
        cfg.opt_low ?? null, cfg.opt_high ?? null,
        now, now,
      ]
    );
  }
  console.log(`[Seed] ${SCORING_CONFIGS.length} scoring configs loaded.`);

  // ── Recommendation Rules ──
  for (const rule of RECOMMENDATION_RULES) {
    db.run(
      `INSERT OR IGNORE INTO recommendation_rules
        (id, rule_code, objective, rule_name, priority, condition_logic,
         recommendation_title, recommendation_body, recommendation_type,
         severity, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [
        uuidv4(), rule.rule_code, rule.objective ?? null, rule.rule_name,
        rule.priority, rule.condition_logic,
        rule.recommendation_title, rule.recommendation_body,
        rule.recommendation_type, rule.severity,
        now, now,
      ]
    );
  }
  console.log(`[Seed] ${RECOMMENDATION_RULES.length} recommendation rules loaded.`);

  // ── Alert Rules ──
  for (const rule of ALERT_RULES) {
    db.run(
      `INSERT OR IGNORE INTO alert_rules
        (id, alert_code, alert_name, description, metric_key,
         trigger_type, trigger_value, comparison_period,
         severity, objective_scope, is_active, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
      [
        uuidv4(), rule.alert_code, rule.alert_name, rule.description,
        rule.metric_key, rule.trigger_type, rule.trigger_value,
        rule.comparison_period ?? null, rule.severity, rule.objective_scope ?? null, now,
      ]
    );
  }
  console.log(`[Seed] ${ALERT_RULES.length} alert rules loaded.`);

  console.log('[Seed] Intelligence configuration complete.');
}

module.exports = { seedIntelligenceConfig };
