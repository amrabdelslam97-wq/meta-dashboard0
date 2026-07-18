'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');
const { computeCreativeScore } = require('../../src/services/creativeIntelligenceEngine');
const { getCreativeTimeline, searchCreativeLibrary, getAdSetComparison, getCreativeDetails, getAccountBestWorstCreative, getCrossModuleSignals } = require('../../src/services/creativeLibrary');

describe('creativeLibrary', () => {
  let testDb;
  let accountId, campaignId, adSetId;

  function insertAd(metaAdId, name = 'Ad') {
    const id = uuidv4();
    testDb.db.run(
      `INSERT INTO ads (id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
      [id, adSetId, campaignId, accountId, metaAdId, name]
    );
    return id;
  }

  function insertSnapshot({ metaAdId, since, until, scoreOverall, fatigueStatus = 'none', fatigueRecommendation = null, headline = 'Shop Now', cta = 'SHOP_NOW', creativeType = 'image' }) {
    testDb.db.run(
      `INSERT INTO creative_analytics
         (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_type, headline, cta_type,
          date_since, date_until, spend, results, ctr, cpa, score_overall, fatigue_status, fatigue_recommendation, calculated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [uuidv4(), accountId, metaAdId, 'adset_lib_1', 'camp_lib_1', creativeType, headline, cta,
        since, until, 100, 10, 2, 10, scoreOverall, fatigueStatus, fatigueRecommendation]
    );
  }

  // Builds a snapshot the way creativeAnalytics.js's real persist step
  // does: score_* columns + ai_analysis_json both derived from the SAME
  // computeCreativeScore() call, never hand-rolled independently -- a
  // details-page row with scores but no text_analysis (or vice versa) can't
  // actually occur in production, so the fixture shouldn't simulate one.
  function insertScoredSnapshot({ metaAdId, since, until, fatigueStatus = 'none', fatigueRecommendation = null }) {
    const creative = {
      headline: 'Save 30% Today', primary_text: 'Tired of overpaying? Save big. Trusted by thousands.',
      description: 'Free shipping.', cta_type: 'SHOP_NOW', media_type: 'image',
      spend: 100, results: 10, ctr: 2.5, cost_per_result: 10,
    };
    const scored = computeCreativeScore(creative, { status: fatigueStatus });
    testDb.db.run(
      `INSERT INTO creative_analytics
         (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_type, headline, cta_type,
          date_since, date_until, spend, results, ctr, cpa,
          score_hook, score_headline, score_copy, score_visual, score_cta, score_offer, score_trust, score_psychology,
          score_conversion_potential, score_scroll_stop, score_retention, score_brand, score_fatigue, score_overall,
          ai_analysis_json, fatigue_status, fatigue_recommendation, calculated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [uuidv4(), accountId, metaAdId, 'adset_lib_1', 'camp_lib_1', 'image', creative.headline, creative.cta_type,
        since, until, creative.spend, creative.results, creative.ctr, creative.cost_per_result,
        scored.score_hook, scored.score_headline, scored.score_copy, scored.score_visual, scored.score_cta,
        scored.score_offer, scored.score_trust, scored.score_psychology, scored.score_conversion_potential,
        scored.score_scroll_stop, scored.score_retention, scored.score_brand, scored.score_fatigue, scored.score_overall,
        JSON.stringify(scored.text_analysis), fatigueStatus, fatigueRecommendation]
    );
  }

  beforeAll(async () => {
    testDb = await createTestDb();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_lib', 'Creative Library Test', ?, datetime('now'), datetime('now'))`,
      [accountId, encryptToken('fake-token')]
    );

    campaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_lib_1', 'Library Test Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId]
    );

    adSetId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_lib_1', 'Library Test Ad Set', 'active', datetime('now'), datetime('now'))`,
      [adSetId, campaignId, accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  describe('getCreativeTimeline', () => {
    test('returns no_data for an ad with zero snapshots', () => {
      expect(getCreativeTimeline('nonexistent_ad')).toEqual({ status: 'no_data', events: [], snapshots: [] });
    });

    test('returns insufficient_data (launch only) for a single snapshot', () => {
      const adId = 'ad_timeline_single';
      insertAd(adId);
      insertSnapshot({ metaAdId: adId, since: '2026-01-01', until: '2026-01-07', scoreOverall: 70 });

      const result = getCreativeTimeline(adId);
      expect(result.status).toBe('insufficient_data');
      expect(result.events).toEqual([{ type: 'launch', date: '2026-01-01', score_overall: 70, fatigue_status: 'none' }]);
    });

    test('detects launch, peak, decline, fatigue, recovery, and a content change across a realistic multi-period history', () => {
      const adId = 'ad_timeline_full';
      insertAd(adId);
      insertSnapshot({ metaAdId: adId, since: '2026-01-01', until: '2026-01-07', scoreOverall: 60, headline: 'Original Headline' });
      insertSnapshot({ metaAdId: adId, since: '2026-01-08', until: '2026-01-14', scoreOverall: 85, headline: 'Original Headline' }); // peak
      insertSnapshot({ metaAdId: adId, since: '2026-01-15', until: '2026-01-21', scoreOverall: 60, fatigueStatus: 'moderate', fatigueRecommendation: 'refresh', headline: 'Original Headline' }); // decline (85->60 = 29% drop) + fatigue
      insertSnapshot({ metaAdId: adId, since: '2026-01-22', until: '2026-01-28', scoreOverall: 82, fatigueStatus: 'none', headline: 'Refreshed Headline' }); // recovery + content change

      const result = getCreativeTimeline(adId);
      expect(result.status).toBe('ok');
      const types = result.events.map(e => e.type);
      expect(types).toEqual(expect.arrayContaining(['launch', 'peak', 'decline', 'fatigue', 'recovery', 'change']));

      const peak = result.events.find(e => e.type === 'peak');
      expect(peak.date).toBe('2026-01-08');

      const decline = result.events.find(e => e.type === 'decline');
      expect(decline.date).toBe('2026-01-15');
      expect(decline.drop_from_peak_pct).toBeCloseTo(29.4, 0);

      const recovery = result.events.find(e => e.type === 'recovery');
      expect(recovery.date).toBe('2026-01-22');

      const change = result.events.find(e => e.type === 'change');
      expect(change).toMatchObject({ field: 'headline', from: 'Original Headline', to: 'Refreshed Headline', date: '2026-01-22' });
    });
  });

  describe('searchCreativeLibrary', () => {
    test('filters by campaign, score range, and search text; flags winner/loser within the ad set', () => {
      insertAd('ad_search_winner', 'Winner Ad');
      insertAd('ad_search_loser', 'Loser Ad');
      insertSnapshot({ metaAdId: 'ad_search_winner', since: '2026-02-01', until: '2026-02-07', scoreOverall: 90, headline: 'Great Deal Today' });
      insertSnapshot({ metaAdId: 'ad_search_loser', since: '2026-02-01', until: '2026-02-07', scoreOverall: 30, headline: 'Buy Stuff' });

      const result = searchCreativeLibrary({ campaign_id: 'camp_lib_1', date_since: '2026-02-01', date_until: '2026-02-07' });
      expect(result.creatives.length).toBe(2);
      const winner = result.creatives.find(c => c.meta_ad_id === 'ad_search_winner');
      const loser = result.creatives.find(c => c.meta_ad_id === 'ad_search_loser');
      expect(winner.library_role).toBe('winner');
      expect(loser.library_role).toBe('loser');

      const searched = searchCreativeLibrary({ campaign_id: 'camp_lib_1', date_since: '2026-02-01', date_until: '2026-02-07', search: 'Great Deal' });
      expect(searched.creatives.map(c => c.meta_ad_id)).toEqual(['ad_search_winner']);

      const scored = searchCreativeLibrary({ campaign_id: 'camp_lib_1', date_since: '2026-02-01', date_until: '2026-02-07', min_score: 50 });
      expect(scored.creatives.map(c => c.meta_ad_id)).toEqual(['ad_search_winner']);

      const winnersOnly = searchCreativeLibrary({ campaign_id: 'camp_lib_1', date_since: '2026-02-01', date_until: '2026-02-07', is_winner: true });
      expect(winnersOnly.creatives.map(c => c.meta_ad_id)).toEqual(['ad_search_winner']);
    });

    test('honestly reports the language filter as unsupported instead of silently ignoring or fabricating it', () => {
      const result = searchCreativeLibrary({ campaign_id: 'camp_lib_1', date_since: '2026-02-01', date_until: '2026-02-07', language: 'en' });
      expect(result.warnings.some(w => w.includes('language'))).toBe(true);
    });
  });

  describe('getAdSetComparison', () => {
    test('ranks the ad set\'s creatives for the given date range using creativeIntelligenceEngine.compareCreativesInAdSet', () => {
      insertAd('ad_comp_winner', 'Comparison Winner');
      insertAd('ad_comp_loser', 'Comparison Loser');
      insertSnapshot({ metaAdId: 'ad_comp_winner', since: '2026-04-01', until: '2026-04-07', scoreOverall: 92 });
      insertSnapshot({ metaAdId: 'ad_comp_loser', since: '2026-04-01', until: '2026-04-07', scoreOverall: 20 });

      const result = getAdSetComparison('adset_lib_1', { since: '2026-04-01', until: '2026-04-07' });
      expect(result.winner.meta_ad_id).toBe('ad_comp_winner');
      expect(result.worst.meta_ad_id).toBe('ad_comp_loser');
      expect(result.ranking.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getCreativeDetails', () => {
    test('returns analyzed:false with a clear reason when no creative_analytics snapshot exists', async () => {
      insertAd('ad_details_no_snapshot');
      const result = await getCreativeDetails('ad_details_no_snapshot');
      expect(result.analyzed).toBe(false);
      expect(result.reason).toMatch(/No creative_analytics snapshot/);
    });

    test('returns null for an unknown ad', async () => {
      expect(await getCreativeDetails('does-not-exist')).toBeNull();
    });

    test('merges snapshot, scores, fatigue, timeline, comparison, recommendations, and the reused ad-grain intelligence pipeline', async () => {
      const adId = insertAd('ad_details_full', 'Details Ad');
      // Phase 41: fatigue is now recomputed LIVE from real historical
      // snapshots (creativeLibrary.js's getCreativeDetails()), not trusted
      // from a hand-set fatigue_status/fatigue_recommendation column pair --
      // a genuine "severe" verdict requires two real snapshots showing a
      // real worsening trend (>=4 of: rising frequency, falling CTR, rising
      // CPC/CPM, falling conversion rate), the same signals
      // creativeIntelligenceEngine.detectFatigue() itself checks, so the
      // fixture provides real prior + latest rows rather than an
      // unreachable-in-production hand-set label.
      testDb.db.run(
        `INSERT INTO creative_analytics
           (id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_type, headline, cta_type,
            date_since, date_until, spend, results, ctr, cpc, cpm, frequency, reach, conversion_rate, cpa, score_overall, calculated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
        [uuidv4(), accountId, 'ad_details_full', 'adset_lib_1', 'camp_lib_1', 'image', 'Shop Now', 'SHOP_NOW',
          '2026-02-22', '2026-02-28', 100, 10, 3, 1, 10, 2, 1000, 5, 10, 60]
      );
      insertScoredSnapshot({ metaAdId: 'ad_details_full', since: '2026-03-01', until: '2026-03-07' });
      testDb.db.run(
        `UPDATE creative_analytics SET cpc = 1.5, cpm = 15, frequency = 3, reach = 1050, conversion_rate = 2
         WHERE meta_ad_id = 'ad_details_full' AND date_since = '2026-03-01'`
      );

      const result = await getCreativeDetails(adId, { useMock: true });
      expect(result.analyzed).toBe(true);
      expect(result.snapshot.meta_ad_id).toBe('ad_details_full');
      expect(typeof result.scores.score_overall).toBe('number');
      expect(result.fatigue.status).toBe('severe');
      expect(result.fatigue.recommendation).toBe('pause');
      expect(result.fatigue.evidence).toBeTruthy();
      expect(result.timeline.status).toBe('ok');
      expect(result.recommendations.some(r => r.action === 'Pause')).toBe(true);
      expect(result.intelligence).not.toBeNull();
      expect(typeof result.executive_summary).toBe('string');

      // Phase 42 — AI Marketing Advisor bundle is additive on this same
      // response; a severe-fatigue creative must be steered toward pausing,
      // never toward scaling, across every advisor sub-section.
      expect(result.benchmark_averages).toBeTruthy();
      expect(result.advisor).toBeTruthy();
      expect(result.advisor.pause_advice.action).toBe('Pause');
      expect(result.advisor.scaling_advice.recommended).toBe(false);
      expect(result.advisor.strategic_advice.headline).toMatch(/Pause/i);
      expect(Array.isArray(result.advisor.root_cause.negative_factors)).toBe(true);
      expect(result.advisor.root_cause.negative_factors.length).toBeGreaterThan(0);

      // Phase 44 additions -- present and structurally sound on this same response.
      expect(result.advisor.panel.priority).toMatch(/HIGH|MEDIUM|LOW/);
      expect(result.advisor.panel.business_risk).toMatch(/LOW|MEDIUM|HIGH/);
      expect(result.advisor.score_relationship.next_step).toBeTruthy();
      expect(result.advisor.benchmark.account_best_worst).toBeTruthy();
      expect(Array.isArray(result.advisor.rich_timeline.business_events)).toBe(true);

      // Phase 45 — Executive Decision Layer: severe fatigue must resolve to
      // a halt-leaning decision (PAUSE or STOP), never SCALE/MONITOR, and
      // "why not SCALE"/"why not MONITOR" must both be present since those
      // weren't chosen.
      expect(result.executive_decision).toBeTruthy();
      expect(['PAUSE', 'STOP']).toContain(result.executive_decision.decision);
      expect(result.executive_decision.why_not.SCALE).toBeTruthy();
      expect(result.executive_decision.why_not.MONITOR).toBeTruthy();
      expect(result.executive_decision.consistency_audit).toBeTruthy();
    });
  });

  describe('getAccountBestWorstCreative (Phase 44, Task 5)', () => {
    test('reports insufficient_data (null best/worst) honestly for an account with no scored creatives', () => {
      const result = getAccountBestWorstCreative(uuidv4(), 'no-such-ad');
      expect(result.best).toBeNull();
      expect(result.worst).toBeNull();
    });

    test('identifies the real best/worst scored creative, excluding the given ad', () => {
      // Isolated account (not the shared fixture accountId other describe
      // blocks in this file also write to) so this test's expectations
      // don't depend on how many other creatives happen to be in the DB.
      const bwAccountId = uuidv4();
      testDb.db.run(
        `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
         VALUES (?, 'act_bw', 'Best/Worst Test', ?, datetime('now'), datetime('now'))`,
        [bwAccountId, encryptToken('fake-token')]
      );
      function insertBw(metaAdId, scoreOverall) {
        testDb.db.run(
          `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, creative_type, date_since, date_until, spend, score_overall, calculated_at)
           VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
          [uuidv4(), bwAccountId, metaAdId, 'image', '2026-04-01', '2026-04-07', 100, scoreOverall]
        );
      }
      insertBw('ad_bw_1', 50);
      insertBw('ad_bw_2', 15);
      insertBw('ad_bw_3', 90);

      const result = getAccountBestWorstCreative(bwAccountId, 'ad_bw_1');
      expect(result.best.meta_ad_id).toBe('ad_bw_3');
      expect(result.worst.meta_ad_id).toBe('ad_bw_2');
    });
  });

  describe('getCrossModuleSignals (Phase 45, Task 13)', () => {
    test('reports both signals as null honestly when neither table has a row for this campaign', () => {
      const result = getCrossModuleSignals(accountId, 'camp_with_no_intelligence_data');
      expect(result.budget).toBeNull();
      expect(result.audience).toBeNull();
    });

    test('reads a real budget-waste flag and a real averaged audience-saturation score', () => {
      testDb.db.run(
        `INSERT INTO budget_analysis_history (id, ad_account_id, level, entity_meta_id, date_since, date_until, waste_detected, waste_amount, efficiency_status, calculated_at)
         VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
        [uuidv4(), accountId, 'campaign', 'camp_lib_1', '2026-04-01', '2026-04-07', 1, 42.5, 'poor']
      );
      testDb.db.run(
        `INSERT INTO audience_score_history (id, ad_account_id, meta_campaign_id, dimension, segment_value, date_since, date_until, saturation_score, calculated_at)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
        [uuidv4(), accountId, 'camp_lib_1', 'age', '25-34', '2026-04-01', '2026-04-07', 80]
      );

      const result = getCrossModuleSignals(accountId, 'camp_lib_1');
      expect(result.budget).toEqual({ waste_detected: true, waste_amount: 42.5, efficiency_status: 'poor' });
      expect(result.audience.saturation_score).toBe(80);
    });
  });
});
