# Brief: the map timelapse for the demo video

You are a coding agent working on the Road Desk repository, on a branch called `timelapse` that starts from the latest `roope`.
Read this whole file first, then `README.md`, `OVERVIEW.md`, `PLAN.md` §2 (the rules), and `video/SCRIPT.md` scene 4 (where
the film uses your work). Another session is finishing README work on `roope`; do not touch the files it owns (see
“Do not touch”).

## Why

The team is filming a 2–3 minute video. In scene 4 (about 15 seconds) the film shows the map of every delivery while
problems pop up on it and go away again as agents and people handle them. We need that picture to be **good, honest and
easy to screen-record**. The map already exists at `/`; what does not exist is a way to play a made-up busy day on it,
fast.

What exists today: the map (`starter/app/components/chart/chart-home.tsx`) has a **Replay** scrubber that moves cars between
stored phone positions (`starter/app/api/chart/replay/route.ts`). It shows positions only, no problems appearing or clearing,
and it is a manual slider. Build the timelapse as new code beside it; do not change how Replay works.

## What to build

A hidden page, **`/timelapse`**, that plays a deterministic, illustrative day on the real map component, about **15 seconds** long
by default, and can be screen-recorded cleanly.

**On screen**

- The same map as `/` (same tiles, same car markers and routes, the existing visual language), full bleed.
- A clock, top left, running quickly from the morning to the evening of the simulated day (for example 09:00 to 21:00 UTC,
  21 Oct), always labelled **“simulated”**.
- A counter, top left under the clock: **“N need a person”**, going up and down as the day plays.
- Two small tallies that only count events actually shown in this run: **“Agent handled N”** and **“A person decided N”**.
- A small legend: red pulse = needs a person, teal = the agent is working, a green tick = cleared by the agent, a person
  icon = cleared by a person.
- A permanent small caption in a corner: **“Illustrative timelapse of simulated events.”** It is part of the film’s honesty
  and must stay on screen for the whole run. Do not add percentages or any claim like “80% handled by agents”.

**What happens**

- About 24 events, spread over the run. Each event is a problem at a car’s position that appears as a red pulse, goes
  **teal while the agent works** (1–3 seconds of film), and then either **clears by the agent** (green tick, fades) or becomes
  **needs a person** (stays red 2–4 seconds), and then clears **by a person** (green, person icon, fades).
- Most events should be cleared by the agent; a few should need a person. The count of “need a person” should rise to a
  visible peak (6–8 at once) around the middle and end low on a calm final frame, which holds for about 1.5 seconds.
- Cars keep moving along their real routes the whole time.
- Four events are the **named demo scenarios**, so the film matches the rest of the video: the warning light (scenario A, the
  Bentley, order `ord-00584`), the routine keys question (C, handled by the agent), the silent driver (F, ends with a person),
  and the light that is usually not critical (G, where the agent only names the system and a person decides). Look up the
  orders and driver names in `starter/lib/sim/scenarios.ts`. The other events can be drawn from the dataset’s own
  open items for other orders (alerts, quiet phones, a missed connection, a late pickup) so the day feels full; read how
  `starter/lib/present/attention.ts` and `queue.ts` describe them and use the same plain wording, never record ids.

**How it is built**

- A pure function in `starter/lib/present/timelapse.ts` takes the orders and a seed and returns the storyline: a list of
  events with a start time, an agent-working period, an outcome (cleared by the agent or by a person) and an end time. Same
  seed, same storyline, always. Default seed fixed in code.
- A client component that drives the map from that storyline and a clock that runs `duration` seconds for the whole day.
- Query parameters: `duration` (seconds, default 15), `seed`, `clean=1` (hides the sidebar and role switcher so a recording
  has no app chrome), `loop=1` (replays after the calm frame), `start=0` (wait for a click instead of starting at once).
  Default with no parameters must work and look right.
- Cars: use the stored phone positions (`/api/chart/replay?at=`) and the routes the map already draws. If positions between
  stored fixes need smoothing, interpolate along the route; say so in a code comment.
- **Read-only.** No writes to the database, no model calls, no API key needed, no network except map tiles. It must work on a
  freshly seeded database with the app running and nothing else.
- Light and dark theme must both look right. Text must be readable at 1080p when recorded (nothing under 18 px on a
  1920×1080 recording). The operator UI rule applies: no raw ids, JSON or capitalised system states.
- A discreet link to `/timelapse` on the `/demo` page (“Timelapse for the video”), nowhere else; it is not part of the
  product navigation.

## Recording helper

Add `starter/scripts/record-timelapse.ts` (npm script `video:timelapse`) that uses Playwright (it is pre-installed; do not
install anything) to open `/timelapse?clean=1&duration=15` at 1920×1080, record the page video, and convert it to an MP4 with
`ffmpeg` (installed). Write to `video/assets/timelapse.mp4` and also save three PNG stills (a quiet start, the peak, the calm
end) to `video/assets/`. Keep the MP4 under 15 MB; if it is larger, lower the bitrate. The team will probably re-record
the page themselves for quality; this file is the fallback.

## Tests and checks

Unit tests for the pure function (put them next to it, in the same style as `lib/present/*.test.ts`): same seed gives the same
storyline; every event ends after it starts; the “need a person” count never goes below zero and peaks as specified; every
event refers to an order that exists; the four named scenarios are present; the tallies equal the number of events shown.
Before you push: `npm run typecheck`, `npm test` against the test database (see README, “Checks”), `npm run build`, and open
the page in headless Chromium and look at the stills yourself.

## Do not touch

`starter/lib/agent/**`, `starter/lib/cr/**`, the gate, the drivability screen, existing tests, `README.md` and `PLAN.md`
(another session owns them right now), and the data files. No new dependencies. No change to how `/` or Replay behaves.
Do not merge into `roope` and do not push to it: push only `timelapse`.

## Process log

Append one entry to `PROCESS.md` in the format at the top of that file (asked, got, checked, changed or rejected). The judges
read it. Say what you rejected, for example if you first tried a canvas overlay and changed approach.

## Time

You have about 75 minutes. The team needs a first working version by **12:00 Finnish time (10:00 UTC)** to record a rough take,
and the feature freeze is **13:00 Finnish time (11:00 UTC)**. A simple version that is honest and clean beats a rich one that
is late. If you run out of time, deliver what works and say what is missing.

## Report back

Reply with: the branch and last commit; how to open the page (the exact URL with parameters); what the film shows, in
three lines; the paths of the MP4 and stills; test and build results (the real output, not a summary); anything you chose
not to do and why; and anything in the brief that was wrong or impossible.
