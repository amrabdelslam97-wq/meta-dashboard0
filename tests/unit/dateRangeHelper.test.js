'use strict';

const {
  resolveDateRange, priorPeriod, defaultRange, isInAttributionWindow,
  periodLabel, fmt, daysAgo, yesterday,
} = require('../../src/services/dateRangeHelper');

describe('dateRangeHelper.resolveDateRange', () => {
  test('defaults to last 7 days when no query params given', () => {
    const range = resolveDateRange({});
    expect(range).toEqual(defaultRange());
  });

  test('explicit since/until override any preset', () => {
    const range = resolveDateRange({ since: '2026-01-01', until: '2026-01-15' });
    expect(range).toEqual({ since: '2026-01-01', until: '2026-01-15' });
  });

  test('preset "today" resolves to a single-day range', () => {
    const range = resolveDateRange({ preset: 'today' });
    expect(range.since).toBe(range.until);
  });

  test('preset "last_30_days" spans 30 days back from yesterday', () => {
    const range = resolveDateRange({ preset: 'last_30_days' });
    expect(range.since).toBe(daysAgo(30));
    expect(range.until).toBe(yesterday());
  });

  test('preset "last_3_days" (dashboard\'s "3D" button) spans 3 days back from yesterday, distinct from the 7-day default', () => {
    const range = resolveDateRange({ preset: 'last_3_days' });
    expect(range.since).toBe(daysAgo(3));
    expect(range.until).toBe(yesterday());
    expect(range).not.toEqual(defaultRange());
  });

  test('preset "last_90_days" (dashboard\'s "90D" button) spans 90 days back from yesterday, distinct from the 7-day default', () => {
    const range = resolveDateRange({ preset: 'last_90_days' });
    expect(range.since).toBe(daysAgo(90));
    expect(range.until).toBe(yesterday());
    expect(range).not.toEqual(defaultRange());
  });

  test('preset "lifetime" spans from a fixed far-past date to yesterday, distinct from the 7-day default', () => {
    const range = resolveDateRange({ preset: 'lifetime' });
    expect(range.since).toBe('2000-01-01');
    expect(range.until).toBe(yesterday());
    expect(range).not.toEqual(defaultRange());
  });

  test('unknown preset falls back to default range', () => {
    const range = resolveDateRange({ preset: 'not_a_real_preset' });
    expect(range).toEqual(defaultRange());
  });

  test('preset "custom" with since/until uses those exact dates', () => {
    const range = resolveDateRange({ preset: 'custom', since: '2026-02-01', until: '2026-02-05' });
    expect(range).toEqual({ since: '2026-02-01', until: '2026-02-05' });
  });
});

describe('dateRangeHelper.priorPeriod', () => {
  test('computes the immediately-preceding period of the same length', () => {
    const prior = priorPeriod('2026-06-08', '2026-06-14'); // 7-day range
    expect(prior).toEqual({ since: '2026-06-01', until: '2026-06-07', days: 7 });
  });

  test('handles a single-day range', () => {
    const prior = priorPeriod('2026-06-14', '2026-06-14');
    expect(prior).toEqual({ since: '2026-06-13', until: '2026-06-13', days: 1 });
  });
});

describe('dateRangeHelper.isInAttributionWindow', () => {
  // Regression test for the since/until bug: the function must check the
  // END of the range (`until`), not the start (`since`) -- a long range
  // whose `since` is far in the past but whose `until` is recent must
  // still be flagged as within the attribution window.
  test('flags a range whose `until` is very recent, even if `since` is old', () => {
    const recentUntil = fmt(new Date()); // today
    expect(isInAttributionWindow(recentUntil, 7)).toBe(true);
  });

  test('does not flag a range whose `until` is well outside the window', () => {
    const oldUntil = daysAgo(30);
    expect(isInAttributionWindow(oldUntil, 7)).toBe(false);
  });

  test('respects a custom attribution window size', () => {
    const until = daysAgo(10);
    expect(isInAttributionWindow(until, 7)).toBe(false);
    expect(isInAttributionWindow(until, 14)).toBe(true);
  });
});

describe('dateRangeHelper.periodLabel', () => {
  test('formats a human-readable day count and range', () => {
    expect(periodLabel('2026-06-08', '2026-06-14')).toBe('7 days: 2026-06-08 → 2026-06-14');
  });

  test('uses singular "day" for a 1-day range', () => {
    expect(periodLabel('2026-06-14', '2026-06-14')).toBe('1 day: 2026-06-14 → 2026-06-14');
  });
});
