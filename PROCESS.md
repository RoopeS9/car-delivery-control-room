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

## 2026-10-24 · RoopeS + Claude Code (local) · second plan review

Asked: assess a plan review from another LLM (nine holes) and fold in the good
parts.

Got: Claude agreed with eight of the nine points and partly agreed with
point 9. It also owned one mistake of its own: the scenario scripts stated
conclusions the evidence didn't yet support ("the 26 Oct delivery is at risk"
before any recovery estimate; "he has not started" where the data only shows
no recorded start).

Checked / changed / rejected:
- Reversed our earlier "road cases only" queue decision: one queue for every
  order needing a person, in three sections (needs your decision / agent
  working / waiting). The judges score the control room, not a support module.
- Added follow-up state (next action, waiting on, next check), a follow-up
  trigger, a watchdog and failure handling; a new failure scenario F (driver
  goes silent on CD-420537, whose app had really stopped reporting at 08:02).
- Separated operator approval from customer agreement (promise states), and
  made approvals bound to a revision, rechecked before execution and executed
  once, with an "outcome unknown" reconciliation state.
- Added channel boundaries: per-audience context, server-side identity
  check, a drivability screen on outbound driver messages, template-only
  safety instructions.
- One reading layer over the dataset plus executed changes, and links from
  cases to imported work items so they don't duplicate.
- Cut: about 15 trouble codes instead of 40, only decision-relevant OBD
  signals, simulated driver for the video only. Kept the map and voice.
- Reserved 40 s of the video for the process story.

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

## 2026-10-24 13:05 UTC · local Claude Code agent (worktree, branch voice/core) · V voice, review fixes

Asked: the coordinator reviewed `traces/voice-warning-light.json` and found
two problems. Every scripted check had passed. The first one came from a
human-style read of the transcript, not from any check.
1. The driver said "No smoke, but a bit of a petrol smell" and the
   interviewer moved on. A fuel smell is a safety signal.
2. After "Is there anything else we should know?" and "No, that's
   everything.", the interviewer said "Sorry, could you tell me a little more
   about what's happening?" before the read-back.

Got (cause of 2): the model returned no speakable text on that turn, even
after the engine's own "now say your reply" follow-up. My empty-reply rule
then filled the gap with the generic re-prompt. Neither the step logic nor
the error fallback caused it (no engine error on that turn).

Changed:
- **Safety signals detected in the extraction step.** The strict
  `record_call_state` schema now has a required `safety_signal` field
  (`NONE`, `FUEL_SMELL`, `BURNING_SMELL`, `SMOKE`, `FIRE`, `FLUID_LEAK`,
  `OVERHEATING`, plus quote and turn), so a paraphrase like "smells like gas"
  is caught. The prompt also explains negation ("no smoke" is not a signal).
  - The prompt tells the model to lead its reply with the template tags. If
    it doesn't, the server speaks the templates in the same turn
    (`LEAVE_CAR_BARRIER`, with `CALL_112` for smoke or fire).
  - The server raises urgency to at least URGENT (EMERGENCY for smoke or
    fire) and records a `safety_signal` slot with quote and turn.
  - The read-back note puts the signal first.
  - After a signal the model must never ask the driver to start, move or get
    back into the car. A run showed it asking "when you turn the key, does
    the car start?" after the petrol smell, an item that isn't in the
    warning-light checklist. It may now ask only listed missing items.
- **Empty replies decided from the interview state.** If the model says
  nothing of its own, the server reads back when the checklist is complete,
  otherwise it asks the next missing item with a fixed question
  (`SPOKEN_QUESTIONS`). The generic re-prompt is gone, and so is the
  engine's follow-up call. A plain "no, nothing else" after the
  anything-else question closes that slot deterministically.
- **Harness.** Scenario A now expects `safety_signal` and checks four things:
  - the agent turn right after the petrol smell speaks the leave-the-car
    template
  - the slot has its quote and turn
  - urgency is at least URGENT
  - the read-back leads with the signal

  A new script, `burning-smell`, has a driver mention "a burning smell"
  partway through a battery-light call, with the same checks. A new check
  fails any re-prompt after an answered turn, and any question repeated
  after the driver's answer filled that slot. (A first version flagged a
  legitimate repeat where the scripted driver hadn't answered, so it now
  looks at the slot.)

Checked by running it: all five scripts pass. Scenario A came from a rerun
after the last prompt change; the other four are from the full run just
before it. In the new scenario A trace the server's empty-reply path fired
once and asked the next item ("asked light after an empty reply"), not a
vague re-prompt. Spend for these fixes was $0.41 (two targeted runs and one
full run). `npm run typecheck` and `npm run build` pass.

Lesson: the scripted checks tested what we had thought of. Reading the
transcript as a person found the petrol smell. Both findings are now
assertions.

## 2026-10-24 ~11:45 UTC · Claude Code (stream A agent) · M0 foundation

## 2026-10-24 ~12:15 UTC · Claude Code (stream A agent) · M0 foundation

## 2026-10-24 ~11:45 UTC · Claude Code (stream A agent) · M0 foundation

Asked: do M0 (shared contract) since `lib/cr/` did not exist, then move on to
the agent.

Got: `starter/lib/cr/` with `types.ts` (enums, `SourceRef`, `HandoverPacket`,
OBD/GPS shapes), `schema.ts` (six `cr_` tables, no foreign keys into starter
tables), `queries.ts` (store/fetch only; gates stay in `lib/agent`),
`clock.ts` (simulated clock from `SIM_NOW`) and `db.ts`. Drizzle config now
pushes both schemas; agent env vars added to `.env.example`.

Checked / changed / rejected:
- Read `scripts/seed.ts` first: it truncates only starter tables, so `cr_`
  rows survive a reseed. Verified by reseeding with the new tables present.
- `lib/db.ts` imports `server-only`, which throws under `tsx`. Rather than
  edit the starter file, `lib/cr/db.ts` opens its own client so tests and
  scripts can share the same queries as the app.
- Added fields the plan's table list lacked but the UI and gates need:
  `channel` and recipient on events (to audit "never contacted a customer"
  and to render the driver thread), `waiting_on` / `next_step` on cases,
  and `transitionProposal()` that only updates from an expected status so a
  double click cannot execute a proposal twice.
- Customer contact is pinned to ASK_FIRST in two places: `setAutonomy`
  refuses it, and `getAutonomy` ignores any stored row for it.
- No Docker daemon in the cloud machine: ran the system Postgres 16 on port
  5438 instead. Node 22 (not 24) here; seed, typecheck and smoke all pass.
- Left the dark-mode token skeleton (also M0) to stream B, since
  `globals.css` is theirs.

## 2026-10-24 ~11:55 UTC · Claude Code (stream B, cloud instance 2) · control room M0 + M1 UI

Asked: own workstream B; do M0 if `lib/cr/` is missing, then work toward M1;
stay in B's folders; keep smoke passing.

Got: dark theme and theme toggle, the old board moved to `/board`, a new
"Needs you" queue on `/`, and an order page that opens with the case: a
decision card, a "Log what happened" box, a merged timeline and an "Ask the
agent" box.

Checked / changed / rejected:
- Did not write `lib/cr/`. Stream A's session was already doing it (seen in its
  task list). Two contracts would have collided, so B messaged A with what the
  UI needs and built on A's branch once it was pushed.
- Every colour is a token now (three hard-coded `rgba` values found and
  replaced). The dark palette applies before first paint, so a saved choice
  never flashes the light theme.
- First queue draft also listed the 18 dataset orders with warn/danger
  attention. Dropped after the plan update: the queue shows only our cases,
  plus one quiet line ("43 other orders need a person …") linking to the board.
- Screenshot review caught the global `.tone-danger` text colour leaking into
  the whole decision card, so all its text rendered red. Fixed by moving those
  containers to a `data-tone` attribute.
- Screenshot review also caught a timeline that folded every line ("Show 24
  earlier"). The fold point is now the earlier of the case opening and the
  first live line.
- The 4.2b "I'll handle it" and "Tell the agent instead" decisions are not in
  A's `DecisionRequest` yet. Proposed the shape to A. Tested the whole flow
  (handle → log outcome → case waits on roadside help → queue updates) against
  a local stub route that was not committed, because `app/api/cases/` is A's.
- The board and the record still agree on "needs a person" for all 100 orders
  with a live case in the database (smoke). A missing `cr_` table falls back to
  the snapshot instead of breaking the starter.

## 2026-10-24 ~12:00 UTC · Claude Code (stream A agent) · agent core + channel routes

## 2026-10-24 ~13:30 UTC · Claude Code (stream A agent) · agent core + channel routes

Asked: build the agent (loop, tools, gates) toward M1; mid-way, pull the
updated plan (OpenRouter, channel contract 4.2c, decision options 4.2b,
triggers) and follow it.

Got: `lib/agent/` (OpenRouter client, context loader, tools, approval gate,
prompts, loop, triggers) and the routes other streams build against:
`/api/channels/{driver,site}/messages` (SSE), `/api/channels/photos`,
driver and site feeds, `/api/cases` (list, detail, decide, outcome,
instruct), `/api/agent/{ask,telemetry,runs}`. Without a key every route
works in stub mode: a fixed reply, and the case goes to a person.

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

## 2026-10-24 ~12:00 UTC · Claude Code (stream C, cloud instance 3) · simulator, route shapes, dashboard photo, scenario A, /demo

Asked: own stream C. Until instance 1 pushes the channel stubs, build the GPS
and OBD generators, route shapes through the ferry terminals and the
dashboard photo; then scenario `warning-light-584`, the `/demo` reset and the
driver app shell.

Got: `lib/sim/` (fleet, motion, sync, scenarios, status), `/api/sim/*`
(scenarios, tick, state, telemetry per order), `/demo`,
`knowledge/routes/routes.json` (27 road legs, 2 sea lanes) and
`public/sim/dashboard-misfire.{svg,jpg}`.

Checked / changed / rejected:
- A "moving car" is an in-progress driver assignment, not an `IN_TRANSIT`
  order: three trade-in returns move while the order says delivered. Two
  cars in the data (CD-420735, CD-421013) have no app position at all; the
  sim gives them none and the panel says "position unknown" instead of
  inventing one. Its first draft did place them at the pickup city.
- Road shapes come from the public OSRM router once and are committed; sea
  lanes are drawn by hand. Rendered every route on a map and looked: the
  first West Baltic lane cut straight across Gotland, so it now runs east of
  the island. The Hamburg lane follows the Elbe and the Kiel Canal.
- The first sync back-filled ten minutes of simulated samples *before* the
  09:00 snapshot, where the dataset's own tracking records are the truth.
  Samples now start at the snapshot; stale phones keep only their last real
  report ("Last app position near Göttingen at 05:00").
- OBD follows the phone (the dongle relays through the driver app), so
  CD-420322, stopped with a dataset tracking gap, shows no invented engine
  data until its own scenario.
- Fault state lives in the `dtc` event's `data.sim`, not in memory: a
  restart keeps the scenario, a reset removes it, and the car's behaviour is
  a pure function of the plan and the sim clock. Compressed the stop to
  about 90 s (limp, pull in, idle, engine off) so a live demo does not wait.
- Dashboard photo is drawn (no brand marks) and rendered to JPEG with
  Playwright. First render had dial numbers off their ticks; recomputed from
  the scale angles. Checked by eye that the warning text and lamp read; a
  Claude vision check still needs an API key on a machine that has one.
- Not built here (stream A owns them): the channel routes and the agent
  trigger. The scenario calls `POST /api/agent/trigger {kind:
  "telemetry_fault", orderId, eventId}` and logs a 404 until it exists;
  that path is a proposal for instance 1, one constant to change.
- For streams A and B: call `syncTelemetry()` from `lib/sim/sync.ts` (or
  `POST /api/sim/tick`) before reading `cr_telemetry`; it is idempotent.

- Read the `claude-api` skill and the bundled Next 16 route docs first.
  The skill's defaults (server-side refusal `fallbacks`, beta client,
  `eager_input_streaming`) were dropped: OpenRouter does not support the
  beta parameters, and eager streaming would turn off the schema check that
  `strict: true` gives us. Refusals hand the case to a person instead.
