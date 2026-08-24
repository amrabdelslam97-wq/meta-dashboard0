'use strict';

/**
 * Unit tests for the stateless signed-cookie auth that replaces
 * express-session (see src/middleware/statelessAuth.js header for why).
 * Exercises exactly the behaviors the migration mission required to be
 * preserved: sign/verify round-trip, expiry, tampering rejection, and
 * missing-secret fail-fast.
 */

const crypto = require('crypto');

describe('statelessAuth', () => {
  const OLD_ENV = process.env.SESSION_SECRET;

  beforeEach(() => {
    jest.resetModules();
    process.env.SESSION_SECRET = 'test-secret-do-not-use-in-real-env';
  });

  afterAll(() => {
    process.env.SESSION_SECRET = OLD_ENV;
  });

  test('a freshly created cookie value verifies as authenticated', () => {
    const { createAuthCookieValue, verifyAuthCookieValue } = require('../../src/middleware/statelessAuth');
    const value = createAuthCookieValue();
    expect(verifyAuthCookieValue(value)).toBe(true);
  });

  test('rejects a tampered payload (signature mismatch)', () => {
    const { createAuthCookieValue, verifyAuthCookieValue } = require('../../src/middleware/statelessAuth');
    const value = createAuthCookieValue();
    const [payloadB64, sig] = value.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ authenticated: true, exp: Date.now() + 999999999 })).toString('base64url');
    expect(verifyAuthCookieValue(`${forgedPayload}.${sig}`)).toBe(false);
  });

  test('rejects a value signed with a different secret', () => {
    const { createAuthCookieValue } = require('../../src/middleware/statelessAuth');
    const value = createAuthCookieValue();
    process.env.SESSION_SECRET = 'a-different-secret';
    jest.resetModules();
    const { verifyAuthCookieValue } = require('../../src/middleware/statelessAuth');
    expect(verifyAuthCookieValue(value)).toBe(false);
  });

  test('rejects an expired cookie', () => {
    jest.resetModules();
    const statelessAuth = require('../../src/middleware/statelessAuth');
    // Build an already-expired payload directly (bypassing createAuthCookieValue's real expiry) to test the expiry check in isolation.
    const payload = JSON.stringify({ authenticated: true, exp: Date.now() - 1000 });
    const payloadB64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest('base64url');
    expect(statelessAuth.verifyAuthCookieValue(`${payloadB64}.${sig}`)).toBe(false);
  });

  test('rejects malformed values (wrong shape, empty, non-string)', () => {
    const { verifyAuthCookieValue } = require('../../src/middleware/statelessAuth');
    expect(verifyAuthCookieValue(null)).toBe(false);
    expect(verifyAuthCookieValue(undefined)).toBe(false);
    expect(verifyAuthCookieValue('')).toBe(false);
    expect(verifyAuthCookieValue('not-a-valid-cookie')).toBe(false);
    expect(verifyAuthCookieValue('a.b.c')).toBe(false);
  });

  test('rejects a payload claiming authenticated:false', () => {
    const payload = JSON.stringify({ authenticated: false, exp: Date.now() + 999999 });
    const payloadB64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest('base64url');
    const { verifyAuthCookieValue } = require('../../src/middleware/statelessAuth');
    expect(verifyAuthCookieValue(`${payloadB64}.${sig}`)).toBe(false);
  });

  test('requireSessionSecret() throws a clear error when SESSION_SECRET is unset', () => {
    delete process.env.SESSION_SECRET;
    jest.resetModules();
    const { requireSessionSecret } = require('../../src/middleware/statelessAuth');
    expect(() => requireSessionSecret()).toThrow(/SESSION_SECRET is not set/);
  });

  test('isAuthenticated(req) reads the "sid" cookie from the raw Cookie header and validates it', () => {
    const { createAuthCookieValue, isAuthenticated, COOKIE_NAME } = require('../../src/middleware/statelessAuth');
    expect(COOKIE_NAME).toBe('sid');
    const value = createAuthCookieValue();
    const reqWithValidCookie = { headers: { cookie: `sid=${encodeURIComponent(value)}; other=ignored` } };
    expect(isAuthenticated(reqWithValidCookie)).toBe(true);

    const reqWithNoCookie = { headers: {} };
    expect(isAuthenticated(reqWithNoCookie)).toBe(false);

    const reqWithWrongCookie = { headers: { cookie: 'sid=garbage' } };
    expect(isAuthenticated(reqWithWrongCookie)).toBe(false);
  });

  test('setAuthCookie/clearAuthCookie call res.cookie/res.clearCookie with matching name and security flags', () => {
    const { setAuthCookie, clearAuthCookie, COOKIE_NAME, MAX_AGE_MS } = require('../../src/middleware/statelessAuth');
    const res = { cookie: jest.fn(), clearCookie: jest.fn() };

    setAuthCookie(res);
    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, value, opts] = res.cookie.mock.calls[0];
    expect(name).toBe(COOKIE_NAME);
    expect(typeof value).toBe('string');
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.maxAge).toBe(MAX_AGE_MS);
    expect(opts.maxAge).toBe(30 * 24 * 60 * 60 * 1000); // matches the previous express-session maxAge exactly

    clearAuthCookie(res);
    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
  });
});
