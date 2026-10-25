# Story C

- ok: the driver is told where the car and keys go (The handover instructions for Kavornia aren't confirmed for this car yet. I've a)
- ok: the agent closes it or brings one card (NEEDS_DECISION)
- ok: /api/orders/ord-00145 renders (200)
- ok: /queue renders (200)
- ok: /orders/ord-00145 renders (200)

## CD-420145 · Unconfirmed delivery handover at Kavornia Helsinki – driver 40 min out [NEEDS_DECISION]

- driver/message → agent: Hi, I'm about 40 minutes from Helsinki with the Porsche. Where do I leave the car and the keys at Kavornia?
- agent/lookup: Read the order record for CD-420145
- agent/note: Handing over to operations: The delivery handover at Kavornia Helsinki is unconfirmed for this order (access marked needs verification, no contact recorded) and the driver is about 40 minutes away; operations needs to verify exactly where to leave the car and keys before the driver hands them over.
- agent/message → driver: The handover instructions for Kavornia aren't confirmed for this car yet. I've asked our operations team to verify exactly where to leave the car and the keys. Please wait for our message before you hand anything over.
- agent/lookup: Read the order record for CD-420145
- agent/lookup: Read the history of CD-420145 (18 entries)
- system/tool_call: Approval gate stopped the agent: Not recorded: that quote is not on this case. Search travel options and choose one returned quote_id.
- agent/proposal: Asked operations to decide: Contact Kavornia Auto to confirm delivery handover at Kavornia Helsinki
- agent/note → operator: The proposal is recorded and waiting for an operator. Here's where we stand: **Case CD-420145** — Porsche 911 Carrera, Lahti → Helsinki. Driver Kasper Carvell is near Vantaa, about 40 minutes out from Kavornia Helsinki. He asked where to leave the car and keys. The delivery handover is unconfirmed: access is `NEEDS_VERIFICATION`, no contact name is recorded, and the site belongs to the customer Ka
- card [PENDING] CONTACT_CUSTOMER: Contact Kavornia Auto to confirm delivery handover at Kavornia Helsinki
