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
 * Phase 41 — bilingual (Arabic + English) word/phrase lists. Confirmed via
 * real production ad accounts (Phase 40/41 runtime audit) that the large
 * majority of real creatives on this system are Arabic-language copy; the
 * pre-Phase-41 version of this file only recognized English vocabulary, so
 * every real Arabic creative scored 0/absent on trust and psychology and
 * "no hook signals detected" regardless of actual content (e.g. copy
 * containing "آراءكم الإيجابية" / positive customer reviews, "مضمونة" /
 * guaranteed, "لا تفوتوا الفرصة" / don't miss the opportunity — all real
 * trust/urgency signals a human reader immediately recognizes). Arabic
 * detection is ADDED alongside the existing English lists, not a
 * replacement -- English creatives are scored exactly as before.
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
// Arabic text normalization -- strips diacritics (tashkeel) and tatweel,
// and folds common spelling variants (alef/yeh/teh-marbuta forms) so
// keyword matching isn't defeated by ordinary casual-Arabic spelling
// variation (e.g. "مجاناً" vs "مجانا", "آراء" vs "اراء"). Applied to BOTH
// the input text and the word/phrase lists below at match time, via
// containsAnyAr(). Non-Arabic text passes through unchanged (no Arabic
// characters to normalize), so this never affects English matching.
// ─────────────────────────────────────────────
const ARABIC_DIACRITICS_REGEX = /[ً-ٰٟۖ-ۭـ]/g; // tashkeel + tatweel
function normalizeArabic(text) {
  if (!text) return '';
  return text
    .replace(ARABIC_DIACRITICS_REGEX, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

// ─────────────────────────────────────────────
// Word/phrase lists -- each list is a real, generic vocabulary list (not
// campaign-specific, not fabricated data), small and reviewable so its
// coverage/limits are obvious, matching this codebase's preference for
// explicit, inspectable rules over black boxes. Arabic entries are
// deliberately multi-word PHRASES where possible (not single common words)
// to keep precision high and avoid false positives on ordinary copy that
// happens to contain a generic word (Phase 41's explicit "avoid false
// positives" requirement) -- e.g. "ضمان" (a real, specific trust word) is
// listed, but a bare "جودة" (quality) is not, since nearly every ad claims
// quality and it would inflate false positives without real signal.
// ─────────────────────────────────────────────
const URGENCY_WORDS = ['today', 'now', 'limited', 'hurry', 'last chance', 'ends soon', 'don\'t miss', 'while supplies last', 'act fast', 'expires', 'only', 'left'];
const URGENCY_WORDS_AR = ['لا تفوت', 'لا تفوتوا', 'متفوتش', 'متفوتوش', 'الفرصه', 'فرصتك', 'اخر فرصه', 'قبل فوات الاوان', 'ينتهي قريبا', 'العرض ينتهي', 'سارع', 'سارعوا', 'الحقوا', 'عاجل', 'حالا', 'فورا', 'اليوم فقط', 'لفتره محدوده'];

const SCARCITY_WORDS_AR = ['كميه محدوده', 'اماكن محدوده', 'العدد محدود', 'حتي نفاد الكميه', 'اخر قطعه', 'اخر الكميه', 'المقاعد محدوده', 'مقاعد محدوده'];

const TRUST_WORDS = ['guarantee', 'certified', 'official', 'trusted', 'verified', 'award', 'accredited', 'licensed', 'authentic'];
const TRUST_WORDS_AR = ['موثق', 'موثقه', 'معتمد', 'معتمده', 'مضمون', 'مضمونه', 'ضمان', 'نضمن لك', 'رسمي', 'رسميه', 'سنوات خبره', 'سنوات الخبره', 'سنه خبره', 'صور حقيقيه', 'شهاده معتمده', 'شهادات معتمده', 'الاكثر مبيعا', 'اكثر مبيعا'];

const SOCIAL_PROOF_WORDS = ['customers', 'reviews', 'rated', 'trusted by', 'clients', 'users love', '5 star', 'five star', 'testimonial', 'join'];
const SOCIAL_PROOF_WORDS_AR = ['اراء العملاء', 'اراء عملائنا', 'تقييم العملاء', 'تقييمات العملاء', 'تجربه عملائنا', 'يثقون بنا', 'ثقتكم فينا', 'الاف العملاء', 'عملاؤنا', 'اللي جربوا', 'اللي جربو'];

const CURIOSITY_WORDS = ['secret', 'finally', 'here\'s why', 'here is why', 'what happens', 'you won\'t believe', 'discover', 'revealed', 'the truth about'];
const CURIOSITY_WORDS_AR = ['تخيل', 'تخيل معايا', 'هل تعلم', 'هل تعلم ان', 'لن تصدق', 'السر', 'اكتشف', 'اكتشفي', 'ما لا تعرفه', 'الحقيقه', 'ليه', 'ايه رايك', 'ايه رايكم', 'وللمره الاولي', 'لاول مره'];

const PAIN_POINT_WORDS = ['tired of', 'struggling with', 'sick of', 'frustrated', 'problem', 'stop wasting', 'without the hassle'];
const PAIN_POINT_WORDS_AR = ['بتعاني من', 'تعاني من', 'مشكله', 'مشكلتك', 'متعب من', 'تعبان من', 'قلقان', 'خايف من', 'مش عارف', 'زهقت من', 'زهقتي من'];

const BENEFIT_WORDS = ['get', 'achieve', 'enjoy', 'save', 'unlock', 'boost', 'improve', 'transform', 'gain'];
const BENEFIT_WORDS_AR = ['تستفيد', 'استفيد', 'يفيدك', 'فوائد', 'فايده', 'يحسن', 'تحسين', 'توفر', 'وفر', 'وفري', 'تكسب', 'احصل علي', 'تحصل علي', 'يرفع', 'ترفع مناعتك'];

const EMOTION_WORDS = ['love', 'excited', 'amazing', 'incredible', 'thrilled', 'happy', 'proud', 'beautiful'];
const EMOTION_WORDS_AR = ['نحب', 'سعاده', 'سعيد', 'فخورين', 'فخر', 'رائع', 'رائعه', 'ممتاز', 'ممتازه', 'حماس', 'متحمسين', 'يدلع', 'يفرحك'];

const TRANSFORMATION_WORDS_AR = ['غير حياتك', 'حياه جديده', 'مستقبل افضل', 'من موظف', 'رحلتك', 'خطوه اولي', 'نسخه افضل منك'];
const PROBLEM_SOLUTION_WORDS_AR = ['الحل', 'الحل الامثل', 'حل نهائي', 'اطمن', 'الاختيار الامثل'];
const AUTHORITY_WORDS_AR = ['خبير', 'دكتور', 'د/', 'متخصص', 'اخصائي', 'استشاري', 'محاضر', 'خبره طويله'];
const AUTHORITY_WORDS = ['expert', 'doctor', 'specialist', 'certified professional', 'award-winning'];
const GUARANTEE_WORDS_AR = ['ضمان استرجاع', 'استرجاع الاموال', 'استرداد الاموال', 'نضمن لك', 'ضمان'];
const VALUE_WORDS_AR = ['افضل سعر', 'يستاهل', 'يستحق', 'مقابل سعره', 'قيمه حقيقيه'];
const RISK_REVERSAL_WORDS_AR = ['ضمان استرجاع الاموال', 'بدون مخاطره', 'جرب مجانا', 'تجربه مجانيه', 'استرجاع مجاني'];

// Combined English+Arabic lists, hoisted to stable module-level references
// (rather than rebuilt as `[...A, ...B]` inline on every analyzer call) so
// normalizedList()'s by-reference cache above actually caches them -- an
// inline spread allocates a brand-new array every call, which would
// silently defeat that cache.
const URGENCY_ALL = [...URGENCY_WORDS, ...URGENCY_WORDS_AR];
const TRUST_ALL = [...TRUST_WORDS, ...TRUST_WORDS_AR];
const SOCIAL_PROOF_ALL = [...SOCIAL_PROOF_WORDS, ...SOCIAL_PROOF_WORDS_AR];
const CURIOSITY_ALL = [...CURIOSITY_WORDS, ...CURIOSITY_WORDS_AR];
const PAIN_POINT_ALL = [...PAIN_POINT_WORDS, ...PAIN_POINT_WORDS_AR];
const BENEFIT_ALL = [...BENEFIT_WORDS, ...BENEFIT_WORDS_AR];
const EMOTION_ALL = [...EMOTION_WORDS, ...EMOTION_WORDS_AR];
const AUTHORITY_ALL = [...AUTHORITY_WORDS, ...AUTHORITY_WORDS_AR];

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
// Meta's messaging-destination CTA types (WhatsApp/Messenger click-to-chat)
// are extremely common in this system's real accounts (Phase 40/41 runtime
// audit: the majority of real ads use WHATSAPP_MESSAGE/MESSAGE_PAGE) but
// were previously unclassified (falling into the generic "moderate, not
// classified" bucket regardless of what the actual embedded copy asked the
// reader to do). They're a real, specific, action-oriented CTA in their own
// right -- Meta documents them as their own family, not a variant of
// LEARN_MORE -- so classified as strong here, same tier as SHOP_NOW/BUY_NOW.
const MESSAGING_CTA_TYPES = new Set(['WHATSAPP_MESSAGE', 'MESSAGE_PAGE', 'SEND_MESSAGE']);

// Embedded Arabic CTA phrases -- Phase 41, Phase 6: many real Arabic ads
// (confirmed in production copy) put the actual call-to-action as text
// inside primary_text ("راسلنا"/"احجز الان") rather than relying solely on
// Meta's cta_type button, so CTA quality is evaluated from BOTH sources.
// Tiered the same way Meta's own STRONG/WEAK cta_type split works: a
// specific, committing action ("احجز" = book, "اشتري" = buy) vs. a vague,
// low-commitment one ("راسلنا" = message us, with no stated action once
// they do).
const STRONG_CTA_PHRASES_AR = ['اطلب الان', 'اطلبي الان', 'احجز الان', 'احجزي الان', 'اشتري الان', 'اشتر الان', 'سجل الان', 'سجلي الان', 'ابدا الان', 'ابدأ الان', 'اشترك الان'];
const MEDIUM_CTA_PHRASES_AR = ['احجز', 'اطلب', 'اشتري', 'اشتر', 'سجل', 'سجلي', 'ابدا', 'ابدأ', 'اشترك', 'تواصل معنا'];
const WEAK_CTA_PHRASES_AR = ['راسلنا', 'ابعتلنا', 'كلمنا', 'اتصل بنا', 'اعرف اكتر', 'اعرفي اكتر', 'اكتشف'];

const OFFER_SIGNAL_REGEX = /(\d+%|\$\d+|free\b|discount|sale|off\b|deal\b|bundle|bonus)/i;
const OFFER_SIGNAL_REGEX_AR = /(خصم|عرض خاص|عروض|مجانا|مجاناً|اشتري واحصل|اشتر واحصل|لفتره محدوده|حتي نفاد الكميه|سعر خاص|عرض اليوم|افضل سعر|وفر|وفري|هديه|هدايا|بونص)/;
const HOOK_TRIGGER_REGEX = /^(why|how|what|stop|warning|attention|imagine|did you know)\b/i;
const HOOK_TRIGGER_REGEX_AR = /^(ليه|لماذا|ازاي|إزاي|كيف|ماذا|إيه|ايه|تخيل|هل تعلم|احذر|انتبه|توقف|يا |وقف)/;
const DIRECT_ADDRESS_REGEX = /\byou(r)?\b/i;
const DIRECT_ADDRESS_REGEX_AR = /(انت|إنت|انتي|إنتي|انتم|حضرتك|معاك|معاكي|بتاعك|بتاعتك)/;
// Arabic question mark (؟, U+061F) as well as the plain "?" (real Arabic
// social copy frequently uses either).
const QUESTION_MARK_REGEX = /[؟?]\s*$/;
// Unicode emoji ranges -- a real, visible, language-agnostic hook signal
// this file previously never checked for at all (an emoji-led opening,
// e.g. "🔥 جعان؟" / "🎉 مستمرين بدعمكم", is a common and genuinely
// effective real-world scroll-stopping hook technique in both languages).
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;
const SURPRISE_WORDS_AR = ['مفاجاه', 'صدمه', 'لاول مره', 'وللمره الاولي', 'حصريا', 'اخيرا'];
const SURPRISE_WORDS = ['surprising', 'shocking', 'unbelievable', 'finally here', 'for the first time'];
const SURPRISE_ALL = [...SURPRISE_WORDS, ...SURPRISE_WORDS_AR];
const NUMBER_LEADING_REGEX = /^\d+/;

function round(n, dp = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

/** Substring match against a phrase list, normalizing Arabic spelling variants on both sides so casual spelling (مجاناً vs مجانا) doesn't defeat matching. Falls back to plain lowercase matching for non-Arabic entries. */
// Every word/phrase list above is a static, module-level constant re-used
// across every analyzeCreative() call -- normalizing each entry fresh on
// every single containsAny() call (this function is called ~20 times per
// analyzeCreative(), once per category) was pure repeated work on data that
// never changes. Cached by list identity (a plain Map keyed on the array
// reference itself, since these arrays are never recreated), computed once
// on first use per list -- a measurable perf win with zero behavior change.
const normalizedListCache = new Map();
function normalizedList(list) {
  let cached = normalizedListCache.get(list);
  if (!cached) {
    cached = list.map(w => ({ lower: w.toLowerCase(), norm: normalizeArabic(w.toLowerCase()) }));
    normalizedListCache.set(list, cached);
  }
  return cached;
}

function containsAny(text, list) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const normalized = normalizeArabic(lower);
  const entries = normalizedList(list);
  const hits = [];
  for (let i = 0; i < entries.length; i++) {
    const { lower: wLower, norm: wNorm } = entries[i];
    if (lower.includes(wLower) || normalized.includes(wNorm)) hits.push(list[i]);
  }
  return hits;
}

function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text) {
  if (!text) return 0;
  const matches = text.match(/[.!?؟]+/g);
  return matches ? matches.length : (text.trim() ? 1 : 0);
}

/**
 * Hook quality -- analyzes the opening of primary_text (the "hook" that
 * must stop a scrolling feed). Real signals: a question (Latin or Arabic
 * ؟), an emoji-led opening, a hook-trigger word/phrase at the start (English
 * or Arabic), direct address ("you"/"انت"), a leading number, or a surprise
 * word. Returns both a human-readable `evidence` string (backward
 * compatible with every existing caller/test) and structured `detected`/
 * `missing` arrays (Phase 41 explainability -- lets the frontend show a
 * checklist instead of a single opaque score).
 */
function analyzeHook(primaryText) {
  if (!primaryText) {
    return { score: 0, label: 'missing', evidence: 'No primary text to evaluate a hook from.', detected: [], missing: [] };
  }
  const trimmed = primaryText.trim();
  // Split ON the delimiter but keep it (String#split with a capturing group
  // interleaves the delimiters into the result) so a leading "?"/"؟" isn't
  // lost -- checking `opening` alone after a lossy split previously meant a
  // question-opening sentence could never be detected as one.
  const firstChunk = (trimmed.match(/^.*?([.!?؟]|$)/) || [trimmed])[0];
  const opening = firstChunk || trimmed.slice(0, 80);
  const openingWords = opening.replace(/[.!?؟]+$/, '').trim().split(/\s+/).filter(Boolean);
  const openingHead = openingWords.slice(0, 4).join(' ');

  const detected = [];
  const missing = [];

  if (QUESTION_MARK_REGEX.test(opening)) detected.push({ key: 'question', label: 'Opens with a question' });
  else missing.push({ key: 'question', label: 'Question' });

  if (EMOJI_REGEX.test(opening)) detected.push({ key: 'emoji', label: 'Emoji-led opening' });
  else missing.push({ key: 'emoji', label: 'Emoji opening' });

  if (HOOK_TRIGGER_REGEX.test(opening.trim()) || HOOK_TRIGGER_REGEX_AR.test(opening.trim())) {
    detected.push({ key: 'hook_trigger', label: 'Opens with a hook-trigger word (why/how/imagine/تخيل/ليه/...)' });
  } else {
    missing.push({ key: 'hook_trigger', label: 'Hook-trigger word' });
  }

  if (DIRECT_ADDRESS_REGEX.test(openingHead) || DIRECT_ADDRESS_REGEX_AR.test(openingHead)) {
    detected.push({ key: 'direct_address', label: 'Directly addresses the reader ("you"/"انت")' });
  } else {
    missing.push({ key: 'direct_address', label: 'Direct address' });
  }

  if (NUMBER_LEADING_REGEX.test(opening.trim())) detected.push({ key: 'number', label: 'Opens with a number/statistic' });
  else missing.push({ key: 'number', label: 'Leading number/statistic' });

  const curiosityHits = containsAny(opening, CURIOSITY_ALL);
  if (curiosityHits.length) detected.push({ key: 'curiosity', label: `Curiosity trigger: "${curiosityHits[0]}"` });
  else missing.push({ key: 'curiosity', label: 'Curiosity trigger' });

  const surpriseHits = containsAny(opening, SURPRISE_ALL);
  if (surpriseHits.length) detected.push({ key: 'surprise', label: `Surprise/novelty signal: "${surpriseHits[0]}"` });
  else missing.push({ key: 'surprise', label: 'Surprise/novelty signal' });

  const painHits = containsAny(opening, PAIN_POINT_ALL);
  if (painHits.length) detected.push({ key: 'pain_point', label: `Pain-point framing: "${painHits[0]}"` });
  else missing.push({ key: 'pain_point', label: 'Pain-point framing' });

  const benefitHits = containsAny(opening, BENEFIT_ALL);
  if (benefitHits.length) detected.push({ key: 'benefit', label: `Benefit language: "${benefitHits[0]}"` });
  else missing.push({ key: 'benefit', label: 'Benefit language' });

  const offerHits = OFFER_SIGNAL_REGEX.test(opening) || OFFER_SIGNAL_REGEX_AR.test(opening);
  if (offerHits) detected.push({ key: 'offer', label: 'Offer signal in the opening' });
  else missing.push({ key: 'offer', label: 'Offer signal' });

  const urgencyHits = containsAny(opening, URGENCY_ALL);
  if (urgencyHits.length) detected.push({ key: 'urgency', label: `Urgency language: "${urgencyHits[0]}"` });
  else missing.push({ key: 'urgency', label: 'Urgency language' });

  const emotionHits = containsAny(opening, EMOTION_ALL);
  if (emotionHits.length) detected.push({ key: 'emotional_opening', label: `Emotional opening: "${emotionHits[0]}"` });
  else missing.push({ key: 'emotional_opening', label: 'Emotional opening' });

  const openingWordCount = wordCount(opening);
  const lengthOk = openingWordCount >= 3 && openingWordCount <= 20;
  if (!lengthOk) {
    missing.push({ key: 'length', label: openingWordCount > 20 ? 'Concise opening (too long to hook a scrolling reader)' : 'Concise opening (too short to establish a hook)' });
  }

  // Each real signal category counts once toward the score, regardless of
  // how many keyword lists it matched under (e.g. curiosity+emotion both
  // firing still counts as 2 signals, not double-counted per list) --
  // capped so a handful of strong signals already reaches a strong score
  // without needing every single category to fire (2 solid signals + a
  // well-sized opening reaches "strong", matching this file's original
  // 2-signals-is-strong calibration).
  const score = Math.min(100, detected.length * 20 + (lengthOk ? 20 : 0));
  const evidence = detected.length
    ? detected.map(d => d.label.toLowerCase()).join('; ')
    : 'No hook signals detected in the opening line.';

  return {
    score,
    label: score >= 60 ? 'strong' : score >= 30 ? 'moderate' : 'weak',
    evidence,
    detected,
    missing,
  };
}

/** Headline quality -- length (Meta feed truncates long headlines), power words, ALL-CAPS spam check. */
function analyzeHeadline(headline) {
  if (!headline) {
    return { score: 0, label: 'missing', evidence: 'No headline set.', detected: [], missing: [] };
  }
  const words = wordCount(headline);
  const chars = headline.length;
  const signals = [];
  const detected = [];
  const missing = [];
  let score = 50;

  if (words >= 3 && words <= 8) { signals.push('ideal length (3-8 words)'); score += 20; detected.push({ key: 'length', label: 'Ideal length (3-8 words)' }); }
  else if (words > 8) { signals.push(`too long (${words} words) -- risks truncation in feed placements`); score -= 20; missing.push({ key: 'length', label: 'Ideal length (3-8 words)' }); }
  else { signals.push(`very short (${words} word${words === 1 ? '' : 's'})`); score -= 5; missing.push({ key: 'length', label: 'Ideal length (3-8 words)' }); }

  if (chars > 40) { signals.push(`${chars} characters -- likely truncated on mobile feed`); score -= 10; }

  const capsRatio = (headline.match(/[A-Z]/g) || []).length / Math.max(chars, 1);
  if (capsRatio > 0.5 && chars > 8) { signals.push('excessive capitalization (reads as spam/shouting)'); score -= 25; }

  const offerHit = OFFER_SIGNAL_REGEX.test(headline) || OFFER_SIGNAL_REGEX_AR.test(headline);
  if (offerHit) { signals.push('contains a concrete offer signal'); score += 15; detected.push({ key: 'offer', label: 'Contains an offer signal' }); }
  else { missing.push({ key: 'offer', label: 'Offer signal' }); }

  score = Math.max(0, Math.min(100, score));
  return { score, label: score >= 65 ? 'strong' : score >= 40 ? 'moderate' : 'weak', evidence: signals.join('; '), detected, missing };
}

/** Copy (primary_text) quality -- length category, sentence structure, readability approximation. */
function analyzeCopy(primaryText) {
  if (!primaryText) {
    return { score: 0, label: 'missing', evidence: 'No primary text set.', length_category: 'none', word_count: 0 };
  }
  const words = wordCount(primaryText);
  const sentences = Math.max(sentenceCount(primaryText), 1);
  const avgWordsPerSentence = words / sentences;
  const avgWordLength = primaryText.replace(/[^a-zA-Z؀-ۿ\s]/g, '').split(/\s+/).filter(Boolean)
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

/**
 * CTA quality -- classifies Meta's real enumerated cta_type as
 * action-oriented vs. generic, AND (Phase 41, Phase 6) evaluates any
 * embedded Arabic CTA phrase actually present in the copy text, since many
 * real Arabic ads put their real call-to-action as text ("راسلنا"/"احجز
 * الآن") rather than relying solely on Meta's button. `primaryText` is
 * optional -- every existing caller passing only `ctaType` keeps working
 * exactly as before.
 */
function analyzeCta(ctaType, primaryText) {
  const embeddedText = primaryText ? String(primaryText) : '';
  const strongPhrase = containsAny(embeddedText, STRONG_CTA_PHRASES_AR)[0];
  const mediumPhrase = !strongPhrase ? containsAny(embeddedText, MEDIUM_CTA_PHRASES_AR)[0] : null;
  const weakPhrase = !strongPhrase && !mediumPhrase ? containsAny(embeddedText, WEAK_CTA_PHRASES_AR)[0] : null;

  if (!ctaType) {
    if (strongPhrase) return { score: 75, label: 'strong', evidence: `No Meta CTA button set, but the copy itself contains a specific, committing call-to-action: "${strongPhrase}".` };
    if (mediumPhrase) return { score: 55, label: 'moderate', evidence: `No Meta CTA button set; the copy contains a call-to-action ("${mediumPhrase}") without added urgency.` };
    if (weakPhrase) return { score: 35, label: 'weak', evidence: `No Meta CTA button set; the copy's only call-to-action ("${weakPhrase}") is vague/low-commitment.` };
    return { score: 30, label: 'missing', evidence: 'No call-to-action set on this creative.' };
  }
  const type = String(ctaType).toUpperCase();

  if (STRONG_CTA_TYPES.has(type)) {
    return { score: 85, label: 'strong', evidence: `"${type}" is a specific, action-oriented CTA.` };
  }
  if (MESSAGING_CTA_TYPES.has(type)) {
    // A messaging CTA's real strength depends on what happens once the
    // conversation starts -- if the copy itself asks for a specific,
    // committing action ("احجز الآن" inside a WHATSAPP_MESSAGE ad), that's
    // functionally as strong as a dedicated booking button; a vague
    // "راسلنا" with no stated next step is weaker.
    if (strongPhrase) return { score: 80, label: 'strong', evidence: `"${type}" opens a real conversation, and the copy itself asks for a specific action ("${strongPhrase}").` };
    if (weakPhrase && !mediumPhrase) return { score: 55, label: 'moderate', evidence: `"${type}" opens a real conversation, but the copy's own call-to-action ("${weakPhrase}") is vague about what happens next.` };
    return { score: 65, label: 'moderate', evidence: `"${type}" is a real, action-oriented messaging CTA (opens a conversation) -- Meta's own click-to-chat family, common for this account's ads.` };
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
  const hasOffer = OFFER_SIGNAL_REGEX.test(combined) || OFFER_SIGNAL_REGEX_AR.test(combined);
  return {
    score: hasOffer ? 80 : 35,
    label: hasOffer ? 'clear' : 'vague',
    evidence: hasOffer ? 'A concrete offer signal (price, discount, or "free"/"مجاناً") is present.' : 'No concrete offer signal (price/discount/free) detected -- the value proposition may be unclear.',
  };
}

/** Trust & Authority -- real trust-vocabulary presence (English + Arabic). */
function analyzeTrust(combinedText) {
  const hits = containsAny(combinedText, TRUST_ALL);
  const socialHits = containsAny(combinedText, SOCIAL_PROOF_ALL);
  const authorityHits = containsAny(combinedText, AUTHORITY_ALL);
  const guaranteeHits = containsAny(combinedText, GUARANTEE_WORDS_AR);
  const score = Math.min(100, hits.length * 25 + socialHits.length * 25 + authorityHits.length * 15 + guaranteeHits.length * 15);
  return {
    score,
    label: score >= 50 ? 'present' : 'absent',
    evidence: [
      ...hits.map(h => `trust word: "${h}"`),
      ...socialHits.map(h => `social proof: "${h}"`),
      ...authorityHits.map(h => `authority signal: "${h}"`),
      ...guaranteeHits.map(h => `guarantee: "${h}"`),
    ].join('; ') || 'No trust or social-proof language detected.',
    social_proof: socialHits.length > 0,
  };
}

/**
 * Psychology composite -- urgency, scarcity, curiosity, benefit,
 * transformation, problem/solution, authority, guarantee, value, risk
 * reversal, and emotional appeal (English + Arabic). Phase 41 expands this
 * from the original 5 dimensions to cover the full set real marketing-
 * psychology audits check for, using the same "generic vocabulary list,
 * never fabricated" approach as the original 5 -- purely additive, no
 * schema change (this whole object is stored as JSON, not individual DB
 * columns, so new dimension keys never require a migration).
 */
function analyzePsychology(combinedText) {
  const urgency = containsAny(combinedText, URGENCY_ALL);
  const scarcity = containsAny(combinedText, SCARCITY_WORDS_AR);
  const curiosity = containsAny(combinedText, CURIOSITY_ALL);
  const pain = containsAny(combinedText, PAIN_POINT_ALL);
  const benefit = containsAny(combinedText, BENEFIT_ALL);
  const emotion = containsAny(combinedText, EMOTION_ALL);
  const transformation = containsAny(combinedText, TRANSFORMATION_WORDS_AR);
  const problemSolution = containsAny(combinedText, PROBLEM_SOLUTION_WORDS_AR);
  const socialProof = containsAny(combinedText, SOCIAL_PROOF_ALL);
  const authority = containsAny(combinedText, AUTHORITY_ALL);
  const guarantee = containsAny(combinedText, GUARANTEE_WORDS_AR);
  const value = containsAny(combinedText, VALUE_WORDS_AR);
  const riskReversal = containsAny(combinedText, RISK_REVERSAL_WORDS_AR);

  const dimensions = {
    urgency: urgency.length > 0,
    scarcity: scarcity.length > 0,
    curiosity: curiosity.length > 0,
    pain_point: pain.length > 0,
    benefit: benefit.length > 0,
    emotional_appeal: emotion.length > 0,
    transformation: transformation.length > 0,
    problem_solution: problemSolution.length > 0,
    social_proof: socialProof.length > 0,
    authority: authority.length > 0,
    guarantee: guarantee.length > 0,
    value: value.length > 0,
    risk_reversal: riskReversal.length > 0,
  };
  const activeCount = Object.values(dimensions).filter(Boolean).length;
  // Scaled for 13 dimensions (was 5) -- a handful of real signals still
  // reaches a strong score without requiring every single dimension to fire.
  const score = Math.min(100, activeCount * 15);

  const evidenceParts = [
    urgency.length ? `urgency: "${urgency[0]}"` : null,
    scarcity.length ? `scarcity: "${scarcity[0]}"` : null,
    curiosity.length ? `curiosity: "${curiosity[0]}"` : null,
    pain.length ? `pain point: "${pain[0]}"` : null,
    benefit.length ? `benefit: "${benefit[0]}"` : null,
    emotion.length ? `emotional appeal: "${emotion[0]}"` : null,
    transformation.length ? `transformation: "${transformation[0]}"` : null,
    problemSolution.length ? `problem/solution: "${problemSolution[0]}"` : null,
    socialProof.length ? `social proof: "${socialProof[0]}"` : null,
    authority.length ? `authority: "${authority[0]}"` : null,
    guarantee.length ? `guarantee: "${guarantee[0]}"` : null,
    value.length ? `value: "${value[0]}"` : null,
    riskReversal.length ? `risk reversal: "${riskReversal[0]}"` : null,
  ].filter(Boolean);

  return {
    score,
    label: score >= 60 ? 'strong' : score >= 20 ? 'moderate' : 'weak',
    dimensions,
    evidence: evidenceParts.join('; ') || 'No urgency, curiosity, pain-point, benefit, or emotional-appeal language detected.',
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
  const cta = analyzeCta(ctaType, primaryText);
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
  analyzeCreative, normalizeArabic,
  STRONG_CTA_TYPES, WEAK_CTA_TYPES, MESSAGING_CTA_TYPES,
};
