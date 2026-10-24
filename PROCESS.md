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
