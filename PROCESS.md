# How we worked with AI

A running log of how team Random used coding agents (Claude Code and others)
to build this. Newest entries at the bottom. Format:

```
## <time UTC> · <who / which agent> · <stream>
Asked: ...
Got: ...
Checked / changed / rejected: ... and why
```

## 2026-10-24 · RoopeS + Claude Code · planning

Asked: read the challenge packet (brief, ops context, schema, starter, data) and
summarise the task; then turn our ideation (driver "sink" with AI interview,
OBD2 dongle, journey photos, rulebook-driven agent, dark mode, map) into a plan.

Got: a summary of the brief and the judging weights, demo-worthy cases found in
the data (CD-420322 warning light, CD-420299 sold-out ferry), and a draft plan.

Checked / changed / rejected:
- The agent found the tracking data has no coordinates, so a "live map" would
  invent positions. We chose simulated phone GPS, labelled as simulated.
- It flagged that 22 of 103 vehicles are electric, where standard OBD2 data is
  thin. Demo cases use petrol cars, and the pitch mentions the EV limit.
- It recommended text chat first; we overrode that and chose live voice + chat
  + photos. The plan builds voice as a layer on a working chat agent, so the
  chat path is a fallback.
- Drivability policy: safety-only advice by the agent; "keep driving" needs an
  operator yes.
- Result: `PLAN.md`.

## 2026-10-24 · RoopeS + Claude Code (local) · plan review

Asked: find the holes in PLAN.md while cloud instance 1 builds streams A+B
and a teammate builds voice.

Got: twelve gaps, most importantly: no owner for the simulator/driver app, no
contract between voice and the agent, no rule for when the agent runs
(the brief's example is proactive, our plan was driver-initiated), and no
story for what happens after a decision. The agent also checked the data for
scenario A and found CD-420584 has a booked ferry with a 15:30 check-in
cutoff, which turns a breakdown into the multi-step chain the brief describes.

Checked / changed / rejected:
- Rejected the agent's suggestion to run a triage pass over all ~30 dataset
  orders needing a person; we keep the queue to road and driver cases.
- Rejected the real-phone demo (needs HTTPS for the mic); second laptop
  window instead.
- Kept "operator logs the outcome" after a phone call instead of a simulated
  dealer reply, because it matches "the person makes the call".
- Added: channel API contract (4.2c), triggers and per-case run lock, decision
  options and per-action effects (4.2b), live judging prep, a second cloud
  instance for stream C (we ended up with three cloud instances, one each for A, B and C).

## 2026-10-24 · RoopeS + Claude Code (local) · open questions

Asked: resolve the plan's open questions.

Got / decided:
- Our event credits are OpenRouter keys, not Anthropic keys. Before changing
  the plan, the agent made one real tool call through OpenRouter's
  Anthropic-compatible endpoint (Opus 5.5, strict tool schema, effort) to
  check it works with the official Anthropic SDK. It did ($0.003). Third-party
  docs found by search were treated as hints only, not facts.
- Checked the data for the customer rule: the delivery site is the paying
  customer on 63 orders, the pickup site on only 4, so the "site owned by the
  customer counts as the customer" rule really matters.
- Picked scenario D from the data (CD-420442, Stockholm pickup desk).
- Customer replies always need approval, even when the customer wrote first.
- Product name: Road Desk.

## 2026-10-24 · RoopeS + Claude Code (local) · voice design

Asked: the best approach for voice. Requirements from us: a reliable
transcript for later use, an interview that asks the right things with low
latency, the agent works through the transcript afterwards, and the first
question decides whether it is urgent. Mentioned Moshi as an option. Also
pasted another LLM's suggestion (ElevenLabs through OpenRouter for speech
out, Chrome for speech in).

Got: before deciding, the agent measured instead of guessing:
- OpenRouter's model list: there is no Moshi or other full-duplex model.
  There are 36 speech models and 28 transcription models.
- A round trip: ElevenLabs Flash speech in 0.63 s; four transcription models
  in about 1.1 s each, all accurate.
- First words: Haiku 5.5 0.75 s, Sonnet 5.5 0.84 s, Opus 5.5 5.9 s.

Checked / changed / rejected:
- Rejected the full Opus agent inside the live call: 5.9 s per turn is too
  slow. Split instead into a fast interviewer (Sonnet, preloaded context,
  slot-filling) and an Opus analyst that works on the transcript.
- Kept Chrome speech recognition only for live speed. The transcript of record
  comes from recording each utterance and transcribing it on the server,
  because Chrome keeps no audio and is unreliable in a noisy hall.
- Rejected speech-to-speech models (no explicit transcript, harder rule
  control), but kept the VoiceProvider swap point.
