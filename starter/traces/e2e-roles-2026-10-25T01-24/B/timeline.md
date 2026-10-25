# Story B

- ok: the new date comes as a promise-change card (Propose new delivery window to the customer)
- ok: an approved proposal is not yet the promise (21 Oct 12:00–16:00 CEST)
- ok: the customer's agreement gets a drafted reply (Confirm the agreed Friday window to the customer)
- ok: the promise block shows the customer's email
- ok: the recorded agreement moves the promise (23 Oct 12:00–16:00 CEST)
- ok: an open reply card keeps the case with operations (NEEDS_DECISION pending=1)
- ok: /api/orders/ord-00322 renders (200)
- ok: /queue renders (200)
- ok: /orders/ord-00322 renders (200)

## CD-420322 · Recovery at 12:00, delivery moved to Friday 23 Oct 12:00–16:00 CEST [NEEDS_DECISION]

- driver/message → agent: Still waiting at the service area with the Bentley. Has anyone decided who is collecting the car? I need to know if I should stay.
- agent/lookup: Read the order record for CD-420322
- agent/lookup: Checked the car and phone data for the last 30 min: nothing received
- agent/note: Waiting on the car owner's decision on recovery for the Bentley (incident opened 08:07 UTC). Next check at 2026-10-21 09:30 UTC, in 30 min: Once the owner's decision is recorded, tell Kasper who is collecting the car and when.
- operator/message → agent: Instruction to the agent: The owner says their roadside partner collects the car from the service area at 12:00 today and takes it to their Hamburg workshop. Today's delivery is lost. Propose to the customer a new delivery window Friday 23 Oct 10:00-14:00 UTC.
- agent/message → driver: No decision yet, Kasper. Operations is still waiting for the Bentley's owner to say who recovers the car and how. Please stay at the service area with the engine off — we will message you the moment we know who is coming and when.
- agent/lookup: Read the order record for CD-420322
- agent/lookup: Read the history of CD-420322 (38 entries)
- agent/message → driver: Kasper, the owner's roadside partner will collect the Bentley from the service area at 12:00 today. Please stay with the car, engine off, until they arrive, and hand it over only to them.
- agent/proposal: Asked operations to decide: Propose new delivery window to the customer
- agent/note → operator: Kasper has been told the roadside partner collects the car at 12:00 today and to stay with it until then. The CHANGE_PROMISE card is ready for an operator to approve — it proposes Friday 23 Oct 12:00–16:00 CEST to the customer.
- operator/decision: Approved "Propose new delivery window to the customer".
- operator/effect → customer: Sent to Marvellin Motorhandel (simulated): Dear Marvellin Motorhandel, As you instructed, the Bentley Continental GT (order CD-420322) remains stopped at the service area after the red warning light. Your roadside partner will collect the car from the service area at 12:00 today and take it to your Hamburg workshop. Because the car cannot reach Hamburg today, the delivery window agreed for today, 
- operator/effect: New delivery date proposed to the customer: Delivery promise: Fri 23 Oct 12:00–16:00 CEST (10:00–14:00 UTC), proposed to the customer (pending agreement). The promise only changes when the customer agrees.
- customer/message → agent: Friday 23 October 12:00-16:00 works for us, we agree to the new delivery date.
- system/note: Marvellin Motorhandel answered while the case was waiting on Marvellin Motorhandel's answer on the new date. Flagged for an operator.
- agent/note: Waiting on Marvellin Motorhandel's agreement to the proposed delivery window Friday 23 Oct 12:00–16:00 CEST.. Next check at 2026-10-21 10:01 UTC, in 60 min: When the customer agrees, an operator records the new promise; then update the delivery site and driver. If they propose a different window, negotiate. Check at 10:01 UTC.
- agent/note → operator: Waiting on Marvellin Motorhandel's reply to the Friday 23 Oct window. Kasper is set with the 12:00 collection. Check at 12:01 CEST.
- agent/lookup: Read the order record for CD-420322
- agent/lookup: Read the history of CD-420322 (20 entries)
- agent/proposal: Asked operations to decide: Confirm the agreed Friday window to the customer
- agent/note → operator: The customer's email answers the pending proposal: Marvellin Motorhandel agreed to Friday 23 October 12:00–16:00 CEST. No CHANGE_PROMISE card is proposed — the operator records the agreement in the delivery promise block, and the only card is the confirmation reply to the customer (CONTACT_CUSTOMER, ready to approve).
- operator/effect: Customer agreed to the new date (Delivery promise: Fri 23 Oct 12:00–16:00 CEST (10:00–14:00 UTC), proposed to the customer (pending agreement)). The promise is now changed. Evidence: Customer agreed by email.
- agent/lookup: Read the order record for CD-420322
- agent/lookup: Read the history of CD-420322 (20 entries)
- agent/note: Waiting on the owner's roadside partner collecting the Bentley at 12:00 CEST from the service area. Next check at 2026-10-21 10:16 UTC, in 72 min: Check at 12:15 CEST that the handover happened. Ask Kasper to confirm the car was collected and by whom. Then address Kasper's travel home and close out the driver's assignment.
- card [EXECUTED] CHANGE_PROMISE: Propose new delivery window to the customer
- card [PENDING] CONTACT_CUSTOMER: Confirm the agreed Friday window to the customer
