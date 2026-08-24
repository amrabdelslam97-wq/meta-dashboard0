/**
 * Root-Cause Taxonomy Mapper — AP-POS Intelligence Layer
 *
 * Translates signals this system ALREADY computes -- diagnosisEngine.js's
 * campaign-level cause category, creativeIntelligenceEngine.js's creative
 * scores/fatigue, and creativeLibrary.js's already-fetched cross-module
 * signals (budget waste, audience saturation) -- into the eight-category
 * root-cause vocabulary an operator asking "what kind of problem is this"
 * expects (Creative / Audience / Funnel / Offer / Delivery / Campaign /
 * Scaling / Measurement). Computes NO new score and overrides no existing
 * verdict: diagnosisEngine.js's own `category` (the first-matched factor in
 * its documented check order) is treated as the platform's own arbitration
 * and is never re-arbitrated here -- this module only relabels it into the
 * eight-name vocabulary and adds corroborating cross-module evidence.
 *
 * Every category not backed by a real, already-computed signal is marked
 * `not_measurable` with the specific reason, rather than guessed at --
 * per this project's "never invent platform logic" instruction.
 */

// diagnosisEngine.js's own cascade categories (decomposeCost/Roas/Volume/
// Rate), mapped 1:1 onto the eight-name taxonomy. Never adds a category
// diagnosisEngine.js itself doesn't already emit.
const DIAGNOSIS_CATEGORY_MAP = {
  creative: 'creative',
  audience: 'audience',
  competition: 'delivery',
  budget: 'campaign',
  tracking: 'measurement',
};

// Same saturation threshold executiveDecisionEngine.js already uses
// (crossModuleSignals.audience.saturation_score >= 70) -- reused verbatim,
// not re-derived, so this module never disagrees with the Executive
// Decision Layer's own verdict on the same signal.
const AUDIENCE_SATURATION_THRESHOLD = 70;
const WEAK_SCORE_THRESHOLD = 50; // matches creativeIntelligenceEngine.js's WEAK_THRESHOLD

const TAXONOMY_KEYS = ['creative', 'audience', 'funnel', 'offer', 'delivery', 'campaign', 'scaling', 'measurement'];

function baseEntry(key) {
  return { category: key, status: 'not_measurable', contributing: false, confidence: null, evidence: [], reason: null };
}

/**
 * @param {object} params
 * @param {object} [params.diagnosis] - mmsOrchestrator/diagnosisEngine.diagnoseCampaign() output on the ad's campaign ({status, category, confidence, priority, factors, summary})
 * @param {object} [params.scores] - creative_analytics score_* fields for this ad
 * @param {object} [params.textAnalysis] - ai_analysis (creativeTextAnalysis.analyzeCreative() output) for evidence strings
 * @param {object} [params.fatigue] - creativeIntelligenceEngine.detectFatigue() output
 * @param {object} [params.crossModuleSignals] - creativeLibrary.getCrossModuleSignals() output ({budget, audience})
 */
