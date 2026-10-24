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
| Model access | Claude **through OpenRouter** (our event credits), using the official `@anthropic-ai/sdk` pointed at OpenRouter's Anthropic-compatible endpoint. Opus 5.5 for the demo; cheaper models while developing. See 4.2. |
| Product name | **Road Desk**. |
| Queue scope | The "Needs you" queue shows **only our road and driver cases** (`cr_cases`). Other dataset orders that need a person stay on the old board, reached by one quiet link with a count. |
| After a decision | When an action needs a human outside the system (e.g. "call the dealer"), the **operator does it and logs the outcome** in one line; the agent picks the case up from there. The operator can also give the agent a free-text instruction instead of approving. |
| Demo device | Driver app runs in a **second browser window on the same laptop** (localhost, so the mic works without HTTPS). |
| Language | Demo in English. Agent replies in the driver's language if they write in another; operator summaries are always English. |

---

## 2. Rules we must never break (from the brief)

These are enforced **in code** (the tool executor), not only in the prompt.

1. **The agent never contacts a customer on its own.** A customer is anyone who
   pays Bahn (`orders.customer_id`). A pickup or delivery site whose
   `sites.customer_id` equals the order's customer counts as the customer.
   Messages to a customer are always a proposal that a person approves; this
   can never be set to automatic. **Replies count too:** when a customer writes
   in, the agent drafts the reply and a person approves it.
   In this dataset the delivery site belongs to the customer on 63 orders
   (including all our scenario orders), while the pickup site does on only 4.
   So pickup desks are normally fine to contact, but receiving dealers are not.
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
Facts from the data (verified): driver **Leo Quellford** (`drv-042`), picked
up 07:00 UTC in Cologne; last app observation 08:37, about 165 km done, 1,992
km left; **ferry booked** West Baltic Vehicle Terminal → South Finland Vehicle
Terminal, **check-in cutoff 15:30 UTC, departs 17:30**, booking ref
WBV-FERRY-00584, check-in unconfirmed; customer promise **26 Oct 08:00–14:00
UTC**, app ETA already 12:50. This gives the chain the brief describes:
fault → recovery decision → ferry cutoff at risk → next sailing (a quote,
not a booking) → promise at risk.
1. Around 09:05 sim time the OBD stream shows a flashing check-engine light,
   misfire codes and reduced power. **The agent reaches out to the driver
   first** (proactive trigger), and the driver answers by voice.
2. The agent: asks if they are safe → tells them to stop now (safety tier) →
   asks for the exact location and a dashboard photo → reads the photo with
   vision → looks up the codes → checks the order (owner, promise, **ferry
   cutoff**) → finds mocked nearby help → checks later sailings (quotes).
3. The operator sees one card: *"Car stopped, driver safe at <service area>.
   Misfire codes P0300/P0302, not safe to drive on. Call the dealer: their own
   roadside assistance or our tow? Today's 15:30 ferry check-in is at risk;
   next sailing is a quote only. The 26 Oct delivery is at risk."* Options:
   "I'll call the dealer" (with talking points), edit, reject, or instruct the
   agent.
4. The operator calls (off-screen) and logs "Dealer sends their own roadside
   help, ETA 11:00". The agent tells the driver, drafts a proposal for the
   ferry change and a customer update, and the case moves to "Waiting on
   roadside help". The timeline shows each step with its source.

**B. Catch-up on an existing case.** CD-420322, Bentley, Munich → Hamburg,
driver Kasper Kovelund (`drv-319`). The dataset already has the safe stop
(08:04–08:58) and an open recovery decision. The customer promise is **today,
21 Oct 10:00–14:00 UTC**, so the card must say it is about to be missed. The
agent reads the history, asks the driver for the OBD readout, and turns the
open work item into a decision card. This shows that the agent respects
existing records and sources.

**C. Routine driver question, no human needed.** CD-420145 (Porsche 911,
Lahti → Helsinki, driver Kasper Carvell `drv-130`, promise today 08:00–13:00
UTC): "Where do I leave the keys?" or "Can I claim this parking receipt?" The
agent answers from the order and site records, or files the expense as a
proposal, and closes the case. In the queue it shows as "handled by agent".

