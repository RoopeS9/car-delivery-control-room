# Road Desk concept: what was added on this branch

- starter/: the control room, rebuilt as four roles (Operator map, Driver, Dealer, Bahn demo controller), an in-app call screen, a call simulator and a node panel per order. Run steps are unchanged (see README), plus set OPENROUTER_API_KEY (and optionally LINE_CALLER) in starter/.env. Keys are never committed: .env is gitignored.
- dossier/: the typed dossier project (strict generated record schemas, evidence-strength ladder, call briefs, simulated counterparts, DeepSeek reasoning, call-service HTTP API on :8799). dossier/data/dataset is a symlink to ../../dataset/data. 
up to date, audited 10 packages in 840ms

3 packages are looking for funding
  run `npm fund` for details

3 vulnerabilities (2 moderate, 1 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
4366 rows, 0 failures
REJECTED  unknown top-level key
REJECTED  misspelled status
REJECTED  time without offset
REJECTED  number as string
REJECTED  unknown nested key
REJECTED  payload key from another command
REJECTED  event changes key not seen for this command
REJECTED  id with spaces
REJECTED  missing required key
9/9 mutations rejected
built and validated 100 dossiers
size (JSON chars/4): median 6206, p90 9114, max 12141 tokens
phases: {
  AFTER: 19,
  INTAKE: 12,
  BOOKED: 11,
  READINESS: 12,
  MOVING: 7,
  DELIVERY_DUE: 19,
  PICKUP_DUE: 7,
  CANCELLED: 2,
  MARKET: 11
}
per class median / max tokens:
  ORDER_CORE        319    452
  ENDPOINTS         962   1426
  WINDOWS           298    691
  ROUTE             325    660
  MARKET            111   3865
  ASSIGNMENT        603   1264
  TRAVEL              1   2369
  MOVEMENT            1   1616
  CUSTODY             1    702
  EVIDENCE           90    687
  MONEY               1   1090
  SIGNALS             1    696
  CONVERSATIONS     370   1735
  AGENT_WORK          1   1381
  HISTORY          1587   4614
  DIRECTORY         191    388
dangling refs by field: { 'internal_notifications.actor_id': 3 }
wrote docs/DOSSIER.md

=== desk-orvendin-stockholm · CD-420442 · PICKUP_READINESS · OUTBOUND · COMPLETED · 79s · brief 1343 chars
   0 callee: Orvendin Cars Stockholm, Uma speaking.
   1 agent : Hello, this is Mira from Bahn car delivery, calling about a collection we have booked with you.
   2 agent : This is about order C D four two zero four four two, a Bentley Continental GT. Our driver Kasper Darevik is booked to collect it.
   3 agent : Is the car on site right now?
   4 callee: Yes, the car is here on the lot, I can see it on the release list.
   5 agent : Are the keys at your desk?
   6 callee: The keys are in our key safe at reception.
   7 agent : Who will hand over the car and keys to our driver?
   8 callee: I will release it myself, Uma Aldermere, or my colleague Jonas if I am on a break.
   9 agent : Do you have the signed release paper for this car?
  10 callee: We have the signed release in the folder with the car.
  11 agent : Will someone be there at the start of the slot?
  12 callee: We open at eight, so eight o'clock is fine.
  13 agent : Where should the driver report when they arrive?
  14 callee: Tell the driver to come to the main reception, not the workshop gate.
  15 agent : Thank you. I will pass this to our operator, and the driver will have your instructions before arriving.
slots: VEHICLE_PRESENT=true (t4), KEYS_AT_SITE=true (t6), RELEASE_CONTACT_NAME="Uma Aldermere (or Jonas)" (t8), RELEASE_DOCUMENT_PRESENT=true (t10), OPEN_DURING_SLOT=true (t12), ACCESS_INSTRUCTION="Main reception, not the workshop gate" (t14)

=== desk-confused-516 · CD-420516 · PICKUP_READINESS · OUTBOUND · PARTIAL · 89s · brief 1384 chars
   0 callee: Reception, hello?
   1 agent : Hello, this is Mira from Bahn car delivery, calling about a collection we have booked with you.
   2 agent : This is about order C D four two zero five one six, a Volvo V60, registration D E M O - F I - P V 2 H S D. A driver is being booked to collect it.
   3 agent : Is the car on site right now?
   4 callee: Our stock screen lists a warehouse transfer for that car. I cannot see it on the lot from here.
   5 agent : Are the keys at your desk?
   6 callee: Reception does not have the keys for this one. I do not know who does.
   7 agent : Who will hand over the car and keys to our driver?
   8 callee: Stock control would know. They said they would call you back.
   9 agent : Do you have the signed release paper for this car?
  10 callee: I would have to ask stock control about papers too.
  11 agent : Will someone be there at the start of the slot?
  12 callee: We are open from eight thirty.
  13 agent : Where should the driver report when they arrive?
  14 callee: The side gate is only for cars coming in, it is not a collection desk. Come to reception, but like I said, we do not have the keys.
  15 callee: Honestly I think the car might be at the warehouse. Stock control will call you.
  16 agent : Thank you. I will pass this to our operator, and the driver will have your instructions before arriving.
slots: VEHICLE_PRESENT=false (t4), KEYS_AT_SITE=false (t6), OPEN_DURING_SLOT=true (t12), ACCESS_INSTRUCTION="Reception, not the side gate; reception has no keys" (t14)
not extracted: RELEASE_CONTACT_NAME, RELEASE_DOCUMENT_PRESENT -> retry after 2026-10-21T11:06:29.350Z

=== driver-399-rest · CD-420399 · DRIVER_START_CHECK · OUTBOUND · COMPLETED · 74s · brief 1014 chars
   0 callee: Hello, yes, I am driving, quickly please.
   1 agent : Hi Freya, this is Mira from Bahn Road Desk, a quick check before tomorrow's collection.
   2 agent : This is about your job C D four two zero three nine nine, the Ferrari 296 GTB from Leipzig. Collection is 22 October from 11:00, that is eleven in the morning.
   3 agent : Are you fit and rested for the job?
   4 callee: I am fine, but after this handover in Hamburg I must take my rest.
   5 agent : Where will you be starting from?
   6 callee: I will be in Hamburg tonight after I deliver this car.
   7 agent : Do you have your travel to the pickup booked?
   8 callee: No, nobody has booked me anything to Leipzig.
   9 agent : When do you expect to arrive?
  10 callee: With my rest I cannot leave before twelve tomorrow, so I would be in Leipzig around three in the afternoon at the earliest.
  11 agent : Is there anything else we should know?
  12 callee: The Leipzig slot in the morning is not possible for me. Someone should look at that.
  13 agent : Thanks. If anything changes, call us or write in the app. An operator confirms any change to the plan.
slots: DRIVER_FIT_TO_DRIVE=true (t4), DRIVER_START_LOCATION="Hamburg, after tonight's handover" (t6), DRIVER_TRAVEL_BOOKED=false (t8), ETA="2026-10-22T13:00:00Z" (t10), ISSUE_REPORTED="Cannot reach the Leipzig morning pickup after required rest; earliest departure 12:00 local" (t12)

=== driver-leo-inbound · CD-420584 · DRIVER_INBOUND · INBOUND · ESCALATED · 72s · brief 1371 chars
triage: URGENT / WARNING_LIGHT  <- turn 2
   0 callee: Hi, this is Leo.
   1 agent : Road Desk here. First: are you safe, and is this urgent?
   2 callee: I am safe, I have stopped. The engine light is flashing and the car was shaking, I think this is urgent.
   3 agent : Understood. Leo Quellford is driving the Bentley Continental GT, order C D four two zero five eight four, from Cologne to Helsinki.
   4 agent : Where exactly are you?
   5 callee: A service area on the A1 near Osnabrueck, northbound.
   6 agent : Which warning light is on, and is it flashing or steady?
   7 callee: The orange engine light, and it is flashing, not steady.
   8 agent : Any shaking, loss of power, noise, smell or smoke?
   9 callee: It was shaking under acceleration and lost power. No smoke, no smell.
  10 agent : Is the engine switched off now?
  11 callee: Yes, I switched it off when I stopped.
  12 agent : Please keep the engine off and stay off the road. I cannot clear you to drive on; an operator decides that.
  13 agent : An operator has this now. Stay with the car and keep your phone on; we will call you back within fifteen minutes.
slots: DRIVER_SAFE=true (t2), CURRENT_LOCATION="Service area, A1 near Osnabrueck, northbound" (t5), WARNING_LIGHT="AMBER_FLASHING" (t7), SYMPTOMS="Shaking under acceleration, loss of power, no smoke or smell" (t9), ENGINE_OFF=true (t11)
tool calls: ESCALATE_TO_OPERATOR(URGENT WARNING_LIGHT: DRIVER_SAFE=true, CURRENT_LOCATION="Service area, A1 near Osnabrueck...)

4/4 simulated calls produced valid CallRecords.
- The live voice line (VoiceChat llama.cpp fork, duplex phone) runs outside this repo; the app talks to it through a reverse proxy at /line/*. Without it the call screens report the line unavailable; the simulator and the dossier service still work.
