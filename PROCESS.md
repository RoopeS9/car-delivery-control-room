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
