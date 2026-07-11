/**
 * Settings Route — Phase 3
 *
 * GET  /api/v1/settings                           — full settings overview
 * GET  /api/v1/settings/targets/:account_id       — targets for account
 * POST /api/v1/settings/targets                   — create/update target
 * GET  /api/v1/settings/benchmarks                — list benchmarks
 * POST /api/v1/settings/benchmarks                — create/update benchmark
 * DELETE /api/v1/settings/benchmarks/:id          — remove benchmark override
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../db/database');
const { asyncHandler } = require('../../middleware/errorHandler');
const smartSyncEngine = require('../../services/smartSyncEngine');

// ── GET /settings ─────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const accounts = db.all(`
    SELECT id, meta_account_id, account_name, client_label, currency,
           timezone, country_code, attribution_window_days, status,
           token_is_valid, last_token_verified_at, business_name, notes,
           last_sync_started_at, last_sync_completed_at, last_successful_sync_at,
           last_failed_sync_at, last_sync_status, last_sync_error, sync_progress_phase,
           auto_sync_enabled, auto_sync_interval_minutes
    FROM ad_accounts ORDER BY account_name
  `);

  const industries = db.all('SELECT * FROM benchmark_industries WHERE is_active = 1 ORDER BY name');

  const targetsByAccount = {};
  for (const acc of accounts) {
    targetsByAccount[acc.id] = db.all(
      `SELECT * FROM account_targets WHERE ad_account_id = ? ORDER BY objective, effective_from DESC`,
      [acc.id]
    );
  }

  const benchmarkOverrides = db.all(`
    SELECT bm.*, bi.name as industry_name, a.account_name
    FROM benchmark_metrics bm
    LEFT JOIN benchmark_industries bi ON bm.industry_id = bi.id
    LEFT JOIN ad_accounts a ON bm.ad_account_id = a.id
    ORDER BY bi.name, bm.objective, bm.metric_key
  `);

  const scoringConfigs = db.all(
    'SELECT * FROM objective_scoring_configs ORDER BY objective, metric_key'
  );

  return res.json({
    accounts: accounts.map(a => ({
      ...a,
      token_is_valid: Boolean(a.token_is_valid),
      auto_sync_enabled: Boolean(a.auto_sync_enabled),
    })),
    industries,
    targets: targetsByAccount,
    benchmark_overrides: benchmarkOverrides,
    scoring_configs: scoringConfigs,
    sync_intervals: smartSyncEngine.getScheduleConfig(),
  });
}));

// ── GET /settings/sync-intervals ──────────────────────────────
// Configurable cadence (minutes) per entity type for the Smart Auto Sync
// scheduler — insights/campaigns/adsets/ads/creatives/metadata.
router.get('/sync-intervals', asyncHandler(async (req, res) => {
  return res.json({ data: smartSyncEngine.getScheduleConfig() });
}));

// ── PATCH /settings/sync-intervals ────────────────────────────
// Body: { entity_type: 'insights', interval_minutes: 15 }
router.patch('/sync-intervals', asyncHandler(async (req, res) => {
  const { entity_type, interval_minutes } = req.body || {};
  if (!entity_type || interval_minutes === undefined) {
    return res.status(400).json({ error: 'entity_type and interval_minutes are required' });
  }
  try {
    const updated = smartSyncEngine.setScheduleInterval(entity_type, interval_minutes);
    return res.json({ data: updated, all: smartSyncEngine.getScheduleConfig() });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
}));

// ── GET /settings/targets/:account_id ────────────────────────
router.get('/targets/:account_id', asyncHandler(async (req, res) => {
  const { account_id } = req.params;
  const targets = db.all(
    'SELECT * FROM account_targets WHERE ad_account_id = ? ORDER BY objective, effective_from DESC',
    [account_id]
  );
  return res.json({ data: targets });
}));

// ── POST /settings/targets ────────────────────────────────────
router.post('/targets', asyncHandler(async (req, res) => {
  const {
    ad_account_id, objective,
    target_cpr, target_cpl, target_cpa, target_roas, target_ctr,
    target_cpm, target_frequency_max,
    monthly_budget_target, monthly_revenue_target,
    monthly_sales_target, monthly_leads_target,
    effective_from, effective_to, notes,
  } = req.body || {};

  if (!ad_account_id || !objective) {
    return res.status(400).json({ error: 'ad_account_id and objective are required' });
  }

  const account = db.get('SELECT id FROM ad_accounts WHERE id = ?', [ad_account_id]);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const now  = new Date().toISOString();
  const from = effective_from || now.slice(0, 10);

  // Close any existing open target for this account+objective
  db.run(
    `UPDATE account_targets SET effective_to = ?, updated_at = ?
     WHERE ad_account_id = ? AND objective = ? AND (effective_to IS NULL OR effective_to >= ?)`,
    [from, now, ad_account_id, objective, from]
  );

  const id = uuidv4();
  db.run(
    `INSERT INTO account_targets (
       id, ad_account_id, objective,
       target_cpr, target_cpl, target_cpa, target_roas, target_ctr,
       target_cpm, target_frequency_max,
       monthly_budget_target, monthly_revenue_target,
       monthly_sales_target, monthly_leads_target,
       effective_from, effective_to, notes, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, ad_account_id, objective,
      target_cpr ?? null, target_cpl ?? null, target_cpa ?? null,
      target_roas ?? null, target_ctr ?? null, target_cpm ?? null,
      target_frequency_max ?? null,
      monthly_budget_target ?? null, monthly_revenue_target ?? null,
      monthly_sales_target ?? null, monthly_leads_target ?? null,
      from, effective_to ?? null, notes ?? null, now, now,
    ]
  );

  return res.status(201).json({ data: db.get('SELECT * FROM account_targets WHERE id = ?', [id]) });
}));

// ── GET /settings/benchmarks ──────────────────────────────────
router.get('/benchmarks', asyncHandler(async (req, res) => {
  const rows = db.all(`
    SELECT bm.*, bi.name as industry_name, a.account_name
    FROM benchmark_metrics bm
    LEFT JOIN benchmark_industries bi ON bm.industry_id = bi.id
    LEFT JOIN ad_accounts a ON bm.ad_account_id = a.id
    ORDER BY bi.name, bm.objective, bm.metric_key
  `);
  const industries = db.all('SELECT * FROM benchmark_industries WHERE is_active = 1 ORDER BY name');
  return res.json({ data: rows, industries });
}));

// ── POST /settings/benchmarks ─────────────────────────────────
router.post('/benchmarks', asyncHandler(async (req, res) => {
  const {
    industry_id, ad_account_id, objective, metric_key,
    excellent_threshold, good_threshold, warning_threshold, critical_threshold,
    comparison_direction = 'lower_is_better', optimal_low, optimal_high,
  } = req.body || {};

  if (!objective || !metric_key || excellent_threshold === undefined) {
    return res.status(400).json({ error: 'objective, metric_key, and thresholds are required' });
  }

  const now = new Date().toISOString();

  // Upsert: if same combo exists update it
  const existing = db.get(
    `SELECT id FROM benchmark_metrics
     WHERE objective = ? AND metric_key = ?
       AND (ad_account_id = ? OR (ad_account_id IS NULL AND ? IS NULL))
       AND (industry_id = ? OR (industry_id IS NULL AND ? IS NULL))`,
    [objective, metric_key, ad_account_id ?? null, ad_account_id ?? null,
     industry_id ?? null, industry_id ?? null]
  );

  if (existing) {
    db.run(
      `UPDATE benchmark_metrics SET
         excellent_threshold=?, good_threshold=?, warning_threshold=?, critical_threshold=?,
         comparison_direction=?, optimal_low=?, optimal_high=?, updated_at=?
       WHERE id=?`,
      [excellent_threshold, good_threshold, warning_threshold, critical_threshold,
       comparison_direction, optimal_low ?? null, optimal_high ?? null, now, existing.id]
    );
    return res.json({ data: db.get('SELECT * FROM benchmark_metrics WHERE id=?', [existing.id]) });
  }

  const id = uuidv4();
  db.run(
    `INSERT INTO benchmark_metrics (
       id, industry_id, ad_account_id, objective, metric_key,
       excellent_threshold, good_threshold, warning_threshold, critical_threshold,
       comparison_direction, optimal_low, optimal_high, last_reviewed_at, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, industry_id ?? null, ad_account_id ?? null, objective, metric_key,
     excellent_threshold, good_threshold, warning_threshold, critical_threshold,
     comparison_direction, optimal_low ?? null, optimal_high ?? null,
     now.slice(0,10), now, now]
  );

  return res.status(201).json({ data: db.get('SELECT * FROM benchmark_metrics WHERE id=?', [id]) });
}));

// ── DELETE /settings/benchmarks/:id ──────────────────────────
router.delete('/benchmarks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const row = db.get('SELECT id FROM benchmark_metrics WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: 'Benchmark not found' });
  db.run('DELETE FROM benchmark_metrics WHERE id = ?', [id]);
  return res.json({ success: true });
}));

module.exports = router;
