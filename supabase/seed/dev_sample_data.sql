-- DEV-ONLY sample data for verifying Phase 2 read routes end-to-end before
-- Phase 3 (ingestion) and Phase 4 (pipeline) exist to produce real data.
--
-- Safe to run multiple times (deletes its own rows by a fixed report_run id
-- first). DELETE this data (or just re-run migrations against a fresh DB)
-- once real ingestion lands — it will look like a stale/fake report run
-- otherwise.

do $$
declare
  v_run_id uuid := '11111111-1111-1111-1111-111111111111';
begin
  delete from trade_ideas where report_run_id = v_run_id;
  delete from stock_scores where report_run_id = v_run_id;
  delete from report_runs where id = v_run_id;

  insert into report_runs (id, run_date, started_at, finished_at, status, summary, narrative, triggered_by)
  values (
    v_run_id,
    to_char(now(), 'YYYY-MM-DD'),
    now() - interval '10 minutes',
    now(),
    'success',
    jsonb_build_object(
      'funnel', jsonb_build_object('universe_total', 51, 'prefilter_pool', 20, 'shortlisted', 6, 'scored', 6),
      'excluded_by_earnings', '[]'::jsonb
    ),
    'Dev sample report run for Phase 2 verification. Markets showed a mixed-to-positive tone with IT and Banking leading.',
    'dev_seed'
  );

  insert into trade_ideas (report_run_id, symbol, name, sector, direction, horizon, setup_type, conviction, entry_low, entry_high, stop_loss, target_low, target_high, reasons, risks)
  values
    (v_run_id, 'HDFCBANK', 'HDFC Bank', 'Banking', 'bullish', 'weekly', 'breakout', 78.5, 1650, 1665, 1610, 1720, 1760,
      array['Price above all key SMAs', 'RSI in bullish momentum zone', 'Above-average volume on breakout'],
      array['Elevated INDIAVIX']),
    (v_run_id, 'TCS', 'Tata Consultancy Services', 'IT', 'bullish', 'monthly', 'pullback', 76.2, 3980, 4020, 3900, 4180, 4280,
      array['Golden cross (SMA50 > SMA200)', 'Strong FII inflows', 'Sector breadth positive'],
      array['Elevated volatility']),
    (v_run_id, 'RELIANCE', 'Reliance Industries', 'Energy', 'watch', 'weekly', 'range', 61.0, 2850, 2880, 2790, 2950, 3000,
      array['Range-bound, awaiting catalyst'], array['High leverage'])
  on conflict do nothing;

  insert into stock_scores (symbol, as_of, report_run_id, technical, fundamental, valuation, ownership, analyst, event_news, macro_sector, conviction, direction, reasons, risks, setup_type)
  values
    ('HDFCBANK', now(), v_run_id, 82, 74, 68, 70, 65, 71, 60, 78.5, 'bullish',
      array['Price above all key SMAs', 'RSI in bullish momentum zone'], array['Elevated INDIAVIX'], 'breakout'),
    ('TCS', now(), v_run_id, 79, 80, 55, 72, 70, 66, 62, 76.2, 'bullish',
      array['Golden cross', 'Strong FII inflows'], array['Elevated volatility'], 'pullback'),
    ('RELIANCE', now(), v_run_id, 58, 70, 50, 55, 60, 52, 58, 61.0, 'watch',
      array['Range-bound'], array['High leverage'], 'range')
  on conflict do nothing;

  insert into technical_snapshots (symbol, as_of, last_close, change_pct_1d, change_pct_1w, change_pct_1m, rsi_14, sma_20, sma_50, sma_100, sma_200, ema_20, ema_50, macd, macd_signal, macd_hist, bb_upper, bb_lower, bb_mid, atr_14, volatility_20, volume_spike, volume_avg_20, relative_strength, setup)
  values
    ('HDFCBANK', now(), 1658.4, 0.8, 2.1, 5.4, 62.3, 1630, 1590, 1560, 1520, 1635, 1600, 12.4, 9.1, 3.3, 1670, 1600, 1635, 24.5, 18.2, 1.6, 8200000, 3.2, 'breakout'),
    ('TCS', now(), 4001.2, 0.5, 1.4, 3.8, 58.1, 3950, 3900, 3850, 3700, 3960, 3910, 22.1, 18.5, 3.6, 4050, 3900, 3975, 55.2, 15.8, 1.1, 2900000, 2.1, 'pullback'),
    ('RELIANCE', now(), 2865.0, -0.2, 0.3, 1.1, 49.5, 2860, 2850, 2830, 2800, 2858, 2848, -2.1, -1.0, -1.1, 2920, 2800, 2860, 38.7, 12.4, 0.9, 6100000, -0.4, 'range')
  on conflict (symbol) do update set
    as_of = excluded.as_of, last_close = excluded.last_close, change_pct_1d = excluded.change_pct_1d,
    change_pct_1w = excluded.change_pct_1w, change_pct_1m = excluded.change_pct_1m, rsi_14 = excluded.rsi_14,
    sma_20 = excluded.sma_20, sma_50 = excluded.sma_50, sma_100 = excluded.sma_100, sma_200 = excluded.sma_200,
    ema_20 = excluded.ema_20, ema_50 = excluded.ema_50, macd = excluded.macd, macd_signal = excluded.macd_signal,
    macd_hist = excluded.macd_hist, bb_upper = excluded.bb_upper, bb_lower = excluded.bb_lower, bb_mid = excluded.bb_mid,
    atr_14 = excluded.atr_14, volatility_20 = excluded.volatility_20, volume_spike = excluded.volume_spike,
    volume_avg_20 = excluded.volume_avg_20, relative_strength = excluded.relative_strength, setup = excluded.setup;
