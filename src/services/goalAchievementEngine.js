/**
 * Goal Achievement Engine
 *
 * Evaluates campaign metrics against account_targets.
 * Runs independently from Health Score.
 *
 * Output per target metric:
 *   status         : Exceeded | On Track | At Risk | Missed
 *   achievement_pct: how close to the target (%)
 *   gap_absolute   : actual - target
 *   gap_pct        : % gap from target
 *
 * Composite status: worst individual metric status wins.
 */

const db = require('../db/database');

// ─────────────────────────────────────────────
// Status thresholds
// ─────────────────────────────────────────────
function achievementToStatus(achievementPct) {
  if (achievementPct >= 110) return 'Exceeded';
  if (achievementPct >= 90)  return 'On Track';
  if (achievementPct >= 70)  return 'At Risk';
  return 'Missed';
}

// Composite: worst status wins
const STATUS_RANK = { Exceeded: 4, 'On Track': 3, 'At Risk': 2, Missed: 1 };
function worstStatus(statuses) {
  if (!statuses.length) return null;
  return statuses.reduce((worst, s) =>
    (STATUS_RANK[s] ?? 0) < (STATUS_RANK[worst] ?? 0) ? s : worst
  );
}

// ─────────────────────────────────────────────
// Load active targets for an account + objective
// ─────────────────────────────────────────────
function loadTargets(adAccountId, objective) {
  const today = new Date().toISOString().slice(0, 10);
  return db.get(
    `SELECT * FROM account_targets
     WHERE ad_account_id = ?
       AND objective = ?
       AND effective_from <= ?
       AND (effective_to IS NULL OR effective_to >= ?)`,
    [adAccountId, objective, today, today]
  );
}

// ─────────────────────────────────────────────
// Evaluate one metric against its target
// lower_is_better: CPR, CPL, CPA, CPM, CPC (cheaper is unambiguously better,
//   no floor concern)
// higher_is_better: CTR, ROAS, leads, purchases
// ceiling: frequency max (a cap, not something to minimize -- going far
//   below the cap isn't "more achievement" the way a lower CPA always is,
//   and usually signals under-delivery rather than success. This matches
//   the optimal-range treatment frequency already gets in health scoring
//   and benchmarking, instead of contradicting it by rewarding near-zero
//   frequency as dramatically "Exceeded")
// ─────────────────────────────────────────────
const LOWER_IS_BETTER_TARGETS = ['target_cpr', 'target_cpl', 'target_cpa', 'target_cpm'];
const HIGHER_IS_BETTER_TARGETS = ['target_ctr', 'target_roas'];
const CEILING_TARGETS = ['target_frequency_max'];

function evaluateTarget(actualValue, targetValue, targetKey) {
  if (actualValue === null || actualValue === undefined) {
    return { status: 'No Data', achievement_pct: null, gap_absolute: null, gap_pct: null };
  }
  if (targetValue === null || targetValue === undefined) {
    return null; // target not set for this metric
  }

  const isLower   = LOWER_IS_BETTER_TARGETS.includes(targetKey);
  const isCeiling = CEILING_TARGETS.includes(targetKey);
  const isHigher  = HIGHER_IS_BETTER_TARGETS.includes(targetKey);

  if (!isLower && !isCeiling && !isHigher) {
    // Every target_* column added to account_targets must be classified
    // into one of the three lists above -- silently defaulting an
    // unclassified key to "higher is better" could invert its math
    // (e.g. treating a new cost target as if lower were worse).
    console.warn(`[GoalAchievement] Unclassified target key "${targetKey}" — skipping.`);
    return null;
  }

  let achievementPct;

  if (isCeiling) {
    // At or below the ceiling is fully achieved (100%, not uncapped credit
    // for going lower); only exceeding the ceiling degrades achievement.
    achievementPct = actualValue <= targetValue
      ? 100
      : Math.round((targetValue / actualValue) * 100);
  } else if (isLower) {
    // For lower-is-better: achievement = target / actual * 100
    // actual < target is GOOD (exceeded)
    achievementPct = targetValue > 0
      ? Math.round((targetValue / actualValue) * 100)
      : 0;
  } else {
    // For higher-is-better: achievement = actual / target * 100
    achievementPct = targetValue > 0
      ? Math.round((actualValue / targetValue) * 100)
      : 0;
  }

  const gapAbsolute = Math.round((actualValue - targetValue) * 100) / 100;
  const gapPct = targetValue > 0
    ? Math.round(((actualValue - targetValue) / targetValue) * 100)
    : null;

  return {
    status:          achievementToStatus(achievementPct),
    achievement_pct: achievementPct,
    gap_absolute:    gapAbsolute,
    gap_pct:         gapPct,
    actual:          Math.round(actualValue * 100) / 100,
    target:          targetValue,
  };
}

