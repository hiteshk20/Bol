/**
 * youtube.js — IFrame player plumbing (loader, oEmbed metadata, URL parsing).
 *
 * NOTE ON SEARCH
 * --------------
 * This file used to search via the IFrame player's `listType:'search'`.
 * YouTube DEPRECATED that on 15 Nov 2020 and it now returns 4xx, which is
 * exactly why searching by song name returned nothing. All of that code has
 * been deleted. Search now lives in `src/lib/search.js`.
 */

let apiPromise = null;

/** Load the IFrame API exactly once, no matter how many callers. */
export function loadYouTubeAPI() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') { try { prev(); } catch { /* ignore */ } }
      resolve(window.YT);
    };

    if (!document.querySelector('script[data-yt-api]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.dataset.ytApi = '1';
      tag.onerror = () => { apiPromise = null; reject(new Error('YouTube API failed to load')); };
      document.head.appendChild(tag);
    }

    const started = Date.now();
    const poll = setInterval(() => {
      if (window.YT?.Player) { clearInterval(poll); resolve(window.YT); }
      else if (Date.now() - started > 20000) {
        clearInterval(poll); apiPromise = null;
        reject(new Error('YouTube API timed out'));
      }
    }, 150);
  });

  return apiPromise;
}

export const PLAYER_STATE = {
  UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5,
};

/** Keyless oEmbed — title/author only, but instant and cheap. */
export async function oembed(videoId, signal) {
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`,
      )}&format=json`,
      { signal },
    );
    if (!r.ok) return null;
    const d = await r.json();
    return { title: d.title, author: d.author_name, thumbnail: d.thumbnail_url };
  } catch {
    return null;
  }
}

const ID = /^[\w-]{11}$/;

/** Accept a pasted YouTube URL as a direct "search" result. */
export function parseVideoId(input) {
  const raw = String(input || '').trim();
  if (ID.test(raw)) return raw;
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(u.hostname)) return null;
    if (u.hostname.endsWith('youtu.be')) {
      const id = u.pathname.slice(1).split('/')[0];
      return ID.test(id) ? id : null;
    }
    const v = u.searchParams.get('v');
    if (v && ID.test(v)) return v;
    const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}
