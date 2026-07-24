-- Recommendation learning: post-trade attribution by reasons, risks and setup context.

create extension if not exists pgcrypto;

create table if not exists recommendation_attributions (
  id uuid primary key default gen_random_uuid(),
  lifecycle_id uuid not null references recommendation_lifecycle(id) on delete cascade,
  trade_idea_id uuid not null references trade_ideas(id) on delete cascade,
  report_run_id uuid not null references report_runs(id) on delete cascade,
  original_run_date text not null,
  symbol text not null,
  outcome text not null,
  return_pct numeric,
  profit_loss text not null check (profit_loss in ('profit', 'loss', 'flat')),
  attribution_score numeric not null default 0,
  primary_driver text,
  factor_attributions jsonb not null default '[]'::jsonb,
  reason_tags text[] not null default '{}',
  risk_tags text[] not null default '{}',
  context_tags text[] not null default '{}',
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lifecycle_id)
);

create index if not exists idx_recommendation_attributions_trade_idea on recommendation_attributions(trade_idea_id);
create index if not exists idx_recommendation_attributions_outcome on recommendation_attributions(profit_loss, outcome);
create index if not exists idx_recommendation_attributions_symbol on recommendation_attributions(symbol, generated_at desc);
create index if not exists idx_recommendation_attributions_reason_tags on recommendation_attributions using gin(reason_tags);
create index if not exists idx_recommendation_attributions_risk_tags on recommendation_attributions using gin(risk_tags);
create index if not exists idx_recommendation_attributions_context_tags on recommendation_attributions using gin(context_tags);
