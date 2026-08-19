/**
 * timeline.js — turn LRC lines into a precise, seek-safe playback model.
 *
 * WHY LIP-SYNC LAGS (and how this fixes it)
 * -----------------------------------------
 * 1. An LRC only says when a line STARTS. If you keep a line highlighted until
 *    the next stamp, it stays lit through instrumental breaks and reads as
 *    "lyrics running ahead of the singer". We give every line an explicit end.
 *
 * 2. `player.getCurrentTime()` updates in coarse ~250ms steps and can even
 *    step backwards. Rendering straight from it makes the highlight stutter.
 *    We run a smoothed clock that extrapolates between readings.
 *
 * 3. Highlighting a whole line at once always *looks* late, because the singer
 *    is mid-word while the UI shows a static block. We interpolate per word,
 *    weighted by syllable count, so the sweep tracks the voice.
 *
 * 4. Any state that accumulates during playback goes out of step after a seek.
 *    Everything here is a PURE function of (timeline, time), so seeking is
 *    exact by construction.
 */

const DEVA = /[\u0900-\u097F]/;

// Singing rates measured against real LRCs.
const CPS_LATIN = 11;
const CPS_DEVA = 8;
const MIN_LINE = 1.3;
const MAX_LINE = 12;
// Hold a line for most of the gap to the next one; only a clearly longer gap
// counts as instrumental. (Cutting at the text estimate alone made the UI
// flicker into "interlude" between every line.)
const HOLD_RATIO = 0.88;
const INTERLUDE_MIN = 4.0;

/** Rough syllable weight — better than raw character count for timing. */
function weight(word) {
  const w = word.trim();
  if (!w) return 0;
  if (DEVA.test(w)) {
    // Devanagari: consonants carry the beat, matras modify it.
    const marks = (w.match(/[\u093E-\u094D\u0962\u0963]/g) || []).length;
    return Math.max(1, w.length - marks * 0.55);
  }
  const groups = w.toLowerCase().match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : Math.ceil(w.length / 3));
}

/**
 * @param {Array<{time:number,text:string}>} lines parsed LRC
 * @param {number} duration  audio duration (seconds)
 * @param {number} offset    manual/auto shift; +ve = lyrics later
 */
export function buildTimeline(lines, duration = 0, offset = 0) {
  if (!Array.isArray(lines) || lines.length === 0) return { lines: [], count: 0, duration };

  const shift = Number(offset) || 0;
  const raw = lines
    .filter((l) => Number.isFinite(l.time))
    .map((l) => ({ time: Math.max(0, l.time + shift), text: String(l.text || '').trim() }))
    .sort((a, b) => a.time - b.time);

  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const cur = raw[i];
    // Blank LRC lines are terminators: they mark where singing stops.
    if (!cur.text) continue;

    const next = raw[i + 1];
    const hardNext = next ? next.time : (duration > 0 ? duration : cur.time + 6);
    const available = Math.max(0.25, hardNext - cur.time);

    const cps = DEVA.test(cur.text) ? CPS_DEVA : CPS_LATIN;
    const natural = Math.min(MAX_LINE, Math.max(MIN_LINE, cur.text.length / cps));

    // How long the WORDS are actually sung for. Before a long instrumental the
    // available gap is far larger than the phrase: "Bairan" line 8 has a 16.6s
    // gap for a line the singer delivers in ~3.6s. Sweeping the words across
    // the whole gap made every word after the first lag further behind the
    // vocal — the "lyrics slowly drift out" complaint. The sweep must follow
    // the natural pace, never the gap.
    const sung = Math.min(available, natural);

    // The LINE may stay lit longer than the words take (so it does not blink
    // out during a short breath), but only up to a real interlude.
    const hold = Math.min(available, Math.max(sung, available * HOLD_RATIO));
    const end = cur.time + (available - sung >= INTERLUDE_MIN ? sung : hold);

    // Never let a line overlap the previous one (duplicate stamps happen).
    const prev = out[out.length - 1];
    if (prev && cur.time < prev.end) prev.end = Math.max(prev.start + 0.2, cur.time);

    out.push({
      index: out.length,
      text: cur.text,
      start: cur.time,
      end,
      nextStart: hardNext,
      gapAfter: Math.max(0, hardNext - end),
      isDeva: DEVA.test(cur.text),
      // Words sweep over the SUNG span, never the padded hold.
      words: sliceWords(cur.text, cur.time, cur.time + sung),
    });
  }

  return { lines: out, count: out.length, duration };
}

