/**
 * lyrics.js — find lyrics that genuinely belong to the audio being played.
 *
 * THE CORE PROBLEM (learned the hard way)
 * ---------------------------------------
 * LRC files are written against a STUDIO recording. A YouTube upload of the
 * same song is often a different cut: extra intro, a label sting, a fade-out,
 * a live version, a lofi remix. If you match lyrics by title alone you get a
 * timeline built for a different waveform, and every line lands late or early.
 *
 * THE FIX — two independent signals, then reconcile:
 *   1. iTunes gives the CANONICAL studio duration for a track (keyless, CORS
 *      enabled, verified working from the browser). That tells us how long the
 *      real recording is, independent of whatever YouTube upload we found.
 *   2. LRCLIB is then queried for an LRC matching that canonical duration, so
 *      the timeline provably belongs to the studio cut.
 *   3. The YouTube video is compared against the canonical length. Any
 *      difference is INTRO PADDING, which we estimate and apply as an offset
 *      instead of letting it desync every line.
 */

import { normaliseLines, analyseScripts, romanize, romanVariants, RE_DEVA } from './script.js';

const ITUNES = 'https://itunes.apple.com/search';
const LRCLIB = 'https://lrclib.net/api';

const DEVA = /[\u0900-\u097F]/;

async function getJSON(url, signal, timeout = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

/* ── Title cleanup ─────────────────────────────────────────────── */

const NOISE =
  /\b(official|full|lyrical|lyrics?|video|audio|song|music\s*video|hd|4k|remaster(ed)?|reprise|with\s+lyrics|out\s+now|full\s+song)\b/gi;

/** YouTube titles are noisy; reduce to a probable artist + track. */
export function parseTrackFromTitle(rawTitle = '', channel = '') {
  let t = String(rawTitle)
    .replace(/\s*[|｜].*$/, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/["“”'']/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  let artist = '';

  // "Artist: Title"
  const colon = t.match(/^([^:]{2,40}):\s*(.+)$/);
  if (colon) { artist = colon[1].trim(); t = colon[2].trim(); }

  // "Artist - Title" or "Title - Artist". The channel disambiguates when it
  // matches one side. Otherwise DON'T guess: a label channel like
  // "Sony Music India" means the dash is usually "Track - Film", and guessing
  // artist-first turns the song name into the artist.
  let alternates = [];
  if (!artist) {
    const parts = t.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
      const ch = norm(String(channel).replace(/vevo$/i, '').replace(/\s*-\s*topic$/i, ''));
      const first = norm(parts[0]);
      const last = norm(parts[parts.length - 1]);
      if (ch && last && (ch.includes(last) || last.includes(ch))) {
        artist = parts[parts.length - 1]; t = parts.slice(0, -1).join(' - ');
      } else if (ch && first && (ch.includes(first) || first.includes(ch))) {
        [artist] = parts; t = parts.slice(1).join(' - ');
      } else {
        // Ambiguous: treat the FIRST segment as the track (most common for
        // label uploads) and keep the other reading as a fallback query.
        t = parts[0];
        alternates = [{ title: parts.slice(1).join(' - '), artist: parts[0] }];
      }
    }
  }

  if (!artist) {
    artist = String(channel).replace(/vevo$/i, '').replace(/\s*-\s*topic$/i, '').trim();
  }

  // Record labels upload most Indian music, but a label is NOT the artist.
  // Keeping it would make every artist-filtered lyric query return nothing.
  if (/\b(t-series|zee music|sony music|saregama|speed records|tips|venus|eros|yrf|shemaroo|times music|aditya music|lahari|believe|universal music|warner music|sony bmg)\b/i.test(artist)) {
    artist = '';
  }

  return {
    title: t.replace(NOISE, ' ').replace(/\s{2,}/g, ' ').trim() || String(rawTitle).trim(),
    artist: artist.trim(),
    alternates,
  };
}

/* ── LRC parsing ───────────────────────────────────────────────── */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** Parse `[mm:ss.xx] text` into ordered lines. Never throws. */
export function parseLRC(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    TIME_TAG.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = TIME_TAG.exec(line)) !== null) stamps.push(m);
    if (!stamps.length) continue;
    const text = line.replace(TIME_TAG, '').trim();
    for (const s of stamps) {
      const frac = Number((s[3] ?? '0').padEnd(3, '0').slice(0, 3)) || 0;
      const time = Number(s[1]) * 60 + Number(s[2]) + frac / 1000;
      if (Number.isFinite(time)) out.push({ time, text });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

const stampsOf = (lines) => lines.filter((l) => Number.isFinite(l.time)).map((l) => l.time);
const wordsOf = (lines) => lines.filter((l) => l.text && l.text.trim()).length;

/* ── iTunes: canonical track identity ──────────────────────────── */

/**
 * Look up the canonical studio recording. Returns the best match with its
 * authoritative duration, which is the anchor for everything downstream.
 */
export async function findCanonicalTrack({ title, artist }, signal, hintDuration = 0) {
  const term = `${artist} ${title}`.trim() || title;
  const url = `${ITUNES}?term=${encodeURIComponent(term)}&entity=song&limit=8&country=IN`;
  const data = await getJSON(url, signal);
  const results = data?.results || [];
  if (!results.length) return null;

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097F]/g, '');
  const wantT = norm(title);
  const wantA = norm(artist);

  let best = null;
  let bestScore = -1;
  for (const r of results) {
    const t = norm(r.trackName);
    const a = norm(r.artistName);
    let score = 0;
    if (t === wantT) score += 100;
    else if (t.includes(wantT) || wantT.includes(t)) score += 55;
    if (wantA && (a.includes(wantA) || wantA.includes(a))) score += 45;
    // Prefer the release closest in length to the upload we are actually
    // playing, so a long remix cannot hijack the anchor.
    if (hintDuration && r.trackTimeMillis) {
      const d = Math.abs(r.trackTimeMillis / 1000 - hintDuration);
      score += Math.max(0, 60 - d * 1.2);
    }
    // Penalise obvious non-originals unless the query asked for them.
    if (/remix|lofi|slowed|reverb|cover|karaoke|instrumental|live/i.test(r.trackName) &&
        !/remix|lofi|slowed|cover|live/i.test(title)) score -= 60;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  // If nothing scored, iTunes returned an unrelated song. Accepting results[0]
  // anyway poisoned everything downstream: for "Aaj Din Chadheya" it returned
  // "Jhol (Acoustic)", which then entered the title whitelist and let a
  // completely different track's lyrics through. Better to have no canonical
  // track than a wrong one.
  if (!best || bestScore <= 0) return null;

  // Even a scoring winner must share a word with what we asked for.
  const bestNorm = norm(best.trackName);
  const overlaps = wantT && (bestNorm.includes(wantT) || wantT.includes(bestNorm));
  if (!overlaps && bestScore < 60) return null;

  return {
    title: best.trackName,
    artist: best.artistName,
    album: best.collectionName || '',
    duration: Math.round((best.trackTimeMillis || 0) / 1000),
    artwork: (best.artworkUrl100 || '').replace('100x100', '600x600'),
    previewUrl: best.previewUrl || null,
  };
}

/* ── LRCLIB: variant scoring ───────────────────────────────────── */

async function gather(title, artist, durations, signal) {
  const seen = new Map();
  const add = (list) => {
    if (Array.isArray(list)) for (const x of list) if (x?.syncedLyrics && !seen.has(x.id)) seen.set(x.id, x);
  };
  const q = (o) => new URLSearchParams(o).toString();

  // Probe every plausible length: the studio cut AND the actual upload. A
  // short video edit has its own LRC keyed to that shorter duration.
  for (const d of [...new Set((Array.isArray(durations) ? durations : [durations]).filter(Boolean))]) {
    const exact = await getJSON(
      `${LRCLIB}/get?${q({ artist_name: artist, track_name: title, duration: String(Math.round(d)) })}`,
      signal,
    );
    if (exact?.syncedLyrics) seen.set(exact.id, exact);
  }
  if (artist) add(await getJSON(`${LRCLIB}/search?${q({ track_name: title, artist_name: artist })}`, signal));
  // Title-only matters: the right variant is often credited to the composer,
  // and LRCLIB's search returns a DIFFERENT slice of records per query shape.
  add(await getJSON(`${LRCLIB}/search?${q({ track_name: title })}`, signal));
  add(await getJSON(`${LRCLIB}/search?${q({ q: title })}`, signal));
  if (artist) add(await getJSON(`${LRCLIB}/search?${q({ q: `${title} ${artist}` })}`, signal));

  return [...seen.values()];
}


/**
 * Reject LRCs that belong to a DIFFERENT SONG.
 *
 * LRCLIB's search is fuzzy: querying "tum hi ho" returns "Uska Hi Banana", and
 * a title-only query for a common word can return an unrelated track that then
 * wins on duration alone. Comparing normalised titles stops the app from
 * confidently displaying the wrong lyrics.
 */
/**
 * Bollywood titles are transliterated inconsistently: the same song is filed as
 * "Aaj Din Chadheya" and "Ajj Din Chadheya", "Kesariya"/"Kesaria",
 * "Chaleya"/"Chaleyaa". Folding those spelling variants stops a perfectly good
 * record from being rejected as a different song — which is how the 315s
 * Devanagari "Ajj Din Chadheya" was skipped in favour of a Lofi remix.
 */
const foldSpelling = (x) => String(x || '')
  .replace(/aa+/g, 'a')
  .replace(/ee+/g, 'i')
  .replace(/oo+/g, 'u')
  .replace(/([bcdfghjklmnpqrstvwxyz])\1+/g, '$1')
  .replace(/ph/g, 'f')
  .replace(/y(?=[aeiou])/g, '')
  .replace(/[aeiou]+$/g, '');

const normTitle = (x) => String(x || '')
  .toLowerCase()
  .replace(/\(from[^)]*\)/gi, ' ')
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  .replace(/\b(official|lyrical|lyrics?|video|audio|song|full|hd|4k|remaster(ed)?|version|mix|feat\.?|ft\.?)\b/gi, ' ')
  .replace(/[^a-z0-9\u0900-\u097F ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Token overlap in both directions; tolerant of word order and extra credits. */
function titleMatches(recTitle, wantTitles) {
  const a = normTitle(recTitle);
  if (!a) return false;
  const at = new Set(a.split(' ').filter(Boolean));

  for (const want of wantTitles) {
    const b = normTitle(want);
    if (!b) continue;
    if (a === b || a.includes(b) || b.includes(a)) return true;

    // Compare on folded spellings too, so "aaj" matches "ajj".
    const af = foldSpelling(a);
    const bf = foldSpelling(b);
    if (af && bf && (af === bf || af.includes(bf) || bf.includes(af))) return true;

    const bt = [...new Set(b.split(' ').filter(Boolean))];
    if (!bt.length) continue;
    const atFolded = new Set([...at].map(foldSpelling));
    const hits = bt.filter((t) => at.has(t) || atFolded.has(foldSpelling(t))).length;
    // Short titles ("Husn") must match fully; longer ones allow one stray word.
    const need = bt.length <= 2 ? bt.length : Math.ceil(bt.length * 0.7);
    if (hits >= need) return true;
  }
  return false;
}

/**
 * Score a candidate against the canonical duration.
 * `preferScript: 'deva'` makes Devanagari outrank romanized transcriptions.
 */
function score(rec, canonicalDuration, preferScript) {
  const rawLines = parseLRC(rec.syncedLyrics);

  // Make the file readable BEFORE judging it. Crowd-sourced LRCs mix scripts
  // (every LRCLIB "Chaleya" is 30 Devanagari + 8 Gurmukhi lines), so rejecting
  // mixed files would leave popular songs with no lyrics at all. Converting
  // first means we score what the user will actually see.
  const norm = normaliseLines(rawLines, preferScript === 'deva');
  if (!norm.ok) return null;
  const lines = norm.lines;

  const stamps = stampsOf(lines);
  const words = wordsOf(lines);
  if (stamps.length < 5 || words < 8) return null;

  const span = stamps[stamps.length - 1];
  const first = stamps[0];
  const coverage = span / canonicalDuration;

  // A timeline that runs past the recording is a different cut. Hard reject.
  if (span > canonicalDuration + Math.max(3, canonicalDuration * 0.06)) return null;
  if (coverage < 0.5) return null;
  if (first > canonicalDuration * 0.4) return null;

  const linesPerMin = words / (canonicalDuration / 60);
  if (linesPerMin < 2.5) return null;

  const gaps = [];
  for (let i = 1; i < stamps.length; i += 1) gaps.push(stamps[i] - stamps[i - 1]);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)] || 0;

  // Script quality is measured AFTER conversion, so a file that was Gurmukhi
  // and is now clean Devanagari is rewarded, not punished.
  const after = analyseScripts(lines);
  const deva = after.deva;
  const foreign = after.unreadable;
  if (preferScript === 'deva' && foreign > 0.1) return null;
  // A Hindi song rendered in romanised Latin is not acceptable output.
  if (preferScript === 'deva' && deva < 0.5) return null;

  let s = 0;
  if (preferScript === 'deva') s += deva * 1200 - foreign * 400;
  // Prefer files that needed no rewriting at all, all else being equal.
  s -= norm.converted * 2;

  // A record whose OWN declared length matches the recording we are matching
  // against was written for this exact cut, so it needs no guessed offset.
  // This is the single strongest signal available and must outrank everything
  // except script correctness.
  if (Number.isFinite(rec.duration) && rec.duration > 0) {
    const durGap = Math.abs(rec.duration - canonicalDuration);
    if (durGap <= 3) s += 900;
    else if (durGap <= 8) s += 400;
  }

  // Lofi / slowed / club edits are re-performed at a different tempo, so their
  // stamps never line up with the original upload. ("Aaj Din Chadheya" was
  // resolving to a Dr LoFi record and inheriting a bogus +12s shift.)
  if (/\b(lofi|lo-fi|slowed|reverb|nightcore|club\s*mix|remix|sped\s*up)\b/i
    .test(`${rec.trackName || ''} ${rec.artistName || ''}`)) s -= 1500;
  s += Math.max(0, 400 - Math.abs(coverage - 0.93) * 900);
  if (Number.isFinite(rec.duration) && rec.duration > 0) {
    s += Math.max(0, 200 - Math.abs(rec.duration - canonicalDuration) * 10);
  }
  s += Math.min(80, words);
  s += Math.max(-120, Math.min(120, (linesPerMin - 6) * 12));
  if (medianGap > 9) s -= 120;

  return { rec, lines, score: s, coverage, span, deva, words };
}


