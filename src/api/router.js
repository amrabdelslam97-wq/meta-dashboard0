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
// Phase X.2
const ruleEngineRouter      = require('./routes/ruleEngine');
// Phase 17 — Executive Marketing Analytics Layer
const analyticsRouter       = require('./routes/analytics');
// Creative Intelligence Engine
const creativeIntelligenceRouter = require('./routes/creativeIntelligence');
// Phase 8 — Attribution & Customer Journey Intelligence
const attributionRouter      = require('./routes/attribution');
// Phase 20 — Audience, Placement, Device & Publisher Platform Intelligence
const intelligenceRouter     = require('./routes/intelligence');
// Phase 21 — Creative Intelligence Engine
const creativeIntelligence21Router = require('./routes/creativeIntelligence21');
// Phase 24 — Budget Intelligence & Attribution
const budgetRouter = require('./routes/budget');
// Phase 28 — Agency Operating System & Team Collaboration
const workspaceRouter = require('./routes/workspaceRoutes');

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
// Phase X.2
router.use('/rule-engine', ruleEngineRouter);
// Phase 17 — Executive Marketing Analytics Layer
router.use('/analytics', analyticsRouter);
// Creative Intelligence Engine
router.use('/creative-intelligence', creativeIntelligenceRouter);
// Phase 8 — Attribution & Customer Journey Intelligence
router.use('/attribution', attributionRouter);
// Phase 20 — Audience, Placement, Device & Publisher Platform Intelligence
router.use('/intelligence', intelligenceRouter);
// Phase 21 — Creative Intelligence Engine
router.use('/creative', creativeIntelligence21Router);
// Phase 24 — Budget Intelligence & Attribution
router.use('/budget', budgetRouter);
// Phase 28 — Agency Operating System & Team Collaboration
router.use('/workspaces', workspaceRouter);

router.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

module.exports = router;
