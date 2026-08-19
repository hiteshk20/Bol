import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { loadYouTubeAPI, PLAYER_STATE } from '../lib/youtube';

/**
 * Player — invisible YouTube audio engine.
 *
 * Notes learned the hard way:
 *  - Never `display:none` the iframe; browsers throttle or refuse audio in
 *    fully hidden frames. A 1×1 clipped, opacity-0 anchor plays normally.
 *  - The API REPLACES the node you hand it, so give it a throwaway child that
 *    React does not own, or unmounting throws `removeChild`.
 *  - Only trust `getDuration()` once `getVideoData().video_id` matches the id
 *    we asked for; after `loadVideoById` it briefly reports the PREVIOUS
 *    track's length, which silently desyncs the next song.
 */
export default function Player({
  videoId, ref, visible = false,
  onTime, onDuration, onStateChange, onError,
}) {
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const rafRef = useRef(0);
  const lastTick = useRef(0);
  const wantedId = useRef(null);
  const reportedDur = useRef(0);
  const dead = useRef(false);
  const [ready, setReady] = useState(false);

  const cbs = useRef({ onTime, onDuration, onStateChange, onError });
  cbs.current = { onTime, onDuration, onStateChange, onError };

  const loop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const tick = (now) => {
      rafRef.current = requestAnimationFrame(tick);
      if (now - lastTick.current < 50) return;
      lastTick.current = now;
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      try {
        const t = p.getCurrentTime();
        const st = p.getPlayerState?.();
        if (Number.isFinite(t)) cbs.current.onTime?.(t, st === PLAYER_STATE.PLAYING);

        const vid = p.getVideoData?.()?.video_id;
        const d = p.getDuration?.();
        if (vid === wantedId.current && d > 0 && d !== reportedDur.current) {
          reportedDur.current = d;
          cbs.current.onDuration?.(d);
        }
      } catch { /* torn down mid-frame */ }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    if (!videoId) return undefined;
    dead.current = false;
    wantedId.current = videoId;
    reportedDur.current = 0;
    let cancelled = false;

    loadYouTubeAPI()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;

        if (playerRef.current?.loadVideoById) {
          try { playerRef.current.loadVideoById(videoId); loop(); }
          catch { cbs.current.onError?.('Could not switch track.'); }
          return;
        }

        const mount = document.createElement('div');
        mount.style.cssText = 'width:100%;height:100%';
        hostRef.current.appendChild(mount);

        playerRef.current = new YT.Player(mount, {
          videoId, width: '100%', height: '100%',
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1,
            rel: 0, fs: 0, iv_load_policy: 3, playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              if (dead.current) return;
              setReady(true);
              try {
                const d = e.target.getDuration?.();
                if (d > 0) { reportedDur.current = d; cbs.current.onDuration?.(d); }
              } catch { /* noop */ }
              loop();
            },
            onStateChange: (e) => {
              if (dead.current) return;
              cbs.current.onStateChange?.(e.data);
              loop();
            },
            onError: (e) => {
              if (dead.current) return;
              cbs.current.onError?.({
                2: 'Invalid video id.',
                5: 'This video cannot play here.',
                100: 'Video removed or private.',
                101: 'The owner disabled embedding.',
                150: 'The owner disabled embedding.',
              }[e.data] || 'Playback error.');
            },
          },
        });
      })
      .catch((err) => { if (!cancelled) cbs.current.onError?.(err?.message || 'YouTube unavailable.'); });

    return () => { cancelled = true; };
  }, [videoId, loop]);

  useEffect(() => () => {
    dead.current = true;
    cancelAnimationFrame(rafRef.current);
    try { playerRef.current?.destroy?.(); } catch { /* noop */ }
    playerRef.current = null;
  }, []);

  useImperativeHandle(ref, () => ({
    play() { try { playerRef.current?.playVideo?.(); } catch { /* noop */ } },
    pause() { try { playerRef.current?.pauseVideo?.(); } catch { /* noop */ } },
    seekTo(s) {
      try {
        playerRef.current?.seekTo?.(Math.max(0, s), true);
        cbs.current.onTime?.(Math.max(0, s), true);
      } catch { /* noop */ }
    },
    setVolume(v) { try { playerRef.current?.setVolume?.(Math.min(100, Math.max(0, v))); } catch { /* noop */ } },
    getDuration() { try { return playerRef.current?.getDuration?.() ?? 0; } catch { return 0; } },
    isReady: () => ready,
  }), [ready]);

  return (
    <div
      aria-hidden="true"
      className={visible
        ? 'relative aspect-video w-full overflow-hidden rounded-2xl'
        : 'pointer-events-none fixed bottom-0 left-0 h-px w-px overflow-hidden opacity-0'}
      style={visible ? undefined : { clipPath: 'inset(50%)' }}
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
