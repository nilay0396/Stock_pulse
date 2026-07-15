# Market Pulse India — PRD

## Original Problem Statement
An institutional-grade AI market intelligence and trade-idea platform that scans global
financial markets, geopolitics, commodities, industry news, company-specific developments,
macro events, ownership trends, analyst sentiment, technical indicators, and company
fundamentals to determine which Indian stocks may be good candidates for weekly and monthly
trades. Generates a daily morning report at 07:00 IST delivered to subscribers.

## User Choices (2026-04-21)
- Stack: React + FastAPI + MongoDB inside the Emergent preview pod. Docker/compose/nginx
  reference artefacts kept under `/app/deploy/` for later self-hosting.
- Market data: yfinance (NSE `.NS`, macro tickers).
- LLM: Claude Sonnet 4.5 via Emergent Universal Key (news sentiment + report narrative).
- Delivery: Telegram bot + Gmail SMTP. Credentials *not* shared yet — both stay in DRY-RUN
  until admin fills them under Admin → Settings.
- Scheduling: APScheduler cron (07:00 IST).
- Admin: `nilay0396@gmail.com` / `Admin@12345`, changeable via Preferences → Change password.

## Personas
1. **Subscriber** — Indian retail / HNI investor. Wants a morning brief with actionable
   weekly + monthly trade ideas, disclaimer included.
2. **Portfolio manager / boutique firm** — uses the dashboard during market hours for macro
   ticker, sector breadth, ideas table, stock drilldown.
3. **Platform admin** — monitors connector health, reruns report, manages users, configures
   delivery credentials, views audit + delivery logs.

## Core Requirements (implemented)
- JWT auth with admin role, admin seeding, change-password, role management.
- User preferences: telegram chat id, email alerts toggle, horizon, risk appetite, sectors,
  watchlist, language.
- Connector architecture with retries, health tracking, ingestion-run records.
- 3 connectors: yfinance_macro, yfinance_equities, yfinance_news.
- Technical indicators in backend (RSI, SMA/EMA 20/50/100/200, MACD, Bollinger, ATR,
  volatility, relative strength vs NIFTY, volume spike, setup classification).
- 7-factor scoring (technical, fundamental, valuation, ownership, analyst, event_news,
  macro_sector) with documented weights (0.20/0.25/0.10/0.10/0.10/0.15/0.10) and explainable
  reasons per sub-score.
- Trade-idea generation with entry/stop/target zones from live ATR, direction, setup type.
- Report pipeline (macro → equities → technicals → fundamentals → news/sentiment → scores
  → ideas → narrative → persist → deliver).
- Telegram + Gmail delivery with dry-run safety, retries, per-user delivery records.
- APScheduler daily cron at 07:00 IST, rescheduleable at runtime.
- Admin: connectors, ingestion runs, deliveries, settings, users, audit logs, test-send.
- 15 frontend pages covering all operational + end-user flows.
- Production reference: Dockerfiles + docker-compose + nginx.conf under `/app/deploy/`.

## Implemented (Timeline)
- **2026-04-21**: MVP complete. Admin seeded, universe seeded (52 NSE symbols), first
  report successfully generated (51 scored, 16 ideas), scheduler armed for 07:00 IST.
  Testing agent iteration_1 flagged one HIGH bug (ObjectId serialization in reports/history)
  + testid gaps → fixed via `utils.clean()` helper; iteration_2 returned zero issues.
- **2026-04-21 (later)**: Implemented the exact strict scoring spec
  `Final = 0.22T + 0.20F + 0.10V + 0.10O + 0.08A + 0.18N + 0.12M` with trade-rules
  Weekly (≥72 & Tech≥70) / Monthly (≥75 & Fund≥70 & Macro≥65).
  After the first tight run produced 0 ideas, added hybrid universe normalization:
  `scoring.HYBRID_ALPHA` + `scoring.normalize_subscores_universe()` blends each sub-score
  with its universe percentile rank. Alpha map:
  T=0.35, F=0.50, V=0.30, O=0.45, A=0.40, N=0.35, M=0.50 — more relative where the
  component is peer-comparative (growth, sector rank, sentiment intensity), more
  absolute where it's a regime/safety variable. `score_event_news` no longer penalises
  stocks with 0 headlines (returns neutral 50 so they aren't pulled below peers with
  neutral news). News ingestion expanded from top-12 liquid to the full 51-stock
  universe, run in parallel so the peer percentile distribution is meaningful.
  Outcome: ADANIPORTS qualified as a weekly bullish idea (conv=72.04, Tech=92.4)
  with entry ₹1586-1610 / stop ₹1519 / target ₹1743-1818, R/R=2.0. Distribution is
  healthy (top-bucket 70-72 has 1 name, 60-69 has 7 names, 50-59 has 26 names).

