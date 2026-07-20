-- Phase 6: live recommendation lifecycle tracking.

create extension if not exists pgcrypto;

create table if not exists recommendation_lifecycle (
  id uuid primary key default gen_random_uuid(),
  trade_idea_id uuid not null references trade_ideas(id) on delete cascade,
  report_run_id uuid not null references report_runs(id) on delete cascade,
  original_run_date text not null,
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
  status text not null default 'pending_entry' check (
    status in ('pending_entry', 'active', 'hit_target', 'hit_stop', 'expired', 'no_entry', 'no_data', 'error')
  ),
  current_price numeric,
  entry_date text,
  entry_price numeric,
  exit_date text,
  exit_price numeric,
  return_pct numeric,
  days_active integer not null default 0,
  last_checked_at timestamptz,
  status_note text,
  ai_followup text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trade_idea_id)
);

create index if not exists idx_recommendation_lifecycle_status on recommendation_lifecycle(status);
create index if not exists idx_recommendation_lifecycle_symbol on recommendation_lifecycle(symbol);
create index if not exists idx_recommendation_lifecycle_report_run on recommendation_lifecycle(report_run_id);
create index if not exists idx_recommendation_lifecycle_updated_at on recommendation_lifecycle(updated_at desc);

