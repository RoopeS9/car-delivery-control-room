# Reading the fictional operations records

Each line in `data/*.jsonl` is one record. The files are one snapshot at the
time in `data/manifest.json`, not a sequence of daily exports. IDs are keys
within this packet; do not infer operational meaning from their spelling.
Missing keys and `null` are meaningful. Timestamps are UTC unless a field
explicitly carries a time zone.

The schema below describes every state the data can have, and several of
those states have no rows in this packet. For example, this packet has no dismissed alert,
waived proof, paper CMR, superseded CMR template, migrated proof requirement,
carrier amendment, recurring alert linked by `source_alert_id`, rejected or
expired directed offer, `NEEDS_EXTERNAL_INPUT` work item, `historical_site_rule`
detail, or custody chain with a verified handover. Treat such states as
possible, not as present, unless a row shows them.

## Orders and routes

`orders.customer_id` joins `customers`. `order_items` joins an order to its
`vehicles`; an order has a primary item and may include a separate trade-in.
`orders.customer_id` is the contracting customer for that order.
`sites.customer_id` is a site profile's associated customer and may be a
different account at a pickup dealership; it does not grant access to every
order using that site. Scope order access to the order and the recipient's
role, including when a site contact participates in a handover.
`orders.active_plan_id` identifies the current `transport_plans` row. A plan
contains ordered `transport_points` and `transport_segments`. A segment moves
one item between two points. Older plans and cancelled work remain in the
files as history. Read the active plan before presenting a current route.
Some booked orders change after acceptance: the old plan, offer and cancelled
assignment remain visible beside the accepted replacement. A moving order can
also have a draft alternative while its original plan remains active. None is
in this packet, where every `DRAFT` plan belongs to an intake order. A draft
is not a changed customer promise or physical movement. Read the approval,
driver acceptance and travel evidence before treating a new route as executable.

The plate or an endpoint contact can be unrecorded in any lane; a VIN is present
for most cars. Four intake records isolate missing inputs: one vehicle
identity, two pickup contacts and one one-off pickup street. `null` means that
input has not been supplied. The city, country and time zone remain
available for broad planning, but a selected slot or route distance does not
establish the missing street address or prove that collection happened.

Each point has an `address_id`. A `site_id` appears when that address has a
reusable dealer or yard profile. The order's pickup and delivery address IDs
copy the primary route endpoints. Some routes include an intermediate transfer
point and different drivers for successive segments. An event at an
intermediate point does not describe the final customer handover.

Managed sites can have different access notes and rules for pickup and
delivery. `order_endpoint_details` contains order-specific contacts and
access state. `endpoint_claims` holds attributed statements about those
details. Claims can disagree with each other or with a site profile; their
resolution status and cited evidence matter. A physical pickup or delivery
event, even with driver photos, does not by itself verify a stored entrance,
receiver identity or contact instruction. Those fields need their own
attributed source. After a completed handover, an old unconfirmed pre-handover
detail is historical. Do
not raise a fresh access task from that status alone; inspect custody, proof
and any current claim to decide whether follow-up remains.
For a claim with `source_type=HANDOFF_CONTACT`, `source_id` points to the
contact's message in this packet. It records what that person reported, not
their authority to change a customer instruction. Follow the message and any
later customer authorization before accepting the proposed handover.
When `last_confirmed_source=MANAGED_SITE_PROFILE`, `CONFIRMED` describes the
standard site profile available when the order was created. It is not a call
about this car, key set or appointment. Other sources such as a site reply or
driver handover refer to narrower, order-specific evidence. Show the source
alongside the status before relying on it for a collection decision.
An access instruction can remain `CONFIRMED` from a site profile while the
named contact is `UNCONFIRMED`; in that case `last_confirmed_at` may be empty
because no one has verified that contact for this order.
A resolved access-route alert can likewise leave a separate release-contact
check open. Read the endpoint detail and owned work before treating the entire
pickup as ready.
`historical_site_rule=true` marks a directly sourced instruction that applied
to an earlier completed handover after the shared site's standing procedure
changed. A direct reply about an entrance may be narrower than the site's full
receiving or release procedure; a driver step can show both.

