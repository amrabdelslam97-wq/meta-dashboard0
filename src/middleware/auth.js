/**
 * Session-cookie authentication for the single-user dashboard.
 *
 * There is exactly one admin identity, configured via USER_EMAIL/
 * USER_PASSWORD env vars (compared with a constant-time check -- no
 * hashing/storage needed since there's no user table, just one
 * operator-set credential pair). Mirrors tokenCrypto.js's
 * requireEncryptionKey() pattern: a boot-time secret check that fails
 * fast rather than silently starting insecure.
 */

const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare against itself so both branches take comparable time,
    // avoiding a length-based timing oracle.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkCredentials(email, password) {
  const expectedEmail = process.env.USER_EMAIL || '';
  const expectedPassword = process.env.USER_PASSWORD || '';
  if (!expectedEmail || !expectedPassword) return false;
  return timingSafeEqualStr(email, expectedEmail) && timingSafeEqualStr(password, expectedPassword);
}

function requireSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is not set. Login sessions cannot be signed without it. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      'and set SESSION_SECRET in your .env file.'
    );
  }
  return secret;
}

// Mounted at the '/api/v1' prefix, so req.path here is already relative
// (e.g. '/health', '/campaigns'). '/health' must stay reachable
// unauthenticated -- it's Railway's healthcheck target (railway.json).
function realRequireAuth(req, res, next) {
  if (req.path === '/health') return next();
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// Bypassed under the test runner, matching this codebase's existing
// rate-limiter precedent (src/app.js) -- otherwise every existing
// Supertest-driven API test would need to log in first.
const isTest = process.env.NODE_ENV === 'test';
const requireAuth = isTest ? (req, res, next) => next() : realRequireAuth;

module.exports = { requireAuth, checkCredentials, requireSessionSecret };
