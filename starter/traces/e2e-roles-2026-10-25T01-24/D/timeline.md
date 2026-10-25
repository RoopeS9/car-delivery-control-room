# Story D

- ok: the desk gets an answer about this order (Hi Uma, Yes, your driver Kasper is booked for the Bentley pickup. The slot is t)
- ok: no promise to keep the desk posted
- ok: the answered question does not wait on the desk (HANDLED_BY_AGENT)
- ok: /api/orders/ord-00442 renders (200)
- ok: /queue renders (200)
- ok: /orders/ord-00442 renders (200)

## CD-420442 · Question from Uma Aldermere, Orvendin Cars Stockholm [HANDLED_BY_AGENT]

- site/message → agent: Hi, this is Uma at the Orvendin Cars desk. Is your driver still coming tomorrow morning for the Bentley?
- agent/lookup: Read the order record for CD-420442
- agent/note: Handled by the agent: Answered Uma at Orvendin Cars Stockholm: driver Kasper is booked, pickup slot confirmed for Thu 22 Oct 10:00–13:00 CEST.
- agent/message → site: Hi Uma, Yes, your driver Kasper is booked for the Bentley pickup. The slot is tomorrow, Thursday 22 October, between 10:00 and 13:00. That slot was selected by our operations team. No journey start is recorded yet — which is normal the day before — so I don't have a live position to share right now, but everything on our side still points to tomorrow morning as planned.
