/**
 * Meta Ads Intelligence System
 * Express app entry point: runs migrations, wires security middleware,
 * serves the dashboard UI, and mounts the versioned API router.
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
const { runPhase8Migrations } = require('./db/schema.phase8');
const { runUniqueConstraintsMigration } = require('./db/schema.uniqueConstraints');
const { seedIntelligenceConfig } = require('./db/seedIntelligence');
const { encryptLegacyTokens }    = require('./db/encryptLegacyTokens');
const { requireEncryptionKey }   = require('./services/tokenCrypto');
const apiRouter                  = require('./api/router');
const { errorHandler }           = require('./middleware/errorHandler');

const PORT    = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || './data/meta_ads.db';

/**
 * Run the full migration set + fail-fast checks against the already
 * -initialized DB. Split out from start() so tests can seed a temp DB
 * with the exact same migration path the real server uses, without
 * also binding a port.
 */
async function initializeApp(dbPath = DB_PATH) {
  requireEncryptionKey();
  await initializeDatabase(dbPath);
  runMigrations();
  runPhase2Migrations();
  runPhase5Migrations();
  runPhase6Migrations();
  runPhase7BMigrations();
  runPhase8Migrations();
  runUniqueConstraintsMigration();
  encryptLegacyTokens();
  seedIntelligenceConfig();
}

/**
 * Build the Express app (middleware + routes), without binding a port.
 * Used by both start() (real server) and the Supertest integration
 * tests (which drive the app in-process via request(createApp())).
 */
function createApp() {
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
  // Disabled under the test runner -- a single Supertest run legitimately
  // fires far more than 20 requests at /sync across the whole suite,
  // and rate limiting itself is verified directly in its own test.
  const isTest = process.env.NODE_ENV === 'test';
  const apiLimiter = isTest ? (req, res, next) => next() : rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  const syncLimiter = isTest ? (req, res, next) => next() : rateLimit({
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

  // Serve static dashboard
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

  return app;
}

async function start() {
  // Fail fast and explain exactly what's needed rather than silently
  // starting with tokens stored in plaintext.
  await initializeApp(DB_PATH);

  const app = createApp();

  app.listen(PORT, () => {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Meta Ads Intelligence System');
    console.log('  Phase 6C — Full Integration');
    console.log(`  Open:  http://localhost:${PORT}`);
    console.log(`  API:   http://localhost:${PORT}/api/v1`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
}

if (require.main === module) {
  start().catch(err => { console.error('[Fatal]', err); process.exit(1); });
}

module.exports = { createApp, initializeApp };