- Added the echo problem (laptop speakers + mic): half-duplex for the demo.
- Noticed Sonnet volunteered mechanical detail ("cylinder 2, catalytic
  converter") in the latency test: the interviewer prompt must hold to
  safety-only advice.

## 2026-10-24 12:50 UTC · local Claude Code agent (worktree, branch voice/core) · V voice

Asked: build stream V from PLAN.md 4.6: interviewer, transcript tables,
voice routes, `<CallScreen>`, a test page and a text harness. Mid-task the
coordinator added four rules: template-only safety lines, a drivability
screen on every utterance, honest goodbyes (a time only when stored as
`next_check_at`), and a reply deadline ending in `no_response`.

Got:
- `lib/voice/`: the urgency-first interviewer (Sonnet 5.5, effort low,
  context preloaded through `lib/present/load.ts`). It streams the spoken
  reply sentence by sentence, then a strict `record_call_state` tool call
  with urgency and quote, situation, and slots
  `{ value, turn_id, quote, confidence }`. Server-side phases cover the
  checklist, read-back and closing. Also: safety templates with ids, the
  `screenDriverUtterance` screen, a TTS cache (memory plus disk), STT, and
  `VoiceProvider` (OpenRouter, plus a browser fallback).
- Tables `cr_calls` and `cr_call_turns`, pushed with `db:push` (the plan
  showed only `CREATE` statements). The drizzle schema is now
  `["./lib/schema.ts", "./lib/*/schema.ts"]`.
- Routes `/api/voice/calls`, `/turns` (server-sent events), `/end`,
  `GET /calls/:id`, `/api/voice/speak`, plus one extra route,
  `GET /calls/:id/audio/:turnId`, for the case page's play button.
- `app/driver/voice/call-screen.tsx` (hands-free VAD, push-to-talk,
  half-duplex, captions, urgency badge, mute, filler, speechSynthesis
  fallback) and the test page `/driver/voice/test`.
- `npm run voice:test` (four scripted calls plus screen cases, saved to
  `traces/voice-*.json`) and `npm run voice:prerender`.

Checked by running it:
- Real requests before choosing formats: `/audio/transcriptions` accepts
  `format: "webm"` from Chrome's MediaRecorder (also ogg, wav, m4a). A webm
  clip labelled as mp3 returns a 400.
- Haiku 5.5 thinks by default and spent all 700 output tokens on thinking,
  so no text came back. It accepts `thinking: {type: "disabled"}`; Sonnet
  5.5 refuses that ("reasoning is mandatory") and takes `effort` instead.
- Streamed responses through OpenRouter carry no `usage.cost`; non-streamed
  ones do. Spend is estimated from tokens. Measured rates: Haiku $1/$5 and
  Sonnet $2/$10 per million tokens, ElevenLabs about $0.04 per 1,000
  characters.
- The harness passes all checks on Sonnet: urgency right for each script,
  urgency question first, slots filled with quotes from their own turn,
  read-back confirmed, emergency templates first, `call_urgent`/`call_ended`
  recorded, `next_check_at` stored, and no mechanical, drivability, meta or
  free-worded safety text spoken. Median latency: model first text
  0.9–1.2 s, first screened sentence 1.9–2.3 s.
- An HTTP smoke run on port 3001 with a real webm clip: STT text of record
  stored beside the live text, clips in the object store, every route answering.

Changed / rejected:
- Rejected Haiku 5.5 as the interviewer, even for the harness. With
  thinking off it spoke its instructions aloud ("This is URGENT…", "Answer
  from the facts: … then ask the first missing item"). The harness uses
  Sonnet as the interviewer; Haiku only runs the screen classifier.
- The first screen prompt blocked a correct read-back as DRIVABILITY and our
  own "your case is at the top of our list" as PROMISE. Rewrote it with
  allow examples and kept both sentences as regression cases. An empty or
  unclear classifier answer once counted as ALLOW; now it fails closed for
  driving-related sentences.
- My free-text-to-template safety mapping replaced a whole read-back with
  "Please switch the engine off." because it mentioned "engine off". It now
  only maps instructions (imperatives or "you should").
- A safety template is not repeated within two turns (the emergency run said
  "behind the barrier" three times).
- After a read-back, the fixed "Thanks, that's noted." plays at once, then
  the fixed closing, instead of the model's acknowledgement, which tended to
  repeat the next step.
- Added beyond the plan's columns: `cr_calls.state` jsonb (phase, context
  facts with sources, urgency quote, triggers, spend), `cr_calls.next_check_at`,
  and `cr_call_turns.flags` jsonb (safety templates used, screen results,
  raw model text, timing, silence).
- Audio: per-turn clips go to the object store (`voice/calls/<id>/…`), with a
  local-disk fallback (`.voice-cache/clips`). TTS cache is in
  `starter/.voice-cache/tts` (gitignored). No whole-call recording, so
  `recording_key` stays null.
- Stream A has no call trigger route yet. Voice POSTs
  `{ trigger, callId, orderRef, urgency }` to `VOICE_AGENT_TRIGGER_PATH`
  (default `/api/agent/call`). It gets a 404 today and records the trigger
  on the call (TODO in `lib/voice/triggers.ts`).
- Scripts import `lib/db.ts`, which imports `server-only` (not an installed
  package). `scripts/voice-register.mjs` resolves it to an empty module for
  tsx. Shared files touched: `drizzle.config.ts`, `package.json` (two
  scripts plus `@anthropic-ai/sdk`), `.gitignore` (`.voice-cache/`), and
  `.env.example` (VOICE_ lines).
- Not verified: a live microphone call in Chrome. The browser extension
  was not connected in this session, so the call screen is only typechecked,
  built and rendered on the server.
