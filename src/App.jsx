import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Search, Loader2, Play, Pause, SkipBack, SkipForward, X, Music4,
  Heart, Clock, Minus, Plus, AudioLines, ExternalLink, AlertTriangle, WifiOff, Check, SlidersHorizontal, Sparkles,
} from 'lucide-react';

import Player from './components/Player';
import Lyrics from './components/Lyrics';
import useSync from './hooks/useSync';
import { parseVideoId, oembed, PLAYER_STATE } from './lib/youtube';
import { searchTracks } from './lib/search';
import { resolveLyrics } from './lib/lyrics';
import { formatTime } from './lib/timeline';

/* ── Local persistence (no backend) ────────────────────────────── */
const load = (k, f) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; }
};
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* noop */ } };


/**
 * Artwork for a track. Stored recents predate the thumbnail field, so derive
 * it from the video id rather than trusting what was saved.
 *
 * `mqdefault` is used deliberately: `hqdefault` is a 480x360 (4:3) frame with
 * black letterbox bars baked in, which both muddied the blurred background and
 * forced an ugly crop. `mqdefault` is a clean 320x180 16:9 image.
 */
const artFor = (t) =>
  t?.videoId ? `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg` : (t?.thumbnail || '');


/**
 * Tells the user, before they commit, how well the lyrics will track this
 * particular upload. Sync problems are caused by the video being a different
 * cut from the one the LRC was timed against, so this is knowable up front.
 */
const FIT_STYLE = {
  exact: { label: 'Perfect sync', color: 'var(--color-glow)' },
  good: { label: 'Good sync', color: 'var(--color-glow-2)' },
  offset: { label: 'May need nudge', color: 'var(--color-warn)' },
  poor: { label: 'Off-sync', color: 'var(--color-hot)' },
};

function FitBadge({ fit }) {
  const style = FIT_STYLE[fit?.tier];
  if (!style) return null;
  return (
    <span
      title={fit.note}
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.08em]"
      style={{ color: style.color, background: `color-mix(in srgb, ${style.color} 14%, transparent)` }}
    >
      {fit.tier === 'exact' && <Check size={10} strokeWidth={3.2} />}
      {fit.tier === 'poor' && <AlertTriangle size={10} strokeWidth={3} />}
      {style.label}
    </span>
  );
}

/**
 * Run a state change inside a View Transition when the browser supports it.
 * Chrome/Edge cross-fade the results grid into the lyric stage; every other
 * browser just applies the update immediately.
 */
const withTransition = (fn) => {
  if (typeof document !== 'undefined' && document.startViewTransition) {
    document.startViewTransition(() => flushSync(fn));
  } else {
    fn();
  }
};

