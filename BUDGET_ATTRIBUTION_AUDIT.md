# Budget & Attribution Intelligence — Architecture Audit

## Existing Foundation (Can Reuse)

### Budget Data (Phase 19)
- **Table:** `budget_distribution_snapshots`
- **Columns:** 
  - budget_amount, spend_amount, results
  - budget_pct, spend_pct, results_pct
  - efficiency_score, is_waste, is_scaling_opportunity
  - level (campaign/ad_set/ad), entity_meta_id
  - date_since, date_until
- **Extended (Phase 22):**
  - revenue, roas (new columns)

### Attribution Data (Phase 22)
- **conversation_attribution** — destination-based conversation tracking
- **attribution_window_comparison** — 1d_click/7d_click/1d_view/7d_view windows
- **language_performance_attribution** — locale-based performance
- **audience_attribution** — audience type performance

### Metrics Foundation (Phase 4+)
- Campaign metrics via `metricsFetcher.js`
- Normalization via `normalizeRow()` (CTR, CPA, CPM, ROAS, etc)
- Caching via `cacheService`

### Intelligence Infrastructure (Phases 17-23)
- analyticsEngine — breakdown fetching + persistence
- Recommendation engine framework
- Rule engine triggers
- Dashboard integration patterns

## What's Missing (To Implement)

### Scoring & Detection
- [ ] Budget Efficiency Scoring (0-100)
- [ ] Budget Waste Detection Engine
- [ ] Scaling Opportunity Detection

### Analysis & Trends
- [ ] Budget Trend Analysis (daily/weekly/monthly/quarterly/yearly)
- [ ] Burn Rate Calculation
- [ ] Pacing Analysis

### Movement & Optimization
- [ ] Budget Movement Engine (recommendations with confidence/impact/risk)
- [ ] Multi-level budget optimization suggestions

### Advanced Features
- [ ] ROAS Intelligence (by every dimension)
- [ ] Revenue Intelligence (if data available)
- [ ] Forecasting Engine (next day/week/month projections)
- [ ] Scenario Simulator (what-if analysis)
- [ ] Budget Health Score (0-100)

### API & Visualization
- [ ] 8 new API endpoints
- [ ] Dashboard section for Budget Intelligence
- [ ] Charts (timeline, allocation tree, Sankey, burn rate, pacing, forecast)

## Meta API Constraints

✓ **Available:**
- Budget allocation (campaign/ad_set/ad level)
- Spend tracking (real-time)
- Results/conversions by dimension
- ROAS when purchase_value available
- Attribution windows (1d_click, 7d_click, 1d_view, 7d_view available via Meta)

✗ **Not Available:**
- Daily granular breakdown (budget_distribution is period snapshot)
- Hourly forecasting
- "True" multi-touch attribution (only last-click windows exposed)
- Historical daily burn rate (would need daily snapshots, not implemented)
- Individual customer journeys (only aggregates available)

## Implementation Strategy

### Phase 24 — Budget Intelligence & Attribution (Part 1)
1. Build scoring engines (efficiency, waste, scaling)
2. Add budget analysis tables
3. Create base API endpoints
4. Integrate with existing recommendation engine

### Phase 25 — Advanced Budget Analysis (Part 2)  
1. Forecasting engine
2. Scenario simulator
3. Budget movement recommendations
4. Trend analysis

### Phase 26 — Attribution & Revenue (Part 3)
1. Expand attribution analysis
2. ROAS/Revenue intelligence
3. Dashboard charts
4. Integration with Executive Summary

## Reuse Opportunities

✓ **Sync Pipeline:** smartSyncEngine tier for daily snapshots
✓ **Caching:** Existing cacheService for budget queries
✓ **Scoring:** Use weight-based approach from CreativeScoring + AudienceScoring
✓ **Recommendations:** Existing recommendation framework
✓ **Rule Engine:** Trigger rules on budget thresholds
✓ **Dashboard:** Extend existing UI with budget widgets
✓ **Analytics:** Reuse breakdown persistence pattern

## No Duplications

- Use existing `normalizeRow()` for metric calculation
- Don't rebuild aggregation logic (analyticsEngine already does)
- Leverage attribution tables from Phase 22
- Extend, don't rebuild recommendation engine
- Reuse permission/auth patterns
