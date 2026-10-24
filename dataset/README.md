# Control Room dataset

This is a fictional snapshot of a car-delivery marketplace. It is designed for
interface and agent prototypes, not as a copy of Bahn's database. Every dealer,
branch, pickup site, driver, order, conversation and event is authored or
generated for this challenge. City names and car makes/models may be real.
There are no source customer, driver, site, contact or vehicle identifiers.

The snapshot is at `2026-10-21T09:00:00Z`. Files under `data/` are newline-delimited
JSON, one record per line. The relationship model is a deliberately smaller
version of car-delivery operations. It does not include legacy mirrors or
projection tables.

This is a design exercise sample, not a measured production distribution.
One-off and private handovers are deliberately more common here than in the
company's recent operations, so teams can test how their interface handles
uncertain contacts, keys and release authority. Use the quiet orders to test
queue scale, but do not infer real-world case frequency or staffing from the
number of rows in this packet.

## Read the world

- `customers`, `drivers`, `vehicles`: marketplace actors and cars.
- `sites` and `addresses`: reusable dealer or yard profiles, and the actual
  endpoint address on each order. A private handoff can have an address without
  a managed site. Managed branches have different pickup and delivery steps,
  hours and release rules, though some site profiles lack recorded hours. A
  raw address may also name an unmodeled dealer branch; it does not automatically
  inherit a Place's access rules. Some cars move between branches of one
  fictional dealer chain.
- `order_endpoint_details` and `endpoint_claims`: order-specific contacts,
  access state, and attributed statements that may disagree.
- `orders` and `order_items`: what the customer requested; a trade-in is a
  separate item when present.
- `transport_plans`, `transport_points`, `transport_segments`: the route. An
  order can have an old replaced plan and one active plan. One order in this
  packet, CD-420702, routes through a staffed transfer yard with a separate
  driver assignment for each leg. Its second-leg booking is cancelled at the
  snapshot. Three orders (CD-420055, CD-420177 and CD-420455) have two drivers
  with live or completed work because the trade-in return segment is booked
  separately.
- `time_windows`: availability, selected pickup slot and delivery target are
  separate records with a source and time zone. A SYSTEM-calculated target or
  OPS selection is not evidence of customer approval.
- `market_offers`: what drivers could see and when it was published or taken.
  A bundle can cover multiple orders through priced lines. Its primary
  `order_id` is only the storage owner; use `order_ids` and `lines` to see
  the full scope.
- `market_offer_reach_checks` and `market_offer_demand_signals`: selected
  open-offer dispatch screening and explicit driver interest. A reach check is
  a point-in-time planning estimate, not a feed impression or proof of driver
  availability. A `VIEW` is a gig detail view; a `PASS` is an explicit pass.
  Neither action explains why a driver did not book on its own.
- `market_offer_demand_windows`: the bounded background sample of open offers
  for which synthetic detail VIEW/PASS actions are complete within the recorded
  window. It includes zero-view offers and several offer ages, route types and
  outcomes. It is not a calibrated production frequency sample.
- `work_assignments`: booked driver work, linked to an offer and segment. Some
  future jobs include the prior duty and the evidence available for positioning
  that driver; a home city is not treated as a current location.
- `travel_reservations`: booked vehicle ferries and driver-positioning travel.
  These can be changed or replaced. A timetable alone does not confirm
  check-in or boarding. A `HOTEL` reservation records a stay: `departure_at`
  is the check-in/start of stay and `expected_arrival_at` is check-out/end of
  stay; its explicit `check_in_at` and `check_out_at` fields carry the same
  times. This unified field naming does not mean the driver travelled at
  check-in.
- `assignment_steps` and `travel_confirmations`: pickup and handover anchors
  for every active driver assignment, plus detailed positioning itineraries for
  selected imports. A planned step does not prove physical movement. Purchased
  travel, gate observations, physical events and driver-reported arrival remain
  separate. A delivered car does not prove which ferry it took.
- `ferry_terminals`, `terminal_road_estimates` and `ferry_terminal_events`:
  fictional city-level terminal plans, coarse road estimates, and recorded
  gate observations. Only a gate observation can confirm or reject check-in.
- `custody_reports`: attributed driver reports during longer overnight
  journeys. They do not verify exact parking location or continuous custody.
- `custody_assets` and `custody_asset_events`: selected key sets, plate papers
  and an original paper CMR tracked per vehicle and order item, separately
  from the car's movement. This packet tracks one key set, on CD-420384. Plate
  papers and a paper CMR are described in the schema but have no rows here. An
  asset event records what a source reported or what a document state shows.
  It is not a physical transfer unless the event and its source say so. A
  linked prior or next order may explain why a driver is at a site without
  proving that the next car's keys were released.
- `proofs`: upcoming and overdue requirements, submitted and approved evidence,
  rejected submissions, and scoped human waivers (none in this packet). A
  small selection of linked file bytes is in `../attachments/`.
- `documents`, `order_notes`, `work_items`, `expenses`, `site_visits` and
  `incidents`: ordinary shift observations and follow-up checks as well as
  selected exceptions. A work item can be a routine check; it is not an
  incident or proof that the underlying source has been verified.
- `conversations` and `messages`: fictional exchanges. Each message identifies
  its sender, recipient, channel, visibility and time. A case workspace groups
  several external threads without implying that all participants saw the
  same message.
- `support_inbox_threads` and `support_inbox_messages`: separate unmatched or
  newly reconciled support mail. Candidate order IDs are hypotheses; only
  `linked_order_ids` are confirmed relationships.
