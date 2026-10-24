# How car delivery operations work

This is a guide to the fictional challenge world. It is based on the kinds of
work Bahn handles, but the companies, people, places, orders and messages in
the packet are invented. The starter screens are mockups, not screenshots of
Bahn's software. Truck work is outside this challenge.

## The job behind an order

A customer asks us to move a car from a pickup address to a delivery address.
Most ordinary handovers use a managed dealer or yard. This sample gives extra
space to one-off and private handovers because their access and authority can
be harder to settle; they should not dominate a design for the whole company.
An order may start with uncertain facts: which branch has the car, when it can
be released, who has the keys, who can receive it, and whether a signed release
is needed. A plan names the route and the car. An offer makes a piece of work
available to drivers. An accepted offer creates a driver assignment.

The physical trip has its own evidence. A booked driver is not a collected car.
A collection scan is not a verified statement about the entrance that was
used. A ferry booking is not a boarding scan. A delivered car may still lack a
signed handover, have a contested condition claim, or have a trade-in return
still moving. The records keep those distinctions on purpose.

## What operators see today

Order work is commonly viewed in lanes: new or preparing, ready, on the driver
market, booked, moving, delivered, or cancelled. Lanes are useful for seeing
volume and broad progress. They do not by themselves answer which order needs
a person right now. The optional starter begins with a board to show the
data, not to prescribe the final interface.

Much of the surrounding work happens in conversations. Drivers ask about keys,
travel, costs and changed plans. Customers and dealers correct addresses,
opening hours and delivery requests. Support conversations have historically
sat apart from the order tool; operations alerts often appear in Slack. Bahn is
working toward a more connected way to see orders, conversations, alerts and
agent work. Your prototype can propose how those pieces should meet.

Agents already help with some routine work, including publishing reviewed
open offers for simpler domestic orders and detecting possible problems in
moving work. The recorded proposals show how Bahn records agent work and what
operators decided, not what a team's agent should propose. Agents can make
an order quieter when the facts line up. They can also make an exception harder
to understand if a quote is treated as a booking, a driver message as a fresh
location, or an old instruction as the current plan. The challenge is to make
the evidence and authority behind an action visible when it matters.

## Decisions worth designing around

- **Readiness:** Which facts are sufficiently confirmed to offer the work, and
  which statement came from the customer, site, driver, app or operator?
- **Dispatch:** Who accepted the current offer? Was an earlier booking cancelled?
  Does the assigned driver have a credible way to reach pickup after another
  duty?
- **Travel:** Which ferry or train is booked, which is only quoted, and which
  connection is at risk? A timetable alone cannot prove physical movement.
- **Live monitoring:** Is a car likely to miss a promise, or is the signal stale?
  What should the agent ask before raising the issue to a person?
- **Communication:** Who needs an update, what can be said as fact, and which
  change needs the customer or site to agree?
- **Handover:** What evidence shows the car and keys changed hands? Which files
  are submitted, reviewed or still missing?

A good design need not show all of this at once. It should help a person see
the few relevant facts, their sources and times, the work an agent has already
done, and the next decision. If an agent proposes an action, show what it
would change and who can approve it. An agent may sensibly stop and ask for
missing evidence. A person may reject an agent's suggestion without losing the
case history.

## What is safe to assume in this packet

The JSONL files are one fixed snapshot. There is no live clock, real booking
tool, or external customer. Participants can simulate an action locally and
explain its effect. The files contain enough structure to build workflows, but
they deliberately leave some answers unknown. The event log and ordinary notes
are selected examples, not a full record of every shift action or support
contact. `dataset/SCHEMA.md` explains
the record links and evidence boundaries. Search across several orders to
test whether an idea works beyond one example.

Orders can arrive through web and API intake on any day, including weekends.
Some planning and shift actions also happen over the weekend in this fictional
world. Physical handovers still depend on the site hours and the selected slot.
