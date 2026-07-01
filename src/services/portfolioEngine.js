/**
 * Portfolio Engine — Phase 6C
 *
 * Cross-account aggregation. Reads ONLY from DB.
 * NO Meta API calls. Uses health_score_history + existing tables.
 *
 * All portfolio scores derived from stored health scores.
 * Spend weighting uses score_breakdown.spend.value when available.
 * Falls back to equal weighting when spend is absent.
 */

const db = require('../db/database');
const { getAggregationRule, getPrimaryKPI } = require('./objectiveKPIMap');

// ─────────────────────────────────────────────
// Helper: parse score_breakdown JSONB safely
// ─────────────────────────────────────────────
function parseBreakdown(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ─────────────────────────────────────────────
// Helper: build date filter clause for health_score_history
// ─────────────────────────────────────────────
function buildDateFilter(dateRange) {
  if (!dateRange?.since || !dateRange?.until) return { clause: '', params: [] };
  return {
    clause: 'AND calculated_at >= ? AND calculated_at <= ?',
    params:  [dateRange.since, dateRange.until + 'T23:59:59'],
  };
}

// ─────────────────────────────────────────────
// Get latest health score per entity for one account
// ─────────────────────────────────────────────
function getLatestScoresForAccount(accountId, entityType, dateFilter) {
  const { clause, params } = dateFilter;
  return db.all(
    `SELECT h.entity_meta_id, h.entity_label, h.health_score, h.health_status,
            h.objective, h.score_breakdown, h.calculated_at
     FROM health_score_history h
     INNER JOIN (
       SELECT entity_meta_id, MAX(calculated_at) as latest
       FROM health_score_history
       WHERE ad_account_id = ? AND entity_type = ? ${clause}
       GROUP BY entity_meta_id
     ) m ON h.entity_meta_id = m.entity_meta_id AND h.calculated_at = m.latest
     WHERE h.ad_account_id = ? AND h.entity_type = ?`,
    [accountId, entityType, ...params, accountId, entityType]
  );
}

// ─────────────────────────────────────────────
// Compute spend-weighted health score for a list of entities
// Falls back to equal weighting when spend is unavailable
// ─────────────────────────────────────────────
function weightedScore(entities) {
  if (!entities.length) return null;

  let totalSpend = 0;
  let hasSpend   = false;

  const withSpend = entities.map(e => {
    const bd    = parseBreakdown(e.score_breakdown);
    const spend = bd.spend?.value != null ? parseFloat(bd.spend.value) : null;
    if (spend !== null && spend > 0) { totalSpend += spend; hasSpend = true; }
    return { ...e, spend };
  });

  if (hasSpend && totalSpend > 0) {
    // Spend-weighted
    const weighted = withSpend.reduce((sum, e) => {
      const w = (e.spend && e.spend > 0) ? e.spend / totalSpend : 0;
      return sum + e.health_score * w;
    }, 0);
    return { score: Math.round(weighted), weighting: 'spend_weighted', total_spend: totalSpend };
  }

  // Equal weighting
  const avg = entities.reduce((sum, e) => sum + e.health_score, 0) / entities.length;
  return { score: Math.round(avg), weighting: 'equal', total_spend: null };
}

// ─────────────────────────────────────────────
// Status from score
// ─────────────────────────────────────────────
function scoreToStatus(score) {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'warning';
  return 'critical';
}

// ─────────────────────────────────────────────
// 1. Portfolio Health Score (across all accounts, campaigns only)
// ─────────────────────────────────────────────
function getPortfolioHealth(dateRange) {
  const accounts   = db.all("SELECT id, meta_account_id, account_name, currency FROM ad_accounts WHERE status='active'");
  const df         = buildDateFilter(dateRange);
  const allEntities = [];

  for (const acct of accounts) {
    const scores = getLatestScoresForAccount(acct.id, 'campaign', df);
    allEntities.push(...scores);
  }

  if (!allEntities.length) {
    return { score: null, status: null, weighting: null, entity_count: 0, message: 'No analyzed campaigns found.' };
  }

  const result = weightedScore(allEntities);
  return {
    score:        result.score,
    status:       scoreToStatus(result.score),
    weighting:    result.weighting,
    total_spend:  result.total_spend,
    entity_count: allEntities.length,
  };
}

// ─────────────────────────────────────────────
// 2. Account Rankings (sorted by account health score desc)
// ─────────────────────────────────────────────
function getAccountRankings(dateRange) {
  const accounts = db.all("SELECT id, meta_account_id, account_name, client_label, currency, status FROM ad_accounts ORDER BY account_name");
  const df       = buildDateFilter(dateRange);

  return accounts.map(acct => {
    const scores = getLatestScoresForAccount(acct.id, 'campaign', df);

    const alertCount = db.get(
      "SELECT COUNT(*) as c FROM active_alerts WHERE ad_account_id=? AND status='active'",
      [acct.id]
    );
    const campCount = db.get(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active FROM campaigns WHERE ad_account_id=?",
      [acct.id]
    );

    const ws = scores.length ? weightedScore(scores) : null;

    return {
      account_id:           acct.id,
      meta_account_id:      acct.meta_account_id,
      account_name:         acct.account_name,
      client_label:         acct.client_label,
      currency:             acct.currency,
      status:               acct.status,
      health_score:         ws?.score ?? null,
      health_status:        ws?.score != null ? scoreToStatus(ws.score) : null,
      weighting:            ws?.weighting ?? null,
      scored_campaigns:     scores.length,
      total_campaigns:      campCount?.total    || 0,
      active_campaigns:     campCount?.active   || 0,
      active_alerts:        alertCount?.c       || 0,
      health_distribution: {
        excellent: scores.filter(s => s.health_score >= 80).length,
        good:      scores.filter(s => s.health_score >= 60 && s.health_score < 80).length,
        warning:   scores.filter(s => s.health_score >= 40 && s.health_score < 60).length,
        critical:  scores.filter(s => s.health_score  < 40).length,
      },
    };
  }).sort((a, b) => (b.health_score ?? -1) - (a.health_score ?? -1));
}

// ─────────────────────────────────────────────
// 3. Portfolio Summary (counts + distributions)
// ─────────────────────────────────────────────
function getPortfolioSummary(dateRange) {
  const accounts = db.all("SELECT id, meta_account_id, account_name FROM ad_accounts WHERE status='active'");
  const df       = buildDateFilter(dateRange);

  let totalCampaigns   = 0;
  let activeCampaigns  = 0;
  let scoredCampaigns  = 0;
  const distribution   = { excellent: 0, good: 0, warning: 0, critical: 0 };
  const topCampaigns   = [];
  const worstCampaigns = [];

  for (const acct of accounts) {
    const cc = db.get("SELECT COUNT(*) as t, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as a FROM campaigns WHERE ad_account_id=?", [acct.id]);
    totalCampaigns  += cc?.t || 0;
    activeCampaigns += cc?.a || 0;

    const scores = getLatestScoresForAccount(acct.id, 'campaign', df);
    scoredCampaigns += scores.length;

    scores.forEach(s => {
      if      (s.health_score >= 80) distribution.excellent++;
      else if (s.health_score >= 60) distribution.good++;
      else if (s.health_score >= 40) distribution.warning++;
      else                            distribution.critical++;

      topCampaigns.push({ ...s, account_name: acct.account_name });
    });
  }

  topCampaigns.sort((a, b) => b.health_score - a.health_score);
  worstCampaigns.push(...topCampaigns.slice().reverse().slice(0, 5));

  return {
    accounts:        { total: accounts.length },
    campaigns:       { total: totalCampaigns, active: activeCampaigns, scored: scoredCampaigns },
    health_distribution: distribution,
    top_campaigns:   topCampaigns.slice(0, 5),
    worst_campaigns: worstCampaigns,
    portfolio_health: getPortfolioHealth(dateRange),
  };
}

// ─────────────────────────────────────────────
// 4. Cross-Account Alerts
// ─────────────────────────────────────────────
function getCrossAccountAlerts() {
  return db.all(
    `SELECT a.id, a.alert_code, a.severity, a.entity_label, a.alert_message,
            a.first_detected_at, a.last_detected_at, a.occurrence_count,
            acc.account_name, acc.meta_account_id,
            r.alert_name
     FROM active_alerts a
     JOIN ad_accounts acc ON a.ad_account_id = acc.id
     LEFT JOIN alert_rules r ON a.alert_rule_id = r.id
     WHERE a.status = 'active'
       AND (a.snoozed_until IS NULL OR a.snoozed_until < datetime('now'))
     ORDER BY CASE a.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
              a.last_detected_at DESC
     LIMIT 50`
  );
}

// ─────────────────────────────────────────────
// 5. Portfolio Objective Summary
// ─────────────────────────────────────────────
function getPortfolioObjectiveSummary(dateRange) {
  const df      = buildDateFilter(dateRange);
  const { clause, params } = df;
  const accounts = db.all("SELECT id FROM ad_accounts WHERE status='active'");

  const objectives  = ['messaging', 'leads', 'sales', 'traffic', 'awareness', 'unknown'];
  const summary     = {};

  for (const obj of objectives) {
    const allScores = [];

    for (const acct of accounts) {
      const scores = db.all(
        `SELECT h.entity_meta_id, h.entity_label, h.health_score, h.health_status,
                h.objective, h.score_breakdown
         FROM health_score_history h
         INNER JOIN (
           SELECT entity_meta_id, MAX(calculated_at) as latest
           FROM health_score_history
           WHERE ad_account_id = ? AND entity_type = 'campaign' AND objective = ? ${clause}
           GROUP BY entity_meta_id
         ) m ON h.entity_meta_id = m.entity_meta_id AND h.calculated_at = m.latest
         WHERE h.ad_account_id = ? AND h.entity_type = 'campaign' AND h.objective = ?`,
        [acct.id, obj, ...params, acct.id, obj]
      );
      allScores.push(...scores);
    }

    if (!allScores.length) continue;

    const ws      = weightedScore(allScores);
    const primary = getPrimaryKPI(obj);

    summary[obj] = {
      objective:    obj,
      campaign_count: allScores.length,
      health_score: ws.score,
      health_status: scoreToStatus(ws.score),
      weighting:    ws.weighting,
      primary_kpi:  primary,
    };
  }

  return summary;
}

module.exports = {
  getPortfolioHealth,
  getAccountRankings,
  getPortfolioSummary,
  getCrossAccountAlerts,
  getPortfolioObjectiveSummary,
};
