-- History: each problem session, synced to the student's account so they can read it back or
-- continue it on any computer. Text only: screenshots are never stored.
-- Gaps aren't a table of their own: they're counted from the sessions' `gaps`, so deleting a
-- session also removes what it taught us.

create table public.sessions (
  id uuid primary key, -- made by the app, so a session saved offline keeps its id
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  started_at timestamptz not null,
  updated_at timestamptz not null default now(),
  subject text not null,
  title text not null,
  summary text not null default '',
  solved boolean not null default false,
  revealed boolean not null default false,
  attempts int not null default 0,
  hints_used int not null default 0,
  gaps jsonb not null default '[]', -- [{type, topic}], one per gap Clueless saw
  plan jsonb not null default '[]', -- the steps as the student saw them (steps not reached have no text)
  thread jsonb not null default '[]', -- the conversation as the app shows it
  recap jsonb,
  constraint sessions_not_huge check (octet_length(thread::text) + octet_length(plan::text) + octet_length(gaps::text) < 1000000)
);

create index sessions_user_updated on public.sessions (user_id, updated_at desc);

alter table public.sessions enable row level security;
create policy "students read their own sessions" on public.sessions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "students add their own sessions" on public.sessions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "students update their own sessions" on public.sessions
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "students delete their own sessions" on public.sessions
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------- what Clueless knows but the student doesn't ----------

-- The hidden solution and the full plan (with the steps the student hasn't reached). Students can
-- write it through save_secrets() but never read it; the `ai` function fills it in when they
-- continue a session.
create table public.session_secrets (
  session_id uuid primary key references public.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  hidden_solution text not null default '',
  plan jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  constraint secrets_not_huge check (octet_length(hidden_solution) + octet_length(plan::text) < 200000)
);

alter table public.session_secrets enable row level security;
-- No policies on purpose.

create function public.save_secrets(session uuid, solution text, full_plan jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if not exists (select 1 from public.sessions s where s.id = session and s.user_id = auth.uid()) then
    raise exception 'Save the session first.' using errcode = 'P0002';
  end if;
  insert into public.session_secrets (session_id, user_id, hidden_solution, plan)
  values (session, auth.uid(), coalesce(solution, ''), coalesce(full_plan, '[]'))
  on conflict (session_id) do update set
    -- a later save without the solution (continuing on another computer) keeps the one we have
    hidden_solution = case when excluded.hidden_solution <> '' then excluded.hidden_solution else public.session_secrets.hidden_solution end,
    plan = case when excluded.plan <> '[]'::jsonb then excluded.plan else public.session_secrets.plan end,
    updated_at = now();
end $$;

revoke execute on function public.save_secrets(uuid, text, jsonb) from public, anon;
grant execute on function public.save_secrets(uuid, text, jsonb) to authenticated;