/**
 * Hindi upload titles append descriptive filler after the song name:
 * "तुम ही हो  आशिकी 2 पूरा गाना बोल के साथ" = "Tum Hi Ho" + album + "full song
 * with lyrics". Sent whole, that query matches nothing and the resolver then
 * settles for an unrelated record. Trim the filler and keep the leading words.
 */
const HINDI_FILLER = /(पूरा|पूरी|गाना|गीत|बोल|के\s*साथ|वीडियो|ऑडियो|लिरिक्स|सॉन्ग|फुल|एचडी|नया|सुपरहिट|हिट|मूवी|फिल्म)/;

function trimHindiTitle(title) {
  const raw = String(title || '').trim();
  if (!raw) return '';
  // Cut at the first separator; the song name is almost always first.
  const head = raw.split(/[|•·—–-]/)[0].trim();
  const words = head.split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of words) {
    if (HINDI_FILLER.test(w) || /^\d+$/.test(w)) break;
    out.push(w);
    if (out.length >= 5) break;
  }
  return (out.length ? out.join(' ') : head).trim();
}

/**
 * Full resolution pipeline.
 *
 * @param {{videoId:string,title:string,author:string,duration:number}} video
 * @returns {Promise<{status:string, lines:Array, offset:number, meta:object, message:string|null}>}
 */
