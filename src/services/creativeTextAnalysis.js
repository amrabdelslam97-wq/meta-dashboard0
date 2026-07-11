/**
 * Creative Text Analysis — Creative Intelligence Engine, Step 3 (AI Analysis)
 *
 * Deterministic, evidence-based analysis of a creative's real text content
 * (headline / primary_text / description / cta_type — already fetched and
 * persisted by creativeAnalytics.js, no new Meta call). This is NOT a
 * generative-AI or computer-vision system -- there is no LLM/vision
 * dependency anywhere in this codebase (confirmed: no such package in
 * package.json), matching every other "intelligence" engine here
 * (diagnosisEngine.js, ruleEngine.js, analyticsInsight.js), which are all
 * deterministic rule/threshold systems, not generative ones. "AI Analysis"
 * means structured, explainable, evidence-backed scoring -- never a
 * fabricated verdict.
 *
 * Honest scope boundary: dimensions that genuinely require pixel-level
 * image/video content analysis (true color psychology, visual hierarchy,
 * visual clutter from actual pixels, "does this show a human face") are
 * NOT implemented here, because doing so without a real vision model would
 * mean inventing an answer -- exactly what this codebase's house rule
 * (see metricsFetcher.js's repeated "confirmed against a real response"
 * comments) forbids. Instead, the "visual" dimension below is computed from
 * real, available CREATIVE METADATA (media type, aspect ratio vs. Meta's
 * documented placement recommendations, video length vs. platform norms) --
 * clearly labeled `basis: 'metadata'` in its evidence, never presented as
 * pixel-based visual analysis.
 */

// ─────────────────────────────────────────────
// Word lists -- each is a real, generic English marketing-copy vocabulary
// list (not campaign-specific, not fabricated data). Every list is small
// and reviewable so its coverage/limits are obvious, matching this
// codebase's preference for explicit, inspectable rules over black boxes.
// ─────────────────────────────────────────────
const URGENCY_WORDS = ['today', 'now', 'limited', 'hurry', 'last chance', 'ends soon', 'don\'t miss', 'while supplies last', 'act fast', 'expires', 'only', 'left'];
const TRUST_WORDS = ['guarantee', 'certified', 'official', 'trusted', 'verified', 'award', 'accredited', 'licensed', 'authentic'];
const SOCIAL_PROOF_WORDS = ['customers', 'reviews', 'rated', 'trusted by', 'clients', 'users love', '5 star', 'five star', 'testimonial', 'join'];
const CURIOSITY_WORDS = ['secret', 'finally', 'here\'s why', 'here is why', 'what happens', 'you won\'t believe', 'discover', 'revealed', 'the truth about'];
const PAIN_POINT_WORDS = ['tired of', 'struggling with', 'sick of', 'frustrated', 'problem', 'stop wasting', 'without the hassle'];
const BENEFIT_WORDS = ['get', 'achieve', 'enjoy', 'save', 'unlock', 'boost', 'improve', 'transform', 'gain'];
const EMOTION_WORDS = ['love', 'excited', 'amazing', 'incredible', 'thrilled', 'happy', 'proud', 'beautiful'];
const OFFER_SIGNAL_REGEX = /(\d+%|\$\d+|free\b|discount|sale|off\b|deal\b|bundle|bonus)/i;
const HOOK_TRIGGER_REGEX = /^(why|how|what|stop|warning|attention|imagine|did you know)\b/i;
const DIRECT_ADDRESS_REGEX = /\byou(r)?\b/i;

// Meta's own documented, action-oriented (specific-intent) CTA types vs.
// generic/passive ones -- both lists are Meta's real, enumerated
// call_to_action `type` values (Marketing API AdCreativeLinkDataCallToAction),
// not invented categories.
const STRONG_CTA_TYPES = new Set([
  'SHOP_NOW', 'BUY_NOW', 'ORDER_NOW', 'SIGN_UP', 'SUBSCRIBE', 'DOWNLOAD',
  'GET_QUOTE', 'BOOK_TRAVEL', 'GET_OFFER', 'APPLY_NOW', 'BOOK_NOW', 'GET_STARTED',
  'START_ORDER', 'REGISTER',
]);
const WEAK_CTA_TYPES = new Set(['LEARN_MORE', 'SEE_MORE', 'NO_BUTTON', 'CONTACT_US', 'WATCH_MORE']);

function round(n, dp = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

function containsAny(text, list) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return list.filter(w => lower.includes(w));
}

function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text) {
  if (!text) return 0;
  const matches = text.match(/[.!?]+/g);
  return matches ? matches.length : (text.trim() ? 1 : 0);
}

