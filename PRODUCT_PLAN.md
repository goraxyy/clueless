# Clueless: from hackathon app to product

Tick a box by changing `- [ ]` to `- [x]`. Phase 1 is built and tested locally; it goes live once the Supabase account exists (steps in [`supabase/README.md`](supabase/README.md)).

## Decisions

| | Decision |
|---|---|
| AI access | Clueless accounts. Our server holds the Claude, voice and speech keys and enforces usage limits. No keys in the app. |
| Students' own Claude plans | Not possible: since early 2026 Anthropic allows Pro and Max logins only in Claude Code and claude.ai. Third-party apps must use API keys. |
| History | Synced to the account, text only. Screenshots stay on the laptop and are thrown away after use. |
| Sign-in | Google, or a magic link by email. No passwords. |
| Server | Supabase: sign-in, Postgres database and server functions in one place. |
| Platforms | macOS and Windows from launch. |
| Launch | Free beta first: invite codes, a weekly free cap, no payments. Starts with the TA's class. |
| Who can join | College students, 18+. |

## What the student sees

1. **Website**: what Clueless is, a short demo video, and **Download for Mac** / **Download for Windows**.
2. **Install**: a signed installer opens without security warnings.
3. **Sign in**: Google or email link, plus a beta invite code.
4. **First run**: a short walkthrough that grants Screen Recording, Accessibility and Microphone. Each one shows a live tick and an "Open Settings" button. Then a sample problem.
5. **History**: a list of past sessions, like chats in an AI app, grouped by day and searchable. Open one to read it back or **Continue** where you left off. It's the same list on every computer you sign into.
6. **Usage**: "14 of 20 problems left this week" in settings, with a friendly message at the limit.
7. **Settings** (replaces the `.env` file):
   - voice on/off and which voice
   - hotkeys
   - the Highlight switch
   - transparency
   - usage
   - **Download my data**, **Delete my account**, **Sign out**
8. **Updates** arrive on their own: "Restart to update".

## How it fits together

```
Desktop app (Electron, macOS + Windows)
  no API keys inside · signs in with Supabase · keeps a local copy of history
  still runs Python code locally (Pyodide) and draws everything on screen
        │  HTTPS, with the student's sign-in token
        ▼
Supabase
  Auth            Google + email link, invite codes, 18+ check at sign-up
  Postgres        profiles, sessions, turns, gaps, usage (row-level security: you see only your rows)
  Edge Functions  /ai        checks the limit, adds our Claude key, streams the reply, records tokens
                  /tts       text to ElevenLabs audio, counts characters
                  /stt-token a short-lived Deepgram token, so the app streams the mic directly
                  my_usage() what's left this week (a database function)
        │  keys live only in Supabase secrets
        ▼
Claude API (Anthropic Console)   ElevenLabs   Deepgram

Website (static, Vercel or Cloudflare Pages): landing, download links, privacy, terms
Releases (GitHub Releases): signed builds, read by the app's auto-updater
```

**Why the server decides the model and the prompt.** If the app could send any request, our key would become a free Claude proxy for anyone who reads the app's traffic. So the app sends a job (`tutor`, `ask`, `trace`, `lesson`) and the conversation. The server picks the model, adds the system prompt and caps the reply length. It also refuses anything else. This also lets us fix a prompt without shipping a new app.

**Why the Claude API rather than Bedrock.**
- Usage and billing per organization.
- Structured outputs: the `reply`-tool workaround goes away.
- Server-side refusal fallbacks.
- One key to look after: our Bedrock key just died without warning.

The app keeps Bedrock support for development.

**The hidden solution stays hidden.** The tutor's private solution is stored in a table the app can't read. Only the server functions can. A student can't pull it from their own account data.

## The hard parts, solved up front

