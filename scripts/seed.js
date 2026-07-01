/**
 * Development Seed Script
 *
 * Creates sample data in the database for local development and testing.
 * Does NOT call Meta API — inserts mock data directly.
 *
 * Usage: node scripts/seed.js
 */

require('dotenv').config();

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { initializeDatabase, run, get } = require('../src/db/database');
const { runMigrations } = require('../src/db/schema');
const { requireEncryptionKey, encryptToken } = require('../src/services/tokenCrypto');

const DB_PATH = process.env.DB_PATH || './data/meta_ads.db';

async function seed() {
  requireEncryptionKey();
  await initializeDatabase(path.resolve(DB_PATH));
  runMigrations();

  const now = new Date().toISOString();

  console.log('[Seed] Starting...');

  // ── Ad Account ──
  const existingAccount = get(
    "SELECT id FROM ad_accounts WHERE meta_account_id = 'act_111111111'"
  );

  let accountId;
  if (existingAccount) {
    accountId = existingAccount.id;
    console.log('[Seed] Ad account already exists, skipping.');
  } else {
    accountId = uuidv4();
    run(
      `INSERT INTO ad_accounts (
        id, meta_account_id, account_name, client_label,
        currency, timezone, country_code, attribution_window_days,
        access_token_encrypted, token_is_valid, last_token_verified_at,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        'act_111111111',
        'Test Ad Account',
        'My Business',
        'EGP',
        'Africa/Cairo',
        'EG',
        7,
        encryptToken('FAKE_TOKEN_FOR_DEVELOPMENT'),
        1,
        now,
        'active',
        now,
        now,
      ]
    );
    console.log(`[Seed] Created ad account: ${accountId}`);
  }

  // ── Campaigns ──
  const campaigns = [
    { meta_id: 'camp_001', name: 'Messages - Cairo Clinics', objective: 'messaging', status: 'active' },
    { meta_id: 'camp_002', name: 'Leads - Summer 2025', objective: 'leads', status: 'active' },
    { meta_id: 'camp_003', name: 'Sales - Product Launch', objective: 'sales', status: 'paused' },
    { meta_id: 'camp_004', name: 'Traffic - Blog Posts', objective: 'traffic', status: 'active' },
    { meta_id: 'camp_005', name: 'Awareness - Brand Q3', objective: 'awareness', status: 'archived' },
  ];

  const campaignIds = {};

  for (const camp of campaigns) {
    const existing = get('SELECT id FROM campaigns WHERE meta_campaign_id = ?', [camp.meta_id]);
    if (existing) {
      campaignIds[camp.meta_id] = existing.id;
      continue;
    }

    const id = uuidv4();
    campaignIds[camp.meta_id] = id;

    run(
      `INSERT INTO campaigns (
        id, ad_account_id, meta_campaign_id, name, objective,
        objective_effective_from, status, meta_created_time, meta_updated_time,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, accountId, camp.meta_id, camp.name, camp.objective,
        now, camp.status, now, now, now, now,
      ]
    );
    console.log(`[Seed] Created campaign: ${camp.name}`);
  }

  // ── Ad Sets ──
  const adSets = [
    { meta_id: 'adset_001', campaign_meta_id: 'camp_001', name: 'Cairo - 25-44', status: 'active', daily_budget: 100 },
    { meta_id: 'adset_002', campaign_meta_id: 'camp_001', name: 'Giza - 25-44', status: 'active', daily_budget: 80 },
    { meta_id: 'adset_003', campaign_meta_id: 'camp_002', name: 'Leads - All Egypt', status: 'active', daily_budget: 150 },
    { meta_id: 'adset_004', campaign_meta_id: 'camp_003', name: 'Retargeting', status: 'paused', daily_budget: 200 },
    { meta_id: 'adset_005', campaign_meta_id: 'camp_004', name: 'Blog Traffic', status: 'active', daily_budget: 50 },
  ];

  const adSetIds = {};

  for (const adSet of adSets) {
    const existing = get('SELECT id FROM ad_sets WHERE meta_adset_id = ?', [adSet.meta_id]);
    if (existing) {
      adSetIds[adSet.meta_id] = existing.id;
      continue;
    }

    const id = uuidv4();
    adSetIds[adSet.meta_id] = id;
    const campaignId = campaignIds[adSet.campaign_meta_id];

    run(
      `INSERT INTO ad_sets (
        id, campaign_id, ad_account_id, meta_adset_id, name, status,
        daily_budget, lifetime_budget, meta_created_time, meta_updated_time,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, campaignId, accountId, adSet.meta_id, adSet.name,
        adSet.status, adSet.daily_budget, null, now, now, now, now,
      ]
    );
    console.log(`[Seed] Created ad set: ${adSet.name}`);
  }

  // ── Ads ──
  const ads = [
    { meta_id: 'ad_001', adset_meta_id: 'adset_001', campaign_meta_id: 'camp_001', name: 'Creative A - Video', status: 'active' },
    { meta_id: 'ad_002', adset_meta_id: 'adset_001', campaign_meta_id: 'camp_001', name: 'Creative B - Image', status: 'active' },
    { meta_id: 'ad_003', adset_meta_id: 'adset_002', campaign_meta_id: 'camp_001', name: 'Creative A - Video', status: 'paused' },
    { meta_id: 'ad_004', adset_meta_id: 'adset_003', campaign_meta_id: 'camp_002', name: 'Lead Form Ad', status: 'active' },
    { meta_id: 'ad_005', adset_meta_id: 'adset_005', campaign_meta_id: 'camp_004', name: 'Blog Post Promotion', status: 'active' },
  ];

  for (const ad of ads) {
    const existing = get('SELECT id FROM ads WHERE meta_ad_id = ?', [ad.meta_id]);
    if (existing) continue;

    const id = uuidv4();
    const adSetId = adSetIds[ad.adset_meta_id];
    const campaignId = campaignIds[ad.campaign_meta_id];

    run(
      `INSERT INTO ads (
        id, ad_set_id, campaign_id, ad_account_id, meta_ad_id, name, status,
        meta_created_time, meta_updated_time, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, adSetId, campaignId, accountId, ad.meta_id, ad.name,
        ad.status, now, now, now, now,
      ]
    );
    console.log(`[Seed] Created ad: ${ad.name}`);
  }

  console.log('');
  console.log('[Seed] ✓ Complete. Database seeded with test data.');
  console.log('[Seed] Start the server and call GET /api/v1/campaigns to verify.');
  process.exit(0);
}

seed().catch(err => {
  console.error('[Seed] Failed:', err);
  process.exit(1);
});
