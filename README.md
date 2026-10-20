# Clueless

[![Watch the Clueless demo](https://img.youtube.com/vi/BK3x3UDiUfQ/hqdefault.jpg)](https://youtu.be/BK3x3UDiUfQ)

**[Watch the demo video](https://youtu.be/BK3x3UDiUfQ)**

| Keys | |
|---|---|
| `Cmd/Ctrl + Shift + Space` | read the screen |
| `Cmd/Ctrl + Shift + 2` | select just the problem |
| `Cmd/Ctrl + Shift + 1` | talk |
| `Cmd/Ctrl + Shift + 3` | show or hide the island |
| `Esc` | hide the panel |

A small study helper that sits on top of whatever you're working on. When you're stuck, it looks at
the problem on your screen and helps you work through it with questions and small hints, instead of
giving you the answer. Code, math, physics and most other problem sets, on macOS and Windows.

- **The panel** walks you through one step at a time:
  - hints that get a little more specific each time
  - checks math answers
  - can animate your code or the idea behind a question
  - can talk
  - ends with a short recap
- **The small window** (the panel shrunk): type a question right in it, talk with the mic, turn
  spoken replies on or off, and open settings (transparency, new session, quit).
- **The island** is for quick questions: highlight anything and pick a button next to the cursor.
  - **Ask** explains it in the panel.
  - **Animate** explains it with an animation and a voice in the **visual island**, a small window
    beside your text. Code runs step by step with its variables drawn as boxes; a math problem or a
    paragraph gets a picture of the idea. The line being explained lights up on your screen, in your
    browser or editor. Go back, stop, and change the speed from the visual island.

## Setup

You'll need [Node.js](https://nodejs.org) and access to Claude through Amazon Bedrock or a Claude API key.

```bash
cd app
npm install
cp .env.example .env
```

In `app/.env`:
- **Bedrock:** set `AWS_REGION` and `AWS_BEARER_TOKEN_BEDROCK` (or `AWS_PROFILE`), and turn on access
  to Claude Sonnet 5.5 and Haiku 5.5 in the Bedrock console.
- **Or the Claude API:** set `ANTHROPIC_API_KEY`.
- **Optional:** `DEEPGRAM_API_KEY` for talking, and `ELEVENLABS_API_KEY` for a nicer reading voice.

Then:

```bash
npm run try -- "Integrate x^2 e^x dx"   # checks it can reach Claude
npm run dev
```

On macOS, Clueless lives in the menu bar. The first time, allow these in System Settings → Privacy &
Security, then restart it:
- **Screen Recording**
- **Microphone**
- **Accessibility**, for the island to notice highlights

To read a highlight, the island presses `Cmd/Ctrl + C` for you and then puts your clipboard back. In a
terminal that stops the running program, so hide the island there.

On Windows PowerShell, use `npm.cmd` if `npm` scripts are blocked.

## Commands

| Command | |
|---|---|
| `npm run dev` | run the app |
| `npm run try -- "problem"` | the tutor in the terminal |
| `npm run trace -- code.py` | an Ask with Animate on, in the terminal |
| `npm run eval` | the model test set (a few dollars of Claude calls) |
| `npm test` | tests |
| `npm run typecheck` | type checks |
| `npm run dist:mac` / `npm run dist:win` | build an installer |

[DESIGN.md](DESIGN.md) has how it works and who did what. [BUILD_PLAN.md](BUILD_PLAN.md) has what's next.

Made by Ali, Nurislam, Rasim and Nurassyl at the Lehigh hackathon.
