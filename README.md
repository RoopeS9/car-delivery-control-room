# Road Desk

An operations control room for Bahn's Car Delivery Control Room challenge,
Prompt Operations Hackathon, 24–25 October 2026. Road Desk puts human decisions,
agent work and external follow-ups in one queue across the 100 fictional orders.
Its specialist road-support agent gathers evidence, handles routine questions
and prepares approval-gated decisions.

**Submission deadline: Sun 25 Oct, 13:00 UTC.**

## What it looks like

Scenario A with the real agent: a Bentley's dongle reports a flashing engine light on a German motorway.

| | |
|---|---|
| ![Needs you: the agent's card first, then what the records raise](screenshots/queue.png) | ![The order page with the agent's decision card and its draft to the dealer](screenshots/order-card.png) |
| **Needs you.** The agent's card leads; below it, what the records raise for a person. Signals without a person waiting sit under "Worth a look". | **The order.** One card: what happened, the recommendation, the draft to the dealer (not sent), and Send, Edit, I'll handle it, Tell the agent instead or Reject. |
| ![The map of every delivery](screenshots/map.png) | ![The driver's phone: safety line first, then the agent's questions](screenshots/driver.png) |
| **The map.** Every delivery on its route; red needs a person, amber is worth a look. | **The driver's phone.** The stop instruction went out before the agent's first word, in the driver's home language with English below; the agent then writes in the driver's language. |

## Run from a fresh clone

You need Node.js 24 or newer, npm and Docker with Compose.

```sh
cd starter
cp .env.example .env
npm ci
docker compose up -d --wait
npm run db:push
npm run db:seed
npm run attachments:seed
npm run dev
```

In a second terminal, start the call service (order dossiers, the agent's
robo-calls, the inbox's suggested replies and simulated delivery runs) on port
8799. The app works without it, but those features read as unavailable:

```sh
cd dossier
cp .env.example .env   # add OPENROUTER_API_KEY; APP_URL is the app (port 3000)
npm ci
npm run serve
```

Open http://localhost:3000. Add `OPENROUTER_API_KEY` to `starter/.env` to use the
real agent. The models, all through OpenRouter, are set in `starter/.env.example`:

| Job | Default | Why |
|---|---|---|
| The agent (`AGENT_MODEL`) | `deepseek/deepseek-v4-pro` | Every traced run and the business case use it; `anthropic/claude-sonnet-5.5` is stronger at about ten times the cost |
| Safety screen (`DRIVABILITY_MODEL`) | `deepseek/deepseek-v4-flash` | One word per message, reasoning off, fast |
| Photo reader (`VISION_MODEL`), simulated driver (`SIM_DRIVER_MODEL`) | `anthropic/claude-haiku-5.5` | Reads images; plays the driver in simulations |

Without a key, the app remains usable and agent cases hand over to a person with
an explanation; that fallback is not a real-model demonstration.

`db:push` includes the original, road-support and voice tables. `db:seed`
replaces only the challenge snapshot. Use the demo reset to clear added cases,
effects and calls. Local Postgres uses port 5438; the attachment store uses 9009
and its console uses 9010. If needed, change the ports in `starter/compose.yaml`
and the matching values in `starter/.env`.

For a production build, run `npm run build`, then `npm start` from `starter/`.

## Try the functional core

- `/`: the map with simulated positions and the orders that need a person.
- `/queue` (Needs you): one attention queue, split into decisions, agent work
  and waiting.
- `/orders/ord-00584` (or `/orders/CD-420584`): scenario A's Bentley, with
  sourced decisions, merged timeline, telemetry, photos and driver-call
  transcripts.
- `/driver?driver=drv-042`: the matching driver window, with chat, photos,
  the delivery steps and Call/Answer controls. Use the same laptop for the
  microphone on localhost.
- `/demo`: presenter controls, scenario starts, simulated clock jumps, the
  customer's emails and reset.
- `/dealer`: the pickup desk (booked collections, readiness calls); `/site`:
  scoped site chat; `/inbox`: every conversation, with suggested replies;
  `/board`: every order; `/agent`: rulebook, autonomy and activity.

`RUN-SHEET.md` is the live demo, click by click.

For the headline scenario, open `/demo` and the driver window. Leave the
simulated driver off when a person plays the driver. Run **A. Fresh warning
light**: the car reports a simulated fault and the agent contacts the driver.
Reply by chat or answer the call. The agent collects evidence and brings the
operator a decision. Choose **I'll handle it**, then log the dealer's answer;
the agent continues through the same approval gates.

Scenario C demonstrates a routine keys question. Scenario D exercises site
scoping. Scenario F leaves the driver silent: advance the clock beyond the
reply deadlines to see one reminder and then a human handover. Scenario G is a
code that is usually not critical: the agent explains it and asks, an operator
clears the driver.

Scenario H walks a whole delivery. The clock moves to Kasper Darevik's pickup
slot in Stockholm; in his phone he reports each step (at the pickup, car and
keys collected, checked in for the ferry, at the delivery address, handed over
to a named receiver). Running H again after a step moves the clock to the next
step's time in the records: an hour before the ferry's check-in closes, then
the delivery window four days later (refused while other cases are open, whose
timers would fire on the way). At the collection and the handover he can add photos of
the car (his own, or labelled demo pictures); they become the order's pickup or
delivery photo proof. The map, the order (its assignment steps, evidence and
timeline), the board and the pickup desk on `/dealer` follow every step, and
the handover brings operations the customer's delivery confirmation to approve.
The steps are our own events laid over the unchanged snapshot; reset removes
them.

Scenario B can go on to a new date: tell the agent the owner's plan and ask for
a new window; approve the proposal card (the customer gets the message), then
send the customer's agreement from `/demo`. The order's **Delivery promise**
block quotes their email; **Customer agreed** records it, and only then does
the promise move.

The customer's side is messages only. On `/demo`, **The customer writes** sends
a simulated email from the paying customer of any order; it lands on the order's
case and conversations, and the agent drafts the answer as a card a person
approves. A customer-owned delivery desk can also write through `/site`. Operator pages
poll telemetry and case timers, so the world keeps moving without the driver
window or demo panel. Reset refuses active calls or in-flight work before
clearing anything.

Live phone calls are not in this repository. The Road Desk line runs on a separate
phone-line server (speech to text, the call service's dossier as the model's context,
ElevenLabs for the voice; see `BAHN-CONCEPT.md`), reached through a proxy at `/line/*`.
Without it the call screens say the line is unavailable, and the driver uses chat.

## What is real and what is simulated

The configured language models run real tool-use loops. A live call on the Road
Desk line is stored on the order with its transcript, claims that cite individual
turns, and a review; it does not start an agent turn. The operator can approve,
reject, instruct, handle a task externally and log its outcome.

The simulation keeps running on its own: a heartbeat in the server (every 20 s,
`HEARTBEAT=off` stops it) writes the telemetry that fell due, runs the case
timers, and lets the **autopilot** place the agent's own check-up calls through
the call service: a quiet phone on a moving car, a ferry check-in closing, a
pickup slot with unverified access, a driver who has not started. Every call
leaves two lines on the order's timeline ("Calling Rafael (position check): no
position from the driver's phone since 02:12", then what was said and the
outcome), and what a call finds that needs a decision goes to the agent as a
follow-up. The demo's scenario orders are left to the presenter; the switch and
the list of what is due are on `/demo`.

