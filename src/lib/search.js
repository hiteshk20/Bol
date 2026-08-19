/**
 * search.js — find playable tracks for a free-text query, without an API key.
 *
 * WHY NOT THE IFRAME PLAYER
 * -------------------------
 * The previous build searched via the IFrame player's `listType:'search'`.
 * That is why searching by name silently returned nothing: YouTube DEPRECATED
 * that feature on 15 November 2020 and it now returns 4xx. It can never work
 * again, so it has been removed entirely.
 *
 * WHAT ACTUALLY WORKS FROM A BROWSER
 * ----------------------------------
 *   • Piped (open-source YouTube front-end API) — sends `access-control-allow-
 *     origin: *`, returns videoId + title + uploader + duration. Verified.
 *   • iTunes Search — CORS-enabled, gives the canonical studio track.
 *
 * Ruled out by testing: YouTube Data API (needs a key), InnerTube
 * (`/youtubei/v1/search`, no CORS headers), most public Invidious mirrors
 * (403/401), and generic CORS proxies (403 / rate-limited).
 *
 * Instances go down often, so we race several and remember the fastest one
 * that answered.
 */

import { annotateFit } from './syncFit';

const INSTANCES = [
  'api.piped.private.coffee',
  'pipedapi.kavin.rocks',
  'pipedapi.adminforge.de',
  'pipedapi.drgns.space',
  'pipedapi.reallyaweso.me',
  'pipedapi.ducks.party',
  'pipedapi.orangenet.cc',
  'piped-api.hostux.net',
  'pipedapi.leptons.xyz',
  'pipedapi.smnz.de',
  'pipedapi.nosebs.ru',
  'pipedapi.phoenixthrush.com',
];

const HEALTHY_KEY = 'ly:instance';
const ID = /^[\w-]{11}$/;

const getHealthy = () => {
  try { return localStorage.getItem(HEALTHY_KEY) || null; } catch { return null; }
};
const setHealthy = (h) => {
  try { localStorage.setItem(HEALTHY_KEY, h); } catch { /* noop */ }
};

async function askInstance(host, query, filter, signal, timeout = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const url = `https://${host}/search?q=${encodeURIComponent(query)}&filter=${filter}`;
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const items = Array.isArray(j) ? j : j?.items;
    return Array.isArray(items) && items.length ? { host, items } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Race every instance; first usable answer wins. */
async function raceInstances(query, filter, signal) {
  const known = getHealthy();
  const ordered = known ? [known, ...INSTANCES.filter((h) => h !== known)] : INSTANCES;

  // Try the remembered instance alone first — usually one fast request.
  if (known) {
    const quick = await askInstance(known, query, filter, signal, 6000);
    if (quick) return quick;
  }

  // Otherwise fan out and take the first that responds.
  const pending = ordered.map((h) => askInstance(h, query, filter, signal, 8000));
  const settled = await Promise.allSettled(pending);
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) {
      setHealthy(s.value.host);
      return s.value;
    }
  }
  return null;
}

const normalise = (items) =>
  items
    .map((x) => {
      const id = String(x.url || x.videoId || '').replace('/watch?v=', '').trim();
      if (!ID.test(id)) return null;
      const duration = Number(x.duration) || 0;
      // Skip Shorts and anything implausibly long for a song.
      if (x.isShort || duration < 45 || duration > 1500) return null;
      return {
        videoId: id,
        title: String(x.title || '').trim(),
        author: String(x.uploaderName || '').replace(/\s*-\s*Topic$/i, '').trim(),
        duration,
        // Piped proxies images through instance hosts that frequently die;
        // i.ytimg.com is YouTube's own CDN, keyless and stable.
        thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        views: Number(x.views) || 0,
      };
    })
    .filter(Boolean);

/** Prefer official-looking studio uploads over covers, live cuts and reactions. */
function rank(items, query) {
  const q = query.toLowerCase();
  const junk = /\b(reaction|review|tutorial|karaoke|instrumental|slowed|reverb|8d|nightcore|mashup|dj|remix|cover|lesson|piano|guitar|ringtone|whatsapp status|shorts)\b/i;
  const live = /\b(live|concert|unplugged|performance|tour)\b/i;
  const official = /\b(official|lyric|audio|video song|full song|topic)\b/i;

  return items
    .map((it) => {
      let s = 0;
      const t = it.title.toLowerCase();
      if (junk.test(t) && !junk.test(q)) s -= 220;
      if (live.test(t) && !live.test(q)) s -= 90;
      if (official.test(t)) s += 60;
      if (/vevo|- topic$/i.test(it.author)) s += 55;
      // Songs cluster around 3–6 minutes.
      if (it.duration >= 120 && it.duration <= 420) s += 40;
      s += Math.min(60, Math.log10(Math.max(10, it.views)) * 9);
      return { it, s };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);
}

/**
 * Search for a song.
 * @returns {Promise<{items:Array, source:string|null, error:string|null}>}
 */
export async function searchTracks(query, signal) {
  const q = String(query || '').trim();
  if (!q) return { items: [], source: null, error: null };

  // `music_songs` returns clean studio tracks; plain `videos` is the wider net.
  const music = await raceInstances(q, 'music_songs', signal);
  const videos = await raceInstances(q, 'videos', signal);

  const merged = new Map();
  for (const batch of [music, videos]) {
    if (!batch) continue;
    for (const it of normalise(batch.items)) {
      if (!merged.has(it.videoId)) merged.set(it.videoId, it);
    }
  }

  if (!merged.size) {
    return {
      items: [],
      source: null,
      error: 'Search is unavailable right now. Paste a YouTube link instead.',
    };
  }

  const ranked = rank([...merged.values()], q).slice(0, 14);

  // Grade each result for lip-sync reliability BEFORE the user commits to one.
  // Costs a single extra LRCLIB request per search; failure degrades silently
  // to tier 'unknown' rather than blocking results.
  const graded = await annotateFit(ranked, q, signal);

  // A perfectly-timed upload is worth more than a slightly more popular one.
  const tierRank = { exact: 3, good: 2, unknown: 1, offset: 1, poor: 0 };
  graded.sort((a, b) => (tierRank[b.fit?.tier] ?? 1) - (tierRank[a.fit?.tier] ?? 1));

  return { items: graded, source: (music || videos)?.host || null, error: null };
}

/** Suggest canonical track names as the user types (CORS-enabled, keyless). */
export async function suggestTracks(query, signal) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  try {
    const r = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=6&country=IN`,
      { signal },
    );
    if (!r.ok) return [];
    const j = await r.json();
    const seen = new Set();
    return (j.results || [])
      .map((t) => ({ title: t.trackName, artist: t.artistName, art: t.artworkUrl100 }))
      .filter((t) => {
        const k = `${t.title}|${t.artist}`.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  } catch {
    return [];
  }
}