**D. Pickup site asks about the driver.** CD-420442, pickup at Orvendin Cars
Stockholm (not the customer), site desk **Uma Aldermere** (contact confirmed
from the site profile), selected pickup slot **22 Oct from 08:00 UTC**, driver
Kasper Darevik, assignment status `ASSIGNED`. Uma writes "Is your driver still
coming tomorrow morning?" The agent answers only about this order, from the
assignment and slot records, and says what it does not know: "Kasper Darevik
is booked for your slot tomorrow from 08:00 UTC. He has not started the
journey yet, so there is no live position; we will message you if anything
changes." No customer, price or other-order details.

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
code. Do not guess SDK names.

**Model access via OpenRouter** (verified 24 Oct with a real tool call on
`anthropic/claude-opus-5.5`: tool use, `strict` tool schemas and
`output_config.effort` all work):

```ts
import Anthropic from "@anthropic-ai/sdk"
const client = new Anthropic({
  baseURL: "https://openrouter.ai/api",        // no /v1: the SDK adds it
  apiKey: null,
  authToken: process.env.OPENROUTER_API_KEY,   // sent as Authorization: Bearer
})
// model ids use OpenRouter names: "anthropic/claude-opus-5.5",
// "anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5"
```

- Put all of this in one module (`lib/agent/client.ts`) so nothing else knows
  about OpenRouter.
- Not available through OpenRouter: token counting (`count_tokens`); do not
  rely on Anthropic beta-only parameters such as server-side refusal
  `fallbacks`. Handle `stop_reason: "refusal"` by handing the case to a person.
- Each response's `usage.cost` reports dollars spent. Log it in `cr_agent_runs`
  and show the running total on `/demo`.
- **Budget:** $60 in total (three $20 keys). The keys stop working a day after
  the event. A short Opus 5.5 tool call cost $0.003; expect roughly $0.05–0.15
  per agent turn with full order context. Use prompt caching (stable system
  prompt + rulebook first), develop on `anthropic/claude-sonnet-5.5` or
  `-haiku-5.5`, and switch to Opus 5.5 for the demo and video. The simulated
  driver always uses Haiku 5.5.
- **Never commit a key.** Keys live in `starter/.env` (gitignored) or the
  cloud instance's environment settings.

Key points for the current API:

- Model from `AGENT_MODEL` (default `anthropic/claude-opus-5.5`).
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

**Triggers: when the agent runs.**

| Trigger | Source | What the agent does |
|---|---|---|
| Driver or site message | `POST /api/channels/{driver,site}/messages` | Conversational turn; opens a case if none is open for that order and topic. |
| Telemetry fault | Simulator writes a `dtc` or warning event | **Proactive**: opens a case and contacts the driver first ("Are you safe?") before any human sees it. |
| Operator decision | Approve / edit / reject / log outcome / instruct | Continues the case: executes the approved effect, informs the driver, proposes the next step. |
| Operator question | "Ask the agent" box | Read-only answer with sources; never changes anything from this box. |

**One run at a time per case.** Runs are serialised per case (a simple lock
row or in-process queue). A message that arrives mid-run is stored as an event
and included in the next turn. A run has a step limit (e.g. 12 tool calls) and
ends by handing over if it reaches it.

### 4.2b Decisions and what happens next

Every decision card offers:

- **Approve**, or **Edit and approve** (the operator changes the drafted
  message or the values).
- **Reject**, with a one-line reason that goes back to the agent.
- **I'll handle it**, for actions a person does outside the system, such as
  a phone call. The case then asks for the outcome ("Log what happened"), and
  the operator writes one line, e.g. "Dealer sends their own roadside help,
  ETA 11:00".