All orders, people, documents, messages, GPS/OBD samples, recovery providers,
travel quotes, bookings and action effects are fictional. No real customer
messages, bookings or payments are sent. A quote stays a quote; an operator's
approval alone does not establish customer agreement to a new promise.
Executed effects overlay the unchanged dataset and retain their evidence.

This is a local prototype with role selection, not a production identity or
dispatch system. Its work coordination and booking locks assume one server
process. Travel decisions preserve the exact recorded quote, route,
sailing times, check-in cutoff, numeric cost and reservation being replaced.
Only a confirmed simulated booking replaces the current reservation. An
uncertain attempt keeps the old booking current until it is reconciled;
original and superseded records remain in the history.

## Checks

From `starter/`:

```sh
npm run typecheck
npm run build
APP_URL=http://localhost:3000 npm run smoke
APP_URL=http://localhost:3000 npm run attachments:smoke
```

The database tests need a disposable seeded database. They exercise approval
gates, customer agreement, stale decisions, duplicate actions, voice handover,
follow-up escalation, simulation and presentation. Gate tests reset autonomy
settings, so keep them separate from a prepared demo:

```sh
docker compose exec db createdb -U controlroom controlroom_test
DATABASE_URL=postgres://controlroom:controlroom@localhost:5438/controlroom_test npm run db:push
DATABASE_URL=postgres://controlroom:controlroom@localhost:5438/controlroom_test npm run db:seed
DATABASE_URL=postgres://controlroom:controlroom@localhost:5438/controlroom_test npm test
```

`npm run agent:scenario-a` and `npm run sim:seed-routine` use a real model and
consume API credit. Run them against disposable demo data; scenario A clears
the added road-support records. Agent traces are under `starter/traces/`.

`APP_URL=http://localhost:3000 npm run e2e:roles` plays the driver, the pickup
desk, the customer and the operator through scenarios A, B, C, D, F, G, H and a
customer email against a running app with the real model (a few cents on
DeepSeek), checking what the records must show rather than the wording. It
resets the demo before and between stories; run it on demo data. Name stories
to run only some: `npm run e2e:roles -- B H`.

## Repository guide

- `PARTICIPANT-BRIEF.md`: what to build and how it is judged.
- `OPERATIONS-CONTEXT.md`: the fictional operations and evidence boundaries.
- `PLAN.md`: working product and integration contracts.
- `PROCESS.md`: coding-agent suggestions, checks and decisions.
- `dataset/`: synthetic source records; `dataset/SCHEMA.md` explains the links.
- `attachments/`: 58 synthetic documents, receipts and photos.
- `starter/`: the integrated Next.js, TypeScript, Drizzle and Postgres app.
- `mockups/`: original starter screenshots, not the current product.

The app keeps source records in the starter tables, road-support cases and
effects in `lib/cr/`, the gated tool loop in `lib/agent/`, driver calls in
`lib/voice/`, simulation in `lib/sim/` and shared display projections in
`lib/present/`. `python3 check_packet.py` checks the original packet integrity.
