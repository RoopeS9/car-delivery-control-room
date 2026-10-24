# The life of a delivery, and where it breaks

Static context for people and coding agents working on the Bahn control room.
Everything below is derived from `dataset/` (100 orders, snapshot
2026-10-21T09:00Z) and the brief. Counts are from this packet, which is
enriched with odd pickups on purpose; use the brief's "normal week" list for
weights and the packet as test fixtures.

## 1. Four patterns that explain almost every case

1. **Claim vs proof.** Every pair of records is a weaker and a stronger
   statement about the same thing. Treating the weak one as the strong one is
   how the agent makes a case harder, not easier.

   | Weak (a statement) | Strong (evidence) |
   |---|---|
   | travel_option (quote) | travel_reservation (booking) |
   | travel_reservation (booking) | ferry_terminal_event (gate scan) |
   | work_assignment ASSIGNED | vehicle.picked_up event |
   | driver message "I'm near X" | tracking_observation (and even that is coarse, no coordinates) |
   | site profile CONFIRMED | site reply about this car, this key set, this slot |
   | endpoint_claim | resolved claim with cited evidence |
   | proof SUBMITTED | proof APPROVED |
   | expense APPROVED | money moved (not in packet) |
   | alert OPEN / ACKNOWLEDGED | alert RESOLVED with evidence |
   | support_inbox candidate_order_ids | linked_order_ids |
   | agent_proposal APPROVED | execution.effect_event_ids |
   | SYSTEM or OPS delivery window | CUSTOMER-sourced promise |

2. **A deadline passes silently.** Slot started with no driver booked; slot
   ended with no pickup; ferry check-in cutoff; promise end; `next_check_at`
   on a waiting thread; offer booking cutoff; staffed yard release window.
   The packet has all of these. None needs a model to detect.

3. **Two records disagree.** Address vs note (brief), booking says showroom
   vs sheet says yard (CD-420347), site profile says side gate vs customer
   says reception (CD-420516), plate vs carrier manifest (CD-420342), photo
   set vs VIN (CD-420071), delivery promise vs app ETA (CD-420322). Also
   detectable in code once both facts are structured.

4. **One slip starts a chain, and each hop changes who approves.** Missed
   ship → new sailing (quote, agent may look) → hotel (cost, operator
   approves) → later delivery (promise, customer approves) → message to
   receiver (customer contact, operator approves, agent drafts). CD-420584 in
   the team's scenario A has every hop available in the data.

A fifth, smaller one: **who is waiting on whom.** `waiting_on` on threads,
`owner` on work items. The queue is really a list of blocked waits.

## 2. Who may decide what

| Change | Who says yes | Agent may |
|---|---|---|
| Delivery promise, date, slot | Customer (via operator) | Draft, compare options |
| Money: tow, hotel, rebooking, expense | Operator | Quote, collect receipts |
| Release of car or keys | Site, with seller's signed authority | Ask site, never assert |
| Receiver identity at delivery | Customer names them | Ask, record claim |
| Driver safety ("stop now") | Agent, immediately | Instruct, log |
| "Keep driving" | Operator | Never alone |
| Recovery of a broken car | Car owner (customer) | Gather facts, draft talking points |
| Message to a customer | Operator, always | Draft only, replies included |
| Question to driver or non-customer site | Agent | Ask freely |

In this packet the delivery site belongs to the paying customer on 63 orders,
the pickup site on 4. Receiving dealers are customers; pickup desks mostly
are not.

## 3. Stages and what goes wrong at each

Stage names follow the order status plus offers and assignments, not
`display_lane`.

