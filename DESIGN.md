# Design

Clueless is a small study helper that sits on top of whatever you're working on. When you're stuck, it
looks at the problem on your screen and helps you work through it with questions and small hints,
instead of giving you the answer.

## Why

One of us works as a TA, and he keeps seeing the same thing: students paste the question into an AI
tool, copy the answer, and learn nothing from it. Research says the same. In a 2024 UPenn study
(Bastani et al., *Generative AI Can Harm Learning*), high schoolers who practiced math with plain
GPT-4 did about 17% worse on the exam than students without AI. A version that gave hints instead of
answers removed most of that gap. Clueless is that hint-giving version, and it works on whatever is
on your screen.

## Who did what

| | |
|---|---|
| **Ali** | The idea and the docs. The app's base: the floating panel and small window, screen capture, the tutor (Claude prompt and engine), answer checks, stuck detection, gap tracking, Bedrock support, full-screen support. Highlights with Ask and Animate, the visual island, running code for real (Pyodide), the line highlight on the screen, voice in step with the animation, models per task with a test set. Repaired the PR #3 merge (PR #4). |
| **Nurislam** | The panel's opening: asks what's tripping you up after a scan, with options. Shorter replies, a resizable panel, clickable plan steps, layout fixes, and filling in fields Claude left out instead of asking again. |
| **Rasim** | Voice: talking to Clueless (Deepgram) and Clueless talking back (ElevenLabs). The UI pass on both windows (PR #6). |
| **Nurassyl** | The visual engine every animation is drawn with (arrays, grids, sets, maps, plots, vectors, trees, graphs), and the first version of highlight → Ask → step-by-step trace (PR #3). |

## How it works

1. You press `Cmd/Ctrl + Shift + Space` (or select an area, or type the problem).
2. Clueless reads the screen and asks what's tripping you up, with 3 options to pick from.
3. It breaks the problem into 3–6 steps and shows only the current one. You can click a step if
   you're stuck on it.
4. You answer or ask by typing or talking, all in one box. Every message goes with a fresh look at
   your screen. It checks your answer; if you're wrong, the next hint is a little bigger.
5. Under the reply, one row of buttons: **Hint**, **What next?**, **Check my work** and **Example**
   (a similar problem with different numbers, worked up to your step). The play button by the mic
   animates the idea at your step, with a voice.
6. Once the whole problem is solved, a short recap comes by itself, and the gaps it noticed are saved
   for next time.

The panel shows only your latest message and the latest reply.

**Highlights** are a second, quicker way in: highlight anything, in any app, and two buttons appear
next to the cursor.
- **Ask**: the answer shows in the panel. Follow-up questions go in the box under it.
- **Animate**: the answer is explained step by step in the **visual island**, a small window of its
  own beside your text, with a voice in step with the picture.
  - Code runs for real and its variables are drawn as boxes. On your screen, the line each step is
    about lights up, with a tag for conditions (true or false), loop passes and return values.
  - Anything else (a math problem, a paragraph) gets a short lesson, a picture per step, that sets
    up the idea but never solves it.
  - Its buttons: back, play/pause, forward, stop, speed (0.5× to 2×, voice included) and voice on/off.
    Drag it anywhere. A finished animation stays up until you stop it, so you can step back through it.

**The pill** (`Cmd/Ctrl + Shift + 3`) has the **Highlight** switch, which turns the two buttons off.

**The windows.** The panel's header has your gaps, shrink, and settings (transparency, new session,
quit). Shrunk, it's a small bar: the logo reads the screen, a box takes a typed question or answer,
the mic talks, the speaker turns spoken replies on or off, and settings slide down under it.

## Rules the tutor follows

1. No final answers or full solutions.
2. One question at a time.
3. When you're wrong, it asks you to check (trace the code, take the derivative, try an extreme case)
   instead of pointing at the mistake.
4. Forgotten syntax or formulas get answered directly; that isn't the lesson.
5. It stays quiet while you're making progress and never pops open by itself.
6. It shows up on screen shares like any other window.
7. The screen goes to Claude only when you ask something: a hotkey, a message, Ask or Animate. Stuck
   detection uses tiny thumbnails that stay on the laptop.
8. Text on the screen is treated as part of the problem, never as instructions.

## Kinds of help

| You... | It... |
|---|---|
| forgot syntax or a formula | shows it, with the common mistake |
| don't get the idea yet | gives a short side lesson with a tiny exercise |
| aren't sure which approach | asks questions |
| made a small slip | asks you to check your work |
| want to see it done once | works a similar example with different numbers |

Hints get bigger one level at a time: where you are, a question, a smaller question, an outline,
then just the next step.

Subjects: coding, math and physics have their own checks (trace a small input; differentiate back or
plug in a number; units and extreme cases). Anything else gets the same loop with an
explain-it-back check.

## How it's built

```
Electron app
  main process   windows, hotkeys, screen capture, Claude calls, code runs, voice, memory
  panel          the tutor (React), also the small window
  island         the pill and the Ask / Animate buttons
  visual island  an animation's picture, voice and controls
  stage          a see-through window over the screen: the line an Animate step is on
```

**Claude.** Through Amazon Bedrock or the Claude API, picked from `app/.env`.
- The tutor (hidden solution, hints) runs on Claude Sonnet. Small jobs (Ask on a highlight, setting
  up a code run, follow-ups) run on Haiku, so they come back in a second or two.
- On the Claude API, replies are structured JSON. On Bedrock, which has no structured outputs,
  Claude replies through a `reply` tool with the same shape. The app checks every reply, fills in
  fields Claude left empty, and asks once more if it still doesn't fit.
- The first turn of a problem thinks harder than later turns. Prompt caching keeps follow-ups cheap.
- `npm run eval` checks a model on 15 problems (5 LeetCode medium/hard, 5 Calc 2, 5 CS concepts):
  LeetCode solutions are run against tests, the rest is graded by a judge model, and every reply is
  checked for giving the answer away.

**Answer checks.** math.js decides whether two expressions are equal, checks antiderivatives by
differentiating, and compares units.

**Animations.**
- Animate on Python code runs it for real. Haiku picks a small input and how to call the code.
  Pyodide (Python in WebAssembly) runs it in a worker thread with a step and time limit, and every
  line and value change becomes a step. A crash in your code shows where it happens. Other
  languages, or a run that won't start: Claude writes the steps instead, which is slower.
- Animate on anything that isn't code, and the play button in the panel: Claude writes a short
  lesson, each step a scene (arrays, grids, sets, maps, plots, vectors, trees, graphs) with a
  sentence to say over it. Scenes are drawn with React and Motion.
- Where the highlight is on screen comes from where your drag started and ended and how many lines
  you copied, fine-tuned on the screenshot: lines of text have ink and the gaps between them don't,
  and the edges stop at the code (not the line numbers or the panel next to it). Scrolling hides the
  line highlight, since it would no longer line up; the visual island plays on.

**Voice.** Deepgram turns speech into text in the main process. ElevenLabs reads replies aloud, or
the computer's own voice if there's no key or the characters run out. In the visual island, code
steps are narrated from the run itself (no model call), lesson steps read the line Claude wrote, and
the next step starts when the current line has been read.

**Memory.** One JSON file in the app's data folder: gaps seen and past sessions.

**Stack.** Electron, React, TypeScript, Tailwind, Motion, Claude (Amazon Bedrock), Pyodide, Deepgram,
ElevenLabs, math.js, KaTeX and uiohook-napi.

## Known limits

- Only Python is run for real; other languages are traced by Claude, which takes longer.
- The line highlight lines up with your text only while the page stays put. A paragraph that wraps
  onto several screen lines counts as one line.
- Built and tested on macOS. The Windows build is in the code but has had little testing.

See [BUILD_PLAN.md](BUILD_PLAN.md) for what's next.
