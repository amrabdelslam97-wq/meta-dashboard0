'use strict';

const { buildGovernanceTrace } = require('../../src/services/mmsOrchestrator');

describe('mmsOrchestrator.buildGovernanceTrace', () => {
  test('a minimal call always includes MF1 and MF2 (campaign-level analysis)', () => {
    const gov = buildGovernanceTrace({
      campaign: { objective: 'leads' },
      currentMetrics: { impressions: 5000 },
    });
    const codes = gov.frameworks.map(f => f.code);
    expect(codes).toContain('MF1');
    expect(codes).toContain('MF2');
    expect(codes).not.toContain('MF9');
  });

  test('a fired HIGH_FREQUENCY recommendation pulls in MF5 (Audience) and carries its documented provenance', () => {
    const gov = buildGovernanceTrace({
      campaign: { objective: 'leads' },
      currentMetrics: { impressions: 5000 },
      intelligence: { recommendations: [{ rule_code: 'HIGH_FREQUENCY' }], alerts: [] },
    });
    expect(gov.frameworks.map(f => f.code)).toContain('MF5');
    const provEntry = gov.recommendation_provenance.find(p => p.rule_code === 'HIGH_FREQUENCY');
    expect(provEntry.provenance.framework).toBe('MF2');
  });

  test('a diagnosis with category "creative" pulls in MF4 and normalizes into root_cause_category', () => {
    const gov = buildGovernanceTrace({
      campaign: { objective: 'engagement' },
      currentMetrics: { impressions: 5000 },
      diagnosis: { status: 'diagnosed', category: 'creative' },
    });
    expect(gov.frameworks.map(f => f.code)).toContain('MF4');
    expect(gov.root_cause_category).toBe('creative');
  });

  test('no diagnosis means no root_cause_category and MF8 is not forced in', () => {
    const gov = buildGovernanceTrace({
      campaign: { objective: 'sales' },
      currentMetrics: { impressions: 5000 },
    });
    expect(gov.root_cause_category).toBeNull();
    expect(gov.frameworks.map(f => f.code)).not.toContain('MF8');
  });

  test('a CPM_SPIKE alert pulls in MF6 (Delivery)', () => {
    const gov = buildGovernanceTrace({
      campaign: { objective: 'awareness' },
      currentMetrics: { impressions: 5000 },
      intelligence: { recommendations: [], alerts: [{ alert_code: 'CPM_SPIKE' }] },
    });
    expect(gov.frameworks.map(f => f.code)).toContain('MF6');
    const provEntry = gov.alert_provenance.find(p => p.alert_code === 'CPM_SPIKE');
    expect(provEntry.provenance.framework).toBe('MF2');
  });

  test('self_check and decision_validations are always present objects', () => {
    const gov = buildGovernanceTrace({
      campaign: { objective: 'traffic' },
      currentMetrics: { impressions: 5000 },
    });
    expect(gov.self_check).toBeDefined();
    expect(gov.decision_validations).toBeDefined();
    expect(['passed', 'failed']).toContain(gov.self_check.overall);
  });
});
