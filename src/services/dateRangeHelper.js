/**
 * Date Range Helper — Phase 4
 *
 * Single source of truth for all date range logic.
 * Used by metricsFetcher, breakdownsFetcher, and insights route.
 */

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function today() {
  return fmt(new Date());
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return fmt(d);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return fmt(d);
}

function startOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function startOfLastMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function endOfLastMonth() {
  const d = new Date();
  d.setDate(0); // last day of previous month
  return fmt(d);
}

// ─────────────────────────────────────────────
// Resolve date range from query params or preset
// ─────────────────────────────────────────────
function resolveDateRange(query = {}) {
  const { preset, since, until } = query;

  if (preset) {
    const presets = {
      today:       { since: today(),          until: today()          },
      yesterday:   { since: yesterday(),       until: yesterday()       },
      last_7_days: { since: daysAgo(7),        until: yesterday()       },
      last_7:      { since: daysAgo(7),        until: yesterday()       },
      last_14:     { since: daysAgo(14),       until: yesterday()       },
      last_30_days:{ since: daysAgo(30),       until: yesterday()       },
      last_30:     { since: daysAgo(30),       until: yesterday()       },
      this_month:  { since: startOfMonth(),    until: yesterday()       },
      last_month:  { since: startOfLastMonth(),until: endOfLastMonth()  },
      custom:      since && until ? { since, until } : defaultRange(),
    };
    if (presets[preset]) return presets[preset];
  }

  if (since && until) return { since, until };

  return defaultRange();
}

function defaultRange() {
  return { since: daysAgo(7), until: yesterday() };
}

// ─────────────────────────────────────────────
// Calculate prior equivalent period
// ─────────────────────────────────────────────
function priorPeriod(since, until) {
  const s = new Date(since);
  const u = new Date(until);
  const days = Math.round((u - s) / (1000 * 60 * 60 * 24)) + 1;

  const priorUntil = new Date(s);
  priorUntil.setDate(priorUntil.getDate() - 1);

  const priorSince = new Date(priorUntil);
  priorSince.setDate(priorSince.getDate() - days + 1);

  return { since: fmt(priorSince), until: fmt(priorUntil), days };
}

// ─────────────────────────────────────────────
// Attribution window check
//
// Checks the END of the requested range (`until`), not the start. Meta
// aggregates every day in a range into one blended metric row, so what
// matters for "is this data still settling" is how recent the most recent
// day in the range is -- checking `since` instead meant a short recent
// range (e.g. last_7_days) correctly warned, but a longer range (e.g.
// last_30_days, whose `since` is far in the past even though its `until`
// is still yesterday) incorrectly never warned, despite its tail end being
// exactly as fresh/unsettled as the short range's.
// ─────────────────────────────────────────────
function isInAttributionWindow(until, attributionWindowDays = 7) {
  const untilDate = new Date(until);
  const now = new Date();
  const daysDiff = Math.round((now - untilDate) / (1000 * 60 * 60 * 24));
  return daysDiff <= attributionWindowDays;
}

// ─────────────────────────────────────────────
// Period label for display
// ─────────────────────────────────────────────
function periodLabel(since, until) {
  const s = new Date(since);
  const u = new Date(until);
  const days = Math.round((u - s) / (1000 * 60 * 60 * 24)) + 1;
  return `${days} day${days !== 1 ? 's' : ''}: ${since} → ${until}`;
}

module.exports = {
  resolveDateRange,
  priorPeriod,
  defaultRange,
  isInAttributionWindow,
  periodLabel,
  fmt,
  today,
  yesterday,
  daysAgo,
};
