'use strict';

const { diagnoseCampaign } = require('../../src/services/diagnosisEngine');
const { resolveProfile } = require('../../src/services/kpiProfileResolver');

const campaign = { id: 'c1', meta_campaign_id: 'camp_1', name: 'Test Campaign' };

function delta(pct) {
  return { delta_abs: 0, delta_pct: pct };
}

// Rich baseline (well above the 1,000-impression high-confidence floor).
const RICH_CURRENT = { impressions: 50000, clicks: 500 };
const RICH_PRIOR    = { impressions: 50000, clicks: 500 };

describe('diagnosisEngine.diagnoseCampaign — data sufficiency', () => {
  test('returns insufficient_data when prior period is null', () => {
    const profile = resolveProfile('leads');
    const result = diagnoseCampaign(
      { ...campaign, objective: 'leads' }, profile,
      { impressions: 5000, leads: 10 }, null, {}
    );
    expect(result.status).toBe('insufficient_data');
    expect(result.category).toBeNull();
  });

  test('returns insufficient_data when impressions are below the floor in either period', () => {
    const profile = resolveProfile('leads');
    const current = { impressions: 50, leads: 2 };
    const prior    = { impressions: 50, leads: 4 };
    const deltas   = { leads: delta(-50) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, current, prior, deltas);
    expect(result.status).toBe('insufficient_data');
  });

  test('returns insufficient_data when there is no delta for the primary KPI at all', () => {
    const profile = resolveProfile('leads');
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, RICH_CURRENT, RICH_PRIOR, {});
    expect(result.status).toBe('insufficient_data');
  });
});

describe('diagnosisEngine.diagnoseCampaign — improvement is not diagnosed as a problem', () => {
  test('leads objective: leads rising is not flagged', () => {
    const profile = resolveProfile('leads');
    const deltas = { leads: delta(25) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.status).toBe('diagnosed');
    expect(result.category).toBeNull();
  });

  test('sales objective: roas rising is not flagged', () => {
    const profile = resolveProfile('sales');
    const deltas = { roas: delta(15) };
    const result = diagnoseCampaign({ ...campaign, objective: 'sales' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.status).toBe('diagnosed');
    expect(result.category).toBeNull();
  });
});

describe('diagnosisEngine.diagnoseCampaign — volume-based cascade (leads falling)', () => {
  const profile = resolveProfile('leads');

  test('frequency rising alone -> category audience, high confidence', () => {
    const deltas = { leads: delta(-20), frequency: delta(15) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.status).toBe('diagnosed');
    expect(result.category).toBe('audience');
    expect(result.confidence).toBe('high');
    expect(result.factors).toHaveLength(1);
  });

  test('cpm rising alone -> category competition', () => {
    const deltas = { leads: delta(-20), cpm: delta(18) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.category).toBe('competition');
    expect(result.confidence).toBe('high');
  });

  test('spend falling alone -> category budget', () => {
    const deltas = { leads: delta(-20), spend: delta(-12) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.category).toBe('budget');
  });

  test('check order: frequency rising wins over cpm rising when both match', () => {
    const deltas = { leads: delta(-20), frequency: delta(15), cpm: delta(18) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.category).toBe('audience');
    expect(result.factors.length).toBeGreaterThan(1);
    expect(result.confidence).toBe('medium'); // multiple factors matched
  });

  test('no matching factor -> category unexplained, low confidence', () => {
    const deltas = { leads: delta(-20) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.category).toBe('unexplained');
    expect(result.confidence).toBe('low');
  });

  test('thin data (below high-confidence floor but above the insufficient-data floor) caps confidence', () => {
    const thin = { impressions: 500, clicks: 50 };
    const deltas = { leads: delta(-20), frequency: delta(15) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, thin, thin, deltas);
    expect(result.status).toBe('diagnosed');
    expect(result.confidence).not.toBe('high');
  });
});

describe('diagnosisEngine.diagnoseCampaign — ROAS cascade', () => {
  const profile = resolveProfile('sales');

  test('stable purchase count + sharp purchase_value drop -> category tracking', () => {
    const deltas = { roas: delta(-25), purchases: delta(2), purchase_value: delta(-30) };
    const result = diagnoseCampaign({ ...campaign, objective: 'sales' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.category).toBe('tracking');
  });

  test('falls back to the cost-based cascade when no tracking anomaly is present', () => {
    const deltas = { roas: delta(-25), purchases: delta(-25), purchase_value: delta(-25), cpm: delta(20) };
    const result = diagnoseCampaign({ ...campaign, objective: 'sales' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.category).toBe('competition');
  });
});

describe('diagnosisEngine.diagnoseCampaign — rate-based cascade (generic, e.g. ad-level ctr/cpc)', () => {
  const rateProfile = { primaryKPI: { key: 'ctr', label: 'CTR' } };

  test('frequency rising -> category audience', () => {
    const deltas = { ctr: delta(-15), frequency: delta(12) };
    const result = diagnoseCampaign({ ...campaign, objective: 'unknown' }, rateProfile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.category).toBe('audience');
  });

  test('flat frequency + flat spend -> creative fatigue proxy', () => {
    const deltas = { ctr: delta(-15), frequency: delta(1), spend: delta(-1) };
    const result = diagnoseCampaign({ ...campaign, objective: 'unknown' }, rateProfile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.category).toBe('creative');
  });
});

describe('diagnosisEngine.diagnoseCampaign — unclassified headline (unknown objective)', () => {
  test('spend is not a classified metric type -> category unclassified', () => {
    const profile = resolveProfile('unknown');
    const deltas = { spend: delta(-20) };
    const result = diagnoseCampaign({ ...campaign, objective: 'unknown' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.status).toBe('diagnosed');
    expect(result.category).toBe('unclassified');
  });
});

describe('diagnosisEngine.diagnoseCampaign — priority scoring', () => {
  const profile = resolveProfile('leads');

  test('severe magnitude + high confidence -> critical priority', () => {
    const deltas = { leads: delta(-40), frequency: delta(20) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.priority).toBe('critical');
  });

  test('mild magnitude + low confidence -> observation_only priority', () => {
    const deltas = { leads: delta(-11) };
    const result = diagnoseCampaign({ ...campaign, objective: 'leads' }, profile, RICH_CURRENT, RICH_PRIOR, deltas);
    expect(result.confidence).toBe('low');
    expect(result.priority).toBe('observation_only');
  });
});
