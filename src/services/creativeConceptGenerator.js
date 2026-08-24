/**
 * Creative Concept Generator — AP-POS Intelligence Layer
 *
 * Bundles the platform's already-computed weak-dimension signals (from
 * creativeTextAnalysis.js's per-dimension scores) plus this layer's own
 * hookAlternativeGenerator.js / ctaAlternativeGenerator.js output into a
 * small number of cohesive, evidence-linked Creative Concepts -- each one
 * addressing ONE real diagnosed weakness, never a generic template applied
 * regardless of evidence (see Step 13's explicit false-positive rule: never
 * generate concepts for a creative with no weak dimension).
 *
 * Computes no new score. "Message angle" is a re-framing of the exact
 * persuasion-signal categories creativeTextAnalysis.js's analyzeHook()
 * already detects/misses (question/curiosity/pain_point/benefit/urgency),
 * not a new vocabulary. Visual direction is always disclosed as
 * "Not measurable with current platform evidence" -- this system has no
 * vision model (creativeIntelligenceEngine.js's own score_visual is
 * metadata-only, per creativeTextAnalysis.js's analyzeVisualMetadata()).
 */

const { generateHookAlternatives } = require('./hookAlternativeGenerator');
const { generateCtaAlternatives } = require('./ctaAlternativeGenerator');

const WEAK_SCORE_THRESHOLD = 50; // matches creativeIntelligenceEngine.js's WEAK_THRESHOLD
const MAX_CONCEPTS = 3;

// Re-frames an already-detected/missing persuasion-signal key (from
// creativeTextAnalysis.js's PERSUASION_SIGNAL_KEYS) as a short strategic
// angle label -- a description of the same evidence, not a new signal.
const ANGLE_LABEL = {
  question: 'Curiosity / question-led',
  curiosity: 'Curiosity / question-led',
  pain_point: 'Pain-point-led',
  benefit: 'Benefit-led',
  urgency: 'Urgency-led',
  emotional_opening: 'Emotion-led',
  offer: 'Offer-forward',
  statistic: 'Proof/statistic-led',
  direct_address: 'Direct-address-led',
};

function messageAngleFor(missingSignals) {
  for (const key of Object.keys(ANGLE_LABEL)) {
    if (missingSignals.has(key)) return ANGLE_LABEL[key];
  }
  return 'Benefit-led';
}

/**
 * @param {object} params
 * @param {object} params.scores - creative_analytics score_* fields
 * @param {object} params.textAnalysis - ai_analysis (creativeTextAnalysis.analyzeCreative() output)
 * @param {string} [params.primaryText]
 * @param {string} [params.ctaType]
 * @param {string} [params.objective]
 */
