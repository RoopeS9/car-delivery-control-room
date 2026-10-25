# Road Desk: review from Bahn operations and the CTO

Reviewed on branch `roope` (HEAD `dd7d925`), 25 Oct 2026, against the brief (`PARTICIPANT-BRIEF.md`), the
team's own claims (`README.md`, `OVERVIEW.md`, `BUSINESS-CASE.md`, `RUN-SHEET.md`, `PROCESS.md`), the code under
`starter/` and `dossier/`, the committed agent traces (`starter/traces/e2e-roles-2026-10-25T01-24/`), and the running
app (GET requests and screenshots only; nothing was changed or run). Line numbers are as of this commit.

## 1. Verdict

Yes, we would pilot this, but as a **shadow pilot on one lane** (German imports, on-the-road incidents), with the agent
reading real messages and drafting cards while a person still does everything, and only after the conditions below.
The core is better than a hackathon usually produces: the approval gate is in code, not prose; nothing reaches a
customer without a person; a quote never becomes a booking; approvals are idempotent and re-checked against current
facts; and the agent's behaviour on the committed traces is calm and mostly right. The failure handling (card when
the model fails, "I'll take it from here") is the kind of thing we would otherwise have to ask for.

Conditions for a pilot with real drivers: (1) authentication on every route and a per-person identity on every
decision; (2) a timer process that does not depend on an operator's browser tab being open; (3) the stop instruction
on a STOP_NOW code sent by code before the model is consulted, and screened in the driver's language; (4) a push/SMS
alert path for critical cards at night; (5) an EU-hosted model or pseudonymisation plus a DPA before any real name or
position leaves our network (DeepSeek via OpenRouter is not acceptable for real data); (6) the OBD dongle removed from
the critical path, because our cars are customers' used cars with no dongle in them.

## 2. Findings, ranked by how much they matter to Bahn

Severity: **blocker** (for any pilot with real drivers), **major**, **minor**, **polish**. Effort: S (hours), M (days), L (weeks).

### R1 · blocker · security / audit · No authentication anywhere; any client can decide, impersonate a driver, or wipe the records
**What:** There is no `middleware.ts`, no session, no token on any route. `decided_by` is a free string from the
browser (`starter/app/api/cases/[id]/proposals/[proposalId]/decide/route.ts:9-20`), hard-coded to `ops-shift`
(`starter/app/components/case/operator.ts:3`, "No login in this prototype", also `lib/cr/types.ts` DecisionRequest).
A driver is whoever sends `driverId` (`app/api/channels/driver/messages/route.ts`, `lib/agent/triggers.ts:79-91`
only checks the driver is on an assignment); `GET /api/channels/driver/<id>/feed` returns any driver's thread
(verified with a GET). `POST /api/sim/scenarios/reset` deletes every case, effect, telemetry and call
(`lib/sim/routine.ts:56-74`), `POST /api/sim/clock` moves the clock, `POST /api/line/link` writes an arbitrary
transcript on any order, `POST /api/agent/ask` costs a model call per request.
**Why it matters:** Every approval in the audit trail says "Shift lead". We cannot defend a decision to a dealer or
an insurer with that. On a network with 1,500 freelancers, "anyone can send 'I'm safe' as any driver" is a safety hole.
**Fix:** Put the app behind SSO (Entra/Google) with a signed session; record the real user id on cases, proposals,
effects and events; give drivers and sites per-order magic links or app tokens checked server-side; delete or
gate `/api/sim/*` and `/demo` behind an `ADMIN` role and a `DEMO_MODE` flag. Effort: M.

### R2 · blocker · operations at night · Timers only run while an operator's tab is open and visible
**What:** "Timers without workers" (`starter/lib/agent/tick.ts:1-11`): reminders to a silent driver, the escalation
card, the 3-minute watchdog and the telemetry sync all run from `POST /api/cases/tick`, which only operator pages
call every 2.5 s, and only while `document.visibilityState === "visible"` (`app/components/live-refresh.tsx:38-47`).
The driver app and demo panel tick `/api/sim/tick` only.
**Why:** At 03:00 the one operator locks the screen for a coffee; a driver who was told to stop and then went silent
(scenario F) gets no reminder and no card until the operator comes back and looks. The queue will look quiet
precisely when nobody is watching.
**Fix:** Move `tick()` into a server-side scheduler (a `setInterval` in `instrumentation.ts` for one instance; a cron
or queue worker with a DB advisory lock for more). Keep the client poll as a refresh only. Effort: S for one instance,
M for a worker.

