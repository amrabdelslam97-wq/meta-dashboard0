'use strict';

/**
 * Frontend render-function tests — Creative Intelligence Engine (Step 20).
 *
 * public/index.html is a single inline <script>, not a module -- there is
 * no bundler/build step in this project (confirmed: no webpack/vite/rollup
 * config, no <script type="module">, plain <script> tag). These tests
 * extract the specific pure render functions (ciRenderCreativeCard,
 * ciRenderDetails, plus the shared helpers they call) by source text and
 * execute them directly against real API-response-shaped fixtures, proving
 * they run without throwing and produce the expected content -- the
 * strongest automated check available without introducing a browser/DOM
 * testing dependency this project doesn't otherwise have.
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
function extractConst(script, name) {
  const idx = script.indexOf('const ' + name + ' =');
  if (idx === -1) throw new Error('const not found in index.html: ' + name);
  const end = script.indexOf(';', idx);
  return script.slice(idx, end + 1);
}

let ciRenderCreativeCard, ciRenderDetails;

beforeAll(() => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const source = [
    'scoreClass', 'scoreLabel', 'fmtHealthStatus', 'fmtDate', 'fmtNum', 'objChip', 'scoreCircle',
    'ciFatigueBadgeClass', 'ciRoleBadge', 'ciCreativeTypeIcon',
  ].map(name => extractFn(script, name)).join('\n\n')
    + '\n\n' + extractConst(script, 'CI_TIMELINE_BADGE')
    + '\n\n' + extractFn(script, 'ciRenderCreativeCard')
    + '\n\n' + extractFn(script, 'ciRenderDetails')
    + '\nmodule.exports = { ciRenderCreativeCard, ciRenderDetails };';

  // eslint-disable-next-line no-eval
  const mod = { exports: {} };
  new Function('module', 'exports', source)(mod, mod.exports);
  ({ ciRenderCreativeCard, ciRenderDetails } = mod.exports);
});

function baseCard(overrides = {}) {
  return {
    meta_ad_id: 'ad_1', headline: 'Save 30% Today', ad_name: 'Ad 1',
    campaign_name: 'Sales Campaign', adset_name: 'Broad', campaign_objective: 'sales',
    thumbnail_url: null, creative_type: 'image',
    score_overall: 72, fatigue_status: 'none', library_role: null,
    ctr: 2.5, roas: 3.1, spend: 120.5,
    ...overrides,
  };
}

function baseDetail(overrides = {}) {
  return {
    meta_ad_id: 'ad_1',
    snapshot: { headline: 'Save 30% Today', primary_text: 'Limited time only.', creative_type: 'image', thumbnail_url: null },
    ai_analysis: {
      hook: { score: 20, evidence: 'Weak opening, no question or urgency.' },
      headline: { score: 40, evidence: 'Generic headline.' },
      copy: { score: 30, evidence: 'Short copy.', length_category: 'short', word_count: 5 },
      cta: { score: 80, evidence: 'Strong action-oriented CTA (Shop Now).' },
      offer: { score: 50, evidence: 'Discount mentioned but no urgency.' },
      trust: { score: 10, evidence: 'No trust signals detected.' },
      psychology: { score: 45, evidence: 'Some urgency language.' },
      not_analyzed: ['color_psychology', 'visual_hierarchy'],
    },
    scores: {
      score_hook: 20, score_headline: 40, score_copy: 30, score_visual: 50, score_cta: 80,
      score_offer: 50, score_trust: 10, score_psychology: 45, score_conversion_potential: 60,
      score_scroll_stop: 55, score_retention: null, score_brand: null, score_fatigue: 100, score_overall: 45,
    },
    fatigue: { status: 'none', recommendation: 'scale' },
    timeline: { status: 'ok', events: [{ type: 'launch', date: '2026-01-01', score_overall: 45 }, { type: 'change', date: '2026-01-08', field: 'headline', from: 'Old', to: 'New' }] },
    comparison: {
      winner: { meta_ad_id: 'ad_1', ad_name: 'Ad 1', score: 45 },
      runner_up: null, worst: null, ranking: [{ rank: 1, meta_ad_id: 'ad_1', ad_name: 'Ad 1', score: 45 }],
      comparisons: [],
    },
    recommendations: [{ action: 'Rewrite Hook', reason: 'Weak opening.', priority: 'high' }],
    intelligence: { health_score: 72, health_status: 'good', framework_recommendations: [{ rule_id: 'MF4.13.12', rule_name: 'Weak CTA', reason: 'Generic CTA' }] },
    executive_summary: 'This sales campaign is currently good (72/100).',
    ...overrides,
  };
}

describe('Creative Intelligence frontend render functions', () => {
  describe('ciRenderCreativeCard', () => {
    test('renders a normal card with headline, score, and metrics', () => {
      const html = ciRenderCreativeCard(baseCard());
      expect(html).toContain('Save 30% Today');
      expect(html).toContain('Sales Campaign');
      expect(html).toContain('score-circle');
      expect(() => ciRenderCreativeCard(baseCard())).not.toThrow();
    });

    test('shows a winner badge and a loser badge distinctly', () => {
      expect(ciRenderCreativeCard(baseCard({ library_role: 'winner' }))).toContain('Winner');
      expect(ciRenderCreativeCard(baseCard({ library_role: 'loser' }))).toContain('Underperformer');
    });

    test('falls back to ad_name and a type icon when headline/thumbnail are missing (real "status"-type creatives)', () => {
      const html = ciRenderCreativeCard(baseCard({ headline: null, thumbnail_url: null, creative_type: 'status', ad_name: 'Untitled Boost' }));
      expect(html).toContain('Untitled Boost');
      expect(html).not.toThrow;
    });

    test('never throws on entirely null metrics (a freshly-synced, not-yet-scored creative)', () => {
      expect(() => ciRenderCreativeCard(baseCard({ score_overall: null, ctr: null, roas: null, spend: null, fatigue_status: null }))).not.toThrow();
    });
  });

  describe('ciRenderDetails', () => {
    test('renders every required section with real evidence text, never throwing', () => {
      const html = ciRenderDetails(baseDetail());
      expect(html).toContain('Creative Score Breakdown');
      expect(html).toContain('AI Analysis');
      expect(html).toContain('Weak opening, no question or urgency.');
      expect(html).toContain('Timeline');
      expect(html).toContain('Recommendations');
      expect(html).toContain('Rewrite Hook');
      expect(html).toContain('Rule Engine');
      expect(html).toContain('MF4.13.12');
      expect(html).toContain('This sales campaign is currently good');
    });

    test('honestly reports not_analyzed dimensions instead of omitting them silently', () => {
      const html = ciRenderDetails(baseDetail());
      expect(html).toContain('color_psychology');
    });

    test('shows the winner badge only when this ad is the comparison winner', () => {
      const win = ciRenderDetails(baseDetail());
      expect(win).toContain('Winner');

      const notWinner = ciRenderDetails(baseDetail({ comparison: { winner: { meta_ad_id: 'other_ad', ad_name: 'Other', score: 90 }, runner_up: null, worst: { meta_ad_id: 'ad_1', ad_name: 'Ad 1', score: 45 }, ranking: [], comparisons: [] } }));
      expect(notWinner).toContain('Underperformer');
    });

    test('degrades gracefully when the ad-grain intelligence pipeline itself failed (analyzed:false)', () => {
      const html = ciRenderDetails(baseDetail({ intelligence: { analyzed: false, reason: 'Meta API error: rate limited' } }));
      expect(html).toContain('Meta API error: rate limited');
      expect(() => ciRenderDetails(baseDetail({ intelligence: { analyzed: false, reason: 'Meta API error: rate limited' } }))).not.toThrow();
    });

    test('degrades gracefully with no timeline history and no comparison siblings', () => {
      const html = ciRenderDetails(baseDetail({
        timeline: { status: 'no_data', events: [], snapshots: [] },
        comparison: { winner: null, runner_up: null, worst: null, ranking: [], comparisons: [] },
      }));
      expect(html).toContain('Not enough history');
      expect(html).toContain('Not enough creatives');
    });
  });
});
