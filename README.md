Bol shows you the words — in the script you actually read.

Search any song, press play, and the lyrics scroll in real time, line by
line, word by word. Hindi songs appear in Devanagari. English songs appear
in English. No romanized half-Hindi that changes the meaning.

WHY BOL

• Real Devanagari, always. Most lyrics apps transliterate Hindi, Punjabi
  and Urdu songs into Roman letters, which garbles spellings and meaning.
  Bol renders Hindi songs in proper Devanagari, every time.

• Search anything. No fixed playlists, no catalog limits. Type a song and
  artist — "kesariya arijit", "tum hi ho" — and it finds the recording.

• Sync you can trust. Lyrics are timed to one specific recording, so Bol
  grades every version before you press play and marks the ones that line
  up. Pick the version badged Perfect Sync and it just works.

• Fix it in one tap. If an upload has a longer intro, nudge the timing with
  the plus and minus buttons. Bol remembers it for that song.

• Word-by-word highlighting. The line lights up as it's sung, so you always
  know where you are.

• Save what you love. Recents and favourites stay on your device.

BUILT FOR HINDI AND ENGLISH LISTENERS

Bollywood playback, Hindi indie, Punjabi hits and English pop — Bol is made
for people who read Devanagari and Latin, and it doesn't pretend to be
anything else.

Free. No account. No sign-up.






# ly·music

Search **any** song and sing along to real-time synced lyrics. No song list, no
API key, no backend — a static React app.

```bash
npm install
npm run dev      # http://localhost:5174
npm run build    # static bundle in dist/
```

> Run it with `npm run dev`. Opening `index.html` from disk shows a blank page:
> browsers cannot compile JSX or load ES modules over `file://`.

---

## What it does

1. Type a song ("kesariya arijit", "blinding lights") or paste a YouTube link.
2. ly·music finds the recording, identifies the **canonical studio track**, and
   picks the lyric file whose timeline actually fits the audio being played.
3. Lyrics scroll with the vocal, highlighting **word by word**.
4. Recents and favourites are remembered in your browser.

---

## Why lyrics used to lag — and how this fixes it

Getting this right needed research, not tweaking. Findings:

**LRC files belong to a specific recording.** A song has dozens of uploads:
album cut, video edit, lofi remix, live version. Matching lyrics by *title*
returns a timeline built for a different waveform, so every line lands late.
*Example: the popular Kesariya video is **172s**, but the studio track is
**268s** — a 96-second mismatch no offset can repair.*

**Duration metadata lies.** One LRCLIB record for Kesariya claims 172s while
its timestamps run to 259s. The **span of the timestamps themselves** is the
only trustworthy signal.

**The fix — three independent checks:**
- **iTunes** (keyless, CORS-enabled) supplies the canonical studio duration.
- **LRCLIB** candidates are gathered across several query shapes, because each
  returns a different slice of records — the variant that fits Kesariya's short
  edit appears in *only one* of them.
- Every candidate is finally scored against the **video actually playing**. Any
  LRC whose last stamp lands past the end is rejected outright. If nothing
  fits, the app says so rather than showing lyrics that drift.

**Timing model** (`src/lib/timeline.js`):
- Each line gets an explicit `[start, end]`, so a line stops when the singing
  stops instead of staying lit through a 30-second instrumental.
- `resolveAt()` is a **pure function** of (timeline, time) — which is what
  makes seeking exact. No accumulated state can fall out of step.
- A smoothing clock hides the player's coarse ~250ms updates that caused the
  visible stutter.
- Words are weighted by **syllable count** (Devanagari matras handled
  separately), so the sweep tracks the voice instead of jumping per line.

**Hindi renders in Devanagari.** Romanized transcriptions score far below
Devanagari ones, and Devanagari gets its own font stack and line metrics so
matras never clip.

---

## Search without an API key

**This was the one broken feature, and the cause was not a bug in the code.**
Search used to run through the IFrame player's `listType:'search'`. Google
**deprecated that on 15 November 2020**; it now answers with `404`/`410`, so
searching by name returned nothing for everyone, on every network. It cannot be
made to work and has been deleted.