`time_windows.point_id` attaches a window to a plan point. Purpose and
`is_selected` distinguish broad availability, a working pickup slot and a
delivery target. `source` records who supplied or selected it. A system
estimate or operator selection does not prove customer approval. Compare the
window's time zone with its UTC start and end timestamps.
`REQUESTED_PICKUP_SLOT` and `REQUESTED_DELIVERY_SLOT` rows are customer
preferences, not selected work or agreed promises. A selected delivery target
may also carry `commitment_deadline_at`, `deadline_source` and
`deadline_stated_at`; that outer limit is distinct from the target range and
from an ETA.

## Offers, assignments and travel

`market_offers.segment_ids` identifies the work shown to drivers.
`work_assignments.source_offer_id` and `segment_ids` identify booked work.
Offers and assignments have their own status and history; a driver's message
about taking work does not create a booking. A bundle offer may cover several
orders. For `type=BUNDLE`, use `order_ids` and priced `lines` to understand
membership; its singular `order_id` is only the filing location.
`visibility=DIRECTED` has a separate `market_offer_exposures` row naming the
recipient driver, decision deadline and delivery evidence. `SHOWN` means an
exposure was created, not that a notification reached the driver. `NOTIFIED`
records delivery, `VIEWED` records an app view, and `REJECTED`, `EXPIRED` and
`ACCEPTED` are recipient outcomes. An offer is withdrawn separately after a
rejection or expiry when Ops decides to publish it elsewhere. One directed offer
may have a sequence of different recipients; only one has a live five-minute
decision window at a time. An ordinary offer can pass
its booking cutoff while its stored status is still `PUBLISHED`; it must be
withdrawn before a replacement is posted. Read offer and exposure histories
separately. A published directed offer is not an assignment.

`market_offer_reach_checks` is a selected set of fictional dispatch screening
snapshots for open offers. `screened_driver_count` is the group considered at
`checked_at`; `provisionally_pickup_suitable_count`,
`audience_matched_count`, and `feed_accessible_count` form a narrowing planning
funnel. These are attributed estimates within `window_start_at` to
`window_end_at`, not instrumented feed impressions, verified current driver
positions, or proof anyone was willing to book. The full rules and per-driver
exclusions are not supplied. A linked `attributed_message_id` supplies one
driver's stated concern, not a market-wide explanation.

`market_offer_demand_signals` records selected explicit open-offer app actions.
`VIEW` means the driver opened the gig detail, not that the offer merely appeared
in a feed. `PASS` means the driver explicitly passed and has a prior `VIEW` in
this sample. The same driver can contribute at most one of each kind per offer.
These records do not include reasons. Compare an attributed driver message and
offer history before describing a fee concern; repricing alone does not prove
why an offer lacked a booking. The absence of a signal is not evidence of no
exposure or no interest.

The three `EDITORIAL_CASE` signals belong to two hand-authored offers on one
order, CD-420404.
`BACKGROUND_SAMPLE` signals belong to `market_offer_demand_windows`, a bounded
fictional slice across open offers with different ages, routes and lifecycle
states. A window's `view_count` and `pass_count` include all synthetic app
actions supplied for that one offer between `window_start_at` and
`window_end_at`. A zero means no detail action in this fictional window. It
does not mean nobody saw a feed listing. Accepted offers can have views before
acceptance; withdrawn offers retain views from before withdrawal. The
background slice was designed to give prototypes varied workload and is not
calibrated to source marketplace rates or a complete driver audience.

Offer fees are fictional planning values, not observed market prices. The
packet has selected directed-recipient exposures and a bounded open-offer
reach and detail VIEW/PASS sample, but no full driver feed, impression,
audience, bid or decline history for ordinary open offers. A missing exposure
does not mean no driver saw an open offer; zero recorded detail views does not
mean nobody saw it listed. The packet also omits personalized driver pricing
and complete eligibility checks. A dispatch prototype can reason about
recorded offers, bookings, timing and missing evidence, but should not claim
it has measured marketplace demand or a complete pricing policy.

Selected `market.offer_assessed` events record an operator's review of a live
offer. Their `changes.evidence_refs` link the specific offer, reach check,
exposure, message or other source used. A review can leave the offer alone or
open an owned dispatch task; it does not itself change price, visibility,
acceptance or booking. Read the current offer and any work item separately.

A cancelled assignment records either `PAYOUT_DUE` or `NO_PAYOUT` for the
assignment fee. This is a separate decision from a driver's submitted travel,
parking or other expense. `PAYOUT_DUE` does not mean money has been paid, and
an approved expense does not reinstate the cancelled assignment's fee. Read
the cancellation event for the decision and the expense row for its own review
state.

