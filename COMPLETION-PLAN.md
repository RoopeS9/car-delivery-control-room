# Completion plan: Road Desk

Written Sun 25 Oct 2026, about 09:30 Finnish time. Checked against `Bahn-hackathon-brief.pdf` and
`PARTICIPANT-BRIEF.md`. All times below are Finnish time (winter time, UTC+2).

**Deadline: 15:00 (from the brief). Our own freeze: 13:00 (the team's choice, not the organizers').** That leaves
about 3½ hours of building and 5½ hours in total. `PLAN.md` also mentions live judging from 15:10 (13:10 UTC); the brief
does not, so treat that as unconfirmed until someone asks at the booth.

## The short version

The product is built. Every "what to build" item in the brief has something behind it. What is left is **shipping it**:
the video, the right branch on a public repo, the write-up, two rehearsals, and a few small fixes that judges will see
in the first minute. Do not start new features.

## Brief against repo

| The brief asks for | Status | Where |
|---|---|---|
| Control room that brings a person only the orders that need them | Done | `/queue` (decide, agent working, waiting), `/` map, `/board` |
| Open any order and see what happened, who said what, what the agent did, the next decision | Done | `/orders/…`: timeline, decision card with source chips |
| Show how people and agents hand over and what happens when something goes wrong | Done | `/agent`, "I'll handle it", reminders, watchdog, scenario F |
| One real agent: tools, a loop, a person can talk to it | Done | `starter/lib/agent/`, 9 playbooks, Ask box, driver chat and voice |
| Never contacts a customer on its own | Done, in code | `gate.ts`; tests |
| Approvals first, freedom later | Done | every action starts at "ask first"; levels exist but nothing in the app raises them |
| Not a developer tool, fictional data only | Done, with wording to polish | see P1 |
| Runs from a fresh clone | **Partly verified** | see "What I checked" |
| Tests and traces | Done | 128 tests, `starter/traces/` |
| How we worked with AI (30%) | Strong | `PROCESS.md`, 1,500 lines; needs 40 s in the video |
| **Demo video, 2–3 min** | **Not made** | script in `SUBMISSION-DRAFTS.md` |
| **Public GitHub repo** | **Not confirmed** | see P0 1–2 |

## What I checked this morning

On a fresh clone of `roope`: `npm ci`, typecheck, schema push, seed of 100 orders, **128 of 128 tests pass**,
production build, app start, smoke ("board and record agree for 100 orders"), and all nine main screens load.

Not checked here: `docker compose` (no Docker daemon in this sandbox, I used a local Postgres), the attachment seed
(so no photos), the call service, voice, and any real-model run (no API key). Those need your machine.

## To do

### P0: submission is invalid or empty without these

| # | Task | Time | Notes |
|---|---|---|---|
| 1 | **Get the final work onto `main`.** `main` is still at `e09d815`, 65 commits behind `roope`. A judge who opens the repo sees the old version. Merge `roope` into `main` (it is a pure fast-forward: `main` is not ahead) or make `roope` the default branch. | 5 min | Do it right after the freeze. |
| 2 | **Make the repo public** and open it in a private window to confirm. GitHub search could not find it, which fits a private repo, but I could not confirm. | 5 min | Brief: "public GitHub repository". |
| 3 | **Find out how to hand in.** The brief says "hand in two things" by Sunday 15:00 but not where. `PLAN.md` mentions a Prompthack page. Ask on Discord or at the booth now. | 5 min | Everything else waits on this answer. |
| 4 | **Run the README steps on a Docker machine, verbatim**, including `attachments:seed` and the call service. | 20 min | Fresh clone, not your working copy. |
| 5 | **One real-model dry run of scenario A** (and check the OpenRouter balance first). Last night's spend was about $10.6. | 10 min | Before recording, not during. |
| 6 | **Record the video** (2–3 min). | 13:00–14:00 | Script: `SUBMISSION-DRAFTS.md`. Also record one rough take around 12:00 as a fallback. |
| 7 | **Write-up and links**, then submit. | 14:00–14:30 | Draft: `SUBMISSION-DRAFTS.md`. |
| 8 | **Two rehearsals of the live demo** with `RUN-SHEET.md`. | before 13:00 | One of them with the microphone off, to test the chat fallback. |

### P1: judges will notice these (fix before the freeze if small)