Search now lives in `src/lib/search.js` and talks to **Piped**, an open-source
YouTube API front-end that sends `access-control-allow-origin: *`. Two passes
run per query — `music_songs` for clean studio uploads and `videos` for
everything else — then results are merged and ranked so official audio and
lyric videos beat reactions, karaoke tracks, slowed/reverb edits and Shorts.

Public instances go down constantly (only 1 of 20 tested was healthy), so the
module keeps a **failover list of 12 hosts**, races them, and caches the
winner in `localStorage` under `ly:instance` for instant later searches. If
every host is down, the search box still accepts a **pasted YouTube link**, and
the error message says so.

Verified non-options: the Data API (needs a key), InnerTube
(`/youtubei/v1/search`, no CORS headers), and Invidious — all 8 mirrors tested
returned 403/401/404 or omitted CORS headers entirely.

---

## Performance & accessibility

- The IFrame API `<script>` is injected with `async` and resolved through
  `onYouTubeIframeAPIReady`, so it never blocks first render.
- `preconnect` to `fonts.gstatic.com`/`fonts.googleapis.com` and `youtube.com`,
  `dns-prefetch` for thumbnails and LRCLIB.
- **View Transitions API** cross-fades results ↔ lyrics on Chrome/Edge; other
  browsers keep the framer-motion animation. Respects `prefers-reduced-motion`.
- Opening a song **moves focus to the player stage**, so keyboard and
  screen-reader users follow the view instead of being stranded.
- Every control is at least **44×44px** (verified 0 undersized targets at
  390px wide).
- Player `onError` is surfaced as a readable message plus an
  **Open on YouTube** link when a video is private, removed, or embed-blocked.
- An **offline banner** appears on `offline`/`online` events.

---

## Why some songs synced and others drifted

This was never randomness in the sync engine. An LRC file is timed against
**one specific master recording**, and YouTube hosts many different cuts of the
same song. Measured across real search results, "Tum Hi Ho" uploads run
anywhere from **141s to 383s** against a lyric track that spans 247s. Three
distinct failure modes come out of that gap:

| Mode | Example | Effect | Fixable? |
|---|---|---|---|
| **Shorter cut** — radio edit, dance mix, reel version | Kesariya at 173s vs a 260s lyric span | Lines run 87s past the end of the audio | No — the audio lacks those lines |
| **Longer cut** — film version, extra intro/dialogue | Tum Hi Ho at 310s | Everything is present but starts late | Yes — one constant offset |
| **Speed-shifted** — slowed+reverb, nightcore, "remaster" | Husn slowed at 270s vs 218s master (1.24x) | Error **grows**: ~14s adrift at 1 min, ~43s at 3 min | No — the error is not constant |

The third mode is the "randomly up and down" case. A constant offset cannot
correct it, because the drift accumulates as the song plays.

## The fix: grade sync before you press play

Because the cause is a duration mismatch, it is **knowable in advance**.
`src/lib/syncFit.js` pulls every synced LRC variant for the query (one extra
request per search, not per result), measures each one's stamp span, and grades
every video against it:

- **Perfect sync** — duration matches a variant within 4s; timed to this cut.
- **Good sync** — lyrics land inside the audio with room to spare.
- **May need nudge** — extended or re-performed; one tap of −/+ fixes it.
- **Off-sync** — shorter edit, or a tempo mismatch that will drift.

Results are sorted so well-timed uploads rank first, and **“Reliable sync only”
is on by default**, hiding the off-sync ones with a visible count of what was
removed. Turn it off to play them anyway.

Live, cover, mashup and slowed/nightcore uploads are re-performed to a
different clock, so they are never labelled "Perfect sync" even when their
length coincidentally matches — unless you explicitly searched for that cut.

If LRCLIB is unreachable the grading degrades silently to unlabelled results
rather than blocking search.

---

## Readable lyrics: Hindi in Devanagari, English in Latin

Three separate defects were making lyrics unreliable. Each was measured against
live data, not guessed at.

