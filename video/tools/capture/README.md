# Screen-capture scripts

These scripts drive the running Road Desk app like a person would (a visible pointer, click ripples, human-paced typing) and
record each window, so the screen parts of the video are **repeatable**: if the agent does something odd, run it again.
Every clip is the real app. Nothing is mocked up; the only things added are the cursor, the click ripples, and (in the
framing step) the phone and window frames.

| Script | Records | Beats it covers | Spends model credit? |
|---|---|---|---|
| `r1-keys.cjs` | Scenario C, the keys question: demo panel, the driver’s phone, the queue and the order | 2b | A little (cents) |
| `r2-scenario-a.cjs` | Scenario A end to end: demo panel, Leo’s phone, the operator (queue, card, details, “I’ll handle it”, the log line) | 2c, 2d, 2e, 2f | Yes, about $0.20 |
| `r5-chaos.cjs` | The clock jumps and scenarios F and G, plus the live map at the same time | 2g | Only without `--no-model` |
| `r6-map.cjs` | A slow shot of the live map, dark theme | 3b | No |
| `r7-timelapse.cjs` | The map timelapse page, once it is merged | 4 | No |
| `r8-process.cjs` | PROCESS.md, the night’s results and the review, gliding to the key passages and highlighting them | 5a | No |
| `frame.cjs` | Puts a clip in a phone or window frame on the brand background; makes 1080p clips | all | No |

**Where this folder lives:** `video/tools/capture` inside the repository. The scripts find PROCESS.md and the other documents from there,
and write their recordings to `video/captures/`. If you keep the folder somewhere else, set `ROAD_DESK_ROOT=/path/to/the/repository`.

## One-time setup (the machine that records)

You need Node, ffmpeg and a Chromium that Playwright manages:

```sh
brew install ffmpeg                    # macOS; on Linux use your package manager
cd video/tools/capture
npm install
npx playwright install chromium
```

## Before every recording

1. **The app runs with a real model key**, and the database is seeded (see the main README). Open `http://localhost:3000/demo`.
2. **Turn the simulated driver OFF** on `/demo` (the “Simulated driver” switch). These scripts play Leo themselves; with the switch on,
   two drivers would answer.
3. **Close other tabs and apps** that might send notifications. Do nothing with the mouse while a script runs: it drives its
   own browser windows, and they are separate from yours.
4. Pick a cheap model for the agent if you want (the main README says how). A scenario A run takes 2–4 minutes of waiting.

## Running

```sh
node r2-scenario-a.cjs          # the big one: run it first
node r1-keys.cjs
node r5-chaos.cjs --no-model    # no credit; drop --no-model to also start scenarios F and G
node r6-map.cjs
node r8-process.cjs
node r7-timelapse.cjs           # when the timelapse page exists
```

Useful flags (all scripts): `--app http://localhost:3000` (where the app is), `--slow 1.5` (slower, calmer pointer and pauses; the
default 1 is a normal human pace), `--theme dark|light`, `--max-wait 240` (seconds to wait for the agent at each step),
`--no-reset` (do not reset the demo first), `--headed` (show the browser windows while recording, to debug), `--preset ultrafast`
(quicker video conversion for test runs), `--crf 15` (video quality; lower is better and bigger).

Each script resets the demo first (except `r6`, `r7`, `r8`, which change nothing). The reset is refused while the agent is still busy;
the script then waits and tries again.

## What you get

A folder per run under `video/captures/` (it is git-ignored, because the files are big):

```
video/captures/scenario-a-2026-10-25T10-26-45/
  scenario-a_demo.mp4      the demo panel         2560x1440, 30 fps
  scenario-a_driver.mp4    Leo's phone            430x932,   30 fps
  scenario-a_ops.mp4       the operator's screen  2560x1440, 30 fps
  events.json              what happened and when, and where each clip starts
  events.csv               the same events as a table
  framed/                  after frame.cjs: the 1080p clips ready for Final Cut
```

**events.json** is the editor’s map. Each event has a time in seconds from the moment the first window opened, a label and, where
useful, the text itself: the agent’s actual messages to Leo, the card’s title, the line that was logged. Use them to find the good
moments, and to write the voice-over or the captions from what was really said. `clips.<name>.offsetSeconds` is how late that clip
starts compared with the first one (a few hundredths of a second): put every clip of one run on the timeline at its offset and
they line up, so you can cut between the phone and the operator’s screen with nothing out of sync. Events that start with
`TIMEOUT` or `ERROR` mean a step did not happen; read them before you trust the clip.

## Framing

```sh
node frame.cjs --dir ../../captures/scenario-a-2026-10-25T10-26-45 --tag "Real run · simulated data"
```

Desktop clips go in a window frame, the phone in a phone frame with a label, both on the cream background, at 1920x1080 and 30 fps,
into `framed/`. The `--tag` pill keeps the film honest about what is real; leave it out if you add the same words in the edit.
Use `--bg dark` for the dark scenes, `--mode plain` to just scale a clip, and `--crop x:y:w:h` (in source pixels) to punch into a
region such as the source chips on the card. A single clip: `node frame.cjs clip.mp4 --mode phone --label "Leo’s phone"`.
Final Cut can also do all of this; this is for when you want the same look on every clip in one command.

## If something goes wrong

- **“The app does not answer”**: start it first, or pass `--app`.
- **“Could not reset the demo”**: agent work is still running. Wait a minute and run again.
- **A TIMEOUT line**: the agent did not answer in time, or the page changed. Read the log; raise `--max-wait`, or re-run.
- **The card says the agent could not finish**: the model key is missing or wrong. Check the app’s `.env`.
- **Map tiles are grey**: no internet, or the tile server is slow. Run `r6` again.
- **Leo’s first message is in Finnish**: that is the driver-language stop line working (Leo lives in Tampere in the data).
- **The pointer looks off**: it is drawn by the page, in the app’s zoomed coordinates; if you change `--zoom`, check one clip.

## What was checked

On a local build with no model key: every script ran to the end, the three windows of scenario A started within 30 milliseconds of
each other, the cursor lands where the real pointer is, the map, the process pages and the framing look right. **What was not
checked:** the real agent’s card, its facts and source chips, and the update to Leo, because they need a model key. Look at the first
real clip before recording everything.
