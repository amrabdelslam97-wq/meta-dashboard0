/**
 * Hook Alternative Generator — AP-POS Intelligence Layer
 *
 * Additive, read-only synthesis on top of creativeTextAnalysis.js's already-
 * computed analyzeHook() output. Never re-scores the hook and never invents
 * a new persuasion-signal category -- it only turns analyzeHook()'s real
 * `missing` list into concrete, fill-in-the-blank hook-line PATTERNS, one
 * per detected gap, so every alternative traces back to a specific,
 * already-evidenced weakness (creativeIntelligenceEngine.js/
 * creativeTextAnalysis.js remain the sole, unchanged source of the Hook
 * score itself -- see PROJECT_FREEZE_RELEASE.md's Protected Engines table).
 *
 * This system has no LLM anywhere (creativeTextAnalysis.js's own header:
 * "deterministic bilingual EN/AR text analysis, no LLM/vision"). Consistent
 * with that discipline, these are deterministic template PATTERNS with
 * [bracketed] placeholders -- not finished, AI-written ad copy -- and are
 * disclosed as such on every response so a user never mistakes a pattern
 * for a guaranteed-performing rewrite.
 */

const AR_REGEX = /[؀-ۿ]/;

// One EN + one AR fill-in-the-blank pattern per persuasion-signal key this
// system can actually detect (creativeTextAnalysis.js's PERSUASION_SIGNAL_KEYS).
// Every placeholder is bracketed on purpose: this system has no product-
// name/price/audience field reliable enough to auto-fill without risking a
// fabricated claim, so every pattern is a starting structure to adapt with
// real, honest specifics -- never presented as finished copy.
const HOOK_PATTERNS = {
  question:          { en: "Struggling with [problem]? Here's the fix.", ar: 'تعاني من [المشكلة]؟ إليك الحل.' },
  curiosity:         { en: 'The one thing about [product/service] most people miss...', ar: 'الشيء الوحيد اللي معظم الناس مايعرفوش عن [المنتج/الخدمة]...' },
  benefit:           { en: 'Get [specific benefit] without [common tradeoff].', ar: 'احصل على [فايدة محددة] من غير [تنازل شائع].' },
  pain_point:        { en: 'Tired of [specific frustration]? [Product] fixes that.', ar: 'زهقت من [مشكلة محددة]؟ [المنتج] بيحلها.' },
  urgency:           { en: "[Offer] ends [timeframe] -- don't miss it.", ar: '[العرض] بينتهي [المدة] -- محدش يفوته.' },
  number:            { en: '[Number] people already got [result] with [product].', ar: '[رقم] شخص فعلاً حققوا [نتيجة] مع [المنتج].' },
  emotional_opening: { en: 'Imagine finally [desired outcome].', ar: 'تخيل إنك أخيراً حققت [النتيجة المرغوبة].' },
  direct_address:    { en: "If you're a [target audience], this is for you.", ar: 'لو إنت [الجمهور المستهدف]، ده ليك.' },
  statistic:         { en: "[X]% of [audience] don't know this about [topic].", ar: '[س]% من [الجمهور] معندهمش فكرة عن ده في [الموضوع].' },
  offer:             { en: 'Get [specific offer] today only.', ar: 'احصل على [عرض محدد] اليوم بس.' },
};

// Priority order for THIS generator's own job (picking which missing
// signals become concrete example lines when several are absent at once).
// Independently authored for that purpose -- not a copy of
// creativeIntelligenceEngine.js's HOOK_GUIDANCE_PRIORITY, which picks 1-2
// signals to name in a single guidance sentence, a narrower, different job.
const GENERATION_PRIORITY = [
  'question', 'pain_point', 'curiosity', 'benefit', 'emotional_opening',
  'urgency', 'number', 'direct_address', 'statistic', 'offer',
];

const MAX_ALTERNATIVES = 5;

// Same bar creativeIntelligenceEngine.js's generateRecommendations() already
// uses to decide whether a hook needs a "Rewrite Hook" action (its own
// WEAK_THRESHOLD), and the same value rootCauseTaxonomy.js/
// creativeConceptGenerator.js use for every other dimension. Deliberately
// NOT analyzeHook()'s own 'strong'/'moderate'/'weak' label boundary (60/30)
// -- that labeling is calibrated for display, and using it here would fire
// this generator for a 50-59 hook the platform's own canonical
// recommendation engine does not consider weak enough to rewrite, an
// inconsistency an internal audit found and this fixes.
const WEAK_SCORE_THRESHOLD = 50;

/**
 * @param {object} hookAnalysis - creativeTextAnalysis.analyzeHook() output ({score, label, evidence, detected[], missing[]})
 * @param {string} [primaryText] - the ad's real primary text; used ONLY to detect language (EN vs AR) for which pattern set to offer -- never parsed for content to insert into a pattern.
 */
function generateHookAlternatives(hookAnalysis, primaryText) {
  if (!hookAnalysis || hookAnalysis.label === 'missing') {
    return { status: 'not_applicable', reason: 'No primary text to generate a hook alternative from.', alternatives: [] };
  }
  if (hookAnalysis.score >= WEAK_SCORE_THRESHOLD) {
    return {
      status: 'not_applicable',
      reason: `Hook score (${hookAnalysis.score}) is at/above the ${WEAK_SCORE_THRESHOLD} threshold this system uses elsewhere to flag a hook as needing a rewrite (detected signals: ${(hookAnalysis.detected || []).map(d => d.key).join(', ') || 'none listed'}) -- no alternative needed.`,
      alternatives: [],
    };
  }

  const missingKeys = new Set((hookAnalysis.missing || []).map(m => m.key));
  const orderedMissing = GENERATION_PRIORITY.filter(k => missingKeys.has(k) && HOOK_PATTERNS[k]);

  if (orderedMissing.length === 0) {
    return { status: 'not_applicable', reason: 'No pattern-covered persuasion signal is missing for this hook.', alternatives: [] };
  }

  const isArabic = AR_REGEX.test(primaryText || '');
  const alternatives = orderedMissing.slice(0, MAX_ALTERNATIVES).map((key, i) => ({
    id: `hook_alt_${i + 1}`,
    addresses_missing_signal: key,
    pattern: isArabic ? HOOK_PATTERNS[key].ar : HOOK_PATTERNS[key].en,
    rationale: `The current hook has no detected "${key.replace(/_/g, ' ')}" signal (creativeTextAnalysis.analyzeHook()'s own missing-signal evidence) -- this pattern adds it.`,
  }));

  return {
    status: 'generated',
    disclosure: 'These are deterministic, evidence-linked FILL-IN-THE-BLANK PATTERNS, not AI-written or finished ad copy -- this system has no language-generation model anywhere (creativeTextAnalysis.js is fully deterministic/keyword-based). Replace every [bracketed] placeholder with a real, honest detail about this specific product/offer, and A/B test against the current hook rather than assuming a rewrite performs better.',
    based_on_hook_score: hookAnalysis.score,
    alternatives,
  };
}

module.exports = { generateHookAlternatives, HOOK_PATTERNS, GENERATION_PRIORITY };
