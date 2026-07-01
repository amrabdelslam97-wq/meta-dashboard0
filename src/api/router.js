/**
 * Main API Router — Phase 5
 * Phase 1–4 routes: untouched.
 * Phase 5 additions: /decisions, /reports
 */

const express = require('express');
const router  = express.Router();

// Phase 1
const campaignsRouter       = require('./routes/campaigns');
const accountsRouter        = require('./routes/accounts');
const syncRouter            = require('./routes/sync');
// Phase 2
const insightsRouter        = require('./routes/insights');
// Phase 3
const dashboardRouter       = require('./routes/dashboard');
const recommendationsRouter = require('./routes/recommendations');
const alertsRouter          = require('./routes/alerts');
const settingsRouter        = require('./routes/settings');
const healthHistoryRouter   = require('./routes/healthHistory');
// Phase 5
const decisionsRouter       = require('./routes/decisions');
const reportsRouter         = require('./routes/reports');
// Phase 6B
const adsetsRouter          = require('./routes/adsets');
const adsRouter             = require('./routes/adRoutes');
// Phase 6C
const portfolioRouter       = require('./routes/portfolio');

router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '6.1.0', phase: 'Phase 6C — Full Integration' });
});

// Phase 1
router.use('/accounts',    accountsRouter);
router.use('/campaigns',   campaignsRouter);
router.use('/sync',        syncRouter);
// Phase 2
router.use('/campaigns/:id/insights', insightsRouter);
// Phase 3
router.use('/dashboard',       dashboardRouter);
router.use('/recommendations', recommendationsRouter);
router.use('/alerts',          alertsRouter);
router.use('/settings',        settingsRouter);
router.use('/health-history',  healthHistoryRouter);
// Phase 5
router.use('/decisions',  decisionsRouter);
router.use('/reports',    reportsRouter);
// Phase 6B
router.use('/adsets',     adsetsRouter);
router.use('/ads',        adsRouter);
// Phase 6C
router.use('/portfolio',  portfolioRouter);

router.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

module.exports = router;
