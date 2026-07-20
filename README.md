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

## GitHub Actions backup scheduler

GitHub Actions owns the primary report cron at 09:00 and 13:00 IST. For a
second safety clock, configure an external cron monitor such as cron-job.org to
call the Netlify backup endpoint shortly after each slot:

```text
https://<netlify-site>/.netlify/functions/report-scheduler-backup?slot=09
https://<netlify-site>/.netlify/functions/report-scheduler-backup?slot=13
```

Use method `POST` if the scheduler supports it, otherwise `GET` is accepted.
Add header:

```text
x-scheduler-secret: <REPORT_BACKUP_SECRET>
```

Required Netlify environment variables:

| Key | Description |
|---|---|
| `REPORT_BACKUP_SECRET` | Shared secret required by the backup endpoint |
| `GITHUB_WORKFLOW_TOKEN` | Fine-grained GitHub PAT with Actions read/write and Contents read |
| `GITHUB_WORKFLOW_OWNER` | Optional, defaults to `nilay0396` |
| `GITHUB_WORKFLOW_REPO` | Optional, defaults to `Stock_pulse` |
| `GITHUB_WORKFLOW_FILE` | Optional, defaults to `daily-report.yml` |
| `GITHUB_WORKFLOW_REF` | Optional, defaults to `main` |

The endpoint is slot-aware: it checks Supabase and recent GitHub workflow runs
for the requested slot before dispatching, so the backup should skip when the
normal scheduler has already run.

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

## Recommendation follow-up

Daily report ideas are registered in `recommendation_lifecycle` and reviewed on
later report runs until they resolve. The pipeline checks forward OHLC against
the original entry, stop and target levels, then classifies each idea as
`pending_entry`, `active`, `hit_target`, `hit_stop`, `expired`, `no_entry`,
`no_data`, or `error`.

The daily email, Telegram report, and in-app report preview include:

- new weekly/monthly ideas for the day
- active follow-ups from previous reports
- resolved follow-ups with return, days active and outcome note

Weekly ideas are tracked for 7 calendar days and monthly ideas for 30 calendar
days unless target or stop is hit first.

## Recommendation hardening

The report pipeline now applies a stricter decision loop after raw scoring:

```text
Full-universe score -> official-data enrichment -> regime/calibration gates
-> structure-aware entry/stop/target -> F&O context when available
-> AI/risk reviewer -> persisted ideas
```

Official NSE/BSE tables already modeled in Supabase are consumed when present:
`bhavcopy_rows`, `financial_results`, `corp_announcements`, `corp_actions`,
`shareholding_filings`, `insider_trades`, and `fii_dii_flows`. These feeds
affect hard filters, ownership/news scores, earnings-risk penalties and final
review context. If a cloud run cannot populate NSE/BSE tables, the pipeline
continues with neutral/fallback inputs rather than fabricating data.

Run official-data ingestion from a residential/home machine before the report
cron when NSE/BSE blocks cloud IPs:

```powershell
$env:SUPABASE_URL="<your supabase url>"
$env:SUPABASE_SERVICE_ROLE_KEY="<your service role key>"
powershell -ExecutionPolicy Bypass -File C:\Users\nilay\Downloads\Market-pulse-main\Market-pulse-main\scripts\run-official-ingest.ps1 -Days 7
```

Recommended Windows Task Scheduler timing: 08:40 IST and 12:40 IST, before the
09:00/13:00 report runs. This runner is best-effort per feed; one blocked NSE
endpoint does not stop the other feeds from loading.

Optional Kite WebSocket streaming runs as a local/VM agent, not inside Netlify
Functions. Run `supabase/migrations/0008_live_ticks.sql` first, then start:

```powershell
cd C:\Users\nilay\Downloads\Market-pulse-main\Market-pulse-main\netlify\functions
$env:SUPABASE_URL="<your supabase url>"
$env:SUPABASE_SERVICE_ROLE_KEY="<your service role key>"
$env:KITE_API_KEY="<your kite api key>"
$env:KITE_STREAM_SYMBOLS="RELIANCE,TCS,HDFCBANK,ICICIBANK,INFY,SBIN" # optional always-on symbols
$env:KITE_STREAM_MAX_SYMBOLS="150"
npm.cmd run stream:kite
```

The agent stores latest ticks in `live_ticks`. It automatically streams manual
symbols plus active/pending recommendation lifecycle symbols and recent report
ideas, refreshing subscriptions every 5 minutes. Keep it on a home machine,
small VPS, or always-on desktop session; serverless functions are not suitable
for holding an all-day broker WebSocket.

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
| Official NSE/BSE filings + delivery archives | **wired, best-effort** | Home-machine runner recommended when cloud IPs are blocked |
| Kite WebSocket ticks | **wired as local agent** | Run `npm run stream:kite` outside Netlify |
| Analyst consensus (fine-grained) | **not wired** | Refinitiv / Bloomberg / Tickertape API |
| Corporate actions / events | **wired from official tables** | Paid APIs can improve coverage/reliability |

All the above can be plugged in by adding a new adapter under `backend/connectors/` and
registering it. Business logic (scoring, ideas, report) will automatically consume the
additional data once it lands in the normalized collections.
