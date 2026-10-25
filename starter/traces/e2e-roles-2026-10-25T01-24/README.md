# Role harness traces, 25 Oct 2026 ~01:25–02:30 UTC

`npm run e2e:roles` against the production build with the real model (DeepSeek v4 pro for the agent, v4 flash for
the drivability classifier, both through OpenRouter). One folder per story; each holds `timeline.md` (the checks, then
every event and card on the story's case as the operator sees it) and the agent's runs as JSON (`AGENT_TRACE_DIR`:
the model calls, tool calls and results, usage and cost; photo bytes are cut out).

| Story | What it plays | Checks |
|---|---|---|
| A | Fresh warning light: the agent reaches the driver first, the operator handles the dealer call | 8/8 |
| B | A new date: proposal, the customer's emailed yes, the operator records it | 9/9 |
| C | Routine keys question from the driver | 5/5 |
| D | The pickup desk asks about the driver | 6/6 |
| F | The driver goes silent: reminder, then a card for a person | 5/5 |
| G | A sensor light that is usually not critical | 5/5 |
| H | Pickup to handover in the driver app, photos, delivery confirmation card | 8/8 |
| customer | A customer's email gets a drafted reply for a person | 6/6 |

B, C and F are from a second run of those three (the first run's B found a defect, fixed before the rerun; its C and
F waited too little for slow model turns, and the harness now waits longer). The defect: on the customer's emailed
yes the agent asked operations to "record the agreement" with a card of its own; the gate now refuses that while
the answer waits to be recorded on the case (see PROCESS.md).
