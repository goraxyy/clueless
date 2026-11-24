# The Clueless server

Students sign in with a code sent to their email. They never paste a key. This server calls
Claude, Deepgram and ElevenLabs for them with our keys, and stops a user at their plan's monthly
limit.

- `functions/api/`: the one server function.
  - `handler.ts` has the logic, tested in `handler_test.ts`.
  - `index.ts` connects it to Supabase.
- `migrations/`: the tables.
  - `profiles`: each user's plan, `free` or `pro`.
  - `usage`: one row per call, with its tokens and its cost in millionths of a dollar.
  - `month_spend()`: what a user has spent this month.
- `templates/code.html`: the sign-in email, which shows the code instead of a link.

What the function does:
- `POST /v1/messages`: the Claude Messages API, passed through, streaming included.
  - It allows only `claude-sonnet-5-5` and `claude-haiku-5-5`, and caps `max_tokens`.
  - Over the limit, it returns a `402` with a message the app shows.
- `GET /me`: the plan, what's been spent this month, and the limit.
- `POST /voice/stt-token`: a 30-second Deepgram token for one recording.
- `/elevenlabs/v2/voices` and `/elevenlabs/v1/text-to-speech/:id`: ElevenLabs, passed through.
- `POST /webhooks/lemonsqueezy`: payments. It needs no sign-in; it checks Lemon Squeezy's
  signature instead, then sets the user's plan from their subscription.

Without `ANTHROPIC_API_KEY`, Claude calls answer "no Claude key yet". Sign-in, `/me` and payments
still work.

## Run it locally

Needs Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development). The
local ports are 553xx, so it can run next to another local Supabase project on the default 543xx.

```bash
supabase start -x logflare,vector,studio,storage-api,realtime,imgproxy,postgres-meta,supavisor
```

Put the server's keys in a file outside the repo, for example `~/clueless-functions.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
# DEEPGRAM_API_KEY=
# ELEVENLABS_API_KEY=
# FREE_MONTHLY_USD=1
# PRO_MONTHLY_USD=8
```

Then serve the function:

```bash
supabase functions serve --env-file ~/clueless-functions.env
```

Point the app at the local server. In `app/.env`, leave `ANTHROPIC_API_KEY` and the AWS settings
empty (keys there win over signing in), and set:

```
CLUELESS_SUPABASE_URL=http://127.0.0.1:55321
CLUELESS_SUPABASE_KEY=<PUBLISHABLE_KEY from `supabase status`>
```

Sign-in emails don't leave your computer. They show up in Mailpit at http://127.0.0.1:55324.

Run the server's tests:

```bash
deno test supabase/functions/api
```

## Put it online

The live project is `clueless` (ref `cdihnjzzivdjhmljexui`, us-east-1), in the tokenlimitlabs
Supabase account. The tables and the `api` function are on it, with **Verify JWT** turned off. It
was first deployed from the dashboard as one file: `handler.ts` and `index.ts` joined.
`supabase functions deploy api` deploys the same code from here.

From scratch:

1. Create a project at [supabase.com](https://supabase.com), then link and push the tables:

   ```bash
   supabase link --project-ref <ref>
   supabase db push
   ```

2. Set the email template. In Authentication → Emails, paste `templates/code.html` into **Magic
   link** and **Confirm signup**, with the subject "Your Clueless sign-in code". Supabase's
   built-in email service sends only a few emails an hour, so add your own SMTP (Resend, Postmark)
   under Authentication → SMTP before real users sign up.

3. Set the keys and deploy the function:

   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-... DEEPGRAM_API_KEY=... ELEVENLABS_API_KEY=...
   supabase functions deploy api
   ```

4. Build the app against it. In `app/.env` set `MAIN_VITE_SUPABASE_URL=https://<ref>.supabase.co`
   and `MAIN_VITE_SUPABASE_KEY=<publishable key>`, then run `npm run dist:mac`. Both values are
   public (they only name the project), so they can go in the build. The Anthropic key never does.

To give someone Pro by hand until payments exist:

```sql
insert into profiles (user_id, plan) values ('<user id>', 'pro')
  on conflict (user_id) do update set plan = 'pro';
```

## Things to know

- **Request time limit.** On the free Supabase plan a request can run for 150 seconds; on paid
  plans, 400. A tutor turn takes a few seconds. Animate at `CLUELESS_TRACE_EFFORT=max` can take
  about 90, so keep it at `high` or lower.
- **Voice costs are estimates.** Deepgram is charged per recording, as about a minute up front
  (`STT_MICRO_PER_RECORDING`). ElevenLabs is charged per character (`TTS_MICRO_PER_CHAR`). Set
  both in `handler.ts` to your plans' real rates.
- **The limit isn't a hard cap.** It's checked before each call and the cost is written after, so
  the last call of the month can go over. One large call (a long conversation plus 64k tokens of
  output) can cost a dollar or two, and calls made at the same time each pass the check. Before
  opening sign-ups widely, add a per-user cap on calls running at once.
- **A stream the app stops early is estimated.** Claude still bills what it sent before the stop,
  so the server counts it: input from `message_start`, output from the characters sent (about 3 a
  token).
- **Server tools are refused.** Requests with web search, code execution, MCP servers or containers
  get a 400, since they'd cost more than the token count shows.
- **Anyone can sign up.** Every new email address gets the free allowance, so a free month costs
  up to `FREE_MONTHLY_USD` per address. Turn off sign-ups (Authentication → Sign In / Providers)
  or lower the allowance if that gets abused.
## Payments (Lemon Squeezy)

Pro is sold through Lemon Squeezy, which handles payments and sales tax.

1. In Lemon Squeezy, make a product with one monthly subscription variant (say $10 a month). Copy
   its checkout link (Share → Checkout URL).
2. Add a webhook: Settings → Webhooks.
   - URL: `https://<ref>.supabase.co/functions/v1/api/webhooks/lemonsqueezy`
   - Signing secret: a long random string.
   - Events: all the `subscription_*` ones.
3. Set the secrets (or add them under Edge Functions → Secrets):

   ```bash
   supabase secrets set LEMONSQUEEZY_WEBHOOK_SECRET=<signing secret> LEMONSQUEEZY_CHECKOUT_URL=<checkout link>
   ```

   - Optional: `LEMONSQUEEZY_PORTAL_URL`, where Pro users manage their subscription. It defaults
     to `https://app.lemonsqueezy.com/my-orders`.
   - While testing with Lemon Squeezy's test mode, also set `LEMONSQUEEZY_TEST_MODE=1`. Test-mode
     events are ignored without it.

How it works:
- In the app, Profile → Upgrade opens the checkout link with the user's ID attached
  (`checkout[custom][user_id]`).
- Each subscription event sets that user's plan in `profiles`:
  - **Pro:** active, on trial, past due (retrying a payment), or cancelled but not ended yet.
  - **Free:** expired, unpaid or paused.
