/**
 * Meta Ads Intelligence System — Phase 3
 * Adds static file serving for the dashboard UI.
 * All Phase 1 and Phase 2 logic unchanged.
 */

require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const path    = require('path');
const { initializeDatabase }     = require('./db/database');
const { runMigrations }          = require('./db/schema');
const { runPhase2Migrations }    = require('./db/schema.phase2');
const { runPhase5Migrations }    = require('./db/schema.phase5');
const { runPhase6Migrations } = require('./db/schema.phase6');
const { runPhase7BMigrations } = require('./db/schema.phase7b');
const { runUniqueConstraintsMigration } = require('./db/schema.uniqueConstraints');
const { seedIntelligenceConfig } = require('./db/seedIntelligence');
const { encryptLegacyTokens }    = require('./db/encryptLegacyTokens');
const { requireEncryptionKey }   = require('./services/tokenCrypto');
const apiRouter                  = require('./api/router');
const { errorHandler }           = require('./middleware/errorHandler');

const PORT    = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || './data/meta_ads.db';

async function start() {
  // Fail fast and explain exactly what's needed rather than silently
  // starting with tokens stored in plaintext.
  requireEncryptionKey();

  await initializeDatabase(DB_PATH);
  runMigrations();
  runPhase2Migrations();
  runPhase5Migrations();
  runPhase6Migrations();
  runPhase7BMigrations();
  runUniqueConstraintsMigration();
  encryptLegacyTokens();
  seedIntelligenceConfig();

  const app = express();

  // Security headers. CSP is disabled because public/index.html is a
  // single-file dashboard relying on inline <script>/<style> and
  // inline event handlers (onclick=...) throughout -- the default
  // helmet CSP would block the dashboard from running. All other
  // helmet protections (X-Frame-Options, X-Content-Type-Options,
  // HSTS, etc.) stay enabled.
  app.use(helmet({ contentSecurityPolicy: false }));

  // CORS: this app serves its own dashboard from the same origin as
  // the API, so cross-origin access is closed by default. Set
  // ALLOWED_ORIGINS (comma-separated) to allow specific external
  // origins (e.g. a separately-hosted frontend) to call the API.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
  }));

  // Rate limiting: general API traffic gets a generous ceiling; the
  // Meta sync endpoint (which fans out into many Graph API calls per
  // request) gets a much tighter one to prevent accidental or
  // malicious hammering of the Meta API / rate limits on our own app.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  const syncLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many sync requests, please try again later.' },
  });

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
  app.use('/api/v1/sync', syncLimiter);
  app.use('/api/v1', apiLimiter, apiRouter);

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
