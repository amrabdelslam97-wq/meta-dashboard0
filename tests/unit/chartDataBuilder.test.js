'use strict';

const chart = require('../../src/services/chartDataBuilder');

describe('chartDataBuilder', () => {
  test('buildLineChart maps a daily series into labels/datasets, with an optional previous-period series attached', () => {
    const series = [
      { date_start: '2026-06-01', spend: 10, results: 2 },
      { date_start: '2026-06-02', spend: 20, results: 4 },
    ];
    const previous = [{ date_start: '2026-05-25', spend: 5, results: 1 }];
    const result = chart.buildLineChart(series, { metricKeys: ['spend', 'results'], previousSeries: previous });

    expect(result.type).toBe('line');
    expect(result.labels).toEqual(['2026-06-01', '2026-06-02']);
    expect(result.datasets.find(d => d.label === 'spend').data).toEqual([10, 20]);
    expect(result.previous.datasets.find(d => d.label === 'spend').data).toEqual([5]);
  });

  test('buildAreaChart is the same shape as buildLineChart but typed "area"', () => {
    const result = chart.buildAreaChart([{ date_start: '2026-06-01', spend: 5 }], { metricKeys: ['spend'] });
    expect(result.type).toBe('area');
  });

  describe('aggregateTrend', () => {
    test('rolls a daily series up into weekly buckets, summing volume and re-deriving ctr/cpm/cost_per_result', () => {
      const daily = [
        { date_start: '2026-06-01', spend: 10, impressions: 1000, reach: 500, clicks: 10, results: 2 }, // Monday
        { date_start: '2026-06-02', spend: 20, impressions: 2000, reach: 1000, clicks: 20, results: 4 }, // Tuesday, same week
        { date_start: '2026-06-09', spend: 5, impressions: 500, reach: 250, clicks: 5, results: 1 }, // next week (Tuesday)
      ];
      const weekly = chart.aggregateTrend(daily, 'week');
      expect(weekly.length).toBe(2);
      expect(weekly[0].spend).toBe(30); // week 1 = 10+20
      expect(weekly[0].results).toBe(6);
      expect(weekly[0].cost_per_result).toBeCloseTo(5, 2); // 30/6
      expect(weekly[1].spend).toBe(5);
    });

    test('rolls a daily series up into monthly buckets', () => {
      const daily = [
        { date_start: '2026-06-01', spend: 10, impressions: 100, reach: 50, clicks: 1, results: 1 },
        { date_start: '2026-06-28', spend: 15, impressions: 150, reach: 75, clicks: 2, results: 1 },
        { date_start: '2026-07-01', spend: 20, impressions: 200, reach: 100, clicks: 3, results: 1 },
      ];
      const monthly = chart.aggregateTrend(daily, 'month');
      expect(monthly.length).toBe(2);
      expect(monthly[0].date_start).toBe('2026-06');
      expect(monthly[0].spend).toBe(25);
      expect(monthly[1].date_start).toBe('2026-07');
      expect(monthly[1].spend).toBe(20);
    });
  });

  test('buildBarChart / buildPieChart / buildDistributionChart map rows to chart-ready labels+values, pie/distribution adding percentages', () => {
    const rows = [
      { dimension_value: 'US', spend: 75 },
      { dimension_value: 'EG', spend: 25 },
    ];
    const bar = chart.buildBarChart(rows);
    expect(bar.type).toBe('bar');
    expect(bar.labels).toEqual(['US', 'EG']);
    expect(bar.data).toEqual([75, 25]);

    const pie = chart.buildPieChart(rows);
    expect(pie.percentages).toEqual([75, 25]);

    const dist = chart.buildDistributionChart(rows);
    expect(dist.type).toBe('distribution');
    expect(dist.percentages).toEqual([75, 25]);
  });

  test('buildStackedChart produces one dataset per requested series key', () => {
    const rows = [
      { dimension_value: 'facebook / feed', spend: 10, results: 2 },
      { dimension_value: 'instagram / reels', spend: 20, results: 5 },
    ];
    const result = chart.buildStackedChart(rows, { seriesKeys: ['spend', 'results'] });
    expect(result.type).toBe('stacked_bar');
    expect(result.datasets.length).toBe(2);
    expect(result.datasets.find(d => d.label === 'results').data).toEqual([2, 5]);
  });

  test('buildHeatmap builds a row x col matrix from flat rows, filling missing combinations with 0', () => {
    const rows = [
      { platform: 'facebook', device: 'mobile', spend: 10 },
      { platform: 'facebook', device: 'desktop', spend: 5 },
      { platform: 'instagram', device: 'mobile', spend: 8 },
      // no instagram/desktop row -- should default to 0
    ];
    const heatmap = chart.buildHeatmap(rows, { rowKey: 'platform', colKey: 'device', valueKey: 'spend' });
    expect(heatmap.rows).toEqual(['facebook', 'instagram']);
    expect(heatmap.cols).toEqual(['mobile', 'desktop']);
    expect(heatmap.matrix).toEqual([[10, 5], [8, 0]]);
  });

  test('buildTreemap maps rows to name/value children', () => {
    const rows = [{ dimension_value: 'Video', spend: 40 }, { dimension_value: 'Image', spend: 60 }];
    const result = chart.buildTreemap(rows);
    expect(result.type).toBe('treemap');
    expect(result.children).toEqual([{ name: 'Video', value: 40 }, { name: 'Image', value: 60 }]);
  });

  test('buildScatterChart maps rows to x/y/label points', () => {
    const rows = [
      { headline: 'A', score_overall: 80, roas: 3.2 },
      { headline: 'B', score_overall: 40, roas: 1.1 },
    ];
    const result = chart.buildScatterChart(rows, { xKey: 'score_overall', yKey: 'roas', labelKey: 'headline' });
    expect(result.type).toBe('scatter');
    expect(result.points).toEqual([
      { x: 80, y: 3.2, label: 'A' },
      { x: 40, y: 1.1, label: 'B' },
    ]);
  });

  test('buildBubbleChart adds a size dimension on top of scatter\'s x/y', () => {
    const rows = [{ headline: 'A', score_overall: 80, roas: 3.2, spend: 500 }];
    const result = chart.buildBubbleChart(rows, { xKey: 'score_overall', yKey: 'roas', sizeKey: 'spend', labelKey: 'headline' });
    expect(result.type).toBe('bubble');
    expect(result.points).toEqual([{ x: 80, y: 3.2, size: 500, label: 'A' }]);
  });

  test('buildFunnelChart computes pct_of_top against the first stage', () => {
    const stages = [
      { label: 'Impressions', value: 1000 },
      { label: 'Link Clicks', value: 200 },
      { label: 'Results', value: 50 },
    ];
    const result = chart.buildFunnelChart(stages);
    expect(result.type).toBe('funnel');
    expect(result.stages.map(s => s.pct_of_top)).toEqual([100, 20, 5]);
  });

  test('buildFunnelChart handles a zero top-stage without dividing by zero', () => {
    const result = chart.buildFunnelChart([{ label: 'Impressions', value: 0 }, { label: 'Clicks', value: 0 }]);
    expect(result.stages.every(s => s.pct_of_top === 0)).toBe(true);
  });

  test('buildRankingChart preserves rank position and maps label/value keys', () => {
    const ranking = [
      { rank: 1, ad_name: 'Winner Ad', score: 92 },
      { rank: 2, ad_name: 'Runner Up', score: 65 },
    ];
    const result = chart.buildRankingChart(ranking, { labelKey: 'ad_name', valueKey: 'score' });
    expect(result.type).toBe('ranking');
    expect(result.items).toEqual([
      { rank: 1, label: 'Winner Ad', value: 92 },
      { rank: 2, label: 'Runner Up', value: 65 },
    ]);
  });

  test('buildRankingChart falls back to array position when a row has no explicit rank', () => {
    const result = chart.buildRankingChart([{ ad_name: 'Only Ad', score: 50 }], { labelKey: 'ad_name', valueKey: 'score' });
    expect(result.items[0].rank).toBe(1);
  });

  test('buildRetentionCurve reads the standard video watch-percentage checkpoints off one creative row', () => {
    const row = { video_p25_pct: 80, video_p50_pct: 60, video_p75_pct: 40, video_p95_pct: 20, video_p100_pct: 10 };
    const result = chart.buildRetentionCurve(row);
    expect(result.type).toBe('retention_curve');
    expect(result.labels).toEqual(['25%', '50%', '75%', '95%', '100%']);
    expect(result.data).toEqual([80, 60, 40, 20, 10]);
  });

  test('buildRetentionCurve returns nulls (never fabricated values) for missing checkpoints', () => {
    const result = chart.buildRetentionCurve({ video_p25_pct: 50 });
    expect(result.data).toEqual([50, null, null, null, null]);
  });

  describe('withComparison / attachRowComparisons', () => {
    test('computes difference/percentage_change/growth/decline correctly', () => {
      const up = chart.withComparison(120, 100);
      expect(up.difference).toBe(20);
      expect(up.percentage_change).toBe(20);
      expect(up.growth).toBe(true);
      expect(up.decline).toBe(false);

      const down = chart.withComparison(80, 100);
      expect(down.growth).toBe(false);
      expect(down.decline).toBe(true);
      expect(down.percentage_change).toBe(-20);
    });

    test('handles a zero/null previous value without dividing by zero', () => {
      const result = chart.withComparison(50, 0);
      expect(result.percentage_change).toBeNull();
      expect(result.growth).toBe(true);
    });

    test('attachRowComparisons wraps each row\'s own `previous` sub-object into a `comparison` block', () => {
      const rows = [
        { breakdown_value: 'US', spend: 120, previous: { spend: 100 } },
        { breakdown_value: 'EG', spend: 50, previous: null },
      ];
      const result = chart.attachRowComparisons(rows, 'spend');
      expect(result[0].comparison.growth).toBe(true);
      expect(result[1].comparison.current).toBe(50);
      expect(result[1].comparison.previous).toBe(0);
    });
  });
});
