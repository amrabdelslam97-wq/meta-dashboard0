/**
 * Objective KPI Map — Phase 6C
 * PRESENTATION LAYER ONLY. No DB reads. No side effects.
 *
 * Single source of truth for:
 *   - which metric is "primary" per objective
 *   - display labels per metric key
 *   - display order per objective
 *   - aggregation rules (for portfolio engine)
 *   - value formatting
 */

// ─────────────────────────────────────────────
// Full KPI definition per objective
// ─────────────────────────────────────────────
const KPI_MAP = {
  messaging: {
    primaryKPI:     { key: 'results',  label: 'Conversations' },
    primaryCostKPI: { key: 'cpr',      label: 'Cost Per Conversation' },
    displayMetrics: ['results', 'cpr', 'ctr', 'cpm', 'frequency', 'reach', 'spend', 'impressions', 'clicks'],
    trendMetrics:   ['results', 'cpr', 'ctr'],
    scoringMetrics: ['cpr', 'ctr', 'frequency', 'reach'],
    aggregation: {
      results:     'sum',
      cpr:         'spend/results',
      ctr:         'spend_weighted_avg',
      cpm:         'spend_weighted_avg',
      frequency:   'spend_weighted_avg',
      reach:       'sum',
      spend:       'sum',
      impressions: 'sum',
      clicks:      'sum',
    },
  },

  leads: {
    primaryKPI:     { key: 'leads',  label: 'Leads' },
    primaryCostKPI: { key: 'cpl',    label: 'Cost Per Lead' },
    displayMetrics: ['leads', 'cpl', 'ctr', 'cpm', 'frequency', 'reach', 'spend', 'impressions', 'clicks'],
    trendMetrics:   ['leads', 'cpl', 'ctr'],
    scoringMetrics: ['cpl', 'leads', 'ctr', 'frequency'],
    aggregation: {
      leads:       'sum',
      cpl:         'spend/leads',
      ctr:         'spend_weighted_avg',
      cpm:         'spend_weighted_avg',
      frequency:   'spend_weighted_avg',
      reach:       'sum',
      spend:       'sum',
      impressions: 'sum',
      clicks:      'sum',
    },
  },

  sales: {
    primaryKPI:     { key: 'roas',      label: 'ROAS' },
    primaryCostKPI: { key: 'cpa',       label: 'Cost Per Purchase' },
    displayMetrics: ['roas', 'purchases', 'purchase_value', 'cpa', 'ctr', 'cpm', 'frequency', 'spend'],
    trendMetrics:   ['roas', 'cpa', 'purchases'],
    scoringMetrics: ['roas', 'cpa', 'purchases', 'ctr'],
    aggregation: {
      roas:           'revenue/spend',
      purchases:      'sum',
      purchase_value: 'sum',
      cpa:            'spend/purchases',
      ctr:            'spend_weighted_avg',
      cpm:            'spend_weighted_avg',
      frequency:      'spend_weighted_avg',
      spend:          'sum',
    },
  },

  traffic: {
    primaryKPI:     { key: 'landing_page_views',      label: 'Landing Page Views' },
    primaryCostKPI: { key: 'cost_per_landing_page_view', label: 'Cost Per LPV' },
    displayMetrics: ['landing_page_views', 'cost_per_landing_page_view', 'link_clicks', 'ctr', 'cpc', 'cpm', 'frequency', 'spend'],
    trendMetrics:   ['landing_page_views', 'cost_per_landing_page_view', 'ctr'],
    scoringMetrics: ['cpc', 'ctr', 'landing_page_views', 'frequency'],
    aggregation: {
      landing_page_views:         'sum',
      cost_per_landing_page_view: 'spend/landing_page_views',
      link_clicks:                'sum',
      ctr:                        'spend_weighted_avg',
      cpc:                        'spend_weighted_avg',
      cpm:                        'spend_weighted_avg',
      frequency:                  'spend_weighted_avg',
      spend:                      'sum',
    },
  },

  awareness: {
    primaryKPI:     { key: 'reach',  label: 'Reach' },
    primaryCostKPI: { key: 'cpm',    label: 'CPM' },
    displayMetrics: ['reach', 'impressions', 'cpm', 'frequency', 'ctr', 'spend'],
    trendMetrics:   ['reach', 'cpm', 'frequency'],
    scoringMetrics: ['reach', 'cpm', 'frequency', 'impressions'],
    aggregation: {
      reach:       'sum',
      impressions: 'sum',
      cpm:         'spend/impressions*1000',
      frequency:   'spend_weighted_avg',
      ctr:         'spend_weighted_avg',
      spend:       'sum',
    },
  },

  unknown: {
    primaryKPI:     { key: 'spend',  label: 'Spend' },
    primaryCostKPI: { key: 'cpm',    label: 'CPM' },
    displayMetrics: ['spend', 'ctr', 'cpm', 'frequency', 'reach', 'impressions'],
    trendMetrics:   ['spend', 'ctr', 'cpm'],
    scoringMetrics: ['ctr', 'cpm', 'frequency'],
    aggregation: {
      spend:       'sum',
      ctr:         'spend_weighted_avg',
      cpm:         'spend_weighted_avg',
      frequency:   'spend_weighted_avg',
      reach:       'sum',
      impressions: 'sum',
    },
  },
};

