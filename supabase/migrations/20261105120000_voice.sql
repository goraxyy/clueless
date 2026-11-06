-- Voice through the server: a short-lived Deepgram token for each time a student talks to Clueless
-- ("listen"), and replies read aloud by ElevenLabs when it's switched on ("speak"). Both count
-- towards weekly caps, like problems and Asks.

alter table public.usage_events drop constraint usage_events_job_check;
alter table public.usage_events add constraint usage_events_job_check
  check (job in ('tutor', 'fast', 'listen', 'speak'));
alter table public.usage_events add column characters int not null default 0; -- read aloud ("speak")

alter table public.plan_limits
  add column listens_per_week int not null default 300,
  add column speech_characters_per_week int not null default 20000;

create or replace function public.usage_check(student uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'activated', p.activated_at is not null,
    'banned', p.banned,
    'plan', p.plan,
    'problems_used', count(u.id) filter (where u.unit = 'problem' and u.created_at >= public.week_start()),
    'problems_limit', l.problems_per_week,
    'asks_used', count(u.id) filter (where u.unit = 'ask' and u.created_at >= public.week_start()),
    'asks_limit', l.asks_per_week,
    'listens_used', count(u.id) filter (where u.job = 'listen' and u.created_at >= public.week_start()),
    'listens_limit', l.listens_per_week,
    'speech_characters_used', coalesce(sum(u.characters) filter (where u.job = 'speak' and u.created_at >= public.week_start()), 0),
    'speech_characters_limit', l.speech_characters_per_week,
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
    l.problems_per_week, l.asks_per_week, l.dollars_per_week, l.requests_per_minute,
    l.listens_per_week, l.speech_characters_per_week
$$;
