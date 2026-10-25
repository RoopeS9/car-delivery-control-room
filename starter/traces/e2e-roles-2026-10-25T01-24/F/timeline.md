# Story F

- ok: a silent driver ends with a card for a person (Call William Mervalen on his phone?)
- ok: the card title fits the queue
- ok: /api/orders/ord-00537 renders (200)
- ok: /queue renders (200)
- ok: /orders/ord-00537 renders (200)

## CD-420537 · Engine over-temperature (P0217), driver instructed to stop [NEEDS_DECISION]

- obd/dtc: Engine temperature warning on. Trouble code P0217. Coolant 116.4 °C and rising; the car was moving at 121 km/h.
- agent/lookup: Looked up P0217: engine coolant over-temperature, stop now
- agent/lookup: Read the car's trouble codes: P0217, check-engine light on
- agent/message → driver: William, please slow down and stop at the next safe place, then switch on your hazard lights.
- agent/message → driver: Please switch the engine off and leave it off.
- agent/message → driver: William, are you stopped somewhere safe with the engine off? Tell me where you are and what you see on the dashboard.
- agent/message → driver: William, we haven't heard from you. Are you stopped somewhere safe with the engine off? Please let us know where you are.
- agent/note → operator: Reminder sent. No reply from William Mervalen since 09:02 UTC — now six minutes without acknowledgement after a STOP_NOW instruction. The case is still waiting on the driver.
- agent/lookup: Read the order record for CD-420537
- agent/lookup: Checked the car's dongle and the driver's phone for the last 15 min
- agent/lookup: Read the history of CD-420537 (20 entries)
- agent/proposal: Asked operations to decide: Call William Mervalen on his phone?
- agent/note → operator: Escalated. William Mervalen has not responded for 13 minutes after two STOP_NOW instructions and a reminder. The car was still moving at 78 km/h at the last OBD sample, coolant at 124 °C and climbing, and then the dongle went completely silent. The operator should call him on his phone now.
- card [PENDING] OPERATOR_DECISION: Call William Mervalen on his phone?
