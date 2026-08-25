'use strict';

/**
 * Phase 40/41 — regression tests for the Campaign Overview data pipeline
 * (public/index.html): icInsightsErrorMessage, icFetchCampaignInsights,
 * icRenderCampaignOverview.
 *
 * Phase 40 root cause: icLoadCampaignView() discarded any thrown fetch
 * error with an empty `catch {}`, so every failure mode rendered the same
 * generic "Not analyzed yet" message even though the backend's 502
 * response already carries a specific `reason` (src/api/routes/insights.js).
 *
 * Phase 41: the automatic on-open load and the explicit Analyze button
 * (icAnalyze) previously had two independent fetch/catch implementations,
 * so only one was ever fixed. They now share one fetch (icFetchCampaignInsights)
 * and one render path (icRenderCampaignOverview) so this can't diverge again.
 *
 * public/index.html is a single inline <script>, no bundler/module system
 * -- functions are extracted by source text and eval'd, the same technique
 * as tests/unit/creativeIntelligenceFrontend.test.js.
 */

const fs = require('fs');
const path = require('path');

function extractFn(script, name) {
  let idx = script.indexOf('function ' + name + '(');
  if (idx === -1) throw new Error('function not found in index.html: ' + name);
  // Include a preceding "async " keyword, if present -- otherwise an
  // extracted async function loses its "async" and any `await` inside it
  // becomes a syntax error.
  const asyncPrefix = 'async ';
  const start = script.startsWith(asyncPrefix, idx - asyncPrefix.length) ? idx - asyncPrefix.length : idx;
  // Skip past the parameter list (paren-balanced) before looking for the
  // body's opening brace -- a destructured default parameter such as
  // `{ forceRefresh = false } = {}` contains its own braces that must not
  // be mistaken for the function body's opening brace.
  let parenDepth = 0, j = script.indexOf('(', idx);
  for (; j < script.length; j++) {
    if (script[j] === '(') parenDepth++;
    else if (script[j] === ')') { parenDepth--; if (parenDepth === 0) { j++; break; } }
  }
  let depth = 0, i = script.indexOf('{', j);
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return script.slice(start, i);
}

let icInsightsErrorMessage, icFetchCampaignInsights, icRenderCampaignOverview;

beforeAll(() => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const source = [
    extractFn(script, 'icInsightsErrorMessage'),
    extractFn(script, 'icFetchCampaignInsights'),
    extractFn(script, 'icRenderCampaignOverview'),
  ].join('\n\n') + '\nmodule.exports = { icInsightsErrorMessage, icFetchCampaignInsights, icRenderCampaignOverview };';
  const mod = { exports: {} };
  new Function('module', 'exports', source)(mod, mod.exports);
  ({ icInsightsErrorMessage, icFetchCampaignInsights, icRenderCampaignOverview } = mod.exports);
});

describe('icInsightsErrorMessage (Phase 40)', () => {
  test('shows the backend-provided reason for a real Meta API error (502)', () => {
    const err = { status: 502, body: { analyzed: false, reason: 'Meta API error: Error validating access token: The session has been invalidated...' } };
    const html = icInsightsErrorMessage(err);
    expect(html).toContain('Meta API error');
    expect(html).not.toContain('Not analyzed yet');
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

describe('icFetchCampaignInsights (Phase 41 — shared by auto-load and Analyze)', () => {
  const campaign = { id: 'internal-uuid-1', meta_campaign_id: 'meta-1' };

  beforeEach(() => {
    global.window = { ic: { insights: null } };
    global.addDateQ = (u) => u;
    global.insightsUrl = (u) => u;
  });

  test('returns cached insights without fetching when not forced and a cache exists', async () => {
    const cached = { analyzed: true, metrics: { spend: 10 } };
    global.window.ic.insights = cached;
    global.api = jest.fn(); // must never be called

    const { ins, err } = await icFetchCampaignInsights(campaign);
    expect(ins).toBe(cached);
    expect(err).toBeNull();
    expect(global.api).not.toHaveBeenCalled();
  });

  test('fetches fresh data on first load when no cache exists (automatic open — no Analyze click needed)', async () => {
    const fresh = { analyzed: true, metrics: { spend: 42 } };
    global.api = jest.fn().mockResolvedValue(fresh);

    const { ins, err } = await icFetchCampaignInsights(campaign);
    expect(global.api).toHaveBeenCalledTimes(1);
    expect(ins).toBe(fresh);
    expect(err).toBeNull();
    expect(global.window.ic.insights).toBe(fresh); // cached for subsequent renders
  });

  test('forceRefresh always re-fetches even when a cache exists (Analyze = explicit refresh)', async () => {
    global.window.ic.insights = { analyzed: true, metrics: { spend: 1 } };
    const refreshed = { analyzed: true, metrics: { spend: 999 } };
    global.api = jest.fn().mockResolvedValue(refreshed);

    const { ins, err } = await icFetchCampaignInsights(campaign, { forceRefresh: true });
    expect(global.api).toHaveBeenCalledTimes(1);
    expect(ins).toBe(refreshed);
    expect(err).toBeNull();
  });

  test('never throws -- a fetch failure is returned as { ins: null, err }, not swallowed', async () => {
    const apiError = { status: 502, body: { analyzed: false, reason: 'Meta API error: token invalid' }, message: 'Request failed (502)' };
    global.api = jest.fn().mockRejectedValue(apiError);

    const { ins, err } = await icFetchCampaignInsights(campaign, { forceRefresh: true });
    expect(ins).toBeNull();
    expect(err).toBe(apiError);
  });
});

describe('icRenderCampaignOverview (Phase 41)', () => {
  test('renders the specific reason, not fake data, when analyzed is false', () => {
    const el = { innerHTML: '' };
    const ins = { analyzed: false, reason: 'No Meta insights available for the selected period' };
    icRenderCampaignOverview(el, ins, { meta_campaign_id: 'meta-1', objective: 'sales' });
    expect(el.innerHTML).toContain('No Meta insights available for the selected period');
  });
});
