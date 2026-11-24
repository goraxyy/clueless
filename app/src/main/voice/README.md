# Voice

Two halves, both with their keys kept in the main process (`app/.env`), never in the UI.

**Talking to Clueless** (`deepgram.ts`, needs `DEEPGRAM_API_KEY`)
- The mic button (or `Cmd/Ctrl + Shift + 1`) records in the UI (`renderer/src/voice/useVoiceInput.ts`)
  and streams the audio here.
- This file forwards it to Deepgram over a WebSocket and sends the words back as they're heard.
- Recording stops on its own when you pause. What you said is sent exactly like a typed message.

**Clueless talking back** (`elevenlabs.ts`, `ELEVENLABS_API_KEY`, optional)
- The UI asks for one piece of text at a time (`renderer/src/voice/speech.ts`); this file turns it into
  audio with ElevenLabs.
- `ELEVENLABS_VOICE` picks the voice by name or ID. A voice the plan doesn't include falls back to a
  free one, and a model the plan doesn't include falls back to the fast one.
- No key, a rejected key, or no characters left: the UI uses the computer's own voice (and, when
  something went wrong, says what).
- A key changed in `.env` is picked up without restarting the app.

**Voice mode** (`renderer/src/voice/voiceMode.ts`) is one switch for the whole window: on, replies are
read aloud. The visual island has its own voice switch and reads each step in time with the animation.