end $$;

-- Macro/News/Flows sample rows (not tied to the report run above). These
-- tables use gen_random_uuid() PKs with no natural unique constraint, so
-- re-running this file would duplicate rows unless we delete-then-insert.
delete from sector_indices where index in ('NIFTY IT', 'NIFTY BANK', 'NIFTY AUTO');
insert into sector_indices (index, symbol, last, prev_close, open, high, low, change, change_pct, pe, pb, div_yield, as_of)
values
  ('NIFTY IT', 'CNXIT', 38500, 38100, 38150, 38650, 38050, 400, 1.05, 28.4, 8.1, 1.9, now()),
  ('NIFTY BANK', 'BANKNIFTY', 52300, 51900, 51950, 52450, 51850, 400, 0.77, 18.2, 3.4, 0.8, now()),
  ('NIFTY AUTO', 'CNXAUTO', 24100, 24250, 24200, 24300, 24000, -150, -0.62, 22.1, 4.2, 1.1, now());

delete from news_items where source = 'Dev Sample Wire';
insert into news_items (symbol, headline, source, url, sentiment, category, published_at)
values
  ('HDFCBANK', 'HDFC Bank posts strong Q3 loan growth, asset quality steady', 'Dev Sample Wire', 'https://example.com/1', 0.6, 'earnings', now() - interval '3 hours'),
  ('TCS', 'TCS wins large multi-year deal with European retailer', 'Dev Sample Wire', 'https://example.com/2', 0.7, 'deal', now() - interval '6 hours'),
  (null, 'RBI holds repo rate steady, signals data-dependent stance', 'Dev Sample Wire', 'https://example.com/3', 0.1, 'macro', now() - interval '1 day');

delete from fii_dii_flows where date = to_char(now(), 'YYYY-MM-DD') and category in ('FII', 'DII');
insert into fii_dii_flows (category, date, buy_value, sell_value, net_value)
values
  ('FII', to_char(now(), 'YYYY-MM-DD'), 8500.2, 7960.4, 539.8),
  ('DII', to_char(now(), 'YYYY-MM-DD'), 6100.0, 5800.5, 299.5);
