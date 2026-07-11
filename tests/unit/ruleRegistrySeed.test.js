'use strict';

require('../../src/services/ruleRegistrySeed');
const { listRules, listUnimplementedRules, executeRules, getRule } = require('../../src/services/ruleEngine');

describe('ruleRegistrySeed — inventory completeness', () => {
  test('registers every rule with a unique id (no accidental duplicates)', () => {
    const all = listRules();
    const ids = all.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.length).toBeGreaterThan(100); // MF2-MF7's ~117 named rules
  });

  test('every rule marked implementable:false carries a non-empty reason (never silently omitted)', () => {
    const unimplemented = listUnimplementedRules();
    expect(unimplemented.length).toBeGreaterThan(0);
    for (const rule of unimplemented) {
      expect(typeof rule.notImplementableReason).toBe('string');
      expect(rule.notImplementableReason.length).toBeGreaterThan(10);
    }
  });

  test('every rule attributed to an existing engine carries an attribution note', () => {
    const attributedRules = listRules().filter(r => r.sourceType && r.sourceType.startsWith('existing_'));
    expect(attributedRules.length).toBeGreaterThan(0);
    for (const rule of attributedRules) {
      expect(typeof rule.attribution).toBe('string');
      expect(rule.attribution.length).toBeGreaterThan(5);
    }
  });

  test('every native, implementable rule has conditions and a mapped action', () => {
    const native = listRules({ sourceType: 'rule_engine_native', implementable: true });
    expect(native.length).toBeGreaterThan(0);
    for (const rule of native) {
      expect(Array.isArray(rule.conditions)).toBe(true);
      expect(rule.conditions.length).toBeGreaterThan(0);
      expect(rule.action).toBeDefined();
      expect(typeof rule.category).toBe('string');
    }
  });

  test('a known rule (MF4.15.3 Frequency Fatigue) is registered with correct Framework attribution', () => {
    const rule = getRule('MF4.15.3');
    expect(rule.framework).toBe('MF4');
    expect(rule.category).toBe('audience');
  });
});

describe('ruleRegistrySeed — end-to-end firing against realistic metrics', () => {
  test('Frequency Fatigue (MF4.15.3) and Reach Exhaustion (MF5.13.8) both fire for a saturating engagement campaign', () => {
    const result = executeRules({
      objective: 'engagement',
      current: { frequency: 5, reach: 20000, ctr: 0.8 },
      deltas: { frequency: { delta_pct: 25 }, reach: { delta_pct: 1 }, ctr: { delta_pct: -18 } },
    });
    const ids = result.fired.map(f => f.rule_id);
    expect(ids).toContain('MF4.15.3');
    expect(ids).toContain('MF5.13.8');
  });

  test('High Bounce (MF7.10.10) fires when landing page views lag far behind link clicks', () => {
    const result = executeRules({
      objective: 'traffic',
      current: { link_clicks: 1000, landing_page_views: 250 },
      deltas: {},
    });
    expect(result.fired.map(f => f.rule_id)).toContain('MF7.10.10');
    const fired = result.fired.find(f => f.rule_id === 'MF7.10.10');
    expect(fired.action.type).toBe('FIX_TRACKING');
  });

  test('Conversion Collapse (MF7.10.11) is scoped to the sales objective only', () => {
    const metrics = {
      current: { clicks: 500, purchases: 3 },
      deltas: { purchases: { delta_pct: -45 }, clicks: { delta_pct: -3 } },
    };
    const sales = executeRules({ objective: 'sales', ...metrics });
    const leads = executeRules({ objective: 'leads', ...metrics });
    expect(sales.fired.map(f => f.rule_id)).toContain('MF7.10.11');
    expect(leads.fired.map(f => f.rule_id)).not.toContain('MF7.10.11');
  });

  test('no rules fire for a healthy, stable campaign', () => {
    const result = executeRules({
      objective: 'sales',
      current: { frequency: 2, reach: 10000, ctr: 1.5, link_clicks: 500, landing_page_views: 480, clicks: 500, purchases: 20 },
      deltas: { frequency: { delta_pct: 1 }, reach: { delta_pct: 5 }, ctr: { delta_pct: 2 }, purchases: { delta_pct: 3 }, clicks: { delta_pct: 2 } },
    });
    expect(result.fired).toHaveLength(0);
  });
});