- **2026-04-21 (refactor)**: Extracted every connector call out of `report.py` into
  a dedicated `services/ingestion.py` with a typed `IngestedData` dataclass.
  `generate_report()` is now pure orchestration:
  `ingest_all` → snapshots → info cache → news + sentiment → scoring →
  universe-wide hybrid normalization → idea selection → narrative → persist →
  deliver. Each stage is its own function under 50 lines with clear inputs.
- **2026-04-21 (feature)**: NSE results-calendar filter. Added a new
  `NSEFinancialResultsConnector` that pulls NSE's `/api/event-calendar`
  (273 upcoming board meetings today), persisted in `financial_results` Mongo
  collection. `_select_ideas` now excludes any candidate whose next earnings
  fall inside the holding horizon — 10-day safety buffer for weekly (7-day
  holds), 35-day for monthly (30-day holds). Verified on today's run:
  ADANIPORTS (conv=73.06) was correctly excluded because earnings are 9 days
  out, saving the user from holding through a gap. Ideas that pass now carry
  `next_earnings` + `earnings_in_days` metadata for full transparency.
- **2026-04-21 (tests)**: Added `backend/tests/test_pipeline_regression.py` with
  10 unit tests + 1 end-to-end integration test (`skip_llm=True`). All 11 pass
  in ~38s. Registered the `integration` pytest marker in `pytest.ini`.

## P0 Backlog (not yet implemented, paid data needed)
- Official NSE snapshot feed adapter (license).
- Tickertape / Trendlyne / CMOTS for corporate actions, analyst consensus, shareholding.
- Real sentiment-grade news sources (Reuters / PTI) behind an adapter.

## P1 Backlog
- Proper candlestick chart on Stock Detail (currently line + SMA50/200 reference lines).
- Per-user WhatsApp Cloud API channel (currently omitted per user direction).
- User-scoped delivery logs (currently admin-only view).
- Backtest harness for idea historical hit-rate.

## P2 / Later
- Multi-language narrative (Hindi already in prefs, not yet wired into LLM prompt).
- Notebook-export for each report.
- Slack / Discord channels.
- Portfolio tracker beyond watchlist.

## Session Update — 2026-04-27 (Funnel verification + admin transparency)
- **Live pipeline test on full universe**: Triggered an end-to-end run
  via `POST /api/reports/run` and proved the funnel actually scans the
  full NSE EQ-series:
  ```
  Stage 1  Universe scanned   : 2,171 stocks
           Prefilter pool     : 1,256 (passed liquidity + price gates)
           OHLC returned      : 1,256
           Ranked             : 1,232 (lightweight composite)
           Shortlisted        :   200
  Stage 2  Deep-scored        :   200
  Stage 3  Final ideas        :     3 (3 weekly + 0 monthly)
  ```
  `bhavcopy_available=True`, `connector_failures=0`. Ideas surfaced
  (e.g. MAHABANK, HINDZINC) come from the bulk-seeded EQUITY_L
  set — proving the funnel reaches well beyond the curated 51.
- **Admin → NSE Universe panel** (`AdminSettings.jsx`):
  - Live counts: total / curated / newly seeded / ETFs.
  - **"Refresh Full NSE Universe"** button → `POST
    /api/admin/seed-full-universe` → re-pulls EQUITY_L.
  - Backed by lightweight `GET /api/stocks/universe/stats`.
