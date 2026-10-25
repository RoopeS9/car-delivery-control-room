# Submission drafts

Drafts, not final text. Everything in `[brackets]` is something to check or fill in on the day. Each claim below comes
from a file in this repo (named in the margin notes), so nothing here needs a source you do not already have.

---

## 1. Demo video script (target 2:45, hard limit 3:00)

About 400 spoken words at a calm pace. One voice, a screen recording. Run **Reset demo** first; the simulated driver
is on (so the video needs no second person), the call service is up.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | `/` map, then `/queue` | "Bahn delivers over 25,000 cars a year with about 50 people, and something changes every hour. Their old portal grew into a maze of forms. We built Road Desk: agents do the legwork, and a person sees only the orders that need them." |
| 0:15–1:15 | `/demo` → **A. Fresh warning light** → Run. Then the driver window. Then the order page. | "A Bentley on its way from Cologne to Helsinki reports a flashing engine light. Before any person sees it, the agent writes to the driver: stop safely, are you safe? [The driver answers.] It reads the car's codes, the order, and asks for a photo of the dashboard. Now the operator gets one card. What happened, every fact with its source and time, what is still unknown, and one decision: ask the dealer how they want the car recovered. The ferry check-in closes at 15:30, so the card says that too. The operator calls the dealer, logs the answer in one line, and the agent carries on: it tells the driver, checks the new arrival time against the ferry, and waits with a next-check time." |
| 1:15–1:45 | `/demo` → **C**, then **F** | "Not everything needs a person. A routine question about keys is answered from the pickup record, no one is bothered. And when a driver goes silent, the agent sends one reminder and then hands a person a card: call him." |
| 1:45–2:00 | `/agent` page, then back to `/queue` | "The rules live in code, not in a prompt. Nothing is booked, sent to a customer, or cleared to drive on without a person's yes. Every action starts at ask first. Autonomy can grow later, but nothing in the app raises it today." |
| 2:00–2:40 | Split screen: `PROCESS.md` and the app | **How we worked with AI.** "We used Claude Code in parallel streams and Codex to merge them. Three things we did not take at first answer. One: we measured the strongest model at 5.9 seconds to its first word, too slow for a live phone call, so we split the voice into a fast interviewer and a stronger analyst that works on the transcript. Two: a review of our own plan caught that an operator approving a new delivery date is not the customer agreeing to it. The promise now moves only when a person records the customer's answer. Three: at night, models played the driver, the pickup desk and the customer against the real app. That found a clock bug where an operator approved the same email three times and it never went, and a safety screen that held 'stop the car' as if it said 'drive on'. Both are fixed and tested, 128 tests." |
| 2:40–2:55 | Business case table (`BUSINESS-CASE.md`) | "Per incident, about 12 cents of AI, measured, and an estimated 5 to 10 minutes of operator time instead of 30 to 45. The person stays, one seat always on duty, but that seat handles about five times the cases." |
| 2:55–3:00 | Title card: repo link | "Road Desk. Code and process log are in the repo." |

Cut order if over time: the business case first, then scenario F, then the `/agent` page.

Notes for the day:
- Margin sources: the 5.9 s and interviewer/analyst split is `PROCESS.md` ("voice design"); operator approval versus
  customer agreement is `PROCESS.md` ("second plan review"); the clock bug and the held stop instruction are faults 1
  and 2 in `starter/scripts/night/MORNING.md`; the 12 cents and the time ranges are `BUSINESS-CASE.md`.
- **Say** that handling times are estimates, not measured at Bahn. One clause is enough.
- [Check the "Codex" claim: `PROCESS.md` shows Codex used for the integration and final verification. Change the line if
  that is not how you want to describe it.]
- Record the voice last, over a silent screen take. Easier to fix a sentence than to redo a run of the agent.

---

## 2. Write-up (Prompthack page or equivalent)

**Name:** Road Desk

**Tagline:** A control room where agents do the legwork and people make the calls.

**The problem.** Bahn's operations team (about 50 people, over 25,000 cars a year) spends its day on phone calls and
paperwork, and every problem starts a chain: a breakdown becomes a recovery decision, a missed ferry, a new booking and a
message about the promised date. Someone has to hold all of it in their head. Their old portal turned into forms on top
of forms.

**What it does.** Road Desk replaces lanes and forms with one queue: *Needs your decision*, *Agent working*, *Waiting*.
When a driver writes in, calls, or the car reports a fault, a language-model agent does the cheap work first. It reads
the order and the car's data, asks the driver whether they are safe, asks for a photo, and looks things up. Then it
either finishes the job or brings a person one decision card: what happened, every fact with its source and time, what is
unknown, a recommendation, and what happens next. The person approves, edits, rejects, tells the agent what to do
instead, or does the call themselves and logs the result in one line. The agent then continues.

**How it stays safe.** The agent never contacts a customer on its own. Nothing is booked, sent or "cleared to drive on"
without a person's yes, and the gate rechecks the facts the card relied on before anything runs, once. A quote stays a
quote. An operator's approval is not the customer's agreement. Drivers and pickup desks see less of the order than
operations does, and every message to a driver passes a screen that stops "you can drive on" slipping out as ordinary chat.

**How we built it.** Next.js, TypeScript, Postgres, models through OpenRouter. We used coding agents in parallel
streams, kept a process log of what we asked, what we checked and what we threw away (`PROCESS.md`), and at night had
models play the driver, the pickup desk and the customer against the real app. That harness found real bugs, which are
fixed and covered by tests (128).

**What is real, what is simulated.** The agent loop, the tool use and the safety screen are real. The phone line, GPS and
car data, ferry prices, providers and the driver's replies in the demo are simulated. All people, orders and messages
are fictional.

**What we did not finish.** [Pick two or three honest ones, for example: the agent can still over-promise on a missed
ferry ("we will inform the receiver"); a live phone call is recorded on the order but does not start an agent turn;
autonomy levels exist but are not editable in the app.]

**Links.** Repo: [URL] · Video: [URL] · Cover image: [screenshot of an order page with its decision card, after
running scenario A]

---

## 3. Final submission checklist (tick at 12:30)

- [ ] `main` holds the final code (or the default branch is `roope`); last commit is the one you tested
- [ ] Repo opens **signed out**, in a private window
- [ ] README steps run from a fresh clone on a machine that has Docker, including photos (`attachments:seed`)
- [ ] No keys committed (`.env` ignored; only `.env.example` files are tracked, which I checked this morning)
- [ ] Video is 2:00–3:00, plays signed out, shows the process, and the voice is audible
- [ ] Write-up has the repo link, the video link and a cover image
- [ ] Submitted by 12:45 UTC (deadline 13:00 UTC = 15:00 Finnish time); confirmation seen or screenshotted
- [ ] Demo laptop: both services up, **Reset demo** pressed, simulated driver **off** for the live demo, chat fallback ready