Some assignments include `positioning`, which links the driver's preceding
duty and the evidence available for reaching the next pickup. A planned
release city and tracking ETA are not a current driver location. Travel quotes
in `matching_quote_ids` are separate from purchased reservations in
`positioning_reservation_ids`. `earliest_positioning_departure_at` is an
estimate from the previous duty's ETA and handover buffer. Where a driver has
reported a later availability time, the projection uses that later time and
links the message in `driver_report_message_id`. The reported time is still an
attributed claim, not a verified location. For other assignments, position may
be unknown.
One selected assignment carries `driver_history`, which links a prior duty and
its recorded outcome to the next gig. A prior delivery city is a past
observation; `current_location` remains unknown. A cancelled duty supplies no
release location.

`travel_options` are capacity checks or quotes observed at `checked_at`.
`travel_reservations` record bookings. Availability can change, and a booking
does not prove check-in or boarding. Ferry records include scheduled
terminals, check-in cutoffs and arrival estimates. `ferry_terminals` and
`terminal_road_estimates` are planning data, not live positions.
Some ferry bookings carry `carrier_amendments`: a carrier-origin notice with
its own issue and receipt times, booking reference, vehicle-space status and
message. It changes the named reservation only. It does not establish space
or a booking on a proposed replacement sailing.
Booked lodging is also a travel reservation; it does not prove a driver stayed
there or create a driver expense claim.
`ferry_terminal_events` record gate observations when present.
`travel_confirmations` are attributed driver reports. Read their sources before
treating them as independent confirmation. For a whole positioning itinerary,
`from_city`, `to_city`, `departure_at` and `expected_arrival_at` describe the
journey's endpoints and full duration. `kind=FLIGHT` names its main mode, not a
nonstop service between those cities. The route label identifies ground legs;
`connection_count` on a quote can indicate a transfer without listing every
intermediate leg.

`assignment_steps` gives pickup and handover anchors for active assignments;
selected journeys have more detailed travel steps. A `PLANNED` step can cite a
purchased ticket without proving travel occurred. Evidence links and step
status should be read separately. `custody_reports` are attributed driver
statements, not continuous observation of a vehicle.
Selected assignments also have `CALL_AHEAD`, `PLATE_PAPERWORK_CHECK` or
`DIGITAL_CMR_CHECK` steps before handover. They cite a site instruction,
endpoint detail or prepared document. `UNVERIFIED` means the step is due but
its completion is not evidenced; the cited instruction is not proof of a call,
paperwork check or signature.

`custody_assets` gives a current, source-attributed view of selected movable
things: keys, plate papers and an original paper CMR. Each asset has an
`order_id`, `order_item_id`, `vehicle_id`, optional `related_order_id`,
responsible assignment, current holder claim and source references. An open
asset has an owned next check. A key count or asset identifier is null unless
a source establishes it. Its
`custody_asset_events` are chronological observations about that asset.
`REPORTED_UNVERIFIED` and `DOCUMENT_RECORD_ONLY` are deliberately weaker than
a verified physical handover. The one chain here uses the still narrower
`QUESTION_ONLY`, `INSTRUCTION_ONLY` and `FOLLOWUP_ONLY`. A vehicle pickup or
delivery event proves car movement at that boundary; it does not by itself
count keys, identify who accepted plate papers or sign a paper CMR. The one
chain in this packet is a key set for the second car of a two-car driver plan
on CD-420384. It has no handover evidence and an owned follow-up.

## Evidence and work still open