- **Funnel telemetry** now also surfaces
  `connector_failures` + `failed_connectors` array (sourced
  from `ingestion_runs` for the report's `run_id`) so silent
  ingest outages are visible on the dashboard.
- **README** updated with the 3-stage funnel architecture
  and the curated → bulk → fallback universe model.


- **Full universe seeding**: New `NSEEquityListConnector` pulls EQUITY_L.csv
  (NSE master list) → `seed_full_nse_universe()` upserts the full ~2,168
  EQ-series stocks into `stock_universe` while preserving hand-curated
  sector tags on the original 51 large-caps. Auto-runs on every boot;
  also exposed via `POST /api/admin/seed-full-universe`.
- **Stage 1 prefilter** (`services/prefilter.py`):
  - `prefilter_by_bhavcopy(universe, bhav)` — gates on price ≥ ₹50,
    turnover ≥ ₹1 Cr, delivery ≥ 20 %.
  - `lightweight_setup_score(snap)` — 6-component composite (trend,
    RSI, momentum, volume spike, relative strength, ATR band).
  - `rank_and_shortlist(snaps, top_n=200)` — descending sort, returns
    shortlisted universe rows + full lite-rank table for transparency.
- **Stage 1 / Stage 2 split** (`services/ingestion.py`):
  - `ingest_stage1_market_wide` — global single-call sources only
    (macro, bhavcopy, FII/DII, sector indices, GDELT, FRED).
  - `ingest_stage1_ohlc` — batched yfinance OHLC ONLY for the ~600-900
    bhavcopy survivors.
  - `ingest_stage2_deep` — heavy per-symbol blocks (info, FMP,
    shareholding, news, RSS) ONLY on the shortlisted ~200.
- **Pipeline rewrite** (`services/report.py::generate_report`):
  3-stage funnel, with graceful curated-universe fallback if
  bhavcopy is unreachable. All stages instrumented into the
  `funnel` block on each report run.
- **Funnel transparency**:
  - `funnel` field on every report run carries
    {universe_total, prefilter_pool, ohlc_returned, ranked,
     shortlisted, scored, weekly_ideas, monthly_ideas,
     excluded_by_earnings, bhavcopy_available}.
  - `GET /api/reports/{run_id}/funnel` exposes it + the top 100
    rows of the lite-rank table.
  - `FunnelWidget` component on the Dashboard renders animated
    bars for every stage.
- **Tests**: 21 → 27 (added 6 prefilter unit tests). Integration
  test now tolerant of NSE / yfinance rate-limits in CI.

## P1 Backlog (remaining after this session)
- WhatsApp Cloud API delivery channel.
- User-scoped delivery logs (currently admin-only view).
- Lite-rank drilldown UI: clicking a stage in the Funnel widget
  opens the lightweight rank table with reasons.
- ETF separate-track scoring (P1) — once we add an ETF master
  list connector. ETFs are NOT yet in the universe.

## Next Tasks
1. Add real credentials (Telegram bot token + Gmail app password) via Admin → Settings,
   then disable dry-run — the pipeline already handles both channels.
2. Optionally wire a paid data source by adding a new connector under `backend/connectors/`.
3. Run `POST /api/reports/run-sync?skip_llm=false` once to verify Claude narrative on production key.

## Session Update — 2026-02-XX (P0 ingestion upgrade + P1 backtest)
- **Data ingestion upgrade completed**:
  - `services/ingestion.py` orchestrates 14 connectors with telemetry
    (`ingestion_runs`), per-block try/except, and primary/fallback logic.
  - `connectors/rss_news.py` — Multi-source RSS (ET, BS, Moneycontrol,
    Reuters) with hash dedup + per-headline scope classification
    (company / sector / macro). Wired into `_fetch_news_sentiment` so
    per-stock sentiment is no longer yfinance-dependent.
  - `services/commodity_mapping.py` — commodity → sector impact with
    rationale-carrying explanations.
  - Shareholding expanded from top-15 to full 51-stock universe with
    quarter-over-quarter delta computation.
- **Earnings event-risk penalty** (`scoring.apply_earnings_penalty`):
  If next earnings ≤ 7 days out, Technical + event_news sub-scores are
  linearly blended toward a neutral 50 (dampen = (7 − days)/7). Applied
  before hybrid normalization in `_build_score_docs`. Complementary to —
  not replacing — the hard 10d/35d exclusion in `_select_ideas`.
- **Backtest harness** (`services/backtest.py` + `/api/admin/backtest/*`):
  Given any past `report_run_id`, replays every idea on yfinance
  forward prices, simulates entry-band fill → stop / target / time-stop
  exit, persists per-trade outcomes to `backtest_trades` and aggregated
  hit-rate / avg return / avg holding days to `backtest_runs`.
- **Tests**: Regression suite expanded 11 → 21 tests (+6 earnings
  penalty, +4 backtest simulation). All pass in ~35 s.
- **Smoke test**: backtested run `6678d8f4…` (ADANIPORTS weekly idea
  from 2026-04-21) end-to-end — fetched forward prices, simulated, and
  persisted trade + summary successfully.

## P1 Backlog (remaining after this session)
- WhatsApp Cloud API delivery channel.
- User-scoped delivery logs (currently admin-only view).
- Frontend UI pages for backtest results (backend already serves the API).