function generateCreativeConcepts({ scores = {}, textAnalysis = {}, primaryText, ctaType, objective } = {}) {
  // textAnalysis.offer.label === 'missing' means primary_text/headline/
  // description are ALL empty (analyzeOffer()'s own definition, the same
  // "no text at all" condition generateRecommendations() already uses to
  // gate its own trust/offer recommendations) -- a DATA gap, not a creative-
  // QUALITY diagnosis. Generating an "offer"/"trust" concept in that case
  // would misrepresent "nothing was ever synced" as "a weak choice was
  // made," so both are gated on real text actually existing to evaluate.
  const hasAnyText = textAnalysis.offer?.label !== 'missing';

  const weakDims = [];
  if (scores.score_hook != null && scores.score_hook < WEAK_SCORE_THRESHOLD && textAnalysis.hook?.label !== 'missing') weakDims.push('hook');
  if (scores.score_headline != null && scores.score_headline < WEAK_SCORE_THRESHOLD && textAnalysis.headline?.label !== 'missing') weakDims.push('headline');
  if (scores.score_copy != null && scores.score_copy < WEAK_SCORE_THRESHOLD && textAnalysis.copy?.label !== 'missing') weakDims.push('copy');
  if (scores.score_cta != null && scores.score_cta < WEAK_SCORE_THRESHOLD) weakDims.push('cta');
  if (scores.score_offer != null && scores.score_offer < WEAK_SCORE_THRESHOLD && hasAnyText) weakDims.push('offer');
  if (scores.score_trust != null && scores.score_trust < 40 && hasAnyText) weakDims.push('trust'); // matches generateRecommendations()'s own trust threshold

  if (weakDims.length === 0) {
    return {
      status: 'not_applicable',
      reason: hasAnyText
        ? 'No creative dimension currently scores weak enough to warrant a new creative concept.'
        : 'No ad copy (headline/primary text/description) is synced for this creative yet -- a data gap, not a diagnosed creative weakness. Only the CTA button (a separate field) can be evaluated right now.',
      concepts: [],
    };
  }

  const hookAlts = generateHookAlternatives(textAnalysis.hook || null, primaryText);
  const ctaAlts = generateCtaAlternatives(textAnalysis.cta || null, ctaType, objective);
  const missingSignals = new Set((textAnalysis.hook?.missing || []).map(m => m.key));

  const concepts = weakDims.slice(0, MAX_CONCEPTS).map((dim, i) => {
    const angle = messageAngleFor(missingSignals);
    const hookLine = dim === 'hook' && hookAlts.status === 'generated'
      ? hookAlts.alternatives[0]?.pattern
      : `Not changed -- hook scores ${scores.score_hook ?? 'N/A'} (${textAnalysis.hook?.label || 'unscored'}), not the weakest dimension here.`;
    const ctaLine = dim === 'cta' && ctaAlts.status === 'generated'
      ? ctaAlts.alternatives[0]?.cta_type
      : `Not changed -- current CTA (${ctaType || 'unset'}) is not the weakest dimension here.`;

    const evidence = [];
    if (dim === 'hook') evidence.push(`score_hook = ${scores.score_hook} (${textAnalysis.hook?.evidence || 'no evidence recorded'}).`);
    if (dim === 'headline') evidence.push(`score_headline = ${scores.score_headline} (${textAnalysis.headline?.evidence || 'no evidence recorded'}).`);
    if (dim === 'copy') evidence.push(`score_copy = ${scores.score_copy} (${textAnalysis.copy?.evidence || 'no evidence recorded'}).`);
    if (dim === 'cta') evidence.push(`score_cta = ${scores.score_cta} (${textAnalysis.cta?.evidence || 'no evidence recorded'}).`);
    if (dim === 'offer') evidence.push(`score_offer = ${scores.score_offer} (${textAnalysis.offer?.evidence || 'no evidence recorded'}).`);
    if (dim === 'trust') evidence.push(`score_trust = ${scores.score_trust} (${textAnalysis.trust?.evidence || 'no evidence recorded'}).`);

    // headline/copy have no dedicated alternative-TEXT generator (unlike
    // hook/cta) -- generating full replacement headline or body copy risks
    // fabricating a product claim this system cannot verify. Instead this
    // cites the platform's OWN already-computed structural evidence sentence
    // (analyzeHeadline()/analyzeCopy()'s real `evidence` string, e.g. "too
    // long -- risks truncation") as guidance, never invented text.
    const structuralGuidance = dim === 'headline'
      ? `Structural guidance only (no fabricated replacement headline): ${textAnalysis.headline?.evidence || 'shorten to 3-8 words with a concrete offer or benefit.'}`
      : dim === 'copy'
        ? `Structural guidance only (no fabricated replacement copy): ${textAnalysis.copy?.evidence || 'shorten and simplify sentence structure.'}`
        : null;

    return {
      id: `concept_${i + 1}`,
      problem_addressed: dim,
      concept: `${angle} rework targeting the weak ${dim} dimension`,
      hook: hookLine,
      message_angle: angle,
      visual_direction: 'Not measurable with current platform evidence -- no vision/image-analysis model exists in this system (score_visual is metadata-only: aspect ratio/media type/video length).',
      cta: ctaLine,
      structural_guidance: structuralGuidance,
      why: `This ad's own ${dim} score (see evidence) is below the ${dim === 'trust' ? 40 : WEAK_SCORE_THRESHOLD} threshold this system already uses elsewhere (creativeIntelligenceEngine.js's WEAK_THRESHOLD) -- this concept targets that specific, already-diagnosed weakness rather than a generic rewrite.`,
      evidence,
      confidence: 'medium', // presentation synthesis over an already-scored dimension; not a platform-computed confidence value
    };
  });

  return {
    status: 'generated',
    disclosure: 'Each concept is a deterministic template addressing one real, already-scored weak dimension -- not AI-written creative, and not a guarantee of performance. Test against the current creative rather than replacing it outright.',
    concepts,
  };
}

module.exports = { generateCreativeConcepts };
