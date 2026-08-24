/**
 * CTA Alternative Generator — AP-POS Intelligence Layer
 *
 * Additive, read-only synthesis on top of creativeTextAnalysis.js's already-
 * computed analyzeCta() output and its exported STRONG_CTA_TYPES/
 * MESSAGING_CTA_TYPES sets. Never invents a CTA value -- every alternative
 * offered is one of Meta's own real, enumerated
 * AdCreativeLinkDataCallToAction `type` values, already classified as
 * action-oriented by creativeTextAnalysis.js. This module only decides
 * WHICH of those already-real values to suggest instead of the ad's current
 * (weak/generic) one, and why.
 */

const { STRONG_CTA_TYPES, MESSAGING_CTA_TYPES } = require('./creativeTextAnalysis');

// Meta's own click-to-chat family is a real, common, action-oriented CTA
// specifically for the 'engagement' objective (creativeTextAnalysis.js's own
// documented rationale for classifying it as strong) -- offered as an
// alternative only for that objective, not asserted as universally best.
const ENGAGEMENT_OBJECTIVE = 'engagement';

const MAX_ALTERNATIVES = 3;

// Same bar creativeIntelligenceEngine.js's generateRecommendations() already
// uses to decide whether a CTA needs an "Improve CTA" action (its own
// WEAK_THRESHOLD), reused here instead of analyzeCta()'s own label
// boundary -- a real MESSAGING-type CTA can score as high as 65 and still
// be labeled 'moderate', which would otherwise fire this generator for a
// CTA the platform's own canonical recommendation engine does not consider
// weak enough to change. Found and fixed by an internal audit.
const WEAK_SCORE_THRESHOLD = 50;

/**
 * @param {object} ctaAnalysis - creativeTextAnalysis.analyzeCta() output ({score, label, evidence})
 * @param {string} [currentCtaType] - the ad's real, current Meta cta_type
 * @param {string} [objective] - this system's internal objective vocabulary (awareness/traffic/engagement/leads/app_promotion/sales)
 */
function generateCtaAlternatives(ctaAnalysis, currentCtaType, objective) {
  if (!ctaAnalysis) {
    return { status: 'not_applicable', reason: 'No CTA analysis available for this creative.', alternatives: [] };
  }
  if (ctaAnalysis.score >= WEAK_SCORE_THRESHOLD) {
    return { status: 'not_applicable', reason: `Current CTA score (${ctaAnalysis.score}) is at/above the ${WEAK_SCORE_THRESHOLD} threshold this system uses elsewhere to flag a CTA as needing improvement (${ctaAnalysis.evidence}) -- no alternative needed.`, alternatives: [] };
  }

  const current = currentCtaType ? String(currentCtaType).toUpperCase() : null;
  const pool = [...STRONG_CTA_TYPES];
  if (objective === ENGAGEMENT_OBJECTIVE) pool.push(...MESSAGING_CTA_TYPES);

  const candidates = pool.filter(t => t !== current).slice(0, MAX_ALTERNATIVES);

  if (candidates.length === 0) {
    return { status: 'not_applicable', reason: 'No alternative CTA type available to suggest.', alternatives: [] };
  }

  return {
    status: 'generated',
    disclosure: 'Every alternative below is one of Meta\'s own real, enumerated CTA button values (already classified as action-oriented by this system\'s CTA analyzer) -- not an invented label. Confirm the destination (page/WhatsApp/site) actually matches the CTA before switching.',
    current_cta_type: current,
    current_cta_reason: ctaAnalysis.evidence,
    alternatives: candidates.map((type, i) => ({
      id: `cta_alt_${i + 1}`,
      cta_type: type,
      rationale: MESSAGING_CTA_TYPES.has(type)
        ? `"${type}" opens a real conversation -- classified as action-oriented for the "${ENGAGEMENT_OBJECTIVE}" objective.`
        : `"${type}" is one of Meta's specific, action-oriented CTA types, unlike the current "${current || 'unset'}" CTA (${ctaAnalysis.evidence}).`,
    })),
  };
}

module.exports = { generateCtaAlternatives };
