# AI Copilot & Conversational Analytics — Architecture Design

**Goal:** Transform platform into AI Marketing Assistant answering complex business questions using ONLY synchronized Meta Ads data.

**Core Principle:** NEVER invent numbers. Every answer from synced project data only.

---

## System Architecture

```
User Input (Text/Voice)
         ↓
Language Identification (Arabic/English/Mixed)
         ↓
Context Engine (Account, Campaign, Date Range, Memory)
         ↓
Query Parser (Intent Recognition)
         ↓
Evidence Engine (Fetch supporting data)
         ↓
Analysis Engine (Root cause, trends, forecasts)
         ↓
Response Generator (Summary + Evidence + Charts)
         ↓
Output Formatter (Text, Charts, Tables, Recommendations)
         ↓
Chat UI (Desktop, Mobile, Dark/Light)
```

---

## Query Types Supported

### Performance Analysis
"Why did CPA increase?" → Root cause analysis with evidence

### Budget Analysis
"Which campaign wastes the most?" → Waste detection + opportunities

### Creative Analysis
"Which creatives are dying?" → Trend analysis + scores

### Audience Analysis
"Which audience performs best?" → Scoring + comparisons

### Trend Analysis
"What changed this week?" → Week-over-week comparisons

### Forecast Analysis
"Will CPA increase?" → Predictive signals + confidence

### Root Cause Analysis
Auto-identify: Budget, Creative, Audience, Learning, Delivery issues

### Recommendation
"What should I scale?" → Scoring + risk assessment

---

## Evidence Engine

Every statement references:
- Specific campaign/ad/creative/audience
- Historical metrics (current vs previous)
- Predictive signals (forecast, risk, opportunity)
- Scoring results (Phase 22, 23, 24)
- Trend analysis (up/down/stable)
- Rule engine decisions
- Decision history (prior changes)

### Data Sources
- analytics_breakdown_history (metrics by dimension)
- budget_distribution_snapshots (budget allocation)
- creative_analytics (creative performance)
- audience_score_history (audience scoring)
- predictiveAIEngine (forecasts)
- creative/audience/budget intelligence scores
- sync_execution_log (data freshness)
- attribution tables (attribution analysis)

---

## Conversation Flow Example

**User:** "Why did CPA increase?"

1. **Parse Intent:** Performance Analysis / Root Cause
2. **Context:** Current campaign, last 30 days
3. **Fetch Evidence:**
   - Current CPA: $15 (Previous: $10 = 50% increase)
   - Creative fatigue detected (-10% score)
   - Audience saturation (-15% efficiency)
   - Frequency explosion (1.2x → 2.8x)
   - Budget reallocation detected

4. **Analyze:**
   - Primary: Audience saturation
   - Secondary: Creative fatigue
   - Tertiary: Frequency increase

5. **Generate Response:**
   - Summary: "CPA increased 50% due to audience saturation"
   - Evidence: Show metrics, charts, scores
   - Impact: "Losing $5k/month efficiency"
   - Recommendation: "Refresh audience + pause creative"
   - Forecast: "CPA should return to $10 after actions"

6. **Follow-up Suggestions:**
   - "Show details on audience saturation?"
   - "Compare with last week?"
   - "What if we pause this audience?"

---

## Context Engine

Tracks throughout conversation:
- Account (current user access)
- Campaign/Ad Set/Ad (selected entity)
- Date Range (analysis period)
- Previous Query (for "why", "continue")
- Filters (geo, platform, device)
- Comparison Context (last comparison)
- Mode (Executive vs Analyst)

---

## Response Generation

1. **Summary** — Direct answer (1-2 sentences)
2. **Evidence** — Metrics, change %, data freshness
3. **Analysis** — Root causes, supporting evidence, confidence
4. **Visualization** — Trend charts, comparisons, forecasts
5. **Recommendation** — Action, expected impact, risk, confidence
6. **Follow-ups** — 3-4 suggested next questions

---

## Multi-Language Support

- **Arabic:** RTL rendering, Arabic marketing terms, bilingual abbreviations
- **English:** Standard processing, marketing terminology
- **Mixed:** Language switch detection, context maintained

---

## API Architecture

```
POST /api/v1/chat
{
  "message": "Why did CPA increase?",
  "context": {
    "account_id": "...",
    "campaign_id": "...",
    "date_range": "7d"
  }
}

Response: {
  "response": {
    "summary": "...",
    "evidence": [...],
    "analysis": "...",
    "visualizations": [...],
    "recommendation": {...},
    "follow_ups": [...]
  }
}
```

---

## Implementation Phases

### Phase 27 Part A — Foundation (2 weeks)
1. Context Engine (conversation memory)
2. Evidence Engine (query builders)
3. Intent Recognition (question classification)
4. Response Generation (template-based)
5. APIs (chat endpoint)

### Phase 27 Part B — Intelligence (2 weeks)
1. Root Cause Analysis
2. Trend Detection
3. Visualization Generation
4. Recommendation Conversation
5. Search Engine

### Phase 27 Part C — Advanced (2 weeks)
1. Natural Language Understanding
2. Multi-language Support
3. Decision Simulator
4. Report Generator
5. Voice Architecture

### Phase 28+ — UI & Polish
1. Chat Interface
2. Conversation History
3. Voice Integration
4. Performance Optimization

---

## Integration with Existing Systems

- Creative Intelligence (Phase 22) → Creative scores, trends
- Audience Intelligence (Phase 23) → Audience scores, opportunities
- Budget Intelligence (Phase 24) → Budget scores, waste, scaling
- Predictive AI (Phase 25) → Forecasts, risk/opportunity
- Executive BI (Phase 26) → KPIs, leaderboards, benchmarks
- Rule Engine → Automation history, decisions
- Attribution Intelligence → Journey data
- Recommendation Engine → Explanations + impact

---

## Success Criteria

✓ Understands Arabic, English, mixed language questions
✓ Every answer backed by synced project data
✓ Root cause analysis identifies 3+ factors
✓ Recommendations show expected impact
✓ Response generation <1 second
✓ Context memory survives 20+ turns
✓ Works across desktop, tablet, mobile
✓ Zero hallucinations (no invented numbers)
✓ Integrates with all intelligence engines

---

## Known Limitations (Phase 1)

- No real LLM (template-based responses)
- Limited context window (current session)
- No voice support (architecture only)
- Synced data only (no real-time)
- No causal inference (correlation only)
- No modification requests (read-only)
- Single account at a time

---

## Future LLM Enhancements (Phase 28+)

- Claude API integration (actual LLM)
- Fine-tuned marketing domain model
- Real-time data streaming
- Multi-account analysis
- Competitor benchmarking
- Voice support (ASR + TTS)
- Proactive insights (anomaly detection)
- Custom company terminology

---

## Next Steps

1. Approve architecture design
2. Build Context Engine
3. Build Evidence Engine
4. Build Intent Recognition
5. Build Response Generator
6. Build APIs
7. Build Chat UI (Phase 28)
8. Integration testing
9. Beta testing with real accounts
10. LLM integration (Phase 28+)
