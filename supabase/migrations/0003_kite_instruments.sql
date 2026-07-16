-- Phase 3a: Kite Connect instrument master cache.
-- Kite's full instrument dump (~90K rows across all exchanges) is filtered
-- to NSE equities + NFO options for our universe and refreshed daily by
-- netlify/functions/kite-token-refresh.ts. Truncate-and-reload table (same
-- pattern as sector_indices/financial_results in 0002) — always represents
-- the latest dump, no historical versioning needed.

create table if not exists kite_instruments (
  instrument_token bigint primary key,
  tradingsymbol text not null,
  name text,
  expiry date,
  strike numeric,
  instrument_type text check (instrument_type in ('EQ', 'CE', 'PE', 'FUT')),
  segment text,
  exchange text,
  refreshed_at timestamptz not null default now()
);

-- Option-chain assembly: filter by underlying name + type + nearest expiry.
create index if not exists idx_kite_instruments_name_type_expiry
  on kite_instruments(name, instrument_type, expiry);

-- Equity/quote lookups by tradingsymbol.
create index if not exists idx_kite_instruments_tradingsymbol
  on kite_instruments(tradingsymbol);
