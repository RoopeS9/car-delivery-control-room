# Build plan: Road Desk for the Car Delivery Control Room

This is the working spec for team **Random** (Bahn challenge, Prompt Operations
Hackathon). Any person or coding agent picking up work should read this file
first, then `PARTICIPANT-BRIEF.md`, `OPERATIONS-CONTEXT.md` and
`dataset/SCHEMA.md`. If this file and the brief disagree, the brief wins.

**Hard deadline: Sun 25 Oct 2026, 13:00 UTC.** Feature freeze 09:00 UTC,
video recorded by 11:00 UTC.

---

## 1. What we are building

Bahn wants a control room where agents do the legwork and bring a person only
the cases that need one, plus one real agent for one area. We pick **On the
road + Driver support**.

The pitch in one line: *a driver calls, writes or sends a photo; an AI
interviews them, reads the car (OBD2) and the phone (GPS, photos), checks the
order and a rulebook, does what it is allowed to, and hands the operator one
decision card where every fact shows its source.*

### Parts

1. **Driver channel ("the sink").** One phone-sized driver app: live voice
   call, chat, photo upload, OBD status. Everything lands in one case timeline.
2. **Telemetry (simulated).** An OBD2 dongle stream (speed, RPM, engine load,
   pedal position, coolant temperature, battery voltage, fuel trim, trouble
   codes with freeze frame) and phone GPS. On a fault, the dongle sends a
   detailed snapshot.
3. **Road agent.** A Claude tool-use loop with a rulebook (playbooks), a
   trouble-code knowledge base, and code-enforced approval gates. It answers
   basic information requests from **operators, drivers and pickup sites**.
4. **Control room.** A "Needs you" queue instead of lanes, a case page with
   the decision card, a live map, an agent page (rulebook + autonomy
   settings), and dark mode.

### Decided (do not reopen without the team)

| Topic | Decision |
|---|---|
| Driver input | Live voice call **and** chat **and** photos. All three feed the same agent and timeline. |
| Map | Simulated phone GPS for moving orders, every position labelled "simulated" with its age. |
| Drivability | Agent may give **safety-only** advice immediately ("stop the car now", "stay safe off the road"). Any "you can keep driving" needs an operator yes. The car owner (customer) decides recovery. |
| Codebase | Extend `starter/` (Next.js 16, Postgres, Drizzle). Keep the old board at `/board`. |
| Model | Claude via the official `@anthropic-ai/sdk`. Default `claude-opus-5-5`; model and effort come from env vars so we can tune for latency. |

---

## 2. Rules we must never break (from the brief)

These are enforced **in code** (the tool executor), not only in the prompt.

1. **The agent never contacts a customer on its own.** A customer is anyone who
   pays Bahn (`orders.customer_id`). A pickup or delivery site whose
   `sites.customer_id` equals the order's customer counts as the customer.
   Messages to a customer are always a proposal that a person approves; this
   can never be set to automatic.
2. **Approval before change.** Bookings, dates and promises, costs, driver
   reassignment, "continue driving" clearance and customer messages all go
   through a proposal. Looking things up and asking drivers or sites questions
   need no approval.
3. **Autonomy can grow later.** Each action type has a level: `ASK_FIRST`
   (default for all), `DO_AND_TELL`, `AUTO`. Customer contact is pinned to
   `ASK_FIRST`.
4. **Real agent.** A language model working in a loop with tools. Phone, OBD,
   GPS, prices and driver replies may be mocked.
5. **Not a developer tool.** No JSON, raw IDs or stack traces in the operator
   UI. Plain language, order references (CD-xxxxxx), names and times.
6. **Everything fictional.** No real people, messages, bookings or purchases.
   Dashboard photos and other images must be generated or drawn, not real
   photos of real people.
7. **Data honesty** (judged): a quote is not a booking, a driver message is
   not a verified location, an alert is not a diagnosis, simulated GPS is
   labelled simulated. Every fact shown carries its source and time.

---

## 3. Demo story (what the video shows, about 2.5 min)

Build towards these scenarios first; everything else is secondary.

**A. Fresh warning light (headline).** CD-420584, Bentley Continental GT
(petrol), Cologne → Helsinki, moving, no open signals in the dataset.
1. The OBD stream shows a flashing check-engine light, misfire code(s) and
   reduced power. The driver calls in by voice.
