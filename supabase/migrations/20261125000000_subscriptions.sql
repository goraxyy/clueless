-- Pro through Lemon Squeezy: the subscription behind each Pro plan, as its webhooks report it.
alter table public.profiles
  add column subscription_id text,
  add column subscription_status text,
  add column updated_at timestamptz not null default now();
