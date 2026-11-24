# Clueless

| Keys | |
|---|---|
| `Cmd/Ctrl + Shift + Space` | read the screen |
| `Cmd/Ctrl + Shift + 2` | select just the problem |
| `Cmd/Ctrl + Shift + 1` | talk |
| `Cmd/Ctrl + Shift + 3` | show or hide the pill |
| `Esc` | hide the panel |

A small study helper that sits on top of whatever you're working on. When you're stuck, it looks at
the problem on your screen and helps you work through it with questions and small hints, instead of
giving you the answer. Code, math, physics and most other problem sets, on macOS and Windows.

- **The panel** walks you through one step at a time:
  - asks what's tripping you up, with 3 options to pick from
  - **Hint**, **What next?**, **Check my work** and **Example** (a similar problem with different numbers)
  - one box for answers and questions; it sees your screen with every message
  - checks math answers
  - the play button by the mic animates the idea at your step, with a voice
  - talks, and reads its replies aloud
  - a short recap once the problem is solved
- **The main window** opens from Finder, the Dock or the menu bar:
  - **Chat:** the same problem as the panel, shown in full.
  - **History:** every problem, with its conversation.
  - **Flashcards:** save any reply with its card button, then review by topic.
  - **Profile:** your plan and this month's use.
  - **Settings**, and first-run setup: sign in, then permissions.
- **The small window** is the panel shrunk to a bar: type a question, talk, turn spoken replies on
  or off, and open settings.
- **Highlights**: highlight anything, in any app, and two buttons appear next to the cursor.
  - **Ask** explains it in the panel.
  - **Animate** explains it step by step in a small window of its own, with a voice. Code runs for
    real and its variables are drawn as boxes, while the line that's running lights up on your
    screen. Anything else gets a short picture of the idea.

## Setup

You'll need [Node.js](https://nodejs.org), and one of these:
- **Sign in to Clueless.** The app sends Claude requests through the Clueless server, which holds
  the keys and keeps each student within their monthly plan. Set it up with
  [supabase/README.md](supabase/README.md). No Claude key on your computer.
- **Your own Claude access**, through Amazon Bedrock or a Claude API key, as below.

```bash
cd app
npm install
cp .env.example .env
```

In `app/.env`:
- **Bedrock:** set `AWS_REGION` and `AWS_BEARER_TOKEN_BEDROCK` (or `AWS_PROFILE`), and turn on access
  to Claude Sonnet 5.5 and Haiku 5.5 in the Bedrock console. If your account doesn't have them yet,
  set `CLUELESS_MODEL=anthropic.claude-sonnet-5` and `CLUELESS_FAST_MODEL=anthropic.claude-haiku-4-5`.
- **Or the Claude API:** set `ANTHROPIC_API_KEY`.
- **Optional:** `DEEPGRAM_API_KEY` for talking, and `ELEVENLABS_API_KEY` for a nicer reading voice.
  Without it, Clueless uses the computer's own voice.

Then:

```bash
npm run try -- "Integrate x^2 e^x dx"   # checks it can reach Claude
npm run dev
```

On macOS, Clueless lives in the menu bar. The first time, allow these in System Settings → Privacy &
Security, then restart it:
- **Screen Recording**
- **Microphone**
- **Accessibility**, to notice highlights

To read a highlight, Clueless presses `Cmd/Ctrl + C` for you and then puts your clipboard back. On
Windows, `Ctrl + C` in a terminal stops the running program, so turn **Highlight** off on the pill there.

On Windows PowerShell, use `npm.cmd` if `npm` scripts are blocked.

## Commands

| Command | |
|---|---|
| `npm run dev` | run the app |
| `npm run try -- "problem"` | the tutor in the terminal |
| `npm run trace -- code.py` | Animate on a code file, in the terminal |
| `npm run eval` | the model test set (a few dollars of Claude calls) |
| `npm test` | tests |
| `npm run typecheck` | type checks |
| `npm run dist:mac` / `npm run dist:win` | build an installer |

[DESIGN.md](DESIGN.md) has how it works and who did what. [BUILD_PLAN.md](BUILD_PLAN.md) has what's next.

Made by Ali, Nurislam, Rasim and Nurassyl at the Lehigh hackathon.