2. The agent: asks if they are safe → tells them to stop now (safety tier) →
   asks for the exact location and a dashboard photo → reads the photo with
   vision → looks up the codes → checks the order (owner, promise, ferry
   leg) → finds mocked nearby help.
3. The operator sees one card: *"Car stopped, driver safe at <place>. Misfire
   codes P0300/P0302, not safe to drive on. Call the dealer: their own roadside
   assistance or our tow? Helsinki delivery on <date> will likely be late."*
   Options: approve "call dealer" (with a drafted message), edit, or reject.
4. The operator approves. The timeline shows what happens next and the case
   moves to "Waiting on dealer".

**B. Catch-up on an existing case.** CD-420322, Bentley, Munich → Hamburg. The
dataset already has the safe stop and an open recovery decision. The agent
reads the history, asks the driver for the OBD readout, and turns the open
work item into a decision card. This shows that the agent respects existing
records and sources.

**C. Routine driver question, no human needed.** E.g. CD-420145 (Porsche 911,
Lahti → Helsinki): "Where do I leave the keys?" or "Can I claim this parking
receipt?" The agent answers from the order and site records, or files the
expense as a proposal, and closes the case. In the queue it shows as
"handled by agent".

**D. Pickup site asks for an ETA.** A site contact writes "When is the driver
here?" The agent answers only about that order, from the simulated GPS and
plan, saying where the estimate comes from.

**E. Overview.** Map and queue with ~100 orders: only a handful need a person.

---

## 4. Architecture

```
starter/ (Next.js 16 app, extended)
  app/
    page.tsx                  -> "Needs you" queue (replaces board as home)
    board/                    -> old lane board, kept
    orders/[id]/              -> order page, now with case panel + decision card on top
    map/                      -> live map
    agent/                    -> how the agent works: playbooks, autonomy, activity log
    driver/                   -> driver phone app (demo surface): call, chat, photos, OBD bar
    site/                     -> minimal pickup-site chat (demo surface)
    demo/                     -> hidden scenario control panel (not linked in ops nav)
    api/
      cases/...               -> list, get, decide on proposals
      agent/...               -> run a turn, operator chat, stream progress
      channels/...            -> inbound driver/site messages, photos, voice turns
      sim/...                 -> scenarios, telemetry ticks, simulated driver
  lib/
    cr/                       -> OUR data layer: schema, types, queries (shared contract)
    agent/                    -> loop, tools, gates, prompts
    sim/                      -> OBD + GPS generators, scenarios, simulated driver
    present/                  -> starter's reading layer (extend, do not rewrite)
  rulebook/                   -> markdown playbooks loaded into the agent prompt
  knowledge/                  -> dtc.json, warning-lights.json, city-coords.json
  traces/                     -> saved agent runs (JSON) for judges
```

### 4.1 Data layer (`lib/cr/`)

Our tables live beside the starter's. **No foreign keys into starter tables**:
the starter's reseed refuses to run otherwise. Store `order_id` as plain text.
Prefix every table with `cr_`.

| Table | Purpose | Key fields |
|---|---|---|
| `cr_cases` | One issue on one order | `id, order_id, kind, status, urgency, title, summary, channel_opened, opened_at, updated_at, owner` |
| `cr_events` | Case timeline (our side) | `id, case_id, order_id, at, actor_type, actor_id, kind, body, data jsonb, source_refs jsonb` |
| `cr_proposals` | Decision cards | `id, case_id, order_id, action_type, title, rationale, changes jsonb, draft_message jsonb, evidence_refs jsonb, options jsonb, status, decided_by, decided_at, decision_note, next_step` |
| `cr_telemetry` | OBD + GPS samples | `id, order_id, vehicle_id, at, source ('OBD'\|'PHONE_GPS'), data jsonb, simulated bool` |
| `cr_autonomy` | Trust levels | `action_type PK, level, locked bool, updated_by, updated_at` |
| `cr_agent_runs` | Trace per agent turn | `id, case_id, started_at, model, input, tool_calls jsonb, output, usage jsonb` |

Enumerations:

