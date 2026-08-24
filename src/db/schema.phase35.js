/**
 * Phase 35 Schema Migration — Bounded/Resumable Insights Tier
 *
 * Purpose: live forensic evidence (executionId 7ae47b40-3719-48a6-b0b3-
 * 6b310b5c8646, real Preview Force Sync against act_665699145095366) proved
 * the Insights tier (runInsightsTier, smartSyncEngine.js) makes ONE Meta
 * call PER campaign already stored for the account, sequentially, with no
 * batch cap -- 37 successful (HTTP 200) Meta requests consumed the entire
 * shared time budget before the campaign-tree tier (the tier that actually
 * discovers/persists NEW campaigns) ever got a turn. As the account's
 * locally-known campaign count grows, this tier would only get slower and
 * would permanently starve every tier behind it.
 *
 * ad_accounts.insights_sync_cursor -- nullable TEXT, the meta_campaign_id
 *   of the last campaign whose insights were refreshed in the current pass.
 *   Same resume/fallback semantics as sync_batch_cursor (schema.phase32.js):
 *   if the cursor's campaign is no longer found in the current list (e.g.
 *   deleted upstream), the tier safely restarts from the beginning rather
 *   than erroring -- every fetchCampaignMetrics() call is idempotent by
 *   meta_campaign_id, so a redundant re-fetch is safe, just not free.
 *   NULL means "no pass in progress" -- either never started, or the most
 *   recent pass reached the end of the list and completed.
 *
 * Method: ALTER TABLE ADD COLUMN, idempotent via PRAGMA table_info check --
 * same pattern as schema.phase31.js/32.js/33.js.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase35_bounded_insights_tier';

async function runPhase35Migrations() {
  await ensureMigrationsTable();
  const existingCols = (await db.all("PRAGMA table_info(ad_accounts)")).map(c => c.name);

  let added = 0;
  if (!existingCols.includes('insights_sync_cursor')) {
    try {
      await db.run(`ALTER TABLE ad_accounts ADD COLUMN insights_sync_cursor TEXT`);
      added++;
    } catch (err) {
      console.warn('[DB] Phase 35: could not add insights_sync_cursor column:', err.message);
    }
  }

  await markMigrationApplied(MIGRATION_NAME);

  if (added > 0) {
    await db.persist();
    console.log(`[DB] Phase 35 migration complete — ${added} column(s) added to ad_accounts.`);
  } else {
    console.log('[DB] Phase 35 schema: already present, skipping.');
  }
}

module.exports = { runPhase35Migrations };