export async function resolveLyrics(video, signal) {
  const parsed = parseTrackFromTitle(video.title, video.author);
  const looksHindi =
    DEVA.test(video.title) ||
    /\b(hindi|bollywood|arijit|shreya|atif|jubin|armaan|neha|sonu|udit|pritam|mithoon|t-series|zee music|sony music india|saregama|speed records|anuv jain|talwiinder|king|darshan raval|vishal|shekhar)\b/i.test(
      `${video.title} ${video.author}`,
    );

  // A Devanagari title is unsearchable on iTunes/LRCLIB (both index romanised
  // names), and its trailing filler poisons the query, so normalise it BEFORE
  // the canonical lookup — that lookup anchors everything downstream.
  const devaCore = RE_DEVA.test(parsed.title) ? trimHindiTitle(parsed.title) : '';
  // Databases spell Bollywood titles loosely ("Tum Hi Ho", not the strictly
  // phonetic "Tum Hee Ho"), so try the popular spelling first.
  const romanAll = devaCore ? romanVariants(devaCore) : [];
  const romanCore = romanAll[0] || '';
  const lookup = romanCore
    ? { ...parsed, title: romanCore, artist: parsed.artist || '' }
    : parsed;

  // 1. Canonical studio track (authoritative duration).
  const canonical = await findCanonicalTrack(lookup, signal, video.duration || 0);
  const canonicalDuration = canonical?.duration || video.duration;
  const videoDur = video.duration || canonicalDuration;
  const delta = videoDur - canonicalDuration;

  // iTunes titles carry qualifiers LRCLIB does not index, e.g.
  // 'Pachtaoge (From "Jaani Ve") [feat. B Praak]'. Strip them, and keep the
  // raw YouTube-derived title as a second query.
  const strip = (x) => String(x || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s*[-–—]\s*(title\s*)?(track|song|version)\b.*$/i, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // A Devanagari video title matches nothing in LRCLIB/iTunes, which are
  // indexed under romanised names. Romanising gives the lookup a usable key.
  const rom = (x) => (RE_DEVA.test(String(x || '')) ? romanize(x) : '');

  const titleQueries = [...new Set([
    strip(canonical?.title),
    strip(parsed.title),
    parsed.title,
    ...romanAll,
    devaCore,
    rom(strip(parsed.title)),
  ].filter(Boolean))].slice(0, 6);

  const splitCredits = (x) => String(x || '')
    .split(/[,&;/]|\bfeat\.?\b|\bft\.?\b/i)
    .map((v) => v.trim())
    .filter((v) => v.length > 1);

  const artistQueries = [...new Set([
    ...splitCredits(canonical?.artist),
    ...splitCredits(parsed.artist),
  ])].slice(0, 4);

  // 2. Candidate LRCs judged against the canonical duration. Query every
  //    title/artist combination — a single phrasing often misses the record.
  const seenIds = new Map();
  for (const ti of titleQueries) {
    // '' first: a title-only query surfaces variants that any artist filter
    // would hide (verified: the only LRCs fitting Kesariya's 172s edit).
    for (const ar of ['', ...artistQueries]) {
      const batch = await gather(ti, ar, [canonicalDuration, videoDur], signal);
      for (const c of batch) if (!seenIds.has(c.id)) seenIds.set(c.id, c);
      if (seenIds.size >= 40) break;
    }
    if (seenIds.size >= 40) break;
  }
  let cands = [...seenIds.values()];

  // Discard records for a DIFFERENT SONG before any scoring happens. LRCLIB's
  // fuzzy search mixes unrelated tracks into the results ("tum hi ho" returns
  // "Uska Hi Banana"), and without this gate one of them can win on duration.
  const wantTitles = [canonical?.title, parsed.title, video.title,
    devaCore, ...romanAll, rom(parsed.title)].filter(Boolean);
  const onTitle = cands.filter((c) => titleMatches(c.trackName, wantTitles));

  // If NOTHING matches the title, every candidate belongs to a different song.
  // The old code fell back to the full list here, which is how an unrelated
  // track ("Maanu - Jhol") was served for "Aaj Din Chadheya". Showing the
  // wrong song's lyrics is the worst possible outcome, so stop instead.
  if (!onTitle.length) {
    return {
      status: 'none',
      lines: [],
      offset: 0,
      meta: { canonical, parsed },
      message: 'No lyrics found for this song.',
    };
  }
  cands = onTitle;

  // Whether a song is Hindi/Urdu is decided by the DATA, not a hardcoded list
  // of artists. If a decent share of the candidate files for this exact track
  // are written in an Indic script, it is an Indic song and Devanagari is the
  // right output. ("Kahani Suno 2.0" by Kaifi Khalil matched no name in the
  // old keyword list, so it silently fell back to romanised Latin.)
  const indicShare = cands.length
    ? cands.filter((c) => /[\u0900-\u097F\u0A00-\u0A7F]/.test(String(c.syncedLyrics || ''))).length / cands.length
    : 0;
  const prefer = looksHindi || indicShare >= 0.25 ? 'deva' : null;
  let scored = cands.map((c) => score(c, canonicalDuration, prefer)).filter(Boolean);
  if (!scored.length && prefer) scored = cands.map((c) => score(c, canonicalDuration, null)).filter(Boolean);
  if (!scored.length) {
    return { status: 'none', lines: [], offset: 0, meta: { canonical, parsed }, message: 'No lyric version matches this recording.' };
  }

  scored.sort((a, b) => b.score - a.score);

  // The lyrics have to fit the VIDEO that is actually playing, not just the
  // studio release. Re-score everything against the video length (allowing
  // for a padded intro) and prefer a candidate that genuinely fits.
  // ── Final arbiter: the lyrics must fit the VIDEO being played ──────────
  // Scoring above used the canonical (studio) length to FIND candidates, but
  // an LRC whose last stamp lands after the video ends can never stay in sync.
  // Rank every candidate by video fit first, quality second.
  // Tolerate a small overrun: uploads routinely trim a fade-out or a few
  // seconds of outro, and the final line is usually held over it. Chaleya's
  // 188s upload against a 194s lyric span was being rejected outright for a
  // 6s tail, leaving a hugely popular song with no lyrics at all.
  const padAllowance = delta >= 2 && delta <= 45 ? Math.min(delta, delta * 0.75) : 0;
  const overrunAllowance = Math.max(3, Math.min(12, videoDur * 0.06));
  const fitsVideo = (c) => c.span + padAllowance <= videoDur + overrunAllowance;

  const byVideo = cands
    .map((c) => score(c, videoDur, prefer))
    .filter(Boolean)
    .filter(fitsVideo)
    .sort((a, b) => b.score - a.score);

  // For an Indic song, a Devanagari file whose STAMPS fit the video is always
  // preferable to a romanised one, even when its declared duration is shorter.
  // ("Kahani Suno 2.0": the Devanagari record declares 174s but carries the
  // same 28 lines at the same times, within ~1s, as the 208s Latin record.)
  if (prefer === 'deva' && byVideo.length) {
    const devaFirst = byVideo.filter((c) => c.deva >= 0.5);
    if (devaFirst.length) byVideo.splice(0, byVideo.length, ...devaFirst, ...byVideo.filter((c) => c.deva < 0.5));
  }

  const byVideoLoose = prefer && !byVideo.length
    ? cands.map((c) => score(c, videoDur, null)).filter(Boolean).filter(fitsVideo)
        .sort((a, b) => b.score - a.score)
    : [];

  let best =
    byVideo[0] ||
    byVideoLoose[0] ||
    scored.filter(fitsVideo).sort((a, b) => b.score - a.score)[0] ||
    null;

  // Nothing fits: this upload is an edit no available LRC matches. Showing
  // lyrics that run 90s past the end is worse than admitting it.
  if (!best) {
    return {
      status: 'none',
      lines: [],
      offset: 0,
      meta: { canonical, parsed, canonicalDuration, videoDuration: videoDur, delta: Math.round(delta) },
      message: 'This upload is a different edit — no lyric version lines up with it.',
    };
  }

  // 3. Offset.
  //
  //    PREVIOUS BUG (this caused "lyrics play before the song"): the shift was
  //    computed as videoDuration - iTunesDuration. But iTunes describes the
  //    STUDIO single, while the chosen LRC may be timed to the *video* cut.
  //    Husn measured: video 240s, iTunes 218s, chosen LRC 239s. The old code
  //    saw delta=22s and injected a +16.5s shift onto a file that was already
  //    perfectly aligned — pushing every line badly out of sync.
  //
  //    The LRC we actually selected is the only correct anchor. If its own
  //    declared duration already matches the video, the file was written for
  //    this cut and the offset MUST be zero.
  const lrcDur = Number(best.rec.duration) || 0;
  const shortEdit = delta <= -8;

  let offset = 0;
  const lrcMatchesVideo = lrcDur > 0 && Math.abs(lrcDur - videoDur) <= 5;

  if (!lrcMatchesVideo) {
    // The LRC belongs to a different-length master. Estimate the intro pad
    // from the LRC's own length when we know it, and only fall back to the
    // iTunes-derived delta when the LRC declares nothing usable.
    const gap = lrcDur > 0 ? videoDur - lrcDur : delta;
    if (gap >= 3 && gap <= 45) {
      const room = videoDur - best.span;
      offset = Math.max(0, Math.min(gap * 0.75, room - 1));
    }
  }

  // Never let an offset push the first line before the audio starts, and never
  // shift so far that the final line falls off the end.
  if (offset !== 0) {
    const firstStamp = best.lines.find((l) => Number.isFinite(l.time))?.time ?? 0;
    if (firstStamp + offset < 0) offset = -firstStamp;
    if (best.span + offset > videoDur - 1) offset = Math.max(0, videoDur - 1 - best.span);
  }

  // Drop lines that start after the audio ends. Uploads routinely trim a
  // fade-out, so an LRC can carry one or two unreachable trailing lines
  // (Chaleya: 194.1s and an empty stamp against a 188s upload). Keeping them
  // would leave the last real line highlighted forever, which reads as the
  // lyrics being stuck. Rejecting the whole file over it is worse.
  const usable = best.lines.filter((l) => !Number.isFinite(l.time) || l.time + offset < videoDur - 0.3);
  const finalLines = usable.length >= 5 ? usable : best.lines;
  const dropped = best.lines.length - finalLines.length;

  return {
    status: 'synced',
    lines: finalLines,
    // Positive offset shifts lyrics LATER, compensating for a padded intro.
    offset: Math.round(offset * 10) / 10,
    meta: {
      canonical,
      parsed,
      lrcId: best.rec.id,
      trackName: best.rec.trackName,
      artistName: best.rec.artistName,
      canonicalDuration,
      videoDuration: video.duration,
      delta: Math.round(delta),
      shortEdit,
      coverage: best.coverage,
      devaRatio: best.deva,
      lrcDuration: lrcDur,
      lrcMatchesVideo,
      autoOffset: offset !== 0,
      droppedTrailing: dropped,
    },
    message: null,
  };
}
