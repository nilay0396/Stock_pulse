# Market Pulse India

> **Current live stack:** `frontend/` + `netlify/functions/` + `supabase/migrations/`
> + `.github/workflows/`. The old Python/FastAPI/Mongo implementation has been
> moved to `legacy/python-fastapi/` for reference only and is not deployed.

An institutional-grade AI market intelligence and trade-idea platform for Indian equities. It
continuously ingests global macro, Indian indices, stock OHLCV, company fundamentals, news and
analyst sentiment, runs a multi-factor scoring engine, and produces a daily morning brief
(07:00 IST) delivered via Telegram + Gmail.

> Live deployment currently runs on Netlify Functions + Supabase, with GitHub Actions
> running the daily report pipeline at 07:00 IST on weekdays.

## Architecture

```
frontend (React, CRA)                   backend (FastAPI)
  ├ App shell / router             ──► /api/auth, /api/preferences
  ├ Dashboard / Trade Ideas             /api/reports, /api/ideas, /api/stocks
  ├ Stock Explorer + Detail             /api/macro, /api/news
  ├ Macro / Sectors / News              /api/admin/*  (role=admin)
  ├ Report Preview + History        ┌─► MongoDB (motor + AsyncIOMotorClient)
  ├ Delivery Logs                   │
  └ Admin (Connectors / Settings /  │   connectors/   yfinance adapters + health tracker
           Users / Audit)           │   services/
                                    │     indicators  RSI / SMA / EMA / MACD / BB / ATR
                                    │     scoring     7 weighted factors → conviction
                                    │     sentiment   Anthropic Claude narrative + scoring helpers
                                    │     report      orchestration pipeline
                                    │     delivery_*  Telegram + Gmail SMTP (dry-run-safe)
                                    │     settings    runtime config (editable via Admin UI)
                                    │   scheduler     APScheduler cron @ 07:00 IST
                                    └── auth          JWT + bcrypt + admin seeding
```

## Running locally in the preview pod

Supervisor already runs FastAPI on `:8001` and React on `:3000`. Defaults:

- Admin: `admin@marketpulse.in` / `Admin@12345`
- Stock universe is seeded automatically on first boot:
  1. **Curated**: 51 large-cap NSE symbols with hand-mapped sector tags.
  2. **Full NSE**: `EQUITY_L.csv` is pulled from `nsearchives.nseindia.com` and
     all EQ-series listings (~2,000+) are upserted. Curated sectors are
     preserved; the rest land as `sector="Other"` until enriched.
- The daily report runs an **institutional 3-stage funnel**, not a flat scan:
  1. **Stage 1 (cheap, full universe)**: NSE bhavcopy → liquidity / price /
     delivery gates → batched yfinance OHLC for survivors → lightweight
     technical composite → top-200 shortlist.
  2. **Stage 2 (deep, only on shortlist)**: yfinance `.info`, FMP
     fundamentals, shareholding, RSS news, Claude sentiment, NSE corp
     actions / announcements, earnings calendar.
  3. **Stage 3**: existing 7-factor strict scoring → 5-15 weekly + monthly
     ideas. Funnel telemetry persisted on every run for dashboard transparency.
- If NSE bhavcopy is rate-limited, the funnel **gracefully falls back** to the
  curated 51-stock universe so the daily run never collapses.
- Scheduler ticks at 07:00 IST daily (configurable from Admin → Settings).

## Environment variables

Backend (`/app/backend/.env`):

| Key | Description |
|---|---|
| `MONGO_URL` | Mongo connection string (preset to local) |
| `DB_NAME` | Mongo database name |
| `CORS_ORIGINS` | Comma-separated allow-list |
| `ANTHROPIC_API_KEY` | Anthropic key used for report narrative and AI analysis |
| `JWT_SECRET`, `JWT_ALGORITHM`, `JWT_EXPIRE_HOURS` | Token signing |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Seeded on first run |
| `REPORT_CRON_HOUR`, `REPORT_CRON_MINUTE` | Defaults for daily schedule |

Runtime config lives in the **`system_settings`** Mongo collection and can be edited via
**Admin → Settings**:

- `telegram_bot_token`, `telegram_default_chat_id`
- `gmail_address`, `gmail_app_password`, `gmail_from_name`, `smtp_host`, `smtp_port`
- `report_hour`, `report_minute`, `dry_run`

Telegram and Gmail delivery are wired and live once credentials are saved in
**Admin -> Settings** and dry-run is disabled. Delivery attempts are recorded in
the Delivery Logs page; admins see all deliveries, users see their own delivery history.

## Data sources (connector registry)

- `yfinance_macro` — NIFTY, BANKNIFTY, INDIAVIX, USDINR, DXY, crude, gold, silver, copper, US2Y/10Y, SP500/NASDAQ/NIKKEI/HANGSENG/BTC.
- `yfinance_equities` — OHLCV history (1y), batched, **only on Stage-1 funnel survivors** (~600-900 stocks per day).
- `yfinance_news` — per-symbol Yahoo Finance headlines, **only on Stage-2 shortlist** (~200).
- `nse_equity_list` — `EQUITY_L.csv` master list (Stage 0 universe seed).
- `nse_bhavcopy` — daily EOD OHLCV + delivery % for the entire EQ-series market.
- `nse_fii_dii`, `nse_sector_indices`, `nse_corp_announcements`, `nse_corp_actions`,
  `nse_insider`, `nse_shareholding`, `nse_financial_results` — keyless NSE feeds.
