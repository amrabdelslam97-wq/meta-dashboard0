/**
 * Budget Distribution Analytics — Executive Marketing Analytics Layer (Phase 17)
 *
 * Budget/spend/results allocation across campaign grain (extendable to
 * ad_set/ad -- `level` column already supports it), efficiency scoring,
 * waste flags, and scaling-opportunity detection.
 *
 * Reuses existing architecture, no new Meta call shape:
 *   - Budget:  ad_sets.daily_budget/lifetime_budget -- already synced by
 *              syncService.js, zero new Meta calls needed.
 *   - Spend/Results: metricsFetcher.fetchCampaignMetrics() -- the exact same
 *              function the "insights" sync tier and the Campaign
 *              Intelligence Center already call, so a call here is a free
 *              cache hit whenever the insights tier already warmed this
 *              campaign/period this cycle (cacheService's existing 10-min
 *              'current' TTL), not a second real Meta round-trip.
 *   - Storage: budget_distribution_snapshots (schema.phase19.js).
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { fetchCampaignMetrics } = require('./metricsFetcher');
const { decryptToken } = require('./tokenCrypto');
const { defaultRange } = require('./dateRangeHelper');
const { isRateLimitError } = require('./metaApiClient');

// Below this efficiency score (0-100, 50 = account average), a campaign
// receiving a meaningful share of spend is flagged as waste.
const WASTE_EFFICIENCY_THRESHOLD = 30;
const WASTE_MIN_SPEND_SHARE_PCT = 10;

// Above this efficiency score, a campaign that's already spending close to
// its budget cap is flagged as a scaling opportunity (more budget would
// likely convert to more results at a similarly strong rate).
const SCALING_EFFICIENCY_THRESHOLD = 70;
const SCALING_BUDGET_UTILIZATION_THRESHOLD = 0.85;

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Sync (fetch spend/results + persist a snapshot) for one account's active
 * campaigns, plus one account-level rollup row.
 */
async function syncAccountBudgetDistribution(account, dateRange = defaultRange()) {
  const accessToken = decryptToken(account.access_token_encrypted);

  const campaigns = db.all(
    `SELECT id, meta_campaign_id, name FROM campaigns WHERE ad_account_id = ? AND status = 'active'`,
    [account.id]
  );

  const rows = [];
  const errors = [];
  let apiCalls = 0;

  for (const campaign of campaigns) {
    const budgetRow = db.get(
      `SELECT COALESCE(SUM(daily_budget), 0) as total_daily, COALESCE(SUM(lifetime_budget), 0) as total_lifetime
       FROM ad_sets WHERE campaign_id = ? AND status = 'active'`,
      [campaign.id]
    );
    const budget = budgetRow.total_daily > 0 ? budgetRow.total_daily : budgetRow.total_lifetime;

    try {
      apiCalls++;
      const metrics = await fetchCampaignMetrics(campaign.meta_campaign_id, accessToken, dateRange, account.attribution_window_days);
      rows.push({
        level: 'campaign',
        entity_meta_id: campaign.meta_campaign_id,
        entity_label: campaign.name,
        budget: budget || 0,
        spend: metrics.current?.spend || 0,
        results: metrics.current?.results || 0,
      });
    } catch (err) {
      errors.push({ campaign: campaign.meta_campaign_id, message: err.message });
      if (isRateLimitError(err)) throw err;
    }
  }

  const snapshot = computeDistribution(rows);
  persistSnapshot(account.id, snapshot, dateRange);

  return { campaignsProcessed: rows.length, apiCalls, errors, snapshot };
}

/**
 * Pure computation: allocation %, spend-weighted efficiency score, waste and
 * scaling-opportunity flags -- takes already-fetched {level, entity_meta_id,
 * entity_label, budget, spend, results} rows, returns the same rows enriched
 * plus one account-level rollup row.
 */
