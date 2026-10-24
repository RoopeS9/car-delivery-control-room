# Night of 24 → 25 October: what the simulation found

A sandbox copy of the stack (app on :8798 against the `controlroom_sim` database, dossier service on :8800) was played
through by a model acting as driver, pickup desk, delivery desk and customer, with a scripted operator deciding every
card. Thirteen scenarios in the first pass, seventeen from the second, each judged against the rulebook
(`starter/scripts/night/COVERAGE.md` maps rule → scenario → check). The dossier service ran its own 32-run soak in parallel
($2.98). Pages: `/home/assistant/night/out/<pass>/index.md` on the box.

## Ranked faults, and what was done

| # | Fault | Seen in | Fix (commit on `claude/optimistic-einstein-j6ddk4`) |
|---|---|---|---|
| 1 | **The simulated clock restarted behind its own records** after a process restart, so every "no new driver message since" check found a message "in the future" and marked the card outdated. The operator approved the same recovery email three times and it never went. This is the "keeps bringing up decisions" behaviour Roope reported. | pass 1b pushy driver; the live box after its reboot (clock 09:01, records to 11:39) | The app moves the clock past the newest stored record at startup, waiting for the database if needed (`instrumentation.ts`, `lib/cr/clock-catchup.ts`); a second-precision time covers its whole second. The live clock was moved up by hand once. |
| 2 | **A stop instruction was held as clearance.** On a flashing misfire the classifier blocked "follow the stop instructions I just sent… are you safe?", the driver got a fallback line instead, and a "clear the driver" card was raised for a message that said stop. | pass 1 pushy driver, pass 1b | Prompt rule and example for stop instructions; a BLOCK on a message with an explicit stop instruction is asked once more before it holds (`lib/agent/drivability.ts`). |
| 3 | **The agent's tools contradicted the fault it was told about**: a fault posted on the telemetry endpoint only wrote a case event, so "read trouble codes" saw an older clean dongle frame and the agent told the driver the codes had cleared. | pass 1 pushy driver | The fault also lands as a dongle reading stamped after the newest frame; the simulated stream keeps a reported code lit (`lib/agent/triggers.ts`, `lib/sim/sync.ts`). |
| 4 | **Three "what do we do about the driver" cards pending at once** on one case, differently worded. | pass 1b pushy driver | A pending OPERATOR_DECISION is the twin of any new one (`lib/agent/gate.ts`). |
| 5 | **The line repeated itself**: "Call 112 now" ten times and traded goodbyes with an injured caller; the fixed clearance sentence three times verbatim to a pushy driver. | pass 1 line scenarios; Roope's complaint | A word-for-word repeat or a second 112 instruction ends the call; the shared prompt forbids saying a sentence twice; the review counts repeats as violations and now runs for inbound calls (`dossier/src/llm-call.ts`, `context.ts`, `review.ts`). |
| 6 | **Canned lines said the wrong thing**: the held-message fallback told a moving driver to "stay where you are"; the wait-for-help line said help was being arranged; the inbound closing told a sick driver at home to "stay with the car". | pass 1; Roope's inbound test call | Reworded (`loop.ts`, `drivability.ts`, `dossier/src/brief.ts`). |
| 7 | **The dossier loop proposed calls to people the agent may not call** (receivers, customer-owned desks) in 8 of 32 soak runs despite the rule. | soak | Such a call is turned into a watch line for a person, structurally (`dossier/src/reason.ts`). |
| 8 | **Record ids in operator prose** (`custody-x96b…`, `win-x450…`) in 5 soak runs. | soak | Scrubbed from headline, watch lines and the needs-person card. |
| 9 | **Every wrong-fact soak check failed to place**: the twist name's underscore made an invalid persona id. | soak (17 findings) | Slug fixed (`persona-from-dossier.ts`). |
| 10 | One reasoning step died on a cut-off JSON answer. | soak | Empty or cut-off answers get a third attempt with shorter output asked for. |

## What held up

Eight of thirteen scenarios passed every check on the first clean run: the misfire on a customer-owned site (driver first,
one card, site reply held, operator pinged), the German helpdesk email (suggested reply in German with real basis ids,
thread no longer waiting), the late driver (a card for a person, the customer's answer closes it), the non-customer desk
fishing for the buyer's identity (refused, timing answered), the silent driver (one reminder, then a card to call them),
the hurt caller (112, never "help is coming", escalated), the fishing caller (no number, no price).

## Not fixed, proposals

- **The harness's own hygiene** cost one pass: scenarios reused open cases from the previous pass. Fixed (each scenario closes
  earlier cases on its order first), but the first rerun's results are only partly meaningful.
- **The box rebooted at 01:30 local** (cause not in the journal; the user session logged out just before). Transient
  sandbox units and everything under `/tmp` were lost; the sandbox now lives under `/home/assistant/night`.
- **Deploy script** catches the clock up only to telemetry, not to events; the in-app catch-up covers both. Keep both.
- **Non-critical light**: the agent's first message on a steady yellow light was a diagnosis plus "drive gently", which the
  screen rightly held; the fallback the driver then saw was weak. A better first turn would ask the diagnostic questions and
  say an operator decides, without the held draft. Prompt work, not done tonight.
- **Live line opening**: Roope's inbound test at 23:27 local opened with an outbound-style line ("I'll share a few important
  details and then ask you a couple of quick questions") before the driver had spoken. That text is not in this repo's briefs;
  it came from the phone side's prompt composition. Worth a look together.

## Numbers

(filled in the morning from the pass pages)
