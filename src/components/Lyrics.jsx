import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, MicOff, Crosshair, Music2 } from 'lucide-react';

/**
 * Lyrics — renders a prebuilt timeline. No timing logic lives here.
 *
 * The word-level sweep is driven by CSS custom properties written from the
 * animation loop, so it runs at display refresh rate without re-rendering
 * React on every frame.
 */

function Dots({ progress = 0, active }) {
  return (
    <div className="flex items-center justify-center gap-2 py-5">
      {[0, 1, 2].map((i) => {
        const f = Math.min(1, Math.max(0, progress * 3 - i));
        return (
          <motion.span
            key={i}
            className="block rounded-full"
            animate={{
              width: 8 + f * 4, height: 8 + f * 4,
              opacity: active ? 0.35 + f * 0.65 : 0.2,
            }}
            transition={{ duration: 0.2 }}
            style={{ background: f > 0 ? 'var(--color-glow)' : 'var(--color-line)' }}
          />
        );
      })}
    </div>
  );
}

function Line({ line, state, distance, onSeek, activeRef }) {
  const active = state === 'active';
  const resting = state === 'resting';
  const sung = state === 'sung';

  const blur = active || resting ? 0 : Math.min(5, 1.2 + (distance - 1) * 1.2);
  const opacity = active ? 1 : resting ? 0.55 : Math.max(0.18, 0.5 - (distance - 1) * 0.12);
  const scale = active ? 1 : 0.965;

  const font = line.isDeva ? 'deva' : 'latn';
  const size = active
    ? line.isDeva ? 'text-[28px] sm:text-[40px]' : 'text-[26px] sm:text-[38px]'
    : line.isDeva ? 'text-[19px] sm:text-[25px]' : 'text-[18px] sm:text-[24px]';
  const weight = active ? 'font-extrabold' : 'font-bold';

  return (
    <motion.button
      ref={active ? activeRef : undefined}
      type="button"
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSeek?.(line.start)}
      initial={false}
      animate={{ opacity, scale, filter: `blur(${blur}px)` }}
      transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
      className={`lyric-line block w-full max-w-3xl px-4 py-2.5 text-center sm:px-8 ${font} ${size} ${weight}`}
      style={{
        color: active ? '#FFFFFF' : sung ? 'rgba(203,212,224,0.62)' : 'rgba(226,232,240,0.88)',
        // Lyrics sit on the song's artwork, which can be any colour, so each
        // line carries its own shadow rather than relying on the backdrop.
        textShadow: active
          ? '0 2px 22px rgba(0,0,0,0.85), 0 0 42px rgba(0,0,0,0.55)'
          : '0 1px 14px rgba(0,0,0,0.75)',
      }}
    >
      {active ? (
        // Word-level sweep: each word lights as it is sung.
        <span className="inline">
          {line.words.map((w, i) =>
            w.space ? ' ' : (
              <span
                key={i}
                data-w={i}
                className="transition-colors duration-150"
                style={{ color: 'rgba(226,232,240,0.55)' }}
              >
                {w.text}
              </span>
            ),
          )}
        </span>
      ) : (
        line.text
      )}
    </motion.button>
  );
}