// ─────────────────────────────────────────────
// Human-readable labels for every metric key
// ─────────────────────────────────────────────
const METRIC_LABELS = {
  results:                     'Conversations',
  cpr:                         'Cost Per Conversation',
  leads:                       'Leads',
  cpl:                         'Cost Per Lead',
  roas:                        'ROAS',
  purchases:                   'Purchases',
  purchase_value:              'Purchase Value',
  cpa:                         'Cost Per Purchase',
  landing_page_views:          'Landing Page Views',
  cost_per_landing_page_view:  'Cost Per LPV',
  link_clicks:                 'Link Clicks',
  ctr:                         'CTR',
  cpm:                         'CPM',
  cpc:                         'CPC',
  frequency:                   'Frequency',
  reach:                       'Reach',
  impressions:                 'Impressions',
  spend:                       'Spend',
  clicks:                      'Clicks',
  landing_page_view_rate:      'LPV Rate',
};

// ─────────────────────────────────────────────
// Exported functions
// ─────────────────────────────────────────────

function getKPIMap(objective) {
  return KPI_MAP[objective] || KPI_MAP.unknown;
}

function getPrimaryKPI(objective) {
  const map = getKPIMap(objective);
  return {
    key:       map.primaryKPI.key,
    label:     map.primaryKPI.label,
    costKey:   map.primaryCostKPI.key,
    costLabel: map.primaryCostKPI.label,
  };
}

function getDisplayMetrics(objective) {
  return getKPIMap(objective).displayMetrics;
}

function getTrendMetrics(objective) {
  return getKPIMap(objective).trendMetrics;
}

function getAggregationRule(objective, metricKey) {
  const map = getKPIMap(objective);
  return map.aggregation[metricKey] || 'sum';
}

function formatMetricLabel(metricKey) {
  return METRIC_LABELS[metricKey] || metricKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatMetricValue(metricKey, value, currency = '') {
  if (value === null || value === undefined) return '—';
  const v = parseFloat(value);
  if (isNaN(v)) return '—';

  switch (metricKey) {
    case 'ctr':                       return `${v.toFixed(2)}%`;
    case 'frequency':                 return v.toFixed(2);
    case 'roas':                      return `${v.toFixed(2)}x`;
    case 'cpr': case 'cpl': case 'cpa': case 'cpm': case 'cpc':
    case 'cost_per_landing_page_view':
      return currency ? `${v.toFixed(2)} ${currency}` : v.toFixed(2);
    case 'spend': case 'purchase_value':
      return currency
        ? `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
        : v.toFixed(2);
    case 'reach': case 'impressions': case 'results': case 'leads':
    case 'purchases': case 'landing_page_views': case 'link_clicks': case 'clicks':
      return v.toLocaleString('en-US');
    default:
      return v.toFixed(2);
  }
}

module.exports = {
  getKPIMap,
  getPrimaryKPI,
  getDisplayMetrics,
  getTrendMetrics,
  getAggregationRule,
  formatMetricLabel,
  formatMetricValue,
  METRIC_LABELS,
  KPI_MAP,
};
