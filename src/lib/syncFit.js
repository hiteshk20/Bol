/**
 * syncFit.js — predict, BEFORE playing, whether a video will lip-sync well.
 *
 * WHY SOME SONGS DRIFT
 * --------------------
 * An LRC file is timed against exactly ONE master recording. YouTube hosts
 * many different cuts of the same song, and measurements confirm the spread is
 * huge — "Tum Hi Ho" uploads range from 141s to 383s for the same 247s lyric
 * track. Three distinct failure modes come out of that:
 *
 *   1. SHORTER CUT (radio edit, dance mix, reel version).
 *      Kesariya's 173s upload against a 260s lyric span: the words run 87s
 *      past the end of the audio. Nothing can rescue this — the audio simply
 *      does not contain those lines.
 *
 *   2. LONGER CUT (film version, live, mashup, extra intro/dialogue).
 *      The lyrics are all present but start late. A CONSTANT offset fixes it,
 *      which is what the −/+ calibration does.
 *
 *   3. SPEED-SHIFTED (slowed + reverb, nightcore, 8K "remaster").
 *      Husn slowed+reverb is 270s against a 218s master — a 1.24x ratio. The
 *      error GROWS as it plays: ~14s adrift after one minute, ~43s after
 *      three. This is the "randomly up and down" case, and a constant offset
 *      can never fix it because the error is not constant.
 *
 * So sync quality is not random — it is predicted by comparing the video's
 * duration to the lyric stamp span. We do that comparison at SEARCH time, from
 * one extra LRCLIB request per query, and grade every result.
 */

const TAIL_SHORT = -3; // lyrics may not overrun the audio by more than this
const TAIL_LONG = 45; // beyond this the upload carries lots of extra material
const EXACT = 4; // duration match this close = timed to the same master

/** Stamp span of an LRC body: when the first and last lines fire. */
function spanOf(lrc) {
  const m = [...String(lrc).matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)].map(
    (x) => Number(x[1]) * 60 + Number(x[2]),
  );
  if (!m.length) return null;
  return { first: m[0], last: m[m.length - 1], count: m.length };
}

/**
 * Fetch every synced LRC variant for a query and reduce each to the numbers
 * needed for grading. One request, reused across all search results.
 */
export async function lyricProfile(query, signal) {
  const q = String(query || '').trim();
  if (!q) return null;
  try {
    const r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, { signal });
    if (!r.ok) return null;
    const rows = await r.json();
    const variants = (Array.isArray(rows) ? rows : [])
      .filter((x) => x.syncedLyrics)
      .map((x) => {
        const s = spanOf(x.syncedLyrics);
        return s ? { last: s.last, first: s.first, count: s.count, decl: Number(x.duration) || 0 } : null;
      })
      .filter(Boolean);
    return variants.length ? variants : null;
  } catch {
    return null;
  }
}

/**
 * Grade one video against the available lyric variants.
 *
 * @returns {{tier:'exact'|'good'|'offset'|'poor'|'unknown', note:string}}
 *   exact   – timed to this very cut, should sync out of the box
 *   good    – lands inside the audio, minor calibration at most
 *   offset  – all lines present but late; one tap of −/+ fixes it
 *   poor    – wrong cut: lines overrun the audio, or the tempo differs
 */
export function gradeVideo(duration, variants) {
  const d = Number(duration) || 0;
  if (!d || !variants?.length) return { tier: 'unknown', note: '' };

  let best = { tier: 'poor', note: '', rank: -1 };
  const order = { poor: 0, offset: 1, good: 2, exact: 3 };

  for (const v of variants) {
    const tail = d - v.last; // room left after the final lyric
    let tier;
    let note;

    if (tail < TAIL_SHORT) {
      // The audio ends before the lyrics do — a genuinely shorter edit.
      tier = 'poor';
      note = `shorter edit · lyrics overrun by ${Math.abs(Math.round(tail))}s`;
    } else if (v.decl && Math.abs(d - v.decl) <= EXACT) {
      tier = 'exact';
      note = 'timed to this version';
    } else if (tail > TAIL_LONG) {
      // Long tail usually means live/mashup/extended, or a slowed-down rip.
      const ratio = v.decl ? d / v.decl : 0;
      if (ratio > 1.06 || (ratio && ratio < 0.94)) {
        tier = 'poor';
        note = 'different tempo · lyrics will drift';
      } else {
        tier = 'offset';
        note = 'extended cut · may need calibration';
      }
    } else {
      tier = 'good';
      note = 'lyrics fit this audio';
    }

    if (order[tier] > best.rank) best = { tier, note, rank: order[tier] };
    if (best.tier === 'exact') break;
  }

  return { tier: best.tier, note: best.note };
}

/**
 * Re-performed audio (live, covers, mashups, slowed/nightcore edits) is sung
 * to a different clock even when its length happens to match the master, so a
 * duration check alone cannot vouch for it. Never claim these are exact.
 */
const RETIMED = /\b(live|unplugged|concert|cover|mashup|remix|slowed|reverb|nightcore|sped\s*up|karaoke|acoustic|reprise|medley)\b/i;

/** Attach a `fit` field to each result. Never throws; degrades to 'unknown'. */
export async function annotateFit(items, query, signal) {
  const variants = await lyricProfile(query, signal);
  if (!variants) return items.map((it) => ({ ...it, fit: { tier: 'unknown', note: '' } }));

  return items.map((it) => {
    const fit = gradeVideo(it.duration, variants);
    // The query itself asking for a remix means the user wants that cut.
    if (RETIMED.test(it.title) && !RETIMED.test(String(query)) && fit.tier !== 'poor') {
      return { ...it, fit: { tier: 'offset', note: 're-performed · expect to calibrate' } };
    }
    return { ...it, fit };
  });
}

/** Results worth showing when the user only wants reliable sync. */
export const isWellSynced = (it) => it.fit?.tier === 'exact' || it.fit?.tier === 'good';
