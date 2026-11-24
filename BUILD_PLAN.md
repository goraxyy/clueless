# Build plan

Tick a box by changing `- [ ]` to `- [x]`.

## Done

**The tutor**
- [x] Floating panel over any app, macOS and Windows, including full-screen apps — Ali
- [x] Reads the screen, a selected area, or typed text, and sees the screen with every message — Ali
- [x] Tutor on Claude (Amazon Bedrock or the Claude API): steps, hints that grow, gap types, a recap that comes by itself — Ali
- [x] Asks what's tripping you up after a scan, with 3 options; shorter replies; clickable plan steps — Nurislam
- [x] One row of buttons: Hint, What next?, Check my work, Example — Ali
- [x] Answer checks for math and physics (math.js) — Ali
- [x] Stuck detection: idle screen, repeated wrong answers, answer sites — Ali
- [x] Gap tracking across sessions — Ali
- [x] Fills in fields Claude left out instead of asking again — Nurislam

**Highlights and animations**
- [x] The visual engine: arrays, grids, sets, maps, plots, vectors, trees, graphs — Nurassyl
- [x] First version of highlight → Ask → step-by-step trace (PR #3) — Nurassyl
- [x] Ask and Animate buttons on any highlight, in any app — Ali
- [x] The visual island: back, play/pause, forward, stop, speed and its own voice — Ali
- [x] Python run for real (Pyodide) instead of the model writing the trace — Ali
- [x] The running line lights up on the real screen, with tags for conditions, loops and returns — Ali
- [x] Concept lessons for anything that isn't code — Ali
- [x] Voice and animation in step: each step is read aloud and the next waits for it — Ali

**Voice**
- [x] Talk to Clueless (Deepgram) — Rasim
- [x] Replies read aloud (ElevenLabs, or the computer's own voice) — Rasim

**The windows**
- [x] Big window and small window, settings (transparency, new session, quit) — Ali
- [x] UI pass on both windows (PR #6) — Rasim
- [x] Resizable panel and layout fixes — Nurislam

**Housekeeping**
- [x] Sonnet for the tutor, Haiku for small jobs, and a 15-problem model test set (`npm run eval`) — Ali
- [x] Restored the work lost in the PR #3 merge (PR #4) — Ali
- [x] Tests (134), typecheck, and a smoke test of every window and a Python run

## Next

- [ ] Try it in a TA's class and measure what students learn with it, against the usual AI tools
- [ ] Interview prep: the same hints-not-answers loop for coding interview questions
- [ ] Run more languages for real (JavaScript next); Claude traces them for now
- [ ] Follow the code when the page scrolls, instead of hiding the line highlight
- [ ] Faster Animate when Claude writes the steps: start at step 1 while the rest arrives

## Shipping it to students

Today Clueless needs Node, a clone of the repo and a Claude key in `app/.env`. The goal: download a
signed app, sign in, and use it, with no key and no terminal.

**Decisions**
- Claude runs through our own small server, which holds the Anthropic key. Students never paste one.
  - Signing in with a claude.ai Pro or Max account isn't an option: Anthropic doesn't allow other
    apps to use those accounts and their limits without approval.
  - A key must never ship inside the app, where anyone can pull it out.
- Bring-your-own-key stays as an option in Settings, for a cheap or free tier.
- Plans: Free (about 10 problems a month, mostly Haiku), Pro at about $10–12 a month (about 150
  problems, Sonnet, voice, Animate). A monthly limit, never "unlimited".
- Payments through a merchant of record (Lemon Squeezy or Paddle), so sales tax and VAT are handled.
- One Electron app with two kinds of window: the main window (Dock icon, in Applications) and the
  island, which is what we have now.

**Cost, to check against real use**
- Sonnet 5.5: $2 in / $10 out per million tokens ($0.10 for cached input). Haiku 5.5: $0.10 / $0.50.
- Estimate: about $0.015 a turn on Sonnet (screenshot + prompt + history), $0.10–0.15 a problem,
  $6–9 a month for a heavy student. Not measured yet.

**1. Server and sign-in**
- [x] Sign-in with Supabase Auth: a 6-digit code by email, typed into the app; the session kept in
  the keychain (`account/`) — Ali
- [ ] Sign in with Google (needs a redirect back into the app: a custom URL scheme)
- [x] The server, a Supabase Edge Function (`supabase/`): checks the user, calls Claude (streaming
  too), mints Deepgram tokens and passes ElevenLabs through, with our keys — Ali
- [x] Count tokens per user from `usage` and stop at the plan's limit, with a clear message in the app — Ali
- [x] A new provider in `tutor/provider.ts` that talks to our server; keys in `.env` still win, for
  development — Ali
- [x] The Supabase project (`clueless`), its tables and the `api` function, online — Ali
- [ ] The server's keys: `ANTHROPIC_API_KEY` (and the voice keys) in Edge Functions → Secrets
- [ ] Custom SMTP (Resend or Postmark), then the code email from `supabase/templates/code.html`:
  until then Supabase's default email has a link and no code, so signing in can't finish
- [ ] Log real usage per turn and per problem, and redo the cost numbers above

**2. Cheaper turns**
- [x] Prompt caching on the system prompt and the conversation history (it already did this)
- [x] Smaller screenshots: scaled to 1600 px and JPEG before sending (it already did this); select-area crops
- [ ] Hints and "What next?" on Haiku if the eval (`npm run eval`) holds up; Sonnet for the tutor and
  checks

**3. Builds people can install**
- [x] Signing and notarization in `electron-builder.yml`, driven by env vars (unsigned builds still work);
  hardened runtime and entitlements in `app/build/` — Ali
- [ ] Apple Developer ID ($99 a year), then add its certificate and the APPLE_* secrets to GitHub
- [ ] An app icon (`app/build/icon.icns` and `icon.ico`): builds use Electron's default icon
- [ ] Windows code signing: a certificate in the WIN_CERT_* secrets (or Azure Trusted Signing)
- [x] Builds on GitHub Releases, and updates inside the app (`electron-updater`, `app/src/main/updates.ts`) — Ali
- [x] A build in CI on every release tag (`.github/workflows/release.yml`, to a draft release) — Ali
- [ ] Push a first tag and check the draft release on GitHub

**4. The main window**
- [x] First run: sign in, then the permissions (Screen Recording, Microphone, Accessibility), each
  with an Allow button, then the hotkeys — Ali
- [x] Chat: the same session as the panel, shown in full; start one by typing, reading the screen or
  selecting the problem — Ali
- [x] History: past problems with their whole conversation, search, delete — Ali
- [x] Flashcards: save a reply (panel, Chat or History) or write your own, grouped by topic, reviewed
  with boxes (right: seen less often, wrong: back in 10 minutes) — Ali
- [x] Profile (plan, this month's use, upgrade, stats, what trips you up) and Settings (open at
  login, permissions, hotkeys, your own key) — Ali
- [x] Sessions and flashcards saved locally (`memory/store.ts`); an unfinished problem is saved on quit — Ali
- [ ] Sync History and flashcards to Supabase, so they follow you to another computer
- [x] The main window and the panel open each other (Show the floating panel / Open Clueless), and
  the menu bar has Open Clueless; the Dock icon shows only while the main window is open — Ali
- [ ] Check the panel still floats over full-screen apps after the main window has opened and closed

**5. Payments and the website**
- [x] Checkout and a signed webhook that sets the plan (Lemon Squeezy; `supabase/README.md`) — Ali
- [ ] Make the Lemon Squeezy store and product, then set its webhook and secrets
- [x] A landing page with downloads and pricing (`web/`, static files) — Ali
- [ ] Put `web/` online (Vercel or GitHub Pages) and point a domain at it
- [x] Privacy page (`web/privacy.html`), checked against what the code does — Ali
- [ ] Fill in the contact email on the privacy page