// ─────────────────────────────────────────────
// Map target column to metrics key
// ─────────────────────────────────────────────
const TARGET_TO_METRIC = {
  target_cpr:           'cpr',
  target_cpl:           'cpl',
  target_cpa:           'cpa',
  target_roas:          'roas',
  target_ctr:           'ctr',
  target_cpm:           'cpm',
  target_frequency_max: 'frequency',
};

// ─────────────────────────────────────────────
// MAIN: Evaluate goal achievement for a campaign
// ─────────────────────────────────────────────
function evaluateGoalAchievement(campaign, metrics, adAccountId) {
  const targets = loadTargets(adAccountId, campaign.objective);

  if (!targets) {
    return {
      has_targets: false,
      message: 'No targets set for this account and objective.',
      composite_status: null,
      metric_results: {},
    };
  }

  const metricResults = {};
  const statuses = [];

  for (const [targetKey, metricKey] of Object.entries(TARGET_TO_METRIC)) {
    const targetValue = targets[targetKey];
    if (targetValue === null || targetValue === undefined) continue; // target not set

    const actualValue = metrics[metricKey] !== undefined
      ? parseFloat(metrics[metricKey])
      : null;

    const result = evaluateTarget(actualValue, targetValue, targetKey);
    if (!result) continue;

    metricResults[metricKey] = result;
    if (result.status && result.status !== 'No Data') {
      statuses.push(result.status);
    }
  }

  // Monthly volume targets (use business inputs if available — Phase 2 uses passed-in values)
  const monthlyTargetFields = {
    monthly_leads_target:   { metric: 'leads',     label: 'Monthly Leads' },
    monthly_sales_target:   { metric: 'purchases',  label: 'Monthly Sales' },
    monthly_budget_target:  { metric: 'spend',      label: 'Monthly Budget' },
  };

  for (const [field, { metric, label }] of Object.entries(monthlyTargetFields)) {
    const targetValue = targets[field];
    if (!targetValue) continue;

    const actualValue = metrics[metric] !== undefined
      ? parseFloat(metrics[metric])
      : null;

    if (actualValue === null) continue;

    const achievementPct = targetValue > 0
      ? Math.round((actualValue / targetValue) * 100)
      : 0;

    const result = {
      status:          achievementToStatus(achievementPct),
      achievement_pct: achievementPct,
      gap_absolute:    Math.round((actualValue - targetValue) * 100) / 100,
      gap_pct:         Math.round(((actualValue - targetValue) / targetValue) * 100),
      actual:          Math.round(actualValue * 100) / 100,
      target:          targetValue,
      label,
    };

    metricResults[field] = result;
    statuses.push(result.status);
  }

  return {
    has_targets:      true,
    composite_status: worstStatus(statuses) ?? 'On Track',
    metric_results:   metricResults,
    targets_used: {
      id:             targets.id,
      effective_from: targets.effective_from,
      effective_to:   targets.effective_to ?? 'ongoing',
    },
  };
}

module.exports = { evaluateGoalAchievement, loadTargets };