/** Distribute a line's span across words by syllable weight. */
function sliceWords(text, start, end) {
  const tokens = text.split(/(\s+)/).filter(Boolean);
  const total = tokens.reduce((n, t) => n + weight(t), 0) || 1;
  const span = Math.max(0.05, end - start);
  let cursor = start;
  return tokens.map((tok) => {
    const dur = (weight(tok) / total) * span;
    const w = { text: tok, start: cursor, end: cursor + dur, space: !tok.trim() };
    cursor += dur;
    return w;
  });
}

/**
 * Resolve UI state at time `t`. Pure — this is what makes seeking exact.
 * @returns {{index:number, phase:'intro'|'singing'|'interlude'|'outro', progress:number, gapProgress:number}}
 */
export function resolveAt(timeline, t) {
  const L = timeline?.lines;
  if (!L?.length) return { index: -1, phase: 'intro', progress: 0, gapProgress: 0 };

  const time = Number(t) || 0;

  if (time < L[0].start) {
    const lead = Math.max(0.5, L[0].start);
    return { index: -1, phase: 'intro', progress: 0, gapProgress: Math.min(1, time / lead) };
  }

  let lo = 0; let hi = L.length - 1; let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].start <= time) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }

  const line = L[idx];
  if (time <= line.end) {
    return {
      index: idx,
      phase: 'singing',
      progress: Math.min(1, Math.max(0, (time - line.start) / Math.max(0.05, line.end - line.start))),
      gapProgress: 0,
    };
  }

  const isLast = idx === L.length - 1;
  const gap = line.nextStart - line.end;
  return {
    index: idx,
    phase: isLast ? 'outro' : gap >= INTERLUDE_MIN ? 'interlude' : 'singing',
    progress: 1,
    gapProgress: gap > 0 ? Math.min(1, Math.max(0, (time - line.end) / gap)) : 1,
  };
}

/** Index of the word being sung at `t` (-1 before the line starts). */
export function activeWord(line, t) {
  if (!line?.words) return -1;
  for (let i = 0; i < line.words.length; i += 1) {
    if (t < line.words[i].end) return i;
  }
  return line.words.length - 1;
}

/**
 * SmoothClock — hides the player's coarse, jittery time reporting.
 *
 * getCurrentTime() only moves every ~250ms. We extrapolate with the wall clock
 * between readings, re-anchor gently on small drift (so corrections are
 * invisible) and snap hard on seeks or pauses.
 */
export function createClock() {
  let anchorMedia = 0;
  let anchorWall = 0;
  let playing = false;
  let rate = 1;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  return {
    update(mediaTime, isPlaying, playbackRate = 1) {
      const t = Number(mediaTime);
      if (!Number.isFinite(t)) return;
      const wasPlaying = playing;
      playing = Boolean(isPlaying);
      rate = Number(playbackRate) || 1;

      const predicted = this.read();
      const drift = Math.abs(t - predicted);

      if (drift > 0.35 || !playing || !wasPlaying) anchorMedia = t;
      else anchorMedia = predicted + (t - predicted) * 0.25;
      anchorWall = now();
    },
    reset(mediaTime) {
      anchorMedia = Math.max(0, Number(mediaTime) || 0);
      anchorWall = now();
    },
    setPlaying(v) {
      anchorMedia = this.read();
      anchorWall = now();
      playing = Boolean(v);
    },
    read() {
      if (!playing) return anchorMedia;
      return anchorMedia + ((now() - anchorWall) / 1000) * rate;
    },
  };
}

export const formatTime = (s) => {
  const v = Math.max(0, Math.floor(Number(s) || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};
