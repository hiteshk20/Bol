import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildTimeline, resolveAt, activeWord, createClock } from '../lib/timeline';

/**
 * useSync — owns the playback clock and derives lyric state from it.
 *
 * React state updates only when something VISIBLE changes (active line, phase,
 * whole second). Word highlighting is written straight to the DOM from the
 * animation loop, so the sweep is smooth without re-rendering 60x/second.
 */
export default function useSync({ lines, duration, offset = 0 }) {
  const timeline = useMemo(
    () => buildTimeline(lines, duration, offset),
    [lines, duration, offset],
  );

  const clock = useRef(null);
  if (!clock.current) clock.current = createClock();

  const raf = useRef(0);
  const lineEl = useRef(null);
  const last = useRef({ index: -2, phase: '', second: -1, word: -1 });
  const [state, setState] = useState({ index: -1, phase: 'intro', gapProgress: 0, second: 0 });

  const bindActiveLine = useCallback((el) => { lineEl.current = el; }, []);

  const pushTime = useCallback((t, playing) => {
    clock.current.update(t, playing);
  }, []);

  const snapTo = useCallback((t) => { clock.current.reset(t); }, []);
  const setPlaying = useCallback((v) => { clock.current.setPlaying(v); }, []);
  const readClock = useCallback(() => clock.current.read(), []);

  useEffect(() => {
    const tick = () => {
      raf.current = requestAnimationFrame(tick);
      const t = clock.current.read();
      const r = resolveAt(timeline, t);
      const prev = last.current;

      // Word-level sweep straight to the DOM — no React render.
      if (lineEl.current && r.index >= 0) {
        const line = timeline.lines[r.index];
        const wi = activeWord(line, t);
        if (wi !== prev.word || r.index !== prev.index) {
          const spans = lineEl.current.querySelectorAll('[data-w]');
          for (const s of spans) {
            const i = Number(s.dataset.w);
            s.style.color = i <= wi ? '#FFFFFF' : 'rgba(226,232,240,0.55)';
            s.style.textShadow = i === wi ? '0 0 18px rgba(110,231,199,.45)' : 'none';
          }
          prev.word = wi;
        }
      }

      const second = Math.floor(t);
      if (r.index !== prev.index || r.phase !== prev.phase || second !== prev.second) {
        last.current = { ...prev, index: r.index, phase: r.phase, second };
        setState({ index: r.index, phase: r.phase, gapProgress: r.gapProgress, second });
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [timeline]);

  // Reset the clock only when a DIFFERENT SONG loads.
  //
  // BUG THIS FIXES: this effect used to depend on `timeline`, which is rebuilt
  // whenever the offset changes. So every tap of the -/+ calibration buttons
  // ran clock.reset(0) — the lyric clock jumped to zero while the audio kept
  // playing, which looked like the song lurching forward for no reason and
  // made the control impossible to use. Offset changes must re-derive the
  // timeline WITHOUT touching the clock.
  const songKey = `${timeline.count}:${Math.round(timeline.duration || 0)}`;
  useEffect(() => {
    last.current = { index: -2, phase: '', second: -1, word: -1 };
    clock.current.reset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey]);

  // An offset change must not blank the highlight; just force a re-evaluation.
  useEffect(() => {
    last.current = { index: -2, phase: '', second: -1, word: -1 };
  }, [timeline]);

  return {
    timeline,
    activeIndex: state.index,
    phase: state.phase,
    gapProgress: state.gapProgress,
    currentSecond: state.second,
    bindActiveLine, pushTime, snapTo, setPlaying, readClock,
  };
}
