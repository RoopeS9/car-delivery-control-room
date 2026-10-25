# Music and sound for the video

I cannot listen to audio, so this is a **brief and a shortlist, not a finished soundtrack.** I did not download or commit
any audio. Picking by ear is your job, and downloading the file yourself from the site keeps the licence page tied to your
download. Everything about licences below comes from search summaries of each site’s own terms (second-hand), so **open the
terms page and the track page and read them before you use anything**, and keep a screenshot (see “Licence record”).

## Cue sheet

One track per cue is enough; two or three tracks in total is fine. Times follow `video/SCRIPT.md`.

| Cue | Where | Mood | Tempo and sound | Level |
|---|---|---|---|---|
| **1** | Scene 1, 0:00–0:14 | Confident, modern, a product launch | 100–115 BPM; clean synths, a soft kick, a build that peaks on the numbers | Under the voice, −20 dB |
| **2** | Scene 2a/2b/2f, 0:14–1:14 | Playful, relaxed: a calm shift | 80–95 BPM lo-fi or light jazz groove; warm keys, brushed drums | −18 dB, ducks to −24 under lines |
| **2b** | 2c and 2d, 0:29–0:46 | Panic, but funny | A low pulse or ticking drone, an alarm sting at the cut; no melody | −16 dB for the sting, then −24 |
| **2c** | 2e, 0:46–0:53 | Relief | The pulse stops; a long warm chord, then back into cue 2 | −20 dB |
| **3** | Scene 3, 1:14–1:27 | Calm attention | Sparse ambient pad, a slow pulse, nothing busy | −22 dB |
| **4** | Scene 4, 1:27–1:42 | Time passing, momentum | 120–128 BPM; a ticking build, hits on each cut, a final calm chord | −16 dB, the loudest point of the film |
| **5** | Scene 5 and end card, 1:42–2:50 | Warm, sincere | A soft, simple bed, no drums; swells once on the end card | −26 dB under speech |

Sound effects (all short): a cartoon pop (2b), an alarm sting (2c), a mouse click (every “Run”), a snare roll (2g), a
mug being put down (2f), a record scratch if you want a joke at “Not now.”

## Where to find them

| Source | Licence, as I could confirm it | What you must do | Fit |
|---|---|---|---|
| **[Pixabay Music](https://pixabay.com/music/)** and its sound effects | Free for commercial and non-commercial use, no credit needed, though credit is appreciated. You may not sell or redistribute the music files as they are, and you must not use it to suggest an endorsement. Pixabay says the user is responsible for any third-party rights in a track. ([terms](https://pixabay.com/service/terms/)) | Read the track’s own page. Keep a screenshot. | **Best first stop**: one site for the music and the effects, no attribution to manage. |
| **[Incompetech (Kevin MacLeod)](https://incompetech.com/)** | Creative Commons Attribution 4.0 (free with credit), or a paid licence with no credit. ([Creative Commons case study](https://wiki.creativecommons.org/Case_Studies/Kevin_MacLeod)) | Credit line, in the description and in the repo (see below). | Good for playful and comedic cues. |
| **[Free Music Archive](https://freemusicarchive.org/faq/)** | Each track has its own Creative Commons licence, shown on its page; its licence filter helps. | Use only tracks that allow commercial use and being synced to video; read the licence on each track page. | Wide choice, but check every single track. |
| **YouTube Audio Library** (in YouTube Studio) | Per track. Sources disagree on use outside YouTube, so treat it as **YouTube-only** unless the track’s terms say otherwise. | Skip unless the video is hosted on YouTube only. | Weakest fit for a video that also goes into a repo. |

Sound effects from **Freesound** (filter to CC0) are also commonly used; I did not check its current terms here.

## Shortlist to audition

**Cue 1** (confident, upbeat corporate). These came from Pixabay’s search page for “technology corporate upbeat”. I could
see the titles, artists and lengths but could not hear them; the names are generic, so audition them.

| Track | Artist | Length | Link |
|---|---|---|---|
| Upbeat Corporate | AtlasAudio | 2:36 | https://pixabay.com/music/corporate-upbeat-corporate-617614/ |
| Corporate Upbeat | AtlasAudio | 3:04 | https://pixabay.com/music/corporate-corporate-upbeat-613502/ |
| Corporate Upbeat | The_Mountain | 2:19 | https://pixabay.com/music/corporate-corporate-upbeat-610127/ |
| Corporate Upbeat | NastelBom | 2:19 | https://pixabay.com/music/corporate-corporate-upbeat-606729/ |
| Upbeat Corporate | The_Mountain | 1:42 | https://pixabay.com/music/corporate-upbeat-corporate-576594/ |

**Other cues.** Search pages to open (I have not checked what they return, only that this address form works):

- Cue 2, playful and relaxed: `https://pixabay.com/music/search/lofi%20jazz%20chill/`
- Cue 2b, panic: `https://pixabay.com/music/search/suspense%20tension%20pulse/`
- Cue 3, calm attention: `https://pixabay.com/music/search/ambient%20pad%20calm/`
- Cue 4, timelapse: `https://pixabay.com/music/search/ticking%20build%20momentum/`
- Cue 5, warm bed: `https://pixabay.com/music/search/warm%20piano%20inspiring/`
- Effects: `https://pixabay.com/sound-effects/search/cartoon%20pop/`

How to choose: put the 15 seconds of the scene on the timeline, drop each candidate under it, and keep the one whose
**build lands on the cut** without you moving the picture. Pick tracks with a clear end or a loop point so you can trim
without a click.

## Licence record (do this at the moment you download)

For every track and effect, make a file `video/CREDITS.md` with one line each:

```
Music: “<title>” by <artist>, <site> — <track URL> — licence: <name> — downloaded <date>
```

Take a screenshot of the track page showing its licence and save it under `video/licences/` (small PNGs are fine to commit).
If the track is Creative Commons Attribution, the credit also goes in the video description and the end card, in the form
the licence asks for (for Incompetech: title, “Kevin MacLeod (incompetech.com)”, licence name and link).

If the video is uploaded to a platform that scans for copyrighted music, a licensed track can still be flagged by mistake.
The screenshot and the credits file are what you show if that happens.

## Not music, but needed

- **Room tone** for each location (20 s of silence) so the edit does not jump.
- **The voice-over**, recorded last in a quiet room, close to the microphone, after the picture is locked.
- **Title and caption cards** in the app’s look (Unbounded, Poppins, cream and orange): they are part of the joke and the polish.