| Problem | Plan |
|---|---|
| **Continuing an old session** | Claude can't be handed an edited history: removing the old screenshots counts as an edit, and new accounts get an error for that. Instead, "Continue" starts a fresh Claude conversation seeded with the saved text: the problem, the hidden solution, the plan, the gaps and the last few turns. |
| **Working offline or on bad Wi-Fi** | History writes queue locally and sync when back online. The app says "Offline: Clueless needs the internet to think." |
| **Cost running away** | Per-user weekly caps enforced on the server. A per-request reply cap. A global monthly budget with an email alert at 50%, 80% and 100%. Switch the quick jobs to Haiku 5.5 (about 10× cheaper than Haiku 4.5) once it's enabled. |
| **Abuse** | Sign-in required, invite codes, a rate limit per user (requests per minute), the server whitelist of jobs above, and a ban switch per account. |
| **Voice licensing** | The ElevenLabs free plan doesn't allow commercial use. The beta uses a paid ElevenLabs plan with a character cap per user, and the built-in voice past the cap. |
| **Windows** | Untested so far. A full pass on a real Windows PC (see Phase 5). The installer is signed so SmartScreen warnings fade quickly. |
| **Privacy** | Screenshots go only to Claude, only when the student asks, and are never stored. History is text. The Anthropic API doesn't train on our data by default. Data download and deletion live in settings. |

## Phases

Each phase ends with something a student can try. Sizes: S about a day, M a few days, L a week or more.

### Phase 1: Accounts and keys off the laptop (L)
- [x] Supabase setup: Google + email-link sign-in, invite codes, 18+ confirmation (`supabase/`)
- [x] Database: `profiles`, `invite_codes`, `plan_limits`, `usage_events`, with row-level security
- [x] `/ai` server function: checks the sign-in, the job and the limit, picks the model, streams Claude's reply, records tokens and cost
- [x] The app signs in (system browser, then back into the app) and keeps the sign-in encrypted with an OS keychain key
- [x] The app's Claude calls go through `/ai`: a new "Clueless" transport next to the Bedrock and Claude API ones
- [x] Weekly free cap shown in settings; a clear message at the limit
- [ ] Create the Supabase project, Anthropic Console key, Google OAuth client and email sender (steps in `supabase/README.md`)
- [ ] Done when: a fresh Mac with no `.env` signs in and solves a problem (works against a local stand-in server; needs the real project)

How the server checks requests:
- It accepts only the app's own prompts and reply schemas, checked by fingerprint, and it picks the model itself. So the app keeps sending the prompt, but the key can't be used for anything else.
- `npm run allowlist` updates the fingerprints after a prompt changes.
- Weeks reset Monday 00:00 New York time.

