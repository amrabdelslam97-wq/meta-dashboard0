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
});
