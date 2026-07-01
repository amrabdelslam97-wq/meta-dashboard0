/**
 * Objective Mapper
 *
 * Translates Meta API objective strings to internal objective enum.
 * Protects the system against Meta API naming changes across versions.
 *
 * Internal objectives: messaging | leads | sales | traffic | awareness | unknown
 */

const OBJECTIVE_MAP = {
  // Messaging
  MESSAGES: 'messaging',
  OUTCOME_ENGAGEMENT: 'messaging', // newer API versions may use this for messaging context

  // Leads
  LEAD_GENERATION: 'leads',
  OUTCOME_LEADS: 'leads',

  // Sales / Conversions
  CONVERSIONS: 'sales',
  OUTCOME_SALES: 'sales',
  PRODUCT_CATALOG_SALES: 'sales',

  // Traffic
  LINK_CLICKS: 'traffic',
  OUTCOME_TRAFFIC: 'traffic',

  // Awareness
  BRAND_AWARENESS: 'awareness',
  REACH: 'awareness',
  OUTCOME_AWARENESS: 'awareness',

  // Video views — map to awareness for phase 1
  VIDEO_VIEWS: 'awareness',
  OUTCOME_VIDEO_VIEWS: 'awareness',

  // App installs — not in scope but don't crash
  APP_INSTALLS: 'unknown',
  OUTCOME_APP_PROMOTION: 'unknown',

  // Store visits — not in scope
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
  return ['messaging', 'leads', 'sales', 'traffic', 'awareness', 'unknown'].includes(objective);
}

module.exports = { mapObjective, isValidObjective };