export default function App() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  const [track, setTrack] = useState(null);
  const [lyrics, setLyrics] = useState({ status: 'idle', lines: [], message: null, meta: {} });
  const [offset, setOffset] = useState(0);

  const [playerState, setPlayerState] = useState(PLAYER_STATE.UNSTARTED);
  const [duration, setDuration] = useState(0);
  const [displayTime, setDisplayTime] = useState(0);
  const [playerError, setPlayerError] = useState(null);

  const [recents, setRecents] = useState(() => load('ly:recents', []));
  const [favourites, setFavourites] = useState(() => load('ly:favs', []));

  const playerRef = useRef(null);
  const stateRef = useRef(PLAYER_STATE.UNSTARTED);
  const searchAbort = useRef(null);
  const resolvedFor = useRef(null);
  const stageRef = useRef(null);
  const [syncOnly, setSyncOnly] = useState(() => load('ly:syncOnly', true));
  const [noteSeen, setNoteSeen] = useState(() => load('ly:noteSeen', false));
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  // Nothing here works without the network, so say so plainly.
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const sync = useSync({ lines: lyrics.lines, duration: duration || track?.duration || 0, offset });

  const playing = playerState === PLAYER_STATE.PLAYING;
  const buffering = playerState === PLAYER_STATE.BUFFERING;

  /* ── Search ──────────────────────────────────────────────────── */
  const runSearch = useCallback(async (raw) => {
    const q = String(raw || '').trim();
    if (!q) return;
    searchAbort.current?.abort();
    const ctrl = new AbortController();
    searchAbort.current = ctrl;

    setSearching(true);
    setSearchError(null);
    try {
      // A pasted link resolves instantly without a search round-trip.
      const direct = parseVideoId(q);
      if (direct) {
        const info = await oembed(direct, ctrl.signal);
        setResults([{
          videoId: direct,
          title: info?.title || `YouTube ${direct}`,
          author: info?.author || '',
          duration: 0,
        }]);
        return;
      }
      const { items, error } = await searchTracks(q, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setResults(items);
      if (error) setSearchError(error);
      else if (!items.length) setSearchError('No results. Try adding the artist name.');
    } catch (e) {
      if (!ctrl.signal.aborted) setSearchError(e?.message || 'Search failed.');
    } finally {
      if (!ctrl.signal.aborted) setSearching(false);
    }
  }, []);

  /* ── Selecting a track ───────────────────────────────────────── */
  const pick = useCallback(async (item) => {
    withTransition(() => {
      setTrack(item);
      setPlayerError(null);
      setDuration(item.duration || 0);
      setDisplayTime(0);
      setPlayerState(PLAYER_STATE.UNSTARTED);
      setLyrics({ status: 'loading', lines: [], message: null, meta: {} });
    });

    const savedOffset = load(`ly:off:${item.videoId}`, null);
    setOffset(typeof savedOffset === 'number' ? savedOffset : 0);

    setRecents((prev) => {
      const next = [item, ...prev.filter((r) => r.videoId !== item.videoId)].slice(0, 24);
      save('ly:recents', next);
      return next;
    });

    // Without a duration we cannot judge which lyric variant fits; the effect
    // below re-runs as soon as the player reports the real length.
    if (!item.duration) return;

    resolvedFor.current = `${item.videoId}:${Math.round(item.duration)}`;
    const res = await resolveLyrics(item);
    setLyrics({ status: res.status, lines: res.lines, message: res.message, meta: res.meta });
    if (typeof savedOffset !== 'number' && res.offset) setOffset(res.offset);
  }, []);

  // The player is the only authoritative source of duration. If lyrics were
  // resolved before we knew it (search results can report 0), redo the match
  // now that the real length is in.
  useEffect(() => {
    if (!track || !duration) return;
    const key = `${track.videoId}:${Math.round(duration)}`;
    if (resolvedFor.current === key) return;

    const known = Math.round(track.duration || 0);
    const needsRedo = !known || Math.abs(known - Math.round(duration)) > 2;
    if (!needsRedo && resolvedFor.current) return;

    resolvedFor.current = key;
    let alive = true;
    (async () => {
      const res = await resolveLyrics({ ...track, duration: Math.round(duration) });
      if (!alive) return;
      setLyrics({ status: res.status, lines: res.lines, message: res.message, meta: res.meta });
      const saved = load(`ly:off:${track.videoId}`, null);
      if (typeof saved !== 'number') setOffset(res.offset || 0);
    })();
    return () => { alive = false; };
  }, [track, duration]);

  // A11y: when a track opens, move focus to the player stage so screen-reader
  // and keyboard users are taken to the new view instead of being left on the
  // result button that just disappeared. Runs after the stage has mounted.
  useEffect(() => {
    if (!track) return undefined;
    const id = requestAnimationFrame(() => {
      stageRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [track]);

  /* ── Transport ───────────────────────────────────────────────── */
  const togglePlay = useCallback(() => {
    if (playing) playerRef.current?.pause();
    else playerRef.current?.play();
  }, [playing]);

  const seek = useCallback((t) => {
    const v = Math.max(0, t);
    playerRef.current?.seekTo(v);
    sync.snapTo(v);
    setDisplayTime(v);
  }, [sync]);

  const close = useCallback(() => {
    playerRef.current?.pause();
    withTransition(() => {
      setTrack(null);
      setLyrics({ status: 'idle', lines: [], message: null, meta: {} });
      setPlayerState(PLAYER_STATE.UNSTARTED);
    });
    setDuration(0);
    setDisplayTime(0);
  }, []);

  const nudgeOffset = useCallback((d) => {
    setOffset((prev) => {
      const next = Math.round((prev + d) * 10) / 10;
      if (track) save(`ly:off:${track.videoId}`, next);
      return next;
    });
  }, [track]);

  const toggleFav = useCallback((item) => {
    setFavourites((prev) => {
      const exists = prev.some((f) => f.videoId === item.videoId);
      const next = exists ? prev.filter((f) => f.videoId !== item.videoId) : [item, ...prev].slice(0, 60);
      save('ly:favs', next);
      return next;
    });
  }, []);

  const isFav = useMemo(
    () => (track ? favourites.some((f) => f.videoId === track.videoId) : false),
    [favourites, track],
  );

  /* ── Keyboard ────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (!track) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.code === 'ArrowRight') { e.preventDefault(); seek(sync.readClock() + 5); }
      if (e.code === 'ArrowLeft') { e.preventDefault(); seek(sync.readClock() - 5); }
      if (e.code === 'Escape') { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [track, togglePlay, seek, close, sync]);

  useEffect(() => {
    if (!track) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [track]);

  const total = duration || track?.duration || 0;
  const browsing = !query.trim() && results.length === 0;
  const shelf = query.trim() ? [] : favourites;
  // Recents are shown as a compact artwork strip, so they are NOT part of the
  // row list — the old layout wasted a full-width row on each one.
  const recentTiles = browsing ? recents : [];

  // Hiding the badly-timed uploads is the default, because a drifting lyric is
  // worse than one fewer choice. The count of what's hidden stays visible.
  const shown = useMemo(
    () => (syncOnly ? results.filter((r) => r.fit?.tier !== 'poor') : results),
    [results, syncOnly],
  );
  const hidden = results.length - shown.length;

  return (
    <div className="app-bg relative min-h-screen">
      {/* Browse-screen ambience: tinted by the most recent song's artwork. */}
      <div
        className="ambience"
        data-on={recents[0] ? 'true' : 'false'}
        aria-hidden="true"
        style={recents[0] ? { backgroundImage: `url(${artFor(recents[0])})` } : undefined}
      />
      {/* Everything here needs the network; failing silently would look broken. */}
      {!online && (
        <div
          role="status"
          className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-[color:var(--color-hot)] px-4 py-2 text-[12.5px] font-bold text-[color:var(--color-ink)]"
        >
          <WifiOff size={14} /> You are offline — search and playback are paused.
        </div>
      )}
      <main className="relative z-10 mx-auto w-full max-w-5xl px-5 pb-28 pt-10 sm:px-8">
        {/* Header */}
        <header className="mb-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className="grid h-11 w-11 place-items-center rounded-2xl"
              style={{ background: 'linear-gradient(145deg,var(--color-glow),var(--color-glow-2))' }}
            >
              <AudioLines size={21} strokeWidth={2.6} className="text-[color:var(--color-ink)]" />
            </span>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight">
                ly<span className="text-[color:var(--color-glow)]">·</span>music
              </h1>
              <p className="text-xs font-medium text-[color:var(--color-mute)]">
                Search any song · real-time synced lyrics
              </p>
            </div>
          </div>
        </header>

        {/* Search */}
        <form
          onSubmit={(e) => { e.preventDefault(); runSearch(query); }}
          className="panel flex items-center gap-3 rounded-2xl px-4 py-3"
        >
          <Search size={18} className="shrink-0 text-[color:var(--color-mute)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search any song, or paste a YouTube link…"
            className="min-w-0 flex-1 bg-transparent text-[15px] font-medium outline-none placeholder:text-[color:var(--color-mute)]"
            autoComplete="off"
            spellCheck="false"
          />
          {query && (
            <button type="button" onClick={() => { setQuery(''); setResults([]); setSearchError(null); }} aria-label="Clear" className="tap grid shrink-0 place-items-center rounded-full">
              <X size={16} className="text-[color:var(--color-mute)]" />
            </button>
          )}
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="tap shrink-0 rounded-xl px-4 text-[13px] font-bold text-[color:var(--color-ink)] disabled:opacity-40"
            style={{ background: 'linear-gradient(145deg,var(--color-glow),var(--color-glow-2))' }}
          >
            {searching ? <Loader2 size={15} className="animate-spin" /> : 'Search'}
          </button>
        </form>

        {searchError && (
          <p className="mt-3 flex items-center gap-2 text-[13px] font-medium text-[color:var(--color-hot)]">
            <AlertTriangle size={14} /> {searchError}
          </p>
        )}
        {searching && (
          <p className="mt-3 text-[13px] text-[color:var(--color-mute)]">
            Asking YouTube… first search takes a few seconds.
          </p>
        )}

        {/* A friendly heads-up: lyric data is crowd-sourced, so the odd upload
            will not line up. Telling people up front (and how to fix it) beats
            them concluding the app is broken. Dismissed permanently on tap. */}
        <AnimatePresence>
          {!noteSeen && (
            <motion.div
              initial={{ opacity: 0, y: -8, height: 0 }}
              animate={{ opacity: 1, y: 0, height: 'auto' }}
              exit={{ opacity: 0, y: -8, height: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="mt-4 overflow-hidden"
            >
              <div className="panel flex items-start gap-3 rounded-2xl px-4 py-3.5">
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
                  style={{ background: 'color-mix(in srgb, var(--color-glow) 16%, transparent)' }}
                  aria-hidden="true"
                >
                  <Sparkles size={16} className="text-[color:var(--color-glow)]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-bold leading-snug">
                    Heads-up — not every upload lines up perfectly
                  </p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--color-mute)]">
                    Lyrics are matched to a specific recording. If a song feels off, try another
                    version from the results — look for the{' '}
                    <span className="font-bold text-[color:var(--color-glow)]">Perfect sync</span>{' '}
                    badge — or fine-tune it with the −/+ buttons while it plays.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setNoteSeen(true); save('ly:noteSeen', true); }}
                  aria-label="Dismiss"
                  className="tap grid shrink-0 place-items-center rounded-full"
                >
                  <X size={15} className="text-[color:var(--color-mute)]" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Recently played — artwork only. A full row per song wasted the space;
            the cover is enough to recognise a track you just heard. */}
        {recentTiles.length > 0 && (
          <section className="mt-7">
            <h2 className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-mute)]">
              <Clock size={12} /> Jump back in
            </h2>
            <div className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-2" style={{ scrollbarWidth: 'thin' }}>
              {recentTiles.map((item) => (
                <motion.button
                  key={item.videoId}
                  type="button"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  whileTap={{ scale: 0.94 }}
                  onClick={() => pick(item)}
                  title={`${item.title}${item.author ? ` — ${item.author}` : ''}`}
                  aria-label={`Play ${item.title}`}
                  className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-[color:var(--color-line)]"
                >
                  <img
                    src={artFor(item)}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
                  />
                  <span className="absolute inset-0 grid place-items-center bg-black/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                    <Play size={17} fill="currentColor" className="text-white" />
                  </span>
                </motion.button>
              ))}
            </div>
          </section>
        )}

        {/* Results / shelf */}
        <section className="mt-7">
          {results.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-mute)]">
                Results
              </h2>
              <button
                type="button"
                onClick={() => setSyncOnly((v) => { save('ly:syncOnly', !v); return !v; })}
                aria-pressed={syncOnly}
                className="tap inline-flex items-center gap-1.5 rounded-full border px-3 text-[11px] font-bold"
                style={{
                  borderColor: syncOnly ? 'var(--color-glow)' : 'var(--color-line)',
                  color: syncOnly ? 'var(--color-glow)' : 'var(--color-mute)',
                  background: syncOnly ? 'color-mix(in srgb, var(--color-glow) 12%, transparent)' : 'transparent',
                }}
              >
                <SlidersHorizontal size={12} />
                Reliable sync only
                {hidden > 0 && syncOnly && <span className="opacity-70">· {hidden} hidden</span>}
              </button>
            </div>
          )}
          {results.length === 0 && shelf.length > 0 && (
            <h2 className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-mute)]">
              <Heart size={12} /> Favourites
            </h2>
          )}

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {(results.length ? shown : shelf).map((item) => (
              <motion.button
                key={item.videoId}
                type="button"
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                onClick={() => pick(item)}
                className="btn-ghost group flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left hover:border-[color:var(--color-glow)]/40"
              >
                {/* Real cover art makes results scannable; the note icon is
                    only a placeholder for the moment before it loads. */}
                <span className="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-white/5">
                  <Music4 size={17} className="text-[color:var(--color-glow)]" />
                  <img
                    src={artFor(item)}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 h-full w-full object-cover"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-bold">{item.title}</span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] text-[color:var(--color-mute)]">
                      {item.author}{item.duration ? ` · ${formatTime(item.duration)}` : ''}
                    </span>
                    <FitBadge fit={item.fit} />
                  </span>
                </span>
                <Play size={15} className="shrink-0 text-[color:var(--color-mute)] group-hover:text-[color:var(--color-glow)]" fill="currentColor" />
              </motion.button>
            ))}
          </div>

          {results.length > 0 && shown.length === 0 && (
            <div className="panel rounded-2xl px-6 py-10 text-center">
              <p className="text-[14px] font-bold">Every upload for this song is a different cut</p>
              <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-[color:var(--color-mute)]">
                None of them match the lyric timings. Turn off “Reliable sync only” to play one
                anyway and calibrate with the −/+ buttons.
              </p>
            </div>
          )}

          {results.length === 0 && shelf.length === 0 && !searching && (
            <div className="panel mt-2 rounded-3xl px-6 py-12 text-center">
              <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl"
                style={{ background: 'color-mix(in srgb, var(--color-glow) 14%, transparent)' }}>
                <AudioLines size={24} className="text-[color:var(--color-glow)]" />
              </span>
              <p className="text-[16px] font-extrabold">What do you want to sing?</p>
              <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-[color:var(--color-mute)]">
                Search any song — ly·music finds the recording, then matches lyrics that line up
                with it. Hindi shows in Devanagari, English in Latin.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {['kesariya', 'tum hi ho', 'husn anuv jain', 'blinding lights'].map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => { setQuery(ex); runSearch(ex); }}
                    className="btn-ghost rounded-full px-3.5 py-2 text-[12.5px] font-semibold text-[color:var(--color-soft)] hover:border-[color:var(--color-glow)]/50 hover:text-[color:var(--color-glow)]"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Focus mode */}
      <AnimatePresence>
        {track && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            role="dialog" aria-modal="true" aria-label={`Now playing ${track.title}`}
            className="fixed inset-0 z-50 flex flex-col"
          >
            {/* The song's own artwork, blurred into ambient colour, sits at the
                very back of the overlay. The scrim above it is deliberately
                translucent so the colour survives while text stays legible. */}
            <div
              className="absolute inset-0 -z-20 overflow-hidden"
              aria-hidden="true"
            >
              <div
                className="ambience-art"
                style={{ backgroundImage: `url(${artFor(track)})` }}
              />
            </div>
            <div
              className="absolute inset-0 -z-10 cursor-pointer"
              onClick={close}
              role="presentation"
              style={{
                background:
                  'radial-gradient(130% 100% at 50% -5%, rgba(11,13,16,0.30), rgba(11,13,16,0.68) 52%, rgba(11,13,16,0.90) 100%)',
                backdropFilter: 'blur(6px)',
              }}
            />

            <motion.section
              initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 14, opacity: 0 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              ref={stageRef}
              tabIndex={-1}
              aria-label={`Now playing ${track.title}`}
              className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 pt-4 outline-none sm:px-8"
            >
              <div className="panel-glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl">
                <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--color-line)] px-5 py-4">
                  <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-white/5">
                    <img
                      src={artFor(track)}
                      alt=""
                      className="h-full w-full object-cover"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-bold">{track.title}</p>
                    <p className="truncate text-[12.5px] text-[color:var(--color-mute)]">{track.author}</p>
                  </div>
                  <button type="button" onClick={() => toggleFav(track)} aria-label="Favourite" className="tap grid shrink-0 place-items-center rounded-full">
                    <Heart size={17} className={isFav ? 'text-[color:var(--color-glow)]' : 'text-[color:var(--color-mute)]'} fill={isFav ? 'currentColor' : 'none'} />
                  </button>
                  <button type="button" onClick={close} aria-label="Close (Esc)" className="tap grid shrink-0 place-items-center rounded-full">
                    <X size={17} className="text-[color:var(--color-mute)]" />
                  </button>
                </div>

                {playerError && (
                  <div className="mx-5 mt-3 flex items-center gap-2 rounded-xl bg-[color:var(--color-hot)]/10 px-3 py-2 text-[12.5px] font-semibold text-[color:var(--color-hot)]">
                    <AlertTriangle size={14} />
                    {playerError}
                    <a
                      href={`https://www.youtube.com/watch?v=${track.videoId}`}
                      target="_blank" rel="noreferrer noopener"
                      className="ml-auto inline-flex items-center gap-1 underline"
                    >
                      Open on YouTube <ExternalLink size={11} />
                    </a>
                  </div>
                )}

                <Player
                  ref={playerRef}
                  videoId={track.videoId}
                  onTime={(t, isPlaying) => { sync.pushTime(t, isPlaying); setDisplayTime(t); }}
                  onDuration={setDuration}
                  onStateChange={(st) => {
                    stateRef.current = st;
                    setPlayerState(st);
                    sync.setPlaying(st === PLAYER_STATE.PLAYING);
                  }}
                  onError={setPlayerError}
                />

                <p className="sr-only" aria-live="polite">
                  {sync.activeIndex >= 0 ? sync.timeline.lines[sync.activeIndex]?.text : ''}
                </p>

                <div className="min-h-0 flex-1">
                  <Lyrics
                    status={lyrics.status}
                    message={lyrics.message}
                    timeline={sync.timeline}
                    activeIndex={sync.activeIndex}
                    phase={sync.phase}
                    gapProgress={sync.gapProgress}
                    activeLineRef={sync.bindActiveLine}
                    onSeekLine={seek}
                  />
                </div>
              </div>
            </motion.section>

            {/* Transport */}
            <div className="shrink-0 px-4 pb-5 pt-3 sm:px-8">
              <div className="panel-glass mx-auto w-full max-w-3xl rounded-3xl px-5 py-4">
                <div className="mb-3 flex items-center gap-3">
                  <span className="w-10 shrink-0 text-right text-[11px] font-bold tabular text-[color:var(--color-mute)]">
                    {formatTime(displayTime)}
                  </span>
                  <input
                    type="range" min={0} max={Math.max(1, Math.round(total))} value={Math.round(displayTime)}
                    onChange={(e) => seek(Number(e.target.value))}
                    aria-label="Seek"
                    className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full
                      [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none
                      [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[color:var(--color-glow)]"
                    style={{
                      background: `linear-gradient(90deg, var(--color-glow) ${total ? (displayTime / total) * 100 : 0}%, #232830 ${total ? (displayTime / total) * 100 : 0}%)`,
                    }}
                  />
                  <span className="w-10 shrink-0 text-[11px] font-bold tabular text-[color:var(--color-mute)]">
                    {formatTime(total)}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-3">
                  {/* Offset calibration */}
                  <div
                    className="flex items-center gap-1 rounded-full border px-1.5 py-1"
                    title="Shift the lyrics earlier or later. Tap the value to reset."
                    style={{
                      borderColor: offset !== 0 ? 'var(--color-warn)' : 'var(--color-line)',
                      background: offset !== 0 ? 'color-mix(in srgb, var(--color-warn) 10%, transparent)' : 'transparent',
                    }}
                  >
                    <button type="button" onClick={() => nudgeOffset(-0.5)} aria-label="Lyrics earlier" className="tap grid place-items-center rounded-full hover:bg-white/5">
                      <Minus size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => nudgeOffset(-offset)}
                      disabled={offset === 0}
                      aria-label="Reset lyric timing"
                      className="min-w-[46px] text-center text-[10.5px] font-bold tabular disabled:cursor-default"
                      style={{ color: offset !== 0 ? 'var(--color-warn)' : 'var(--color-mute)' }}
                    >
                      {offset > 0 ? `+${offset.toFixed(1)}` : offset.toFixed(1)}s
                    </button>
                    <button type="button" onClick={() => nudgeOffset(0.5)} aria-label="Lyrics later" className="tap grid place-items-center rounded-full hover:bg-white/5">
                      <Plus size={12} />
                    </button>
                  </div>

                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => seek(sync.readClock() - 10)} aria-label="Back 10s" className="tap grid place-items-center rounded-full text-[color:var(--color-soft)]">
                      <SkipBack size={18} />
                    </button>
                    <button
                      type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
                      className="grid h-14 w-14 place-items-center rounded-full text-[color:var(--color-ink)]"
                      style={{ background: 'linear-gradient(145deg,var(--color-glow),var(--color-glow-2))' }}
                    >
                      {buffering ? <Loader2 size={20} className="animate-spin" />
                        : playing ? <Pause size={20} fill="currentColor" />
                        : <Play size={20} fill="currentColor" />}
                    </button>
                    <button type="button" onClick={() => seek(sync.readClock() + 10)} aria-label="Forward 10s" className="tap grid place-items-center rounded-full text-[color:var(--color-soft)]">
                      <SkipForward size={18} />
                    </button>
                  </div>

                  <div className="hidden w-[104px] justify-end sm:flex">
                    {playing && (
                      <span className="eq flex h-4 items-end gap-[3px]">
                        <span className="w-[3px] rounded-full bg-[color:var(--color-glow)]" />
                        <span className="w-[3px] rounded-full bg-[color:var(--color-glow)]" />
                        <span className="w-[3px] rounded-full bg-[color:var(--color-glow)]" />
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
