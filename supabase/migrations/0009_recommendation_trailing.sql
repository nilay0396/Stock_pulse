-- Recommendation lifecycle: target-1 partial booking and trailing continuation.

alter table recommendation_lifecycle
  add column if not exists target1_date text,
  add column if not exists target1_price numeric,
  add column if not exists trailing_stop numeric,
  add column if not exists partial_exit_pct numeric not null default 50;

alter table recommendation_lifecycle
  drop constraint if exists recommendation_lifecycle_status_check;

alter table recommendation_lifecycle
  add constraint recommendation_lifecycle_status_check check (
    status in (
      'pending_entry',
      'active',
      'target_1_hit',
      'trailing',
      'hit_target',
      'hit_stop',
      'hit_trailing_stop',
      'expired',
      'no_entry',
      'no_data',
      'error'
    )
  );

create index if not exists idx_recommendation_lifecycle_trailing
  on recommendation_lifecycle(status, trailing_stop)
  where status in ('target_1_hit', 'trailing');
