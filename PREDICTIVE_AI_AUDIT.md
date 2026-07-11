# Predictive AI Optimization Engine — Architecture Audit

## Existing Data Foundation

### Historical Data Available
✓ **analytics_breakdown_history** (Phase 19) — Per-dimension breakdowns with dates
✓ **budget_distribution_snapshots** (Phase 19) — Period-based budget allocation
✓ **attribution_window_comparison** (Phase 22) — Attribution across windows
✓ **creative_analytics** (Phase 19) — Creative performance snapshots
✓ **sync_execution_log** (Phase 16) — Historical sync events

### Metrics Available (Normalized)
✓ **spend, impressions, reach, clicks** — From metricsFetcher
✓ **ctr, cpm, cpc, frequency** — Calculated metrics
✓ **results, cpa, roas, revenue** — From Meta Insights
✓ **actions_json** — Stores purchase, lead, message, etc

### Time Series Data
- Period snapshots (date_since/date_until) — not granular daily
- Multiple snapshots per entity over time
- Dates back to start of sync

### Seasonal/Behavioral Patterns
✓ Campaign objective behavior (Phase 5)
✓ Ad set targeting metadata (Phase 22)
✓ Creative lifecycle tracking (Phase 19+)
✓ Audience attribution by type (Phase 22)

## What Exists to Reuse

### Services
✓ **metricsFetcher.js** — Normalized metric extraction
✓ **analyticsEngine.js** — Breakdown fetching + persistence
✓ **dateRangeHelper.js** — Date calculations
✓ **cacheService.js** — Query caching
✓ **audienceScoringEngine.js** — Component scoring pattern
✓ **budgetIntelligenceEngine.js** — Scoring + detection pattern

### Patterns
✓ Weight-based scoring (Creative, Audience, Budget)
✓ Trend detection (pctChange function, variance analysis)
✓ Pattern detection (fatigue, waste, saturation)
✓ Confidence calculation patterns
✓ API endpoint structure
✓ Error handling middleware

## What's NOT Available

✗ **Hourly data** — Only period snapshots exist
✗ **Individual customer data** — Aggregates only
✗ **Causal inference** — Can't determine why changes occur
✗ **External features** — No market, competitor, seasonal data
✗ **ML models** — No pre-trained models available

## What We CAN Do

✓ **Time series analysis** — Moving averages, trend lines, seasonality
✓ **Anomaly detection** — Z-score, volatility thresholds
✓ **Confidence estimation** — Historical stability, data quality
✓ **Risk/Opportunity scoring** — Based on patterns + metrics
✓ **Scenario simulation** — Linear projections, sensitivity analysis
✓ **Proactive alerts** — Threshold-based early warning

## Implementation Strategy

### Phase 25 (Recommended Split)

**Part A — Core Prediction Engine (Week 1)**
- Time series forecasting (moving average, trend)
- Confidence calculation
- Anomaly detection
- Risk scoring
- Database schema

**Part B — Optimization (Week 2)**
- Opportunity scoring
- Recommendation generation
- What-if simulator
- AI alerts
- Dashboard integration

**Part C — Advanced (Week 3)**
- Confidence improvements (Bayesian)
- Seasonality modeling
- Custom alert rules
- Performance tracking
- Analytics refinement

## Data Quality Considerations

### Strengths
✓ Real Meta API data (no fabrication)
✓ Consistent normalization (normalizeRow)
✓ Audit trail (sync logs)
✓ Multiple dimensions
✓ Historical consistency

### Limitations
✗ Period snapshots (not daily granular)
✗ No sub-period data (can't decompose)
✗ Sparse data (some entities have few snapshots)
✗ Aggregate only (no individual user behavior)
✗ Attribution window dependency

## Prediction Confidence Factors

1. **Data Recency** — Recent data more reliable than old
2. **Data Density** — More snapshots = higher confidence
3. **Pattern Stability** — Consistent trends more predictable
4. **Volatility** — Low volatility = higher confidence
5. **Historical Accuracy** — How well past predictions matched
6. **Metadata Quality** — Complete targeting/creative info

## Algorithms to Implement

### Time Series Forecasting
- Simple exponential smoothing (recent data weighted more)
- Linear regression on trend
- Moving average (7d, 14d, 30d)
- Seasonality detection (if data available)

### Anomaly Detection
- Z-score (how many σ from mean)
- Isolation Forest concept (simple version)
- Rate of change thresholds
- Volatility expansion

### Risk Scoring
- Budget stability (burn rate variance)
- Creative lifecycle (performance fade)
- Audience fatigue (frequency rise, CTR fall)
- Delivery issues (reach decline)
- Learning phase instability (metric swings)

### Opportunity Scoring
- Performance vs category average
- Growth trajectory
- Headroom (can spend more)
- Scaling readiness
- Audience/Creative freshness

## No New Dependencies

- Use only existing npm packages
- Leverage existing ML-lite functions
- Simple statistical math (mean, variance, trend)
- No heavy ML frameworks

## Integration Points

**Inputs:**
- analytics_breakdown_history (read)
- budget_distribution_snapshots (read)
- creative_analytics (read)
- attribution tables (read)
- Synced campaign/ad_set/ad/audience metadata

**Outputs:**
- New prediction tables (write)
- Risk/Opportunity scores (API)
- Forecast data (dashboard)
- Recommendations (rule engine)
- Alerts (notification system)

## Architecture Constraints

1. **No real-time predictions** — Use synced historical data only
2. **No data fabrication** — Predict from real patterns only
3. **No external data** — Meta API data only
4. **No model persistence** — Recalculate on each request
5. **Transparency required** — Show confidence, data quality, methodology

