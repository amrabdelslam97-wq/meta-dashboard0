'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

describe('messagingAnalytics.getMessagingDestinationAnalytics', () => {
  let testDb, messagingAnalytics;

  beforeAll(async () => {
    testDb = await createTestDb();
    messagingAnalytics = require('../../src/services/messagingAnalytics');
  });

  afterAll(() => { testDb.cleanup(); });

  afterEach(() => { testDb.db.run('DELETE FROM creative_analytics'); });

  test('groups persisted creative_analytics rows by destination_type and computes cost per conversation', () => {
    const range = { since: '2026-06-01', until: '2026-06-07' };
    const now = new Date().toISOString();
    const insert = (destType, spend, results) => testDb.db.run(
      `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, meta_campaign_id, destination_type, date_since, date_until, spend, results, calculated_at)
       VALUES (?, 'acct1', ?, 'camp_msg_1', ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), uuidv4(), destType, range.since, range.until, spend, results, now]
    );
    insert('WHATSAPP', 100, 20);
    insert('WHATSAPP', 50, 10);
    insert('MESSENGER', 80, 8);

    const result = messagingAnalytics.getMessagingDestinationAnalytics('camp_msg_1', range);
    expect(result.destinations.length).toBe(2);
    const whatsapp = result.destinations.find(d => d.destination_type === 'WHATSAPP');
    expect(whatsapp.spend).toBe(150);
    expect(whatsapp.results).toBe(30);
    expect(whatsapp.cost_per_conversation).toBeCloseTo(5, 2);
    expect(result.insight.top_performer).toBeTruthy();
  });

  test('returns an honest empty result with an explanatory note when no messaging data exists', () => {
    const result = messagingAnalytics.getMessagingDestinationAnalytics('camp_no_messaging', { since: '2026-06-01', until: '2026-06-07' });
    expect(result.destinations).toEqual([]);
    expect(result.note).toMatch(/not.*synced|not.*messaging/i);
  });
});

describe('messagingAnalytics.getDestinationAttribution (Attribution Step 2)', () => {
  let testDb, messagingAnalytics;

  beforeAll(async () => {
    testDb = await createTestDb();
    messagingAnalytics = require('../../src/services/messagingAnalytics');
  });

  afterAll(() => { testDb.cleanup(); });
  afterEach(() => { testDb.db.run('DELETE FROM creative_analytics'); });

  function insert(destType, spend, results, roas, ctr, conversionRate) {
    testDb.db.run(
      `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, meta_campaign_id, destination_type, date_since, date_until, spend, results, roas, ctr, conversion_rate, calculated_at)
       VALUES (?, 'acct1', ?, 'camp_dest_1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), uuidv4(), destType, '2026-06-01', '2026-06-07', spend, results, roas, ctr, conversionRate, new Date().toISOString()]
    );
  }

  test('computes revenue via spend*roas reconstruction, correctly weighted (not a naive average of per-ad ROAS)', () => {
    insert('WEBSITE', 10, 2, 10, 1.5, 20);  // revenue 100
    insert('WEBSITE', 1000, 50, 1, 2.0, 5); // revenue 1000 -- ROAS of 1 should dominate the naive-average-of-10-and-1=5.5 result
    const result = messagingAnalytics.getDestinationAttribution('camp_dest_1', { since: '2026-06-01', until: '2026-06-07' });
    const website = result.destinations.find(d => d.destination_type === 'WEBSITE');
    expect(website.revenue).toBeCloseTo(1100, 0); // 100 + 1000
    expect(website.roas).toBeCloseTo(1100 / 1010, 1); // NOT 5.5 (naive average)
  });

  test('computes contribution_pct across destinations, summing to 100', () => {
    insert('WEBSITE', 75, 5, 2, 1, 10);
    insert('MESSENGER', 25, 3, 1, 1, 10);
    const result = messagingAnalytics.getDestinationAttribution('camp_dest_1', { since: '2026-06-01', until: '2026-06-07' });
    const total = result.destinations.reduce((s, d) => s + d.contribution_pct, 0);
    expect(Math.round(total)).toBe(100);
  });
});

describe('messagingAnalytics.comparePlatforms (Attribution Step 7)', () => {
  let testDb, messagingAnalytics;

  beforeAll(async () => {
    testDb = await createTestDb();
    messagingAnalytics = require('../../src/services/messagingAnalytics');
  });

  afterAll(() => { testDb.cleanup(); });
  afterEach(() => { testDb.db.run('DELETE FROM creative_analytics'); });

  test('picks the lowest cost_per_result destination as the winner', () => {
    const now = new Date().toISOString();
    const insert = (destType, spend, results) => testDb.db.run(
      `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, meta_campaign_id, destination_type, date_since, date_until, spend, results, calculated_at)
       VALUES (?, 'acct1', ?, 'camp_cmp_1', ?, '2026-06-01', '2026-06-07', ?, ?, ?)`,
      [uuidv4(), uuidv4(), destType, spend, results, now]
    );
    insert('WHATSAPP', 100, 20); // $5/result
    insert('MESSENGER', 100, 10); // $10/result
    insert('WEBSITE', 100, 0); // no results -- never the winner

    const result = messagingAnalytics.comparePlatforms('camp_cmp_1', { since: '2026-06-01', until: '2026-06-07' });
    expect(result.winner.destination_type).toBe('WHATSAPP');
    expect(result.platforms.length).toBe(3);
  });

  test('returns a null winner (not a crash) when nothing has data', () => {
    const result = messagingAnalytics.comparePlatforms('camp_cmp_empty', { since: '2026-06-01', until: '2026-06-07' });
    expect(result.winner).toBeNull();
    expect(result.platforms).toEqual([]);
  });
});

describe('languageAnalytics.getLanguageTargeting', () => {
  let testDb, languageAnalytics;

  beforeAll(async () => {
    testDb = await createTestDb();
    languageAnalytics = require('../../src/services/languageAnalytics');
  });

  afterAll(() => { testDb.cleanup(); });

  afterEach(() => {
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM ad_sets');
  });

  test('reports configured target languages per ad set, labeling known locale IDs and never fabricating performance', () => {
    const accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_lang', 'Lang Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
    const campaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_lang_1', 'Lang Campaign', 'engagement', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId]
    );
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, targeting_locales, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_lang_1', 'Arabic Ad Set', 'active', ?, datetime('now'), datetime('now'))`,
      [uuidv4(), campaignId, accountId, JSON.stringify([24, 6])]
    );
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, targeting_locales, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_lang_2', 'Broad Ad Set', 'active', NULL, datetime('now'), datetime('now'))`,
      [uuidv4(), campaignId, accountId]
    );

    const result = languageAnalytics.getLanguageTargeting('camp_lang_1');
    expect(result.ad_sets.length).toBe(2);
    const arabic = result.ad_sets.find(a => a.meta_adset_id === 'adset_lang_1');
    expect(arabic.targeted_languages).toEqual(['Arabic', 'English (US)']);
    expect(arabic.all_languages).toBe(false);
    const broad = result.ad_sets.find(a => a.meta_adset_id === 'adset_lang_2');
    expect(broad.all_languages).toBe(true);
    expect(result.note).toMatch(/does not expose performance/);
  });
});

