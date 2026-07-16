-- Phase 2: report/scoring pipeline output tables + market-flows data tables.
-- Ported from backend/models.py + backend/db.py (MongoDB collections) per
-- the Phase 2 route/schema research. No writers exist yet (Phase 3/4) —
-- these tables are empty until ingestion + the pipeline land.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Report pipeline output
-- ---------------------------------------------------------------------

create table if not exists report_runs (
  id uuid primary key default gen_random_uuid(),
  run_date text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  error text,
  -- Heterogeneous blob: macro snapshot, funnel stats, excluded_by_earnings,
  -- lite_rank_top, etc. Multiple ad-hoc sub-keys read by different routes —
  -- kept as JSON rather than normalized, matching the Python system.
  summary jsonb not null default '{}'::jsonb,
  narrative text,
  triggered_by text
);
create index if not exists idx_report_runs_started_at on report_runs(started_at desc);
create index if not exists idx_report_runs_status on report_runs(status);

create table if not exists trade_ideas (
  id uuid primary key default gen_random_uuid(),
  report_run_id uuid not null references report_runs(id) on delete cascade,
  symbol text not null,
  name text,
  sector text,
  direction text check (direction in ('bullish', 'bearish', 'watch', 'avoid')),
  horizon text check (horizon in ('weekly', 'monthly')),
  setup_type text,
  conviction numeric,
  entry_low numeric,
  entry_high numeric,
  stop_loss numeric,
  target_low numeric,
  target_high numeric,
  reasons text[] not null default '{}',
  risks text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_trade_ideas_run_conviction on trade_ideas(report_run_id, conviction desc);

create table if not exists stock_scores (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  as_of timestamptz not null default now(),
  report_run_id uuid references report_runs(id) on delete cascade,
  technical numeric,
  fundamental numeric,
  valuation numeric,
  ownership numeric,
  analyst numeric,
  event_news numeric,
  macro_sector numeric,
  conviction numeric,
  direction text,
  reasons text[] not null default '{}',
  risks text[] not null default '{}',
  setup_type text
);
create index if not exists idx_stock_scores_symbol_asof on stock_scores(symbol, as_of desc);

create table if not exists technical_snapshots (
  symbol text primary key,
  as_of timestamptz not null default now(),
  last_close numeric,
  change_pct_1d numeric,
  change_pct_1w numeric,
  change_pct_1m numeric,
  rsi_14 numeric,
  sma_20 numeric,
  sma_50 numeric,
  sma_100 numeric,
  sma_200 numeric,
  ema_20 numeric,
  ema_50 numeric,
  macd numeric,
  macd_signal numeric,
  macd_hist numeric,
  bb_upper numeric,
  bb_lower numeric,
  bb_mid numeric,
  atr_14 numeric,
  volatility_20 numeric,
  volume_spike numeric,
  volume_avg_20 numeric,
  relative_strength numeric,
  setup text check (setup in ('breakout', 'pullback', 'range', 'downtrend', 'neutral'))
);

-- ---------------------------------------------------------------------
-- News
-- ---------------------------------------------------------------------

create table if not exists news_items (
  id uuid primary key default gen_random_uuid(),
  symbol text,
  headline text,
  source text,
  url text,
  sentiment numeric,
  category text,
  published_at timestamptz,
  ingested_at timestamptz not null default now()
);
create index if not exists idx_news_items_ingested_at on news_items(ingested_at desc);
create index if not exists idx_news_items_symbol on news_items(symbol);

-- ---------------------------------------------------------------------
-- Flows / market-wide data
-- ---------------------------------------------------------------------

create table if not exists fii_dii_flows (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  date text,
  buy_value numeric,
  sell_value numeric,
  net_value numeric,
  ingested_at timestamptz not null default now()
);
create index if not exists idx_fii_dii_flows_ingested_at on fii_dii_flows(ingested_at desc, category);

create table if not exists insider_trades (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  company text,
  acquirer text,
  category text,
  tx_type text,
  shares bigint,
  value numeric,
  tx_date_from text,
  disclosure_date text,
  broadcast_date text,
  tx_date_to text,
  remarks text,
  raw jsonb not null default '{}'::jsonb,
  ingested_at timestamptz not null default now()
);
create index if not exists idx_insider_trades_symbol_disclosure on insider_trades(symbol, disclosure_date desc);

create table if not exists geopolitics_events (
  id uuid primary key default gen_random_uuid(),
  title text,
  url text,
  source text,
  published_at text,
  language text,
  country text,
  tone numeric,
  ingested_at timestamptz not null default now()
);
create index if not exists idx_geopolitics_events_ingested_at on geopolitics_events(ingested_at desc);

create table if not exists bhavcopy_rows (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  date text,
  prev_close numeric,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  avg_price numeric,
  traded_qty bigint,
  turnover_lacs numeric,
  trades bigint,
  deliv_qty bigint,
  deliv_pct numeric,
  as_of text,
  ingested_at timestamptz not null default now()
);
create index if not exists idx_bhavcopy_rows_symbol_asof on bhavcopy_rows(symbol, as_of desc);

-- Truncate-and-reload table: Phase 3/4 ingestion wipes and fully reinserts
-- this table every run, so a plain SELECT is always "latest snapshot" —
-- no as_of filtering needed in read routes.
create table if not exists sector_indices (
  id uuid primary key default gen_random_uuid(),
  index text not null,
  symbol text,
  last numeric,
  prev_close numeric,
  open numeric,
  high numeric,
  low numeric,
  change numeric,
  change_pct numeric,
  year_high numeric,
  year_low numeric,
  pe numeric,
  pb numeric,
  div_yield numeric,
  as_of timestamptz not null default now()
);

create table if not exists corp_announcements (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  description text,
  subject text,
  attachment text,
  disclosure_time timestamptz,
  time_diff text,
  ingested_at timestamptz not null default now()
);
create index if not exists idx_corp_announcements_disclosure on corp_announcements(disclosure_time desc);

create table if not exists corp_actions (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  series text,
  subject text,
  ex_date text,
  record_date text,
  bc_start text,
  bc_end text,
  face_value numeric,
  industry text,
  ingested_at timestamptz not null default now()
);
create index if not exists idx_corp_actions_exdate_symbol on corp_actions(ex_date, symbol);

create table if not exists shareholding_filings (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  name text,
  date text,
  xbrl text,
  pdf text,
  description text,
  ingested_at timestamptz not null default now()
);
create index if not exists idx_shareholding_filings_symbol_date on shareholding_filings(symbol, date desc);

-- Upsert-keyed table: continuously updated in place by series_id, not
-- append-only, unlike the other flows tables.
create table if not exists fred_macro (
  series_id text primary key,
  date text,
  value numeric,
  prev numeric,
  change numeric,
  key text,
  ingested_at timestamptz not null default now()
);

create table if not exists fmp_fundamentals (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  ratios_ttm jsonb not null default '{}'::jsonb,
  metrics_ttm jsonb not null default '{}'::jsonb,
  estimates jsonb not null default '[]'::jsonb,
  ingested_at timestamptz not null default now()
);
create index if not exists idx_fmp_fundamentals_symbol_ingested on fmp_fundamentals(symbol, ingested_at desc);

-- Truncate-and-reload-scoped table: Phase 3/4 deletes rows where
-- period='Upcoming' then bulk-inserts fresh ones each run.
create table if not exists financial_results (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  company text,
  bm_date text,
  bm_date_raw text,
  purpose text,
  bm_desc text,
  period text not null default 'Upcoming',
  as_of timestamptz not null default now()
);
create index if not exists idx_financial_results_symbol_bmdate on financial_results(symbol, bm_date);

-- ---------------------------------------------------------------------
-- GET /macro/sectors aggregation — ported from the in-Python loop in
-- backend/routes/macro.py as a real SQL LEFT JOIN + GROUP BY (per Phase 2
-- decision), rather than pulling rows into the app and aggregating there.
-- Deliberate deviation from upstream: the Python version caps its source
-- read at 500 technical_snapshots rows before aggregating (an artifact of
-- `.to_list(500)`); this function aggregates the full table instead.
-- ---------------------------------------------------------------------
create or replace function macro_sector_breadth()
returns table (
  sector text,
  count bigint,
  day_pct numeric,
  week_pct numeric,
  month_pct numeric
)
language sql
stable
as $$
  select
    coalesce(u.sector, 'Other') as sector,
    count(*) as count,
    round(avg(coalesce(t.change_pct_1d, 0))::numeric, 2) as day_pct,
    round(avg(coalesce(t.change_pct_1w, 0))::numeric, 2) as week_pct,
    round(avg(coalesce(t.change_pct_1m, 0))::numeric, 2) as month_pct
  from technical_snapshots t
  left join stock_universe u on u.symbol = t.symbol
  group by coalesce(u.sector, 'Other')
  order by month_pct desc;
$$;
