# Meta Ads Intelligence System
## Phase 1 — Foundation

Single-user internal system for managing and analyzing Meta Ads campaigns.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 5 |
| Database | SQLite (sql.js) |
| Meta API | axios |

---

## Project Structure

```
meta-ads-system/
├── src/
│   ├── app.js                    # Entry point — boots server
│   ├── api/
│   │   ├── router.js             # Main API router
│   │   └── routes/
│   │       ├── campaigns.js      # GET /campaigns
│   │       ├── accounts.js       # Account management
│   │       └── sync.js           # POST /sync
│   ├── db/
│   │   ├── database.js           # SQLite connection + query helpers
│   │   └── schema.js             # Table definitions + migrations
│   ├── services/
│   │   ├── metaApiClient.js      # Meta Graph API calls
│   │   ├── syncService.js        # Fetch from Meta → upsert to DB
│   │   └── objectiveMapper.js    # Meta objective → internal enum
│   └── middleware/
│       └── errorHandler.js       # Global error handling
├── scripts/
│   ├── seed.js                   # Insert test data (no Meta API needed)
│   └── verify.js                 # End-to-end test suite
├── data/                         # SQLite database file (auto-created)
├── .env.example                  # Environment config template
└── package.json
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your Meta App credentials
```

### 3. Seed test data (no Meta API required)
```bash
npm run seed
```

### 4. Start the server
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 5. Verify everything works
```bash
# In a second terminal (server must be running):
npm test
```

---

## API Endpoints

### Health
```
GET /api/v1/health
```

### Campaigns (Phase 1 primary endpoint)
```
GET /api/v1/campaigns
GET /api/v1/campaigns?status=active
GET /api/v1/campaigns?objective=messaging
GET /api/v1/campaigns?account_id=<uuid>
GET /api/v1/campaigns?limit=20&offset=0
GET /api/v1/campaigns/:id
```

### Ad Accounts
```
GET  /api/v1/accounts
POST /api/v1/accounts          { meta_account_id, access_token, client_label }
PATCH /api/v1/accounts/:id     { client_label, attribution_window_days, status }
```

### Sync (triggers Meta API fetch → DB upsert)
```
POST /api/v1/sync              { account_id? }
GET  /api/v1/sync/status
```

---

## Connecting a Real Meta Ad Account

1. Get a Meta User Access Token with `ads_read` permission
2. Call `POST /api/v1/accounts` with your account ID and token
3. Call `POST /api/v1/sync` to fetch campaigns
4. Call `GET /api/v1/campaigns` to verify

```bash
# Connect account
curl -X POST http://localhost:3000/api/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "meta_account_id": "act_YOUR_ACCOUNT_ID",
    "access_token": "YOUR_META_TOKEN",
    "client_label": "My Business"
  }'

# Sync campaigns
curl -X POST http://localhost:3000/api/v1/sync

# View campaigns
curl http://localhost:3000/api/v1/campaigns
```

---

## Database

SQLite file is stored at `./data/meta_ads.db` (auto-created on first run).

### Tables (Phase 1)
- `users` — single operator record
- `ad_accounts` — connected Meta ad accounts
- `campaigns` — synced from Meta
- `ad_sets` — synced from Meta
- `ads` — synced from Meta

### No metrics stored
All performance metrics come live from Meta API (Phase 2+).

---

## Phase 1 Scope (Complete)

✅ Database schema with 5 core tables  
✅ Meta API client with pagination and rate limit retry  
✅ Sync service: fetch → upsert campaigns, ad sets, ads  
✅ `GET /campaigns` returns DB data with filters and pagination  
✅ Objective mapping (Meta API → internal enum)  
✅ Upsert idempotency (safe to sync multiple times)  
✅ Error handling middleware  
✅ Test/verification script  

## Out of Scope (Phase 1)

❌ Health scores  
❌ Recommendations  
❌ Alerts  
❌ Benchmarks  
❌ Business inputs  
❌ Metrics / insights storage  
❌ Authentication middleware  
❌ Caching  

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | 3000 | HTTP server port |
| `NODE_ENV` | No | development | Environment |
| `META_APP_ID` | Yes* | — | Meta App ID |
| `META_APP_SECRET` | Yes* | — | Meta App Secret |
| `META_API_VERSION` | No | v21.0 | Meta API version |
| `DB_PATH` | No | ./data/meta_ads.db | SQLite file path |

*Required for real Meta API calls. Not needed for seeded test data.