### Intake (NEW, PREPARING) · 12 orders
Missing inputs: no VIN or plate (CD-420009), no pickup contact handle
(CD-420010), no street address (CD-420023), unnamed key releaser (CD-420015).
Unmatched support mail (5 inbox threads: one with two candidate orders, one
quoting another account's reference).
*Agent alone:* ask the customer-facing desk for the missing input via an
operator-approved draft; match inbox mail to candidates. *Person:* link a
thread when identity is in doubt.

### Readiness (NEW, CONFIRMED) · 23 orders
`CONFIRMED` means availability was established, not that contact, gate and
keys are verified. 75 of 200 endpoint details are UNCONFIRMED contact with
NEEDS_VERIFICATION access. Seller date slips (CD-420656). Commercial hold on
release (CD-420458). Cancellation before pickup (CD-420419).
*Agent alone:* call-ahead to the pickup site, confirm readiness and papers
(the brief's "pickup readiness by phone" area). *Person:* decide to publish
an offer on weak facts.

### Market (offer PUBLISHED) · 11 orders
Offer past its booking cutoff but still PUBLISHED; offer live while the car's
location is in doubt (CD-420347); fee negotiation by email (CD-420404);
directed offer not viewed in its five-minute window.
*Agent alone:* report reach and views, flag cutoff. *Person:* withdraw,
reprice, direct to a named driver.

### Booked (ASSIGNED) · 18 orders
Driver cannot reach pickup after the prior duty and rest (CD-420399). Driver
unwell, will confirm by evening (CD-420449). Driver has no travel booking,
only a suggested route (CD-420154, CD-420299). Site needs a separate document
set per car (CD-420689, CD-420941). Two-car plan with unclear second key
handover (CD-420413, CD-420384). Pickup slot ends with no pickup recorded.
*Agent alone:* confirm the driver's start position and travel, ask the site
who releases keys, prepare a backup list. *Person:* reassign, accept a later
slot (customer must agree).

### Pickup (at the site) · 2 failed visits in packet
Car not in the release queue (CD-420593, CD-420201, both VEHICLE_NOT_FOUND).
Reception has no keys and the side gate is not a desk (CD-420516). Driver
photographed the neighbouring car (CD-420071). Staffed transfer yard window
missed, car still on the yard register (CD-420702). The biggest open
category: 11 open pickup_and_release threads and 7 of 15 work items.
*Agent alone:* keep the driver from taking a substitute car, ask stock
control, time-box the driver's wait. *Person:* send the driver home, cancel,
rebook.

### Moving (IN_TRANSIT) · 24 orders
Ferry sold out (CD-420299, CD-420154). Queue may miss the cutoff (CD-420603).
Gate rejected: presented after cutoff (CD-420194); plate did not match the
manifest (CD-420342). Red warning, driver stopped (CD-420322, the only
breakdown in the packet). No app position during the ferry window
(CD-420020) or at all (CD-420322). Overnight rest with keys and car with the
driver (five custody reports). Delivery slot will be overrun (CD-420675).
Receiver only available until early afternoon (CD-420437).
*Agent alone:* safety instruction, ask where and whether safe, look up
codes, check cutoff vs ETA, fetch later sailings as quotes, acknowledge rest
reports. *Person:* tow vs owner's assistance, hotel cost, rebook, change the
promise (customer).

### Delivery (handover) · 43 planned delivery steps
Nobody authorised to receive and sign (CD-420437, CD-420014). Receiver away
over the weekend (CD-420342). Car arrives outside the promise.
*Agent alone:* confirm the named receiver from the customer's authorisation,
remind the driver not to leave car or keys unattended. *Person:* approve a
new attended slot.

### After delivery (DELIVERED) · 21 orders
Signed handover missing while photos exist (CD-420164). Mark reported after
delivery, origin unverified (CD-420055, CD-420455). Invoice reference query
(CD-420194). Expense corrections and duplicates (CD-420326); 38 of 86
expenses still SUBMITTED. Trade-in return still moving after the primary is
delivered (CD-420177).
*Agent alone:* collect pickup, delivery and customer photos side by side;
chase the signed record from the receiver (customer, so draft only).
*Person:* attribute damage, approve or reject expenses.

## 4. What drivers actually write in (33 driver messages)

| Kind | n | Routine? |
|---|---|---|
| Connection, slot or cutoff at risk | 6 | No: chain starts |
| At the site, car or keys not found / which car | 5 | No: hold the driver, ask the site |
| Overnight rest, car locked, keys with me | 5 | Yes: acknowledge, record custody, ask for morning ETA |
| Expense, fee or payout question | 5 | Yes mostly: answer from records, file as proposal |
| Is my travel or ferry booked? | 3 | Yes: answer from reservations, say what is only quoted |
| Unwell or availability doubt | 3 | No: backup driver decision |
| Breakdown or warning | 3 | No: safety tier then person |
| Condition or evidence dispute | 2 | No |
| Other | 1 | |

Routine is roughly 40 percent. The rest need a person, but the agent can do
the first five minutes of each: confirm safety, confirm the facts it already
holds, ask the one missing thing, and show the chain.

## 5. What goes into the sink (the context packet)

Static, cached first:
1. Principles: the four patterns, the authority table, the safety tier, the
   customer rule.
2. Source ladder from section 1, as the rule for every source chip.
3. The playbook for the detected situation.

Per order, fetched at case open:
4. Order packet: vehicle, active plan with points, selected slot and promise
   with source, assignment and driver, travel reservations with status and
   cutoff, open travel quotes, site access notes and contact status, open
   alerts, work items, open threads with `waiting_on`, last tracking
   observation with age, custody assets.

Live, appended as they arrive, each with actor, channel and time:
5. Driver turn (chat or voice transcript), driver photo, OBD snapshot
   (simulated), GPS sample (simulated), site reply, customer message
   (read-only for the agent), operator decision or instruction, and timer
   events: slot start, slot end, cutoff minus 2 h, promise end,
   `next_check_at`.

Out:
6. Question to driver or site, safety instruction, lookup, proposal with
   evidence refs, escalate, close.

OBD belongs in row 5 as one more attributed source with a severity hint. It
is a trigger and a fact, not a diagnosis; three or four fault signatures
cover the demo.
