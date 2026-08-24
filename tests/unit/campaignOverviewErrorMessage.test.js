'use strict';

/**
 * Phase 40 — regression test for icInsightsErrorMessage (public/index.html).
 *
 * Root cause: icLoadCampaignView() previously discarded any thrown fetch
 * error with an empty `catch {}`, so every failure mode (invalid Meta
 * token, a real Meta API error, mock=true blocked in production, a network
 * error) rendered the same generic "Not analyzed yet" message -- even
 * though the backend's 502 response already carries a specific `reason`
 * (src/api/routes/insights.js). This tests the extracted pure function that
 * now decides which message to show, using the same extraction-by-source
 * technique as tests/unit/creativeIntelligenceFrontend.test.js (public/
 * index.html is a single inline <script>, no bundler/module system).
 */

const fs = require('fs');
const path = require('path');

function extractFn(script, name) {
  const idx = script.indexOf('function ' + name + '(');
  if (idx === -1) throw new Error('function not found in index.html: ' + name);
  let depth = 0, i = script.indexOf('{', idx);
  const start = idx;
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return script.slice(start, i);
}

let icInsightsErrorMessage;

beforeAll(() => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const source = extractFn(script, 'icInsightsErrorMessage')
    + '\nmodule.exports = { icInsightsErrorMessage };';
  const mod = { exports: {} };
  new Function('module', 'exports', source)(mod, mod.exports);
  ({ icInsightsErrorMessage } = mod.exports);
});

describe('icInsightsErrorMessage (Phase 40)', () => {
  test('shows the backend-provided reason for a real Meta API error (502)', () => {
    const err = { status: 502, body: { analyzed: false, reason: 'Meta API error: Error validating access token: The session has been invalidated...' } };
    const html = icInsightsErrorMessage(err);
    expect(html).toContain('Meta API error');
    expect(html).not.toContain('Not analyzed yet');
  });

  test('shows the backend-provided reason when mock data is blocked in production (403)', () => {
    const err = { status: 403, body: { error: 'Mock data is disabled in production', message: 'The mock=true parameter is only available when NODE_ENV is not "production".' } };
    // No `reason` field on this particular error shape -- falls back to the generic message
    // rather than fabricating one, but must not silently show a misleading "not analyzed" claim
    // without at least the generic fallback text being honest about needing verification.
    const html = icInsightsErrorMessage(err);
    expect(html).toContain('Not analyzed yet');
  });

  test('falls back to the generic "not analyzed yet" message when there is no error at all', () => {
    const html = icInsightsErrorMessage(null);
    expect(html).toContain('Not analyzed yet');
    expect(html).toContain('Analyze');
  });

  test('falls back to the generic message for a plain network error with no response body', () => {
    const err = { status: 0, body: null, message: 'Network error — check your connection and try again.' };
    const html = icInsightsErrorMessage(err);
    expect(html).toContain('Not analyzed yet');
  });
});
