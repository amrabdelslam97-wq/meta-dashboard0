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
const { runPhase11Migrations } = require('./db/schema.phase11');
const { runPhase12Migrations } = require('./db/schema.phase12');
const { runPhase13Migrations } = require('./db/schema.phase13');
const { runPhase14Migrations } = require('./db/schema.phase14');
const { runPhase15Migrations } = require('./db/schema.phase15');
const { runPhase16Migrations } = require('./db/schema.phase16');
const { runPhase17Migrations } = require('./db/schema.phase17');
const { runPhase18Migrations } = require('./db/schema.phase18');
const { runPhase19Migrations } = require('./db/schema.phase19');
const { runPhase20Migrations } = require('./db/schema.phase20');
const { runPhase21Migrations } = require('./db/schema.phase21');
const { runPhase22Migrations } = require('./db/schema.phase22');
const { runPhase23Migrations } = require('./db/schema.phase23');
const { runPhase24Migrations } = require('./db/schema.phase24');
const { runPhase28Migrations } = require('./db/schema.phase28');
const { runPhase29Migrations } = require('./db/schema.phase29');
const { runPhase30Migrations } = require('./db/schema.phase30');
const { seedIntelligenceConfig } = require('./db/seedIntelligence');
const { startAutoSyncScheduler } = require('./services/autoSyncScheduler');
const { recoverInterruptedSyncs } = require('./services/syncService');
const { encryptLegacyTokens }    = require('./db/encryptLegacyTokens');
const { requireEncryptionKey }   = require('./services/tokenCrypto');
const apiRouter                  = require('./api/router');
const { errorHandler }           = require('./middleware/errorHandler');
const { parseAllowedOrigins, requestOrigin, isOriginAllowed } = require('./middleware/corsOriginPolicy');
const { displayBanner }          = require('./startup-banner');

/**
 * Parse TRUST_PROXY into whatever Express's "trust proxy" setting expects
 * (boolean / hop count / IP-or-subnet list) -- env vars only ever give us
 * strings. Left unset by default (Express's own default: trust nothing),
 * so a directly-exposed deployment can't have req.protocol or IP-based
 * rate limiting spoofed via a forged X-Forwarded-* header from an
 * untrusted client. Only set this when actually running behind a real
 * reverse proxy that overwrites/strips inbound X-Forwarded-* itself.
 */
function parseTrustProxy(raw) {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return isNaN(Number(raw)) ? raw : Number(raw);
}

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
  runPhase11Migrations();
  runPhase12Migrations();
  runPhase13Migrations();
  runPhase14Migrations();
  runPhase15Migrations();
  runPhase16Migrations();
  runPhase17Migrations();
  runPhase18Migrations();
  runPhase19Migrations();
  runPhase20Migrations();
  runPhase21Migrations();
  runPhase22Migrations();
  runPhase23Migrations();
  runPhase24Migrations();
  runPhase28Migrations();
  runPhase29Migrations();
  runPhase30Migrations();
  encryptLegacyTokens();
  seedIntelligenceConfig();

  // Task 2 — Automatic Recovery For Interrupted Sync. Must run after every
  // migration (needs the full ad_accounts column set) and before the
  // scheduler starts (start(), below) so no account is ever left stuck in
  // last_sync_status='running' from a prior ungraceful shutdown.
  const recovery = recoverInterruptedSyncs();
  if (recovery.recovered > 0) {
    console.log(`[Sync] Recovered ${recovery.recovered} interrupted sync(s) on startup.`);
  }
}

/**
 * Build the Express app (middleware + routes), without binding a port.
 * Used by both start() (real server) and the Supertest integration
 * tests (which drive the app in-process via request(createApp())).
 */
function createApp() {
  const app = express();

  // Opt-in only -- see parseTrustProxy()'s comment above. Must be set
  // before anything reads req.protocol/req.ip (CORS below, and
  // express-rate-limit further down both do).
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

  // Security headers. CSP is disabled because public/index.html is a
  // single-file dashboard relying on inline <script>/<style> and
  // inline event handlers (onclick=...) throughout -- the default
  // helmet CSP would block the dashboard from running. All other
  // helmet protections (X-Frame-Options, X-Content-Type-Options,
  // HSTS, etc.) stay enabled.
  app.use(helmet({ contentSecurityPolicy: false }));

  // CORS: same-origin requests (including the bundled dashboard's own
  // POST/PATCH/DELETE fetch() calls, which -- unlike simple GETs --
  // browsers send with an Origin header even when same-origin) are always
  // allowed automatically, computed fresh per request from that request's
  // own protocol+host -- never a hardcoded "localhost". Set ALLOWED_ORIGINS
  // (comma-separated) to additionally allow specific external origins
  // (e.g. a separately-hosted frontend calling this API cross-origin).
  // Everything else is rejected exactly as before.
  //
  // Uses cors()'s per-request "options delegate" form (a function passed
  // directly to cors(), receiving (req, callback)) instead of a static
  // options object, purely to get access to req -- the actual CORS
  // enforcement is still done entirely by the same `cors` middleware.
  app.use(cors((req, callback) => {
    const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
    const serverOrigin = requestOrigin(req);
    callback(null, {
      origin(origin, cb) {
        if (isOriginAllowed(origin, serverOrigin, allowedOrigins)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
      },
    });
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

  startAutoSyncScheduler();

  app.listen(PORT, () => {
    displayBanner({
      port: PORT,
      environment: process.env.NODE_ENV || 'development',
      dbPath: DB_PATH,
      startTime: new Date(),
    });
  });
}

if (require.main === module) {
  start().catch(err => { console.error('[Fatal]', err); process.exit(1); });
}

module.exports = { createApp, initializeApp };