describe('languageAnalytics.syncAccountLanguagePerformance + getLanguagePerformanceAttribution (Attribution Step 11)', () => {
  let testDb, languageAnalytics, accountId, campaignId;

  beforeAll(async () => {
    testDb = await createTestDb();
    languageAnalytics = require('../../src/services/languageAnalytics');
  });

  afterAll(() => { testDb.cleanup(); });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ad_accounts');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM ad_sets');
    testDb.db.run('DELETE FROM language_performance_attribution');
  });

  beforeEach(() => {
    // fetchAdSetMetrics caches by campaign+date-range -- every test below
    // reuses the same meta_campaign_id/date range, so a stale cache entry
    // from a prior test would mask this test's own nock mock entirely.
    require('../../src/services/cacheService').flush();

    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, status, token_is_valid, attribution_window_days, created_at, updated_at)
       VALUES (?, 'act_langperf', 'Lang Perf Test', ?, 'active', 1, 7, datetime('now'), datetime('now'))`,
      [accountId, encryptToken('fake-token')]
    );
    campaignId = uuidv4();
    testDb.db.run(
      `INSERT INTO campaigns (id, ad_account_id, meta_campaign_id, name, objective, status, created_at, updated_at)
       VALUES (?, ?, 'camp_langperf_1', 'Lang Perf Campaign', 'sales', 'active', datetime('now'), datetime('now'))`,
      [campaignId, accountId]
    );
  });

  test('groups real ad-set performance by locale set, never fanning a multi-language ad set out across locales (no double counting)', async () => {
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, targeting_locales, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_arabic', 'Arabic AdSet', 'active', ?, datetime('now'), datetime('now'))`,
      [uuidv4(), campaignId, accountId, JSON.stringify([24])]
    );
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, targeting_locales, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_broad', 'Broad AdSet', 'active', NULL, datetime('now'), datetime('now'))`,
      [uuidv4(), campaignId, accountId]
    );

    nock(BASE).get(`/${VERSION}/camp_langperf_1/insights`).query(q => q.level === 'adset').reply(200, {
      data: [
        { adset_id: 'adset_arabic', spend: '100', impressions: '1000', clicks: '20', actions: [{ action_type: 'omni_purchase', value: '5' }], action_values: [{ action_type: 'omni_purchase', value: '300' }] },
        { adset_id: 'adset_broad', spend: '50', impressions: '500', clicks: '5', actions: [{ action_type: 'omni_purchase', value: '1' }], action_values: [{ action_type: 'omni_purchase', value: '50' }] },
      ],
    });

    const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [accountId]);
    const range = { since: '2026-06-15', until: '2026-06-21' };
    const result = await languageAnalytics.syncAccountLanguagePerformance(fullAccount, range);
    expect(result.errors).toEqual([]);
    expect(result.campaignsProcessed).toBe(1);

    const read = languageAnalytics.getLanguagePerformanceAttribution('camp_langperf_1', range);
    expect(read.languages.length).toBe(2);

    const arabic = read.languages.find(l => l.locale_label === 'Arabic');
    expect(arabic.spend).toBe(100);
    expect(arabic.roas).toBe(3); // 300/100

    const all = read.languages.find(l => l.locale_label === 'All Languages');
    expect(all.spend).toBe(50);

    // Total spend across groups equals total real spend -- no double counting.
    const totalSpend = read.languages.reduce((s, l) => s + l.spend, 0);
    expect(totalSpend).toBe(150);
    const totalContribution = read.languages.reduce((s, l) => s + l.contribution_pct, 0);
    expect(Math.round(totalContribution)).toBe(100);
  });

  test('combines a multi-locale ad set into one blended group label instead of double-counting across languages', async () => {
    testDb.db.run(
      `INSERT INTO ad_sets (id, campaign_id, ad_account_id, meta_adset_id, name, status, targeting_locales, created_at, updated_at)
       VALUES (?, ?, ?, 'adset_mixed', 'Mixed AdSet', 'active', ?, datetime('now'), datetime('now'))`,
      [uuidv4(), campaignId, accountId, JSON.stringify([24, 6])]
    );

    nock(BASE).get(`/${VERSION}/camp_langperf_1/insights`).query(q => q.level === 'adset').reply(200, {
      data: [{ adset_id: 'adset_mixed', spend: '100', impressions: '1000', clicks: '10', actions: [], action_values: [] }],
    });

    const fullAccount = testDb.db.get('SELECT * FROM ad_accounts WHERE id = ?', [accountId]);
    const range = { since: '2026-06-15', until: '2026-06-21' };
    await languageAnalytics.syncAccountLanguagePerformance(fullAccount, range);

    const read = languageAnalytics.getLanguagePerformanceAttribution('camp_langperf_1', range);
    expect(read.languages.length).toBe(1); // one combined row, not two
    expect(read.languages[0].locale_label).toBe('English (US) + Arabic'); // sorted by locale ID (6, then 24)
    expect(read.languages[0].spend).toBe(100); // not double-counted
  });
});
