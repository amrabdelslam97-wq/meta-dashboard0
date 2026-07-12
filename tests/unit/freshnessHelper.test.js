'use strict';

const { buildFreshness, buildPortfolioFreshness, DEFAULT_STALE_THRESHOLD_MINUTES } = require('../../src/services/freshnessHelper');

function minutesAgo(m) {
  return new Date(Date.now() - m * 60000).toISOString();
}

describe('freshnessHelper.buildFreshness', () => {
  test('reports fresh (stale=false) when last sync is well within the threshold', () => {
    const f = buildFreshness({ last_successful_sync_at: minutesAgo(5) });
    expect(f.stale).toBe(false);
    expect(f.sync_age_minutes).toBeGreaterThanOrEqual(4);
    expect(f.sync_age_minutes).toBeLessThanOrEqual(6);
    expect(f.data_source).toBe('sqlite');
  });

  test('reports stale=true when last sync is older than the threshold', () => {
    const f = buildFreshness({ last_successful_sync_at: minutesAgo(DEFAULT_STALE_THRESHOLD_MINUTES + 30) });
    expect(f.stale).toBe(true);
  });

  test('falls back to last_sync_completed_at when last_successful_sync_at is null', () => {
    const f = buildFreshness({ last_successful_sync_at: null, last_sync_completed_at: minutesAgo(10) });
    expect(f.last_sync_at).not.toBeNull();
    expect(f.stale).toBe(false);
  });

  test('never synced (both columns null) is always stale with a null age', () => {
    const f = buildFreshness({ last_successful_sync_at: null, last_sync_completed_at: null });
    expect(f.sync_age_minutes).toBeNull();
    expect(f.stale).toBe(true);
  });
});

describe('freshnessHelper.buildPortfolioFreshness', () => {
  test('uses the OLDEST sync among accounts, not the newest', () => {
    const f = buildPortfolioFreshness([
      { last_successful_sync_at: minutesAgo(5) },
      { last_successful_sync_at: minutesAgo(200) },
    ]);
    expect(f.sync_age_minutes).toBeGreaterThanOrEqual(199);
    expect(f.stale).toBe(true);
  });

  test('empty account list is stale with a null age', () => {
    const f = buildPortfolioFreshness([]);
    expect(f.sync_age_minutes).toBeNull();
    expect(f.stale).toBe(true);
  });
});