- `cases.kind`: `VEHICLE_WARNING, BREAKDOWN, ACCIDENT, DELAY, MISSED_CONNECTION, KEYS_ACCESS, EXPENSE, DRIVER_QUESTION, SITE_QUESTION, OPERATOR_QUESTION`
- `cases.status`: `AGENT_WORKING, NEEDS_DECISION, WAITING_EXTERNAL, HANDLED_BY_AGENT, RESOLVED`
- `events.actor_type`: `driver, site, customer, operator, agent, obd, phone, system`
- `events.kind`: `message, voice_turn, photo, telemetry_snapshot, dtc, lookup, tool_call, proposal, decision, effect, note`
- `proposals.action_type`: `CONTACT_CUSTOMER, UPDATE_ETA, CHANGE_PROMISE, BOOK_RECOVERY, BOOK_TRAVEL, APPROVE_EXPENSE, REASSIGN_DRIVER, CLEAR_TO_CONTINUE, CONTACT_SITE_AS_CUSTOMER`
- `proposals.status`: `PENDING, APPROVED, EDITED_AND_APPROVED, REJECTED, EXECUTED, FAILED`

`source_refs` / `evidence_refs` are arrays of `{ kind, id, label, at }` where
`kind` is a dataset collection (`messages`, `alerts`, `time_windows`, ...) or
one of ours (`cr_events`, `cr_telemetry`, `knowledge:dtc`). The UI renders these
as source chips ("Driver, app chat, 08:22", "OBD dongle, 08:05", "Rulebook:
warning light").

The case timeline is the dataset's messages and events for the order **merged
with** `cr_events`, sorted by time, each line labelled with its actor and
source.

**Simulated clock:** `SIM_NOW` env (default `2026-10-21T09:00:00Z`, the
snapshot time). Our new events advance from there (`SIM_NOW` + real elapsed
time since server start). Every "x min ago" uses this clock.

**Attention:** extend `lib/present/attention.ts` so open `cr_cases` and
pending `cr_proposals` count as "needs a person". Keep `npm run smoke` passing.

### 4.2 Agent (`lib/agent/`)

Read the `claude-api` skill or the live Anthropic docs before writing this
code. Do not guess SDK names. Key points for the current API:

- `@anthropic-ai/sdk`, model from `AGENT_MODEL` (default `claude-opus-5-5`).
- Opus 5.5 thinking cannot be disabled; control depth with
  `output_config.effort`. Use `AGENT_EFFORT_FAST` (default `low`) for driver
  chat and voice turns, `AGENT_EFFORT_DEEP` (default `medium`) for case
  analysis and building proposals.
- Forced `tool_choice` (`any`/`tool`) returns a 400. Use `auto` plus prompt
  instructions, and `strict: true` on tool schemas.
- Write our own loop (or Tool Runner with per-turn hooks) so **every tool call
  passes through our gate and is logged** to `cr_agent_runs` and `cr_events`.
- Stream for long turns. Cache the system prompt + rulebook (stable prefix
  first, volatile content last).
- Include the server-side refusal `fallbacks` option, as the skill recommends.

**One agent, three audiences.** The same loop runs with a different role
preamble and tool subset depending on who it is talking to:

| Audience | Can see | Tone |
|---|---|---|
| Driver | Their own assignment, route, site access notes, keys, travel bookings | Short, calm, one question at a time. Voice: one or two sentences. |
| Pickup/delivery site | Only that order's timing, driver name, vehicle and plate | Polite, minimal. Never other orders, prices or customer details. |
| Operator | Everything on the order and related records | Facts with sources; recommendation; what is unknown. |

**Tools.**

Read (no approval, always allowed):

- `get_order_context(order_ref)`: vehicle (make, model, fuel), route with
  active plan, promise windows (with source), assigned driver, customer name,
  site access notes, open alerts, work items, conversations, last tracking
  observation. Returns facts with `source_refs`.
- `get_timeline(order_ref, since?)`: merged messages and events.
- `get_telemetry(order_ref, minutes)`: OBD + GPS samples, latest snapshot.
- `get_active_codes(order_ref)`: current trouble codes + freeze frame.
- `lookup_trouble_code(code, make?)`: from `knowledge/dtc.json`.
- `lookup_warning_light(description)`: from `knowledge/warning-lights.json`.
- `analyse_photo(event_id)`: vision on an uploaded photo (dashboard, damage).
- `find_nearby_help(lat, lng, kind)`: mocked: service areas, tow companies,
  brand workshops, hotels. Clearly fictional names.
- `search_travel_options(from, to, after)`: mocked ferries, trains, hotels;
  results are **quotes**, never bookings.
- `read_playbook(name)`: fetch a rulebook section if not already in context.

Ask (no approval; drivers and non-customer sites only):

- `message_driver(text)`, `request_photo(what)`, `ask_site(order_ref, text)`.
  `ask_site` refuses if the site counts as the customer (rule 1).
- `safety_instruction(text)`: immediate, only for the safety tier; logged
  as its own event so the operator sees exactly what was said.

Change (gate checks `cr_autonomy`; at `ASK_FIRST` this creates a proposal):

- `propose_action({ action_type, title, rationale, changes, draft_message?,
  options, evidence_refs, next_step_if_approved, next_step_if_rejected })`.
- `escalate({ question, summary })`: puts the case in `NEEDS_DECISION` with a
  handover packet when there is no single action to propose.
- `close_case({ summary })`: only for routine questions fully answered.

**Handover packet** (what every decision card is built from):
1. What happened (one sentence).
2. Facts, each with a source chip and time.
3. What the agent already did (questions asked, lookups, instructions given).
4. What is still unknown.
5. Recommendation and alternatives.
6. What happens after each choice.

**Stopping rules** (in the system prompt and playbooks): stop and hand over
when a decision needs money, a date or promise change, customer contact,
judgement about safety beyond the safety tier, or when facts conflict. Never
retry an external action whose outcome is unknown (see CD-420299 in the
dataset).

### 4.3 Rulebook (`rulebook/*.md`)

One playbook per situation. Each has: *when it applies, facts to collect (in
order), what the agent may do alone, when to stop, who decides, never do,
worked example.* Write them in plain English; they are also shown on the
`/agent` page.

- `00-principles.md`: safety first, customer rule, approvals, sources, tone.
- `warning-light.md`, `breakdown.md`, `accident.md` (people first; emergency
  number advice is a safety instruction).
- `delay-and-missed-connection.md` (ferry or train missed: quotes vs bookings,
  driver rest, customer approval for later date).
- `keys-and-access.md`, `expenses.md`, `eta-requests.md` (driver, site,
  operator variants), `driver-questions.md` (routine FAQ).

### 4.4 Knowledge (`knowledge/`)

- `dtc.json`: about 40 common codes (misfires P0300–P0306, lean/rich P0171/
  P0172, catalyst P0420, coolant temperature P0217, oil pressure P0520–P0524,
  charging P0562/P0563, EVAP, sensors, transmission P07xx, plus a few EV/hybrid
  high-voltage codes like P0AA6, P1E00-style manufacturer placeholders). Fields:
  `code, title, system, severity ('STOP_NOW'|'DRIVE_TO_SAFE_STOP'|
  'CONTINUE_AND_MONITOR'), drivability, common_causes, questions_for_driver,
  ev_relevant, note`. Mark the file as illustrative guidance, not workshop
  advice.
- `warning-lights.json`: red vs amber lights. Flashing check-engine = stop;
  oil pressure, coolant temperature, brake and charging (red) = stop; steady
  check-engine = operator decides.
- `city-coords.json`: lat/lng for the 30 cities in `addresses.jsonl`, plus the
  ferry terminals in `ferry_terminals.jsonl`.

Note in the pitch: standard OBD2 data on EVs is thin and mostly
manufacturer-specific (22 of the 103 vehicles are electric). Demo cases use
petrol cars.

### 4.5 Simulation (`lib/sim/`)

- **GPS:** for every `IN_TRANSIT` order, interpolate a position between
  pickup and delivery city coordinates (via ferry terminals when the plan has a
  ferry segment), driven by the last tracking observation's progress and the
  sim clock. Stored in `cr_telemetry` with `simulated: true`. Some orders go
  stale on purpose to show the "last seen 47 min ago" state.
- **OBD:** per-vehicle baseline signals with noise, ticking every few seconds
  for scenario orders (and cheaply for others). Fault injection changes the
  signals (misfire: RPM jitter, load drop, rising misfire counter, flashing
  check-engine; overheating: coolant climbing) and emits a `dtc` event with a
  freeze frame. Electric cars report a reduced PID set.
- **Scenarios** (`POST /api/sim/scenarios/:name`, triggered from `/demo`):
  `warning-light-584`, `catch-up-322`, `driver-keys-145`, `site-eta`, `reset`.
  Reset removes all `cr_*` rows for a clean take.
- **Simulated driver** (optional per scenario): a small LLM persona that
  knows the scenario facts (location, what they saw, mood) and answers the
  agent in the driver channel, so one person can run the demo. A human using
  `/driver` always overrides it.

### 4.6 Voice

- Voice is a transport layer over the same agent turn. A transcript turn
  becomes a `voice_turn` event; the agent reply is spoken.
- **Version 1:** the browser's Web Speech API (SpeechRecognition +
  speechSynthesis) in Chrome. Call screen: big call button, live transcript,
  mute, end call, and a "switch to chat" link. Use push-to-talk first;
  hands-free with silence detection if stable.
