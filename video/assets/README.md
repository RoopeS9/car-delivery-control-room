# Video assets

Everything here was made by the team for this project. There is no third-party material, so no licence to track and no
credit to give.

| Folder | Files | How they were made |
|---|---|---|
| `cards/` | 10 PNGs: transparent 1920×1080 caption overlays, and a 512×512 hazard triangle | `video/tools/make-cards.cjs` (Playwright renders HTML in the app’s fonts, Unbounded and Poppins, and colours) |
| `sfx/` | 11 WAVs, mono, 48 kHz, 16-bit | `video/tools/make-sfx.sh` (ffmpeg synthesis only: sines, noise and envelopes) |

To change a card’s text or a sound, edit the script and run it again from the repository root:

```sh
NODE_PATH=$(npm root -g) node video/tools/make-cards.cjs
bash video/tools/make-sfx.sh
python3 video/tools/make-fcpxml.py     # the Final Cut assembly project
```

The sound effects are **placeholders to judge by ear**. Their lengths and peak levels were checked by machine, but nobody has
listened to them. If one does not sound right, replace it from Pixabay’s sound effects (see `video/MUSIC.md`) and record the
licence.

**Music is not in this folder.** See `video/MUSIC.md`.