/**
 * Hook quality -- analyzes the opening of primary_text (the "hook" that
 * must stop a scrolling feed). Real signals: a question, a hook-trigger
 * word/phrase at the start, direct address ("you"), or a leading number/stat.
 */
function analyzeHook(primaryText) {
  if (!primaryText) {
    return { score: 0, label: 'missing', evidence: 'No primary text to evaluate a hook from.' };
  }
  const trimmed = primaryText.trim();
  // Split ON the delimiter but keep it (String#split with a capturing group
  // interleaves the delimiters into the result) so a leading "?" isn't lost
  // -- checking `opening` alone after a lossy split previously meant a
  // question-opening sentence could never be detected as one.
  const firstChunk = (trimmed.match(/^.*?([.!?]|$)/) || [trimmed])[0];
  const opening = firstChunk || trimmed.slice(0, 80);
  const openingWords = opening.replace(/[.!?]+$/, '').trim().split(/\s+/).filter(Boolean);
  const signals = [];
  if (/\?\s*$/.test(opening)) signals.push('opens with a question');
  if (HOOK_TRIGGER_REGEX.test(opening.trim())) signals.push('opens with a hook-trigger word (why/how/stop/imagine/...)');
  // Direct address only counts as a hook technique when "you/your" appears
  // prominently near the start (first 4 words) -- matching it anywhere in a
  // longer opening picks up incidental usage ("... for your home") that
  // isn't actually a deliberate direct-address hook technique.
  if (DIRECT_ADDRESS_REGEX.test(openingWords.slice(0, 4).join(' '))) signals.push('directly addresses the reader ("you") up front');
  if (/^\d+/.test(opening.trim())) signals.push('opens with a number/statistic');
  const curiosityHits = containsAny(opening, CURIOSITY_WORDS);
  if (curiosityHits.length) signals.push(`curiosity trigger: "${curiosityHits[0]}"`);

  const openingWordCount = wordCount(opening);
  const lengthOk = openingWordCount >= 3 && openingWordCount <= 15;
  if (!lengthOk) signals.push(openingWordCount > 15 ? 'opening is too long to hook a scrolling reader' : 'opening is too short to establish a hook');

  const score = Math.min(100, signals.filter(s => !s.startsWith('opening is')).length * 25 + (lengthOk ? 20 : 0));
  return {
    score,
    label: score >= 60 ? 'strong' : score >= 30 ? 'moderate' : 'weak',
    evidence: signals.length ? signals.join('; ') : 'No hook signals detected in the opening line.',
  };
}

/** Headline quality -- length (Meta feed truncates long headlines), power words, ALL-CAPS spam check. */
function analyzeHeadline(headline) {
  if (!headline) {
    return { score: 0, label: 'missing', evidence: 'No headline set.' };
  }
  const words = wordCount(headline);
  const chars = headline.length;
  const signals = [];
  let score = 50;

  if (words >= 3 && words <= 8) { signals.push('ideal length (3-8 words)'); score += 20; }
  else if (words > 8) { signals.push(`too long (${words} words) -- risks truncation in feed placements`); score -= 20; }
  else { signals.push(`very short (${words} word${words === 1 ? '' : 's'})`); score -= 5; }

  if (chars > 40) { signals.push(`${chars} characters -- likely truncated on mobile feed`); score -= 10; }

  const capsRatio = (headline.match(/[A-Z]/g) || []).length / Math.max(chars, 1);
  if (capsRatio > 0.5 && chars > 8) { signals.push('excessive capitalization (reads as spam/shouting)'); score -= 25; }

  const offerHit = OFFER_SIGNAL_REGEX.test(headline);
  if (offerHit) { signals.push('contains a concrete offer signal'); score += 15; }

  score = Math.max(0, Math.min(100, score));
  return { score, label: score >= 65 ? 'strong' : score >= 40 ? 'moderate' : 'weak', evidence: signals.join('; ') };
}

