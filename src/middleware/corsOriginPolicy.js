/**
 * CORS Origin Policy
 *
 * Decides whether a request's Origin header should be allowed, without ever
 * hardcoding a specific host (localhost, a LAN IP, a production domain, ...).
 *
 * Two things are always allowed, computed fresh per request:
 *   1. No Origin header at all -- same-origin simple GETs, curl, server-to-
 *      server calls. Browsers only attach Origin for cross-origin requests
 *      and for same-origin "unsafe" methods (POST/PATCH/DELETE, or any
 *      request with a non-simple Content-Type like application/json).
 *   2. An Origin that exactly matches the origin this request actually
 *      arrived on (protocol + host, from req.protocol/req.get('host')).
 *      This is what makes the bundled dashboard's own same-origin
 *      POST/PATCH/DELETE fetch() calls work automatically on localhost, a
 *      LAN IP, or a production domain -- with zero configuration, and
 *      without ever special-casing "localhost" in code.
 *
 * Anything else is only allowed if it's in the explicit ALLOWED_ORIGINS
 * allowlist (for a genuinely separate, externally-hosted frontend origin).
 * Everything else is rejected -- this never weakens the reject path, it
 * only adds the same-origin case that was previously missing.
 */

function parseAllowedOrigins(envValue) {
  return (envValue || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
}

/**
 * The origin (protocol://host) this request actually arrived on. Honors
 * X-Forwarded-Proto/Host when Express's "trust proxy" setting is enabled
 * (see TRUST_PROXY in app.js), so a reverse-proxy deployment resolves to
 * its real public origin instead of the proxy's internal connection.
 */
function requestOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function isOriginAllowed(origin, serverOrigin, allowedOrigins) {
  if (!origin) return true;
  if (origin === serverOrigin) return true;
  return allowedOrigins.includes(origin);
}

module.exports = { parseAllowedOrigins, requestOrigin, isOriginAllowed };
