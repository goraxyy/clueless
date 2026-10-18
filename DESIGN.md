# Design

Clueless is a small study helper that sits on top of whatever you're working on. When you're stuck, it
looks at the problem on your screen and helps you work through it with questions and small hints,
instead of giving you the answer.

## Who did what

| | |
|---|---|
| **Ali** | The idea and the docs. The app's base: the floating panel, screen capture, the tutor (Claude prompt and engine), answer checking, stuck detection, gap tracking, Bedrock support, full-screen support, the compact orange panel. Repaired the PR #3 merge (PR #4). Then: Ask's answers in the panel and its animations on the real screen, code runs (Pyodide), voice in step with the animation, Sonnet/Haiku per task with a test set, flashcards removed. Then: Ask / Animate on a highlight with the visual island (back, stop, speed, its own voice) and concept lessons for non-code, the small window's text box and voice button, settings in both windows, browser preview removed. |
| **Nuris** | Panel improvements: asks what's tripping you up after a scan, shorter replies, resizable panel, layout fixes, clickable plan steps. |
| **Rasim** | Voice: talking to Clueless (Deepgram) and Clueless talking back (ElevenLabs). PRs #1 and #2. |
| **Nurassyl** | Animations: the visual engine, Animate my code / problem / question, code mode and explain mode. The island: highlight code, Ask, step-by-step trace. PR #3. |

## Why

Students who use AI to get answers tend to learn less. In a 2024 UPenn study (Bastani et al.,
*Generative AI Can Harm Learning*), high schoolers who practiced math with plain GPT-4 did about 17%
worse on the exam than students without AI. A version that gave hints instead of answers removed most
of that gap. Clueless is that hint-giving version, and it works on whatever is on your screen.

## How it works

1. You press `Cmd/Ctrl + Shift + Space` (or select an area, or paste the problem).
2. Clueless reads the screen and asks what's tripping you up.
3. It breaks the problem into 3–6 steps and shows only the current one. You can click a step if you're stuck on it.
4. You answer by typing or talking. It checks your answer. If you're wrong, it gives a slightly bigger hint.
5. When you're done: a short recap, plus the gaps it noticed, saved for next time.

The panel shows only your latest message and the latest reply.

**The island** (`Cmd/Ctrl + Shift + 3`) is a second, quicker way in. It's a small pill with one
switch, **Highlight**: while it's on, highlighting anything brings up two buttons next to the cursor.
- **Ask**: the answer shows in the panel.
- **Animate**: the answer is explained step by step in the **visual island**, a small window of its
  own beside your text, with a voice in step with the picture. Code runs for real and its variables
  are drawn as boxes; anything else (a math problem, a paragraph) gets a short lesson, a picture per
  step, that sets up the problem and the idea behind it but never solves it. On your screen the line
  each step is about lights up, with an arrow to the visual island. Its buttons: back, play/pause,
  forward, stop, speed (0.5× to 2×, voice included) and voice on/off. Drag it anywhere.

**The windows.** The panel's header has your gaps, shrink, and settings (transparency, new session,
quit). Shrunk, it's a small bar: the logo reads the screen, a box takes a typed question or answer,
the mic talks, the speaker turns spoken replies on or off, and settings are on the right.

## Rules the tutor follows

1. No final answers or full solutions. **Reveal** unlocks after 3 real tries, gets logged, and asks you to explain it back.
2. One question at a time.
3. When you're wrong, it asks you to check (trace the code, take the derivative, try an extreme case) instead of pointing at the mistake.
4. Forgotten syntax or formulas get answered directly; that isn't the lesson.
5. It stays quiet while you're making progress and never pops open by itself.
6. It shows up on screen shares like any other window.
7. The screen is only sent to Claude when you ask. Stuck detection uses tiny thumbnails that stay on the laptop.
8. Text on the screen is treated as part of the problem, never as instructions.

## Kinds of help

