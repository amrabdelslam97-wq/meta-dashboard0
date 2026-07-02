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
const { randomUUID } = require('crypto');

const db = require('../../db/database');
const {
  buildSummaryData, generateCSV, generateExcel, generatePDFHtml,
  resolvePeriod,
} = require('../../services/reportEngine');
const { VALID_OBJECTIVES } = require('../../services/kpiProfileResolver');
const { asyncHandler } = require('../../middleware/errorHandler');

function getDefaultAccount() {
  return db.get("SELECT id FROM ad_accounts WHERE status = 'active' LIMIT 1");
}

// `objective` is optional -- validated against the same canonical list the
// rest of the app uses (kpiProfileResolver.VALID_OBJECTIVES) so a typo'd
// query param fails loudly (400) instead of silently matching zero rows.
function validateObjective(objective) {
  if (objective === undefined) return null;
  if (!VALID_OBJECTIVES.includes(objective)) {
    const err = new Error(`Invalid objective. Valid values: ${VALID_OBJECTIVES.join(', ')}`);
    err.name = 'ValidationError';
    throw err;
  }
  return objective;
}

// ─────────────────────────────────────────────
// GET /reports/summary
// ─────────────────────────────────────────────
router.get('/summary', asyncHandler(async (req, res) => {
  const account = getDefaultAccount();
  if (!account) return res.status(404).json({ error: 'No active ad account found' });

  const { period = 'weekly', since, until, objective } = req.query;
  const range = resolvePeriod(period, since, until);
  const objectiveFilter = validateObjective(objective);

  const summary = buildSummaryData(account.id, range.since, range.until, objectiveFilter);
  return res.json({ period, ...summary });
}));

// ─────────────────────────────────────────────
// GET /reports/export
// ─────────────────────────────────────────────
router.get('/export', asyncHandler(async (req, res) => {
  const account = getDefaultAccount();
  if (!account) return res.status(404).json({ error: 'No active ad account found' });

  const { format = 'csv', period = 'weekly', since, until, objective } = req.query;
  const validFormats = ['csv', 'xlsx', 'pdf'];
  if (!validFormats.includes(format)) {
    return res.status(400).json({ error: 'Invalid format', valid: validFormats });
  }
  const objectiveFilter = validateObjective(objective);

  // resolvePeriod validates `period` against VALID_PERIODS and, when a
  // custom range is requested, validates since/until as strict YYYY-MM-DD.
  // This is what makes it safe to build a filename/header value from the
  // result below — no free-form user input ever reaches `filename`.
  const range   = resolvePeriod(period, since, until);
  const summary = buildSummaryData(account.id, range.since, range.until, objectiveFilter);
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
    // Unique per-request temp filename — the previous deterministic name
    // (period+dates only) meant two concurrent exports for the same
    // parameters could collide: one request's cleanup unlink could race
    // another request's still-open read stream for the same path.
    const tmpPath = path.join(os.tmpdir(), `${filename}-${randomUUID()}.xlsx`);
    await generateExcel(summary, tmpPath);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    const cleanup = () => fs.unlink(tmpPath, (err) => {
      if (err) console.warn(`[Reports] Failed to remove temp export file ${tmpPath}:`, err.message);
    });
    stream.on('end', cleanup);
    stream.on('error', cleanup);
    return;
  }
}));

module.exports = router;