- Behind a small `VoiceProvider` interface so we can swap in a hosted
  speech-to-text and text-to-speech service later. Check the live Anthropic
  docs for native audio support before picking one.
- Voice replies must be short (1–2 sentences) and use the fast effort level.
- The call ends when the playbook's facts are collected; the agent says what
  happens next ("An operator is calling the dealer now. Stay with the car.").
- Fallback for the demo: the chat path must work alone. Record video in a
  quiet room.

### 4.7 Control room UI

Design rules (judged as "taste", 30%): readable text, calm spacing, one
glance tells what is wrong and what to do, sensible empty and loading
states, works with hundreds of orders. Keep Bahn's birch / asphalt / sand
palette and the starter fonts. All colours are CSS tokens with a dark theme
(`prefers-color-scheme` plus a manual toggle saved per browser).

- **Needs you (home).** A short list of cases with status `NEEDS_DECISION`
  (then `AGENT_WORKING`, then `WAITING_EXTERNAL`). Each row: car + reference,
  one-line "what happened", the decision waiting, urgency, age, who's on it
  (agent or person). Below: "Handled by the agent today (n)" collapsed, and
  "n orders quiet" as a count with a link to the board. Search stays.
- **Case / order page.** At the top, the decision card: title, recommendation,
  "what changes if you approve" (before → after), drafted message (editable),
  source chips, buttons **Approve / Edit / Reject** (reject asks for a short
  reason, which goes back to the agent). After deciding: a "what happens next"
  line and the timeline updates. Then: the timeline (merged, labelled by
  actor and source), telemetry strip (key OBD values + codes), photos, and an
  **"Ask the agent"** box for operator questions ("Has the driver sent the
  photo?", "What is the promise and who set it?"). The starter's record
  sections stay below, folded.
- **Map.** MapLibre GL or Leaflet with light and dark tile styles (with
  attribution). Markers: needs decision (strong colour), agent working,
  waiting, fine (muted), stale (hollow, with "last seen"). Clicking a marker
  opens a side panel with the case summary and a link. Label every position
  "simulated GPS".
- **Agent page.** The playbooks (rendered markdown), the autonomy table (each
  action type with its level; customer contact shown locked), and a recent
  activity log in plain language ("08:05 Asked driver for a dashboard photo on
  CD-420584").
- **Driver app** (`/driver`). Phone frame on desktop, full screen on mobile.
  Pick a driver (role switcher, no login). Tabs or stack: current job card,
  call, chat, camera/upload, OBD status bar (connected, key values, warning
  icon).
- **Site chat** (`/site`). Pick a site contact + order, simple chat.
- **Demo panel** (`/demo`). Scenario buttons, reset, toggle simulated driver.
  Not linked from the ops navigation.

---

## 5. Running it

Local (and any cloud machine with Docker), from the repo root:

```sh
cd starter
cp .env.example .env          # add ANTHROPIC_API_KEY
npm ci
docker compose up -d --wait
npm run db:push
npm run db:seed
npm run attachments:seed
npm run dev                   # http://localhost:3000
```

**Cloud machine without Docker:** install Postgres 17 directly (or use a
hosted Postgres) and point `DATABASE_URL` at it. The S3 attachment store is
optional for agent work; skip `attachments:seed` and the app still runs
(photos from the dataset will be missing).

Env vars to add to `starter/.env.example`:

```
ANTHROPIC_API_KEY=
AGENT_MODEL=claude-opus-5-5
AGENT_EFFORT_FAST=low
AGENT_EFFORT_DEEP=medium
SIM_NOW=2026-10-21T09:00:00Z
SIM_DRIVER_ENABLED=true
```

Read `starter/AGENTS.md`: this Next.js version differs from what models
remember. Check `node_modules/next/dist/docs/` before writing routes or
server code.

Checks that must keep passing: `npm run typecheck`, `npm run build`,
`APP_URL=http://localhost:3000 npm run smoke`.

---

## 6. Workstreams (parallel; separate folders to avoid merge conflicts)

**Contract first.** Before splitting up, whoever starts writes `lib/cr/schema.ts`
and `lib/cr/types.ts` (section 4.1) and pushes them. Everyone builds against
that contract. Changes to it are announced to the team.

| Stream | Owner | Folders | Delivers |
|---|---|---|---|
| A. Agent | TBD | `lib/agent/`, `rulebook/`, `knowledge/`, `app/api/agent/`, `app/api/cases/` | Loop, tools, gates, prompts, playbooks, DTC base, traces, gating tests |
| B. Control room | TBD | `app/page.tsx`, `app/orders/`, `app/map/`, `app/agent/`, `app/components/`, `globals.css`, `lib/present/` | Queue, decision card, timeline, ask-the-agent box, map, agent page, dark mode |
| C. Driver, sim, voice | TBD | `app/driver/`, `app/site/`, `app/demo/`, `lib/sim/`, `app/api/sim/`, `app/api/channels/` | Driver app, site chat, OBD/GPS sim, scenarios, simulated driver, voice; video + write-up |

Git: branch per stream (`agent/*`, `ui/*`, `sim/*`), small PRs into `main`,
pull often. Do not commit `.env`.

---

## 7. Milestones and acceptance

Times are UTC targets.

**M0 Foundation (first ~1 h).** Starter runs; `cr_*` tables pushed; contract
types committed; tokens and dark mode skeleton; `PROCESS.md` started.
*Done when:* app runs, `cr_` tables exist, smoke passes.

**M1 Vertical slice, chat only (Sat evening).** Scenario A end to end with no
polish: trigger warning light → driver chats → agent asks, looks up, gives
the safety instruction, proposes "call dealer" → operator approves on the
order page → timeline shows decision and next step.
*Done when:* a run is saved in `traces/` and a test proves that a
`CONTACT_CUSTOMER` action cannot execute without approval.

**M2 Control room quality (Sat night / Sun early).** Needs-you queue, decision
card, source chips, map with simulated GPS, empty and loading states, dark mode
complete. Scenarios B, C, D work.

**M3 Voice (after M1 is solid).** Web Speech call on `/driver` for scenario A.
Chat fallback still works.

**M4 Extras, cut in this order if late:** map polish → site chat → checkpoint
photos → autonomy editing (show it read-only instead) → hosted voice.

**Freeze 09:00 UTC Sun.** Then only bug fixes, README, video (record by
11:00), write-up on prompthack, submit before 13:00.

---

## 8. Deliverables checklist

- [ ] Public GitHub repo (`origin`: RoopeS9/car-delivery-control-room) that runs
      from a fresh clone with the README steps.
- [ ] README: what it is, how to run, how to trigger scenarios, architecture
      sketch, what is mocked.
- [ ] `traces/`: saved agent runs for each scenario.
- [ ] Tests: approval gates, customer rule, site scoping.
- [ ] `PROCESS.md`: how we used coding agents (30% of the score).
- [ ] 2–3 min video: problem → demo A → glimpse of C/D/map → process.
- [ ] Prompthack write-up (name, tagline, story, cover screenshot, links) and
      marked as submitted.

---

## 9. Process log (`PROCESS.md`), keep it as you go

Judges score *how we worked with AI*: what we asked for, what we checked, what
we threw away, where we did not take the first answer. Every person and agent
appends short entries:

```
## <time UTC> · <who / which agent> · <stream>
Asked: ...
Got: ...
Checked / changed / rejected: ... and why
```

Coding agents working from this plan: append an entry when you finish a
meaningful task, and especially when you deviate from this plan or discard an
approach.

---

## 10. Out of scope

Real telephony, real OBD hardware, real bookings or payments, login and
permissions beyond a role switcher, a native mobile app, trucks, and changing
the dataset files.