function computeDistribution(rows) {
  const totalBudget = rows.reduce((s, r) => s + (r.budget || 0), 0);
  const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
  const totalResults = rows.reduce((s, r) => s + (r.results || 0), 0);
  const avgResultsPerSpend = totalSpend > 0 ? totalResults / totalSpend : 0;

  const enriched = rows.map(r => {
    const resultsPerSpend = r.spend > 0 ? r.results / r.spend : 0;
    const efficiencyScore = avgResultsPerSpend > 0
      ? Math.max(0, Math.min(100, round((resultsPerSpend / avgResultsPerSpend) * 50, 1)))
      : (r.spend > 0 ? 0 : null);

    const budgetPct = totalBudget > 0 ? round((r.budget / totalBudget) * 100, 1) : 0;
    const spendPct = totalSpend > 0 ? round((r.spend / totalSpend) * 100, 1) : 0;
    const resultsPct = totalResults > 0 ? round((r.results / totalResults) * 100, 1) : 0;
    const budgetUtilization = r.budget > 0 ? r.spend / r.budget : null;

    const isWaste = efficiencyScore !== null
      && efficiencyScore < WASTE_EFFICIENCY_THRESHOLD
      && spendPct >= WASTE_MIN_SPEND_SHARE_PCT;

    const isScalingOpportunity = efficiencyScore !== null
      && efficiencyScore >= SCALING_EFFICIENCY_THRESHOLD
      && budgetUtilization !== null
      && budgetUtilization >= SCALING_BUDGET_UTILIZATION_THRESHOLD;

    return {
      ...r,
      budget_pct: budgetPct,
      spend_pct: spendPct,
      results_pct: resultsPct,
      efficiency_score: efficiencyScore,
      is_waste: isWaste,
      is_scaling_opportunity: isScalingOpportunity,
    };
  });

  const accountRollup = {
    level: 'account',
    entity_meta_id: 'account',
    entity_label: 'Account Total',
    budget: totalBudget,
    spend: totalSpend,
    results: totalResults,
    budget_pct: 100,
    spend_pct: 100,
    results_pct: 100,
    efficiency_score: null,
    is_waste: false,
    is_scaling_opportunity: false,
  };

  return { rows: enriched, account: accountRollup };
}

function persistSnapshot(adAccountId, snapshot, dateRange) {
  const now = new Date().toISOString();
  db.transaction(tx => {
    for (const row of [snapshot.account, ...snapshot.rows]) {
      tx.run(
        `INSERT INTO budget_distribution_snapshots (
           id, ad_account_id, level, entity_meta_id, entity_label, date_since, date_until,
           budget_amount, spend_amount, results, budget_pct, spend_pct, results_pct,
           efficiency_score, is_waste, is_scaling_opportunity, calculated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(ad_account_id, level, entity_meta_id, date_since, date_until) DO UPDATE SET
           entity_label = excluded.entity_label, budget_amount = excluded.budget_amount,
           spend_amount = excluded.spend_amount, results = excluded.results,
           budget_pct = excluded.budget_pct, spend_pct = excluded.spend_pct, results_pct = excluded.results_pct,
           efficiency_score = excluded.efficiency_score, is_waste = excluded.is_waste,
           is_scaling_opportunity = excluded.is_scaling_opportunity, calculated_at = excluded.calculated_at`,
        [
          uuidv4(), adAccountId, row.level, row.entity_meta_id, row.entity_label,
          dateRange.since, dateRange.until,
          row.budget, row.spend, row.results, row.budget_pct, row.spend_pct, row.results_pct,
          row.efficiency_score, row.is_waste ? 1 : 0, row.is_scaling_opportunity ? 1 : 0, now,
        ]
      );
    }
  });
}

/** Read side (no Meta calls) -- the persisted snapshot for an account/period. */
function getBudgetDistribution(adAccountId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT * FROM budget_distribution_snapshots WHERE ad_account_id = ? AND date_since = ? AND date_until = ? AND level != 'account' ORDER BY spend_amount DESC`,
    [adAccountId, dateRange.since, dateRange.until]
  );
  const account = db.get(
    `SELECT * FROM budget_distribution_snapshots WHERE ad_account_id = ? AND level = 'account' AND date_since = ? AND date_until = ?`,
    [adAccountId, dateRange.since, dateRange.until]
  );

  return {
    date_range: dateRange,
    account_totals: account || null,
    campaigns: rows,
    waste: rows.filter(r => r.is_waste),
    scaling_opportunities: rows.filter(r => r.is_scaling_opportunity),
  };
}

module.exports = {
  computeDistribution,
  syncAccountBudgetDistribution,
  getBudgetDistribution,
  WASTE_EFFICIENCY_THRESHOLD,
  SCALING_EFFICIENCY_THRESHOLD,
};
