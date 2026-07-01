/**
 * Intelligence Config Seeder
 *
 * Seeds:
 *  - objective_scoring_configs  (weights + default thresholds per objective)
 *  - recommendation_rules       (Phase 2 minimal: 3 rules)
 *  - alert_rules                (Phase 2 minimal: 3 rules)
 *  - benchmark_metrics          (global defaults, no industry required)
 *
 * Safe to run multiple times — uses INSERT OR IGNORE.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('./database');

// ─────────────────────────────────────────────────────────────────────
// DEFAULT SCORING CONFIGS
// Weights must sum to 1.0 per objective.
// Thresholds are platform defaults (fallback when no benchmark exists).
// ─────────────────────────────────────────────────────────────────────
const SCORING_CONFIGS = [
  // ── MESSAGING ──
  { objective: 'messaging', metric_key: 'cpr',       weight: 0.40, direction: 'lower_is_better',  excellent: 5,    good: 15,   warning: 30,  critical: 60  },
  { objective: 'messaging', metric_key: 'ctr',       weight: 0.30, direction: 'higher_is_better', excellent: 3,    good: 2,    warning: 1,   critical: 0.5 },
  { objective: 'messaging', metric_key: 'frequency', weight: 0.20, direction: 'optimal_range',    excellent: null, good: null, warning: null, critical: null, opt_low: 1.5, opt_high: 3.5 },
  { objective: 'messaging', metric_key: 'reach',     weight: 0.10, direction: 'higher_is_better', excellent: 5000, good: 1000, warning: 300,  critical: 50  },

  // ── LEADS ──
  { objective: 'leads', metric_key: 'cpl',       weight: 0.40, direction: 'lower_is_better',  excellent: 5,    good: 20,   warning: 50,  critical: 100 },
  { objective: 'leads', metric_key: 'leads',     weight: 0.30, direction: 'higher_is_better', excellent: 50,   good: 20,   warning: 5,   critical: 1   },
  { objective: 'leads', metric_key: 'ctr',       weight: 0.20, direction: 'higher_is_better', excellent: 3,    good: 2,    warning: 1,   critical: 0.5 },
  { objective: 'leads', metric_key: 'frequency', weight: 0.10, direction: 'optimal_range',    excellent: null, good: null, warning: null, critical: null, opt_low: 1.5, opt_high: 3.5 },

  // ── SALES ──
  { objective: 'sales', metric_key: 'roas',      weight: 0.35, direction: 'higher_is_better', excellent: 4,    good: 2,    warning: 1,   critical: 0.5 },
  { objective: 'sales', metric_key: 'cpa',       weight: 0.35, direction: 'lower_is_better',  excellent: 20,   good: 60,   warning: 120, critical: 250 },
  { objective: 'sales', metric_key: 'purchases', weight: 0.20, direction: 'higher_is_better', excellent: 20,   good: 5,    warning: 1,   critical: 0   },
  { objective: 'sales', metric_key: 'ctr',       weight: 0.10, direction: 'higher_is_better', excellent: 3,    good: 2,    warning: 1,   critical: 0.5 },

  // ── TRAFFIC ──
  { objective: 'traffic', metric_key: 'cpc',              weight: 0.30, direction: 'lower_is_better',  excellent: 0.5,  good: 1.5,  warning: 3,   critical: 6   },
  { objective: 'traffic', metric_key: 'ctr',              weight: 0.30, direction: 'higher_is_better', excellent: 3,    good: 2,    warning: 1,   critical: 0.5 },
  { objective: 'traffic', metric_key: 'landing_page_views', weight: 0.25, direction: 'higher_is_better', excellent: 1000, good: 300, warning: 50,  critical: 5   },
  { objective: 'traffic', metric_key: 'frequency',        weight: 0.15, direction: 'optimal_range',    excellent: null, good: null, warning: null, critical: null, opt_low: 1.5, opt_high: 3.5 },

  // ── AWARENESS ──
  { objective: 'awareness', metric_key: 'reach',     weight: 0.40, direction: 'higher_is_better', excellent: 50000, good: 10000, warning: 2000, critical: 300 },
  { objective: 'awareness', metric_key: 'cpm',       weight: 0.30, direction: 'lower_is_better',  excellent: 3,     good: 8,     warning: 20,   critical: 50  },
  { objective: 'awareness', metric_key: 'frequency', weight: 0.20, direction: 'optimal_range',    excellent: null,  good: null,  warning: null,  critical: null, opt_low: 1.5, opt_high: 4.0 },
  { objective: 'awareness', metric_key: 'impressions', weight: 0.10, direction: 'higher_is_better', excellent: 100000, good: 20000, warning: 3000, critical: 500 },
];

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
  },
];

function seedIntelligenceConfig() {
  console.log('[Seed] Seeding intelligence configuration...');
  const now = new Date().toISOString();

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
         severity, is_active, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
      [
        uuidv4(), rule.alert_code, rule.alert_name, rule.description,
        rule.metric_key, rule.trigger_type, rule.trigger_value,
        rule.comparison_period ?? null, rule.severity, now,
      ]
    );
  }
  console.log(`[Seed] ${ALERT_RULES.length} alert rules loaded.`);

  console.log('[Seed] Intelligence configuration complete.');
}

module.exports = { seedIntelligenceConfig };
