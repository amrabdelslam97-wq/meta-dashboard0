/**
 * Report Engine — Phase 5
 *
 * Generates Daily, Weekly, Monthly summaries from DB data.
 * Exports: CSV (pure JS), Excel (exceljs), PDF (HTML print-ready page).
 *
 * Reuses: health_score_history, recommendation_log, active_alerts, decision_history
 */

const db = require('../db/database');

// ─────────────────────────────────────────────
// Build summary data from DB for a date range
// ─────────────────────────────────────────────
function buildSummaryData(adAccountId, since, until) {
  // Health score stats for the period
  const healthStats = db.get(`
    SELECT
      AVG(health_score)  as avg_score,
      MIN(health_score)  as min_score,
      MAX(health_score)  as max_score,
      COUNT(DISTINCT entity_meta_id) as campaigns_scored
    FROM health_score_history
    WHERE ad_account_id = ? AND entity_type = 'campaign'
      AND calculated_at >= ? AND calculated_at <= ?
  `, [adAccountId, since, until + 'T23:59:59']);

  // Latest score per campaign for period
  const campaignScores = db.all(`
    SELECT
      h.entity_meta_id, h.entity_label, h.health_score, h.health_status,
      h.objective, h.calculated_at
    FROM health_score_history h
    INNER JOIN (
      SELECT entity_meta_id, MAX(calculated_at) as latest
      FROM health_score_history
      WHERE ad_account_id = ? AND entity_type = 'campaign'
        AND calculated_at >= ? AND calculated_at <= ?
      GROUP BY entity_meta_id
    ) m ON h.entity_meta_id = m.entity_meta_id AND h.calculated_at = m.latest
    ORDER BY h.health_score DESC
  `, [adAccountId, since, until + 'T23:59:59']);

  // Recommendations for the period
  const recs = db.all(`
    SELECT rule_code, severity, entity_label, recommendation_title,
           action_taken, generated_at
    FROM recommendation_log
    WHERE ad_account_id = ? AND generated_at >= ? AND generated_at <= ?
    ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END
  `, [adAccountId, since, until + 'T23:59:59']);

  // Alerts for the period
  const alerts = db.all(`
    SELECT alert_code, severity, entity_label, alert_message,
           first_detected_at, occurrence_count, status
    FROM active_alerts
    WHERE ad_account_id = ? AND first_detected_at >= ? AND first_detected_at <= ?
    ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END
  `, [adAccountId, since, until + 'T23:59:59']);

  // Decisions generated in the period
  let decisions = [];
  try {
    decisions = db.all(`
      SELECT decision_type, priority, campaign_name, reason, status, created_at
      FROM decision_history
      WHERE ad_account_id = ? AND created_at >= ? AND created_at <= ?
      ORDER BY priority_score DESC
    `, [adAccountId, since, until + 'T23:59:59']);
  } catch {} // table may not exist in older installs

  const topCampaigns    = campaignScores.slice(0, 5);
  const worstCampaigns  = [...campaignScores].sort((a, b) => a.health_score - b.health_score).slice(0, 5);

  const account = db.get('SELECT account_name, currency FROM ad_accounts WHERE id = ?', [adAccountId]);

  return {
    account_name:    account?.account_name || 'Unknown Account',
    currency:        account?.currency     || 'USD',
    period:          { since, until },
    health: {
      avg_score:         healthStats?.avg_score ? Math.round(healthStats.avg_score) : null,
      min_score:         healthStats?.min_score || null,
      max_score:         healthStats?.max_score || null,
      campaigns_scored:  healthStats?.campaigns_scored || 0,
    },
    top_campaigns:    topCampaigns,
    worst_campaigns:  worstCampaigns,
    recommendations: {
      total:     recs.length,
      critical:  recs.filter(r => r.severity === 'critical').length,
      warning:   recs.filter(r => r.severity === 'warning').length,
      completed: recs.filter(r => r.action_taken).length,
      items:     recs,
    },
    alerts: {
      total:    alerts.length,
      critical: alerts.filter(a => a.severity === 'critical').length,
      warning:  alerts.filter(a => a.severity === 'warning').length,
      items:    alerts,
    },
    decisions: {
      total:     decisions.length,
      completed: decisions.filter(d => d.status === 'completed').length,
      items:     decisions.slice(0, 10),
    },
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// Preset period helpers
// ─────────────────────────────────────────────
function todayRange()   { const t = new Date().toISOString().slice(0,10); return { since: t, until: t }; }
function weekRange()    { const u = new Date(); u.setDate(u.getDate()-1); const s = new Date(u); s.setDate(s.getDate()-6); return { since: s.toISOString().slice(0,10), until: u.toISOString().slice(0,10) }; }
function monthRange()   { const u = new Date(); u.setDate(u.getDate()-1); const s = new Date(u.getFullYear(), u.getMonth(), 1); return { since: s.toISOString().slice(0,10), until: u.toISOString().slice(0,10) }; }

const VALID_PERIODS = ['daily', 'weekly', 'monthly'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a report period into a concrete { since, until } date range.
 *
 * Strict validation is deliberate: the caller (reports.js) builds a
 * filesystem path and an HTTP header value directly from these values.
 * `period` must be one of the 3 known literals, and a custom `since`/
 * `until` override must match YYYY-MM-DD exactly — this closes off path
 * traversal / header-value injection at the source rather than trying to
 * sanitize a filename after the fact.
 */
function resolvePeriod(period, since, until) {
  // Validated unconditionally, even when since/until override the actual
  // date computation below — `period` is still used verbatim by the caller
  // to build a filename/header value, so it must never be allowed to carry
  // anything other than one of these 3 known-safe literals.
  if (!VALID_PERIODS.includes(period)) {
    const err = new Error(`Invalid period. Valid values: ${VALID_PERIODS.join(', ')}`);
    err.name = 'ValidationError';
    throw err;
  }

  if (since !== undefined || until !== undefined) {
    if (!ISO_DATE_RE.test(since || '') || !ISO_DATE_RE.test(until || '')) {
      const err = new Error('since/until must both be provided in YYYY-MM-DD format');
      err.name = 'ValidationError';
      throw err;
    }
    return { since, until };
  }

  if (period === 'daily')   return todayRange();
  if (period === 'monthly') return monthRange();
  return weekRange();
}

// ─────────────────────────────────────────────
// CSV Export
// ─────────────────────────────────────────────
function generateCSV(summaryData) {
  const rows = [
    ['Meta Ads Intelligence — Report'],
    ['Account', summaryData.account_name],
    ['Period', `${summaryData.period.since} to ${summaryData.period.until}`],
    ['Generated', summaryData.generated_at],
    [],
    ['HEALTH SUMMARY'],
    ['Average Health Score', summaryData.health.avg_score ?? 'N/A'],
    ['Min Score', summaryData.health.min_score ?? 'N/A'],
    ['Max Score', summaryData.health.max_score ?? 'N/A'],
    ['Campaigns Scored', summaryData.health.campaigns_scored],
    [],
    ['TOP CAMPAIGNS'],
    ['Campaign', 'Objective', 'Health Score', 'Status'],
    ...summaryData.top_campaigns.map(c => [c.entity_label, c.objective || '', c.health_score, c.health_status]),
    [],
    ['WORST CAMPAIGNS'],
    ['Campaign', 'Objective', 'Health Score', 'Status'],
    ...summaryData.worst_campaigns.map(c => [c.entity_label, c.objective || '', c.health_score, c.health_status]),
    [],
    ['RECOMMENDATIONS'],
    ['Total', summaryData.recommendations.total],
    ['Critical', summaryData.recommendations.critical],
    ['Warning', summaryData.recommendations.warning],
    ['Completed', summaryData.recommendations.completed],
    [],
    ['RECOMMENDATION DETAILS'],
    ['Campaign', 'Severity', 'Title', 'Completed', 'Date'],
    ...summaryData.recommendations.items.map(r => [
      r.entity_label, r.severity, r.recommendation_title,
      r.action_taken ? 'Yes' : 'No', r.generated_at?.slice(0,10)
    ]),
    [],
    ['ALERTS'],
    ['Campaign', 'Code', 'Severity', 'Message', 'Occurrences', 'First Detected'],
    ...summaryData.alerts.items.map(a => [
      a.entity_label, a.alert_code, a.severity,
      a.alert_message, a.occurrence_count, a.first_detected_at?.slice(0,10)
    ]),
  ];

  return rows.map(row =>
    row.map(cell => {
      let s = String(cell ?? '');
      // CSV/formula injection: a cell beginning with =, +, -, or @ is
      // interpreted as a formula by Excel/Sheets when the file is opened.
      // entity_label/recommendation_title/alert_message all ultimately
      // originate from Meta campaign names or rule text an operator could
      // influence (e.g. by naming a campaign "=cmd|...!A1"), so prefix
      // with a leading apostrophe to force plain-text interpretation --
      // this is the standard mitigation and is invisible in the rendered
      // cell in every common spreadsheet application.
      if (/^[=+\-@]/.test(s)) {
        s = `'${s}`;
      }
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(',')
  ).join('\n');
}

// ─────────────────────────────────────────────
// Excel Export (exceljs)
// ─────────────────────────────────────────────
async function generateExcel(summaryData, outputPath) {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch {
    throw new Error('exceljs not installed. Run: npm install exceljs');
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Meta Ads Intelligence System';
  wb.created = new Date();

  // ── Sheet 1: Summary ──
  const summarySheet = wb.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'Value',  key: 'value',  width: 25 },
  ];
  summarySheet.getRow(1).font = { bold: true };

  const summaryRows = [
    { metric: 'Account',          value: summaryData.account_name },
    { metric: 'Period',           value: `${summaryData.period.since} → ${summaryData.period.until}` },
    { metric: 'Generated At',     value: summaryData.generated_at },
    { metric: '--- HEALTH ---',   value: '' },
    { metric: 'Avg Health Score', value: summaryData.health.avg_score ?? 'N/A' },
    { metric: 'Min Score',        value: summaryData.health.min_score ?? 'N/A' },
    { metric: 'Max Score',        value: summaryData.health.max_score ?? 'N/A' },
    { metric: 'Campaigns Scored', value: summaryData.health.campaigns_scored },
    { metric: '--- ALERTS ---',   value: '' },
    { metric: 'Total Alerts',     value: summaryData.alerts.total },
    { metric: 'Critical',         value: summaryData.alerts.critical },
    { metric: 'Warning',          value: summaryData.alerts.warning },
    { metric: '--- RECOMMENDATIONS ---', value: '' },
    { metric: 'Total',            value: summaryData.recommendations.total },
    { metric: 'Critical',         value: summaryData.recommendations.critical },
    { metric: 'Completed',        value: summaryData.recommendations.completed },
  ];
  summarySheet.addRows(summaryRows);

  // Color rows with scores
  summarySheet.eachRow((row, rn) => {
    if (rn > 1) {
      row.getCell(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1a1d27' } };
    }
  });

  // ── Sheet 2: Campaigns ──
  const campSheet = wb.addWorksheet('Campaigns');
  campSheet.columns = [
    { header: 'Campaign',     key: 'name',    width: 35 },
    { header: 'Objective',    key: 'obj',     width: 15 },
    { header: 'Health Score', key: 'score',   width: 15 },
    { header: 'Status',       key: 'status',  width: 15 },
    { header: 'Last Scored',  key: 'date',    width: 20 },
  ];
  campSheet.getRow(1).font = { bold: true };
  summaryData.top_campaigns.forEach(c => {
    campSheet.addRow({ name: c.entity_label, obj: c.objective, score: c.health_score, status: c.health_status, date: c.calculated_at?.slice(0,10) });
  });

  // ── Sheet 3: Recommendations ──
  const recSheet = wb.addWorksheet('Recommendations');
  recSheet.columns = [
    { header: 'Campaign',   key: 'campaign', width: 30 },
    { header: 'Severity',   key: 'severity', width: 12 },
    { header: 'Title',      key: 'title',    width: 40 },
    { header: 'Completed',  key: 'done',     width: 12 },
    { header: 'Date',       key: 'date',     width: 15 },
  ];
  recSheet.getRow(1).font = { bold: true };
  summaryData.recommendations.items.forEach(r => {
    recSheet.addRow({ campaign: r.entity_label, severity: r.severity, title: r.recommendation_title, done: r.action_taken ? 'Yes' : 'No', date: r.generated_at?.slice(0,10) });
  });

  // ── Sheet 4: Alerts ──
  const alertSheet = wb.addWorksheet('Alerts');
  alertSheet.columns = [
    { header: 'Campaign',    key: 'campaign', width: 30 },
    { header: 'Code',        key: 'code',     width: 20 },
    { header: 'Severity',    key: 'severity', width: 12 },
    { header: 'Message',     key: 'message',  width: 50 },
    { header: 'Occurrences', key: 'count',    width: 12 },
    { header: 'Detected',    key: 'date',     width: 15 },
  ];
  alertSheet.getRow(1).font = { bold: true };
  summaryData.alerts.items.forEach(a => {
    alertSheet.addRow({ campaign: a.entity_label, code: a.alert_code, severity: a.severity, message: a.alert_message, count: a.occurrence_count, date: a.first_detected_at?.slice(0,10) });
  });

  await wb.xlsx.writeFile(outputPath);
  return outputPath;
}

// ─────────────────────────────────────────────
// PDF Export (HTML print-ready string)
// ─────────────────────────────────────────────
function generatePDFHtml(summaryData) {
  const scoreColor = (s) => {
    if (!s) return '#888';
    if (s >= 80) return '#22c55e';
    if (s >= 60) return '#eab308';
    if (s >= 40) return '#f97316';
    return '#ef4444';
  };

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Meta Ads Report — ${summaryData.period.since} to ${summaryData.period.until}</title>
<style>
  body { font-family: Arial, sans-serif; color: #1a1a2e; margin: 0; padding: 20px; font-size: 13px; }
  h1 { color: #6366f1; font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 15px; color: #3730a3; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; margin-top: 20px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #6366f1; color: white; padding: 8px 10px; text-align: left; font-size: 12px; }
  td { padding: 7px 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
  tr:nth-child(even) td { background: #f8fafc; }
  .score { font-weight: bold; }
  .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .stat { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; text-align: center; }
  .stat-value { font-size: 24px; font-weight: 800; }
  .stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; margin-top: 2px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge-critical { background: #fef2f2; color: #ef4444; }
  .badge-warning  { background: #fffbeb; color: #d97706; }
  .badge-good     { background: #f0fdf4; color: #22c55e; }
  .footer { margin-top: 30px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; }
  @media print { body { margin: 0; padding: 10px; } }
</style>
</head>
<body>
<h1>📊 Meta Ads Intelligence Report</h1>
<div class="meta">
  <strong>${summaryData.account_name}</strong> ·
  Period: ${summaryData.period.since} → ${summaryData.period.until} ·
  Generated: ${new Date(summaryData.generated_at).toLocaleString()}
</div>

<div class="stat-row">
  <div class="stat">
    <div class="stat-value" style="color:${scoreColor(summaryData.health.avg_score)}">${summaryData.health.avg_score ?? '—'}</div>
    <div class="stat-label">Avg Health Score</div>
  </div>
  <div class="stat">
    <div class="stat-value" style="color:#ef4444">${summaryData.alerts.critical}</div>
    <div class="stat-label">Critical Alerts</div>
  </div>
  <div class="stat">
    <div class="stat-value" style="color:#6366f1">${summaryData.recommendations.total}</div>
    <div class="stat-label">Recommendations</div>
  </div>
  <div class="stat">
    <div class="stat-value" style="color:#22c55e">${summaryData.recommendations.completed}</div>
    <div class="stat-label">Actions Completed</div>
  </div>
</div>

<h2>🏆 Top Performing Campaigns</h2>
<table>
  <tr><th>Campaign</th><th>Objective</th><th>Health Score</th><th>Status</th></tr>
  ${summaryData.top_campaigns.map(c => `
  <tr>
    <td>${c.entity_label}</td>
    <td>${c.objective || '—'}</td>
    <td class="score" style="color:${scoreColor(c.health_score)}">${c.health_score}/100</td>
    <td><span class="badge badge-${c.health_status === 'excellent' || c.health_status === 'good' ? 'good' : c.health_status === 'warning' ? 'warning' : 'critical'}">${c.health_status}</span></td>
  </tr>`).join('')}
</table>

<h2>⚠ Campaigns Needing Attention</h2>
<table>
  <tr><th>Campaign</th><th>Objective</th><th>Health Score</th><th>Status</th></tr>
  ${summaryData.worst_campaigns.map(c => `
  <tr>
    <td>${c.entity_label}</td>
    <td>${c.objective || '—'}</td>
    <td class="score" style="color:${scoreColor(c.health_score)}">${c.health_score}/100</td>
    <td><span class="badge badge-${c.health_status === 'critical' ? 'critical' : 'warning'}">${c.health_status}</span></td>
  </tr>`).join('')}
</table>

<h2>💡 Recommendations</h2>
<table>
  <tr><th>Campaign</th><th>Severity</th><th>Recommendation</th><th>Completed</th></tr>
  ${summaryData.recommendations.items.slice(0,10).map(r => `
  <tr>
    <td>${r.entity_label}</td>
    <td><span class="badge badge-${r.severity}">${r.severity}</span></td>
    <td>${r.recommendation_title}</td>
    <td>${r.action_taken ? '✓ Yes' : '—'}</td>
  </tr>`).join('')}
</table>

<h2>🔔 Alerts</h2>
<table>
  <tr><th>Campaign</th><th>Alert</th><th>Severity</th><th>Occurrences</th><th>Detected</th></tr>
  ${summaryData.alerts.items.slice(0,10).map(a => `
  <tr>
    <td>${a.entity_label}</td>
    <td>${a.alert_code}</td>
    <td><span class="badge badge-${a.severity}">${a.severity}</span></td>
    <td>${a.occurrence_count}</td>
    <td>${a.first_detected_at?.slice(0,10) || '—'}</td>
  </tr>`).join('')}
</table>

<div class="footer">
  Generated by Meta Ads Intelligence System · Phase 5 · ${new Date().toISOString()}
</div>
</body>
</html>`;
}

module.exports = {
  buildSummaryData,
  generateCSV,
  generateExcel,
  generatePDFHtml,
  todayRange,
  weekRange,
  monthRange,
  resolvePeriod,
  VALID_PERIODS,
};
