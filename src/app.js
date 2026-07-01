/**
 * Meta Ads Intelligence System — Phase 3
 * Adds static file serving for the dashboard UI.
 * All Phase 1 and Phase 2 logic unchanged.
 */

require('dotenv').config();

const express = require('express');
const path    = require('path');
const { initializeDatabase }     = require('./db/database');
const { runMigrations }          = require('./db/schema');
const { runPhase2Migrations }    = require('./db/schema.phase2');
const { runPhase5Migrations }    = require('./db/schema.phase5');
const { runPhase6Migrations } = require('./db/schema.phase6');
const { seedIntelligenceConfig } = require('./db/seedIntelligence');
const apiRouter                  = require('./api/router');
const { errorHandler }           = require('./middleware/errorHandler');

const PORT    = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || './data/meta_ads.db';

async function start() {
  await initializeDatabase(DB_PATH);
  runMigrations();
  runPhase2Migrations();
  runPhase5Migrations();
  runPhase6Migrations();
  seedIntelligenceConfig();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  // Phase 3: serve static dashboard
  app.use(express.static(path.join(__dirname, '../public')));

  // API routes
  app.use('/api/v1', apiRouter);

  // SPA fallback — all non-API routes serve index.html
  app.get('/{*path}', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  app.use(errorHandler);

  app.listen(PORT, () => {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Meta Ads Intelligence System');
    console.log('  Phase 6A — Multi-Entity Intelligence');
    console.log(`  Open:  http://localhost:${PORT}`);
    console.log(`  API:   http://localhost:${PORT}/api/v1`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
}

start().catch(err => { console.error('[Fatal]', err); process.exit(1); });
