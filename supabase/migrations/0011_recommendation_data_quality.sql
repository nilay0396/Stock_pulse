-- Recommendation engine hardening: horizon-specific conviction and data quality.

alter table stock_scores add column if not exists weekly_conviction numeric;
alter table stock_scores add column if not exists monthly_conviction numeric;
alter table stock_scores add column if not exists data_confidence_score numeric;
alter table stock_scores add column if not exists data_penalty numeric;
alter table stock_scores add column if not exists data_gaps text[] not null default '{}';

alter table trade_ideas add column if not exists horizon_conviction numeric;
alter table trade_ideas add column if not exists effective_conviction numeric;
alter table trade_ideas add column if not exists data_confidence_score numeric;
alter table trade_ideas add column if not exists data_penalty numeric;
alter table trade_ideas add column if not exists data_gaps text[] not null default '{}';
alter table trade_ideas add column if not exists fno_score numeric;

create index if not exists idx_stock_scores_weekly_conviction on stock_scores(report_run_id, weekly_conviction desc);
create index if not exists idx_stock_scores_monthly_conviction on stock_scores(report_run_id, monthly_conviction desc);
create index if not exists idx_trade_ideas_effective_conviction on trade_ideas(report_run_id, effective_conviction desc);
