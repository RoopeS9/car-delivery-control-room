# Live demo run sheet

For the partner demo (5–10 minutes, our laptop). Everything here was run end to end on the night of 24–25 October
with DeepSeek v4 through OpenRouter; `npm run e2e:roles` replays the same paths and checks what the records show.

## Roles

- **Clicker**: plays operations on the left screen (Needs you, the order page, the decision card).
- **Driver**: plays Leo Quellford in the driver's phone, on a second window (`/driver?driver=drv-042&job=CD-420584`).
  Types, or calls Road Desk if the room is quiet enough for the microphone.
- **Talker**: tells the story; keeps to the times below.

## Before the judges arrive (5 minutes)

1. Both services up: the app (`cd starter && npm start`, port 3000) and the call service
   (`cd dossier && npm run serve`, port 8799). `curl -s localhost:3000/api/cases` answers.
2. `/demo` → **Reset demo**. The sim clock reads 09:00 UTC, 21 Oct.
3. In `/demo`, the **simulated driver** is off (a person plays Leo). The **autopilot** may stay on: it phones drivers and
   desks on the other orders as the simulation runs (each call shows on that order's timeline) and leaves the scenario
   orders A to H alone. Switch it off if you want nothing to happen that you did not start.
4. Tabs, in order: `/` (map), `/queue`, `/demo`; the driver's phone in its own window.
5. The queue shows the dataset's own open items and no Road Desk case yet.

## The story (about 6 minutes)

| Time | Who | Do | What the screen shows | If it does not |
|---|---|---|---|---|
| 0:00 | Talker | The problem: hundreds of orders, a person should see only the ones that need them. | `/` map, `/queue`: only the orders that need a person, red for a decision. | — |
| 0:40 | Clicker | `/demo` → **A. Fresh warning light** → Run. | The car reports a flashing light and misfire codes. At once, before the agent has read anything, Leo gets the fixed stop and engine-off lines in Finnish with English below (he lives in Tampere and has not written yet). Within about 30 s the agent asks him in English: are you safe. Say it: "the safety line never waits for the model, and it speaks the driver's language". | Wait up to a minute (a DeepSeek turn takes 20–60 s). |
| 1:20 | Driver | Types: *"I'm safe, parked at the service area by the fuel station, engine off. The orange light was blinking and the car shook."* | The agent answers him (never "you can drive on"), asks for a dashboard photo. | Press **Send demo picture** if it asks. |
| 2:00 | Clicker | `/queue` → the Bentley at the top → open it. | One card: ask the dealer how they want the car recovered, every fact with its source chip, the ferry cutoff 15:30 UTC, what is unknown. | If the card is not there yet, open the order: the timeline shows the agent's lookups as they happen. |
| 2:40 | Clicker | Choose an option → **I'll handle it** → log *"Called the owner: their own roadside help arrives at 11:00 UTC and takes the car to the Bentley workshop nearby."* | The agent tells Leo what happens next, checks the 11:00 arrival against the ferry check-in, and puts the case into a wait with a next check time. | — |
| 3:20 | Driver | Shows the phone. | Leo's thread: the safety instruction, the agent's questions, the update; the steps strip reads "Car and keys collected 09:00 CEST" (the phone shows the time where the driver is). | — |
| 3:40 | Clicker | `/demo` → **C. Routine question** → open CD-420145. | The keys question answered from the site record, handled without a person (or one card to confirm an unconfirmed instruction). | — |
| 4:10 | Clicker + Driver | `/demo` → **Reset demo** (A and C are done; H moves the clock by days), then **H. From pickup to handover**. In the phone (Kasper Darevik): at the pickup, then collected with **Demo pictures**. Press H's **Run** again after each step: the clock moves to the next step's time in the records (the ferry check-in on 22 Oct, then the delivery window on 26 Oct). Name a receiver at the handover. | The order page's steps complete, the photos become the pickup proof, `/dealer` shows "Collected", the map moves the car; the handover brings one card: the delivery confirmation to the customer, which a person sends. | If H refuses a jump of days, other cases are open: reset first. |
| 5:00 | Talker | How we worked with AI: `PROCESS.md` (what we asked, what we checked, what we threw away). | — | — |

Scenario B (a new delivery date the customer agrees to by email) and F (the driver goes silent, one reminder, then a
person) are the backups if a judge asks "what if the customer has to agree?" or "what if nobody answers?".

- **B**: `/demo` → B; on the case, **Tell the agent**: *"The owner's roadside partner collects the car at 12:00 and
  takes it to their Hamburg workshop. Propose to the customer a new delivery window Friday 23 Oct 10:00–14:00 UTC."*
  Approve the card; in `/demo` → **The customer writes**: *"Friday works for us, we agree."* The order's Delivery
  promise block quotes the email; **Customer agreed** moves the promise. Takes 3–4 minutes of agent time.
- **F**: `/demo` → F, then **+5 min** twice. A card: call William on his phone.

## Things that are true and worth saying

- The agent never contacts the customer: every customer message is a card a person sends.
- Nothing changes without a person's yes; an operator's approval of a new date is not the customer's agreement.
- Drivers and pickup desks get answers at once; a desk never gets a promise to "keep you posted".
- Every message to a driver is screened; anything that reads as "you can drive on" is held for a person.

## When something goes wrong

- **Reset refuses (409)**: agent work is still running. Wait 30–60 s and press it again.
- **The agent is slow**: a turn takes 20–60 s, a follow-up after a decision another 30–90 s. Talk over it; the
  timeline fills as it works.
- **The microphone fails**: type in the phone instead; the chat path is the same agent.
- **The app is down**: the video is the last fallback.
