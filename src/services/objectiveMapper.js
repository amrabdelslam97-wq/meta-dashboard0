/**
 * Objective Mapper
 *
 * Translates Meta API objective strings to internal objective enum.
 * Protects the system against Meta API naming changes across versions.
 *
 * Internal objectives (Meta's real ODAX taxonomy):
 *   awareness | traffic | engagement | leads | app_promotion | sales | unknown
 *
 * 'engagement' replaces the old 'messaging' bucket (Meta's OUTCOME_ENGAGEMENT
 * campaign objective covers Messages/Video Views/Post Engagement/Conversions,
 * of which the legacy pre-ODAX MESSAGES objective is one destination type --
 * see src/services/kpiProfileResolver.js for how a finer-grained distinction
 * within engagement, e.g. via an ad set's optimization_goal, is resolved).
 * 'app_promotion' is split out of the old 'unknown' catch-all (Meta's
 * OUTCOME_APP_PROMOTION/APP_INSTALLS objectives) now that it's fully in
 * scope. campaigns.objective's DB CHECK constraint was widened to match in
 * src/db/schema.phase8.js -- this mapping and that migration must always
 * stay in sync.
 */

const OBJECTIVE_MAP = {
  // Awareness
  OUTCOME_AWARENESS: 'awareness',
  BRAND_AWARENESS: 'awareness',
  REACH: 'awareness',
  VIDEO_VIEWS: 'awareness',
  OUTCOME_VIDEO_VIEWS: 'awareness',

  // Traffic
  OUTCOME_TRAFFIC: 'traffic',
  LINK_CLICKS: 'traffic',

  // Engagement (was folded into 'messaging' before ODAX-aware taxonomy)
  OUTCOME_ENGAGEMENT: 'engagement',
  MESSAGES: 'engagement',

  // Leads
  OUTCOME_LEADS: 'leads',
  LEAD_GENERATION: 'leads',

  // App Promotion (was incorrectly falling into 'unknown')
  OUTCOME_APP_PROMOTION: 'app_promotion',
  APP_INSTALLS: 'app_promotion',

  // Sales / Conversions
  OUTCOME_SALES: 'sales',
  CONVERSIONS: 'sales',
  PRODUCT_CATALOG_SALES: 'sales',

  // Store visits — genuinely out of scope, no dedicated profile
  STORE_VISITS: 'unknown',
};

/**
 * Map a Meta API objective string to an internal objective.
 * @param {string} metaObjective - Raw objective string from Meta API
 * @returns {string} Internal objective enum value
 */
function mapObjective(metaObjective) {
  if (!metaObjective) return 'unknown';

  const normalized = String(metaObjective).toUpperCase().trim();
  return OBJECTIVE_MAP[normalized] || 'unknown';
}

/**
 * Check if an internal objective is valid.
 */
function isValidObjective(objective) {
  return ['awareness', 'traffic', 'engagement', 'leads', 'app_promotion', 'sales', 'unknown'].includes(objective);
}

module.exports = { mapObjective, isValidObjective };