### R3 · blocker · driver safety · The stop instruction waits for the language model
**What:** On a STOP_NOW code the fault handler opens a case and immediately starts a model turn
(`lib/agent/triggers.ts:224-262`); the fixed template is sent only when the model chooses the `safety_instruction`
tool. In trace A the template went out after five lookups (`traces/.../A/timeline.md`), in F after two. A model call
may take up to 120 s (`lib/agent/loop.ts:254`) and a turn up to 12 calls (`lib/agent/config.ts`); the RUN-SHEET admits
20–60 s a turn, 2 min at busy hours. Only when there is *no API key* does a canned stop line go out at once
(`loop.ts:62-67`).
**Why:** A flashing MIL on a Bentley at 111 km/h is a seconds problem. The right instruction is already known from
`knowledge/dtc.json` severity; it does not need a model.
**Fix:** In `handleTelemetryFault`, map severity → template deterministically and send it (and record it) before
`runTurn`; tell the model in the case notes what was already sent. Same for a driver message matching a small
STOP-NOW vocabulary. Effort: S.

### R4 · blocker · driver safety / language · Safety templates, clearance screen and sentence-dropping are English-only
**What:** The six safety templates are English (`lib/agent/drivability.ts:22-29`); the clearance regexes
(`drivability.ts:40-45, :70`), the "drop the sign-off" filter (`lib/agent/tools.ts:510`) and the second-chance
stop-instruction check (`drivability.ts:211`) are English; the prompt tells the agent to answer in the driver's
language (`lib/agent/prompts.ts:21`). So a Finnish, German or Danish driver gets "Please switch the engine off" in
English, and a German "du kannst ruhig weiterfahren" is caught only by the DeepSeek-flash classifier, with no pattern
layer and a fail-open when the classifier is down and the text has no English driving words (`drivability.ts:189-196`).
**Why:** Our drivers are across FI, DK, DE (and SE, EE in this dataset). The one rule the brief insists on ("never
tell a driver it is fine to keep driving") is enforced for English only.
**Fix:** Translate the templates (FI, SV, DE, DA, EN) and pick by the driver's language; add pattern lists per
language; make the classifier fail *closed* for every non-routine case regardless of vocabulary; add multilingual
cases to `drivability.test.ts`. Effort: M.

### R5 · blocker · privacy / compliance · Driver, customer and site personal data goes to DeepSeek via OpenRouter; traces persist it
**What:** The operator context sent to the model carries driver names, phone positions (lat/lng,
`lib/agent/context.ts:369-374`), VIN and plate (`:447-451`), site contact names and email handles (`:231-236`),
customer names (`:515-520`). The documented and traced model is `deepseek/deepseek-v4-pro` through OpenRouter
(`README.md:38-41`, every run in `starter/traces/`). Every run's full prompt and tool results are written to disk when
`AGENT_TRACE_DIR` is set (`loop.ts:587-603`) and committed under `starter/traces/`. The call service sends the
*whole* dossier (29 KB, incl. the customer record) as a system prompt for a phone call with a pickup desk
(`dossier/src/serve.ts` `/context`, verified by GET). Driver GPS is also shown to non-customer sites
(`context.ts:429`, `latest_driver_position`). No retention or deletion exists for `cr_telemetry`, `cr_events`
(which also hold photos as base64, see R21), traces or `dossier/data/out`.
**Why:** Location of a freelance driver is personal data; it crosses to a US router and a provider we do not
control. We need a lawful basis, a DPA, transfer safeguards, driver information and retention before a single real
message is processed.
**Fix:** Choose an EU-hosted endpoint (or Bedrock/Vertex EU) and pin it; pseudonymise names/handles in the model
context (map back on output); strip coordinates to place labels for site audiences; turn traces off outside dev;
define retention (e.g. telemetry 30 d, cases 2 y) with a nightly job; write the DPIA. Effort: M.

### R6 · major · fit to Bahn's reality · The headline trigger is an OBD dongle we do not have
**What:** Scenarios A, F, G and the telemetry trigger assume a dongle streaming codes (`lib/sim/sync.ts`,
`lib/sim/sim.test.ts` "only the scenario cars carry a dongle"). The brief's own story is a driver who *writes* in the
app after a warning light.
**Why:** We move customers' used cars; nobody fits a dongle. The path that matters is driver message/call + phone
GPS anomaly (stopped on a motorway, no position for 60 min). That path exists (`handleDriverMessage`, the night
harness's "breakdown-chat") but is secondary in the demo, the docs and the business case.
**Fix:** Make the inbound driver report the primary path in the run sheet and tests; derive "stopped on a
motorway" from phone GPS alone (speed 0 off a service area for N min → open a case, ask the driver); keep OBD as an
optional integration. Effort: S (re-prioritise) + M (GPS anomaly trigger).

### R7 · major · operations at night · No alerting outside the browser
**What:** A CRITICAL card is only a red row and a count badge (`app/components/app-frame.tsx`). No push, SMS, phone
or Slack hook exists anywhere in `starter/` or `dossier/`.
**Why:** One operator at night is not staring at the queue; today our alerts go to Slack and phones.
**Fix:** On `NEEDS_DECISION` with urgency CRITICAL/HIGH, and on "The agent couldn't finish", post to Slack and send an
SMS/push to the on-call phone, with escalation if not acknowledged in N minutes; make the queue show "acknowledged
by whom". Effort: S–M.

### R8 · major · queue clarity / alert fatigue · "Needs your decision" is 19 rows of which 1 has a card
**What:** Screenshot of `/queue`: 19 need your decision, 1 with the agent's card; 18 are dataset alerts, work items and
incidents up to 2 days old ("From the records"), ranked into the decide band when their tone is warn or better
(`lib/present/queue.ts:139-141, 162-168`). Below sit "22 more from the records with routine open items". The map badge
says 16, the queue 19, the board 16 (a known, deliberate mismatch, `PROCESS.md` "Need a person read 44…").
**Why:** The brief's first criterion is "only the orders that need a person, with just enough to decide". For the
records rows there is no decision, no recommended action and no way to clear them from the queue (no acknowledge,
no snooze, no owner change). A night operator will learn to ignore the red.
**Fix:** Split "Decide (card ready)" from "Look (records)"; let the agent run a cheap read-only pass over records rows
and either propose a card or park them with a reason; add acknowledge/snooze/assign on records rows; one count
everywhere. Effort: M.

### R9 · major · integration · Two agent stacks, two rulebooks, two stores
**What:** `starter/lib/agent` (Anthropic SDK over OpenRouter, rulebook in `starter/rulebook/`, gate in code, records in
Postgres) and `dossier/src` (raw chat-completions calls, `llm-call.ts:16`; its own rules in `context.ts`
`MUST_NOT_WORDS` and `reason.ts` `RULES`; its own review `review.ts`; calls and runs stored as JSON files in
`dossier/data/out/`, `serve.ts` `storeCall`) overlap on the same job (what needs a person, who may be called). The
inbox's suggested replies, the dealer desk calls and the delivery runs need the second service; the README says the app
"works without it" but those features then "read as unavailable".
**Why:** Two prompts can disagree about our rules; two stores mean two audit trails; `tools/deploy.sh` rsyncs the call
service while excluding its data. We would own two systems.
**Fix:** Keep the dossier's evidence ladder and brief builders as a library inside the app; store calls in
`cr_calls`; one rulebook rendered to both prompts; delete the HTTP seam. Effort: L.

### R10 · major · deployability · Not runnable outside one developer's box; voice is not in the repo
**What:** `tools/deploy.sh` is tied to `/home/assistant/...`, systemd user units and `docker exec bahn-pg`. No
Dockerfile for the app or call service; the live phone line (Whisper, DeepSeek, ElevenLabs) runs "outside this repo"
(`BAHN-CONCEPT.md`, `app/components/line/call-screen.tsx:11-16` "Caddy adds the auth"). Schema is `drizzle-kit push`
with no migration history. Two `.env` files hold the same single OpenRouter key (gitignored and never committed,
verified; rotate it anyway after a hackathon of sandboxes).
**Why:** We cannot stand this up in our cloud without the team, and "Call the driver" on the order page will do
nothing.
**Fix:** Dockerfiles + compose for app, call service, Postgres; drizzle migrations; a documented interface for the
phone line or drop the live-call button until it exists; separate keys per service with spend limits. Effort: M.

### R11 · major · integration · Everything outbound is a row in this app's own database
**What:** `ask_site` writes a `site_chat` event the site only sees on `/site` (`lib/agent/tools.ts:540-551`); sent
customer emails are `MESSAGE_SENT` effects (`lib/agent/gate.ts:495-506`); bookings go to `mockProviderBook`
(`lib/agent/mocks.ts`); nearby help and quotes are seeded fakes. Expected for the hackathon, but there is no adapter
boundary: the gate's `performEffects` switch calls mocks directly.
**Why:** Integration cost is the real cost. The good news: `cr_effects` with `authority` and `evidence_refs` is a
sound outbox for pushing decisions to our order system, email/SMS gateway, ferry and tow partners and telephony.
**Fix:** Introduce `Channels` and `Providers` interfaces (email, SMS, WhatsApp, voice; ferry, tow, hotel) behind
`performEffects`; implement the mocks as one provider; add an outbox worker with retries and the existing
UNKNOWN_OUTCOME reconciliation. Effort: L.

### R12 · major · engineering · Single-process assumptions everywhere
**What:** Case locks, booking locks, the tick guard and the simulated clock live on `globalThis`
(`loop.ts:77-97`, `gate.ts:293-312`, `tick.ts:26`, `lib/cr/clock.ts`). README admits "assume one server process".
**Why:** The first time we run two instances (or Next restarts mid-turn), two turns can run on one case and a booking
can be sent twice; the `claimExecution` key protects the proposal, not the model turn.
**Fix:** Postgres advisory locks (`pg_advisory_xact_lock(hash(case_id))`) for case and order locks; a `cr_locks` or
job table for ticks; real time instead of the sim clock in production (`simNow()` is one function, 161 call sites, so
this is cheap). Effort: M.

### R13 · major · operations · Audit trail has authority but no person; no shift handover
**What:** Effects record `authority.by`, revision and basis (good, `gate.ts:459-465`), but `by` is always `ops-shift`.
Cases have `owner` but no per-person assignment, no "mine", no handover note, no "who acknowledged this alert".
**Why:** Shift change at 06:00 needs "what is open, who promised what to whom, what is due before 08:00". The
"Waiting" section with next-check times is a start; the rest is missing.
**Fix:** After R1, add assign-to-me, a shift handover view (open cases by due time, with the last human line on
each) and a mandatory handover note at shift end. Effort: M.

### R14 · major · cost / safety · No budget or rate limits on model spend
**What:** No per-case, per-day or per-order cap; `MAX_ITERATIONS = 12`, `MAX_TOKENS = 16000`, 120 s per call; one
retry per turn; the Ask box is a public model call (R1). Spend is only displayed (`/agent`, `/api/sim/state`).
**Why:** A looping case or a flood of spoofed telemetry (R1) can run up a bill and starve real cases.
**Fix:** Per-case and per-hour spend caps with an automatic "The agent couldn't finish" card when hit; a global
circuit breaker; rate limits per driver/site token. Effort: S.

### R15 · major · liability · "Diagnosis on chat" reads as reassurance
**What:** For CONTINUE_AND_MONITOR codes the prompt lets the agent explain the code and say "it is usually not
critical" (`prompts.ts:48`). Trace G: "it's not something that should stop you immediately… The car may use a bit
more fuel" — the screen allowed it. The knowledge base itself says it is "illustrative guidance, not workshop advice"
(`knowledge/dtc.json:_about`).
**Why:** If the driver carries on after reading that and the car fails, that sentence is ours. 47 codes and 14 lights
were written by the team, not by a mechanic.
**Fix:** Have the code/light tables reviewed by a workshop partner and legal; replace reassurance with neutral
wording ("the code concerns the emissions system; an operator confirms whether you continue"); add "should stop you
immediately" patterns to the screen. Effort: S (wording) + M (review).

### R16 · major · engineering / robustness · Policy encoded as regexes over model-written text
**What:** Gate decisions depend on regexes over proposal titles (`tools.ts:709-711` "agree|accept|answer…"),
`wait_for` minutes are corrected by parsing "check at 11:15 UTC" out of prose (`tools.ts:575-583`), the driver reply is
cleaned by splitting on `---` and a "leading note" heuristic (`loop.ts:170-214`), `twinOf` treats any pending
OPERATOR_DECISION as a twin of any new one and silently returns the old card (`gate.ts:376-381`), and the gate is 986
lines with one-card-at-a-time exemptions that changed three times in one night (`PROCESS.md`).
**Why:** Each heuristic was added after a model misbehaved; each will break with the next model or language. The
agent may believe a new question was recorded when the old one was returned.
**Fix:** Make the driver reply a structured tool call (`reply_to_driver`) instead of the final text; give `wait_for` a
`check_at_utc` field; reject rather than alias twin escalations; move title-based rules into explicit proposal
fields (`answers_customer: true`). Effort: M.

### R17 · major · business case · Numbers rest on assumed handling times and a model we would not use
**What:** `BUSINESS-CASE.md:16, :31` admits 30–45 min today and 5–10 min with Road Desk are estimates. AI cost
(€0.12/case) is measured on DeepSeek, while `.env.example` defaults to `anthropic/claude-sonnet-5.5` and R5 pushes us
to an EU-hosted model: costs could be 5–15× higher. Telephony is excluded. "≈3 FTE saved" sits beside "a 24/7 seat
stays (5.4 FTE either way)"; the saving is only real if we currently staff more than one seat at night, and the
dealer call, the reading of 19 queue rows and the verification of wrong drafts remain human time.
**Why:** We would present this to the board; it has to survive a question like "what if the model is EU-hosted and the
incident rate is 10%?".
**Fix:** Reframe as a hypothesis with a measurement plan: baseline time-and-motion on 50 incidents before the pilot,
measure after; price three model options; include telephony and alerting; show a sensitivity table rather than a
headline. Effort: S.

### R18 · major · docs vs code · README claims features the code does not have
**What:** `README.md:113-115` "Voice uses Chrome's speech recognition… `VOICE_PROVIDER=browser`": no such code or env
anywhere (grep). `README.md:164` "`npm run voice:test`": no such script in `package.json`. `README.md:118-120`
"urgent and ended calls feed the road agent": a live call is linked with `caseId: null` and starts no turn
(`app/api/line/link/route.ts`, confirmed by `OVERVIEW.md`). `README.md:38` "voice interviewer" was retired
(`lib/voice/schema.ts:1`). `lib/voice/` is one schema file.
**Why:** We judge what we can run; stale claims cost trust.
**Fix:** Delete the stale paragraphs; state plainly that the live line is external and what its contract is. Effort: S.

### R19 · major · dealer / customer experience · Language and brand voice are undefined
**What:** Customer drafts are English unless the customer wrote in another language (`prompts.ts:73`); most customers
in the dataset are Finnish dealers who never wrote first. Drafts sign as "Shift lead" with no Bahn signature block,
no reference to our SLA language, no template. Non-customer desks get an immediate model reply (D trace: good), but a
customer-owned desk asking "where is the driver?" waits for a human approval that may take the whole night (R2, R7).
**Why:** The dealer reads this as Bahn. Tone was fine in B and the customer trace, but it is the model's tone, not ours.
**Fix:** Customer language from the customer record (country/preferred language), a signature block and three
approved templates (delay, new date, delivered) the agent fills; an SLA for held site replies with an automatic
holding line after 15 min. Effort: S–M.

### R20 · major · data model · Brittle, snapshot-shaped records
**What:** The dataset is loaded into a `related_records` JSONB table keyed by collection name; `OrderFacts` is built
from `Raw = Record<string, unknown>` with string status comparisons (`lib/agent/context.ts:72-145`, `:157-161`);
app events are "laid over" the snapshot in `lib/cr/lifecycle.ts`, `effective.ts` and `present/load.ts`.
**Why:** Replacing the packet with our order system means rewriting `loadOrderFacts`, the lifecycle overlay and the
presenters. The effects overlay pattern itself (never edit the source of truth) is right for a control room that does
not own the orders.
**Fix:** Define a typed `Order` read model (the dossier project already has strict generated schemas,
`dossier/src/records.generated.ts`) and one adapter from our API; keep effects as the write-ahead log. Effort: L.

### R21 · major · data / engineering · Photos stored as base64 in the events table
**What:** `storePhoto` puts up to 5 MB of base64 into `cr_events.data` (`lib/agent/triggers.ts:203-218`), while an
S3-compatible store already exists for attachments (`compose.yaml`, `lib/attachments.ts`).
**Why:** Damage and dashboard photos are evidence we must keep for claims, under retention rules, and they will bloat
the hottest table (every timeline read).
**Fix:** Upload to the attachment bucket, store a key and a hash in the event, presign on read; add retention. Effort: S.

### R22 · major · observability · Console logs only
**What:** Run usage and cost land in `cr_agent_runs` (good) and the `/agent` page; failures go to `console.error`
(`loop.ts`, `triggers.ts:431`, `http.ts:50`). No metrics, no structured logs, no error tracking, no health endpoint
beyond `/api/sim/state` and `/api/build`.
**Why:** At 03:00 "the agent is slow" (RUN-SHEET) and "the agent is down" look identical from the queue.
**Fix:** Structured JSON logs with case/run ids; metrics for turn latency, error rate, cost, cards per hour, time to
first driver message; `/healthz` covering DB, model and call service; Sentry or equivalent. Effort: S–M.

### R23 · major · scale · Every operator tab reloads all orders every 2.5 s and runs the simulator in the read path
**What:** `/queue` and the map re-render server-side on each poll via `loadBoardBundles`, which selects all orders,
all related records in 16 collections, all alerts, conversations and events (`lib/present/load.ts:234-296`) and first
calls `syncSimulator()` (`load.ts:26-37`). `/api/chart` is 135 KB per poll.
**Why:** With ~300 live orders and five open tabs this is a continuous full-table scan; mixing simulation into reads
is a production hazard.
**Fix:** Query only open cases and orders with open items for the queue; push changes (SSE) instead of polling;
remove the simulator from `load.ts` behind `DEMO_MODE`. Effort: M.

### R24 · minor · operations · Prompts and screens carry demo wording that would reach production
**What:** `prompts.ts:20` "All prices, bookings and outside parties in this system are simulated and fictional";
`rulebook/warning-light.md:22` "A phone position is simulated in this demo; say so"; "simulated" labels across the UI
and driver app ("Simulated OBD", "simulated GPS").
**Fix:** A `DEMO_MODE` flag that switches the sentence set and labels. Effort: S.

### R25 · minor · driver experience · The driver app shows UTC and raw OBD values
**What:** Driver phone screenshot: "Ferry check-in by 21 Oct 15:30 UTC", "Car and keys collected 07:00 UTC",
"Speed 126 km/h · Coolant 92 °C · Battery 14.2 V".
**Why:** A driver in Germany thinks in CEST; raw telemetry on a phone invites reading it while driving.
**Fix:** Local time of the driver's position; hide telemetry from the driver view. Effort: S.

### R26 · minor · safety · Fail-open corners in the drivability screen
**What:** When the classifier is unavailable, a message in *routine* context that mentions a gate or reception is
allowed by regex (`drivability.ts:189-196`); on a job with no recorded fault the screen only drops the offending
sentence and sends the rest (`tools.ts:505-518`), so a driver who said "the car feels odd" but whose case kind stayed
DRIVER_QUESTION gets trimmed reassurance, not a held reply (`driverSaid` raises caution only for listed English words,
`drivability.ts:186`).
**Fix:** Any driver text in the last N minutes that mentions a fault in any supported language flips the context to
restricted; fail closed when the classifier is down unless the text is a pure site-directions template. Effort: S.

### R27 · minor · operations · "I'll handle it" never auto-escalates
**What:** `tick.ts:58` ignores cases waiting on an operator; the queue only marks them overdue after 15–30 min
(`queue.ts:67`).
**Fix:** After the deadline, raise the row to the top and alert (R7); at shift end, force handover. Effort: S.

### R28 · minor · customer rule · Customer-side detection depends on `sites.customer_id`
**What:** `isCustomerSide` (`context.ts:67-70`): a site is the customer only when its profile's `customer_id` equals
the order's; a one-off delivery address is customer-side, a one-off pickup is not. A dealer group with several site
profiles under different customer ids would be contactable by the agent.
**Fix:** Resolve customer identity through our account hierarchy (group → accounts → sites) in the adapter; default
to "customer" when unknown. Effort: S after R20.

### R29 · minor · integration · Knowledge bases are hand-written JSON
**What:** `knowledge/dtc.json` (47 codes), `warning-lights.json` (14), `city-coords.json`, `routes/`.
**Fix:** Source codes and lights from a licensed database and manufacturer data after R15's review; keep the
severity mapping as our policy table. Effort: M.

### R30 · minor · tests · Good gate coverage, blind spots where the pilot risk is
**What:** 126+ tests with scripted model stand-ins cover approvals, outdated cards, double clicks, unknown outcomes,
booking selection, silent-driver follow-ups (`lib/agent/gate.test.ts`, `loop.test.ts`). Nothing tests route
authorisation (there is none), non-English clearance, timers without a tab, two instances, or PII scoping of the
driver context (only the site context is tested, `gate.test.ts:663-672`). The night harness's evidence pages live on
the team's box (`/home/assistant/night/out`), not in the repo; the committed e2e traces (18 runs, $0.58) are the
reproducible evidence.
**Fix:** Add tests for R1, R4, R2, R26; commit the night harness output or a summary with transcripts. Effort: S–M.

### R31 · minor · engineering · Clock catch-up and sim reset are production hazards
**What:** `instrumentation.ts` moves the in-memory clock to the newest stored record on every start; `/api/sim/clock`
advances it; `resetSimClock` restarts it. All of this exists because the clock is simulated.
**Fix:** In production `simNow = () => new Date()` and the catch-up, reset and clock routes are compiled out. Effort: S.

### R32 · minor · operator UX · Card requires expanding "What the agent found" to see sources
**What:** The decision card shows title, what happened, recommendation and the draft; facts with source chips,
unknowns and "if you approve / if you reject" sit inside a collapsed `<details>` (`decision-card.tsx:206-213`).
**Why:** The brief asks "can you see where every fact came from"; at 03:00 the operator should not have to click to
see the unknowns before pressing Send.
**Fix:** Show unknowns and the next-step lines open; collapse only the evidence list. Effort: S.

### R33 · minor · operator UX · Operator-facing notes contain markdown and sales talk
**What:** Trace A operator note: "**What's on the table:** … **What you need to do:** Approve the card and call
Kavellora. Once they choose, come back and I'll inform the driver and book or coordinate accordingly." Rendered via
`RichText`, but the prompt says plain text, and "I'll book" is a promise the gate will not let it keep.
**Fix:** Prompt: no markdown, no promises of future bookings; cap operator notes at two lines. Effort: S.

### R34 · minor · dealer desk · The pickup desk cannot be contacted except through our web chat
**What:** `/site` and `/dealer` are role-play pages; a real desk has email and a phone. `ask_site` only writes a row.
**Fix:** Part of R11; until then the agent's site questions should become a card "email/call the site" for the
operator. Effort: S.

### R35 · minor · engineering · The call service keeps state in memory and on disk
**What:** `dossier/src/serve.ts`: calls, jobs, runs and brief caches in `Map`s and `data/out/*.json`; a restart marks
running runs failed; loopback-only HTTP with no auth, called by the app with a plain base URL.
**Fix:** Part of R9; at minimum persist to Postgres and add a shared secret between the two services. Effort: M.

### R36 · minor · privacy · Site context includes the driver's live coordinates
**What:** `getSiteContext` returns `latest_driver_position` with lat/lng (`context.ts:415, :429`) to a third-party desk's
conversation, although the prompt says to give an estimate in minutes.
**Fix:** Give sites a distance/ETA band only. Effort: S.

### R37 · minor · robustness · Twin escalation returns the old card silently
**What:** `gate.ts:376-381`: any pending OPERATOR_DECISION is a twin; `escalate` then reports "Question recorded for
operations: <old title>", so the agent's new question is lost without the agent being told.
**Fix:** Return an explicit refusal naming the pending card. Effort: S.

### R38 · minor · operations · Reset and demo controls sit one click from the operator
**What:** The "Bahn" role tab on every page leads to `/demo` with "Reset demo" (deletes everything, `routine.ts:56`)
and clock jumps; `app-frame.tsx` shows it to everyone.
**Fix:** R1 roles; hide demo entirely unless `DEMO_MODE`. Effort: S.

### R39 · polish · UI consistency · Three different "needs a person" counts
**What:** Map badge 16, queue 19, board 16 (screenshots). Documented as deliberate in `PROCESS.md`, but an operator
sees a bug.
**Fix:** One function, one number. Effort: S.

### R40 · polish · docs · PLAN.md and README disagree on the model
**What:** `PLAN.md` "Opus 5.5 for the demo", `.env.example` Sonnet 5.5, README and traces DeepSeek, `vision.ts` Haiku,
`sim-driver.ts` Haiku. Four models, three providers' pricing, one business case.
**Fix:** One model matrix in README with the cost and compliance reason for each. Effort: S.

### R41 · polish · code hygiene · Dead or orphaned pieces
**What:** `lib/voice/schema.ts` kept for retired tables; `leaflet` map code retained beside the new chart; `/map`
page alongside `/`; `mockups/` and `attachments/` from the packet; `check_packet.py` untouched. Fine for a hackathon;
list them in README under "not part of the product".
**Fix:** Prune or mark. Effort: S.

### R42 · polish · a11y / taste · Light theme, empty states and typography are good; small things remain
**What:** Light theme works (screenshot); empty states exist ("Nothing needs your decision right now."); the order
page is readable. Remaining: monospace references are small at 100%; "Owner not recorded" in red-band rows reads as
an error; truncated "Also:" lines carry the useful part.
**Fix:** Typography pass with our ops team on a 27" monitor. Effort: S.

## 3. What works and should be kept

- **The gate in code.** Customer contact pinned to ask-first (`gate.ts:248-252`), approval bound to a revision,
  assumptions re-checked before execution with OUTDATED redraft (`gate.ts:608-619, :655-656`), execution claimed once
  (`queries.ts:187-195`), booking timeouts become UNKNOWN_OUTCOME that block retries until reconciled
  (`gate.ts:286-291, :549-556`), a quote must be the exact recorded quote (`gate.ts:223-242`). This is the right
  shape for "give it more freedom later".
- **Customer agreement is a separate record.** Approving a new date sends a proposal; only "Customer agreed" with
  evidence moves the promise (`gate.ts:922-960`, `effective.ts`). The Delivery promise block on the order page shows
  all three states. Keep this exactly.
- **Disagreement handling.** Reject with a reason blocks a twin for 4 h unless new facts (`gate.ts:394-397`);
  "Tell the agent instead"; "I'll take it from here" keeps the agent out (`triggers.ts:337-344`); an operator who
  edits a clearance into an instruction has *not* cleared the driver (`gate.ts:567-585`).
- **Failure handling.** Model error, step limit, refusal or watchdog → one card with "let it try again / I'll take
  it" (`followup.ts:50-88`); silent driver → one reminder, then a card with sourced facts (`tick.ts`, F trace).
- **Audience scoping built server-side.** Sites see their end only (`context.ts:410-433`); drivers their job; the
  server checks the driver is on the assignment and the site contact belongs to the order (`triggers.ts:79-91,
  :123-135`); tools per audience come from one table (`gate.ts:43-64`).
- **Evidence language.** Source chips on every fact; "a quote is not a booking", "simulated GPS", "not confirmed for
  this car" everywhere, in the UI and in what the agent says (D trace: "No journey start is recorded yet… so I don't
  have a live position").
- **The agent's actual behaviour** on the traces: safety first, one question at a time, hands over with a usable
  card (A: options, ferry cutoff, workshop 12 km, cost as a quote), tells the driver what happens next without
  promising, keeps the customer out.
- **The order page and the map** are close to what we asked for: the case at the top, the timeline with the agent's
  lookups foldable, the "Ask the agent" read-only box, the route with pickup/delivery confirmation state.
- **The process.** `PROCESS.md` is an honest log of what the agents got wrong and what was thrown away; the role and
  night harnesses check records, not wording, and found real faults (clock behind its records, stop instruction held
  as clearance, three cards at once).
- **Rulebook as plain English** the ops team can edit and read on `/agent`.

## 4. Suggested fix order

1. **R1** Authentication, identity on every decision, demo routes behind a flag. Nothing else is credible before this.
2. **R3** Deterministic stop instruction before the model; then **R4** multilingual templates and screen.
3. **R2** Server-side timers, independent of any browser tab.
4. **R7** Slack/SMS alerting for critical cards and agent failures; **R27** escalation of forgotten "I'll handle it".
5. **R5** EU-hosted model or pseudonymisation, traces off, retention, DPIA; **R21** photos to object storage.
6. **R6** Make the driver-report path primary and add a GPS-anomaly trigger; retire the dongle from the demo.
7. **R8** Separate "card ready" from "records to look at"; acknowledge/snooze; one count (**R39**).
8. **R16** Structured driver reply and wait fields instead of regex heuristics; **R37** explicit twin refusal.
9. **R10/R18** Dockerise, migrations, honest README; define or drop the external phone line.
10. **R9/R11/R20** One agent stack, adapter boundaries for channels and providers, typed order read model: the
    integration project, scoped after the shadow pilot shows which cards earn their keep.