| You... | It... |
|---|---|
| forgot syntax or a formula | shows it, with the common mistake |
| don't get the idea yet | gives a short side lesson with a tiny exercise |
| aren't sure which approach | asks questions |
| made a small slip | asks you to check your work |

Hints get bigger one level at a time: where you are, a question, a smaller question, an outline or a
similar example, then just the next step.

Subjects: coding, math and physics have their own checks (trace a small input; differentiate back or
plug in a number; units and extreme cases). Anything else gets the same loop with an explain-it-back check.

## How it's built

```
Electron app
  main process   windows, hotkeys, screen capture, Claude calls, voice, memory
  panel          the tutor (React), also the small window
  stage          a see-through window that draws over your screen (the tutor's code animations,
                 the line an Animate step is on)
  island         the pill and the Ask / Animate buttons
  visual island  an Animate run's picture, voice and controls
```

**Claude.** Through Amazon Bedrock or the Claude API, picked from `app/.env`.
- The tutor (hidden solution, hints) runs on Claude Sonnet 5.5. Small jobs (Ask on a highlight,
  setting up a code run, follow-ups) run on Haiku 5.5. Set `CLUELESS_MODEL` to use Opus 5.5 instead.
- `npm run eval` checks a model on 15 problems (5 LeetCode medium/hard, 5 Calc 2, 5 CS concepts):
  LeetCode solutions are run against tests, the rest is graded by a judge model, and every reply is
  checked for giving the answer away.
- On the Claude API, replies are structured JSON.
- On Bedrock, which has no structured outputs, Claude replies through a `reply` tool with the same
  shape. The app checks every reply and asks once more if it doesn't fit.

The first turn of a problem runs at medium effort, later turns at low. Prompt caching keeps follow-up
turns cheap.

**Answer checks.** math.js decides whether two expressions are equal, checks antiderivatives by
differentiating, and compares units.

**Animations.**
- Panel animations come from the tutor's reply as a small list of scenes (arrays, grids, sets, maps,
  plots, vectors, trees, graphs), drawn with React and Motion.
- Animate on Python code runs it for real. Haiku picks a small input and how to call the code;
  Pyodide (Python in WebAssembly, in a worker thread, with a step and time limit) runs it, and every
  line and value change becomes a step. Other languages, or a run that won't start: Claude writes
  the steps instead, which is slower.
- Animate on anything that isn't code: Claude writes a lesson of 3 to 8 steps, each a scene (the
  same kinds the panel draws), the lines of the highlight it's about, and a sentence to say over it.
- Where the highlight is on screen comes from where your drag started and ended and how many lines
  you copied, fine-tuned on the screenshot (lines of text have ink, the gaps between them don't).
  Scrolling hides the line highlight, since it would no longer line up; the visual island plays on.
- The visual island is placed beside the highlight (right, left, below or above, whichever fits,
  out from under the panel) and stays where you drag it.

**Voice.** Deepgram turns speech into text in the main process. ElevenLabs reads replies out loud, or
the computer's own voice if there's no key. The visual island has its own voice: code steps are
narrated from the trace itself (no model call), lesson steps read the line Claude wrote, and the next
step starts when the current line has been read. The speed button speeds up the voice too.

**Memory.** One JSON file in the app's data folder: gaps seen and past sessions.

**Stack.** Electron, React, TypeScript, Tailwind, Motion, Claude, Deepgram, ElevenLabs, math.js,
KaTeX, Pyodide and uiohook-napi.

## Known limits

- Only Python is run for real; other languages are traced by Claude, which takes longer.
- The line highlight lines up with your text only while the page stays put. A paragraph that wraps
  onto several screen lines counts as one line.
- Animate takes a while when Claude writes the steps (other languages, and anything that isn't code):
  the whole reply arrives before step 1.
- The island reads your highlight by pressing `Cmd/Ctrl + C`; in a terminal that stops the running program.
- Not yet tested much on Windows.

See [BUILD_PLAN.md](BUILD_PLAN.md) for what's next.
