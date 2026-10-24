# How a dossier-scoped session moves

The dossier is static context: everything known about one order, typed and graded, loaded whole into a reasoning
model. It does not move by itself. This note says what makes it move, what wakes the model, and what a simulated
delivery run shows about the whole loop.

## The loop

```
records arrive, or time passes
        │
        ▼
  build the dossier as of now  ──  dataset records + the live input (what the app recorded: clock, phone, telemetry,
        │                          timeline events, cases, stored calls)              src/build.ts, src/livepull.ts
        ▼
  derive                        ──  DUE_CHECK · DEADLINE_AT_RISK · SILENT_GAP · CONFLICT, each citing its basis,
        │                          from one table of thresholds                       src/derived.ts
        ▼
  diff against the last build   ──  opened / changed / closed, by item id
        │
   empty? ── yes ──▶ nothing happens; the model is never shown a GPS fix on course
        │
        no
        ▼
  reason                        ──  one model call, the dossier + the derived items as context, a closed typed output:
        │                          headline, needsPerson, watching, calls, unknowns      src/reason.ts
        ▼
  place the due checks          ──  a call brief (rule-built, polished by the model), the call on the turn-based
        │                          line, claims extracted citing turns, a review          src/brief.ts, src/llm-call.ts
        ▼
  the claims are live input for the next build
```

Two triggers only: a record arrived (the app's `/api/live/<order>` changed) or time passed (a tick). The dossier
service's `GET /derived/:ref?live=1` is the pure part of one tick; `POST /runs {ref, mode: "LIVE"}` is one whole tick.

Rules the loop keeps:

- One run per order at a time (the service answers 409 to a second).
- A derived item never produces two calls: calls are keyed by the item's subject, and a `PARTIAL` call reopens the
  check only after `retryAfterH`, at most `maxAttempts` times.
- The model proposes, the rules place. A call the model proposes that the rules did not derive is noted on the
  step (`modelOnlyCalls`), never dialled; one to a party the agent may not call is a recorded failure.
- A `BLOCKED` check (the pickup desk is the paying customer) is shown, never placed.

## The derived kinds and their thresholds

`src/derived.ts`, `THRESHOLDS`:

| Kind | Opens when | Closes when |
|---|---|---|
| `DUE_CHECK PICKUP_READINESS` | the selected pickup slot is within 48 h, the desk is not the customer | a `COMPLETED` readiness call exists, or the slot is 2 h past |
| `DUE_CHECK DRIVER_START_CHECK` | a driver is booked and the slot is within 30 h | a `COMPLETED` start check exists |
| `SILENT_GAP` + `DUE_CHECK POSITION_CHECK` | the car is moving and no phone position for 60 min (the app's phone state outranks stored observations) | the phone is live again, or the check completed |
| `DUE_CHECK FERRY_CHECKIN` | a booked ferry's cutoff is within 6 h and no gate scan confirms check-in | a gate scan, or the check completed |
| `DEADLINE_AT_RISK` (ferry) | under 2 h to the cutoff with a position but no scan | the scan |
| `DEADLINE_AT_RISK` (promise) | the latest ETA lands under 30 min before the promise ends, or after | a new ETA inside it |
| `DEADLINE_AT_RISK` (slot) | a start check recorded an ETA after the slot starts | — |
| `CONFLICT` | a call's claim contradicts a record: car not on site, keys not at a desk that releases, a different releaser, "no travel booked" against a booking | — |

A `DUE_CHECK` carries a state: `DUE`, `OVERDUE` (4 h past due), `RETRY` (a partial or failed call, waiting), `DONE`,
`BLOCKED`.

## A delivery run

`POST /runs {ref, twist?, mode?}` or `npm run run-delivery -- CD-420442 --twist confused`.

`TIMELINE` mode walks an order through its key instants without the dataset changing: two days before the slot,
the day before, the collection (the status is overlaid to `IN_TRANSIT`), a 70-minute silent stretch on the road,
five hours before the ferry cutoff, the delivery (then `DELIVERED`). Instants within an hour merge. At each one the
loop above runs; the counterpart on every call is built from the dossier (`src/sim/persona-from-dossier.ts`) with
a twist: `cooperative` answers from the records, `confused` cannot find the car or the keys, `rushed` gives short
answers and a driver who cannot make the slot, `wrong_fact` contradicts the records.

`LIVE` mode is one tick as the app sees it now: the app's clock, phone state, telemetry, timeline and cases.

The report (`RunReport`, `data/out/runs/`) is typed: per step the derived items, the diff, the model's answer, the
calls placed with outcome, claim count, review verdict and whether the rules and the model agreed, the model's
extra proposals, and every failure (a call that could not be placed, a forbidden line said, a proposal to a party
the agent may not call). `npm run run-delivery -- CD-… --plan` prints the instants a run would walk and what the
rules derive at each, with no model call.

## Known limits

- The dataset does not move, so a timeline run overlays the status and the phone state; it does not invent
  positions, scans or messages. A run therefore never closes a `FERRY_CHECKIN` by a gate scan: only a completed
  call closes it, which is the honest reading of the data.
- Conflicts are detected for the slots the brief asks for; a contradiction in free text is the model's to notice
  (it reads the call's claims in the dossier's CALLS section).
- The reasoning model is woken on any derived change, including a check moving from `DUE` to `DONE`. That is one
  call per step at most, a few tenths of a cent.
- Receiver and customer calls are never placed; the run records the model's `needsPerson` for those.
