/**
 * Reports Route — Phase 5
 *
 * GET /api/v1/reports/summary?period=daily|weekly|monthly
 *   Returns structured summary data (JSON).
 *
 * GET /api/v1/reports/export?format=csv|xlsx|pdf&period=daily|weekly|monthly
 *   Downloads the report in the requested format.
 */

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const db = require('../../db/database');
const { resolveDateRange } = require('../../services/dateRangeHelper');
const {
  buildSummaryData, generateCSV, generateExcel, generatePDFHtml,
  todayRange, weekRange, monthRange,
} = require('../../services/reportEngine');
const { asyncHandler } = require('../../middleware/errorHandler');

// resolvePeriod replaced by resolveDateRange from dateRangeHelper (Phase 6C)

function getDefaultAccount() {
  return db.get("SELECT id FROM ad_accounts WHERE status = 'active' LIMIT 1");
}

// ─────────────────────────────────────────────
// GET /reports/summary
// ─────────────────────────────────────────────
router.get('/summary', asyncHandler(async (req, res) => {
  const account = getDefaultAccount();
  if (!account) return res.status(404).json({ error: 'No active ad account found' });

  const { period = 'weekly' } = req.query;
  const range = resolveDateRange(req.query);

  const summary = buildSummaryData(account.id, range.since, range.until);
  return res.json({ period, ...summary });
}));

// ─────────────────────────────────────────────
// GET /reports/export
// ─────────────────────────────────────────────
router.get('/export', asyncHandler(async (req, res) => {
  const account = getDefaultAccount();
  if (!account) return res.status(404).json({ error: 'No active ad account found' });

  const { format = 'csv', period = 'weekly', since, until } = req.query;
  const validFormats = ['csv', 'xlsx', 'pdf'];
  if (!validFormats.includes(format)) {
    return res.status(400).json({ error: 'Invalid format', valid: validFormats });
  }

  const range   = resolvePeriod(period, since, until);
  const summary = buildSummaryData(account.id, range.since, range.until);
  const filename = `meta-ads-report-${period}-${range.since}-${range.until}`;

  // ── CSV ──
  if (format === 'csv') {
    const csv = generateCSV(summary);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(csv);
  }

  // ── PDF (HTML print page) ──
  if (format === 'pdf') {
    const html = generatePDFHtml(summary);
    res.setHeader('Content-Type', 'text/html');
    // Client-side: window.print() will produce the PDF
    return res.send(html);
  }

  // ── Excel ──
  if (format === 'xlsx') {
    const tmpPath = path.join(os.tmpdir(), `${filename}.xlsx`);
    await generateExcel(summary, tmpPath);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(tmpPath); } catch {} });
    return;
  }
}));

module.exports = router;