function mapRootCauseTaxonomy({ diagnosis, scores = {}, textAnalysis = {}, fatigue, crossModuleSignals = {} } = {}) {
  const result = {};
  for (const key of TAXONOMY_KEYS) result[key] = baseEntry(key);

  // ── Creative ──────────────────────────────────────────────
  const weakDims = ['hook', 'headline', 'copy', 'cta', 'visual', 'trust', 'psychology']
    .filter(d => scores[`score_${d}`] != null && scores[`score_${d}`] < WEAK_SCORE_THRESHOLD);
  const creativeFatigued = fatigue && (fatigue.status === 'moderate' || fatigue.status === 'severe');
  if (weakDims.length || creativeFatigued) {
    result.creative.status = 'measurable';
    result.creative.contributing = true;
    result.creative.confidence = diagnosis?.status === 'diagnosed' && diagnosis.category === 'creative' ? diagnosis.confidence : 'medium';
    if (weakDims.length) result.creative.evidence.push(`Weak creative dimensions (score < ${WEAK_SCORE_THRESHOLD}): ${weakDims.join(', ')}.`);
    if (creativeFatigued) result.creative.evidence.push(`Fatigue status: ${fatigue.status} (${fatigue.evidence}).`);
  } else {
    result.creative.status = 'measurable';
    result.creative.reason = 'No weak creative dimension or fatigue signal detected.';
  }
  result.creative.not_measurable_note = 'Objective/message alignment (does this hook match this campaign\'s objective) has no dedicated check in this system -- only individual text-quality dimensions are scored.';

  // ── Audience ──────────────────────────────────────────────
  const saturation = crossModuleSignals?.audience?.saturation_score;
  const diagnosisAudience = diagnosis?.status === 'diagnosed' && diagnosis.category === 'audience';
  if (diagnosisAudience || (saturation != null && saturation >= AUDIENCE_SATURATION_THRESHOLD)) {
    result.audience.status = 'measurable';
    result.audience.contributing = true;
    result.audience.confidence = diagnosisAudience ? diagnosis.confidence : 'medium';
    if (diagnosisAudience) result.audience.evidence.push(diagnosis.factors.find(f => f.category === 'audience')?.detail || diagnosis.summary);
    if (saturation != null && saturation >= AUDIENCE_SATURATION_THRESHOLD) result.audience.evidence.push(`Audience Intelligence saturation score ${saturation} (>= ${AUDIENCE_SATURATION_THRESHOLD} threshold).`);
  } else {
    result.audience.status = saturation != null ? 'measurable' : 'not_measurable';
    result.audience.reason = saturation != null ? `Saturation score ${saturation} is below the ${AUDIENCE_SATURATION_THRESHOLD} threshold.` : 'No Audience Intelligence saturation score computed yet for this campaign.';
  }
  result.audience.not_measurable_note = 'Audience quality and targeting-mismatch beyond saturation are not measurable with current platform evidence.';

  // ── Funnel ────────────────────────────────────────────────
  result.funnel.reason = 'This system has no landing-page or post-click funnel data source (no schema field for landing-page load time, form friction, or checkout steps).';
  result.funnel.not_measurable_note = 'Not measurable with current platform evidence.';
  const conversionFactor = diagnosis?.status === 'diagnosed' ? diagnosis.factors?.find(f => f.key === 'conversion_rate_falling') : null;
  if (conversionFactor) {
    result.funnel.evidence.push(`Closest available proxy: diagnosisEngine.js flagged "${conversionFactor.detail}" (labeled under its own "audience" category, not re-labeled here) -- consistent with, but not proof of, a funnel/landing-page problem.`);
  }

  // ── Offer ─────────────────────────────────────────────────
  const offerScore = scores.score_offer;
  if (offerScore != null) {
    result.offer.status = 'measurable';
    result.offer.contributing = offerScore < WEAK_SCORE_THRESHOLD;
    result.offer.confidence = 'medium';
    result.offer.evidence.push(textAnalysis?.offer?.evidence || `score_offer = ${offerScore}.`);
    if (!result.offer.contributing) result.offer.reason = `Offer score ${offerScore} is at/above the ${WEAK_SCORE_THRESHOLD} threshold.`;
  } else {
    result.offer.reason = 'No offer score computed yet for this creative.';
  }
  result.offer.not_measurable_note = 'Competitive price/value comparison and differentiation vs. other advertisers are not measurable with current platform evidence (no competitor data source exists).';

  // ── Delivery ──────────────────────────────────────────────
  const deliveryFactor = diagnosis?.status === 'diagnosed' ? diagnosis.factors?.find(f => f.category === 'competition') : null;
  if (deliveryFactor) {
    result.delivery.status = 'measurable';
    result.delivery.contributing = true;
    result.delivery.confidence = diagnosis.confidence;
    result.delivery.evidence.push(deliveryFactor.detail);
  } else {
    result.delivery.status = diagnosis?.status === 'diagnosed' ? 'measurable' : 'not_measurable';
    result.delivery.reason = diagnosis?.status === 'diagnosed' ? 'No CPM/competition signal flagged in this diagnosis.' : 'Diagnosis unavailable or insufficient data.';
  }

  // ── Campaign ──────────────────────────────────────────────
  const budgetSignal = crossModuleSignals?.budget;
  const diagnosisBudget = diagnosis?.status === 'diagnosed' && diagnosis.category === 'budget';
  if (diagnosisBudget || (budgetSignal && budgetSignal.waste_detected)) {
    result.campaign.status = 'measurable';
    result.campaign.contributing = true;
    result.campaign.confidence = diagnosisBudget ? diagnosis.confidence : 'medium';
    if (diagnosisBudget) result.campaign.evidence.push(diagnosis.factors.find(f => f.category === 'budget')?.detail || diagnosis.summary);
    if (budgetSignal && budgetSignal.waste_detected) result.campaign.evidence.push(`Budget Intelligence: waste detected (efficiency status: ${budgetSignal.efficiency_status}, waste amount: ${budgetSignal.waste_amount}).`);
  } else {
    result.campaign.status = budgetSignal ? 'measurable' : 'not_measurable';
    result.campaign.reason = budgetSignal ? 'No budget waste currently detected.' : 'No Budget Intelligence snapshot available yet for this campaign.';
  }
  result.campaign.not_measurable_note = 'Campaign structure and optimization-goal configuration correctness (e.g. "wrong optimization event chosen") have no dedicated check in this system.';

  // ── Scaling ───────────────────────────────────────────────
  result.scaling.reason = 'This system can identify when a campaign is READY to scale (decisionEngine.js SCALE_CAMPAIGN verdict, opportunityEngine.js) but has no signal for whether a PAST scaling action caused a current decline -- that would require a scale-event log this system does not persist.';
  result.scaling.not_measurable_note = 'Not measurable with current platform evidence.';

  // ── Measurement ───────────────────────────────────────────
  const trackingFactor = diagnosis?.status === 'diagnosed' ? diagnosis.factors?.find(f => f.category === 'tracking') : null;
  if (trackingFactor) {
    result.measurement.status = 'measurable';
    result.measurement.contributing = true;
    result.measurement.confidence = diagnosis.confidence;
    result.measurement.evidence.push(trackingFactor.detail);
  } else if (diagnosis?.status === 'insufficient_data') {
    result.measurement.status = 'measurable';
    result.measurement.contributing = true;
    result.measurement.confidence = 'low';
    result.measurement.evidence.push('Diagnosis engine reports insufficient traffic volume to diagnose the primary KPI\'s movement -- a measurement/data-volume limitation, not a confirmed performance cause.');
  } else {
    result.measurement.status = diagnosis?.status ? 'measurable' : 'not_measurable';
    result.measurement.reason = diagnosis?.status ? 'No tracking anomaly or data-volume gap flagged.' : 'No diagnosis available to check for a tracking anomaly.';
  }

  // ── Arbitration ───────────────────────────────────────────
  // Defers entirely to diagnosisEngine.js's own already-arbitrated category
  // (the first-matched factor in its documented check order) when a
  // diagnosis exists -- this module never runs a second, competing
  // arbitration. Cross-module-only signals (budget/audience) are surfaced
  // as contributing but are never promoted over an existing diagnosis.
  let primaryCategory = null;
  let arbitrationSource = null;
  // A diagnosis can be "diagnosed" yet carry a category this taxonomy has no
  // mapping for (diagnosisEngine.js's own 'unexplained'/'unclassified'/null
  // verdicts, or a future category this map hasn't been extended for) --
  // that is NOT the same as "no diagnosis was available", and saying so
  // would misrepresent what actually happened (an internal audit caught
  // this exact wording bug). Both cases are tracked separately below so the
  // explanation always states the truth.
  const diagnosisWasDiagnosed = diagnosis?.status === 'diagnosed';
  const diagnosisMapped = diagnosisWasDiagnosed && diagnosis.category && DIAGNOSIS_CATEGORY_MAP[diagnosis.category];

  if (diagnosisMapped) {
    primaryCategory = DIAGNOSIS_CATEGORY_MAP[diagnosis.category];
    arbitrationSource = `diagnosisEngine.js (category="${diagnosis.category}", confidence=${diagnosis.confidence}) -- this platform's own single arbitrated cause for this campaign's primary KPI movement.`;
  } else {
    const diagnosisCaveat = diagnosisWasDiagnosed
      ? `diagnosisEngine.js did produce a diagnosis, but its category ("${diagnosis.category || 'none'}") has no mapping in this system's eight-category taxonomy -- `
      : 'No campaign-level diagnosis was available -- ';
    const contributing = TAXONOMY_KEYS.filter(k => result[k].contributing);
    if (contributing.length === 1) {
      primaryCategory = contributing[0];
      arbitrationSource = `${diagnosisCaveat}only one category (${contributing[0]}) has a contributing cross-module signal, so it is reported as primary.`;
    } else if (contributing.length > 1) {
      primaryCategory = null;
      arbitrationSource = `${diagnosisCaveat}multiple categories show a contributing signal (${contributing.join(', ')}) with nothing to arbitrate between them -- reported as multiple candidate causes rather than a single guess.`;
    } else {
      primaryCategory = null;
      arbitrationSource = diagnosisWasDiagnosed
        ? `diagnosisEngine.js did produce a diagnosis ("${diagnosis.category || 'none'}", not mapped in this taxonomy), and no other category currently shows a contributing signal.`
        : 'No category currently shows a contributing signal.';
    }
  }

  return {
    categories: result,
    primary_category: primaryCategory,
    arbitration_source: arbitrationSource,
    contributing_categories: TAXONOMY_KEYS.filter(k => result[k].contributing),
  };
}

module.exports = { mapRootCauseTaxonomy, TAXONOMY_KEYS };
