'use strict';

const nock = require('nock');
const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');
const { syncAccount, upsertCampaign, upsertAdSet, upsertAd } = require('../../src/services/syncService');
const { encryptToken } = require('../../src/services/tokenCrypto');

const BASE = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

describe('syncService.syncAccount (full nock-mocked Meta account tree)', () => {
  let testDb;
  let account;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  beforeEach(() => {
    account = {
      id: uuidv4(),
      meta_account_id: 'act_sync_test',
      access_token_encrypted: encryptToken('fake-meta-token'),
    };
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, ?, 'Sync Test Account', ?, datetime('now'), datetime('now'))`,
      [account.id, account.meta_account_id, account.access_token_encrypted]
    );
  });

  afterEach(() => {
    nock.cleanAll();
    testDb.db.run('DELETE FROM ads');
    testDb.db.run('DELETE FROM ad_sets');
    testDb.db.run('DELETE FROM campaigns');
    testDb.db.run('DELETE FROM ad_accounts');
  });

  test('syncs a full campaign -> ad set -> ad tree in one pass, persisting creative fields', async () => {
    nock(BASE).get(`/${VERSION}/act_sync_test/campaigns`).query(true).reply(200, {
      data: [{ id: 'camp_1', name: 'Campaign One', objective: 'OUTCOME_LEADS', status: 'ACTIVE' }],
    });
    nock(BASE).get(`/${VERSION}/camp_1/adsets`).query(true).reply(200, {
      data: [{ id: 'adset_1', name: 'AdSet One', status: 'ACTIVE', daily_budget: '5000' }],
    });
    nock(BASE).get(`/${VERSION}/adset_1/ads`).query(true).reply(200, {
      data: [{
        id: 'ad_1', name: 'Ad One', status: 'ACTIVE',
        creative: { id: 'creative_1', thumbnail_url: 'https://x/thumb.jpg', image_url: 'https://x/full.jpg' },
      }],
    });

    const summary = await syncAccount(account);

    expect(summary.campaigns.synced).toBe(1);
    expect(summary.adSets.synced).toBe(1);
    expect(summary.ads.synced).toBe(1);
    expect(summary.errors).toEqual([]);

    const campaign = testDb.db.get('SELECT * FROM campaigns WHERE meta_campaign_id = ?', ['camp_1']);
    expect(campaign.objective).toBe('leads'); // OUTCOME_LEADS mapped correctly
    expect(campaign.status).toBe('active');

    const adSet = testDb.db.get('SELECT * FROM ad_sets WHERE meta_adset_id = ?', ['adset_1']);
    expect(adSet.daily_budget).toBe(50); // Meta cents (5000) -> currency units (50)

    const ad = testDb.db.get('SELECT * FROM ads WHERE meta_ad_id = ?', ['ad_1']);
    expect(ad.creative_id).toBe('creative_1');
    expect(ad.thumbnail_url).toBe('https://x/thumb.jpg');
    expect(ad.image_url).toBe('https://x/full.jpg');
  });

  test('isolates a single ad-set-level fetch failure without aborting sibling campaigns', async () => {
    nock(BASE).get(`/${VERSION}/act_sync_test/campaigns`).query(true).reply(200, {
      data: [
        { id: 'camp_broken', name: 'Broken Campaign', objective: 'LINK_CLICKS', status: 'ACTIVE' },
        { id: 'camp_ok', name: 'OK Campaign', objective: 'LINK_CLICKS', status: 'ACTIVE' },
      ],
    });
    nock(BASE).get(`/${VERSION}/camp_broken/adsets`).query(true).reply(500, {});
    nock(BASE).get(`/${VERSION}/camp_ok/adsets`).query(true).reply(200, {
      data: [{ id: 'adset_ok', name: 'OK AdSet', status: 'ACTIVE' }],
    });
    nock(BASE).get(`/${VERSION}/adset_ok/ads`).query(true).reply(200, { data: [] });

    const summary = await syncAccount(account);

    expect(summary.campaigns.synced).toBe(2); // both campaigns still upserted
    expect(summary.adSets.synced).toBe(1);    // only the healthy campaign's ad set
    expect(summary.errors.some(e => e.level === 'adsets' && e.campaignId === 'camp_broken')).toBe(true);

    const brokenCampaign = testDb.db.get('SELECT * FROM campaigns WHERE meta_campaign_id = ?', ['camp_broken']);
    expect(brokenCampaign).toBeTruthy(); // campaign itself still synced despite its ad-set fetch failing
  });

  test('records a warning when metaGetAll reports an incomplete page fetch, without failing the sync', async () => {
    nock(BASE).get(`/${VERSION}/act_sync_test/campaigns`).query(true).reply(200, {
      data: [{ id: 'camp_paged', name: 'Paged Campaign', objective: 'OUTCOME_SALES', status: 'ACTIVE' }],
      paging: { cursors: {}, next: `${BASE}/${VERSION}/act_sync_test/campaigns?after=BROKEN` },
    });
    nock(BASE).get(`/${VERSION}/act_sync_test/campaigns`).query({ after: 'BROKEN' }).reply(500, {});
    nock(BASE).get(`/${VERSION}/camp_paged/adsets`).query(true).reply(200, { data: [] });

    const summary = await syncAccount(account);

    expect(summary.campaigns.synced).toBe(1);
    expect(summary.warnings.some(w => w.level === 'campaigns' && w.reason === 'page_fetch_error')).toBe(true);
  });

  test('an initial campaign-fetch failure aborts the whole sync for that account with a clear error', async () => {
    nock(BASE).get(`/${VERSION}/act_sync_test/campaigns`).query(true).reply(400, {
      error: { message: 'Invalid OAuth access token', code: 190 },
    });

    const summary = await syncAccount(account);

    expect(summary.campaigns.synced).toBe(0);
    expect(summary.errors[0].level).toBe('account');
    expect(summary.errors[0].message).toMatch(/Invalid OAuth access token/);
  });
});

describe('syncService upsert functions (idempotency)', () => {
  let testDb;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    accountId = uuidv4();
    testDb.db.run(
      `INSERT INTO ad_accounts (id, meta_account_id, account_name, access_token_encrypted, created_at, updated_at)
       VALUES (?, 'act_upsert_test', 'Upsert Test', 'enc:v1:x', datetime('now'), datetime('now'))`,
      [accountId]
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('upsertCampaign updates in place on the second call instead of duplicating', () => {
    const metaCampaign = { id: 'camp_idempotent', name: 'First Name', objective: 'MESSAGES', status: 'ACTIVE' };
    const id1 = upsertCampaign(accountId, metaCampaign);
    const id2 = upsertCampaign(accountId, { ...metaCampaign, name: 'Updated Name' });

    expect(id1).toBe(id2);
    const rows = testDb.db.all('SELECT * FROM campaigns WHERE meta_campaign_id = ?', ['camp_idempotent']);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('Updated Name');
  });

  test('upsertCampaign tracks objective_effective_from only when the objective actually changes', () => {
    const metaCampaign = { id: 'camp_objective_track', name: 'Obj Test', objective: 'MESSAGES', status: 'ACTIVE' };
    upsertCampaign(accountId, metaCampaign);
    const before = testDb.db.get('SELECT objective_effective_from FROM campaigns WHERE meta_campaign_id = ?', ['camp_objective_track']);

    // Same objective again -- effective_from must not change.
    upsertCampaign(accountId, metaCampaign);
    const unchanged = testDb.db.get('SELECT objective_effective_from FROM campaigns WHERE meta_campaign_id = ?', ['camp_objective_track']);
    expect(unchanged.objective_effective_from).toBe(before.objective_effective_from);

    // Objective changes -- effective_from must update.
    upsertCampaign(accountId, { ...metaCampaign, objective: 'LINK_CLICKS' });
    const changed = testDb.db.get('SELECT objective, objective_effective_from FROM campaigns WHERE meta_campaign_id = ?', ['camp_objective_track']);
    expect(changed.objective).toBe('traffic');
    expect(changed.objective_effective_from).not.toBe(before.objective_effective_from);
  });

  test('upsertAdSet and upsertAd are also idempotent by their Meta ID', () => {
    const campaignId = upsertCampaign(accountId, { id: 'camp_for_adset', name: 'Parent', objective: 'MESSAGES', status: 'ACTIVE' });
    const adSetId1 = upsertAdSet(accountId, campaignId, { id: 'adset_idempotent', name: 'AS1', status: 'ACTIVE' });
    const adSetId2 = upsertAdSet(accountId, campaignId, { id: 'adset_idempotent', name: 'AS1 renamed', status: 'PAUSED' });
    expect(adSetId1).toBe(adSetId2);

    const adId1 = upsertAd(accountId, campaignId, adSetId1, { id: 'ad_idempotent', name: 'Ad1', status: 'ACTIVE' });
    const adId2 = upsertAd(accountId, campaignId, adSetId1, { id: 'ad_idempotent', name: 'Ad1 renamed', status: 'PAUSED' });
    expect(adId1).toBe(adId2);

    const adSetRows = testDb.db.all('SELECT * FROM ad_sets WHERE meta_adset_id = ?', ['adset_idempotent']);
    const adRows = testDb.db.all('SELECT * FROM ads WHERE meta_ad_id = ?', ['ad_idempotent']);
    expect(adSetRows.length).toBe(1);
    expect(adRows.length).toBe(1);
    expect(adSetRows[0].status).toBe('paused');
    expect(adRows[0].status).toBe('paused');
  });

  // Regression test: optimization_goal (added in schema.phase8.js) must
  // round-trip through upsertAdSet on both insert and update -- this is
  // the field the Video Views KPI sub-profile and the Optimization Goal
  // filter depend on, and it's easy to silently drop if only the INSERT
  // branch is updated and the UPDATE branch is missed (or vice versa).
  test('upsertAdSet persists optimization_goal on both insert and update', () => {
    const campaignId = upsertCampaign(accountId, { id: 'camp_for_optgoal', name: 'Parent', objective: 'MESSAGES', status: 'ACTIVE' });

    upsertAdSet(accountId, campaignId, { id: 'adset_optgoal', name: 'Video AdSet', status: 'ACTIVE', optimization_goal: 'THRUPLAY' });
    const inserted = testDb.db.get('SELECT optimization_goal FROM ad_sets WHERE meta_adset_id = ?', ['adset_optgoal']);
    expect(inserted.optimization_goal).toBe('THRUPLAY');

    upsertAdSet(accountId, campaignId, { id: 'adset_optgoal', name: 'Video AdSet', status: 'ACTIVE', optimization_goal: 'REACH' });
    const updated = testDb.db.get('SELECT optimization_goal FROM ad_sets WHERE meta_adset_id = ?', ['adset_optgoal']);
    expect(updated.optimization_goal).toBe('REACH');
  });

  test('upsertAdSet stores NULL optimization_goal when Meta does not return one, without throwing', () => {
    const campaignId = upsertCampaign(accountId, { id: 'camp_for_no_optgoal', name: 'Parent', objective: 'MESSAGES', status: 'ACTIVE' });
    expect(() => upsertAdSet(accountId, campaignId, { id: 'adset_no_optgoal', name: 'No OptGoal', status: 'ACTIVE' })).not.toThrow();
    const row = testDb.db.get('SELECT optimization_goal FROM ad_sets WHERE meta_adset_id = ?', ['adset_no_optgoal']);
    expect(row.optimization_goal).toBeNull();
  });
});