`proofs` tracks requirements, submissions and reviews at route points.
Most requirements are attached to a pickup or delivery point. Selected key
and paper CMR captures also name an `assignment_step_id`, so teams can tell
which handover action produced the evidence. A point-level requirement alone
does not identify its photographer or resolve a custody dispute.
`REQUIRED` has no accepted submission; `SUBMITTED` awaits review; `REJECTED`
retains a submitted file and reason; `APPROVED` is accepted evidence. A
`WAIVED` requirement has its own authority and scope. Physical handover does
not automatically satisfy every proof requirement. `documents` separately
tracks forms, release authority and signed handovers. On selected import orders,
a CMR document's `medium` is `DIGITAL` or `PAPER`. A digital CMR's
`signature_scope` is `NONE` until collection and `COLLECTION_ONLY` after its
collection acknowledgement is filed. `SIGNED` by itself does not mean the
receiver signed. A paper CMR's `signature_scope` is `NONE`, `SELLER_ONLY` or
`BOTH`. These describe the central paper filing; `BOTH` records two handover
marks, not a verified name or authority for the receiver. Inspect the endpoint
contact and document itself before treating it as a complete recipient check.
An unsigned CMR template can be superseded by a corrected template before
pickup. `template_vin`, `current_for_handover`, `supersedes_document_id` and
`superseded_by_document_id` identify the two document versions; neither is a
signed original. A seller stamp with an empty date field, or a receiver stamp
whose signer is disputed, needs its own attributed follow-up. A direct site
statement about vehicle identity does not turn rejected condition photos into
approved pickup evidence.
Pickup and delivery CMR proof captures remain separate records. An open,
unsubmitted key proof requirement can move from a cancelled assignment to a
replacement step. `migration_history` and `proof.requirement_migrated` retain
the old step, point and deadline; submitted evidence is never moved this way.
`expenses` distinguishes
a submitted cost from payment; payroll and invoices are outside this packet.
Most cost rows belong to a driver assignment. `service_at` is when the cost was
incurred, `submitted_at` when the claim entered review, and `reviewed_at` when
an operator made a decision. `APPROVED` means the claim was accepted, not that
money moved. `SUBMITTED` still needs review; `REJECTED` records a decision;
`SUPERSEDED` retains an older submission linked to its correction. The
`receipt_count` and `receipt_state` describe claimed evidence. Selected flight
costs have `payer=BAHN`, a linked booked `reservation_id`, and
`submission_source=CENTRAL_RECEIPT_MATCHER`; they have no driver claimant and
are not reimbursement requests. Other generated expense rows are driver claims.
`ATTACHED_SAMPLED` has at least one inspectable fictional PDF in the attachment
manifest; `ATTACHED_NOT_SAMPLED` has no supplied bytes. `MISSING` records no
receipt. An expense may claim several receipts while only one sample is supplied.
Amounts are in minor units of `currency`; some fictional costs are in DKK.
No exchange-rate or payout ledger is included, so do not treat the DKK number
as euros or infer a settled reimbursement.
A release authority names the driver and handover point for the leg beginning
at its collection point. On a relay order, that point can be a staffed transfer
yard rather than the customer's final destination.

`../attachments/manifest.json` joins selected file bytes to records such as
documents, proofs, messages and site visits. A proof's `file_count` can exceed
the number of sample files supplied here. Check the manifest before assuming
that a file is available in the packet.

`site_visits` and `incidents` record selected attempts and exceptions. A
site visit is not necessarily a successful collection. `tracking_observations`
contain coarse progress and ETA signals with separate `observed_at` and
`received_at` times. This packet does not provide map coordinates for those
records. Uploads may arrive late or stop. A signal near a terminal is not a
gate scan. `alerts` are signals for investigation; inspect
their acknowledgement, resolution and linked evidence rather than treating
the signal as a verified diagnosis.
`ACKNOWLEDGED` records that a person took notice, not that the risk is gone.
`RESOLVED` records a supported conclusion about that alert episode.
`DISMISSED` means its triggering source was invalid or stale; the dismissal
should cite the evidence. A later recurrence may be a new alert linked by
`source_alert_id` to the old resolved episode.
For a tracking gap, `evidence_refs` identify the observations behind the
signal. `followup_message_id` and `followup_linked_at` identify a later
outreach message linked to that alert. The outreach did not trigger the
earlier signal and is not proof that the car moved.
The alert table is a selection of signal histories, not a replay of the
complete production alert stream or a staffing policy.

`work_items` is a small operations queue for ordinary checks and follow-ups.
It is separate from `incidents`: an open work item does not by itself mean the
car is in trouble. Its `source_refs` point to records that led to the check;
`summary` and `next_action` are internal interpretations, not independent
proof that a customer or driver did anything. `OPEN` and
`NEEDS_EXTERNAL_INPUT` remain unfinished; the latter does not prove that
anyone has contacted the external party. A `DONE` item has a `closed_at` and a narrow
`outcome`; for example, an accepted offer can close an offer check without
proving pickup. `due_at` is a queue reminder, not a customer promise. Most
orders have no work item, and no order in this packet has more than one.
`created_by` names the creator: five of the fifteen entries were created by
`system` and ten by a person, recorded as a desk id such as `ops-support` or as
the generic label `operator`. An assigned owner is not proof that a person has
read one.

## Conversations and agent work

