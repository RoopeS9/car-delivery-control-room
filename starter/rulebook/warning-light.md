# Warning light

## When it applies

A driver reports a warning light or message on the dashboard, or the OBD
dongle reports a new trouble code or a lit check-engine light (MIL).

## Facts to collect, in order

1. **Is the driver safe?** Where is the car right now: moving, on the hard
   shoulder, at a service area?
2. **What does the light look like?** Colour, symbol, steady or flashing,
   any message text. Ask for a dashboard photo (`request_photo`).
3. **How does the car feel?** Loss of power, shaking, noises, smells, smoke,
   temperature gauge.
4. **What does the car report?** `get_active_codes` and `get_telemetry`.
   Look up each code (`lookup_trouble_code`) and the described light
   (`lookup_warning_light`).
5. **Exact location.** Service-area name, motorway and direction, or a
   location pin. A phone position is simulated in this demo; say so.
6. **The order.** `get_order_context`: who owns the car, the delivery
   promise and who set it, any ferry or train booked later on the route.

## What you may do alone

- Give the safety instruction for the light's severity: for `STOP_NOW`,
  tell the driver to stop at the next safe place and switch off; for
  `DRIVE_TO_SAFE_STOP`, to leave the motorway at the next safe place.
- Ask the driver questions and for photos.
- Look up codes, lights, nearby help (`find_nearby_help`) and the order.
- Update the case title and summary.

## When to stop and hand over

As soon as the car is stopped and the driver is safe, and you know the
severity, the location and what is at stake for the delivery. Do not wait
for every detail.

## Who decides

- Recovery (the owner's own roadside assistance, a tow we book, or a brand
  workshop) is the **car owner's** decision, through an operator. Propose
  `CONTACT_CUSTOMER` with a drafted message that asks the owner, and list the
  options.
- Clearing the driver to continue is an **operator** decision
  (`CLEAR_TO_CONTINUE`), only for `CONTINUE_AND_MONITOR` severity.
- A later delivery is a **customer** agreement (`CHANGE_PROMISE`), after
  recovery is clear.

## Never

- Never tell the driver it is fine to keep driving.
- Never give mechanical advice beyond the safety instruction ("try
  restarting it", "top up the oil").
- Never book recovery yourself.
- Never call a code a diagnosis.
- Never turn an unknown repair time into a definite missed ferry or late
  delivery. Show the dated cutoff and delivery window; describe risk and
  missing information until an itinerary supports a firmer conclusion.
- Cite the driver's own message or call turn for safety and symptoms. GPS
  establishes only its reported position; it cannot establish that the driver
  said they were safe.

## Worked example

Driver: "Warning light came on, the car is shaking." You: safety instruction
"Please slow down and stop at the next safe place, then switch the engine
off." Driver stops at a service area. Codes P0300 and P0302, check-engine
flashing. Photo shows the flashing engine light. Order: Bentley, owned by
the dealer, due in Helsinki on Monday, ferry check-in today at 17:30 local.
Proposal: *Call the dealer about recovery* (`CONTACT_CUSTOMER`), options
"dealer's own roadside assistance" / "we book a tow to the brand workshop",
with a note that today's ferry and Monday's delivery are at risk.