### Phase 2: History (M)
- [x] Tables: `sessions` (one row per problem; the conversation lives in the row) and a locked `session_secrets` (hidden solution and full plan), with row-level security. Gaps are counted from the sessions, so deleting a session removes its gaps too.
- [x] The hidden solution is kept out of the screen and out of history: it's saved where only the server can read it, and the server fills it in when a session is continued. (During a live problem it still passes through the app; we chose not to go further.)
- [x] Each session saves as it goes (text only): title, subject, steps, the conversation, gaps, solved or not
- [x] A history list in the panel: today, this week, older; search; delete one; delete all in settings
- [x] Open an old session read-only; **Continue** starts a new Claude conversation from the saved text, and doesn't count as a new problem
- [x] Saved on the laptop first, synced when online; the same history on a second computer
- [x] The gaps screen reads from the synced sessions
- [x] The old local memory file moves into the first account that signs in on that laptop, once
- [ ] Done when: start a problem on one laptop, continue it on another (passes as an automated test with two laptops' histories; needs the real project to try on two machines)

### Phase 3: Install and update (M)
- [x] App icon (placeholder from the panel's logo: `app/build/icon.svg`, `npm run icon`)
- [x] macOS: one universal download (Apple silicon and Intel), hardened runtime, microphone entitlement; signing and notarizing switch on once the Apple Developer keys are in GitHub (`RELEASING.md`)
- [ ] macOS: enroll in the Apple Developer Program (individual) and add the keys
- [x] Windows: an NSIS installer, unsigned for the beta (the install guide covers "Run anyway"); signing before a wider launch
- [x] Auto-update with `electron-updater` from GitHub Releases, and a "Restart to update" banner (Mac needs signing for this)
- [x] GitHub Actions: tests on every push and pull request; on a version tag, build both installers into a draft release and publish it when both are up
- [x] Website (`website/`, for Vercel): download buttons for the latest release, the demo video, an install guide, draft privacy and terms
- [ ] Deploy the website to Vercel (after `CONTACT_EMAIL` is filled in)
- [ ] Done when: download from the site on a clean Mac and a clean PC, and install with no warnings (needs the Apple keys, the first release and the live account server)

### Phase 4: First run, settings and voice through the server (M)
- [ ] First-run walkthrough: sign in, the three permissions with live status, a sample problem
- [ ] Settings screen replacing `.env`: voice, hotkeys, Highlight switch, transparency, usage, account
- [ ] `/tts` and `/stt-token` server functions; voice works with no keys on the laptop
- [ ] Error messages that make sense to a student (no "check your .env")
- [ ] Done when: a new student goes from download to first hint without help

### Phase 5: Windows parity (M)
Test and fix each item on a real Windows 11 PC, at 100% and 150% display scaling:
- [ ] hotkeys
- [ ] floating over full-screen apps
- [ ] highlight detection
- [ ] the `Ctrl+C` side effect in terminals
- [ ] screen capture and the line highlight
- [ ] Python runs
- [ ] mic and voice
- [ ] the tray icon
- [ ] Done when: the same demo works on both platforms

### Phase 6: Trust and running it (S–M)
- [ ] Privacy policy and terms (plain language), 18+ in the terms
- [ ] Download my data and Delete my account, including server-side deletion
- [ ] Crash reports (Sentry, opt-in) that never include screenshots or problem text
- [ ] Budget alerts, per-user rate limits, a ban switch
- [ ] An in-app "Send feedback" button
- [ ] Done when: we'd be comfortable handing it to a class

### Phase 7: Beta with the TA's class (ongoing)
- [ ] Invite codes for the class, a short intro for students
- [ ] Measure it: hints per problem, problems solved without Reveal, gaps that repeat, and a short quiz score compared with students using usual AI tools
- [ ] Weekly look at cost per student and what breaks
- [ ] Decide pricing from real usage (the free tier, the student plan and school seats outlined earlier)

## What you'll need to set up (accounts and costs)

| Item | Why | Rough cost |
|---|---|---|
| Anthropic Console account with billing | The server's Claude key | Pay per use (estimate below) |
| Supabase | Sign-in, database, server functions | Free for the beta; about $25/month on Pro |
| Apple Developer Program | Signing and notarizing the Mac app | $99/year |
| Windows code signing | A trusted installer | About $10/month (Azure Trusted Signing) or $200+/year for a certificate |
| Google Cloud OAuth client | "Sign in with Google" | Free |
| ElevenLabs paid plan | Commercial use of the voice | From a few dollars a month, by characters |
| Deepgram | Speech to text | Pay per minute; starts with free credit |
| A domain | The website and email links | About $12/year |
| Sentry | Crash reports | Free tier |

**Claude cost for the beta** (our app logs and list prices): about 10 to 25 cents per problem on Sonnet, under a cent per Ask. With 50 students doing about 15 problems a month each, that's roughly **$75 to $190 a month**. It drops when the quick jobs move to Haiku 5.5.

## Open questions for later

- The final name and domain (is "Clueless" staying?).
- Free cap numbers: problems per week, Asks per week, voice characters per month.
- Keep the repository public once the server exists? The server code can live in a private folder or repo.
- Who on the team owns each phase.
