/**
 * Phase 48 — Authentication routes.
 * Mounted unauthenticated (before requireAuth) so login/logout/status are
 * always reachable, even when no session exists yet.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { checkCredentials } = require('../../middleware/auth');

// Brute-force protection on the login endpoint specifically -- mirrors the
// syncLimiter precedent in app.js (a tighter limit on a sensitive route,
// stacked in front of the general API limiter). Disabled under the test
// runner for the same reason all other rate limiters are.
const isTest = process.env.NODE_ENV === 'test';
const loginLimiter = isTest ? (req, res, next) => next() : rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

router.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (checkCredentials(email, password)) {
    req.session.authenticated = true;
    return res.json({ authenticated: true });
  }
  return res.status(401).json({ error: 'Invalid email or password' });
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ authenticated: false });
  req.session.destroy(() => {
    res.json({ authenticated: false });
  });
});

router.get('/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

module.exports = router;
