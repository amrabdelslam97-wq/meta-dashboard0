'use strict';

const cta = require('../../src/services/creativeTextAnalysis');

describe('creativeTextAnalysis', () => {
  describe('analyzeHook', () => {
    test('scores a question + direct address + curiosity opening as strong', () => {
      const result = cta.analyzeHook('Why do most people struggle to lose weight? Here\'s why it\'s not your fault.');
      expect(result.score).toBeGreaterThanOrEqual(60);
      expect(result.label).toBe('strong');
    });
    test('scores plain, signal-free text as weak', () => {
      const result = cta.analyzeHook('We sell furniture in various styles and colors for your home.');
      expect(result.score).toBeLessThan(30);
    });
    test('returns 0/missing for no primary text', () => {
      expect(cta.analyzeHook(null).score).toBe(0);
      expect(cta.analyzeHook(null).label).toBe('missing');
    });
  });

  describe('analyzeHeadline', () => {
    test('rewards ideal length (3-8 words) with an offer signal', () => {
      const result = cta.analyzeHeadline('Get 50% Off Today');
      expect(result.score).toBeGreaterThan(50);
    });
    test('penalizes excessive capitalization', () => {
      const result = cta.analyzeHeadline('BUY NOW BEFORE ITS GONE FOREVER');
      expect(result.evidence).toMatch(/capitalization/);
    });
    test('penalizes an overly long headline', () => {
      const long = cta.analyzeHeadline('This Is A Really Really Long Headline That Goes On And On Without Stopping');
      const short = cta.analyzeHeadline('Shop The Sale');
      expect(long.score).toBeLessThan(short.score);
    });
    test('missing headline scores 0', () => {
      expect(cta.analyzeHeadline('').score).toBe(0);
      expect(cta.analyzeHeadline(null).label).toBe('missing');
    });
  });

  describe('analyzeCopy', () => {
    test('classifies length into short/medium/long buckets correctly', () => {
      const short = cta.analyzeCopy('Great deal today only.');
      expect(short.length_category).toBe('short');
      const words60 = new Array(61).fill('word').join(' ') + '.';
      const long = cta.analyzeCopy(words60);
      expect(long.length_category).toBe('long');
    });
    test('long copy scores lower than short copy, all else equal', () => {
      const short = cta.analyzeCopy('Short and simple message here.');
      const long = cta.analyzeCopy(new Array(80).fill('word').join(' ') + '.');
      expect(long.score).toBeLessThan(short.score);
    });
    test('missing copy returns 0/missing/none', () => {
      const result = cta.analyzeCopy(null);
      expect(result.score).toBe(0);
      expect(result.length_category).toBe('none');
    });
  });

  describe('analyzeCta', () => {
    test('classifies real Meta strong CTA types correctly', () => {
      expect(cta.analyzeCta('SHOP_NOW').label).toBe('strong');
      expect(cta.analyzeCta('shop_now').label).toBe('strong'); // case-insensitive
      expect(cta.analyzeCta('SIGN_UP').score).toBeGreaterThanOrEqual(80);
    });
    test('classifies real Meta weak/generic CTA types correctly', () => {
      expect(cta.analyzeCta('LEARN_MORE').label).toBe('weak');
      expect(cta.analyzeCta('CONTACT_US').label).toBe('weak');
    });
    test('missing CTA is flagged, not silently ignored', () => {
      expect(cta.analyzeCta(null).label).toBe('missing');
    });
    test('an unrecognized CTA type is neither fabricated strong nor weak', () => {
      const result = cta.analyzeCta('SOME_FUTURE_META_CTA_TYPE');
      expect(result.label).toBe('moderate');
    });
  });

  describe('analyzeOffer', () => {
    test('detects a concrete offer signal (%, $, free)', () => {
      expect(cta.analyzeOffer('Save 20% this week', null, null).label).toBe('clear');
      expect(cta.analyzeOffer('Get it for free', null, null).label).toBe('clear');
      expect(cta.analyzeOffer('$49 only', null, null).label).toBe('clear');
    });
    test('flags vague copy with no offer signal', () => {
      expect(cta.analyzeOffer('We make great products for everyone', null, null).label).toBe('vague');
    });
  });

  describe('analyzeTrust', () => {
    test('detects trust and social-proof vocabulary with evidence', () => {
      const result = cta.analyzeTrust('Certified and trusted by 10,000 customers with 5 star reviews');
      expect(result.label).toBe('present');
      expect(result.social_proof).toBe(true);
    });
    test('absent when no trust language exists', () => {
      const result = cta.analyzeTrust('Buy our shoes today');
      expect(result.label).toBe('absent');
    });
  });

  describe('analyzePsychology', () => {
    test('identifies multiple active psychological dimensions', () => {
      const result = cta.analyzePsychology('Tired of slow results? Discover the secret today before it\'s gone. You will love it!');
      expect(result.dimensions.pain_point).toBe(true);
      expect(result.dimensions.curiosity).toBe(true);
      expect(result.dimensions.urgency).toBe(true);
      expect(result.score).toBeGreaterThan(40);
    });
    test('plain text triggers no dimensions', () => {
      const result = cta.analyzePsychology('This is a product description.');
      expect(Object.values(result.dimensions).every(v => v === false)).toBe(true);
      expect(result.score).toBe(0);
    });
  });

  describe('analyzeMobileFriendliness', () => {
    test('short combined text scores well, long text scores poorly', () => {
      const good = cta.analyzeMobileFriendliness('Short text.', 'Headline');
      const bad = cta.analyzeMobileFriendliness(new Array(100).fill('word').join(' '), 'A Very Long Headline Indeed');
      expect(good.score).toBeGreaterThan(bad.score);
    });
  });

  describe('analyzeVisualMetadata (metadata-basis, never claims pixel analysis)', () => {
    test('rewards video creatives with a short, feed-appropriate length and recommended aspect ratio', () => {
      const result = cta.analyzeVisualMetadata({ mediaType: 'video', aspectRatio: '9:16', videoLengthSec: 12 });
      expect(result.score).toBeGreaterThan(60);
      expect(result.basis).toBe('metadata');
    });
    test('penalizes a non-recommended aspect ratio and a very long video', () => {
      const result = cta.analyzeVisualMetadata({ mediaType: 'video', aspectRatio: '21:9', videoLengthSec: 120 });
      expect(result.evidence).toMatch(/not one of Meta's recommended/);
      expect(result.evidence).toMatch(/long for feed/);
    });
    test('every returned object is explicitly marked basis:"metadata", never implying pixel analysis', () => {
      const result = cta.analyzeVisualMetadata({ mediaType: 'image', aspectRatio: '1:1' });
      expect(result.basis).toBe('metadata');
    });
  });

  describe('analyzeCreative (full suite)', () => {
    test('runs every dimension and honestly reports unavailable pixel-based dimensions rather than fabricating them', () => {
      const result = cta.analyzeCreative({
        headline: 'Shop The Sale Now',
        primary_text: 'Tired of overpaying? Save 30% today only. Trusted by 5,000 happy customers.',
        description: 'Free shipping on all orders.',
        cta_type: 'SHOP_NOW',
        media_type: 'image',
        aspect_ratio: '4:5',
      });

      expect(result.hook).toBeDefined();
      expect(result.headline).toBeDefined();
      expect(result.copy).toBeDefined();
      expect(result.cta.label).toBe('strong');
      expect(result.offer.label).toBe('clear');
      expect(result.trust.label).toBe('present');
      expect(result.psychology.dimensions.urgency).toBe(true);
      expect(result.visual.basis).toBe('metadata');
      expect(result.brand_consistency.label).toBe('not_available');
      expect(result.not_analyzed.some(d => d.dimension === 'color_psychology')).toBe(true);
    });

    test('handles a creative with no text content at all without throwing', () => {
      expect(() => cta.analyzeCreative({})).not.toThrow();
      const result = cta.analyzeCreative({});
      expect(result.hook.label).toBe('missing');
      expect(result.headline.label).toBe('missing');
    });
  });

  // Phase 41 — Arabic NLP. Real production creatives are overwhelmingly
  // Arabic-language (confirmed via Phase 40/41 runtime audit against real
  // ad accounts); before this phase every one of them scored 0/absent on
  // trust and psychology and "no hook signals detected" regardless of
  // actual content. These lock in representative Arabic phrases from each
  // category so a future refactor can't silently regress back to that.
  describe('Arabic detection (Phase 41)', () => {
    test('analyzeHook detects an Arabic question, emoji-led opening, and curiosity trigger', () => {
      const result = cta.analyzeHook('🎉 مستمرين بدعمكم .. آراء عملائنا بعد تجربة منتجاتنا!');
      expect(result.detected.some(d => d.key === 'emoji')).toBe(true);
      expect(result.score).toBeGreaterThan(0);

      const question = cta.analyzeHook('ليه بنعمل حجامة؟');
      expect(question.detected.some(d => d.key === 'question')).toBe(true);
      expect(question.detected.some(d => d.key === 'hook_trigger')).toBe(true);
    });

    test('analyzeTrust detects real Arabic trust and social-proof vocabulary', () => {
      const result = cta.analyzeTrust('منتجاتنا مضمونة 100% وموثقة، وهذا رأي آراء عملائنا بعد التجربة');
      expect(result.label).toBe('present');
      expect(result.social_proof).toBe(true);
    });

    test('analyzeTrust stays absent for ordinary Arabic copy with no trust language', () => {
      const result = cta.analyzeTrust('عندنا بيتزا ايطالي وكريبات وحواوشي في مكان واحد');
      expect(result.label).toBe('absent');
    });

    test('analyzeOffer detects Arabic offer signals (خصم/مجاناً/عرض)', () => {
      expect(cta.analyzeOffer('خصم 20% على كل المنتجات', null, null).label).toBe('clear');
      expect(cta.analyzeOffer('احصل على استشارة مجاناً اليوم', null, null).label).toBe('clear');
    });

    test('analyzePsychology detects urgency, curiosity, and pain-point in Arabic', () => {
      const result = cta.analyzePsychology('لا تفوتوا الفرصة! ليه طفلك تعاني من التعب؟ فوائد كتير هتستفيد منها');
      expect(result.dimensions.urgency).toBe(true);
      expect(result.dimensions.curiosity).toBe(true);
      expect(result.dimensions.pain_point).toBe(true);
      expect(result.dimensions.benefit).toBe(true);
      expect(result.score).toBeGreaterThan(40);
    });

    test('analyzePsychology detects scarcity, authority, and guarantee -- dimensions the pre-Phase-41 system never had', () => {
      const result = cta.analyzePsychology('الأماكن محدودة، مع دكتور متخصص، وضمان استرجاع الأموال');
      expect(result.dimensions.scarcity).toBe(true);
      expect(result.dimensions.authority).toBe(true);
      expect(result.dimensions.guarantee).toBe(true);
    });

    test('analyzeCta differentiates embedded Arabic CTA phrase strength (Phase 6)', () => {
      const weak = cta.analyzeCta(null, 'للاستفسار راسلنا');
      const medium = cta.analyzeCta(null, 'احجز موعدك');
      const strong = cta.analyzeCta(null, 'اطلب الآن قبل نفاد الكمية');
      expect(weak.score).toBeLessThan(medium.score);
      expect(medium.score).toBeLessThan(strong.score);
    });

    test('analyzeCta classifies Meta messaging CTA types (WhatsApp/Messenger) as real, action-oriented CTAs, not generic/unclassified', () => {
      const whatsapp = cta.analyzeCta('WHATSAPP_MESSAGE');
      expect(whatsapp.label).not.toBe('missing');
      expect(whatsapp.score).toBeGreaterThanOrEqual(60);

      const withStrongCopy = cta.analyzeCta('WHATSAPP_MESSAGE', 'اطلب الآن عبر واتساب');
      expect(withStrongCopy.label).toBe('strong');
    });

    test('spelling variants (diacritics, alef/teh-marbuta forms) still match via normalization', () => {
      // "مجاناً" (with tanween diacritic) vs "مجانا" (plain) -- same word, real
      // casual-Arabic spelling variance that must not defeat matching.
      expect(cta.analyzeOffer('احصل عليه مجاناً', null, null).label).toBe('clear');
      expect(cta.analyzeOffer('احصل عليه مجانا', null, null).label).toBe('clear');
    });

    test('a real Arabic creative with genuine signals scores meaningfully higher than the pre-Phase-41 near-zero baseline', () => {
      const result = cta.analyzeCreative({
        headline: null,
        primary_text: '🎉 مستمرين بدعمكم .. آراء عملائنا بعد تجربة منتجاتنا! 🎉\nأفضل المنتجات الطبيعية 100% ومضمونة. لا تفوتوا الفرصة!',
        description: null,
        cta_type: 'WHATSAPP_MESSAGE',
      });
      expect(result.trust.label).toBe('present');
      expect(result.psychology.score).toBeGreaterThan(0);
      expect(result.hook.score).toBeGreaterThan(0);
    });
  });

  // Phase 43 (Task 3) — Hook upgrade: emoji alone must never be treated as a
  // real hook; a genuine persuasion signal (question/curiosity/pain-point/
  // etc.) must always outscore an emoji-only opening of similar length.
  describe('analyzeHook (Phase 43 — emoji de-weighting + new signal coverage)', () => {
    test('an emoji-only opening with no other real signal scores weak, not strong', () => {
      const emojiOnly = cta.analyzeHook('🎉🔥 great products for your home and office needs today');
      expect(emojiOnly.label).not.toBe('strong');
    });

    test('a real persuasion signal (question) outscores an emoji-only opening of the same length', () => {
      const emojiOnly = cta.analyzeHook('🎉 great products for your home and office needs');
      const question = cta.analyzeHook('Why do great products cost so much for your home and office?');
      expect(question.score).toBeGreaterThan(emojiOnly.score);
    });

    test('detects open loop, shock, novelty, pattern interrupt, and specificity signals', () => {
      expect(cta.analyzeHook('Keep reading to find out what happened next.').detected.some(d => d.key === 'open_loop')).toBe(true);
      expect(cta.analyzeHook('You won\'t believe what happened to us this week.').detected.some(d => d.key === 'shock')).toBe(true);
      expect(cta.analyzeHook('This is brand new and just launched today.').detected.some(d => d.key === 'novelty')).toBe(true);
      expect(cta.analyzeHook('Wait for it before you scroll away from this post.').detected.some(d => d.key === 'pattern_interrupt')).toBe(true);
      expect(cta.analyzeHook('Save 3% on your first 2 orders this week.').detected.some(d => d.key === 'statistic')).toBe(true);
    });

    test('missing entries explain absence for every new signal category on plain text', () => {
      const result = cta.analyzeHook('We sell furniture in various styles and colors for your home.');
      const missingKeys = result.missing.map(m => m.key);
      for (const key of ['open_loop', 'statistic', 'specificity', 'shock', 'novelty', 'pattern_interrupt', 'authority', 'transformation']) {
        expect(missingKeys).toContain(key);
      }
    });
  });

  // Phase 43 (Task 4) — Psychology upgrade: new dimensions, each explaining
  // why it fired (or why it's absent), without disturbing any pre-existing
  // dimension.
  describe('analyzePsychology (Phase 43 — expanded dimension coverage)', () => {
    test('detects fear, loss aversion, identity, belonging, exclusivity, status, future pacing, reciprocity, and commitment', () => {
      const result = cta.analyzePsychology(
        'Don\'t let this happen to you. Don\'t miss out on this. For people who want more, join our community. ' +
        'This is members only. Be the first to try it. Imagine yourself a month from now with a free gift on us. Book your spot now.'
      );
      expect(result.dimensions.fear).toBe(true);
      expect(result.dimensions.loss_aversion).toBe(true);
      expect(result.dimensions.identity).toBe(true);
      expect(result.dimensions.belonging).toBe(true);
      expect(result.dimensions.exclusivity).toBe(true);
      expect(result.dimensions.status).toBe(true);
      expect(result.dimensions.future_pacing).toBe(true);
      expect(result.dimensions.reciprocity).toBe(true);
      expect(result.dimensions.commitment).toBe(true);
    });

    test('every dimension has a details entry explaining why it was detected or why it is missing', () => {
      const result = cta.analyzePsychology('Tired of slow results? Discover the secret today before it\'s gone. You will love it!');
      expect(Array.isArray(result.details)).toBe(true);
      expect(result.details.length).toBeGreaterThan(20);
      for (const d of result.details) {
        expect(typeof d.evidence).toBe('string');
        expect(d.evidence.length).toBeGreaterThan(0);
      }
      const painDetail = result.details.find(d => d.dimension === 'pain_point');
      expect(painDetail.detected).toBe(true);
      const scarcityDetail = result.details.find(d => d.dimension === 'scarcity');
      expect(scarcityDetail.detected).toBe(false);
      expect(scarcityDetail.evidence).toMatch(/no scarcity/i);
    });

    test('new dimensions never false-positive on plain, signal-free text', () => {
      const result = cta.analyzePsychology('This is a product description.');
      expect(Object.values(result.dimensions).every(v => v === false)).toBe(true);
      expect(result.score).toBe(0);
    });
  });
});
