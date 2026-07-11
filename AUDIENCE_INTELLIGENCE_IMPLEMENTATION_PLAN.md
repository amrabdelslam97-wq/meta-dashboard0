# Audience Intelligence Engine — Implementation Plan

## Current State Assessment

✓ **Foundation:**
- `breakdownsFetcher.js` — Fetches: age_gender, placement, country, region, dma, impression_device, device_platform
- `analyticsEngine.js` — Persists to `analytics_breakdown_history` table
- `audienceIntelligenceEngine.js` — Reads breakdowns for analysis
- `intelligence.js` route — Exposes audience/placement/device endpoints

✗ **Gaps:**
1. Time Intelligence (hour/day/week/month) — Not in breakdownsFetcher
2. Audience Segmentation (custom/lookalike/advantage+) — Not in breakdownsFetcher
3. Interest Intelligence — Not supported by Meta Insights breakdowns
4. Language Intelligence — Partial support (targeting_locales, no performance breakdown)
5. Audience Scoring Engine — Not implemented
6. Opportunity Detection Engine — Minimal
7. Diagnostics Engine — Basic
8. Charts + Dashboard Page — Not built

## Implementation Strategy

### Phase A: Extend breakdownsFetcher (No Breaking Changes)
1. Add `action_type` dimension (if available in Meta API)
2. Document language/time limitations
3. Reuse existing breakdown infrastructure

### Phase B: Build Audience Scoring Engine
1. Create `audienceScoringEngine.js`
2. Score 0-100 across: cost, volume, conversion rate, CTR, ROAS, frequency, trend, stability
3. Integrate with existing engines

### Phase C: Enhance Intelligence Engines
1. Expand `audienceIntelligenceEngine.js` with:
   - Audience Opportunity Engine
   - Comprehensive Diagnostics
   - Time-based analysis (if data available)
2. Create `audienceLanguageIntelligence.js` for language targeting analysis
3. Create `audienceInterestIntelligence.js` (if metadata available)

### Phase D: Database Extensions
1. Add `audience_score_history` table (Phase 23)
2. Extend `audience_attribution` table if needed
3. No schema breaking changes

### Phase E: API Enhancements
1. Add scoring endpoints
2. Add opportunity/recommendation endpoints
3. Add diagnostics endpoints

### Phase F: Dashboard
1. Create charts for Audience Analytics
2. Age pyramid, Gender pie, Geo heatmap
3. Placement/Platform/Device comparisons
4. ROAS/CPA/CTR by segment

## Meta API Constraints

**Supported Breakdowns (Confirmed via breakdownsFetcher):**
- age (0–6 segments)
- gender (3 segments)
- country (100–200 segments)
- region (varies by country)
- dma (US-only)
- publisher_platform (4 platforms)
- platform_position (10+ positions)
- impression_device (5 categories)
- device_platform (3 categories)

**NOT Supported via Insights API:**
- city/zip/district (geotarget metadata only, no performance breakdown)
- hour/day/week/month (would require datetime-granular Insights, not exposed)
- language (ad_sets.targeting_locales present, performance breakdown NOT available)
- audience type (targeting metadata present, performance NOT exposed)
- interest (targeting metadata present, performance NOT exposed)

## Implementation Order

1. **Audience Scoring Engine** (highest priority, enables comparisons)
2. **Expand Intelligence Engines** (opportunity + diagnostics)
3. **Database Schema** (audience_score_history)
4. **API Routes** (new endpoints)
5. **Dashboard Charts** (visualization)
6. **Testing + Verification**

## Estimated Effort

- Audience Scoring: 2-3 hours
- Intelligence Engine Expansion: 2-3 hours
- Schema + Persistence: 1-2 hours
- API Routes: 1-2 hours
- Dashboard: 2-3 hours
- Testing: 1-2 hours
---

Total: ~11-15 hours implementation + testing
