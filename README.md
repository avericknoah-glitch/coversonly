# LineUp — Backend API

Node.js/Express backend for the LineUp Sports Betting Leagues platform.

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your values (see Configuration below)
```

### 3. Set up the database
```bash
# Option A: Supabase (recommended — free tier)
#   1. Create a project at supabase.com
#   2. Copy the connection string into DATABASE_URL in .env

# Option B: Local PostgreSQL
createdb lineup_db
```

### 4. Run migrations
```bash
npm run db:migrate
```

### 5. (Optional) Seed demo data
```bash
npm run db:seed
# Creates 5 demo users, 1 league, and sample picks
# Login: alex@demo.com / Password123!
```

### 6. Start the server
```bash
npm run dev      # development (auto-restarts)
npm start        # production
```

The API will be running at **http://localhost:3001**

---

## Configuration

| Variable | Description | Required |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `JWT_SECRET` | Long random string for signing tokens | Yes |
| `ODDS_API_KEY` | From [the-odds-api.com](https://the-odds-api.com) (free tier: 500 req/mo) | For live odds |
| `ODDS_REFRESH_INTERVAL_MINUTES` | How often to poll The Odds API (default: 30) | No |
| `ODDS_BOOKMAKERS` | Comma-separated bookmakers (default: draftkings,fanduel,betmgm) | No |
| `ALLOWED_ORIGINS` | Comma-separated frontend URLs for CORS | Yes |
| `PORT` | Server port (default: 3001) | No |

> **No API key?** The server runs fine without one — it serves mock odds data so you can develop the frontend immediately.

---

## API Reference

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Login, receive JWT |
| `GET`  | `/api/auth/me` | Get current user |
| `POST` | `/api/auth/logout` | Logout (client deletes token) |

**Register body:**
```json
{
  "email": "you@example.com",
  "password": "Password123!",
  "username": "sharpshooter99",
  "first_name": "Alex",
  "last_name": "Johnson"
}
```

**Auth header for all protected routes:**
```
Authorization: Bearer <token>
```

---

### Odds
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/odds?sports=nfl,nba` | Events for multiple sports |
| `GET` | `/api/odds/:sport` | Events for one sport |
| `GET` | `/api/odds/:sport/event/:id` | Single event detail |
| `GET` | `/api/odds/admin/cache` | Cache status + API credit usage |

**Supported sport slugs:** `nfl`, `nba`, `mlb`, `nhl`, `ncaafb`, `ncaamb`, `soccer_epl`, `soccer_mls`, `tennis_atp`

**Query params for `/api/odds/:sport`:**
- `?markets=spread,moneyline,totals` — filter bet types

**Example response:**
```json
{
  "sport": "nfl",
  "count": 8,
  "fetchedAt": "2025-01-15T18:00:00.000Z",
  "events": [
    {
      "id": "abc123",
      "sport_key": "americanfootball_nfl",
      "commence_time": "2025-01-19T18:25:00Z",
      "home_team": "Kansas City Chiefs",
      "away_team": "Las Vegas Raiders",
      "lines": {
        "moneyline": {
          "home": { "odds": "-320", "price": -320 },
          "away": { "odds": "+260", "price": 260 }
        },
        "spread": {
          "home": { "point": -6.5, "label": "Kansas City Chiefs -6.5", "odds": "-110", "price": -110 },
          "away": { "point": 6.5,  "label": "Las Vegas Raiders +6.5",  "odds": "-110", "price": -110 }
        },
        "totals": {
          "point": 47.5,
          "over":  { "label": "Over 47.5",  "odds": "-110", "price": -110 },
          "under": { "label": "Under 47.5", "odds": "-110", "price": -110 }
        }
      }
    }
  ]
}
```

---

