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
| 11 | **A routine question became a "clear the driver" card.** On the keys question the agent signed off "you're good to go"; the screen held the whole reply and raised a clearance card on a case with no fault. On the missed ferry the compliant operator then approved that card and the agent told the driver "the operator has cleared you". | clean pass, routine-keys and missed-ferry | With no fault and no restriction on the case the clearance-sounding sentence is dropped and the rest is sent; nothing goes to operations. Prompt: no clearance-sounding sign-offs, no markdown in chat (`lib/agent/tools.ts`, `prompts.ts`). |
| 12 | **Two open questions at once**: a new-date card and a held site reply waited together on the misfire case. | clean pass, misfire-customer-site | While a card waits the agent may not raise a second one and is told to fold what it learnt into the case; replies the gate holds are the exception (`lib/agent/gate.ts`). |
| 13 | **A site's instruction about the broken car opened a second case** next to the misfire, so the operator had the recovery decision on one case and the owner's written instruction on another. | rerun, misfire-customer-site | While an incident case is open on the order, the site's message lands on it (`lib/agent/triggers.ts`). |
| 14 | **"Recovery is being arranged now"** was told to the driver before the booking card was approved. | rerun, misfire-customer-site | Prompt: until a person approved the card and it ran, say what is being asked for, not what is being done. |
| 15 | **The call review counted a refusal as a violation**: "I can't give out the customer's number" matched the customer-details pattern. | clumsy pass and line rerun, fishing driver | A refusal that names the forbidden thing is not a violation (`dossier/src/review.ts`). |
| 16 | **A sign-off still became a clearance card** on cases with no fault whose kind was not a routine one (a late driver, a keys question the agent had re-titled): "You're all set, Thomas. Safe drive the rest of the way to Munich." | rerun, late-driver-promise and routine-keys | The card is raised only when a fault or restriction is recorded on the job; otherwise the sentence is dropped and the rest sent (`lib/agent/tools.ts`). Verified in pass 5. |

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

Pages on the box under `/home/assistant/night/out/`. Costs are the players' and judges' model calls only; the agent's own
spend shows on the sandbox app's `/api/sim/state` (about $1 per full pass).

| Pass | Code | Operator | Scenarios | Checks passed | Failed | Review | Notes |
|---|---|---|---|---|---|---|---|
| 1 | e09d815+ | compliant | 13 | 118 | 5 | 4 | first run; faults 2, 3, 5, 6 found here |
| 1b | 9a3f910 | compliant | 12 (rerun) | – | – | – | contaminated by cases left open from pass 1; fault 1 and 4 found here, then discarded |
| 1c | ce68de3 | compliant | 17 | 138 | 9 | 5 | 4 line scenarios and the German email failed on the sandbox dossier having lost its key after the reboot; faults 11, 12 found here |
| 2 | ce68de3 | clumsy | 17 | 153 | 1 | 3 | the clumsy operator (double approvals, non-clearing edits, nonsense instructions) broke nothing; the one fail is fault 15 |
| lines2 | b4f04d8 | – | 4 | 10 | 1 | 1 | no repeated caller lines, 112 said once and the call ended, review present for inbound calls; the fail is fault 15 |
| 3 | b4f04d8 | compliant | 7 (rerun) | 71 | 3 | 3 | 2 fails are fault 13 (fixed after the pass started), 1 is fault 16; reviews: light-monitor prompt, German basis ids the harness could not resolve, late-driver GPS/driver mismatch |
| 4 | 4dc2618 | compliant | 4 (rerun) | 27 | 0 | 2 | faults 13, 14, 15 verified fixed; the desk-contradiction call did not read back the corrected values (model variance, extraction prompt amended) |
| 5 | after 4dc2618 | compliant | 3 (rerun) | see `out/pass5` | | | verifies fault 16 |

Dossier soak: 32 runs, 4 twists × 8 orders, $2.98; 68 findings of which 31 were the old judge misreading a live-section
source; the rest are faults 7 to 10, all fixed.
