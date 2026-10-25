# Story customer

- ok: a customer's email gets a drafted reply for a person (Reply to Kavellora with current location and Monday estimate)
- ok: the draft speaks of no simulated data
- ok: nothing reached the customer without a person
- ok: /api/orders/ord-00584 renders (200)
- ok: /queue renders (200)
- ok: /orders/ord-00584 renders (200)

## CD-420584 · Message from Kavellora Car House [NEEDS_DECISION]

- customer/message → agent: Hello, can you tell us where our car is and whether it still arrives on Monday? We have a buyer coming at 14:00.
- agent/lookup: Read the order record for CD-420584
- agent/lookup: Read the history of CD-420584 (16 entries)
- agent/proposal: Asked operations to decide: Reply to Kavellora with current location and Monday estimate
- card [PENDING] CONTACT_CUSTOMER: Reply to Kavellora with current location and Monday estimate