### Leagues
| Method | Path | Description |
|---|---|---|
| `GET`   | `/api/leagues` | My leagues with standings |
| `GET`   | `/api/leagues/browse` | Public leagues to join |
| `POST`  | `/api/leagues` | Create a league |
| `GET`   | `/api/leagues/:id` | League detail + standings |
| `PATCH` | `/api/leagues/:id` | Update settings (commissioner) |
| `POST`  | `/api/leagues/:id/invite` | Invite a user (commissioner) |
| `POST`  | `/api/leagues/join/:code` | Join via invite code |
| `PATCH` | `/api/leagues/:id/members/:userId/role` | Change member role |

**Create league body:**
```json
{
  "name": "Sunday Ballers",
  "visibility": "private",
  "sports": ["nfl", "nba"],
  "bet_types": ["spread", "moneyline", "totals"],
  "picks_per_week": 5,
  "max_members": 10,
  "pick_deadline": "first_game"
}
```

---

### Picks
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/picks` | Submit picks for the week |
| `GET`  | `/api/picks/my` | My picks (filter: ?league_id, ?week) |
| `GET`  | `/api/picks/league/:id` | All picks in a league (?week=14) |
| `GET`  | `/api/picks/member/:userId/league/:id` | Member's full pick history |

**Submit picks body:**
```json
{
  "league_id": 1,
  "week": 14,
  "picks": [
    {
      "event_id": "abc123",
      "sport": "nfl",
      "bet_type": "spread",
      "selection": "Kansas City Chiefs -6.5"
    },
    {
      "event_id": "def456",
      "sport": "nfl",
      "bet_type": "totals",
      "selection": "Over 47.5"
    }
  ]
}
```

---

### Users
| Method | Path | Description |
|---|---|---|
| `GET`   | `/api/users/:username` | Public profile + lifetime stats |
| `PATCH` | `/api/users/me` | Update own profile |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    FRONTEND                         │
│              (React / your HTML app)                │
└─────────────────┬───────────────────────────────────┘
                  │  REST calls with JWT
                  ▼
┌─────────────────────────────────────────────────────┐
│               LINEUP BACKEND (this)                 │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ /auth    │  │ /leagues │  │ /picks           │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │  Odds Service (in-memory cache + DB cache)  │   │
│  └─────────────┬───────────────────────────────┘   │
│                │                                    │
│  ┌─────────────▼───────────────────────────────┐   │
│  │  Cron Jobs                                  │   │
│  │  • Every 30m: refresh odds from API         │   │
│  │  • Every 1h:  grade pending picks           │   │
│  └─────────────────────────────────────────────┘   │
└──────────┬──────────────────────────┬───────────────┘
           │                          │
           ▼                          ▼
┌──────────────────┐      ┌─────────────────────────┐
│   PostgreSQL DB  │      │   The Odds API          │
│  (Supabase rec.) │      │   the-odds-api.com      │
│                  │      │   Free: 500 req/mo      │
│  users           │      │   $30/mo: 20k req/mo    │
│  leagues         │      └─────────────────────────┘
│  league_members  │
│  events          │
│  picks           │
└──────────────────┘
```

## Credit Management

The Odds API charges **1 credit per request**. Your backend protects your quota by:
1. **Caching** — odds are only re-fetched after `ODDS_REFRESH_INTERVAL_MINUTES`
2. **In-season filtering** — the cron only fetches sports currently in season
3. **Single bookmaker** — pulling one bookmaker instead of many reduces response size but not credit cost (1 request = 1 credit regardless)

**Free tier math (500 credits/month):**
- NFL only, refresh every 30 min, 8 hours/day active window = ~480 req/mo ✅
- NFL + NBA, every 30 min = ~960 req/mo ❌ (upgrade to $30/mo)
- **Recommended dev setting:** `ODDS_REFRESH_INTERVAL_MINUTES=120` until you go live

## Deployment Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use a real `JWT_SECRET` (32+ random chars)
- [ ] Set `DATABASE_URL` to your production Postgres
- [ ] Set `ALLOWED_ORIGINS` to your production frontend domain
- [ ] Enable SSL in DB connection (already handled for `NODE_ENV=production`)
- [ ] Consider a process manager like PM2: `pm2 start server.js`