- Rules live in code, not just the prompt: per-audience tool allowlists,
  order scoping for drivers and sites, `ask_site` refused for a site the
  customer owns, customer drafts forced to ASK_FIRST whatever the autonomy
  table says, and `executeProposal` refuses anything not approved.
- "Never tell the driver to keep driving" is checked on every message to a
  driver, including the streamed reply: the stream is released one sentence
  at a time and stops before a sentence that clears driving ("you can
  continue"), while negations and conditions ("not safe to drive", "until an
  operator confirms you can drive") pass.
- A reply to a site the customer owns is never streamed: it becomes a
  CONTACT_SITE_AS_CUSTOMER draft (plan: "replies count too").
- Driver and site turns stay fast and cannot propose; they call `hand_over`,
  and a separate deeper "prepare a decision" turn builds the card. This keeps
  voice replies quick and puts the careful work where the decision is made.
- Each turn starts fresh from a stable cached system prompt (principles +
  whole rulebook) plus case notes, and is append-only within the turn, so
  thinking blocks are never edited or replayed across turns.
- Deviation: photos are stored in Postgres (a `photo` event) instead of the
  S3 object store, which needs Docker; this machine has none.
- Telemetry stub reply first said "Thanks, we have your message" to a driver
  who had not written; replaced with a fixed safety-first line.
- Not yet run against the model: `OPENROUTER_API_KEY` is not visible in this
  session.

## 2026-10-24 ~12:00 UTC · Claude Code (stream B, cloud instance 2) · map, agent page, real routes

Asked: continue toward M1 on the control room side; the plan now asks for
5 decision buttons, 2–3 s polling and a queue with only our cases.

Got: `/map` (simulated phone positions by case state, stale ones hollow, a
side list and a panel with the case and the position's source), `/agent`
(what the agent does alone / asks first / never does, autonomy levels read
only with customer contact locked, recent steps, the rulebook rendered from
`rulebook/*.md`), and the order page wired to stream A's real decide,
outcome, instruct and ask routes.

Checked / changed / rejected:
- Picked CARTO basemaps first; the screenshot showed "API KEY REQUIRED" on
  every tile, so they are no longer keyless. Probed the alternatives with
  curl and switched to Stadia's light and dark tiles (keyless on localhost,
  where the demo runs), with filtered OpenStreetMap tiles as an automatic
  fallback.
- Positions are never guessed: cars on the road without a simulated position
  are listed beside the map, not drawn on a straight line.
- Ran the browser flow against A's routes (no model key, so the agent hands
  back to a person). That exposed desk ids in the gate's sentences ("Waiting
  on ops-shift to log what happened"). The presentation layer now replaces
  desk ids with titles ("the shift lead"). Told stream A as well.
- My first guess at how "I'll handle it" is stored (an execution marker) did
  not match A's gate (an approved card with no execution yet). Switched to A's
  semantics and read which button was used from the decision event.
- Rulebook inline code (`request_photo`, `STOP_NOW`) renders as plain words
  for operators instead of code.
- Smoke still reports agreement on all 100 orders; build passes.

## 2026-10-24 ~12:45 UTC · Claude Code (stream C) · driver app shell, wired to the agent

Asked: the driver app shell, against the 4.2c channel contract; then connect
the simulator to stream A's agent once their routes landed.

Got: `/driver` (pick a driver, then job card, car status bar, one thread
with Bahn, photo send, photo requests, safety instructions shown apart) and
`app/driver/channel.ts` (SSE reader, photo upload, feed polling) that the
site chat will reuse. Scenario A now calls stream A's real trigger
`POST /api/agent/telemetry`; my guessed `/api/agent/trigger` is gone.
Checked end to end in a browser (Playwright): reset, start the warning
light, the agent's first message arrives through the feed, a typed reply
streams back, the drawn dashboard picture uploads and survives a reload.
No model key on this machine, so the agent ran in stream A's stub mode.

Checked / changed / rejected:
- A driver sees only their own thread: dataset messages they wrote or that
  were addressed to them (PUBLIC), plus our events to or from them. No
  internal notes, customer mail or other drivers' work.
- The picker first listed the order's primary car and route; for a trade-in
  return (CD-420055) that is the wrong car. It now names the car and leg the
  driver is actually assigned. Demo drivers are listed first.
- Messages added in the browser were stamped with the real clock (12:09)
  while the server used the sim clock (09:00); the thread jumped on reload.
  The app now carries the server's sim-clock offset.
- At phone width the job card pushed the thread off screen. It now folds to
  car, route and the one time that matters next (ferry check-in, else
  delivery).