/** Copy (primary_text) quality -- length category, sentence structure, readability approximation. */
function analyzeCopy(primaryText) {
  if (!primaryText) {
    return { score: 0, label: 'missing', evidence: 'No primary text set.', length_category: 'none', word_count: 0 };
  }
  const words = wordCount(primaryText);
  const sentences = Math.max(sentenceCount(primaryText), 1);
  const avgWordsPerSentence = words / sentences;
  const avgWordLength = primaryText.replace(/[^a-zA-Z\s]/g, '').split(/\s+/).filter(Boolean)
    .reduce((sum, w, _, arr) => sum + w.length / arr.length, 0) || 0;

  let lengthCategory;
  if (words <= 20) lengthCategory = 'short';
  else if (words <= 60) lengthCategory = 'medium';
  else lengthCategory = 'long';

  const signals = [`${words} words, ${sentences} sentence(s), ${lengthCategory} copy`];
  let score = 70;

  // Meta's own best-practice guidance favors short-to-medium primary text
  // for feed placements; long copy performs situationally (e.g. detailed
  // offers) but is scored down as a general-purpose default, not a hard rule.
  if (lengthCategory === 'long') { score -= 20; signals.push('long copy risks being collapsed behind "See More" before the message lands'); }
  if (avgWordsPerSentence > 25) { score -= 15; signals.push('very long sentences reduce readability'); }
  if (avgWordLength > 6.5) { score -= 10; signals.push('long average word length may reduce mobile readability'); }
  if (avgWordsPerSentence <= 15 && avgWordLength <= 5.5) { score += 10; signals.push('short sentences and simple words aid readability'); }

  score = Math.max(0, Math.min(100, score));
  return {
    score, label: score >= 65 ? 'strong' : score >= 40 ? 'moderate' : 'weak',
    evidence: signals.join('; '), length_category: lengthCategory, word_count: words,
    readability: score >= 65 ? 'easy' : score >= 40 ? 'moderate' : 'difficult',
  };
}

/** CTA quality -- classifies Meta's real enumerated cta_type as action-oriented vs. generic. */
function analyzeCta(ctaType) {
  if (!ctaType) {
    return { score: 30, label: 'missing', evidence: 'No call-to-action set on this creative.' };
  }
  const type = String(ctaType).toUpperCase();
  if (STRONG_CTA_TYPES.has(type)) {
    return { score: 85, label: 'strong', evidence: `"${type}" is a specific, action-oriented CTA.` };
  }
  if (WEAK_CTA_TYPES.has(type)) {
    return { score: 45, label: 'weak', evidence: `"${type}" is a generic, low-commitment CTA -- consider a more specific action if the objective supports it.` };
  }
  return { score: 60, label: 'moderate', evidence: `"${type}" is a recognized CTA not classified as strong or generic by this system's reference list.` };
}

/** Offer clarity -- is there a concrete, legible offer signal in the copy? */
function analyzeOffer(primaryText, headline, description) {
  const combined = [primaryText, headline, description].filter(Boolean).join(' ');
  if (!combined) return { score: 0, label: 'missing', evidence: 'No text to evaluate an offer from.' };
  const hasOffer = OFFER_SIGNAL_REGEX.test(combined);
  return {
    score: hasOffer ? 80 : 35,
    label: hasOffer ? 'clear' : 'vague',
    evidence: hasOffer ? 'A concrete offer signal (price, discount, or "free") is present.' : 'No concrete offer signal (price/discount/free) detected -- the value proposition may be unclear.',
  };
}

/** Trust & Authority -- real trust-vocabulary presence. */
function analyzeTrust(combinedText) {
  const hits = containsAny(combinedText, TRUST_WORDS);
  const socialHits = containsAny(combinedText, SOCIAL_PROOF_WORDS);
  const score = Math.min(100, hits.length * 30 + socialHits.length * 25);
  return {
    score,
    label: score >= 50 ? 'present' : 'absent',
    evidence: [...hits.map(h => `trust word: "${h}"`), ...socialHits.map(h => `social proof: "${h}"`)].join('; ') || 'No trust or social-proof language detected.',
    social_proof: socialHits.length > 0,
  };
}

/** Psychology composite -- urgency, curiosity, pain-point/benefit framing, emotional appeal. */
function analyzePsychology(combinedText) {
  const urgency = containsAny(combinedText, URGENCY_WORDS);
  const curiosity = containsAny(combinedText, CURIOSITY_WORDS);
  const pain = containsAny(combinedText, PAIN_POINT_WORDS);
  const benefit = containsAny(combinedText, BENEFIT_WORDS);
  const emotion = containsAny(combinedText, EMOTION_WORDS);

  const dimensions = { urgency: urgency.length > 0, curiosity: curiosity.length > 0, pain_point: pain.length > 0, benefit: benefit.length > 0, emotional_appeal: emotion.length > 0 };
  const activeCount = Object.values(dimensions).filter(Boolean).length;
  const score = Math.min(100, activeCount * 20);

  return {
    score,
    label: score >= 60 ? 'strong' : score >= 20 ? 'moderate' : 'weak',
    dimensions,
    evidence: [
      urgency.length ? `urgency: "${urgency[0]}"` : null,
      curiosity.length ? `curiosity: "${curiosity[0]}"` : null,
      pain.length ? `pain point: "${pain[0]}"` : null,
      benefit.length ? `benefit: "${benefit[0]}"` : null,
      emotion.length ? `emotional appeal: "${emotion[0]}"` : null,
    ].filter(Boolean).join('; ') || 'No urgency, curiosity, pain-point, benefit, or emotional-appeal language detected.',
  };
}

