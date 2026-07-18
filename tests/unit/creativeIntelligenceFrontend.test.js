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
    // Phase 44 — AI Strategic Advisor panel + supporting render helpers.
    'ciAdvisorStatusBadgeClass', 'ciPriorityBadgeClass', 'ciRiskBadgeClass',
    'ciRenderAdvisorPanel', 'ciRenderScoreRelationship', 'ciRenderBusinessImpact',
    'ciRenderRiskAssessment', 'ciBulletAlreadyShown', 'ciRenderPriorities', 'ciBenchmarkGrainRow', 'ciRenderBenchmark',
    'ciMergedTimelineRows',
    // Phase 45 — Executive Decision Layer render helpers.
    'ciDecisionColorClass', 'ciDecisionBorderVar', 'ciRenderExecutivePriorityCard', 'ciRenderWhyNot',
    'ciRenderConsistencyAudit', 'ciRenderExecutiveDecision', 'ciRenderMarketingDirectorPlan',
    'ciRenderContributionFormula', 'ciRenderBusinessImpactRanking',
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

    // Phase 44 — AI Strategic Advisor panel + upgraded recommendations/
    // benchmarking/timeline, all driven by the `advisor` bundle field.
    test('renders the AI Strategic Advisor panel and upgraded sections when advisor data is present', () => {
      const html = ciRenderDetails(baseDetail({
        advisor: {
          panel: {
            current_status: 'Scale', confidence: 89, priority: 'HIGH',
            reason: ['Creative quality is holding steady (score 68).', 'This creative still has room to scale before signs of audience fatigue appear.'],
            recommended_actions: ['Increase budget 20%', 'Keep current audience'],
            expected_result: 'Higher reach with stable CPA.', business_risk: 'LOW',
            potential_risks: ['Watch frequency after scaling (currently 1.4).'],
          },
          score_relationship: { pattern: 'both_high', explanation: 'Both health and creative quality are strong.', next_step: 'Keep the current creative running.' },
          priorities: [{
            priority: 1, priority_label: 'Highest Priority', tier: 'Immediate Actions', action: 'Duplicate Winner',
            why: 'Creative continues outperforming account average.', evidence_used: ['CTR +18%', 'CPA stable', 'Frequency 1.4'],
            confidence_pct: 92, confidence: 'high', expected_impact: 'Reach increase without major CPA increase.', risk: 'Low risk.',
            business_impact: { reach_increase: { range: '10-20%', probability: 'Medium' }, cpa_change: { range: '+/-10%', probability: 'Low' }, ctr_improvement: { range: null, probability: null } },
            risk_assessment: {
              implementation_risk: { level: 'Low', reason: 'x' }, learning_phase_risk: { level: 'Medium', reason: 'x' },
              audience_fatigue_risk: { level: 'Low', reason: 'x' }, budget_risk: { level: 'Medium', reason: 'x' }, performance_volatility: { level: 'Low', reason: 'x' },
            },
          }],
          benchmark: {
            comparison: { ad_set: { status: 'insufficient_data', reason: 'not enough peers' }, campaign: { status: 'insufficient_data', reason: 'not enough peers' }, account: { status: 'insufficient_data', reason: 'not enough peers' } },
            historical: { status: 'ok', trend: { ctr: { direction: 'improving' } } },
            previous_version: { status: 'no_version_change', reason: 'x' },
            account_best_worst: { status: 'ok', best: { ad_name: 'Best Ad', score_overall: 90, score_gap: 22 }, worst: { ad_name: 'Worst Ad', score_overall: 20, score_gap: 48 } },
          },
          comparison_breakdown: { winner_vs_weakest: { narrative: 'This creative wins because CTR is 26% higher. Compared against: Ad XYZ.' } },
          rich_timeline: { business_events: [{ type: 'ctr_peak', date: '2026-01-05', detail: 'New high CTR (3.5%), up 20% from the prior snapshot.' }], state_transitions: [], not_tracked_at_ad_grain: ['budget_changes', 'audience_changes'] },
        },
      }));
      expect(html).toContain('AI Strategic Advisor');
      expect(html).toContain('SCALE');
      expect(html).toContain('89%');
      expect(html).toContain('Increase budget 20%');
      expect(html).toContain('Higher reach with stable CPA.');
      expect(html).toContain('Creative Score vs. Ad Health');
      expect(html).toContain('Keep the current creative running.');
      expect(html).toContain('Immediate Actions');
      expect(html).toContain('CTR +18%');
      expect(html).toContain('Best Ad');
      expect(html).toContain('This creative wins because CTR is 26% higher');
      expect(html).toContain('New high CTR');
      expect(html).toContain('budget changes');
      expect(() => ciRenderDetails(baseDetail({ advisor: null }))).not.toThrow();
    });

    // Dashboard Normalization (Phase 46) — a recommendation's evidence bullet
    // that exactly repeats a fact already stated in the Advisor Panel's
    // "Reason" list directly above it must be shown once, not twice, while
    // any genuinely different evidence bullet on the same card is untouched.
    test('does not repeat an evidence bullet that already appears in the Advisor Panel reason', () => {
      const html = ciRenderDetails(baseDetail({
        advisor: {
          panel: {
            current_status: 'Scale', confidence: 89, priority: 'HIGH',
            reason: ['This creative still has room to scale before signs of audience fatigue appear.'],
            recommended_actions: ['Increase budget 20%'], expected_result: 'x', business_risk: 'LOW', potential_risks: [],
          },
          priorities: [{
            priority: 1, priority_label: 'Highest Priority', tier: 'Immediate Actions', action: 'Duplicate Winner',
            why: 'x', evidence_used: ['This creative still has room to scale before signs of audience fatigue appear.', 'CTR +18%'],
            confidence_pct: 92, confidence: 'high', expected_impact: 'x', risk: 'Low risk.',
          }],
        },
      }));
      const occurrences = (html.match(/still has room to scale/g) || []).length;
      expect(occurrences).toBe(1);
      expect(html).toContain('CTR +18%');
    });

    // Phase 45 — Executive Decision Layer: the single arbitrated verdict,
    // priority card, why-not explanations, marketing director plan, and
    // winning/loss formula, all driven by `executive_decision`.
    test('renders the Executive Decision card and its sub-sections when executive_decision data is present', () => {
      const html = ciRenderDetails(baseDetail({
        executive_decision: {
          decision: 'SCALE', confidence: 89, confidence_reason: '4 supporting signal(s), 0 conflicting signal(s).',
          why_not: { MONITOR: 'A clear scaling signal already exists.', PAUSE: 'Health score remains excellent.', STOP: 'No compounding failure present.', TEST: 'No single weak dimension stands out.', OPTIMIZE: 'No fatigue or refresh signal is active.' },
          consistency_audit: { signals_disagreed: true, resolution_rule: 'The more conservative signal always wins.', overrides: [{ from: 'SCALE', to: 'SCALE', because: 'Rule Engine finding "Weak CTA" suggested OPTIMIZE, but SCALE is not more conservative so it does not apply here -- kept for illustration.' }] },
          priority_card: { available: true, action: 'Rewrite the first sentence.', business_impact: 'Highest', confidence_pct: 88, reason: 'Weak hook is currently the largest growth bottleneck.', estimated_gain: 'Highest among all available actions.' },
          marketing_director_plan: { today: 'Keep campaign running.', tomorrow: 'Rewrite opening hook.', this_week: 'Launch Variant B.', next_week: 'Increase budget if CTR remains stable.' },
          winning_formula: { available: true, items: [{ factor: 'Trust', contribution_pct: 35, evidence: 'x' }, { factor: 'Offer', contribution_pct: 25, evidence: 'x' }] },
          loss_formula: { available: false, reason: 'This creative is currently winning, not losing.' },
          recommendations: [],
          dropped_recommendations: [{ action: 'Rewrite Hook', conflicts_with: 'Scale', reason: 'x' }],
        },
      }));
      expect(html).toContain('Executive Decision');
      expect(html).toContain('SCALE');
      expect(html).toContain('89%');
      expect(html).toContain('If you do only one thing today');
      expect(html).toContain('Rewrite the first sentence.');
      expect(html).toContain('Why not MONITOR?');
      expect(html).toContain('Signals disagreed');
      expect(html).toContain('If I were managing this account');
      expect(html).toContain('Launch Variant B.');
      expect(html).toContain('Winning Formula');
      expect(html).toContain('Trust');
      expect(html).toContain('35%');
      expect(html).toContain('Not shown (conflicted');
      expect(() => ciRenderDetails(baseDetail({ executive_decision: null }))).not.toThrow();
    });
  });
});
