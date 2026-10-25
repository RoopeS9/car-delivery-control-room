#!/usr/bin/env python3
"""Builds a Final Cut Pro assembly project from the script's beats.

The project is an empty 1920x1080, 30 fps timeline cut into one placeholder per beat,
named and timed as in video/SCRIPT.md, with a chapter marker at each scene and a to-do
marker at each beat (what to film, the words, the sound, which screen recording).
Drop the real clips on top of the placeholders and tick the to-dos off as you go.

Run from the repository root:  python3 video/tools/make-fcpxml.py
Writes video/final-cut/RoadDesk-assembly.fcpxml (FCPXML 1.9).
"""
import sys
import xml.etree.ElementTree as ET
from xml.sax.saxutils import quoteattr

FPS = 30

# scene, beat id, title, seconds, note
BEATS = [
    ("1 Opener", "1a", "Opener", 6, "Film L1: all three in the lobby, thumbs up, phone propped, hold 4 s. Words: voice-over, we built Road Desk, AI agents do the legwork, people make the calls. Music: cue 1, Upbeat Corporate."),
    ("1 Opener", "1b", "The numbers", 8, "Use: business slide still plus cards/footnote-estimates.png. Words: voice-over, on our estimates under ten minutes not half an hour, twelve cents of AI. Music: cue 1 peaks on the numbers."),
    ("2 A quiet shift", "2a", "A calm shift", 8, "Film L3: operator slumped at the desk, feet up, mug. Use: cards/calm-shift.png. Words: Quiet morning. Music: cue 2, Jazz Lofi."),
    ("2 A quiet shift", "2b", "Simulator, keys", 7, "Screen R1: run C. Film L4: the simulator hand in the dark room. Use: cards/sim-keys.png, sfx/click.wav, Pixabay Pop Cartoon (or sfx/pop.wav). Words: Keys. Agent's got it."),
    ("2 A quiet shift", "2c", "Panic", 8, "Screen R2: run A. Film L4 (the hand) and L2 (the driver in the pod, dash-cam angle). Use: cards/sim-warning.png, sfx/alarm-sting.wav. Music: cue 2b, Panic Attack, file started at 0:30 (cut at engine off). Words: No no no no, what is that light, it's shaking."),
    ("2 A quiet shift", "2d", "The stop line", 9, "Screen R2 and R3: Leo's phone, Finnish and English. Film: driver pulls over. Use: cards/hazard-triangle.png flashing, sfx/hazard-tick.wav, sfx/engine-off.wav; Panic Attack stops here. Words: Okay, okay."),
    ("2 A quiet shift", "2e", "Relief", 7, "Screen R3: the agent's real reply. Film: shoulders drop. Use: sfx/relief-chord.wav. Words: Okay. Somebody's got this."),
    ("2 A quiet shift", "2f", "One card", 10, "Screen R4: queue ping, card with sources, I'll handle it. Use: cards/needs-you.png, sfx/mug-down.wav. Words: Right. That one's mine."),
    ("2 A quiet shift", "2g", "The chaos montage", 11, "Screen R5: demo panel chaos. Use: cards/sim-no-shame.png, sfx/snare-riser.wav, sfx/click.wav. Film: driver calm, operator pushes the mouse away. Words: Not now."),
    ("3 The control room", "3a", "The shift lead", 6, "Film L3: same actor upright, dim desk, lit by the map. Words: Hamburg. Music: cue 3, Calm Ambient Dreamscape."),
    ("3 The control room", "3b", "The real map", 7, "Screen R6: the map, dark theme, slow pan. Words: voice-over, the map shows every car and only the ones that need a person glow red."),
    ("4 Timelapse", "4", "Timelapse", 15, "Screen R7: the timelapse page. Use: cards/tag-simulated.png, sfx/timelapse-build.wav. No voice. Music: cue 4, Epic Build, a 15 s stretch that builds and ends on a hit."),
    ("5 On camera", "5a", "Process", 28, "Voice-over over B-roll R8: PROCESS.md, session list, night harness; one 2 s hand-held shot of the team. Words: see SCRIPT.md scene 5a. Music: cue 5, warm bed (not chosen yet)."),
    ("5 On camera", "5b", "Limits and next steps", 26, "Voice-over over the limits and next-steps slides (6-8 s each) with the live map between. Words: see SCRIPT.md scene 5b."),
    ("5 On camera", "5c", "The invitation", 8, "Film L1 again: all three, thumbs up, mirroring the opener. Words: We would love to show you Road Desk running. Find us at the booth, or watch the repo (voice-over if the lobby is noisy)."),
    ("End card", "E", "End card", 6, "Use: the last slide of the Road Desk presentation with the real links. Total must stay under 3:00."),
]


def t(seconds):
    """A frame-aligned FCPXML time, as a fraction of a second."""
    return f"{int(round(seconds * FPS))}/{FPS}s"


def esc(text):
    """quoteattr adds the surrounding quotes and escapes &, <, >, and the quote character."""
    return quoteattr(text)


def main():
    total = sum(b[3] for b in BEATS)
    lines = []
    w = lines.append
    w('<?xml version="1.0" encoding="UTF-8"?>')
    w('<!DOCTYPE fcpxml>')
    w('<fcpxml version="1.9">')
    w('  <resources>')
    w('    <format id="r1" name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>')
    w('  </resources>')
    w('  <library>')
    w('    <event name="Road Desk video">')
    w('      <project name="Road Desk assembly">')
    w(f'        <sequence format="r1" duration="{t(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">')
    w('          <spine>')
    offset = 0
    last_scene = None
    for scene, bid, title, secs, note in BEATS:
        name = f"{bid} {title}"
        w(f'            <gap name={esc(name)} offset="{t(offset)}" duration="{t(secs)}" start="3600s">')
        if scene != last_scene:
            w(f'              <chapter-marker start="3600s" duration="1/30s" value={esc(scene)} posterOffset="0s"/>')
            last_scene = scene
        w(f'              <marker start="3600s" duration="1/30s" value={esc(name + ": " + note)} completed="0"/>')
        w('            </gap>')
        offset += secs
    w('          </spine>')
    w('        </sequence>')
    w('      </project>')
    w('    </event>')
    w('  </library>')
    w('</fcpxml>')
    xml = "\n".join(lines) + "\n"

    # Fail loudly rather than write something Final Cut will refuse.
    root = ET.fromstring(xml.split("\n", 2)[2])  # skip the XML declaration and DOCTYPE for the parser
    gaps = root.findall(".//gap")
    assert len(gaps) == len(BEATS), "one gap per beat"
    assert total == 170, f"runtime should be 2:50 (170 s), got {total} s"

    path = "video/final-cut/RoadDesk-assembly.fcpxml"
    with open(path, "w", encoding="utf-8") as f:
        f.write(xml)
    print(f"wrote {path}: {len(BEATS)} placeholders, {total} s ({total // 60}:{total % 60:02d})")


if __name__ == "__main__":
    sys.exit(main())