- **Tell the agent instead**: a free-text instruction ("Book the tow
  ourselves and ask the driver to wait in the café"). It goes into the next
  agent turn as an operator instruction.

What "execute" means per action type (all simulated, all logged as an
`effect` event with "simulated" shown in the UI):

| Action | Effect |
|---|---|
| `CONTACT_CUSTOMER` | Message marked sent on the chosen channel; case goes to `WAITING_EXTERNAL` with a next check time. |
| `UPDATE_ETA` / `CHANGE_PROMISE` | New ETA or promise stored as our own record, shown beside the original dataset window (the dataset is never changed). |
| `BOOK_RECOVERY` / `BOOK_TRAVEL` | Mock booking with a fictional reference; the earlier quote stays a quote. |
| `APPROVE_EXPENSE` | Expense marked approved (not paid). |
| `CLEAR_TO_CONTINUE` | Driver gets the operator-approved instruction, attributed to the operator. |
| `REASSIGN_DRIVER` | Out of scope for the demo; show as "handed to dispatch". |

After every decision the card is replaced by one line in plain words: **what
happens next, who does it, and when we check again.**

If the order changes while a proposal waits (new message, new telemetry that
contradicts it), the card shows "Facts changed since this was drafted" and
offers a refresh. This is nice to have.

### 4.2c Contracts between streams (agreed; change only after telling the team)

**Driver and site channel (used by chat UI, voice and the simulated driver):**

```
POST /api/channels/driver/messages
  body: { orderRef: "CD-420584", driverId: "drv-042", text: string,
          mode: "chat" | "voice", photoIds?: string[] }
  response: text/event-stream
    event: text_delta  data: { text }
    event: done        data: { caseId, replyEventId }
    event: error       data: { message }

POST /api/channels/site/messages       same shape with siteContactId instead of driverId
POST /api/channels/photos              multipart upload -> { photoId } (stored via lib/object-store.ts)
GET  /api/channels/driver/:driverId/feed?since=ISO   -> agent-initiated messages for the driver app
```

- `mode: "voice"` makes the agent answer in 1–2 short spoken sentences, with
  no lists or markdown.
- The voice code only owns the browser side: capturing speech, transcribing
  it, POSTing the text, and speaking the streamed reply. It never calls
  Claude directly.
- Agent-initiated messages (the proactive trigger) reach the driver app by
  polling `feed` every 2 s. In voice mode, an incoming agent message rings the
  call screen.

**Live updates:** operator pages poll `GET /api/cases?since=` and
`GET /api/cases/:id?since=` every 2–3 s. Only agent replies stream.

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

- **GPS:** for every `IN_TRANSIT` order, place the car along its route
  (pickup city → origin ferry terminal → destination terminal → delivery city
  when there is a ferry), driven by the last tracking observation's
  `progress_fraction` and the sim clock. Never draw a straight line across the
  sea. Road shapes can be fetched once from a public routing service at build
  time and committed as JSON in `knowledge/routes/`; a polyline through
  terminals is the fallback. Stored in `cr_telemetry` with `simulated: true`. Some orders go
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
- **Dashboard photo:** a fictional dashboard image for scenario A (flashing
  check-engine light, reduced-power message), drawn as SVG and rendered to PNG,
  or generated. Stored in `public/sim/`. The driver app's "send photo" can pick
  it in demo mode. It must be readable by Claude's vision; test it.
- **Background "handled by agent" cases:** `npm run sim:seed-routine` runs the
  real agent on 4–6 scripted routine driver questions on quiet moving orders
  and keeps the results. The queue's "Handled by the agent" section then holds
  genuine traces, not fake rows. Reset keeps or drops them by flag.

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
- The live demo runs the driver app in a second window on the same laptop
  (`localhost` counts as a secure context, so the mic works). A phone over
  the local network would need HTTPS, which we are not doing.
- Voice uses the channel contract in 4.2c and nothing else.

### 4.7 Control room UI

Design rules (judged as "taste", 30%): readable text, calm spacing, one
glance tells what is wrong and what to do, sensible empty and loading
states, works with hundreds of orders. Keep Bahn's birch / asphalt / sand
palette and the starter fonts. All colours are CSS tokens with a dark theme
(`prefers-color-scheme` plus a manual toggle saved per browser).

- **Needs you (home).** A short list of cases with status `NEEDS_DECISION`
  (then `AGENT_WORKING`, then `WAITING_EXTERNAL`). Each row: car + reference,
  one-line "what happened", the decision waiting, urgency, age, who's on it
  (agent or person). Below: "Handled by the agent today (n)" collapsed. The
  queue holds only our road and driver cases. One quiet line at the bottom
  says "n other orders need a person (readiness, dispatch, documents)" and
  links to the board. Search stays.
- **Case / order page.** At the top, the decision card: title, recommendation,
  "what changes if you approve" (before → after), drafted message (editable),
  source chips, and the decision buttons from section 4.2b: Approve, Edit and
  approve, Reject, I'll handle it (then log the outcome), and Tell the agent
  instead. After deciding: a "what happens next" line and the timeline
  updates. Then: the timeline (merged, labelled by
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
cp .env.example .env          # add OPENROUTER_API_KEY
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
OPENROUTER_API_KEY=
AGENT_MODEL=anthropic/claude-sonnet-5.5     # switch to anthropic/claude-opus-5.5 for the demo
SIM_DRIVER_MODEL=anthropic/claude-haiku-5.5
AGENT_EFFORT_FAST=low
AGENT_EFFORT_DEEP=medium
SIM_NOW=2026-10-21T09:00:00Z
SIM_DRIVER_ENABLED=true
```

Remove the unused `ANTHROPIC_API_KEY` line from `.env.example`.

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
| A. Agent | Cloud instance 1 | `lib/agent/`, `rulebook/`, `knowledge/` (except `routes/`), `app/api/agent/`, `app/api/cases/`, `app/api/channels/` (server side of 4.2c) | M0 contract, loop, tools, gates, triggers, decisions, prompts, playbooks, DTC base, traces, gating tests |
| B. Control room | Cloud instance 2 | `app/page.tsx`, `app/orders/`, `app/map/`, `app/agent/`, `app/components/`, `globals.css`, `lib/present/` | Queue, decision card, timeline, ask-the-agent box, map, agent page, dark mode |
| C. Driver app and simulation | Cloud instance 3 | `app/driver/` (except `voice/`), `app/site/`, `app/demo/`, `lib/sim/`, `app/api/sim/`, `knowledge/routes/`, `public/sim/` | Driver app shell, site chat, OBD/GPS sim, scenarios, simulated driver, dashboard photo, routine seed |
| V. Voice | Teammate | `app/driver/voice/`, `lib/voice/` | Call screen, speech-to-text, text-to-speech, `VoiceProvider`, against the 4.2c contract only |
| Plan and integration | RoopeS + local Claude Code | `PLAN.md`, `PROCESS.md`, `README.md` | Plan, contract changes, review and integration, demo script, video, write-up |

Start order: instance 1 pushes the M0 contract (`lib/cr/`) and the channel
route stubs (4.2c, returning a canned reply) **first**. Instances 2 and 3 and
voice build against the stubs, so nobody waits for the real agent. Until the
contract lands, instance 2 can do work that does not need it (tokens, dark
mode, queue and map layout with placeholder data), and instance 3 likewise
(GPS/OBD generators, route shapes, dashboard photo).

Git: branch per stream (`agent/*`, `ui/*`, `sim/*`), small PRs into `main`,
pull often. Do not commit `.env`.

---

## 7. Milestones and acceptance

Times are UTC targets.

**M0 Foundation (first ~1 h).** Starter runs; `cr_*` tables pushed; contract
types committed; tokens and dark mode skeleton; `PROCESS.md` started.
*Done when:* app runs, `cr_` tables exist, smoke passes.

**M1 Vertical slice, chat only (Sat evening).** Scenario A end to end with no
polish: trigger warning light → agent contacts the driver first → driver
chats → agent asks, looks up, gives the safety instruction, proposes "call
dealer" → operator picks "I'll handle it" and logs the outcome → agent
continues → timeline shows each decision and the next step.
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

**Live judging, 13:10–15:15 UTC Sun.** Partners meet each team for a 5–10
minute demo and discussion, on our laptop. Needs: `/demo` reset that brings
the app back to a clean start in one click; a written run sheet (who clicks,
who talks, who plays the driver); two full rehearsals before 12:30; the chat
path ready if the mic or room noise fails; the video ready to play as the last
fallback.

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
- [ ] Live demo run sheet, rehearsed twice.

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