describe('ruleRegistrySeed — grain filtering (Phase X.1 Runtime Unification)', () => {
  test('no native rule is ad_set-scoped today, so none fire at ad_set grain', () => {
    // Same saturating-engagement-campaign metrics that fire MF4.15.3 and
    // MF5.13.8 at campaign grain (see the test above) -- if grain filtering
    // regresses, this would start firing at ad_set grain silently.
    const metrics = {
      current: { frequency: 5, reach: 20000, ctr: 0.8, link_clicks: 1000, landing_page_views: 200, clicks: 500, purchases: 3, post_engagements: 500 },
      deltas: {
        frequency: { delta_pct: 25 }, reach: { delta_pct: 1 }, ctr: { delta_pct: -18 },
        purchases: { delta_pct: -45 }, post_engagements: { delta_pct: 15 },
      },
    };
    const adSetResult = executeRules({ objective: 'sales', entityType: 'ad_set', ...metrics });
    expect(adSetResult.fired).toHaveLength(0);

    // The exact same metrics DO fire at campaign grain (the default) --
    // proves this is grain filtering, not the metrics simply not matching.
    const campaignResult = executeRules({ objective: 'sales', entityType: 'campaign', ...metrics });
    expect(campaignResult.fired.length).toBeGreaterThan(0);
  });

  test('audience/tracking/landing-page rules (not creative-content rules) stay campaign-only at ad grain', () => {
    // MF5.13.8 (audience saturation) and MF7.10.10 (tracking) were never
    // made ad-scoped (Creative Intelligence Engine phase only widened the
    // creative-content rules -- MF4.13.3/13.4/13.5/13.12/15.2/15.4).
    const result = executeRules({
      objective: 'traffic', entityType: 'ad',
      current: { frequency: 5, reach: 20000, link_clicks: 1000, landing_page_views: 200 },
      deltas: { frequency: { delta_pct: 25 }, reach: { delta_pct: 1 } },
    });
    expect(result.fired.map(f => f.rule_id)).not.toContain('MF5.13.8');
    expect(result.fired.map(f => f.rule_id)).not.toContain('MF7.10.10');
  });

  test('creative-content rules (MF4.13.3/13.4/13.5/15.2/15.4) now fire at ad grain, per-creative (Creative Intelligence Engine phase)', () => {
    const metrics = {
      current: { video_p25_watched: 300, video_p50_watched: 100, frequency: 3, post_engagements: 50, purchases: 3 },
      deltas: {
        video_p25_watched: { delta_pct: -25 }, frequency: { delta_pct: 2 },
        post_engagements: { delta_pct: 15 }, purchases: { delta_pct: -30 },
      },
    };
    const adResult = executeRules({ objective: 'sales', entityType: 'ad', ...metrics });
    const ids = adResult.fired.map(f => f.rule_id);
    expect(ids).toContain('MF4.13.3');  // Low Hook Rate
    expect(ids).toContain('MF4.13.4');  // Low Hold Rate (video_p50/video_p25 ratio_lt 0.5)
    expect(ids).toContain('MF4.15.2');  // High Engagement, Low Conversion
    expect(ids).toContain('MF4.15.4');  // Visual Fatigue

    // Still fire at campaign grain too -- ad:true was additive, not a move.
    const campaignResult = executeRules({ objective: 'sales', entityType: 'campaign', ...metrics });
    expect(campaignResult.fired.map(f => f.rule_id)).toEqual(expect.arrayContaining(ids));
  });

  test('MF4.13.12 (Weak CTA) fires at ad grain only, from a categorical cta_type match', () => {
    const weak = executeRules({ objective: 'sales', entityType: 'ad', current: { cta_type: 'LEARN_MORE' }, deltas: {} });
    expect(weak.fired.map(f => f.rule_id)).toContain('MF4.13.12');
    const fired = weak.fired.find(f => f.rule_id === 'MF4.13.12');
    expect(fired.action.type).toBe('REFRESH_CREATIVE');
    expect(fired.evidence[0]).toMatchObject({ metric: 'cta_type', operator: 'in_set', actual: 'LEARN_MORE' });

    const strong = executeRules({ objective: 'sales', entityType: 'ad', current: { cta_type: 'SHOP_NOW' }, deltas: {} });
    expect(strong.fired.map(f => f.rule_id)).not.toContain('MF4.13.12');

    // Never fires at campaign/ad_set grain -- CTA is configured per creative, not aggregable.
    for (const entityType of ['campaign', 'ad_set']) {
      const result = executeRules({ objective: 'sales', entityType, current: { cta_type: 'LEARN_MORE' }, deltas: {} });
      expect(result.fired.map(f => f.rule_id)).not.toContain('MF4.13.12');
    }
  });
});
