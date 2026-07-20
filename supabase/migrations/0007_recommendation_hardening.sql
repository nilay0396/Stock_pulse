-- Recommendation hardening persistence.

create extension if not exists pgcrypto;

alter table trade_ideas add column if not exists risk_reward numeric;
alter table trade_ideas add column if not exists construction text;
alter table trade_ideas add column if not exists market_regime text;
alter table trade_ideas add column if not exists next_earnings text;
alter table trade_ideas add column if not exists earnings_in_days integer;
alter table trade_ideas add column if not exists ai_review jsonb not null default '{}'::jsonb;
alter table trade_ideas add column if not exists fno jsonb not null default '{}'::jsonb;

create table if not exists fno_oi_snapshots (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  expiry text not null,
  strike numeric not null,
  side text not null check (side in ('CE', 'PE')),
  oi numeric,
  change_oi numeric,
  ltp numeric,
  volume numeric,
  iv numeric,
  underlying numeric,
  source text not null default 'kite',
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_fno_oi_snapshots_symbol_time on fno_oi_snapshots(symbol, fetched_at desc);
create index if not exists idx_fno_oi_snapshots_contract on fno_oi_snapshots(symbol, expiry, strike, side, fetched_at desc);

