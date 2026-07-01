/**
 * Benchmark Resolver
 *
 * Single source of truth for the 3-tier threshold resolution used by both
 * healthScoreEngine.js and benchmarkEngine.js:
 *   1. Account-specific benchmark (benchmark_metrics, ad_account_id = X)
 *   2. Global/industry benchmark   (benchmark_metrics, ad_account_id IS NULL)
 *   3. Platform default            (objective_scoring_configs)
 *
 * Previously each of those two files implemented this identically but
 * independently, meaning any change to the resolution order or to how a
 * tier is queried had to be made in two places to stay in sync -- which is
 * exactly how they'd already drifted (see fixed metricsByObjective in
 * benchmarkEngine.js, a related but separate drift).
 */

const db = require('../db/database');

/**
 * @param {string} objective
 * @param {string} metricKey
 * @param {string} adAccountId
 * @param {object|null} platformConfig - if the caller already loaded the
 *   objective's scoring configs (as healthScoreEngine does, one query for
 *   all metrics instead of one per metric), pass the matching row here to
 *   skip tier 3's query entirely. If omitted, tier 3 queries
 *   objective_scoring_configs directly and returns null if nothing exists
 *   at any tier (callers must handle a null result).
 */
function resolveThresholds(objective, metricKey, adAccountId, platformConfig = null) {
  const accountBenchmark = db.get(
    `SELECT * FROM benchmark_metrics
     WHERE objective = ? AND metric_key = ? AND ad_account_id = ?`,
    [objective, metricKey, adAccountId]
  );
  if (accountBenchmark) return { ...accountBenchmark, source: 'account_benchmark' };

  const globalBenchmark = db.get(
    `SELECT * FROM benchmark_metrics
     WHERE objective = ? AND metric_key = ? AND ad_account_id IS NULL`,
    [objective, metricKey]
  );
  if (globalBenchmark) return { ...globalBenchmark, source: 'global_benchmark' };

  if (platformConfig) {
    return { ...platformConfig, source: 'platform_default' };
  }

  const platform = db.get(
    `SELECT * FROM objective_scoring_configs WHERE objective = ? AND metric_key = ?`,
    [objective, metricKey]
  );
  return platform ? { ...platform, source: 'platform_default' } : null;
}

module.exports = { resolveThresholds };