export default function Lyrics({
  status, message, timeline, activeIndex, phase, gapProgress,
  activeLineRef, onSeekLine,
}) {
  const boxRef = useRef(null);
  const nodes = useRef([]);
  const manualRef = useRef(false);
  const timer = useRef(0);
  const touchY = useRef(null);
  const [manual, setManual] = useState(false);

  const synced = status === 'synced' && timeline?.count > 0;

  const centre = useCallback((smooth = true) => {
    const box = boxRef.current;
    const node = nodes.current[activeIndex];
    if (!box || !node) return;
    box.scrollTo({
      top: Math.max(0, node.offsetTop - box.clientHeight / 2 + node.offsetHeight / 2),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }, [activeIndex]);

  useLayoutEffect(() => {
    if (!synced || manual || activeIndex < 0) return;
    centre(true);
  }, [synced, manual, activeIndex, centre]);

  // Reset the scroll position only for a genuinely NEW song.
  //
  // BUG THIS FIXES: this effect depended on `timeline`, which is rebuilt every
  // time the offset changes. So each tap of the -/+ calibration buttons
  // scrolled the lyric list back to the top and cleared the node cache — the
  // words visibly jumped away from the singer, which is why the control felt
  // like it "moved the song for no reason" instead of nudging the lyrics.
  // Keyed on line-count + duration so it fires per song, not per offset.
  const songKey = `${timeline?.count ?? 0}:${Math.round(timeline?.duration ?? 0)}`;
  useEffect(() => {
    nodes.current = [];
    manualRef.current = false;
    setManual(false);
    boxRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [songKey]);

  // Only a genuine scroll gesture suspends auto-centring — never a tap.
  const nudge = useCallback((e) => {
    if (e?.type === 'pointerdown') {
      if (e.target?.closest?.('button, a, [role="slider"]')) return;
      if (e.pointerType === 'mouse') return;
    }
    manualRef.current = true;
    setManual(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { manualRef.current = false; setManual(false); }, 2800);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (status === 'idle') return null;

  if (status === 'loading') {
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 text-[color:var(--color-mute)]">
        <Loader2 size={22} className="animate-spin" />
        <span className="text-sm font-semibold">Finding lyrics that match this recording…</span>
      </div>
    );
  }

  if (!synced) {
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl panel">
          {status === 'none' ? <MicOff size={22} /> : <Music2 size={22} />}
        </span>
        <p className="text-base font-bold">No synced lyrics</p>
        <p className="max-w-sm text-[13px] leading-relaxed text-[color:var(--color-mute)]">
          {message || 'The audio still plays normally.'}
        </p>
      </div>
    );
  }

  const L = timeline.lines;
  const interlude = phase === 'interlude';

  return (
    <div className="relative h-full">
      <div
        ref={boxRef}
        onWheel={nudge}
        onTouchStart={(e) => { touchY.current = e.touches?.[0]?.clientY ?? null; }}
        onTouchMove={(e) => {
          const y = e.touches?.[0]?.clientY;
          if (touchY.current == null || y == null) return;
          if (Math.abs(y - touchY.current) > 12) nudge(e);
        }}
        onPointerDown={nudge}
        className="h-full w-full overflow-y-auto overscroll-contain scroll-smooth"
        style={{
          maskImage: 'linear-gradient(180deg, transparent 0, rgba(0,0,0,.4) 9%, #000 28%, #000 72%, rgba(0,0,0,.4) 91%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(180deg, transparent 0, rgba(0,0,0,.4) 9%, #000 28%, #000 72%, rgba(0,0,0,.4) 91%, transparent 100%)',
        }}
      >
        <div style={{ height: '44%' }} />
        <div className="flex flex-col items-center">
          {phase === 'intro' && <Dots active progress={gapProgress} />}

          {L.map((line, i) => {
            const isActive = i === activeIndex;
            const st = isActive
              ? (interlude || phase === 'outro' ? 'resting' : 'active')
              : i < activeIndex ? 'sung' : 'upcoming';
            return (
              <div key={i} className="w-full" ref={(el) => { nodes.current[i] = el; }}>
                <Line
                  line={line}
                  state={st}
                  distance={Math.abs(i - activeIndex)}
                  onSeek={onSeekLine}
                  activeRef={activeLineRef}
                />
                {isActive && interlude && <Dots active progress={gapProgress} />}
              </div>
            );
          })}
        </div>
        <div style={{ height: '44%' }} />
      </div>

      <AnimatePresence>
        {manual && (
          <motion.button
            type="button"
            onClick={() => { clearTimeout(timer.current); manualRef.current = false; setManual(false); centre(true); }}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-xs font-bold panel"
          >
            <Crosshair size={13} className="text-[color:var(--color-glow)]" />
            Resume auto-scroll
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
