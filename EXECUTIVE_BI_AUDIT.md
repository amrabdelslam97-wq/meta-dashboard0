# Executive BI & Enterprise Analytics Suite — Architecture Audit

**Goal:** Turn platform into complete BI environment for executive reporting, advanced analytics, custom dashboards, KPI monitoring.

## Current State Analysis

### Data Available
✓ **Campaign metrics** — spend, results, reach, impressions, clicks, ctr, cpm, cpc, cpa, roas, revenue, frequency
✓ **Ad set metrics** — same as campaigns, plus audience/targeting data
✓ **Ad metrics** — creative performance, device, placement, platform breakdowns
✓ **Creative metrics** — creative_analytics table with performance + video metrics
✓ **Audience metrics** — audience_score_history + attribution breakdown
✓ **Geographic metrics** — analytics_breakdown_history by country/region
✓ **Time series** — historical snapshots with date_since/date_until
✓ **Budget data** — budget_distribution_snapshots with allocation + waste flags
✓ **Predictions** — predictiveAIEngine with risk/opportunity scores

### Existing Intelligence Engines
✓ Creative Intelligence (Phase 22)
✓ Audience Intelligence (Phase 23)
✓ Budget Intelligence (Phase 24)
✓ Predictive AI (Phase 25)
✓ Attribution Intelligence (Phase 22)
✓ Executive Summary (basic, Phase 17)

### What Needs to Be Built

#### KPI Engine
- [ ] Current value calculations
- [ ] Period comparison (vs previous period, vs target)
- [ ] Trend detection (up/down/stable)
- [ ] Confidence scores
- [ ] Risk indicators
- [ ] AI commentary generation

#### Business Health Index
- [ ] 0-100 score across 9 dimensions
- [ ] Weighted component calculation
- [ ] Trend tracking
- [ ] Risk assessment

#### Drill-Down Data Layer
- [ ] Campaign-level drill
- [ ] Ad set-level drill
- [ ] Ad-level drill
- [ ] Creative drill
- [ ] Placement drill
- [ ] Audience drill
- [ ] Geographic drill
- [ ] Time drill

#### Geographic Intelligence
- [ ] Country-level metrics
- [ ] State/region metrics
- [ ] City-level (if available)
- [ ] Spend/results/roas distribution
- [ ] Growth detection by region

#### Time Intelligence
- [ ] Hourly analysis (if data available)
- [ ] Daily trends
- [ ] Weekly patterns
- [ ] Monthly comparison
- [ ] YoY analysis
- [ ] Seasonality detection

#### Benchmark Center
- [ ] Campaign benchmarking
- [ ] Account comparison
- [ ] Objective-level benchmarks
- [ ] Country-level performance
- [ ] Platform performance comparison
- [ ] Creative type comparison

#### Leaderboards
- [ ] Campaign rankings (by spend, roas, cpa, growth)
- [ ] Ad rankings
- [ ] Creative rankings
- [ ] Audience rankings
- [ ] Placement rankings
- [ ] Geographic rankings

#### Export Engine
- [ ] PDF export
- [ ] Excel export
- [ ] CSV export
- [ ] JSON export
- [ ] PowerPoint templates (basic)

#### Analytics APIs
- [ ] KPI endpoint
- [ ] Business health endpoint
- [ ] Leaderboard endpoint
- [ ] Benchmark endpoint
- [ ] Geographic analytics endpoint
- [ ] Time series endpoint
- [ ] Export endpoint

## Implementation Strategy

### Phase 26 Part A — Core Analytics Engine
**Priority: HIGH**
1. KPI calculation engine
2. Business Health Index
3. Leaderboard generation
4. Geographic intelligence
5. Time series analysis
6. Core analytics APIs

### Phase 26 Part B — Drill-Down & Comparison
**Priority: MEDIUM**
1. Drill-down data layer
2. Benchmark center
3. Comparison mode
4. Filtering system
5. Advanced APIs

### Phase 26 Part C — Export & Reporting
**Priority: MEDIUM**
1. Export engine (PDF, Excel, CSV, JSON)
2. Report scheduling
3. Email distribution
4. Snapshot system
5. Sharing & permissions

### Phase 27+ — Frontend UI
**Priority: LATER (requires UI framework)**
1. Custom dashboard builder (React/Vue)
2. Widget library
3. Chart library integration (recharts/d3)
4. Presentation mode
5. Real-time updates

## Data Architecture

### KPI Source Tables
- campaigns (current metrics)
- budget_distribution_snapshots (period allocations)
- creative_analytics (creative performance)
- analytics_breakdown_history (breakdowns)
- attribution_window_comparison (attribution)
- audience_score_history (audience analysis)

### Calculation Pattern
```
KPI Calculation:
1. Fetch current period metrics
2. Fetch previous period metrics
3. Calculate change %
4. Determine trend
5. Get target from account settings (if exists)
6. Calculate achievement %
7. Get risk from risk engines
8. Get confidence from data quality
9. Generate AI commentary
10. Return complete KPI object
```

## Performance Strategy

### Caching
✓ Reuse existing cacheService
✓ KPI results (5 min TTL)
✓ Leaderboards (10 min TTL)
✓ Benchmarks (15 min TTL)
✓ Geographic data (15 min TTL)

### Query Optimization
✓ Use indexes on date_since/date_until
✓ Index on level + entity_meta_id
✓ Aggregation at DB level (not in code)
✓ Pagination for large result sets
✓ Server-side filtering

### Frontend Performance (Phase 27)
- Virtual scrolling for large lists
- Lazy loading for charts
- Incremental widget loading
- Chart caching with canvas renderer

## No Duplications

- Reuse existing scoring engines (creative, audience, budget)
- Reuse existing trend detection functions
- Reuse existing prediction engine
- Reuse existing cache layer
- Reuse existing API patterns
- Leverage existing databases
- Don't rebuild aggregation logic

## Integration Points

**Inputs:**
- All existing intelligence engines
- Creative Intelligence scores
- Audience Intelligence scores
- Budget Intelligence scores
- Predictive AI risk/opportunity
- Attribution data
- Historical metrics

**Outputs:**
- KPI APIs for dashboards
- Export files
- Reports
- Alerts (to Rule Engine)
- Snapshots
- Insights

## Success Criteria

✓ All KPIs calculated within 100ms
✓ Leaderboards generated within 200ms
✓ Geographic queries within 300ms
✓ Export generation within 5s (for 1M rows)
✓ Dashboard loads with <20 queries
✓ Zero breaking changes to existing APIs
✓ 100% backward compatibility