- `gdelt_news` — global-events feed for geopolitics scoring.
- `rss_news` — multi-source RSS (Economic Times, Business Standard, Moneycontrol,
  Reuters) merged with yfinance news for the Stage-2 shortlist.
- `fmp_fundamentals`, `fred_macro` — optional, gracefully skipped when API key absent.

The `BaseConnector` handles retries (3), exponential backoff, duration stats, success/failure
counts, and persists every run in `ingestion_runs`. To swap any adapter for a paid source
(NSE official, EODHD, Alpha Vantage, Trendlyne, Tickertape, Finnhub, etc.), implement the
same `fetch()` contract and register it in `connectors/registry.py`.

## Scoring engine

```
conviction = 0.20·technical + 0.25·fundamental + 0.10·valuation
           + 0.10·ownership + 0.10·analyst + 0.15·event_news + 0.10·macro_sector
```

Each sub-score emits an explainable reason list. Direction classification uses conviction
+ technical + macro alignment. Ideas generate entry / stop / target bands from live ATR.

## Morning report pipeline (institutional 3-stage funnel)

```
Stage 0  Universe load          → ~2,000 EQ-series stocks (NSE EQUITY_L)
Stage 1  Market-wide ingest     → macro, bhavcopy, FII/DII, sector indices, GDELT, FRED
         Bhavcopy gates         → price ≥ ₹50, turnover ≥ ₹1 Cr, delivery ≥ 20 %
         Batched yfinance OHLC  → 1-yr daily for survivors only
         Lightweight ranking    → trend, RSI, momentum, volume spike, RS, ATR band
         → top 200 shortlist
Stage 2  Deep ingest (only 200) → yfinance .info, FMP, shareholding, news,
                                  Claude sentiment, NSE corp actions / announcements,
                                  earnings calendar
Stage 3  7-factor scoring       → conviction + direction + horizon
         Hard filters + earnings event-risk dampening
         → 5-15 weekly + monthly ideas
         → Claude Sonnet 4.5 narrative
         → persist report_runs / stock_scores / trade_ideas / news_items / funnel
         → deliver to every user (Telegram summary + Gmail HTML report)
         → store per-user delivery receipts with status / errors / dry_run flags
```

Funnel telemetry (universe → prefilter → shortlist → scored → ideas) is persisted
on every run and rendered as the **Daily Funnel** widget on the Dashboard.

## Endpoints

All prefixed with `/api`.

| Route | Auth | Description |
|---|---|---|
| `POST /auth/register`, `/auth/login`, `GET /auth/me`, `POST /auth/change-password` | mixed | JWT auth |
| `GET/PUT /preferences` | user | user delivery + investing profile |
| `GET /reports/history`, `/reports/latest`, `/reports/{id}` | user | daily briefs |
| `POST /reports/run`, `/reports/run-sync` | admin | manual trigger |
| `GET /ideas`, `/ideas/scores`, `/ideas/scores/{symbol}` | user | signals |
| `GET /stocks/universe`, `/stocks/{symbol}`, `/stocks/{symbol}/history` | user | stock detail |
| `GET /macro`, `/macro/sectors` | user | macro + sector breadth |
| `GET /news` | user | news feed |
| `GET /admin/connectors`, `POST /admin/connectors/{name}/run` | admin | connector control |
| `GET /admin/ingestion-runs`, `/admin/deliveries`, `/admin/audit` | admin | logs |
| `GET/PUT /admin/settings` | admin | runtime config |
| `POST /admin/test/telegram`, `/admin/test/email` | admin | test sends |
| `GET /admin/users`, `POST /admin/users/{id}/role`, `.../reset-password` | admin | user mgmt |
| `GET /admin/scheduler`, `POST /admin/seed-universe` | admin | scheduler + seeder |
| `GET /health`, `/readiness` | public | health checks |

## Deployment (reference, outside the preview pod)

```
cp deploy/.env.example .env.production
docker compose -f deploy/docker-compose.yml up -d --build
```

Nginx proxies `/api/*` → backend and serves the React build from root.

## What still requires paid / external credentials

| Area | Status | What's needed |
|---|---|---|
| Telegram delivery | **wired/live** | Bot token from @BotFather, chat IDs per user |
| Gmail delivery   | **wired/live** | Gmail account + 16-char App Password (2FA enabled) |
| LLM (sentiment + narrative) | **wired** | `ANTHROPIC_API_KEY` |
| Official NSE snapshot feeds | **not wired** | Paid license. `yfinance` used as free fallback. |
| Analyst consensus (fine-grained) | **not wired** | Refinitiv / Bloomberg / Tickertape API |
| Corporate actions / events | **not wired** | Tickertape / Trendlyne / CMOTS |

All the above can be plugged in by adding a new adapter under `backend/connectors/` and
registering it. Business logic (scoring, ideas, report) will automatically consume the
additional data once it lands in the normalized collections.
