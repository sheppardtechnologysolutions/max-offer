-- Max Offer database schema
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.

-- 1. Saved deals, one row per deal, private to the user who owns it.
create table if not exists public.deals (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null default 'Untitled deal',
  address     text not null default '',
  strategy    text not null default 'rental' check (strategy in ('rental','brrrr','flip')),
  inputs      jsonb not null default '{}'::jsonb,
  lookup      jsonb,                          -- last RentCast import (estimates + comps)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists deals_user_idx on public.deals (user_id, updated_at desc);

alter table public.deals enable row level security;

drop policy if exists "Own deals: read"   on public.deals;
drop policy if exists "Own deals: insert" on public.deals;
drop policy if exists "Own deals: update" on public.deals;
drop policy if exists "Own deals: delete" on public.deals;
create policy "Own deals: read"   on public.deals for select using (auth.uid() = user_id);
create policy "Own deals: insert" on public.deals for insert with check (auth.uid() = user_id);
create policy "Own deals: update" on public.deals for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Own deals: delete" on public.deals for delete using (auth.uid() = user_id);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists deals_touch on public.deals;
create trigger deals_touch before update on public.deals for each row execute function public.touch_updated_at();

-- 2. Cache of RentCast results, so the same address is never paid for twice within 30 days.
--    Only the Edge Function (service role) reads and writes it; RLS with no policies blocks everyone else.
create table if not exists public.property_cache (
  address_key text primary key,
  data        jsonb not null,
  fetched_at  timestamptz not null default now()
);
alter table public.property_cache enable row level security;

-- 3. Log of fresh (non-cached) lookups, used to cap monthly RentCast usage.
create table if not exists public.lookup_log (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete set null,
  address_key text not null,
  requests    int not null default 3,
  created_at  timestamptz not null default now()
);
create index if not exists lookup_log_month_idx on public.lookup_log (created_at);
alter table public.lookup_log enable row level security;
