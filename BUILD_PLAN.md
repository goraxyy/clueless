# Build plan

Tick a box by changing `- [ ]` to `- [x]`.

## Done

**The panel (the tutor)**
- [x] Floating panel over any app, macOS and Windows, including full-screen apps — Ali
- [x] Reads the screen, a selected area, or pasted text — Ali
- [x] Tutor on Claude (Amazon Bedrock or the Claude API): steps, hints that grow, gap types, recap — Ali
- [x] Answer checks for math and physics (math.js) — Ali
- [x] Stuck detection: idle screen, repeated wrong answers, answer sites — Ali
- [x] Gap tracking across sessions — Ali
- [x] Compact, Claude-orange panel that sizes itself to its content — Ali
- [x] "What's tripping you up?" after a scan, shorter replies, resizable panel, clickable plan steps — Nuris

**Voice**
- [x] Talk to Clueless (Deepgram) — Rasim
- [x] Replies read out loud (ElevenLabs, or the computer's own voice) — Rasim

**Animations**
- [x] Animate my code / the problem / the question, with a renderer for every visual type — Nurassyl
- [x] Code mode (drawn over your code) and explain mode (next to the conversation) — Nurassyl
- [x] Island: highlight code, Ask, watch a step-by-step trace (Cmd/Ctrl+Shift+3) — Nurassyl
- [x] Ask's animations drawn on the real screen (browser, PDF, editor); the answer in the panel; the pill is just two switches — Ali
- [x] Faster animations: Python is run for real (Pyodide) instead of the model writing the trace — Ali
- [x] Voice and animation in sync: each step is read aloud and the next waits for it — Ali
- [x] Ask / Animate buttons on a highlight; Animate plays in the visual island (its own window, with
  back, stop, speed and its own voice) while the line lights up on the screen — Ali
- [x] Animate on non-code (math, physics, a paragraph): a concept lesson, a scene per step — Ali

**The windows**
- [x] Small window: type a question, mic, spoken replies on/off, settings — Ali
- [x] Big window: settings on the right (transparency, new session, quit); no ✕ or transparency button — Ali

**Housekeeping**
- [x] Removed the browser preview (`npm run ui`) and its mock data: test in the real app — Ali
- [x] Restored work lost in the PR #3 merge, island as its own mode (PR #4) — Ali
- [x] Sonnet 5.5 for the tutor, Haiku 5.5 for small jobs, and a 15-problem model test set (`npm run eval`) — Ali
- [x] Removed flashcards (the recap and the gap list stay) — Ali
- [x] Simpler panel: 3 opening options, one answer box (no Answer / How do I write choice), one row
  of buttons (Hint, What next?, Check my work, Animate), the recap comes by itself, no Reveal or
  Finish, and every animation plays in the visual island — Ali
- [x] Highlights work from launch, not only with the pill open — Ali
- [x] Tests (127), typecheck, smoke test of the panel, the island, Python runs, the stage and the visual island

## Next

- [ ] Run the model test set on Sonnet and Haiku (`npm run eval`) once Bedrock access to them is on
- [ ] Run more languages for real (JavaScript next); Claude traces them for now
- [ ] Follow the code when the page scrolls, instead of hiding the line highlight
- [ ] Faster Animate: stream the reply and start at step 1, a smaller trace format, voice that
  doesn't hold up step 1

## Before the demo

- [ ] Run it with the team's Bedrock key: the 3 demo problems end to end
- [ ] Try to get it to give the answer away; tighten `app/src/main/tutor/prompt.ts` if it does
- [ ] Run it on Windows
- [ ] Record a backup video
- [ ] Pitch: the problem → coding, math and physics demos → the recap
