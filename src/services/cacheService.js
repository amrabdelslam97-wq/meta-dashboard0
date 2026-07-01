/**
 * Cache Service — Phase 4
 *
 * In-memory TTL cache. Not persisted to disk — purely a performance layer.
 * Protects Meta API rate limits. Cleared on manual Refresh.
 *
 * TTLs (per architecture spec):
 *   current metrics:  10 min
 *   breakdown data:   10 min
 *   prior period:     24 hours  (historical data doesn't change)
 *   metadata:         30 min
 *   trend data:       10 min
 */

const TTLS = {
  current:   10 * 60 * 1000,       // 10 min
  prior:     24 * 60 * 60 * 1000,  // 24 hours
  breakdown: 10 * 60 * 1000,       // 10 min
  trend:     10 * 60 * 1000,       // 10 min
  metadata:  30 * 60 * 1000,       // 30 min
};

// store: Map<key, { value, expiresAt }>
const store = new Map();

// Stats for monitoring
let hits = 0;
let misses = 0;

// ─────────────────────────────────────────────
// Core operations
// ─────────────────────────────────────────────

function set(key, value, ttlType = 'current') {
  const ttl = TTLS[ttlType] || TTLS.current;
  store.set(key, {
    value,
    expiresAt: Date.now() + ttl,
    ttlType,
    setAt: Date.now(),
  });
}

function get(key) {
  const entry = store.get(key);
  if (!entry) { misses++; return null; }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    misses++;
    return null;
  }
  hits++;
  return entry.value;
}

function del(key) {
  store.delete(key);
}

// ─────────────────────────────────────────────
// Invalidation helpers
// ─────────────────────────────────────────────

/** Clear all cache entries for a specific Meta account */
function invalidateAccount(metaAccountId) {
  const prefix = `${metaAccountId}:`;
  let count = 0;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      count++;
    }
  }
  console.log(`[Cache] Invalidated ${count} entries for account ${metaAccountId}`);
  return count;
}

/** Clear all cache entries for a specific campaign */
function invalidateCampaign(metaCampaignId) {
  let count = 0;
  for (const key of store.keys()) {
    if (key.includes(metaCampaignId)) {
      store.delete(key);
      count++;
    }
  }
  return count;
}

/** Clear everything */
function flush() {
  const count = store.size;
  store.clear();
  hits = 0; misses = 0;
  console.log(`[Cache] Flushed all ${count} entries`);
  return count;
}

// ─────────────────────────────────────────────
// Key builders — ensures consistent key format
// ─────────────────────────────────────────────

function keyInsights(metaCampaignId, since, until) {
  return `${metaCampaignId}:insights:${since}:${until}`;
}

function keyPrior(metaCampaignId, since, until) {
  return `${metaCampaignId}:prior:${since}:${until}`;
}

function keyTrend(metaCampaignId, since, until) {
  return `${metaCampaignId}:trend:${since}:${until}`;
}

function keyBreakdown(metaCampaignId, dimension, since, until) {
  return `${metaCampaignId}:breakdown:${dimension}:${since}:${until}`;
}

function keyAdSetInsights(metaAdSetId, since, until) {
  return `${metaAdSetId}:adset:${since}:${until}`;
}

function keyAdInsights(metaAdId, since, until) {
  return `${metaAdId}:ad:${since}:${until}`;
}

// ─────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────

function stats() {
  // Prune expired entries first
  const now = Date.now();
  let expired = 0;
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) { store.delete(key); expired++; }
  }

  return {
    size:    store.size,
    hits,
    misses,
    hit_rate: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) + '%' : 'n/a',
    expired_pruned: expired,
  };
}

// Auto-prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = {
  get, set, del,
  invalidateAccount, invalidateCampaign, flush, stats,
  keyInsights, keyPrior, keyTrend, keyBreakdown,
  keyAdSetInsights, keyAdInsights,
  TTLS,
};
