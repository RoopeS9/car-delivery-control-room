# bahn-map: make the map the home of the Bahn control room, as a maritime viewer

## Why
Hackathon (Bahn car-delivery control room), deadline **Sun 25 Oct 13:00 UTC = 16:00 EEST**. The owner's direction: the home screen is a
full-screen map that one or two operators watch all day on a good monitor, "full of life", styled like a maritime traffic viewer.
A sidebar that never gets cluttered. Clicking a node surfaces everything the operator might need about that delivery. Agent work
(robo-calls, checks) does NOT ping the operator; it shows up as history on the node. The old ticket-style queue stays reachable but is not home.
This is a concept that will be iterated live with the owner; ship something visible early, then refine.

## Where
- Repo clone: `/home/assistant/projects/bahn-control-room`, branch **`ux/map-home`** (already created). Work only on this branch, commit often, clear messages. Local only: never push, never add a remote, never open a PR. This clone on tuf is the working copy.
- App: `starter/` (Next.js 16, Postgres on 127.0.0.1:5438 in docker `bahn-pg`, attachments on 9009 in `bahn-attachments`). Read `starter/AGENTS.md`: this Next.js differs from what you remember.
- Served live: user unit `bahn-control-room.service` runs the **built** app on 127.0.0.1:8797; Caddy serves it at https://bahn.hopeajahti.lol (Cloudflare may still 525; loopback works: `curl -k --resolve bahn.hopeajahti.lol:443:127.0.0.1 https://bahn.hopeajahti.lol/`).
  Deploy loop: `cd starter && npm run build && XDG_RUNTIME_DIR=/run/user/1001 systemctl --user restart bahn-control-room`. For fast iteration run `npx next dev -p 8798 -H 127.0.0.1` on the side; the public URL always serves the last successful build.
  Keep passing: `npm run typecheck`, `npm run build`, `APP_URL=http://127.0.0.1:8797 npm run smoke`.
- Read first: `PARTICIPANT-BRIEF.md` (judging: taste 30%, control room 40%), `OPERATIONS-CONTEXT.md`, `starter/app/components/map-screen.tsx` + `starter/lib/present/map.ts` (the existing Leaflet map), `starter/lib/present/attention.ts` (what needs a person), `starter/lib/sim/` (simulated positions and routes; `knowledge/routes/` shapes), `starter/lib/cr/` (cases, calls, telemetry tables).
- Vocabulary to use for labels and source chips: `/home/assistant/projects/road-dossier/docs/DOSSIER.md` (information classes, evidence strength ladder: a quote is not a booking, a booking is not a gate scan, a message is a claim) and `/home/assistant/projects/road-dossier/docs/LIFECYCLE.md` (phases, what goes wrong at each). You do not need to import that package; mirror its words.

## Goal, in priority order (commit + deploy after each)
1. **Map is `/`.** Full-viewport map, the old queue moves to `/queue` (keep `/board`, `/orders/[id]` etc. working, keep a quiet top-right nav). Dark maritime-chart look by default: muted sea and land, thin route lines as tracks (pickup -> terminal -> terminal -> delivery; never a straight line across the sea), vessel-style markers with heading for moving cars, short trails, terminal/port markers, dealers and yards as small port symbols. Clustering or decluttering at low zoom. A thin instrument rail: simulated clock (the app has SIM_NOW), counts (moving / booked / at pickup / delivered today), nothing else. Every position labelled simulated. Light theme must still work (tokens exist in globals.css).
2. **Sidebar, uncluttered.** Default content = only what needs a person right now, fleet-wide, as short cards: what happened, the decision waiting, age. Derive from the existing attention/cases logic; do not invent new business rules. Collapsed below: "handled by the agent today (n)". Empty state that looks designed. Hundreds of orders must not make it long.
3. **Node panel on click.** For the selected delivery: car, reference, driver, customer; **journey progress** (points with done/planned/unverified, where it is now, ETA vs promise, ferry booking with cutoff and whether check-in is confirmed by a gate scan); **calls and agent work** as a chronological list (the `cr_calls`/`cr_call_turns` transcripts of record exist; agent events in `cr_events`); facts with source chips using the strength words (claim / booked / verified / simulated, with who said it and when); link to the full order page. The panel must stay readable: sections fold, newest first.
4. **Life.** Markers move with the simulator while the page is open (there is already a LiveRefresh/poll pattern); stale positions hollow with "last seen"; a subtle pulse on a node whose state just changed. No sound.
5. If time remains: hover cards, keyboard navigation between nodes, a fleet "timeline scrubber" on the sim clock.

## Rules
- Do not restructure Roope's agent, voice or sim logic (`lib/agent`, `lib/voice`, `lib/sim` internals). Read them; add presenters in `lib/present/` and UI in `app/`. One new map library at most (MapLibre GL is fine if Leaflet limits you; keep attribution).
- Not a developer tool: no raw JSON, ids only as references (CD-xxxxxx), plain words, calm spacing, readable at 100% zoom on a 27" monitor.
- Data honesty on every label: simulated GPS says so; a quote is not a booking; an alert is a signal.
- Never touch: Caddy, `/home/assistant/projects/duplex`, the GPU, mpv, niksa, ports other than 8797/8798.
- Report `/home/assistant/workers/<your id>/report.md` in three parts (done+how verified, unverified, got wrong). **Interim report at 21:30 EEST** and a line whenever a new build is live. Include screenshots (headless Chromium via `node` + playwright is available under `~/olc/tools/playwright/`) in the worker dir.