- `agent_proposals`: suggestions tied to a target, evidence and a state
  dependency. They include different review and execution states. Only a
  linked effect event represents a committed change. Proposal text is never
  a source of truth for the order.
- `internal_notifications`: selected fictional internal room activity linked
  to alerts and proposals. The nine rows here are `POSTED`, `FOLLOWUP`,
  `OPERATOR_ACK` and `PROPOSAL_REVIEW` activities, and every one has
  `delivery_state` `RECORDED`. Suppressed or failed deliveries can occur in the
  generator but none is in this packet. A room post is not an external driver
  or customer message.
- `tracking_observations` and `alerts`: imperfect signals that may need
  investigation, not verified diagnoses. Some alerts have acknowledgement or
  resolution history. The trajectories include stops, delayed uploads and
  stale gaps. A driver report is not a location fix.
- `travel_options`: quoted or unavailable alternatives. A quote is not a
  `travel_reservation`, which records a booking. Each option is an observation
  at `checked_at`; availability can change after that time. Twenty-seven of
  the 37 checks here were made in the two hours before the snapshot. The rest
  are one to five days older.
- `operational_events`: a simplified append-only history of lifecycle changes,
  recorded assessments and selected work decisions. It is not a complete audit
  log of every field or every contact.

## Finding cases

Start with the order stage and read the active plan, selected windows and
assignments. Then look for linked conversations, alerts, work items, proposals
and evidence. Some orders have none of these because routine work is part of
the world too. For a more involved case, find an order with several kinds of
records, an older plan, a related order, or a claim whose source changed over
time. Follow the record links and timestamps before deciding which statement
is current. Counts and status labels alone do not identify a safe next action.

`orders.status` uses the four current operational statuses: `NEW`,
`WAITING_FOR_PICKUP`, `IN_TRANSIT`, and `DELIVERED`. `readiness_status` persists
through the lifecycle; it controls availability work while the order is `NEW`.
`CONFIRMED` means collection availability was established, not that every
contact, gate or key instruction is verified. Check each endpoint detail
separately, especially before a driver travels.
Missing contact fields are common in this snapshot. Their absence alone is
not an incident or a reason to contact every driver: use the order's stage,
selected slot, assignment and recorded handover to decide whether a check is
due. After delivery, a pre-handover `UNCONFIRMED` value is historical unless
another current record makes it relevant.
`cancelled_at` is separate. A useful UI lane must be
derived from these facts plus offers and assignments; `display_lane` is included
only as a convenience for the optional starter and should not be treated as a
source of truth.

The primary vehicle can have a `DELIVERED` order status while a second
`TRADE_IN` item and its return segment are still moving. Replaced plans and
cancelled assignments remain in the files; use the active plan and current
assignment when showing present work, and the event log when explaining how it
got there. An order can have several offers and assignments over time.

All timestamps are ISO 8601 UTC. Site hours and windows carry an IANA time
zone. One-off address hours may be unknown or appointment-based. A future
appointment can be known at the snapshot time, but no recorded
event or message occurs after it. Message claims are not automatically verified
facts. An alert is a signal, and a submitted proof is not necessarily approved.
`orders.updated_at` is the latest recorded operational event for that order;
it is not the most recent conversation or note activity. A worklist needs to
consider messages and alerts separately.

## Check the files

From the packet folder, run `python3 check_packet.py`. It checks record counts,
core links, attachment links and file hashes. It does not judge operational
choices or certify that every case is realistic.

## Scope and limits

The participant snapshot has 100 orders: 12 intake, 12 ready, 11 on market, 18
booked, 24 moving, 21 delivered and 2 cancelled. Forty-six fictional customer
accounts are in the packet. Forty-four of them place these orders and two
appear only as site profile customers. They range from large dealer groups to
one-order buyers across Finland, Germany, Denmark, France and the Netherlands.
The orders include domestic deliveries, cross-border moves in northern and
western Europe, dealer-to-dealer transfers, private handovers, three trade-ins,
one relay through a transfer yard, two replaced plans and three cancelled
driver bookings. This mix gives prototypes work in several stages; it is not a
measured production distribution.

Seventy orders have no recorded alert, incident, endpoint claim, open work
item or open conversation at the snapshot. They still include normal travel,
costs, documents, proofs and completed communication. The selection behind this
packet treats 60 orders as ordinary and 40 as case histories, including linked
orders and resolved issues. Some case orders are quiet by that five-signal
count because their issue is already closed or sits in another record, such as
a replaced plan, a cancelled booking or a custody follow-up. The vehicle mix
deliberately favours sports, performance and flagship luxury models. This is
an enriched challenge sample rather than a measured production distribution.
Conversation topics and their frequency should not be used to estimate Bahn's
support workload. Tracking is coarse and sometimes
missing; travel prices, schedules, site hours and driving distances are
fictional approximations. The attachment folder contains 58 selected files,
linked through its manifest. These are examples, not
complete photo archives for every proof record. Some provider outcomes and
handover authorities remain unknown at the snapshot time.
Four intake orders lack a basic input: one has no recorded vehicle identity,
two have no pickup contact, and one has no street address. The first has a
support request and an owned follow-up, but the missing identity is still
missing. One of the contact gaps is linked only from the support inbox and has
no work item yet. Selected open
support cases show delayed replies, handoffs and named next checks; those
examples do not measure response times or staffing across the marketplace.
