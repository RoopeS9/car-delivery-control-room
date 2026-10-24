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