`conversations` groups `messages`. Some records are external threads; a
`case_workspace` can link separate driver, customer and site exchanges.
Messages specify sender, recipient, channel, time and visibility. `PUBLIC`
means visible to the named recipient, not to everyone in the case. Internal
notes are operator-only. Messages may conflict with each other or with stored
data; preserve their speaker and time when using them as evidence.
For handoff-contact threads, `author_id` and `counterparty_id` refer to the
order endpoint, which can change recipient. Use `author_name_snapshot` on a
message and `counterparty_name_snapshot` on its thread for the name recorded
when that person spoke; the endpoint's current `contact_name` is not history.

The conversation `category` is a broad issue topic, not an outcome label.
`related_order_ids` identifies other orders discussed in a thread. Its
primary `order_id` is a filing location, and `link_history` can describe a
thread that arrived before the order was known. An agent-authored message is
not a customer or driver reply. `language` identifies the authored language;
the packet supplies no authoritative translations. `order_notes` are
operational notes, not universal site facts.

Selected open conversations also have `waiting_on`, `owner` and
`next_check_at`. These describe the current handoff, not a promise that the
outside party has replied or that the missing fact is verified. Channels
include email, app chat and a fictional WhatsApp exchange. Compare the
message times before assuming a quick response or a continuous conversation.
Many older threads omit these ownership fields in this selected export. A
missing owner is unknown here, not proof that nobody at the company owns the
conversation. Some narrow questions have a recorded answer and closure;
other open threads genuinely await a person, a customer or a site.

`support_inbox_threads` and `support_inbox_messages` hold a small set of
messages before an order link is certain. They deliberately have no
`order_id`. A thread's `candidate_order_ids` are possible matches suggested
by the available evidence, not links or permission to change those orders.
Only `linked_order_ids` are confirmed links. `link_state` distinguishes a
pending match, an account-identity conflict, one confirmed order, a confirmed
multi-order inquiry, and a general question that needs no order. Read the
messages and `candidate_basis` before taking action. A quoted order reference
can be wrong or belong to another account; do not disclose that account's
details while asking for correction. A closed general-policy thread does not
imply a reimbursement decision for any job.
Link resolution does not close the support request: a confirmed thread can
remain open while an arrival update or document is still owed.

`agent_proposals` is a review queue, separate from committed operations. A
proposal has a target, payload, cited evidence and a state dependency.
Statuses distinguish review, rejection, approval, execution and failure.
An approved proposal may still await execution; an attempted external action
may need reconciliation. For an executed proposal, inspect its reviewed
payload and `execution.effect_event_ids`. No supersession chain is present in
this selection: `superseded_by_proposal_id` is null on every row. The effect
event's `actor_id` and `actor_type` record who committed the change. In this
packet three executed proposals were committed by an operator and one by an
agent. Proposal text alone is never proof that an order, booking or customer
promise changed.

`internal_notifications` is a selected history of alert posts and replies in
fictional operations rooms. Its `destination` is an internal room, not an
external recipient. `POSTED` records a routed signal, `OPERATOR_ACK` a person
taking notice, and `SOURCE_RESOLVED` a change on the underlying alert.
`FOLLOWUP` and `PROPOSAL_REVIEW` are later replies on the same thread by a
person or an agent. This packet has `POSTED`, `FOLLOWUP`, `OPERATOR_ACK` and
`PROPOSAL_REVIEW` rows, all with `delivery_state` `RECORDED`.
Suppressed or failed deliveries do not prove anyone saw the notification.
Follow `alert_id`, `proposal_id` and `evidence_refs` back to the source before
using an internal comment as a decision or external communication.
An acknowledged alert can still require action; its owner and internal reply
do not resolve the source issue.

## Event history and a starting query

`operational_events` is a selected append-only history. Each event records
time, command, target, source, actor and a small change object. It covers the
main lifecycle and selected exceptions but is not a complete audit log of
every field. Do not infer that a nearby message caused an event without a
link. On orders, `source=IMPORT` describes the intake source; geographic
imports use `route_kind=IMPORT`.
Some ordinary support threads end in an answer, an explicit decision to leave
the plan alone, or an owned follow-up. A conversation outcome records that
decision, not a physical handover or an approved commercial change.

To inspect a case, start from `orders.reference`, load its active route,
then join offers and assignments through segment IDs. Put messages, alerts,
proofs and events beside that route with their sources and times visible.
For a delivered primary car, check whether other work on the order is still
open before calling the whole case finished.
