-- Phase 4: report delivery audit trail.

create extension if not exists pgcrypto;

create table if not exists delivery_logs (
  id uuid primary key default gen_random_uuid(),
  report_run_id uuid references report_runs(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  channel text not null check (channel in ('telegram', 'email')),
  recipient text,
  status text not null check (status in ('sent', 'failed', 'dry_run', 'skipped')),
  error text,
  response_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_delivery_logs_created_at on delivery_logs(created_at desc);
create index if not exists idx_delivery_logs_report_run on delivery_logs(report_run_id);
