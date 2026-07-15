-- Phase 1: auth, preferences, stock universe, settings, audit log.
-- Ported from backend/models.py + backend/db.py (MongoDB collections).

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null default '',
  role text not null default 'user' check (role in ('user', 'admin')),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  telegram_chat_id text,
  email_alerts boolean not null default true,
  telegram_alerts boolean not null default false,
  delivery_time text not null default '07:00',
  language text not null default 'en' check (language in ('en', 'hi')),
  preferred_sectors text[] not null default '{}',
  horizon text not null default 'both' check (horizon in ('weekly', 'monthly', 'both')),
  risk_appetite text not null default 'medium' check (risk_appetite in ('low', 'medium', 'high')),
  watchlist text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists stock_universe (
  symbol text primary key,
  yf_symbol text not null,
  name text not null,
  sector text not null default 'Other',
  industry text not null default 'Unknown',
  market_cap_tier text not null default 'unknown' check (market_cap_tier in ('large', 'mid', 'small', 'unknown')),
  isin text,
  listing_date text
);

create table if not exists system_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  email text,
  action text not null,
  meta jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create index if not exists idx_stock_universe_sector on stock_universe(sector);
create index if not exists idx_audit_logs_at on audit_logs(at desc);