/** Mobile-friendliness -- combined text length, since most Meta impressions are mobile feed. */
function analyzeMobileFriendliness(primaryText, headline) {
  const totalChars = (primaryText?.length || 0) + (headline?.length || 0);
  const score = totalChars === 0 ? 0 : totalChars <= 150 ? 90 : totalChars <= 300 ? 65 : 35;
  return {
    score,
    label: score >= 65 ? 'good' : score >= 35 ? 'fair' : 'poor',
    evidence: `${totalChars} combined headline+primary-text characters -- ${score >= 65 ? 'reads well on a mobile feed without truncation' : 'likely truncated or dense on a mobile feed'}.`,
  };
}

/**
 * Visual dimension -- METADATA-based proxy only (media type, aspect ratio
 * vs. Meta's documented placement recommendations, video length vs. common
 * platform norms). Explicitly NOT pixel/color/composition analysis -- see
 * this file's header comment for why. `basis: 'metadata'` marks this
 * distinction on every returned object so no caller can mistake it for
 * true visual content analysis.
 */
function analyzeVisualMetadata({ mediaType, aspectRatio, videoLengthSec }) {
  const signals = [];
  let score = 50;

  if (mediaType === 'video') {
    signals.push('video creative (generally higher scroll-stop power than static image)');
    score += 15;
    if (videoLengthSec != null) {
      if (videoLengthSec <= 15) { signals.push(`${videoLengthSec}s length is within the commonly-recommended short-form feed range`); score += 10; }
      else if (videoLengthSec > 60) { signals.push(`${videoLengthSec}s is long for feed placements -- retention risk`); score -= 15; }
    }
  } else if (mediaType === 'image') {
    signals.push('static image creative');
  } else if (mediaType === 'carousel') {
    signals.push('carousel creative (multiple cards)');
    score += 5;
  }

  if (aspectRatio) {
    const squareOrVertical = ['1:1', '4:5', '9:16'].includes(aspectRatio);
    if (squareOrVertical) { signals.push(`${aspectRatio} matches Meta's recommended mobile-feed aspect ratios`); score += 10; }
    else { signals.push(`${aspectRatio} is not one of Meta's recommended mobile-feed ratios (1:1, 4:5, 9:16) -- may be cropped`); score -= 10; }
  } else {
    signals.push('aspect ratio unknown');
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score, label: score >= 65 ? 'good' : score >= 40 ? 'fair' : 'poor',
    evidence: signals.join('; '), basis: 'metadata',
  };
}

/**
 * Runs the full text/metadata analysis suite for one creative snapshot.
 * @param {object} creative - { headline, primary_text, description, cta_type,
 *   creative_type|media_type, aspect_ratio, video_length_sec }
 */
function analyzeCreative(creative) {
  const { headline, primary_text: primaryText, description, cta_type: ctaType } = creative;
  const combinedText = [headline, primaryText, description].filter(Boolean).join(' ');

  const hook = analyzeHook(primaryText);
  const headlineAnalysis = analyzeHeadline(headline);
  const copy = analyzeCopy(primaryText);
  const cta = analyzeCta(ctaType);
  const offer = analyzeOffer(primaryText, headline, description);
  const trust = analyzeTrust(combinedText);
  const psychology = analyzePsychology(combinedText);
  const mobileFriendliness = analyzeMobileFriendliness(primaryText, headline);
  const visual = analyzeVisualMetadata({
    mediaType: creative.media_type || creative.creative_type,
    aspectRatio: creative.aspect_ratio,
    videoLengthSec: creative.video_length_sec,
  });

  return {
    hook, headline: headlineAnalysis, copy, cta, offer, trust, psychology,
    mobile_friendliness: mobileFriendliness, visual,
    brand_consistency: { score: null, label: 'not_available', evidence: 'Requires brand guideline reference data (approved colors/fonts/logo usage) not available in this system -- not fabricated.' },
    not_analyzed: ['color_psychology', 'visual_hierarchy', 'visual_clutter (pixel-based)'].map(dim => ({
      dimension: dim, reason: 'Requires image/video pixel content analysis (a vision model) -- none exists in this system. See visual.basis="metadata" for the closest honest proxy.',
    })),
  };
}

module.exports = {
  analyzeHook, analyzeHeadline, analyzeCopy, analyzeCta, analyzeOffer,
  analyzeTrust, analyzePsychology, analyzeMobileFriendliness, analyzeVisualMetadata,
  analyzeCreative,
  STRONG_CTA_TYPES, WEAK_CTA_TYPES,
};
