# Team notes from live testing (24 Oct evening), with where each one lands

## Roope, 19:24 — OBD and worked examples
> OBD: currently just speed and battery voltage are shown. The OBD is there for diagnostics (engine codes). When a chat or call establishes the car has an issue, the agent should read the OBD remotely for a general sense of the problem. If non-trivial (not a light, wiper, bug), inform the seller and collect the data for a later human update to the customer. Also check whether it was reported in the docs when receiving the car. Operator attention in all non-trivial cases. The road desk agent should have a couple of examples of well resolved situations to reference.

Mapping:
- **Telemetry class** (`src/live.ts` ObdReading): already carries MIL state, DTCs with status and a freeze frame, and the list of PIDs the car does not report. Speed/voltage alone is a UI choice, not a data limit.
- **Derived kind to add: VEHICLE_FAULT** — opened when an inbound/chat slot WARNING_LIGHT or ISSUE_REPORTED lands, or MIL goes FLASHING/ON, or a confirmed DTC appears. Fields: codes, severity class (TRIVIAL | NON_TRIVIAL | STOP_NOW, from a small code table), `reportedAtPickup` (true if a pickup proof note or CONDITION_PHOTO document on the order mentions the symptom), basis refs. NON_TRIVIAL and STOP_NOW always create an operator item (Roope: operator attention in all non-trivial cases).
- **Call brief**: a PICKUP_SITE_DESK brief with purpose `FAULT_NOTICE` (new) tells the seller/pickup desk; allowed because pickup desks are non-customers on 96 of 100 orders. The customer update stays human: the derived item collects the facts for it.
- **Inbound brief**: when a VEHICLE_FAULT is open, `mayState` gets the latest codes in words ("the car reports a cylinder two misfire") so the voice model confirms rather than asks.
- **Worked examples**: the dataset has them — executed proposals with operator review notes (e.g. CD-420322 safe stop: "Remove restart advice. Ask only for a safe location detail and keep the owner recovery decision open."). Render 2–3 of these as the agent's reference cases in the rulebook/prompt, cited by proposal id.

## Owner, ~20:00 — non-critical codes in text chat
> In text conversations (e.g. Kasper Kovelund's), when not running as duplex, the assistant could help diagnose if the code is a non-critical oxygen sensor and similar.

Mapping: the VEHICLE_FAULT derived kind's severity class (TRIVIAL | NON_TRIVIAL | STOP_NOW) drives channel behaviour. TRIVIAL (CONTINUE_AND_MONITOR codes: O2 sensor circuits, catalyst efficiency, EVAP) -> text channel may explain and ask up to three diagnostic questions, never clears driving; voice channel stays safety-only; operator item still opens (Roope's rule). STOP_NOW / DRIVE_TO_SAFE_STOP -> safety-only on both channels. Call brief mustNot MECHANICAL_ADVICE stays on voice briefs; a future TEXT brief variant may drop it for TRIVIAL faults.
