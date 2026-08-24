/**
 * Vercel serverless entrypoint — Meta Ads Intelligence Platform.
 *
 * Purely additive: does not modify src/app.js. Reuses its existing
 * createApp()/initializeApp() split (already designed for this exact
 * purpose — see src/app.js's own comment: "Used by both start() (real
 * server) and the Supertest integration tests"), only adding the
 * request-handler glue Vercel's Node.js runtime expects.
 *
 * Caches the initialized app at module scope so a warm serverless
 * container reuses it across invocations instead of re-running all
 * migrations on every request. On a cold start, initialization still
 * runs fresh — see VERCEL_MIGRATION_COMPLETION_REPORT.md for what that
 * means given this platform's sql.js file-based persistence.
 */

const { createApp, initializeApp } = require('../src/app');

let appPromise = null;

function getApp() {
  if (!appPromise) {
    appPromise = initializeApp().then(() => createApp());
  }
  return appPromise;
}

module.exports = async (req, res) => {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    // A failed cold-start init (e.g. a missing required secret) must not
    // hang the request or leak a stack trace to the client.
    appPromise = null; // allow the next invocation to retry rather than caching a permanent failure
    console.error('[Fatal] Serverless init failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server initialization failed' }));
  }
};
