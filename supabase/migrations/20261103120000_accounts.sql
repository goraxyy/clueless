-- Clueless accounts: profiles, beta invite codes, each plan's weekly caps, and a usage log.
-- Students can read only their own rows. Invite codes and the server-side usage check are never
-- reachable from the app; the `ai` function reads them with the service role.

-- ---------- plans ----------

create table public.plan_limits (
  plan text primary key,
  problems_per_week int not null,
  asks_per_week int not null,
  dollars_per_week numeric(8, 2) not null, -- a ceiling on what one student can cost us, whatever they do
  requests_per_minute int not null
);

insert into public.plan_limits (plan, problems_per_week, asks_per_week, dollars_per_week, requests_per_minute)
values ('beta', 20, 60, 2.00, 30);

alter table public.plan_limits enable row level security;
create policy "signed-in students can read the plans" on public.plan_limits
  for select to authenticated using (true);

-- ---------- invite codes (beta) ----------

create table public.invite_codes (
  code text primary key check (code = upper(code)),
  note text not null default '', -- who it was for, e.g. "TA class, fall"
  max_uses int not null default 1 check (max_uses > 0),
  uses int not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.invite_codes enable row level security;
-- No policies on purpose: only activate() and the service role touch invite codes.

-- ---------- profiles ----------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  plan text not null default 'beta' references public.plan_limits (plan),
  invite_code text references public.invite_codes (code) on delete set null,
  adult_confirmed_at timestamptz, -- the student confirmed they're 18 or older
  activated_at timestamptz, -- invite code accepted: the student may use Clueless
  banned boolean not null default false
);

alter table public.profiles enable row level security;
create policy "students read their own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

-- Every new sign-in gets a profile, not yet activated.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- usage ----------

create table public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  job text not null check (job in ('tutor', 'fast')),
  unit text check (unit in ('problem', 'ask')), -- what this request started, if anything
  model text not null,
  status int not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd numeric(12, 6) not null default 0
);

create index usage_events_user_time on public.usage_events (user_id, created_at desc);

alter table public.usage_events enable row level security;
create policy "students read their own usage" on public.usage_events
  for select to authenticated using ((select auth.uid()) = user_id);

-- ---------- functions ----------

-- The student enters an invite code and confirms they're 18+. Safe to call again once activated.
create function public.activate(invite text, adult boolean) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  wanted text := upper(trim(coalesce(invite, '')));
  p public.profiles;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  select * into p from public.profiles where id = me for update;
  if not found then
    insert into public.profiles (id) values (me) returning * into p;
  end if;
  if p.activated_at is not null then
    return p;
  end if;

  if adult is not true then
    raise exception 'During the beta, Clueless is for students 18 and older.' using errcode = 'P0001';
  end if;

  update public.invite_codes set uses = uses + 1
  where code = wanted and uses < max_uses and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'That invite code isn''t valid, or it has been used up.' using errcode = 'P0001';
  end if;

  update public.profiles
  set invite_code = wanted, adult_confirmed_at = now(), activated_at = now()
  where id = me
  returning * into p;
  return p;
end $$;

revoke execute on function public.activate(text, boolean) from public, anon;
grant execute on function public.activate(text, boolean) to authenticated;

-- Weeks start Monday 00:00 New York time: the beta's students are on the US East Coast.
create function public.week_start() returns timestamptz
language sql stable set search_path = '' as $$
  select date_trunc('week', now() at time zone 'America/New_York') at time zone 'America/New_York'
$$;

-- This week's use against the plan's caps. For the `ai` function only.
create function public.usage_check(student uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'activated', p.activated_at is not null,
    'banned', p.banned,
    'plan', p.plan,
    'problems_used', count(u.id) filter (where u.unit = 'problem' and u.created_at >= public.week_start()),
    'problems_limit', l.problems_per_week,
    'asks_used', count(u.id) filter (where u.unit = 'ask' and u.created_at >= public.week_start()),
    'asks_limit', l.asks_per_week,
    'dollars_used', coalesce(sum(u.cost_usd) filter (where u.created_at >= public.week_start()), 0),
    'dollars_limit', l.dollars_per_week,
    'requests_last_minute', count(u.id) filter (where u.created_at >= now() - interval '1 minute'),
    'requests_per_minute', l.requests_per_minute,
    'resets_at', (date_trunc('week', now() at time zone 'America/New_York') + interval '7 days') at time zone 'America/New_York'
  )
  from public.profiles p
  join public.plan_limits l on l.plan = p.plan
  left join public.usage_events u
    on u.user_id = p.id and u.created_at >= least(public.week_start(), now() - interval '1 minute')
  where p.id = student
  group by p.id, p.activated_at, p.banned, p.plan,
    l.problems_per_week, l.asks_per_week, l.dollars_per_week, l.requests_per_minute
$$;

revoke execute on function public.usage_check(uuid) from public, anon, authenticated;
grant execute on function public.usage_check(uuid) to service_role;

-- The same numbers for the signed-in student, for the app's "14 of 20 problems left this week".
create function public.my_usage() returns json
language sql stable security definer set search_path = '' as $$
  select public.usage_check(auth.uid())
$$;

revoke execute on function public.my_usage() from public, anon;
grant execute on function public.my_usage() to authenticated;
