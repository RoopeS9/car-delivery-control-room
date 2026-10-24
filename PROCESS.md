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

## 2026-10-24 ~12:15 UTC · Claude Code (stream A agent) · M0 foundation

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