| # | Task | Why | Size |
|---|---|---|---|
| 1 | **Done** (`6d8ff7b`): one rule, 16 everywhere; signals moved to an amber "Worth a look" group. ~~**Two different counts.**~~ The map and board say "16 need a person"; `/queue` says "20 need your decision". The board counts orders flagged by `needsPersonNow`; the queue counts its own rows. Pick one rule or explain the difference on screen. | A judge will spot it in the first ten seconds. | small |
| 2 | **Done** (`6d8ff7b`): rows lead with the item that needs a person; the packet's tooling phrase is reworded. ~~**The clean-start queue is 20 red cards that all read "Open alert: …".**~~ Several use record wording ("source is a conversation, not a verified outcome"), which sounds like a data tool, not an operations desk. Rewrite the first line of the card as a plain sentence, and consider showing the top 5 with "show 15 more". | Brief: "high signal, low noise, even with hundreds of orders", "one glance tells you what is wrong and what to do". | small to medium |
| 3 | **(a)–(c) done** (`6d8ff7b`): live-call claim, root `.env.example`, a model table with DeepSeek as the example default. (d) done: the four finished items in `PLAN.md` §8 are ticked. ~~**README is out of date in four places.**~~ (a) It says urgent and ended calls feed the road agent; `OVERVIEW.md` found that a live call does not start an agent turn. (b) The root `.env.example` asks for `ANTHROPIC_API_KEY`, but the app uses `OPENROUTER_API_KEY`. (c) `.env.example` defaults to Claude, while the README and run sheet describe DeepSeek runs: say which model the demo uses. (d) The `PLAN.md` §8 checklist is all unticked. | The brief: "should run from a fresh clone with the steps in your README". | small |
| 4 | **Add 2–3 screenshots to the README** (queue, an order with its decision card, the driver phone). The same picture serves as the write-up's cover. | First impression; "made with care". | small |
| 5 | **Demo day: both services must be running.** If the call service is down, `/demo` shows "The call service is not running" in the middle of the page. Put "start both, then check `/api/cases`" at the top of the run sheet. | Avoid a live surprise. | tiny |
| 6 | **Checked**: all three are ancestors of `roope` (fully merged; `git cherry` finds no patch missing), so they can be deleted on GitHub with nothing lost. ~~**Three older `claude/*` branches still show patches that are not in `roope`.**~~ They are probably early versions that were superseded. Check in five minutes, then delete or leave a note, so nothing important is lost and the repo looks tidy. | Lost work or clutter. | tiny |
| 7 | **Known agent gaps from the second night** (`starter/scripts/night/MORNING.md`): on a missed ferry the reply still promises "inform the receiver" (a customer contact needing a card); the first reply to a steady yellow light is weak; the keys answer could be time-boxed. Fix only if it is a prompt change under 30 minutes. Otherwise say it honestly in the write-up. | Honest limits score well; surprises on stage do not. | prompt only |

### P2: only if there is time left after the video

- Check dark mode and a phone-width screen on the three main pages.
- The risky refactors the last log entry left alone (`runTurn`, `submitProposal`): leave them. Not worth it today.
- A second language demo (a German driver message). Already supported; just a nice extra.

## Timeline (Finnish time)

| Time | What |
|---|---|
| 09:30–10:30 | P0 3 (ask how to hand in), P0 2 (public), P1 1 and 2 (counts, queue wording) |
| 10:30–11:30 | P1 3–7; README screenshots |
| 11:30–12:15 | P0 4 and 5 on the near-final build: fresh-clone run on Docker, one real scenario A |
| 12:00–13:00 | One rehearsal of the script and one of the live demo; a rough fallback video take; only fixes found by these |
| **13:00** | **Freeze.** P0 1 (merge to `main`), tag it, no more feature work |
| 13:00–14:00 | P0 6: record the video (2–3 takes) |
| 14:00–14:30 | Edit, upload, write-up, cover image, all links |
| 14:30–15:00 | Submit, confirm the repo link works signed out. **15:00 is the deadline; aim for 14:45.** |

With a 13:00 freeze only two hours remain for the video, write-up and submission, and nothing in them can slip. If
12:00 arrives and the app is not near-final, move the freeze earlier rather than shortening the video.

## Since this plan was written (10:00)

- A critical review from Bahn's side is in `REVIEW-BAHN.md` (42 findings). Fixed before the freeze: the stop
  instruction on a serious fault now goes out before the model is asked (R3), safety instructions and the
  "may drive on" screen work in Finnish, Swedish, German, Danish and French (R4), and the agent no longer calls a
  fault "usually not critical" (R15). Commit `02241f7`, 132 tests.
- Deliberately left for after the hackathon (new features, not polish): login and per-person identity (R1), timers
  that run without an open tab (R2), Slack/SMS alerts (R7), an EU-hosted model and data retention (R5). Say so in the
  write-up as the pilot conditions.

## Decisions for you

1. **Which model for the demo?** DeepSeek v4 (cheap, every end-to-end run used it, a turn takes 20–60 s) or Claude (the
   `.env.example` default, likely better wording). Whichever you pick, rehearse with that one.
2. **Who records, who clicks, who plays the driver?** `RUN-SHEET.md` assumes three roles; the video needs only one voice.
3. **Cut or keep the business case** (`BUSINESS-CASE.md`) in the video. It is a strong close but its handling times are
   estimates, so say so in one clause.
