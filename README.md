# Road Desk

An operations control room for Bahn's Car Delivery Control Room challenge,
Prompt Operations Hackathon, 24–25 October 2026. Road Desk puts human decisions,
agent work and external follow-ups in one queue across the 100 fictional orders.
Its specialist road-support agent gathers evidence, handles routine questions
and prepares approval-gated decisions.

**Submission deadline: Sun 25 Oct, 13:00 UTC.**

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

Open http://localhost:3000. Add `OPENROUTER_API_KEY` to `starter/.env` to use the
real agent and voice interviewer. The model names and effort settings are in
`.env.example`. Without a key, the app remains usable and agent cases hand over
to a person with an explanation; that fallback is not a real-model demonstration.

`db:push` includes the original, road-support and voice tables. `db:seed`
replaces only the challenge snapshot. Use the demo reset to clear added cases,
effects and calls. Local Postgres uses port 5438; the attachment store uses 9009
and its console uses 9010. If needed, change the ports in `starter/compose.yaml`
and the matching values in `starter/.env`.

For a production build, run `npm run build`, then `npm start` from `starter/`.

## Try the functional core

- `/`: one attention queue, split into decisions, agent work and waiting.
- `/orders/ord-00584`: scenario A's Bentley, with sourced decisions, merged
  timeline, telemetry, photos and driver-call transcripts.
- `/driver?driver=drv-042`: the matching driver window, with chat, photos and
  Call/Answer controls. Use the same laptop for the microphone on localhost.
- `/demo`: presenter controls, scenario starts, simulated clock jumps and reset.
- `/site`: scoped site chat; `/board`: every order; `/map`: simulated positions;
  `/agent`: rulebook, autonomy and activity.

For the headline scenario, open `/demo` and the driver window. Leave the
simulated driver off when a person plays the driver. Run **A. Fresh warning
light**: the car reports a simulated fault and the agent contacts the driver.
Reply by chat or answer the call. The agent collects evidence and brings the
operator a decision. Choose **I'll handle it**, then log the dealer's answer;
the agent continues through the same approval gates.

Scenario C demonstrates a routine keys question. Scenario D exercises site
scoping. Scenario F leaves the driver silent: advance the clock beyond the
reply deadlines to see one reminder and then a human handover. Operator pages
poll the case timer endpoint; the demo panel drives simulated telemetry.

Voice uses Chrome's speech recognition by default. `VOICE_PROVIDER=browser`
uses browser speech synthesis instead of hosted speech. Hosted voice requires
the configured OpenRouter speech models. Chat remains available independently.

## What is real and what is simulated

The configured language models run real tool-use loops. Driver voice has a
separate interviewer and transcript of record; urgent and ended calls feed the
road agent, which cites individual turns. The operator can approve, reject,
instruct, handle a task externally and log its outcome.

All orders, people, documents, messages, GPS/OBD samples, recovery providers,
travel quotes, bookings and action effects are fictional. No real customer
messages, bookings or payments are sent. A quote stays a quote; an operator's
approval alone does not establish customer agreement to a new promise.
Executed effects overlay the unchanged dataset and retain their evidence.

This is a local prototype with role selection, not a production identity or
dispatch system. Travel decisions preserve the exact recorded quote, route,
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
`npm run voice:test` is a separate real-model interview harness.

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
