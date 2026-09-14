import { RefObject, useEffect } from "react";

interface ConstantTickerMotionOptions {
  enabled: boolean;
  loopRef: RefObject<HTMLElement>;
  trackRef: RefObject<HTMLElement>;
  pixelsPerSecond?: number;
}

const DEFAULT_TICKER_PIXELS_PER_SECOND = 52;

/**
 * How far the marquee had travelled when it was last torn down.
 *
 * The header is mounted by each page rather than by the layout, so every navigation unmounts this
 * ticker and mounts a fresh one. Starting from zero each time is what makes the strip read as
 * "constantly restarting" — the eye catches the jump even when the speed is calm. Module scope is
 * the right home for it: there is one ticker on screen at a time, and the value is meaningless to
 * anything else.
 */
let resumeOffsetPx = 0;

export const useConstantTickerMotion = ({
  enabled,
  loopRef,
  trackRef,
  pixelsPerSecond = DEFAULT_TICKER_PIXELS_PER_SECOND,
}: ConstantTickerMotionOptions) => {
  useEffect(() => {
    if (!enabled) return;

    const loop = loopRef.current;
    const track = trackRef.current;
    if (!loop || !track) return;

    const requestFrame =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 16));
    const cancelFrame =
      window.cancelAnimationFrame ??
      ((id: number) => window.clearTimeout(id));

    let tickerFrame = 0;
    let measureFrame = 0;
    let lastTime = performance.now();
    let distance = Math.max(1, loop.scrollWidth);
    let offset = resumeOffsetPx % distance;

    const measure = () => {
      measureFrame = 0;
      const nextDistance = loop.scrollWidth;
      if (nextDistance <= 0) return;

      distance = nextDistance;
      offset %= distance;
      track.style.setProperty("--ticker-distance-px", `${distance}px`);
    };

    const scheduleMeasure = () => {
      if (measureFrame) return;
      measureFrame = requestFrame(measure);
    };

    const tick = (time: number) => {
      const delta = Math.min(40, Math.max(0, time - lastTime));
      lastTime = time;

      offset = (offset + (delta / 1000) * pixelsPerSecond) % distance;
      resumeOffsetPx = offset;
      track.style.transform = `translate3d(${-offset}px, 0, 0)`;
      tickerFrame = requestFrame(tick);
    };

    measure();
    tickerFrame = requestFrame((time) => {
      lastTime = time;
      tick(time);
    });

    window.addEventListener("resize", scheduleMeasure);
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleMeasure)
        : null;
    resizeObserver?.observe(loop);

    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      resizeObserver?.disconnect();
      if (measureFrame) cancelFrame(measureFrame);
      if (tickerFrame) cancelFrame(tickerFrame);
      track.style.transform = "";
    };
  }, [enabled, loopRef, pixelsPerSecond, trackRef]);
};
