'use strict';

const { buildRootCauseReasoning, computeConfidence } = require('../../src/services/executiveReasoningEngine');

describe('executiveReasoningEngine', () => {
  describe('computeConfidence', () => {
    test('more supporting signals raises confidence, more conflicting signals lowers it', () => {
      const high = computeConfidence({ supportingSignals: 4, conflictingSignals: 0, dataSufficient: true });
      const low = computeConfidence({ supportingSignals: 0, conflictingSignals: 3, dataSufficient: true });
      expect(high.confidence_pct).toBeGreaterThan(low.confidence_pct);
    });

    test('caps confidence at 40 when data is insufficient, regardless of signal count', () => {
      const result = computeConfidence({ supportingSignals: 10, conflictingSignals: 0, dataSufficient: false });
      expect(result.confidence_pct).toBeLessThanOrEqual(40);
    });

    test('always reports the real supporting/conflicting counts', () => {
      const result = computeConfidence({ supportingSignals: 3, conflictingSignals: 1, dataSufficient: true });
      expect(result.supporting_signals).toBe(3);
      expect(result.conflicting_signals).toBe(1);
    });
  });

  describe('buildRootCauseReasoning', () => {
    test('defers (returns null) when diagnosisEngine already found a real cause', () => {
      const diagnosis = { status: 'diagnosed', category: 'audience', factors: [{ key: 'frequency_rising', category: 'audience', detail: 'x' }] };
      expect(buildRootCauseReasoning({ diagnosis, crossSignals: { creativeScore: 80 } })).toBeNull();
    });

    test('defers when diagnosis is not diagnosed at all (insufficient_data/not_delivering)', () => {
      expect(buildRootCauseReasoning({ diagnosis: { status: 'insufficient_data' } })).toBeNull();
    });

    test('never fabricates when no cross-signal data is available -- stays honest at low confidence', () => {
      const diagnosis = { status: 'diagnosed', category: 'unexplained', factors: [] };
      const result = buildRootCauseReasoning({ diagnosis, crossSignals: {} });
      expect(result.probable_explanation).toBeNull();
      expect(result.confidence.confidence_pct).toBeLessThanOrEqual(40);
      expect(result.note).toMatch(/insufficient data/i);
    });

    test('all signals healthy -> hedged auction/demand explanation with a reasonably high confidence', () => {
      const diagnosis = { status: 'diagnosed', category: 'unexplained', factors: [] };
      const result = buildRootCauseReasoning({
        diagnosis,
        crossSignals: { creativeScore: 78, fatigueStatus: 'none', frequency: 1.4, ctrDeltaPct: 2 },
      });
      expect(result.probable_explanation).toMatch(/auction competition or audience demand fluctuation/);
      expect(result.ruled_out.length).toBe(4);
      expect(result.confidence.confidence_pct).toBeGreaterThanOrEqual(60);
    });

    test('a real contributing signal (weak creative score) is named as the probable explanation instead of the generic fallback', () => {
      const diagnosis = { status: 'diagnosed', category: 'unexplained', factors: [] };
      const result = buildRootCauseReasoning({
        diagnosis,
        crossSignals: { creativeScore: 25, fatigueStatus: 'none', frequency: 1.2, ctrDeltaPct: 1 },
      });
      expect(result.probable_explanation).toMatch(/Creative score is weak/);
      expect(result.probable_explanation).not.toMatch(/auction competition/);
    });
  });
});
