import { useEffect, useState } from "react";

/**
 * Hides the fixed page chrome while the reader scrolls down and brings it back the moment they
 * scroll up — the behaviour Safari, the App Store and most reading apps share, which hands the
 * content the whole viewport without taking navigation away.
 *
 * Every consumer reads the same document scroll, so the header and the bottom bar move together
 * without needing to talk to each other or share a provider.
 */

/** Below this the chrome is always shown: at the top of a page it must never be hidden. */
const TOP_ZONE_PX = 24;

/** Scrolling down only hides the chrome past here, so a short page cannot hide its own header. */
const ENGAGE_AFTER_PX = 72;

/**
 * Ignore movement smaller than this. Momentum scrolling on iOS emits a stream of sub-pixel
 * deltas, and reacting to them makes the bars twitch instead of committing to a direction.
 */
const DIRECTION_THRESHOLD_PX = 6;

export interface ChromeVisibilityOptions {
  /**
   * Force the chrome visible regardless of scrolling — pass `true` while a drawer, sheet or modal
   * is open. Chrome that slides away under an open overlay reads as a rendering bug.
   */
  pinned?: boolean;
}

export const useChromeVisibility = ({ pinned = false }: ChromeVisibilityOptions = {}) => {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (pinned) {
      setHidden(false);
      return;
    }

    if (typeof window === "undefined") return;

    let lastY = window.scrollY;
    let frame = 0;

    const evaluate = () => {
      frame = 0;
      const y = window.scrollY;
      const delta = y - lastY;

      // Anchor `lastY` even when the delta is too small to act on, otherwise a slow drag
      // accumulates into a jump the moment it crosses the threshold.
      if (Math.abs(delta) < DIRECTION_THRESHOLD_PX) return;
      lastY = y;

      if (y <= TOP_ZONE_PX) {
        setHidden(false);
        return;
      }

      // Rubber-band scrolling past the bottom of the page reports a positive delta with nowhere
      // left to go. Treating that as "scrolling down" hides the chrome at the end of every page.
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      if (y >= maxScroll - 1) return;

      if (delta > 0) {
        setHidden(y > ENGAGE_AFTER_PX);
      } else {
        setHidden(false);
      }
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(evaluate);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [pinned]);

  return hidden;
};

export default useChromeVisibility;
