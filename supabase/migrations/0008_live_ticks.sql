-- Live market tick cache fed by the optional Kite WebSocket agent.

create extension if not exists pgcrypto;

create table if not exists live_ticks (
  instrument_token bigint primary key,
  symbol text,
  exchange text not null default 'NSE',
  last_price numeric,
  change_pct numeric,
  volume_traded numeric,
  average_traded_price numeric,
  total_buy_quantity numeric,
  total_sell_quantity numeric,
  oi numeric,
  ohlc jsonb not null default '{}'::jsonb,
  depth jsonb not null default '{}'::jsonb,
  exchange_timestamp timestamptz,
  received_at timestamptz not null default now(),
  source text not null default 'kite_websocket'
);

create index if not exists idx_live_ticks_symbol on live_ticks(symbol);
create index if not exists idx_live_ticks_received_at on live_ticks(received_at desc);
