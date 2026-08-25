'use strict';

/**
 * Phase 49 — regression test for the Campaigns page freshness label.
 *
 * Root cause: #last-updated is a single global topbar element only ever
 * written by loadDashboard() (via freshnessLabel(d.freshness)). /campaigns
 * already returns its own equivalent `freshness` field (campaigns.js), but
 * loadCampaigns() never read it, so the label kept showing whatever
 * loadDashboard() last wrote (or nothing) while viewing Campaigns. Fixed by
 * writing #last-updated from campsR.freshness using the same freshnessLabel()
 * helper loadDashboard() already uses.
 *
 * public/index.html is a single inline <script>, no bundler/module system --
 * functions are extracted by source text and eval'd, same technique as
 * tests/unit/campaignOverviewErrorMessage.test.js.
 */

const fs = require('fs');
const path = require('path');

function extractFn(script, name) {
  let idx = script.indexOf('function ' + name + '(');
  if (idx === -1) throw new Error('function not found in index.html: ' + name);
  const asyncPrefix = 'async ';
  const start = script.startsWith(asyncPrefix, idx - asyncPrefix.length) ? idx - asyncPrefix.length : idx;
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

let loadCampaigns, freshnessLabel;

beforeAll(() => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const source = [
    extractFn(script, 'freshnessLabel'),
    extractFn(script, 'loadCampaigns'),
  ].join('\n\n') + '\nmodule.exports = { freshnessLabel, loadCampaigns };';
  const mod = { exports: {} };
  new Function('module', 'exports', source)(mod, mod.exports);
  ({ freshnessLabel, loadCampaigns } = mod.exports);
});

describe('loadCampaigns() freshness label (Phase 49)', () => {
  let lastUpdatedEl, contentEl;

  beforeEach(() => {
    lastUpdatedEl = { innerHTML: '' };
    contentEl = { innerHTML: '' };
    global.document = {
      getElementById: jest.fn((id) => {
        if (id === 'last-updated') return lastUpdatedEl;
        if (id === 'content') return contentEl;
        return null;
      }),
    };
    global.window = { ic: {} };
    global.renderIC = jest.fn();
  });

  test('writes #last-updated from campsR.freshness (Campaigns-scoped), not left blank/untouched', async () => {
    const freshness = { last_sync_at: '2026-08-24T12:31:49.186Z', data_source: 'sqlite', sync_age_minutes: 5, stale: false };
    global.apiDate = jest.fn()
      .mockResolvedValueOnce({ data: [], freshness })
      .mockResolvedValueOnce({ data: [] });

    await loadCampaigns();

    expect(lastUpdatedEl.innerHTML).toBe(freshnessLabel(freshness));
    expect(lastUpdatedEl.innerHTML).toContain('5m ago');
    expect(lastUpdatedEl.innerHTML).not.toContain('stale');
  });

  test('reflects a stale Campaigns freshness value exactly like freshnessLabel() would render it directly', async () => {
    const freshness = { last_sync_at: '2026-08-23T00:00:00.000Z', data_source: 'sqlite', sync_age_minutes: 2280, stale: true };
    global.apiDate = jest.fn()
      .mockResolvedValueOnce({ data: [], freshness })
      .mockResolvedValueOnce({ data: [] });

    await loadCampaigns();

    expect(lastUpdatedEl.innerHTML).toBe(freshnessLabel(freshness));
    expect(lastUpdatedEl.innerHTML).toContain('38h ago');
    expect(lastUpdatedEl.innerHTML).toContain('stale');
  });

  test('still populates window.ic.campaigns from campsR.data -- no other Campaigns behavior changed', async () => {
    const campaigns = [{ id: 'c1', meta_campaign_id: 'm1', status: 'active', name: 'Test Campaign' }];
    global.apiDate = jest.fn()
      .mockResolvedValueOnce({ data: campaigns, freshness: { sync_age_minutes: 1, stale: false } })
      .mockResolvedValueOnce({ data: [] });

    await loadCampaigns();

    expect(global.window.ic.campaigns).toEqual(campaigns);
    expect(global.window.ic.selectedCampaign).toEqual(campaigns[0]);
    expect(global.renderIC).toHaveBeenCalledTimes(1);
  });
});
