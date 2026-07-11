/**
 * Phase 22 Schema Migration — Attribution & Customer Journey Intelligence
 *
 * Purpose: durable, historical storage for the new Attribution module,
 * following the exact pattern schema.phase19.js established (one row per
 * entity/dimension/date-range, additive to the existing sync/scheduler
 * machinery, no new scheduler tier -- these are synced as additional steps
 * inside smartSyncEngine.js's existing 'analytics' tier).
 *
 * New tables:
 *   conversation_attribution      — Step 1: conversation count/cost/rate per
 *     (campaign, destination), from real Insights `results` bucket data.
 *     Deliberately has NO response_rate/first_reply_time/qualified_conversations
 *     columns -- Meta's Marketing API exposes no such fields (that data lives
 *     in the Messenger/WhatsApp/Instagram Messaging Platform APIs, a
 *     genuinely separate integration this system does not have); adding
 *     always-null columns for values that can never be populated would be
 *     schema bloat, not honesty -- the read-side response documents the gap
 *     instead (see conversationAttributionEngine.js).
 *   attribution_window_comparison — Step 5: results/cpa/roas under different
 *     real Meta attribution windows (1d_click/7d_click/1d_view), a genuine
 *     substitute for a fabricated multi-touch attribution model (see
 *     attributionWindowEngine.js's header for why true Last/First/Linear/
 *     Position/Time-Decay/Data-Driven models are not implementable with this
 *     system's data).
 *   language_performance_attribution — Step 11: ad_sets.targeting_locales
 *     joined with that ad set's own real performance, grouped by targeted
 *     language -- extends languageAnalytics.js's existing config-only view
 *     with genuine performance data.
 *   audience_attribution          — Step 9: spend/results/ctr/roas/cpa/
 *     frequency aggregated by the newly-classified ad_sets.audience_type.
 *   customer_journey_funnel       — Steps 4+13: an AGGREGATE (not per-customer)
 *     funnel snapshot -- impressions -> reach -> clicks -> landing page views
 *     -> conversations -> purchases -> revenue. This system has no per-
 *     customer identity/event data (Meta Insights are ad-level aggregates,
 *     not a clickstream), so a literal individual-journey visualization is
 *     not implementable; this table is the honest aggregate equivalent.
 *
 * Existing tables extended (ALTER TABLE ADD COLUMN, additive):
 *   ad_sets.targeting_json   — raw-but-trimmed Meta targeting sub-objects
 *     (custom_audiences/lookalike_spec/geo_locations/flexible_spec presence),
 *     added to the SAME fetchAdSets() call metaApiClient.js already makes.
 *   ad_sets.audience_type    — derived classification (broad/interest/
 *     custom/lookalike/advantage/remarketing/saved/dynamic/mixed), computed
 *     at sync time from targeting_json.
 *   budget_distribution_snapshots.revenue / .roas — Step 6: the exact same
 *     fetchCampaignMetrics() call syncAccountBudgetDistribution() already
 *     makes returns purchase_value/roas; previously fetched and discarded,
 *     not persisted. Zero new Meta calls.
 *
 * Method: idempotent CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN,
 * same guard pattern as every other phaseN schema file.
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied, isMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase22_attribution_customer_journey';

function addColumnIfMissing(table, column, type) {
  const existingCols = db.all(`PRAGMA table_info(${table})`).map(c => c.name);
  if (existingCols.includes(column)) return false;
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    return true;
  } catch (err) {
    console.warn(`[DB] Phase 22: could not add ${table}.${column}:`, err.message);
    return false;
  }
}

function runPhase22Migrations() {
  ensureMigrationsTable();
  const alreadyApplied = isMigrationApplied(MIGRATION_NAME);

  let added = 0;
  if (addColumnIfMissing('ad_sets', 'targeting_json', 'TEXT')) added++;
  if (addColumnIfMissing('ad_sets', 'audience_type', 'TEXT')) added++;
  if (addColumnIfMissing('budget_distribution_snapshots', 'revenue', 'REAL')) added++;
  if (addColumnIfMissing('budget_distribution_snapshots', 'roas', 'REAL')) added++;

  db.run(`
    CREATE TABLE IF NOT EXISTS conversation_attribution (
      id                   TEXT PRIMARY KEY,
      ad_account_id        TEXT NOT NULL,
      meta_campaign_id     TEXT NOT NULL,
      destination_type     TEXT NOT NULL DEFAULT 'UNKNOWN',
      date_since           TEXT NOT NULL,
      date_until           TEXT NOT NULL,
      spend                REAL,
      impressions          INTEGER,
      clicks               INTEGER,
      conversation_count   REAL,
      cost_per_conversation REAL,
      conversation_rate    REAL,
      calculated_at        TEXT NOT NULL,
      UNIQUE(ad_account_id, meta_campaign_id, destination_type, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conversation_attribution_lookup ON conversation_attribution(ad_account_id, meta_campaign_id, date_since)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS attribution_window_comparison (
      id                TEXT PRIMARY KEY,
      ad_account_id     TEXT NOT NULL,
      meta_campaign_id  TEXT NOT NULL,
      attribution_window TEXT NOT NULL,
      date_since        TEXT NOT NULL,
      date_until        TEXT NOT NULL,
      spend             REAL,
      results           REAL,
      cpa               REAL,
      roas              REAL,
      calculated_at     TEXT NOT NULL,
      UNIQUE(ad_account_id, meta_campaign_id, attribution_window, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_attribution_window_lookup ON attribution_window_comparison(ad_account_id, meta_campaign_id, date_since)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS language_performance_attribution (
      id                TEXT PRIMARY KEY,
      ad_account_id     TEXT NOT NULL,
      meta_campaign_id  TEXT NOT NULL,
      locale_id         TEXT NOT NULL DEFAULT 'all',
      locale_label      TEXT,
      date_since        TEXT NOT NULL,
      date_until        TEXT NOT NULL,
      spend             REAL,
      results           REAL,
      ctr               REAL,
      roas              REAL,
      cpa               REAL,
      contribution_pct  REAL,
      calculated_at     TEXT NOT NULL,
      UNIQUE(ad_account_id, meta_campaign_id, locale_id, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_language_attribution_lookup ON language_performance_attribution(ad_account_id, meta_campaign_id, date_since)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS audience_attribution (
      id                TEXT PRIMARY KEY,
      ad_account_id     TEXT NOT NULL,
      meta_campaign_id  TEXT NOT NULL,
      audience_type     TEXT NOT NULL DEFAULT 'unknown',
      date_since        TEXT NOT NULL,
      date_until        TEXT NOT NULL,
      spend             REAL,
      results           REAL,
      ctr               REAL,
      roas              REAL,
      cpa               REAL,
      frequency         REAL,
      contribution_pct  REAL,
      calculated_at     TEXT NOT NULL,
      UNIQUE(ad_account_id, meta_campaign_id, audience_type, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audience_attribution_lookup ON audience_attribution(ad_account_id, meta_campaign_id, date_since)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS customer_journey_funnel (
      id                   TEXT PRIMARY KEY,
      ad_account_id        TEXT NOT NULL,
      meta_campaign_id     TEXT NOT NULL,
      date_since           TEXT NOT NULL,
      date_until           TEXT NOT NULL,
      impressions          REAL,
      reach                REAL,
      clicks               REAL,
      landing_page_views   REAL,
      conversations        REAL,
      purchases            REAL,
      revenue              REAL,
      calculated_at        TEXT NOT NULL,
      UNIQUE(ad_account_id, meta_campaign_id, date_since, date_until)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_journey_funnel_lookup ON customer_journey_funnel(ad_account_id, meta_campaign_id, date_since)`);

  markMigrationApplied(MIGRATION_NAME);

  if (added > 0 || !alreadyApplied) {
    db.persist();
    console.log(`[DB] Phase 22 migration complete — added ${added} column(s), created 5 attribution tables.`);
  } else {
    console.log('[DB] Phase 22 schema: attribution tables already present, skipping.');
  }
}

module.exports = { runPhase22Migrations };
