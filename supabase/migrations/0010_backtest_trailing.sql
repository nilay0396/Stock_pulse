-- Backtests: align historical validation with target-1 partial booking and trailing continuation.

alter table backtest_trades
  add column if not exists target1_date text,
  add column if not exists target1_price numeric,
  add column if not exists trailing_stop numeric,
  add column if not exists partial_exit_pct numeric not null default 50;

alter table backtest_trades
  drop constraint if exists backtest_trades_outcome_check;

alter table backtest_trades
  add constraint backtest_trades_outcome_check check (
    outcome in (
      'hit_target',
      'target_1_hit',
      'hit_stop',
      'hit_trailing_stop',
      'time_stop',
      'no_entry',
      'no_data',
      'error'
    )
  );

create index if not exists idx_backtest_trades_partial_trailing
  on backtest_trades(backtest_run_id, outcome, trailing_stop)
  where outcome in ('target_1_hit', 'hit_trailing_stop');