- Every instruction on the job card says where it came from ("From the
  place's standard instructions"), and the ferry line says "check-in not
  confirmed yet" rather than implying the driver is booked onto the ship.
- The Call button appears only once `/driver/voice` exists (voice stream).

## 2026-10-24 ~14:15 UTC · Claude Code (stream A agent) · M1 acceptance tests

Asked: prove in code that customer contact cannot happen without approval
(M1), and get scenario A ready to run end to end.

Got: `npm test` with 30 tests. `gate.test.ts` covers the approval rules against
the real database, no model needed. `loop.test.ts` covers the loop wiring,
using a scripted stand-in for the model. `npm run agent:scenario-a` runs
scenario A with the real model, a rule-based driver and the operator's "I'll
handle it", and saves every run plus a readable `timeline.md` under `traces/`.
The dashboard photo in the fixture is drawn with code, not photographed.

Checked / changed / rejected:
- The customer rule is tested the hard way. AUTO is written straight into the
  autonomy table, past `setAutonomy`'s own check, and the proposal still waits.
  Neither the agent nor an operator can execute it while it is pending. After
  approval it runs once, attributed to the operator, and a second click gets
  409 and changes nothing.
- The loop tests failed on the first run. It was not the code: open cases left
  over from my manual stub-mode calls were being reused, which is correct
  behaviour. I moved the loop tests to a quiet order (CD-420366) that no demo
  scenario uses, and clear it first, rather than wiping the whole table under
  teammates.
- Did not mock the model inside the real loop. The test hook only swaps the
  client, so the prompts, gates and delivery code that run are the real ones.
- Still open: a real-model run and its trace. `OPENROUTER_API_KEY` is not
  visible to this session.

## 2026-10-24 ~14:40 UTC · Claude Code (stream A agent) · plan re-check, out-of-date cards

Asked: pull, re-read PLAN.md 4.2–4.2c and 6, push the contract and channel
stubs first, then continue toward M1 (telemetry trigger, 4.2b decisions).

Got: main had nothing newer than the plan already merged. Checked the plan
line by line against what is built: contract and stub routes were already
pushed and both other streams had merged them and built against them (B's case
panel calls the routes; C's simulator posts to `/api/agent/telemetry`).
Neither touched stream A's folders. Built the one missing 4.2b item: "Facts
changed since this was drafted". `GET /api/cases/{id}` lists out-of-date cards,
and `POST …/proposals/{id}/refresh` sets one aside and has the agent draft a
fresh one.

Checked / changed / rejected:
- Only outside facts count as "changed" (driver, site, customer, car, phone).
  The agent's own notes and operators' actions do not, or every card would be
  stale the moment the agent logs anything. A test covers both sides.
- Refresh is refused (409) when nothing new came in, so it cannot be used to
  silently discard a card.
- Still blocked: the real-model M1 trace. `OPENROUTER_API_KEY` is not visible
  in this session.

## 2026-10-24 ~13:30 UTC · Claude Code (stream C) · scenarios B–F, site chat, plan update

Asked: scenarios B, C, D and the site chat; mid-way, pull the revised plan
(4.5: OBD cut to decision signals, new `site-eta-442` and
`driver-silent-537`, clock jumps on `/demo`, simulated driver last and for
the video only) and follow it.

Got: every scenario on `/demo` (A, B, C, D, F) plus reset, clock jumps
(+5/+15/+60) and the agent's running spend. B, C and D send their opening
message through the real channel routes after the scenario responds, so the
demo exercises the path a phone or browser uses. `/site` lets a pickup or
delivery desk write about one order. Checked each in the running app against
stream A's routes (stub mode: no model key here).

Checked / changed / rejected:
- OBD now carries only speed, coolant, battery voltage, engine on/off, the
  light and codes with a freeze frame; rpm, load, trims and misfire counts are
  gone, and electric cars drop coolant too. `engine_on` is not in the shared
  `ObdData` type, so the simulator writes it as an extra key (`SimObd` in
  `lib/sim/motion.ts`). **For streams A and B:** add `engine_on?: boolean` to
  `ObdData` and read it; stream B's strip still looks for `rpm`.
- Only the scenario cars (584, 145, 537) carry a dongle now, and it reports on
  its own rather than through the phone: scenario F needs coolant readings
  from a car whose driver app is silent.
- Scenario F's first draft started the coolant climb "90 s ago" so the code
  could fire at once. The trend then showed 90 °C right up to a 116 °C jump,
  because samples for those 90 s already existed. Now the climb starts at the
  click, the sync sets P0217 when it comes due (also inside a clock jump),
  writes the `dtc` event and calls the agent then. A minute later the dongle
  goes quiet while the car still moves at 78 km/h, so "is it still moving" is
  honestly unknown. CD-420537's app stays silent since its 08:02 report,
  as in the data.
- Scenario B keeps one stored code (P0217), not P0217 + P0299, so it depends
  on fewer entries in the trimmed trouble-code list.
- In stub mode a customer-owned desk got neither a reply nor
  `heldForApproval`, so the site chat showed nothing. It now says "Bahn has
  your message. A colleague will answer here shortly" whenever no answer
  streams back, and never tells the desk about internal approval.
- The clock jump calls stream A's `POST /api/cases/tick`, which does not exist
  yet; the panel says so instead of claiming follow-ups ran.
- A running dev server kept serving its cached fleet after the code changed
  shape; the cache is now versioned and reset reloads it.
- Not built yet, on purpose: the LLM simulated driver (video only, last).

## 2026-10-24 ~14:00 UTC · Claude Code (stream C) · routine seed, sim tests

Asked: `npm run sim:seed-routine` (4.5): genuine "handled by the agent" cases
for the queue, kept or dropped on reset; tests for the simulator.

Got: four routine driver questions on quiet moving orders, each answerable
from records (closing time in Tampere, who takes the keys in Hamburg, which
entrance in Turku, the storage gate in Helsinki). The seed calls stream A's
real turn functions, saves a readable `traces/routine-*/timeline.md` plus the
run JSON, and the `/demo` reset keeps those cases by default (a checkbox drops
them). `lib/sim/sim.test.ts` adds 8 tests to `npm test` (39 pass): phones only
report what the data supports, only scenario cars carry a dongle, OBD frames
carry only decision signals, scenario A stops and switches off, scenario F
sets P0217 and goes quiet while moving, ferry cars wait for their sailing,
and every road shape starts at its city or terminal.

Checked / changed / rejected:
- Picked the questions from the data, not from imagination: only orders whose
  delivery access is CONFIRMED, with no open alert or conversation, and not
  the two cars whose phones go quiet on purpose. A question the records cannot
  answer would make "handled by agent" a lie.
- The seed refuses to run without `OPENROUTER_API_KEY`. In stub mode every
  case is handed to a person, and keeping those would fill the "handled" list
  with fakes. Not yet run for real: no key in this session.
- The `/demo` spend read `usage.cost`; the agent loop stores `cost_usd`.
  Fixed after reading stream A's scenario runner.
- Touched `starter/package.json` (outside my folders) for two script lines:
  `sim:seed-routine`, and `lib/sim/*.test.ts` added to `npm test`.

## 2026-10-24 ~14:30 UTC · Claude Code (stream C) · simulated driver (video only)

Asked: the simulated driver, built last and for the video only (4.5).

Got: `lib/sim/sim-driver.ts` with personas for scenarios A, B and C. It runs
on the sim tick, answers only an agent message to its driver that asks
something (a question mark, "please send/tell/connect", or a photo request),
waits until the agent's run has finished and a few seconds have passed, and
replies through the real channel routes: the drawn dashboard picture for A's
photo request, and for B it plugs the dongle in (stored P0217 arrives) before
saying so. Scenario F has no persona: nobody answers. `/demo` has the toggle,
labelled video only. Checked in the running app by inserting agent questions
(stub mode never asks any): A answered the safety and location question and
sent the photo, B reconnected the car, and after a "human" message for Leo
the simulated driver stayed silent.

Checked / changed / rejected:
- Off by default, whatever `.env` says. In the live demo a teammate plays the
  driver, and a forgotten "on" would answer over them. `SIM_DRIVER_ENABLED=false`
  removes the toggle altogether.
- A person typing in `/driver` takes over that driver for the rest of the take.
  Rejected guessing "human or not" from message text: the driver app says so
  explicitly.
- Loop guards: only questions get answers, at most 8 replies per order, one
  reply in flight per driver, and never while the agent's run is still going.
- Read the `claude-api` skill before the model call: Haiku 5.5 runs adaptive
  thinking by default and its effort defaults to `medium`, so the call omits
  `thinking`, sets effort `low` explicitly, sends no `temperature`, and treats
  a `refusal` as "use the script". It reuses stream A's OpenRouter client.
- The persona speaks only from a short fact sheet that shares its place names
  with the simulator (the stop label, the reconnect place), so the driver
  never names a different service area than the GPS shows. The model path is
  not yet run: no key in this session; the scripted path covers the same facts.

## 2026-10-24 ~12:00 UTC · Claude Code (stream A agent) · agent core + channel routes

Asked: build the agent (loop, tools, gates) toward M1; mid-way, pull the
updated plan (OpenRouter, channel contract 4.2c, decision options 4.2b,
triggers) and follow it.

Got: `lib/agent/` (OpenRouter client, context loader, tools, approval gate,
prompts, loop, triggers) and the routes other streams build against:
`/api/channels/{driver,site}/messages` (SSE), `/api/channels/photos`,
driver and site feeds, `/api/cases` (list, detail, decide, outcome,
instruct), `/api/agent/{ask,telemetry,runs}`. Without a key every route
works in stub mode: a fixed reply, and the case goes to a person.

Checked / changed / rejected:
- Read the `claude-api` skill and the bundled Next 16 route docs first.
  The skill's defaults (server-side refusal `fallbacks`, beta client,
  `eager_input_streaming`) were dropped: OpenRouter does not support the
  beta parameters, and eager streaming would turn off the schema check that
  `strict: true` gives us. Refusals hand the case to a person instead.
- Rules live in code, not just the prompt: per-audience tool allowlists,
  order scoping for drivers and sites, `ask_site` refused for a site the
  customer owns, customer drafts forced to ASK_FIRST whatever the autonomy
  table says, and `executeProposal` refuses anything not approved.
- "Never tell the driver to keep driving" is checked on every message to a
  driver, including the streamed reply: the stream is released one sentence
  at a time and stops before a sentence that clears driving ("you can
  continue"), while negations and conditions ("not safe to drive", "until an
  operator confirms you can drive") pass.
- A reply to a site the customer owns is never streamed: it becomes a
  CONTACT_SITE_AS_CUSTOMER draft (plan: "replies count too").
- Driver and site turns stay fast and cannot propose; they call `hand_over`,
  and a separate deeper "prepare a decision" turn builds the card. This keeps
  voice replies quick and puts the careful work where the decision is made.
- Each turn starts fresh from a stable cached system prompt (principles +
  whole rulebook) plus case notes, and is append-only within the turn, so
  thinking blocks are never edited or replayed across turns.
- Deviation: photos are stored in Postgres (a `photo` event) instead of the
  S3 object store, which needs Docker; this machine has none.
- Telemetry stub reply first said "Thanks, we have your message" to a driver
  who had not written; replaced with a fixed safety-first line.
- Not yet run against the model: `OPENROUTER_API_KEY` is not visible in this
  session.

## 2026-10-24 ~12:05 UTC · Claude Code (stream A agent) · M1 acceptance tests

Asked: prove in code that customer contact cannot happen without approval
(M1), and get scenario A ready to run end to end.

Got: `npm test` with 30 tests. `gate.test.ts` covers the approval rules against
the real database, no model needed. `loop.test.ts` covers the loop wiring,
using a scripted stand-in for the model. `npm run agent:scenario-a` runs
scenario A with the real model, a rule-based driver and the operator's "I'll
handle it", and saves every run plus a readable `timeline.md` under `traces/`.
The dashboard photo in the fixture is drawn with code, not photographed.

Checked / changed / rejected:
- The customer rule is tested the hard way. AUTO is written straight into the
  autonomy table, past `setAutonomy`'s own check, and the proposal still waits.
  Neither the agent nor an operator can execute it while it is pending. After
  approval it runs once, attributed to the operator, and a second click gets
  409 and changes nothing.
- The loop tests failed on the first run. It was not the code: open cases left
  over from my manual stub-mode calls were being reused, which is correct
  behaviour. I moved the loop tests to a quiet order (CD-420366) that no demo
  scenario uses, and clear it first, rather than wiping the whole table under
  teammates.
- Did not mock the model inside the real loop. The test hook only swaps the
  client, so the prompts, gates and delivery code that run are the real ones.
- Still open: a real-model run and its trace. `OPENROUTER_API_KEY` is not
  visible to this session.

## 2026-10-24 ~12:10 UTC · Claude Code (stream B, cloud instance 2) · telemetry strip, photos, three-stream run

Asked: finish the case page from PLAN 4.7 (telemetry strip, photos) and check
it against the other streams' real output instead of B's own fixtures.

Got: a strip on vehicle cases (check-engine light, codes named from
`knowledge/dtc.json` with severity, key OBD values, phone position, each with
age and "simulated"), photo thumbnails in the timeline, and phone-width fixes.

Checked / changed / rejected:
- Photos are stored as base64 on the event (up to 5 MB). Rejected putting them
  in the order JSON that polls every 2.5 s; they are served from a small route
  under `app/orders/` instead.
- The test dashboard image for B's fixture was drawn as SVG and rendered, not
  a real photo (rule 6). It stays in the scratchpad; stream C owns the demo one.
- Merged A (30 gate and loop tests pass) and C (simulator) into B's branch and
  ran C's `warning-light-584` scenario through A's telemetry trigger: the case
  opened, the strip showed the limping car live, and the map drew 23 cars on
  C's routes. Without a model key the agent hands over to a person, and the
  page offers "Tell the agent" open by default in that state.
- Screenshots at 390 px caught the map shrinking to a strip under the legend
  and code chips wrapping mid-word; both fixed.

## 2026-10-24 ~12:10 UTC · Claude Code (stream A agent) · plan re-check, out-of-date cards

Asked: pull, re-read PLAN.md 4.2–4.2c and 6, push the contract and channel
stubs first, then continue toward M1 (telemetry trigger, 4.2b decisions).

Got: main had nothing newer than the plan already merged. Checked the plan
line by line against what is built: contract and stub routes were already
pushed and both other streams had merged them and built against them (B's case
panel calls the routes; C's simulator posts to `/api/agent/telemetry`).
Neither touched stream A's folders. Built the one missing 4.2b item: "Facts
changed since this was drafted". `GET /api/cases/{id}` lists out-of-date cards,
and `POST …/proposals/{id}/refresh` sets one aside and has the agent draft a
fresh one.

Checked / changed / rejected:
- Only outside facts count as "changed" (driver, site, customer, car, phone).
  The agent's own notes and operators' actions do not, or every card would be
  stale the moment the agent logs anything. A test covers both sides.
- Refresh is refused (409) when nothing new came in, so it cannot be used to
  silently discard a card.
- Still blocked: the real-model M1 trace. `OPENROUTER_API_KEY` is not visible
  in this session.

## 2026-10-24 ~12:12 UTC · Claude Code (stream B, cloud instance 2) · out-of-date cards

Asked (by stream A's message, within PLAN 4.2b): show "Facts changed since
this was drafted" on a waiting card and offer a refresh.

Got: a banner on the card naming what came in and when ("a message from the
driver at 09:01"), with "Ask the agent to redraft" posting to A's refresh
route; a set-aside card then reads "set it aside because facts changed".

Checked / changed / rejected:
- The order view already holds the case's events, so the check runs there
  with the same rule as A's `proposalsWithChangedFacts` (only the driver,
  site, customer or car count as news) instead of a second query per poll.
- The first browser test showed no banner. Cause: each test script starts its
  own simulated clock at 09:00, so the "newer" message was stamped earlier
  than the card. The app runs one clock per server, so the test now sets the
  message time explicitly.
- Noted for later: PLAN 4.6 now asks B for a call transcript block on the case
  page once voice's `cr_calls` tables exist.

## 2026-10-24 ~12:25 UTC · Claude Code (stream B, cloud instance 2) · one queue, outdated and unknown cards

Asked: rebuild "Needs you" as one queue for every order that needs a person
(PLAN 4.7, revised): three sections, "From the records" rows, and waiting
rows with who we wait on and the next check; plus the new card states in 4.2b.

Got: one row per order. *Needs your decision* holds the agent's cards,
escalations, overdue follow-ups, unknown outcomes and records rows with an
urgent reason. Then *Agent working* and *Waiting* (who, next check, sorted by
soonest check), with a passed check moving the row up as Overdue. Handled
cases and a quiet-order count close the page. On the case page, an
`OUTDATED` card shows what it relied on (expected → actual) and that nothing
ran; an `UNKNOWN_OUTCOME` card shows that nothing is retried until someone
checks.

Checked / changed / rejected:
- Counted first: 43 orders carry starter attention items (9 danger, 10 warn,
  1 accent, 22 neutral, 2 only waiting). Listing all 43 at full height buried
  the two agent cards, so neutral-only records rows are folded under the
  decision section ("22 more from the records with routine open items").
  They are still one click away and still searchable. This is a judgement
  call, raised with the team.
- First screenshot: records rows were about 170 px tall with red detail text.
  Now one neutral detail line plus one "Also:" line, about 140 px.
- Waiting rows said who we wait on twice (side label and wait line); kept the
  wait line only.
- The new statuses (`OUTDATED`, `UNKNOWN_OUTCOME`), the tick route and the
  "what changed" field are not in stream A's contract yet. Built against them
  as plain strings, tested by setting statuses directly in the local
  database, and sent A the exact shapes B reads.
- A hydration error during review turned out to be the dev server serving
  stale modules (third time this session). Restarting fixed it; the code
  was fine.
- Smoke (100 orders agree), build and A's 31 tests pass.

## 2026-10-24 ~12:45 UTC · Claude Code (stream A agent) · contract v2: follow-ups, effects, drivability

Asked: pull and re-read PLAN.md rules 2 and 8 and sections 4.1, 4.2, 4.2b and 7,
then adjust everything already built: case follow-up fields, proposal
revisions, assumptions and execution keys, `cr_effects` with
`lib/cr/effective.ts`, context per audience, the drivability screen,
template-only safety instructions, follow-up and watchdog triggers with
`POST /api/cases/tick`, and the M1 tests.

Got: all of it, in `lib/cr/` and `lib/agent/`. `npm test` runs 42 tests, all
passing, with no model needed. Typecheck, smoke and build pass.
- Every open case now says what happens next, who or what it waits on, and
  when we look again. `POST /api/cases/tick` sends one reminder to a silent
  driver (5 sim minutes when urgent, 30 otherwise), then escalates with what is
  known, what is missing and one next action. A watchdog catches a run that
  hangs or errors and turns it into a "the agent couldn't finish" card.
- Cards carry a revision, the assumptions they rely on, and an execution key.
  The assumptions are checked again just before anything runs. If one changed,
  the card is marked OUTDATED and the agent redrafts it. Two approvals of the
  same card execute once. A booking with no answer from the provider becomes
  UNKNOWN_OUTCOME, and an operator has to confirm it before anything else
  happens.
- Results go into `cr_effects` with who authorised them and on what basis.
  `effectiveOrder()` reads them. Approving a new delivery date only records
  "proposed to the customer". The promise changes only when the customer's
  agreement is logged (`POST /api/cases/{id}/customer-answer`).
- Each audience gets its own context. A site gets nothing about the customer
  or prices, and a driver gets no prices. A customer's own site is treated as
  the customer. Rule 8: a driver can only write about an assignment that is
  ASSIGNED or IN_PROGRESS.
- Every message to a driver is screened. Patterns check it first, sentence by
  sentence while it streams. Haiku then catches the indirect phrasings. If
  Haiku is unavailable, a message that mentions driving is held. A held
  message is never sent; it becomes a CLEAR_TO_CONTINUE card. The driver gets
  a fixed "please stay where you are" line instead.

Checked / changed / rejected:
- Safety instructions are fixed templates. The server fills in only the
  driver's first name; the model never writes free text into them. This is
  stricter than the plan's slots, because a slot is still a place where the
  model can write "it's fine to drive".
- Added a `waiting_for` column (driver, site, customer, operator, agent,
  provider, dispatch) next to the free-text `waiting_on`. The tick needs to
  know whom to chase, and parsing that out of prose would break.
- Approving a phone-call card now means "I'll handle it". The case waits for
  the operator to log what happened. The agent does not pretend it called
  anyone.
- Refresh now marks the old card OUTDATED instead of rejecting it, so the
  history shows why it was replaced.
- Renamed for the plan's words (B and C told): `nextStep` → `nextAction`,
  `sourceRefs` → `linkedRecords`, `execution` → `executionResult`. Existing
  databases need `npm run cr:reset-schema && npm run db:push`, because
  drizzle-kit's rename prompts would otherwise hang.
- Tests found two bugs in my own first draft. The "no prices" check flagged
  "Europe/Helsinki". The double-approval race test assumed the first click
  always wins; now either click may win, as long as exactly one executes.

## 2026-10-24 ~12:50 UTC · Claude Code (stream B, cloud instance 2) · adopt contract v2

Asked: merge stream A's contract v2 (renamed columns, new card states,
customer answers, effective promise, tick) and keep the control room working.

Got: B reads `nextAction`, `linkedRecords` and `executionResult`; out-of-date
cards list what changed from A's assumption checks; a redraft says which
version it replaces; unknown outcomes are reconciled with "It exists / It
does not exist" plus a one-line note; phone-call cards approve as "I'll make
the call"; "couldn't finish" cards are a plain choice; clearing a driver to
drive on needs a second, explicit confirmation; and the case page shows the
delivery promise from `effectiveOrder()` with changes proposed to the
customer and "Customer agreed / declined" buttons. The record's promise tile
and headline follow the effective promise, so the original never reads as
current once the customer agreed to a change.

Checked / changed / rejected:
- The first typecheck after the merge passed, which was wrong. It turned out
  the incremental cache (`tsconfig.tsbuildinfo`) hid 12 real errors from
  the renames. B now typechecks with `--incremental false` after merges.
- Merging PROCESS.md naively duplicated four of stream A's entries, because
  A had corrected their times. Compared with A's branch and kept the
  corrected headings only.
- Clicked every new action against A's real routes in a browser: reconcile
  (card ends FAILED, shown as "checked with the other side: it did not
  happen"), customer agreed (promise, tile and headline move), retry on a
  "couldn't finish" card (the agent, offline here, stops again and the
  watchdog raises a new card, which is correct), and drive-on clearance.
- Review fixes from screenshots: "If you approve / reject" lines removed from
  pure choice cards; the "Tell the agent" box no longer opens beside an
  unknown-outcome notice; waiting text no longer repeats on rows that wait
  for you.
- Smoke (100 orders agree), build and A's 42 tests pass.

## 2026-10-24 ~13:00 UTC · Claude Code (stream A agent) · M1 with the real model

Asked: finish M1. That means a real-model run of scenario A saved in `traces/`.

Got: `traces/scenario-a-2026-10-24T12-58-13/` (Sonnet 5.5, 4 runs, $0.19).
The car reports a misfire and the agent sends two safety templates to the
driver first. The driver says they are safe and asks "can I drive on 15 km?";
the agent says no. It then hands over, and a separate turn builds one card,
"Ask Kavellora how they want the Bentley recovered". The card has sourced
facts, the unknowns, options and an email draft. The operator picks "I'll
handle it" and logs the dealer's answer. The agent tells the driver, puts the
case into a wait on the roadside help, and sets the next check at 12:27 CEST.
`timeline.md` is the readable version; the JSON files hold every model call.

Checked / changed / rejected. The first two real runs failed in ways the
scripted tests could not show:
- The model mixed its own parameter tags into the nested `handover` object,
  so the tool input was not valid JSON (`"handover": <parameter
  name="what_happened">`). This happened 3 times out of 3. OpenRouter does not
  seem to enforce `strict` tool schemas. Fix: `propose_action` and `escalate`
  no longer take object-valued parameters; the handover fields, the draft and
  the date window are top-level. A broken tool call is now made once more,
  with a short note, instead of failing the whole turn.
- Text the model wrote before a tool call ("the car shows speed 0, so I'll
  add the engine-off instruction") reached the driver. Fix: each model call's
  text is held until the call ends. Only text from the call that ends the turn
  is the reply.
- The drivability classifier held a message that said "please don't drive
  on". On its own, Haiku allows that text 12 times out of 12. The gate had
  been checking every growing prefix, sentence by sentence (7+ calls), so one
  stray BLOCK was likely. Fix: one check per reply, plus examples in the
  classifier prompt. A held reply is now replaced entirely by the fixed line,
  never cut off halfway.
- "I'll handle it" marked the card OUTDATED. Its assumption was "no new
  driver message after 09:02". The agent only sees minute-precision times,
  and the message it had read came at 09:02:07. Fix: the cut-off moves up to
  the latest message that was in front of the agent when its turn started.
- The agent set a check for 12:15 UTC when it meant 12:15 CEST. Fix: the
  case notes give "now" in the pickup and delivery zones too, and `wait_for`
  answers with the check time in UTC and local time. The next run set it
  correctly.
- OpenRouter's cost arrives only in the stream's final `message_delta`, and
  the SDK drops it. The first run reported $0.001 for four Sonnet calls. Now
  it is read from the stream.
- Mock bug: the tow search gave negative distances (a signed bit shift) and
  described results as "near Düsseldorf, 102 km away". Fixed. Between the
  dataset's cities, results are now placed around the reported position.
- 45 tests, typecheck, smoke and build pass. Not done yet: the voice
  triggers (`call_urgent`, `call_ended`), which wait for the voice stream.

## 2026-10-24 ~13:00 UTC · Claude Code (stream B, cloud instance 2) · the real agent's card in the UI

Asked: nothing new from the user; checked B against stream A's first
real-model trace (scenario A, `traces/scenario-a-…`), since until now every
card B had rendered came from B's own fixtures.

Got: the real `propose_action` input from the trace, loaded into the local
database through A's own `proposalFrom` mapping, rendered on the case page.
The card holds up: 7 sourced facts, 4 unknowns, 3 options, an email draft and
"Nothing reaches the customer until a person says yes".

Checked / changed / rejected:
- The real agent writes the time into source labels ("OBD dongle, 2026-10-21
  09:01 UTC"), so chips showed the time twice. Chips now skip their own time
  when the label already has one.
- The real draft is a 20-line email, which pushed the decision buttons about
  2,000 px down the card. Long drafts are now folded to a few lines with
  "Show the whole message". Rejected moving the buttons above the facts:
  operators should read what the agent found before they approve.
- The model key added to the environment is not visible to this session
  (environment variables reach new sessions only); network access to
  OpenRouter works, so a new session can run the agent live.

## 2026-10-24 ~15:00 UTC · Claude Code (stream C) · contract v2, first real-model run

Asked (by stream A's session, checked against their branch): merge contract
v2 (renamed case columns, `cr_effects`, `advanceSimClock`,
`POST /api/cases/tick`, feed kind `call`).

Got: merged, ran `cr:reset-schema` and `db:push`. The clock jump now uses
`advanceSimClock` and reports what the case timers did ("1 followed up, 0
handed to a person"); the keep-routine reset also clears `cr_effects`; the
driver app shows a `call` feed item as an incoming call with an Answer button
once the voice screen exists; the site chat says "Operations will reply here"
when nothing streams back. `npm test` 50 pass, smoke and build pass.

Checked / changed / rejected:
- After a container restart the session had `OPENROUTER_API_KEY`, so
  scenario F ran against Sonnet 5.5 for the first time (under $0.001):
  P0217 at 09:06:30, the agent told William to stop, one reminder after the
  reply deadline, then escalation. **Found for stream A:** the escalation
  turn failed with a JSON parse error in a tool input ("Expected ',' or '}'
  ... position 241"); the watchdog then moved the case to *Needs your
  decision* with "The agent couldn't finish" instead of the planned
  "Call William" card. The failure path held; the planned card did not
  appear. Not fixed here: it is in `lib/agent/`.

## 2026-10-24 ~15:15 UTC · Claude Code (stream C) · first real runs: vision check, routine seed

Asked: with the model key now available, run the two checks that were
waiting for one.

Got:
- `npx tsx lib/sim/check-photo.ts`: Claude read the drawn dashboard as
  "check-engine light, 'Engine malfunction / Reduced power / Stop safely',
  0 km/h". All three checks pass, so 4.5's "readable by Claude's vision" is
  now tested, not just eyeballed.
- `npm run sim:seed-routine` on Sonnet 5.5 ($0.002): **1 of 4** routine
  questions closed by the agent alone. Trace:
  `starter/traces/routine-2026-10-24T12-51-34/timeline.md`.

Checked / changed / rejected:
- The three failures are not the questions: the agent's answers were right
  ("open until 18:00", "use the marked vehicle entrance"), but stream A's
  drive-on screen blocked them and sent the driver "An operator has to
  confirm before you drive on. Please stay where you are for now", plus a
  "Clear the driver to drive on?" card. Those drivers have nothing wrong
  with their cars. Cause: `screenDriverMessage` (`lib/agent/drivability.ts`)
  runs on every driver message, and its classifier blocks anything that
  "implies ... continue the journey", which every routine direction does.
  **For stream A:** screen only when the case has a fault, stop or safety
  instruction (or give the classifier that context). As it stands this
  breaks scenario C (protected core) and tells healthy drivers to stop.
- Did not loosen the seed questions to dodge the screen; the questions are
  the right test. Did not touch `lib/agent/`.

## 2026-10-24 13:40 UTC · RoopeS + Codex · integration of the functional core

Asked: merge the completed agent, control-room, simulator/driver and voice
branches into main, identify shortcomings, and delegate fixes; ask before major
changes.

Got: integrated all four streams on `integration/functional-core`, preserving
their shared configuration and process history. Three agents repaired the voice
handover, control-room read layer and driver/simulator boundaries. A later
review exercised booking concurrency, uncertain outcomes and reset races.

Checked / changed / rejected:
- Voice originally posted to a missing analyst endpoint, and the driver app
  probed a nonexistent call page. Added the canonical-call bridge, real call
  surface, operator transcript/audio and turn-level sources. Saved urgency and
  final transcription before announcing handovers; serialised operator changes
  against the analyst. Kept voice independent from the chat transport.
- Found that an unrelated urgent record could disappear behind a waiting agent
  case. Unified attention and effective promise/ETA/booking reads across the
  queue, order, board, map, driver card and voice interviewer.
- Requested and received explicit permission for the substantial booking
  contract change. Exact recorded quote, schedule, cost and replaced reservation
  now survive review and execution. Unconfirmed requests preserve the old
  booking. Added order-wide reconciliation checks and booking locks, including
  simultaneous approvals from different cases.
- Preserved at-most-once execution on partial failures: no automatic provider
  retry, explicit uncertain outcome or failure, and a human next step. Kept
  customer contact and customer agreement separate from operator approval.
- Reset now refuses active calls, in-flight work and deferred tasks before
  clearing data. Evidence attachment rejects missing or cross-order/cross-case
  sources atomically. The local demo remains one server process; this is not a
  distributed-job design.
- Tested on a separate `controlroom_integration` database. Applied only additive
  schema changes to the existing local app database; did not reseed its snapshot
  or delete its voice history.
- Ran two real Sonnet warning-light traces (eight agent runs, $0.4278 recorded).
  The first trace cited GPS for a driver claim and overclaimed a missed ferry.
  Tightened evidence instructions; the next run cited the driver's own message
  and explicitly kept the ferry outcome uncertain and the 26 Oct promise
  unchanged. Also replaced the standalone harness's unrelated telemetry fixture
  with the actual simulator fault plan. Both traces are retained as process
  evidence rather than editing an earlier model answer.
- Reviewed the integrated queue and driver page in Chrome. Exercised call
  start/text-turn/hang-up APIs without a microphone; wrong-driver access was
  rejected and the ended call linked to its case. Microphone capture, live
  speech recognition and hosted audio still need a person to rehearse.
- Read the unresolved routine-seed note instead of assuming passed branch tests
  proved scenario C. Assigned a context-aware drivability fix and real-model
  recheck; completion evidence is recorded below after final verification.

## 2026-10-24 ~13:40 UTC · Claude Code (stream B, cloud instance 2) · testing B against the real agent

Asked: continue stream B and test the implementation. A model key reached this
session for the first time, so every earlier check of B (its own fixtures,
scripted tests, "hands to a person" stub mode) could finally be replaced by
the real thing.

Got: merged stream C's branch (scenarios B–F, driver app, site chat) into B's,
set up Postgres and the app, and ran all five scenarios through the browser
with the real agent: queue, case page, every decision button, the Ask box, map
and agent page, in light and dark mode and at 390 px. Typecheck, 65 tests
(11 new in B's folders, 1 new gate test), production build and smoke pass.
Eight problems found, all fixed and shown in the browser:

- **The control room showed a frozen world.** The simulator moves only when
  something calls `/api/sim/tick`; only the driver app and /demo did. With just
  the control room open, one card said "car stopped, engine off" next to
  "Speed 111 km/h", and scenario F's overheating code (written by the sync)
  never opened a case while the operator sat on the queue. Operator pages now
  tick the simulator before the case timers, and the order and map loaders sync
  before reading telemetry. Verified: with only the queue open, F's card
  appeared after 96 s (the simulated 90 s plus polling).
- **"I'll handle it" recorded a choice nobody made.** The card pre-selects the
  recommended option and sent it with every button, and the gate fell back to
  the recommendation. A phone call to the owner was written down as "Chosen:
  We book tow to Birkenhain", against the rule that approval to ask is not
  approval to book. B now sends an option with "I'll handle it" only if the
  operator picked one, and the gate records none by default (two lines in A's
  `gate.ts`, flagged in the commit). The new gate test fails on the old gate.
- **Code names reached operators** ("STOP_NOW", "a CONTACT_CUSTOMER
  proposal"). `plainText` now rewrites them and runs over every agent-written
  card field and the activity log.
- **Scenario F had no way through.** Choice-only "Your call" cards hid "I'll
  handle it", so "Call the driver now" was approved as if the system had made
  the call, the case read "Agent working, waiting on the agent", and nobody was
  asked to log the call. The plan's F script is "I'll handle it, then log the
  outcome"; the button is back and the whole chain works (the next card cites
  "Shift lead, internal" as the source of the outcome).
- **A stale summary contradicted the card.** After the operator logged that the
  driver was stopped, the page still said "moving on the motorway, waiting for
  his reply". A waiting card now speaks for the case; the summary shows only
  when there is no card.
- **An edit was invisible after approval.** The sent message used the
  operator's edit (checked in the database), but the card only said "approved
  it". It now says "approved it with changes" and keeps the sent text in a fold.
- **The Ask box and agent notes showed raw markup** (`**bold**`, `- `) and a
  raw `CHANGE_PROMISE`; the activity log was a 1,000-character wall. They are
  rendered as formatted text (React elements, never injected HTML), and the log
  keeps one skimmable line per step.
- Not a bug, checked: the Ask box refused "book the ferry and message the
  customer", explained why, and created no proposal, effect or customer message.

Checked / changed / rejected:
- Every claim above was reproduced first and verified after in the browser;
  the two logic fixes have tests that fail on the old behaviour (including a
  test that caught an offset bug in my own first version of `plainText`).
- The typecheck cache hid nothing this time, but `--incremental false` still
  found three entry builders my new field had missed.
- My own mistake: `pkill -f "next dev"` matched the shell running it and
  killed the dev server and the command. Stopped by listing processes instead.
- Rejected editing A's agent prompt to fix the F dead-end at its root (see
  below): it is A's, and B's button closes the demo path.
- Cost: the real agent runs behind this testing cost well under $2 on Sonnet 5.5.

Found, not B's, for stream A (all reproduced with the real model):
- **Scenario C (protected core) still fails.** The drivability screen holds the
  agent's routine key answer and turns it into a "Clear the driver to drive
  on?" card, so the case goes to a person instead of closing. Stream C
  reported this at ~15:15; it is still open on this branch. The agent itself
  calls the held card "a screening artefact" in the second card. "Handled by
  the agent" is empty in the live queue because of it.
- Approving an `OPERATOR_DECISION` option is treated as "carried out
  (simulated)". For options a person must do (phone the driver) the agent then
  waits on itself. Suggest: say that the option is the operator's to do, and
  wait on the operator for the outcome.
- Case titles go stale: F stays "Bentley moving on motorway" after the logged
  call says it stopped near Bremen. The agent needs a way to retitle.
- F's second follow-up chose to wait another 5 minutes instead of escalating
  (the first run escalated at once). The plan says one reminder, then escalate.
- F's card says "Delivery on 22 Oct is at risk" before any recovery estimate;
  PLAN 3 asks for wording only as far as the evidence goes.

Still open in B: the call-transcript block (PLAN 4.6) waits for voice's
`cr_calls` tables, which have not landed.

# How we worked with AI

A running log of how team Random used coding agents (Claude Code and others)
to build this. Newest entries at the bottom. Format:

```

## 2026-10-24 13:51 UTC · RoopeS + Codex · final combined verification

Included the updated Stream B at `7bb0b4c` (with C and its operator fixes),
and the agent branch's voice/main synchronization at `8a58a65`, while keeping
all integration safeguards. The synchronization merge changed process history
only; the verified application code stayed the same.

- Full combined suite: **110 tests passed**, 17 suites, no failures or skips.
  Production build and typecheck passed. The build retains the starter's
  filesystem-tracing warnings; no build errors.
- API smoke: all **100 orders** agree between board and record on attention;
  both synthetic attachment formats download through the local object store.
- Real Sonnet routine seed: **4 of 4 handled by the agent**, compared with the
  earlier 1 of 4. Trace: `starter/traces/routine-2026-10-24T13-45-27/`.
  Kept explicit permission-to-drive blocking; the classifier now receives
  trusted fault/stop context so ordinary access instructions remain routine.
- End-to-end runtime check on the production server and isolated DB:
  wrong driver rejected; an active call blocks reset with 409 and no deletion;
  text turn and hang-up produce a delivered call trigger, linked case and
  visible transcript; a selected replacement ferry executes once, with the
  exact quote and cutoff shown in the driver view. A subsequent clean reset
  removes calls, cases and proposals and leaves all 100 source orders.
- Existing app on localhost:3000 and isolated production app on :3100 both
  return 200 for the queue, driver-call surface and order API. The :3100 app
  uses no model key for deterministic API verification; :3000 retains the
  user's original configuration.
- Microphone capture, live browser speech recognition and hosted speech still
  require a person to rehearse; API/text transcript plumbing is verified.

## 2026-10-24 ~20:40–23:30 UTC · RoopeS + Claude Code (cloud) · night run: every role, pickup to handover

Asked: pull main into `roope`, run the scenarios and use cases end to end as operator, driver, pickup desk and
customer, compare against the brief and the plan (above all the driver's and the customer's experience), fix what
breaks, make the workflows show up on the platform, add data if needed. Customer as mock messages, no new screen;
lifecycle actions if not too big. Budget under $10, DeepSeek models through OpenRouter preferred.

How: a fresh container (Docker Hub rate-limited, so local Postgres 16 and an S3 mock instead of compose), the app
on the DeepSeek v4 models (`AGENT_MODEL=deepseek/deepseek-v4-pro`, flash for the safety screen and the simulated
driver), and a small harness that plays every role through the real routes: driver chat and photos, the site
chat, operator decisions and logged outcomes, clock jumps. Every turn was read back from the case timeline and
the agent runs, and the operator, driver and map screens were checked in headless Chromium. Each finding was
reproduced first, fixed, then rerun with the real model; the logic fixes have tests (116 now, all passing).

Got, by role (each line a defect seen in a run, then fixed):
- Tests: the suite stopped at the first agent test (a `data:` URL the CommonJS loader read as a path) and hung on
  an open pool; three tests asserted behaviour main had changed on purpose. The gate now checks an unknown booking
  outcome before it reuses a repeated card.
- Driver (A): DeepSeek spent the safety classifier's 400 tokens thinking and returned nothing, so a harmless
  "the car cannot be driven further" became a "Clear the driver to drive on?" card and the driver read "An operator
  has to confirm before you drive on". A reply split around a tool call reached the driver as "the car.". An
  operator summary with prices and bold text reached the driver. Haiku 5.5 spent the photo's budget thinking, so
  every photo was "could not be read". All fixed (thinking off for one-word and description calls; the gate joins
  a continued sentence; hand_over tells the model to write the driver two plain sentences).
- Driver (A, after the repair): one rejected bogus clearance blocked every later clearance, so the driver never
  heard about his new ferry and nobody could clear the repaired car. A rejection now holds only until something new
  happens on the case.
- Driver (B): the driver-facing context had none of his open incident, so the agent asked a driver stopped for an
  hour "what happened?". It now carries his open issues and earlier messages, with sources.
- Driver (G): a held answer left the driver on the motorway with "Please stay where you are" and no answer to his
  question; the held reply is now written again once without the clearance. "The car can keep going" slipped past
  the patterns; car-as-subject phrasings are caught. The classifier was checked on 15 paraphrases (DeepSeek flash,
  pro and Haiku all 15/15) before keeping the cheapest.
- Pickup desk (D): "I'll let you know if that changes" (monitoring nobody does), and an answered question parked as
  "waiting on the site's reply" that would have reached an operator empty. Site turns can close an answered case.
- Customer (F, B): the owner's answer to a recovery email parked the case for two hours and nobody told the driver
  to wait for their tow; customer drafts came with markdown. Fixed; plus a simulated customer email from the Demo
  page on any order, which the agent answers only as a card for a person.
- Operator: invented citations ("msg-latest") are refused at propose_action; card titles have a length limit; the
  Needs-you list put a driver waiting for a clearance under two-day-old record items, so the agent's live decisions
  now come first; post-decision turns retitle the case; a rebooked ferry and a repaired car change the simulated
  world (the car resumes, waits for the new sailing); the agent and the driver see Road Desk bookings.
- Lifecycle: nothing could move an order from booked to delivered, so a Demo delivery run left the order reading
  "collects it tomorrow". The driver now reports the steps in the app (at the pickup, collected with keys, checked in
  as a simulated gate scan, at the delivery address, handed over to a named receiver); they are stored as our own
  events and laid over the snapshot for every reader, and a handover brings the customer's delivery confirmation as
  a card. Scenario H walks it.
- The sim clock restarted at SIM_NOW on every restart, behind the stored samples (a GPS fix "in 8 min"); it now
  catches up once to the newest stored sample.

Checked / changed / rejected:
- Kept main's design choices where they were deliberate and adjusted tests instead (a dongle that never reported
  does not outdate a card; a repeated card is reused), but moved the booking-outcome check ahead of the twin reuse,
  because a reused card must not slip past reconciliation.
- Rejected sending booking details as a clearance, and rejected widening the classifier to Haiku: the eval said the
  cheaper model was enough once thinking was off.
- Rejected moving the customer into a screen of their own (the brief's customer is reached only through approved
  messages); their side is a simulated email in Demo and the replies are cards.
- Not fixed: the journey bar's "km to go" uses the simulated route length (sea included) while the header shows the
  order's distance; Demo delivery runs stamp calls ahead of the simulated clock (now labelled so); Node 24's dev
  server reload-looped in this container (Node 22 dev and Node 24 tests were used).
- Spend: about $2 of model calls for all of the above.

## 2026-10-24 ~23:30–24:00 UTC · RoopeS + Claude Code (cloud) · night run, second half

Asked: keep iterating on your own within the budget: the lifecycle, the customer's side, whatever the runs show.

Got:
- The dossier service now hears the driver's steps (its live feed had dropped the new event kind): a collected car
  moves its phase to MOVING, a reported check-in stands in for the gate scan, so it stops asking for
  pickup-readiness calls on a car already on the road.
- `npm run e2e:roles`: a role-playing harness against a running app with the real model (A, C, D, F, G, H and a
  customer email; checks records, not wording). Its first run found two more defects: after close_case the desk
  received "The case has been closed" instead of the answer, and DeepSeek's notes before a "---" line reached the
  driver. Both fixed; the last full run passed 20/20.
- The inbox's suggested reply quoted the promise as "08:00–14:00 EET" (UTC times with a local zone pasted on); the
  suggestion now gets the key windows already in local time.
- Ask the agent: 58 s at the deep effort, 9 s at the fast effort, same sources; read-only questions run fast now.
- A wait the agent set "check at 11:15 UTC" with 12 minutes would have fired two hours early; the named time wins.
- Small ones: the journey bar's km now match the route card; a customer question was re-kinded as a handover by the
  agent (refused now); "simulated GPS" stayed out of customer drafts; markdown stays out of the driver's phone.

Checked / changed / rejected:
- The dev server reloaded pages in a loop in this container (no file changed on disk); screens were checked against
  a production build instead, which is also what the live box serves.
- Scenario C's agent sometimes asks operations to confirm the site's handover instruction instead of closing the
  case (the record marks it unconfirmed). Kept: it is a defensible reading of the evidence, and the harness accepts
  either a closed case or exactly one card.
- Spend for the whole night so far: about $3.20 of model calls (DeepSeek v4 for the agent).

## 2026-10-25 ~00:00–01:30 UTC · RoopeS + Claude Code (cloud) · night run, third part

Asked: keep iterating on your own within the budget; walk the paths the first runs did not reach.

Got:
- Scenario B through a new date, as four roles: the operator instructs a new window, approves the proposal (the
  customer's message goes out, the promise does not move), the customer agrees by email from `/demo`, the agent
  drafts the acknowledgement as a card, the operator records the agreement, and only then does the promise read
  Fri 23 Oct on the order, the header and the story. Harness story B checks each of those (6/6).
- Defects that run found, fixed: after a recorded customer answer the agent set a wait with the reply card still
  open, and the case sat in "agent working" (now it stays in Needs you); a reply card listed "Delivery promise:
  agreed" as a change, which approving a message never makes (message cards carry no record changes now); card
  changes carried raw UTC instants in brackets (the words stay human, the instant stays in the value); the agent
  once drafted a separate "record the agreement" card next to the reply (the instructions now keep one card).
- The Delivery promise block quotes the customer's email under the proposal and uses it as the evidence when the
  operator presses Customer agreed or declined.
- The seller's desk (`/dealer`) keeps a car the driver reported collected, marked "Collected 09:50 (driver app,
  simulated)", and no longer offers a readiness call for it: the call service's actions now read the live app
  state, so the same car gets a position check for the driver instead.
- The driver's collection and handover take condition photos (his own or labelled demo pictures). They become
  the dataset's own PICKUP_PHOTOS / DELIVERY_PHOTOS proof (a required one is submitted, else one is added), and
  the dataset's pickup and delivery assignment steps complete with the synthetic event as their evidence.
- `/orders/CD-420322` opens the order by its reference.
- The full harness run caught one more: on the turn after the customer's "we agree" email the agent told
  operations "delivery is now Friday" and set a wait that moved the case out of Needs you, though nobody had
  recorded the answer. Now a wait cannot hide an unrecorded customer answer to a proposed date (the case stays
  with operations, "record the customer's answer"), the tool result says the promise has not changed, and the
  prompt names the email-yes case.
- The Inbox thread says when Road Desk already drafted a reply to that person and links to the card, so the desk
  does not answer twice.
- The agent's order context lists the steps the driver reported (with their event as the source); a pickup or
  delivery desk sees only its own end's steps.

Checked / changed / rejected:
- One "missing card" was the turn still running when I looked (the sim clock had not moved); checked the run
  record before changing anything, and changed nothing for it.
- Scenario A after the logged recovery: the agent tells the driver and waits on the roadside help with the
  ferry cutoff in its note, and drafts no customer delay message. Kept: the promise is 26 Oct with days of slack,
  and the plan says scripts state boundaries, not conclusions.
- Loading states: every page renders in 10–270 ms on the production build and the order page has its own loading
  view; no loading.tsx added.

## 2026-10-25 ~00:40–02:00 UTC · RoopeS + Claude Code (cloud) · night run, bug sweep

Asked: keep improving along the plan, bugs and issues before extensions.

Found and fixed (each from a run or a screenshot, not from reading the code):
- **The simulated clock went backwards after a server restart.** The catch-up to the newest stored event ran only
  inside the telemetry sync, so a decision made right after a restart was stamped minutes before the events it
  answered, and the timeline read out of order. It now runs once at server start (Next's instrumentation hook) and
  retries if the database was not ready.
- **One card made the whole order page fail (500).** The model sent a fact without its sources list; the gate took
  it and the view mapped over nothing. The gate now stores such a fact with no sources, the view tolerates it, and
  the card marks the line "no source given" (where every fact came from is a judging question). The role harness
  now also checks that each story's order page and the queue still render.
- **A second date proposal while the first waited for the customer.** On the customer's emailed yes the agent
  proposed a CHANGE_PROMISE "record the agreement": approving it would have sent a second proposal and left two
  dates pending. The gate refuses a new date card while one waits; the answer is recorded on the case by a person.
- **The driver's phone offered "I'm at the pickup" to a driver who collected the car at 07:00** (the records hold the
  collection; only app reports were counted). Steps now count the record's collection and gate scan, at the
  record's pickup time rather than the assignment start.
- **The order story said "Leo is driving it" next to a stopped car with a flashing engine light.** With an open
  warning or breakdown case and the dongle at 0 km/h it now says he has stopped, and marks the ETA as from before.
- Under a case panel the agent's card was shown three times; the order section no longer repeats it.
- The driver's newest message hid behind the photo request (pinning ran only on new messages); the thread now
  re-pins on any resize while the driver reads the end, and never scrolls the page.
- Site chat had no sidebar or role switch; operator notes showed raw backticks and "---"; the demo panel named
  Claude Haiku for a simulated driver running on DeepSeek.
- Fresh clone: the README never started the call service (port 8799), which the desk, suggested replies and
  delivery runs use; the service never read its own `.env` and pointed at the app on 8797 while the README runs it
  on 3000. All three fixed.

- The traced full run then caught two more. The agent's own note reached Leo: "Now let me contact Leo — he hasn't
  written yet … Leo, the car has reported …"; a reply that opens with a planning note, or speaks of the person in
  the third person before addressing them, is now sent from their name on (an ordinary "Thanks, I'll pass it on."
  stays). And B again: blocked from a second date card, the agent asked operations to "record the customer's
  agreement?" with a decision card of its own; while that answer is unrecorded, such a card is refused before
  validation, and the reply is the one card. Rerun: B 9/9.
- "Need a person" read 44 on All orders, 17 on the map and 20 in Needs you. The board counted any open signal; it
  now uses the map's rule (a decision due now): both read 16. Needs you still lists three urgent alerts among its
  decisions: moving them to the watched group broke a team test ("an unrelated urgent record remains in Needs your
  decision"), which states that choice on purpose, so the queue change was reverted and only the board moved.

Added for the deliverables: `RUN-SHEET.md` (roles, clicks, expected screens, timings and fallbacks for the live
demo), and agent traces for every scenario from the role harness under `starter/traces/e2e-roles-2026-10-25T01-24/`
(52/52 checks; B, C and F from a rerun, see its README).

Checked / rejected:
- Fresh clone of `roope`, following the README without Docker (a local Postgres instead): `npm ci`, typecheck and
  `npm run build` in `starter/`, `npm ci` and typecheck in `dossier/`, the call service started and loaded 100
  orders, `db:push` and `db:seed` into an empty database, and the unit suite against it: 126/126. npm 11 warns that
  esbuild's install script is not approved; `tsx` works without it.
- C and F failed once in the traced run. Their traces showed the agent doing the right thing more slowly than the
  harness waited (a DeepSeek turn took up to two minutes at that hour), so the harness was changed, not the agent.
- Spend: about $6 of the $10 for the whole night by this point (OpenRouter key: $8.94, $2.88 before the night).

## 2026-10-25 ~01:50–02:40 UTC · RoopeS + Claude Code (cloud) · night run, the delivery's own time

Asked: keep going along the plan; the pickup-to-delivery path is the one the night started with.

Got:
- Scenario H told an impossible story: tapping the five steps in a minute put the car in Tampere an hour after the
  pickup in Stockholm, across a ferry, and the confirmation card said so. Running H again after a step now moves
  the clock to that step's time in the records (the slot, an hour before the ferry check-in closes, just before the
  26 Oct delivery window, then inside it); the demo panel's button reads "Next step's time". A jump of days is
  refused while other cases are open, since their timers would fire on the way (checked with a test case row).
- Walking it found three small wording defects: every step carried "(to <receiver>)" when one was sent,
  "Arrived at the delivery address at the delivery address in Tampere", and a handover five minutes before the
  window was called early. Fixed; harness H 8/8.
- The order story said "no position from the driver app in this packet" for a car collected in this app, while the
  simulated phone GPS had it at the ferry terminal; it now shows that position, labelled simulated.
- A review of my own changes narrowed one rule: the "record the customer's answer" refusal matched any decision
  titled "confirm…", so "Confirm the tow booking?" would have been refused while an answer waited. It now needs the
  customer, the date or the agreement in the title.
- The inbox's **Suggested reply** took 2 min 18 s (the app gives it 150 s, so it often failed): the flash model
  reasoned by default over OpenRouter's chat API. Drafting now turns that off: 4 s, drafts of the same shape. The
  team's simulated calls already did the same for spoken turns.
- **Ask the agent** answered correctly in 7 s but cited "travel_reservations res-x6196641f25ccf47f" and wrote
  "BOOKED". Operator text now drops record ids and the table they came from (keeping the label) and reads record
  states as words; the Ask mode is told to name sources by what they are. A scan of three order views found no
  other id in displayed text.
- Regression on the build with all of the above: the full role harness passed 51/52; D's one miss was the harness
  reading the desk's reply five seconds after the case closed, before the reply landed (a rerun showed it). D now
  waits for the reply itself. Spend for the night: about $6.8 of the $10 (OpenRouter key at $9.65, $2.88 before).

## 2026-10-25 morning UTC · RoopeS + Claude Code (cloud) · merging the second night (aloimusa/main)

Asked: compare the friend's night of work (github.com/aloimusa/car-delivery-control-room, 14 commits: a night
harness that plays every party against a sandbox stack, and fixes for the 16 faults it ranked in
`starter/scripts/night/MORNING.md`) with `roope` and merge it; conflicts in function or UI go to Roope.

Got:
- Six files conflicted: `instrumentation.ts`, `lib/sim/sync.ts`, `lib/agent/tools.ts`, `lib/agent/drivability.ts`,
  `dossier/src/reason.ts`, `package.json`. Everything else merged as written.
- Both nights had fixed the simulated clock falling behind its own records after a restart: theirs at server start,
  retrying until the database answers; mine on the first sync. Both now call their one catch-up function, so the
  sync covers a process that skipped the start-up step.
- Both had changed what happens when a driver reply sounds like clearance. Theirs: on a job with no recorded fault or
  restriction the sentence is dropped and the rest is sent. Mine: on a restricted job the reply is held as a card and
  the driver is told an operator has it. These cover different cases, so both are kept.
- Roope decided two: (1) their "one card at a time per case" rule stays, but cards the gate raises itself (a held
  clearance, a held reply) are marked as the gate's and do not block the agent's own card; on screen they still
  read as the Road agent. (2) The wait-near-the-car line is mine: "Please stay in a safe place near the car. An
  operator is working out what happens next, and we will message you soon." Their drive-on fallback wording is kept.
- Their unit tests had not been running: on their branch the runner crashed at start-up (the voice loader's
  `data:` URL), which `roope` had already fixed. With that fix their one-card rule failed nine tests. The gate's
  exemption fixed the held-card cases. Three older tests put two waiting cards on one case; they now put the second
  card on another case of the same order, which still checks the same rule. 127/127.

- The role harness then found a third effect of the one-card rule. In B the customer agreed to the new date by email
  while the agent's card for the driver's train home waited, and the reply to the customer was refused until someone
  decided the train. Roope decided (3): the answer to someone who wrote (a message card to a customer or site
  that wrote on the case and has had nothing back since) neither waits behind another card nor holds one back.
  Outreach nobody asked for still waits its turn. Test added; 128/128.

Checked: typecheck of both packages, production build, smoke (board and record agree for 100 orders), and the role
harness on DeepSeek. The first full run passed 47/51. All four misses were in B: once the agent raised the new
date as the wrong kind of card (it raised the right kind in the next two runs), and once the reply was refused as
described above. After the fix B passed 9/9. Spend so far: about $7.2 of the $10 (OpenRouter key at $10.08, $2.88
before the night).

## 2026-10-25 ~06:40–07:05 UTC · RoopeS + Claude Code (cloud) · overview and refactor

Asked: a two-page `OVERVIEW.md` for a reader who is not a programmer (the parts, the workflows between them, the
safety rules), and while reading, refactor only what is clearly tangled, without changing behaviour or the tests.

Got:
- `OVERVIEW.md`, about 1,100 words with one diagram, checked against the code rather than the docs. Two findings
  went in as written: a live call on the Road Desk line is recorded on the order (claims, review) but does not start
  an agent turn, which the README's "urgent and ended calls feed the road agent" no longer matches; and nothing in
  the app raises an action above "ask first" (only the tests call `setAutonomy`).
- Eight small refactors, one commit each. `toolsFor` built its own copy of who may use which tool; it now reads the
  gate's `TOOL_AUDIENCES` and `READ_TOOLS`, so the offered tools and the allowed ones cannot drift (the offered
  lists compared byte for byte, before and after). In the gate, seven hand-written "back to the agent" case patches
  became `backToAgent()`, the booking test `isBookingAction()`. The gate's own timeline lines (seven copies in three
  files) are written by `gateNote()`. The agent loop's reply gate was set up twice with the same four lines, and the
  site's end chosen four times; the site and customer handlers shared a two-line nest for "which cases wrote to
  them". The call service stored a call three ways and built job ids twice. Deleted: the old Leaflet map screen,
  unused since the chart became home, with its styles, and three helpers nothing called. Two doc comments sat on the
  wrong function.
- Left alone as too risky for a refactor without the role harness: `runTurn` (`loop.ts`, 145 lines, the retry and
  held-reply paths share mutable state), `submitProposal` and `performEffects` (`gate.ts`, the one-card rule and the
  execution core), the `wait_for` time correction (`tools.ts`), and the call service's single request handler, where
  `/context` and `/card` cache briefs slightly differently.

Checked: after every step, both typechecks, `npm test` 128/128 on the test database, and the production build (in
a copy of `starter/`, so the running server's `.next` was not replaced; the same four filesystem warnings). The call
service's GET routes answered the same from the old and the new code (a brief's own timestamp aside). No model was
called.

## 2026-10-25 ~07:00–08:10 UTC · RoopeS + Claude Code (cloud) · a cost slide, a hostile review, and fixing what it found

Asked: three jobs, each for its own agent and in order: a one-slide business case against a Finnish operator at
most 20 €/h (Roope added: include how many car issues an operator gets through); the overview and refactor above;
then a critical review of the whole repo from Bahn's side by a separate model (Fable), and start fixing what it
finds. Later, from another session's completion plan: the counts, the queue wording and the README.

Got:
- **The business case** (`BUSINESS-CASE.md`, one slide). The agent measured AI cost from what OpenRouter billed in
  the traces (mean €0.12 an incident) and turn times, and took 2026 Finnish employer costs from ETK and Statistics
  Finland. Checking its arithmetic held, but three things were changed before the slide: the title's range did not
  match the table (€3–6 vs €2.5–6), "one incident's AI cost equals ~26 s of operator time" used the costliest
  incident beside a mean, and "€14k a month saved" sat next to "a 24/7 seat costs €27k either way". The saving is
  hours of work freed, which becomes money only as staff not added for load, peaks and growth; the slide says so.
- **The review** (`REVIEW-BAHN.md`, 42 findings with file:line evidence). Its top claims were checked in the code
  before acting: the stop instruction on a STOP_NOW code waited for the model (true: in trace A it went out after
  five lookups); the safety lines and the "may drive on" patterns were English only while the agent answers in the
  driver's language (true; the data's drivers live in DE 67, FI 49, FR 41, BE, DK, SE); the agent may call a
  monitor-level fault "usually not critical" (true, the prompt allowed it, and trace G shows "not something that
  should stop you immediately").
- **Fixed (`02241f7`)**: a fault whose severity calls for it now sends "stop when safe" and "engine off" before the
  model is asked anything, and fire, smoke or someone hurt in a driver's message sends the 112 line first. The six
  fixed lines exist in Finnish, Swedish, German, Danish and French; they go out in the language the driver writes in,
  or their home country's with English below. The clearance patterns, the stop check and the classifier-down
  fallback cover those languages (with Unicode word edges: `\b` in JavaScript fails on "är" and "fumée"). No more
  "usually not critical".
- **A real run found what the tests could not.** With the Finnish line in the thread, the agent answered Leo, who
  writes English, in Finnish, and switched back and forth. The prompt already said "English until they write"; the
  model took the server's line as the conversation's language. The agent now reads such a line as its English text
  with a note of the languages it went out in. The rerun: every agent message after the stop lines was in English.
- **The counts and the queue** (`6d8ff7b`, from Roope and the completion plan). The map said 16 need a person, the
  queue 20: the queue also put open alerts and quiet phones under "Needs your decision", each row headed by "Open
  alert: …". A records row now needs a decision only when an item in it waits on a person (the map's rule); that
  item leads the row; signals go to an amber "Worth a look". One team test said an urgent alert stays in "Needs your
  decision"; its point was that the alert must not hide behind a waiting case, so the code keeps it visible as worth
  a look and the test says that now. The packet's "source is a conversation, not a verified outcome" reads as words.
- README: the live line is outside the repo and starts no agent turn; no `VOICE_PROVIDER` or `voice:test`; a model
  table; the root `.env.example` points to the two real ones. Four screenshots of scenario A on the real agent.
- Left for after the hackathon, as new features rather than fixes, and named in the plan as pilot conditions:
  login and per-person identity (R1), timers without an open tab (R2), Slack/SMS alerts (R7), an EU-hosted model,
  pseudonymisation and retention (R5).

Checked: 133/133 tests, both typechecks, the build, smoke; the role harness on DeepSeek for A, F and G after the
safety change (18/18), and scenario A twice more for the language fix and the screenshots. Map, board and queue
show the same count. Spend: about $7.9 of the $10 (OpenRouter key at $10.82, $2.88 before the night).

## 2026-10-25 ~08:05–08:35 UTC · RoopeS + Claude Code (cloud) · the night's open agent gaps, on Roope's own key

Asked: fix the three agent gaps the second night left open (`starter/scripts/night/MORNING.md`) and the driver phone's
UTC times (review R25); from here on use Roope's own OpenRouter key, up to $15, since the hackathon key had $10.84 of
$20 spent. Then merge to `main`.

Got:
- The prompt and the keys playbook: never promise to tell the receiver, the customer or a desk anything (who tells them
  is a person's decision); a described warning light with no codes gets questions and "an operator decides", never
  "drive gently"; keys with an unconfirmed contact get the recorded instruction, labelled unconfirmed, with a time box
  that ends before the driver arrives.
- The phone shows times where the driver is: the pickup side until the ferry lands, then the delivery side; the ferry
  in its terminal's zone ("Ferry check-in by 21 Oct 17:30 CEST", "Car and keys collected 09:00 CEST").
- The night harness ran here for the first time: it reached its database only through `docker exec`; with
  `NIGHT_DATABASE_URL` it uses a local psql. Its three scenarios against this app found what the unit tests could not:
  on the keys question the agent wrote exactly the time-boxed answer, before calling `hand_over`; text before a tool
  call is never sent, and `hand_over` then asked for "one or two short sentences", so the driver got "the fallback is
  as above". `hand_over` now says its reply is the only text the driver receives. Rerun: the whole answer arrived,
  with "If you haven't heard from us by 12:35, go ahead with that: hand the keys to reception and get the handover
  signed". The harness also read "an operator will decide whether you can continue" as clearance; fixed in the judge.

Checked: missed ferry 12/0/0 ("operations decides what to tell the receiver and when"), routine keys 11/0/0, light
11 checks with one review (no fuel-cap question, which only fuel-tank codes call for); 133 unit tests; the full role
harness on the final build before the merge to `main`.
- The full role harness on the final build passed 47/51; all four misses were story B, the same way as after the merge:
  asked for a new delivery date, the agent drafted it as `CONTACT_CUSTOMER` with the window filled in (two of four
  runs). The gate now refuses a customer message carrying a window other than the promise while no date waits for an
  answer, and says to propose `CHANGE_PROMISE`. B then passed 9/9 twice; the refusal fired and the agent re-proposed.
  `main` was fast-forwarded to `roope` (`594703a`). Spend on Roope's key: $1.29.

## 2026-10-25 ~09:00–10:00 UTC · RoopeS + Claude Code (cloud) · the agent's calls on the record, and a simulation that runs itself

Asked: the agent's calls must show on the order (that it called the driver to check their location, and what came of
it); the agent should make such calls on its own when a situation is urgent or when it has time, as checks on a
schedule, with the demo screen's manual triggers taking precedence; and CD-420806's customer asked about "another time
zone" on a Turku to Oulu delivery.

Got:
- Calls were stored only in the call service and shown in its own section; the order's "Activity" showed the packet's
  event log alone, so nothing the app recorded live (a call, a note) ever appeared there on an order without a case.
  Every call the agent places now leaves two lines on the order and its open case ("Calling Rafael Rillavik (position
  check): no position from the driver's phone since 02:12 UTC", then "Called Rafael Rillavik to check where the car is:
  on the road, near the last position I sent, ETA 14:40 UTC, the driver is fine"), and Activity merges what the app
  recorded live with the record.
- The autopilot (`lib/sim/autopilot.ts`) and a heartbeat in the server (review R2: timers with no tab open). Every 20 s
  the server writes due telemetry, runs the case timers and places at most one call for the most pressing check: a
  quiet phone on a moving car, a ferry check-in closing within 90 min, a pickup slot within 3 h with unverified access,
  an assigned driver who has not started. What a call finds that may need a decision goes to the agent as a follow-up
  turn. Manual wins: the scenario orders are the presenter's; a scenario started on an order stands the non-location
  checks down there; an order someone is working on is left alone; a driver a person is playing is not phoned. The
  demo screen has the switch and the list of what is due. The silent-driver escalation now phones the driver before
  the card: in F the record reads stop lines, a question, one reminder, "Called William to check where the car is: no
  answer", then "Call William on his phone now?".
- Two things only a real run showed. The call service's extractor took "Are you safely off the road?" "No, I'm on the
  road, but everything's fine" for DRIVER_SAFE=false, and the agent sent a stop instruction to a driver who was fine;
  the extractor now reads "safe" as danger, not as being parked, the summary carries the person's own words on
  anything flagged, and the agent is told to judge by those words. And my first "quiet phone" rule read the packet's
  last tracking fix instead of the simulated samples, so every car was due at once; it now reads the simulated fixes.
- CD-420806: the two messages now ask and answer the delivery range in Oulu (same zone as Turku), in the dataset and
  the live database. It was the only such message.

Checked: 137 unit tests (a new one for the call summary), both typechecks, the build; against the running app on
Roope's key: the autopilot's call to Rafael on CD-420806 end to end (the lines on the order, no case opened since
nothing was flagged), scenario F through its clock jumps, and the demo screen. Not run: the full role harness.
