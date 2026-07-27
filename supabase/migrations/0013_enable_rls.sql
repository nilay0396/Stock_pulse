-- Defensive database containment.
-- The app uses server-side service-role access through Netlify Functions.
-- Enabling RLS blocks accidental direct anon access if a browser Supabase
-- client or anon key is introduced later.

alter table if exists users enable row level security;
alter table if exists user_preferences enable row level security;
alter table if exists stock_universe enable row level security;
alter table if exists system_settings enable row level security;
alter table if exists audit_logs enable row level security;
alter table if exists report_runs enable row level security;
alter table if exists trade_ideas enable row level security;
alter table if exists stock_scores enable row level security;
alter table if exists technical_snapshots enable row level security;
alter table if exists news_items enable row level security;
alter table if exists fii_dii_flows enable row level security;
alter table if exists insider_trades enable row level security;
alter table if exists geopolitics_events enable row level security;
alter table if exists bhavcopy_rows enable row level security;
alter table if exists sector_indices enable row level security;
alter table if exists corp_announcements enable row level security;
alter table if exists corp_actions enable row level security;
alter table if exists shareholding_filings enable row level security;
alter table if exists fred_macro enable row level security;
alter table if exists fmp_fundamentals enable row level security;
alter table if exists financial_results enable row level security;
alter table if exists kite_instruments enable row level security;
alter table if exists fno_oi_snapshots enable row level security;
alter table if exists delivery_logs enable row level security;
alter table if exists backtest_runs enable row level security;
alter table if exists backtest_trades enable row level security;
alter table if exists recommendation_lifecycle enable row level security;
alter table if exists recommendation_attributions enable row level security;
alter table if exists live_ticks enable row level security;
