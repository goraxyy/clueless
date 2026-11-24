-- Who is on which plan, and what every Claude call cost. Only the server function (service role)
-- writes these; a signed-in user can read their own rows.

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  created_at timestamptz not null default now()
);

create table public.usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  kind text not null default 'claude' check (kind in ('claude', 'tts', 'stt')),
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  characters integer not null default 0,
  -- millionths of a dollar
  cost_micro bigint not null
);

create index usage_user_month on public.usage (user_id, created_at);

-- Table access is granted explicitly (new Supabase projects don't grant it by default).
grant select, insert, update on public.profiles to service_role;
grant select, insert on public.usage to service_role;
grant usage on sequence public.usage_id_seq to service_role;
grant select on public.profiles, public.usage to authenticated;

alter table public.profiles enable row level security;
alter table public.usage enable row level security;

create policy "read own profile" on public.profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "read own usage" on public.usage for select to authenticated using ((select auth.uid()) = user_id);

-- What a user has spent this calendar month (UTC), in millionths of a dollar.
create function public.month_spend(uid uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(cost_micro), 0)::bigint
  from public.usage
  where user_id = uid
    and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
$$;

revoke execute on function public.month_spend(uuid) from public, anon, authenticated;
grant execute on function public.month_spend(uuid) to service_role;
