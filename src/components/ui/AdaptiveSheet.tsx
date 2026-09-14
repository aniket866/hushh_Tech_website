import React, { useEffect, useRef, useSyncExternalStore } from "react";
import {
  AnimatePresence,
  motion,
  useDragControls,
  useReducedMotion,
} from "framer-motion";

/**
 * One overlay, two presentations.
 *
 * On a phone it is a bottom sheet: it arrives from the bottom edge, sits under the thumb, and is
 * pulled down to dismiss. On a desktop it is a right-hand sidebar: full height, arriving from the
 * edge the trigger lives on, pushed right to dismiss. Those are the conventions each platform
 * already has, and a bottom sheet on a 27-inch display is neither.
 *
 * The drag is the point rather than a flourish. A sheet that can only be closed by finding a small
 * X in a corner is a sheet that is awkward one-handed, which is the posture it is most often opened
 * in.
 */

/** Tailwind's `md`. Matches the breakpoint the rest of the site switches navigation on. */
const DESKTOP_QUERY = "(min-width: 768px)";

/** Past this, releasing dismisses. About a thumb's comfortable travel. */
const DISMISS_DISTANCE_PX = 96;

/** A fast flick dismisses even if it never travelled far, which is how a real sheet behaves. */
const DISMISS_VELOCITY = 520;

/**
 * `matchMedia` is an external store, so it is read through the API meant for one. Subscribing in an
 * effect and mirroring into state would also need a resync on mount to catch a resize landing
 * between render and effect — a bug class `useSyncExternalStore` removes rather than patches.
 *
 * It is also missing in jsdom and in any non-browser host, and an unguarded call there throws
 * out of render — taking the whole drawer with it. Mobile-first is the answer when it is absent: a
 * bottom sheet that becomes a sidebar on hydration is a smaller jolt than the reverse on a phone.
 */
const supportsMatchMedia = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

const subscribeToDesktop = (onChange: () => void) => {
  if (!supportsMatchMedia()) return () => {};
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

const readIsDesktop = () =>
  supportsMatchMedia() ? window.matchMedia(DESKTOP_QUERY).matches : false;

const useIsDesktop = () => useSyncExternalStore(subscribeToDesktop, readIsDesktop, () => false);

export interface AdaptiveSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Id of the element naming this sheet, for `aria-labelledby`. */
  labelledBy?: string;
  /**
   * Rendered above the scrolling content, and doubles as the drag grip. Put the title and the
   * close button here: a sheet whose whole body is draggable cannot also scroll.
   */
  children: React.ReactNode;
  className?: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  panelRef?: React.RefObject<HTMLDivElement>;
  /**
   * True while the sheet is a bottom sheet, so the caller can drop its own close button rather than
   * letting a corner control compete with the grab indicator — the sheet is dismissed by pulling it
   * down. Passed to `header` as a render prop.
   */
  header?: React.ReactNode | ((state: { isDesktop: boolean }) => React.ReactNode);
}

export const AdaptiveSheet: React.FC<AdaptiveSheetProps> = ({
  isOpen,
  onClose,
  labelledBy,
  header,
  children,
  className = "",
  onKeyDown,
  panelRef,
}) => {
  const isDesktop = useIsDesktop();
  const reduceMotion = useReducedMotion();
  const dragControls = useDragControls();
  const fallbackRef = useRef<HTMLDivElement>(null);
  const ref = panelRef ?? fallbackRef;

  // Escape closes, and the page behind must not scroll while the sheet owns the screen.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  const axis = isDesktop ? "x" : "y";
  const closedOffset = isDesktop ? { x: "100%" } : { y: "100%" };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          className={`fixed inset-0 z-[100] flex ${isDesktop ? "justify-end" : "items-end"} bg-[#000000]/35 backdrop-blur-[10px]`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
          onClick={onClose}
        >
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onClick={(event) => event.stopPropagation()}
            className={[
              "flex flex-col overflow-hidden bg-[#FFFFFF]",
              isDesktop
                // Floats inset rather than flush to the edge, the geometry the search console's
                // sheet uses: a margin all round, rounded corners, and a width that always leaves
                // a gutter. A panel welded to the display edge is the thing that reads as
                // unpadded.
                ? "my-4 mr-4 h-[calc(100dvh-2rem)] w-[min(100vw-1.5rem,26rem)] rounded-[28px] shadow-[0_20px_70px_rgba(29,29,31,0.22)] ring-1 ring-black/[0.06]"
                : "max-h-[calc(100dvh-1rem)] w-full rounded-t-[32px] shadow-[0_-8px_32px_rgba(29,29,31,0.18)]",
              className,
            ].join(" ")}
            // A bottom sheet arrives from off-screen because that is the gesture it answers. The
            // sidebar does not: it is a short slide with a touch of scale, which reads as the panel
            // settling into place rather than being flung in from the edge.
            initial={reduceMotion ? { opacity: 0 } : isDesktop ? { opacity: 0, x: 24, scale: 0.985 } : closedOffset}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : isDesktop ? { opacity: 0, x: 20, scale: 0.99 } : closedOffset}
            transition={
              reduceMotion
                ? { duration: 0 }
                : isDesktop
                  ? { type: "spring", stiffness: 420, damping: 40, mass: 0.8 }
                  : { type: "spring", stiffness: 380, damping: 38, mass: 0.9 }
            }
            // Drag is started by the grip below rather than by the panel, so the scrolling content
            // underneath keeps its own gestures. A sheet that dismisses when you try to scroll it
            // is worse than one that does not drag at all.
            drag={reduceMotion ? false : axis}
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0, left: 0, right: 0 }}
            dragElastic={
              isDesktop
                ? { top: 0, bottom: 0, left: 0, right: 0.55 }
                : { top: 0, bottom: 0.55, left: 0, right: 0 }
            }
            onDragEnd={(_event, info) => {
              const offset = isDesktop ? info.offset.x : info.offset.y;
              const velocity = isDesktop ? info.velocity.x : info.velocity.y;
              if (offset > DISMISS_DISTANCE_PX || velocity > DISMISS_VELOCITY) onClose();
            }}
          >
            {/*
              The grip. `touch-action: none` is what stops the browser claiming the gesture for a
              page scroll before Framer ever sees it — without it the drag works with a mouse and
              does nothing under a thumb, which is the one case it exists for.
            */}
            <div
              onPointerDown={(event) => dragControls.start(event)}
              style={{ touchAction: "none" }}
              className={`shrink-0 ${reduceMotion ? "" : "cursor-grab active:cursor-grabbing"}`}
            >
              {isDesktop ? null : (
                <div
                  className="mx-auto mt-3 h-1.5 w-9 rounded-full bg-[#000000]/[0.18]"
                  aria-hidden="true"
                />
              )}
              {typeof header === "function" ? header({ isDesktop }) : header}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};

export default AdaptiveSheet;