### 1. Lines appeared in a script you cannot read

Not a bad pick — the source files themselves are mixed. Every LRCLIB record for
**Chaleya** is the *same* 38 lines split **30 Devanagari / 8 Gurmukhi**. There
is no clean file to choose instead, so rejecting mixed files would have left
popular songs with no lyrics at all.

`src/lib/script.js` transliterates instead. The Brahmic blocks are positionally
aligned (Gurmukhi U+0A00 ↔ Devanagari U+0900), so Gurmukhi, Bengali, Gujarati
and Odia convert letter-for-letter — lossless, not machine translation. Addak
(ੱ) is expanded into a proper conjunct, tippi into anusvara, and independent
vowels after a matra become the य-form, so ਚੱਲਿਆ renders as चल्लिया, not चॱलिा.

Scripts with no Hindi correspondence — Tamil, Telugu, Arabic, CJK — cannot be
mapped, so those files are rejected outright rather than shown.

### 2. The wrong song's lyrics

Two causes. LRCLIB's search is fuzzy: `"tum hi ho"` returns **"Uska Hi Banana"**,
which could then win on duration alone. A title-match gate now rejects records
whose name does not overlap the track.

The bigger cause was Hindi-titled uploads. `"तुम ही हो आशिकी 2 पूरा गाना बोल के
साथ"` matches nothing in LRCLIB or iTunes, which index romanised names — so the
resolver settled for any loosely-related record. Titles are now trimmed of
filler ("पूरा गाना", "बोल के साथ") and romanised. Crucially, databases use the
*popular* spelling, not strict phonetics:

| strict | LRCLIB hits | popular | LRCLIB hits |
|---|---|---|---|
| `tum hee ho` | 0 | `tum hi ho` | 20 |
| `kesariyaa` | 0 | `kesariya` | 20 |
| `satarangaa` | 0 | `satranga` | 20 |

Both spellings are tried, popular first.

Whether a song is Indic is now decided by the **data** — the share of candidate
files written in an Indic script — rather than a hardcoded list of artist names
that silently missed singers like Kaifi Khalil. Measured separation is clean:
Hindi songs score 60–95%, English songs exactly 0%.

### 3. Lyrics running ahead of the music

A genuine bug. The offset was computed as `videoDuration − iTunesDuration`, but
iTunes describes the **studio single** while the chosen LRC is often timed to
the **video cut**. Husn measured: video 240s, iTunes 218s, chosen LRC 239s. The
old code saw a 22s gap and injected **+16.5s** onto a file that was already
aligned, pushing every line badly out of sync.

The selected LRC is now the only anchor. If its own duration matches the video,
the offset is **zero** — verified: Husn, Kesariya, Chaleya and Tum Hi Ho all
resolve at 0.0s. Offsets are also clamped so no line can be pushed before the
audio starts or past its end, and unreachable trailing lines (Chaleya carries
two past a trimmed fade-out) are dropped rather than leaving the last line
highlighted forever.

**Verified across 21 tracks** — Hindi film, Hindi indie, Punjabi and English:
21 resolved, 0 without lyrics, 0 with a foreign script, 0 overruns. Hindi songs
render 97–100% Devanagari; English stays Latin.

---

## Word-level drift, and why calibration felt broken

Two more defects, found by testing **Gehra Hua**, **Aaj Din Chadheya** and
**Bairan**.

### The −/+ buttons moved the song instead of the lyrics

A real bug in `useSync`. The effect that reset the playback clock depended on
`timeline`, and `timeline` is rebuilt every time the offset changes. So each
tap of −/+ ran `clock.reset(0)`: the lyric clock jumped to zero while the audio
kept playing, which looked like the song lurching forward for no reason.

The clock now resets only when a genuinely different song loads, keyed on
`lines:duration` rather than object identity. Offset changes re-derive the
timeline and leave the clock alone. Verified in a browser: three taps of “+”
moved the offset `0.0s → +1.5s` with **zero** change to the playback clock.

### Lyrics that started in sync and slid out

