# The backend, reviewed: what moves, what wakes, what can go wrong

A reading of the dossier-scoped reasoning as it is implemented today, written so that the people on the project and
the agent testing it overnight mean the same thing by each word. `RUN.md` has the loop diagram and the thresholds;
this note says how the pieces are wired, where the design is honest about its limits, and what the overnight soak
is looking for.

## The three parts and how they touch

```
app (starter/)                      dossier service (dossier/, :8799)                 the line (duplex, roaddesk)
─────────────                       ─────────────────────────────────                ───────────────────────────
records in Postgres                 dataset + live pull  ──▶ Dossier (typed, graded)   system prompt = /context/<ref>/<purpose>
clock, phone, telemetry   /api/live  ─────────────────▶     derived layer (rules)      the whole dossier + the brief
cases, timeline, helpdesk msgs                              reason() on change          turns ──▶ /line/ ──▶ ingestTranscript
                                                            briefs, personas, calls     claims cited by turn, review
Needs-you queue, order page  ◀────  /derived /dossier /runs /suggest /calls             the record is live input next build
```

The app owns the world (what happened), the service owns the reading of it (what it means, as of a time), the line
owns one conversation at a time (what to say, from the reading). Nothing writes into another part's store: the
service never writes to Postgres, the app never writes a call record, the line never writes anything; it returns a
transcript the service turns into claims.

## The dossier

`buildDossier(ds, orderId, live, asOf, overlay)` in `src/build.ts`. Pure: the same inputs give the same dossier.

- `ds` is the dataset snapshot (`data/dataset/*.jsonl`, typed by `records.generated.ts`, zod strict). Every record
  is placed into a class (ORDER, PARTIES, VEHICLE, PLAN, BOOKINGS, COMMITMENTS, CLAIMS, OBSERVATIONS, HISTORY, …) and
  graded on the evidence ladder (`src/strength.ts`: REFERENCE … RECORD). A record about another order joins only as
  JOINED or CANDIDATE membership, never DIRECT.
- `live` is what the app recorded since the snapshot (`src/live.ts`, `src/livepull.ts`): the clock, the car's phone
  state, GPS/OBD samples, timeline events, open cases, helpdesk messages, and the stored calls. Rows that do not
  parse are dropped and counted, never coerced.
- `asOf` is the dossier's time. Everything dated after it is left out, which is what lets a TIMELINE run rebuild the
  past honestly. `derivePhase` reads the phase (BOOKED, READY, MOVING, …) from the records as of that time; `overlay`
  lets a run say "the status is IN_TRANSIT now" without touching the dataset.

What the dossier is not: a memory. It holds no model output. The reasoning step's answer is shown to the operator and
discarded; the next build starts from records again. The only thing a model ever adds to a dossier is a **claim**: a
slot extracted from a call transcript, cited to a turn, graded CLAIM. That is the one door through which garbage
could enter, and the soak watches it.

## The derived layer

`derive(d)` in `src/derived.ts`. Pure rules over one dossier, every item citing the records it rests on:

