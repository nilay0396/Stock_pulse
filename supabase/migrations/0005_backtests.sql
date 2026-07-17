-- Phase 5: backtest audit trail for historical report ideas.

create extension if not exists pgcrypto;

create table if not exists backtest_runs (
  id uuid primary key default gen_random_uuid(),
  report_run_id uuid references report_runs(id) on delete cascade,
  run_date text,
  status text not null default 'running' check (status in ('running', 'success', 'empty', 'failed')),
  triggered_by text,
  summary jsonb not null default '{}'::jsonb,
  trades_count integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists backtest_trades (
  id uuid primary key default gen_random_uuid(),
  backtest_run_id uuid not null references backtest_runs(id) on delete cascade,
  report_run_id uuid references report_runs(id) on delete cascade,
  trade_idea_id uuid references trade_ideas(id) on delete set null,
  symbol text not null,
  name text,
  sector text,
  direction text,
  horizon text,
  conviction numeric,
  entry_low numeric,
  entry_high numeric,
  stop_loss numeric,
  target_low numeric,
  target_high numeric,
  entry_date text,
  exit_date text,
  entry_price numeric,
  exit_price numeric,
  holding_days integer,
  return_pct numeric,
  outcome text not null check (outcome in ('hit_target', 'hit_stop', 'time_stop', 'no_entry', 'no_data', 'error')),
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_backtest_runs_created_at on backtest_runs(created_at desc);
create index if not exists idx_backtest_runs_report_run on backtest_runs(report_run_id);
create index if not exists idx_backtest_trades_run_return on backtest_trades(backtest_run_id, return_pct desc);