An LRC only says when a line *starts*. The old builder swept a line's words
across the entire gap to the next line — but that gap is not how long the line
is sung for. **Bairan** line 8 has a 16.6s gap for a phrase the singer delivers
in about 3.6s, so the words were stretched over 14.6s: the first word landed
right and every word after it drifted further behind the vocal.

Words now sweep at the natural singing pace (measured characters-per-second,
separately for Devanagari and Latin) and the *line* may stay lit longer without
dragging the word highlight with it. Measured across 21 tracks, the worst
word-sweep stretch is **1.00x** — previously **4.1x** on Bairan.

### Bonus: two wrong-song bugs surfaced by these tracks

- **iTunes returned an unrelated canonical track.** For "Aaj Din Chadheya" it
  answered `"Jhol (Acoustic)"`, which then entered the title whitelist and let
  a completely different song's lyrics through. The lookup now returns *null*
  rather than accepting a non-matching result, and the title gate refuses to
  fall back to the full candidate list when nothing matches.
- **Transliteration variants were treated as different songs.** A perfect 315s
  Devanagari *"Ajj Din Chadheya"* was rejected against the query *"Aaj Din
  Chadheya"*, so the resolver settled for a Dr LoFi remix and inherited a bogus
  +12s shift. Spelling is now folded (`aa→a`, `ee→i`, doubled consonants) before
  comparison, records whose declared length matches the video are strongly
  preferred, and lofi/slowed/club edits are penalised.

**Result:** all three reported songs now resolve at **offset 0** with 100%
Devanagari — Aaj Din Chadheya went from a Lofi remix at +12s to the real 315s
recording at 0s. Across 22 tracks: 21 synced, 0 script problems, 0 overruns,
0 stretched sweeps.

---

## Interface

**Ambient artwork.** The playing song's own cover, blown up and blurred past
recognition, sits behind the lyrics as coloured light. It reads as atmosphere
rather than a picture, and every lyric line carries its own shadow so it stays
legible whatever the cover looks like. `mqdefault` is used rather than
`hqdefault`, because the latter is a 4:3 frame with black letterbox bars baked
in — those bars both muddied the blur and forced an ugly crop.

**A friendly heads-up on first open.** Lyric data is crowd-sourced, so the odd
upload will not line up. The app now says so up front and points at the fix —
pick a version with the *Perfect sync* badge, or nudge with −/+. Dismissed
permanently once tapped.

**Recents are artwork only.** A full-width row per song wasted most of the
screen; the cover alone is enough to recognise something you just heard. They
now sit in a compact horizontal strip of 64px tiles under "Jump back in", with
the title available on hover and to screen readers.

Also: cover art on every search result, artwork in the player header, example
chips on the empty state, and a calibration control that turns amber when it is
non-zero — tap the value itself to reset it to 0.

## Why −/+ appeared to do nothing

Two separate resets, both keyed on the wrong thing.

`useSync` reset the playback clock whenever `timeline` changed — and `timeline`
is rebuilt on every offset change, so each tap ran `clock.reset(0)`.

`Lyrics.jsx` had the identical bug: it scrolled the lyric list back to the top
and cleared its node cache on every `timeline` change. Even after the clock was
fixed, each tap visibly threw the words away from the singer, which is why the
control still felt broken.

Both now key on `lines:duration`, so they fire once per song and never for a
calibration change. Line keys were also switched off `line.start` (which shifts
with the offset, remounting every line) to a stable index.

Verified in a browser: three taps of "+" move the offset `0.0s → +1.5s` with the
lyric scroll position unchanged and no clock jump.

---

## If a song is still a little off

Some uploads add an intro the lyrics don't know about. Use the **−/+ buttons**
in the player bar to shift lyrics in 0.5s steps; the value is saved per song.

## Controls
`Space` play/pause · `←/→` seek 5s · `Esc` close · click any line to jump

## Verified
14/14 test tracks (Hindi film, Hindi indie, Punjabi, English pop) resolve to a
fitting LRC with zero overlapping lines, nothing past the audio end, and
79–100% Devanagari on Hindi songs.
