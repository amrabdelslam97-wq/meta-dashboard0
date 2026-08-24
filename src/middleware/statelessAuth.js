/**
 * Stateless, signed-cookie authentication — replaces express-session's
 * in-memory MemoryStore. Justified directly by source evidence (see
 * VERCEL_MIGRATION_ARCHITECTURE_DECISION.md §4): req.session held exactly
 * one field anywhere in this codebase, `req.session.authenticated = true`
 * — no user id, no CSRF token, no OAuth state, nothing that requires
 * server-side storage. A signed cookie carrying just that boolean plus an
 * expiry reproduces the exact same behavior with zero external
 * infrastructure (no Redis/KV needed), which matters on Vercel where
 * per-process in-memory session storage doesn't survive across
 * invocations/instances.
 *
 * Cookie name, maxAge, httpOnly/secure/sameSite all match the previous
 * express-session config exactly, so no client-visible behavior changes.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'sid';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches the previous express-session cookie.maxAge exactly

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function requireSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is not set. Login cookies cannot be signed without it. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      'and set SESSION_SECRET in your .env file.'
    );
  }
  return secret;
}

function createAuthCookieValue() {
  const secret = requireSessionSecret();
  const payload = JSON.stringify({ authenticated: true, exp: Date.now() + MAX_AGE_MS });
  const payloadB64 = base64url(payload);
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

function verifyAuthCookieValue(value) {
  if (!value || typeof value !== 'string') return false;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;

  const parts = value.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;

  const expectedSig = sign(payloadB64, secret);
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!payload || payload.authenticated !== true) return false;
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;
  return true;
}

// Express only populates req.cookies when the `cookie-parser` middleware is
// installed. Rather than add a new dependency for one cookie, parse the
// raw header directly — the same minimal-dependency style already used
// elsewhere in this codebase (e.g. auth.js hand-rolling its own
// timing-safe string compare instead of pulling in a library for it).
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  };
}

function setAuthCookie(res) {
  res.cookie(COOKIE_NAME, createAuthCookieValue(), { ...cookieOptions(), maxAge: MAX_AGE_MS });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

function isAuthenticated(req) {
  return verifyAuthCookieValue(readCookie(req, COOKIE_NAME));
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_MS,
  setAuthCookie,
  clearAuthCookie,
  isAuthenticated,
  requireSessionSecret,
  // exported for unit testing only
  createAuthCookieValue,
  verifyAuthCookieValue,
};