| item | the rule, from `THRESHOLDS` |
|---|---|
| `DUE_CHECK PICKUP_READINESS` | slot within 48 h, the pickup desk is not the paying customer, no COMPLETED readiness call |
| `DUE_CHECK DRIVER_START_CHECK` | a driver booked, slot within 30 h, no COMPLETED start check |
| `DUE_CHECK POSITION_CHECK` + `SILENT_GAP` | moving, no phone position for 60 min (the app's phone state outranks stored fixes) |
| `DUE_CHECK FERRY_CHECKIN` | booked ferry, cutoff within 6 h, no gate scan |
| `DEADLINE_AT_RISK` | ferry: under 2 h to cutoff with no scan; promise: latest ETA within 30 min of its end or after; slot: a start check's ETA after the slot |
| `CONFLICT` | a call's claim contradicts a record (car not on site, keys elsewhere, another releaser, "no travel booked" against a booking) |

A `DUE_CHECK` carries a state: DUE, OVERDUE (4 h past), RETRY (a partial call, waiting `retryAfterH`), DONE, BLOCKED
(the desk is the customer). Items have identity (kind + subject), so `diffDerived(before, after)` says what opened,
changed and closed.

## What wakes the model, and what it may do

`reason(d, {derived})` in `src/reason.ts` is called only when the diff is non-empty (and once at a run's first step).
It gets the rendered dossier, the derived items rendered apart from the facts, and the list of callable parties. It
answers a closed schema (`ReasonOutput`): headline, `needsPerson` (what, why, options, basis) or null, up to three
`watching` lines with basis, up to two `calls`, unknowns. Output is zod-validated; one retry with the validation
errors; a second failure is a recorded failure, not a crash.

The model proposes, the rules place. In `runDelivery` (`src/run.ts`) the calls placed at a step are exactly the
`DUE_CHECK`s in state DUE or OVERDUE. A call the model proposed that the rules did not derive is written down as
`modelOnlyCalls` and never dialled; one to a party the agent may not call is a failure. The model's agreement with the
rules is recorded on every placed call (`proposedBy: RULES | BOTH`), which is the number to read first in a report.

Why this shape: the model cannot start an action the rules did not already justify, so a hallucinated urgency costs
one line in a report, not a phone call. The price is that the rules must know every kind of check; a new kind is a
new `DUE_CHECK` rule plus a brief builder, not a prompt change.

## A call, end to end

1. `briefFor(d, purpose)` (`src/brief.ts`) builds the brief from the dossier: `mayState` (the only facts the caller may
   say), `ask` (the slots to fill), `mustNot`, opening, closing, `basis`. It throws when the dossier cannot support
   the call (no driver, no slot); that is how a check becomes UNPLACEABLE rather than a bad call.
2. `composeBrief` (optional, `?by=model`) lets the model rephrase the rule-built brief for speech. It may reorder the
   asks and polish the words; it may not add facts (the draft's facts are the allowed set).
3. The line's system prompt is `contextPrompt(d, brief)` (`src/context.ts`): how to speak, the brief, the hard rules
   (customer details, prices, other orders, mechanical advice, promises, clearance to drive, and the emergency rule:
   it cannot send help, an injured caller is told to call 112), then the whole rendered dossier.
4. The transcript comes back and `ingestTranscript` (`src/llm-call.ts`) runs the extraction prompt: slots only when
   the callee stated them, each citing the turn and quoting the words; "I can't see it" is not `false`; inbound calls
   also get a triage and an `escalate` flag.
5. `reviewCall` (`src/review.ts`) checks the caller's turns against the brief: numbers it said must come from
   `mayState` or from the callee; forbidden lines fail the review.
6. The record is stored; the next build sees its claims as CLAIM-strength live items, and `derive` may close a check
   (COMPLETED) or open a CONFLICT.

Simulated calls (`runLlmCall`) play the counterpart with a persona built from the same dossier
(`src/sim/persona-from-dossier.ts`) under a twist: cooperative answers from the records, confused cannot find things,
rushed is short and cannot make the slot, wrong_fact contradicts the records on purpose.

## Where it is honest about its limits

- The dataset does not move. A TIMELINE run overlays status and phone state; it never invents a gate scan, a
  position or a message. So a `FERRY_CHECKIN` closes only by a completed call, never by a scan.
- The model is woken on any derived change, including DUE → DONE. One call per step at most.
- Receiver and customer calls are never placed. The run records `needsPerson` for those; the helpdesk's drafts
  (`POST /suggest`) are the operator's tool for that side.
- The line has no tools. It cannot look anything up mid-call; what it does not have in the dossier it says an operator
  will check.
- Claims are graded CLAIM and cited to a turn, but a wrong extraction (a slot the callee did not state) still enters
  the next build as a claim. The review catches forbidden caller lines, not wrong callee readings. This is the main
  way garbage can be committed, and it is what the soak measures on cooperative runs.

## What the overnight soak checks

`npm run soak -- --sample 8 --twists cooperative,confused,rushed,wrong_fact --budget 20` (`src/cli/soak.ts`,
checks in `src/soak.ts`). Each run is judged with no further model call, against a dossier rebuilt as of each step:

| finding | what it means |
|---|---|
| `PHANTOM_CITATION` | the model cited an item id that is not in the dossier: it made a source up |
| `ID_IN_PROSE` | an id leaked into a headline, a watching line or an option (rule 6) |
| `REPROPOSED_CLOSED` | the model proposed a check the rules hold DONE, RETRY or BLOCKED (rule 5) |
| `UNCALLABLE_PARTY` | it proposed calling the customer or the receiver |
| `FORBIDDEN_LINE` | the caller said a forbidden line on a call |
| `REPEAT_CALL` | one subject called more than the retry rule allows |
| `CLAIM_FLOOD` | more claims from one call than a brief asks for: the extraction is inventing |
| `WOKEN_WITHOUT_CHANGE` | the model ran on a step with an empty diff |
| `CONFLICT_ON_COOPERATIVE` | a cooperative counterpart "contradicted" the records: either the persona or the extraction is wrong; both are garbage in the dossier |
| `NEEDS_PERSON_FOR_ROUTINE` | needsPerson on a step with nothing at risk, no conflict, no failed call, cooperative twist |
| `UNPLACEABLE` | a due check whose brief could not be built from the dossier |

The page is `data/out/soak/<stamp>.md`, rewritten after every run, so a night that stops halfway still reports.
`--judge` re-reads every stored run with the current checks, which is how a check added in the morning is applied to
the night's runs without spending again.

What a clean night looks like: zero phantom citations, zero ids in prose, zero re-proposed closed checks, zero
conflicts on cooperative runs, rules and model agreeing on every placed call. What to expect to see instead, and to
read closely: conflicts on wrong_fact runs (that is the twist working), partial calls on rushed runs with a RETRY
state afterwards, and `needsPerson` on confused runs where the car or keys cannot be found.
