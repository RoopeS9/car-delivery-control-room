# Story H

- ok: a collection puts the order in transit (IN_TRANSIT)
- ok: the pickup photo becomes the pickup proof
- ok: the pickup step reads completed
- ok: a handover brings the customer's confirmation as a card
- ok: the order reads delivered (DELIVERED)
- ok: /api/orders/ord-00442 renders (200)
- ok: /queue renders (200)
- ok: /orders/ord-00442 renders (200)

## CD-420442 · Delivered: confirm to Vekarino Vehicle Group [NEEDS_DECISION]

- agent/proposal: Asked operations to decide: Tell Vekarino Vehicle Group the car was delivered
- card [PENDING] CONTACT_CUSTOMER: Tell Vekarino Vehicle Group the car was delivered
