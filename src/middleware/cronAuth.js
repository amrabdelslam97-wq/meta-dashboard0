/**
 * Authentication for Vercel Cron-triggered routes. A cron invocation has
 * no browser session and must never be checked against the user-facing
 * signed-cookie auth (statelessAuth.js) -- it authenticates via Vercel's
 * standard convention: an `Authorization: Bearer <CRON_SECRET>` header,
 * which Vercel Cron sends automatically (its own docs describe this as the
 * documented pattern for securing a cron endpoint from being called by
 * anyone who guesses its URL).
 */

const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireCronSecret() {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new Error(
      'CRON_SECRET is not set. The cron-trigger route cannot authenticate requests without it. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      'and set CRON_SECRET in your environment (and as the matching value Vercel Cron sends).'
    );
  }
  return secret;
}

function requireCronAuth(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(500).json({ error: 'CRON_SECRET is not configured on this server.' });

  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  const provided = match ? match[1] : null;

  if (!provided || !timingSafeEqualStr(provided, expected)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return next();
}

module.exports = { requireCronAuth, requireCronSecret };
