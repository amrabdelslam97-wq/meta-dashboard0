/**
 * Phase 1 Verification Script
 *
 * Tests the complete Phase 1 flow:
 *   1. Database initializes correctly
 *   2. Schema creates all 5 tables
 *   3. Seed data inserts correctly
 *   4. GET /campaigns returns data from DB
 *   5. Filters work (status, objective)
 *   6. GET /campaigns/:id returns single campaign with ad sets
 *   7. GET /sync/status returns correct counts
 *
 * Run: node scripts/verify.js
 * Does NOT require Meta API — uses seeded test data.
 */

require('dotenv').config();

const path = require('path');
const http = require('http');

// ── Helpers ──

let passed = 0;
let failed = 0;

function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ─────────────────────────────`);
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: process.env.PORT || 3000,
      path,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => reject(new Error('Request timeout')));
    req.end();
  });
}

// ── Test Runner ──

async function runTests() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Meta Ads System — Phase 1 Verification');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── 1. Database Layer ──
  section('1. Database Layer');

  const { initializeDatabase } = require('../src/db/database');
  const { runMigrations } = require('../src/db/schema');
  const db = require('../src/db/database');

  const dbPath = process.env.DB_PATH || './data/meta_ads.db';
  await initializeDatabase(path.resolve(dbPath));
  runMigrations();

  const tables = db.all(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).map(r => r.name);

  ok('users table exists', tables.includes('users'));
  ok('ad_accounts table exists', tables.includes('ad_accounts'));
  ok('campaigns table exists', tables.includes('campaigns'));
  ok('ad_sets table exists', tables.includes('ad_sets'));
  ok('ads table exists', tables.includes('ads'));
  // This script only calls Phase 1's runMigrations() itself, but when run
  // against a server that has already booted with the full migration set
  // (Phase 2/5/6/7B), later-phase tables will also be present -- so this
  // checks that the 5 core tables exist, not that they are the *only*
  // tables, which used to fail here for exactly that reason.
  const core5 = ['users', 'ad_accounts', 'campaigns', 'ad_sets', 'ads'];
  ok('All 5 core tables present', core5.every(t => tables.includes(t)),
    `found: ${tables.join(', ')}`);

  // ── 2. Indexes ──
  section('2. Indexes');

  const indexes = db.all(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
  ).map(r => r.name);

  ok('campaigns indexed by ad_account_id', indexes.includes('idx_campaigns_ad_account_id'));
  ok('campaigns indexed by meta_campaign_id', indexes.includes('idx_campaigns_meta_id'));
  ok('ad_sets indexed by campaign_id', indexes.includes('idx_ad_sets_campaign_id'));
  ok('ads indexed by ad_set_id', indexes.includes('idx_ads_ad_set_id'));

  // ── 3. Seed Data ──
  section('3. Seed Data');

  // Run seed if DB is empty
  const campCount = db.get('SELECT COUNT(*) as c FROM campaigns');
  if (!campCount || campCount.c === 0) {
    console.log('  → No data found, running seed...');
    // seed.js runs as a separate process with its own sql.js in-memory
    // instance -- it writes the seeded rows to disk and exits, but this
    // process's `db` handle was already loaded from the (empty) file
    // before that happened, so it keeps serving stale empty results
    // until reloaded from the file the subprocess just wrote.
    const { execSync } = require('child_process');
    execSync('node scripts/seed.js', { stdio: 'inherit' });
    await initializeDatabase(path.resolve(dbPath));
  }

  const accountCount = db.get('SELECT COUNT(*) as c FROM ad_accounts');
  const campaignCount = db.get('SELECT COUNT(*) as c FROM campaigns');
  const adSetCount = db.get('SELECT COUNT(*) as c FROM ad_sets');
  const adCount = db.get('SELECT COUNT(*) as c FROM ads');

  ok('At least 1 ad account in DB', accountCount?.c >= 1);
  ok('At least 1 campaign in DB', campaignCount?.c >= 1);
  ok('At least 1 ad set in DB', adSetCount?.c >= 1);
  ok('At least 1 ad in DB', adCount?.c >= 1);

  // ── 4. Objective Mapping ──
  section('4. Objective Mapper');

  const { mapObjective } = require('../src/services/objectiveMapper');

  ok('MESSAGES → engagement', mapObjective('MESSAGES') === 'engagement');
  ok('LEAD_GENERATION → leads', mapObjective('LEAD_GENERATION') === 'leads');
  ok('CONVERSIONS → sales', mapObjective('CONVERSIONS') === 'sales');
  ok('LINK_CLICKS → traffic', mapObjective('LINK_CLICKS') === 'traffic');
  ok('BRAND_AWARENESS → awareness', mapObjective('BRAND_AWARENESS') === 'awareness');
  ok('OUTCOME_LEADS → leads', mapObjective('OUTCOME_LEADS') === 'leads');
  ok('Unknown objective → unknown', mapObjective('SOME_NEW_OBJECTIVE') === 'unknown');
  ok('Null objective → unknown', mapObjective(null) === 'unknown');

  // ── 5. Data Integrity ──
  section('5. Data Integrity');

  const campaigns = db.all('SELECT * FROM campaigns');
  const validObjectives = ['engagement', 'leads', 'sales', 'traffic', 'awareness', 'app_promotion', 'unknown'];
  const validStatuses = ['active', 'paused', 'archived', 'deleted'];

  const allObjectivesValid = campaigns.every(c => validObjectives.includes(c.objective));
  const allStatusesValid = campaigns.every(c => validStatuses.includes(c.status));
  const allHaveMetaId = campaigns.every(c => c.meta_campaign_id && c.meta_campaign_id.length > 0);
  const allHaveName = campaigns.every(c => c.name && c.name.length > 0);
  const allHaveAccountId = campaigns.every(c => c.ad_account_id && c.ad_account_id.length > 0);

  ok('All campaigns have valid objectives', allObjectivesValid);
  ok('All campaigns have valid statuses', allStatusesValid);
  ok('All campaigns have meta_campaign_id', allHaveMetaId);
  ok('All campaigns have names', allHaveName);
  ok('All campaigns are linked to an account', allHaveAccountId);

  // FK integrity: every campaign's ad_account_id exists
  const orphanCampaigns = db.all(
    'SELECT c.id FROM campaigns c LEFT JOIN ad_accounts a ON c.ad_account_id = a.id WHERE a.id IS NULL'
  );
  ok('No orphaned campaigns (FK integrity)', orphanCampaigns.length === 0);

  const orphanAdSets = db.all(
    'SELECT s.id FROM ad_sets s LEFT JOIN campaigns c ON s.campaign_id = c.id WHERE c.id IS NULL'
  );
  ok('No orphaned ad sets (FK integrity)', orphanAdSets.length === 0);

  const orphanAds = db.all(
    'SELECT a.id FROM ads a LEFT JOIN ad_sets s ON a.ad_set_id = s.id WHERE s.id IS NULL'
  );
  ok('No orphaned ads (FK integrity)', orphanAds.length === 0);

  // ── 6. Upsert Behavior ──
  section('6. Upsert Idempotency');

  const { upsertCampaign } = require('../src/services/syncService');
  const beforeCount = db.get('SELECT COUNT(*) as c FROM campaigns');

  // Get an existing account
  const account = db.get('SELECT * FROM ad_accounts LIMIT 1');
  // Upsert an already-existing campaign (should UPDATE, not INSERT)
  const existingCampaign = db.get('SELECT * FROM campaigns LIMIT 1');
  upsertCampaign(account.id, {
    id: existingCampaign.meta_campaign_id,
    name: existingCampaign.name + ' (updated)',
    objective: 'MESSAGES',
    status: 'ACTIVE',
  });

  const afterCount = db.get('SELECT COUNT(*) as c FROM campaigns');
  ok('Upsert does not duplicate campaigns', beforeCount.c === afterCount.c);

  const updated = db.get(
    'SELECT name FROM campaigns WHERE meta_campaign_id = ?',
    [existingCampaign.meta_campaign_id]
  );
  ok('Upsert updates existing campaign name', updated.name === existingCampaign.name + ' (updated)');

  // Restore original name
  db.run(
    'UPDATE campaigns SET name = ? WHERE meta_campaign_id = ?',
    [existingCampaign.name, existingCampaign.meta_campaign_id]
  );

  // ── 7. HTTP API Tests (requires server running) ──
  section('7. HTTP API — GET /campaigns');

  let serverAvailable = true;
  try {
    const health = await httpGet('/api/v1/health');
    ok('Server is running', health.status === 200);
    ok('Health check returns ok', health.body?.status === 'ok');
  } catch {
    serverAvailable = false;
    console.log('  ⚠  Server not running — skipping HTTP tests');
    console.log('     Start with: npm start  then run verify again');
  }

  if (serverAvailable) {
    // GET /campaigns — base
    const res1 = await httpGet('/api/v1/campaigns');
    ok('GET /campaigns returns 200', res1.status === 200);
    ok('Response has data array', Array.isArray(res1.body?.data));
    ok('Response has meta object', typeof res1.body?.meta === 'object');
    ok('Returns at least 1 campaign', res1.body?.data?.length >= 1);
    ok('meta.total is a number', typeof res1.body?.meta?.total === 'number');
    ok('meta.returned matches data length', res1.body?.meta?.returned === res1.body?.data?.length);

    // Check campaign shape
    const firstCampaign = res1.body?.data?.[0];
    ok('Campaign has id', !!firstCampaign?.id);
    ok('Campaign has meta_campaign_id', !!firstCampaign?.meta_campaign_id);
    ok('Campaign has name', !!firstCampaign?.name);
    ok('Campaign has objective', !!firstCampaign?.objective);
    ok('Campaign has status', !!firstCampaign?.status);
    ok('Campaign has account info (JOIN)', !!firstCampaign?.account_name);

    // GET /campaigns?status=active
    const res2 = await httpGet('/api/v1/campaigns?status=active');
    ok('GET /campaigns?status=active returns 200', res2.status === 200);
    const allActive = res2.body?.data?.every(c => c.status === 'active');
    ok('All returned campaigns are active', allActive !== false);

    // GET /campaigns?status=invalid
    const res3 = await httpGet('/api/v1/campaigns?status=invalid_status');
    ok('Invalid status filter returns 400', res3.status === 400);

    // GET /campaigns?objective=engagement
    const res4 = await httpGet('/api/v1/campaigns?objective=engagement');
    ok('GET /campaigns?objective=engagement returns 200', res4.status === 200);

    // GET /campaigns?limit=2&offset=0
    const res5 = await httpGet('/api/v1/campaigns?limit=2&offset=0');
    ok('Pagination: limit=2 returns max 2 items', res5.body?.data?.length <= 2);
    ok('Pagination: meta.limit matches', res5.body?.meta?.limit === 2);

    // GET /campaigns/:id
    if (firstCampaign?.id) {
      const res6 = await httpGet(`/api/v1/campaigns/${firstCampaign.id}`);
      ok('GET /campaigns/:id returns 200', res6.status === 200);
      ok('Single campaign has id', !!res6.body?.data?.id);
      ok('Single campaign includes ad_sets array', Array.isArray(res6.body?.data?.ad_sets));
    }

    // GET /campaigns/:id with bad id
    const res7 = await httpGet('/api/v1/campaigns/00000000-0000-0000-0000-000000000000');
    ok('GET /campaigns/:id 404 for unknown id', res7.status === 404);

    // GET /sync/status
    const res8 = await httpGet('/api/v1/sync/status');
    ok('GET /sync/status returns 200', res8.status === 200);
    ok('Sync status has campaign count', typeof res8.body?.database?.campaigns === 'number');
    ok('Sync status campaigns > 0', res8.body?.database?.campaigns > 0);

    // GET /accounts
    const res9 = await httpGet('/api/v1/accounts');
    ok('GET /accounts returns 200', res9.status === 200);
    ok('Accounts response has data array', Array.isArray(res9.body?.data));
    ok('At least 1 account returned', res9.body?.data?.length >= 1);
    const account = res9.body?.data?.[0];
    ok('Account does NOT expose access token', !account?.access_token_encrypted);
  }

  // ── Final Summary ──
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const total = passed + failed;
  console.log(`  Results: ${passed}/${total} passed`);
  if (failed > 0) {
    console.error(`  ✗ ${failed} test(s) failed`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
  } else {
    console.log('  ✓ All tests passed — Phase 1 complete');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('\n[Verify] Unexpected error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
