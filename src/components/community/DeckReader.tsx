import { useEffect, useMemo, useRef, useState } from "react";

import { useAuthSession } from "../../auth/AuthSessionProvider";
import { appleDisplayFont, appleFont, Icon } from "../hushh-tech-ui/HushhAppleUI";
import GatedImage from "./GatedImage";
import {
  readingMinutes,
  wordCount,
  type DeckCard,
  type DeckCardDocument,
} from "./deckReaderTypes";

/**
 * Renders a Gamma deck as a document.
 *
 * What this replaces, and why
 * ---------------------------
 * Deck pages used to be a bare vertical stack of slide JPEGs. That is bad twice over. A reader gets
 * pictures of text — unselectable, unsearchable, unreadable on a phone, with no way to navigate 105
 * cards. And a crawler gets nothing at all, because there is no text on the page: the whole point of
 * publishing research is that it can be found and cited.
 *
 * The alternative the site already had — an iframe to a published gamma.site — is worse for the
 * second problem, not better. An iframe's content belongs to the framed origin; the deck page at
 * /community/general/ai-powered-berkshire-hathaway delivers 33 characters of body text to Googlebot.
 *
 * So the deck is rendered natively. Read view is the real document: headings, prose, images with
 * their alt text, and tables as tables. Slides view keeps the original page images for anyone who
 * wants to see the deck as designed. Both are the same URL; the reader chooses.
 */

interface DeckReaderProps {
  title: string;
  description: string;
  /** Where convert-gamma-export.mjs put this deck's cards, under its access prefix. */
  cardsSrc: string;
  imageBaseSrc: string;
  /** Slide images in GCS. Zero for a deck that was published as a live embed and never exported. */
  imagePageCount: number;
  /** Reading cards. Equals imagePageCount for a deck that came from a slide export. */
  cardCount?: number;
  accessLevel?: string;
  publishedAt?: string;
  category?: string;
  /** Rendered when the cards cannot be fetched, so the page is never blank. */
  fallbackHtml?: string;
}

type View = "read" | "slides";

const formatDate = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
};

/* ------------------------------------------------------------------------------------------- */

/** Thin bar across the top; the only always-visible signal of how much of a 105-card deck is left. */
function ReadingProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const update = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div className="fixed inset-x-0 top-0 z-40 h-[3px] bg-transparent" aria-hidden="true">
      <div
        className="h-full bg-[#0066CC] transition-[width] duration-150 ease-out"
        style={{ width: `${progress * 100}%` }}
      />
    </div>
  );
}

/**
 * The same contents, for a phone.
 *
 * The rail below is `hidden lg:block`, which meant that under 1024px a 105-card deck had no
 * section navigation at all — an unbroken scroll with no way to see where you were or jump. This
 * is the mobile half: a compact bar pinned under the header showing position and current section,
 * which opens a full-height sheet of every card. The bar is the useful part on its own; the sheet
 * is one tap away.
 */
function MobileContents({ cards, activeAnchor }: { cards: DeckCard[]; activeAnchor: string }) {
  const [open, setOpen] = useState(false);
  // Latches once crossed: a control that reappears and disappears as you scroll back and forth is
  // worse than one that is simply always there after the first screen.
  const [entered, setEntered] = useState(false);
  const index = Math.max(0, cards.findIndex((card) => card.anchor === activeAnchor));
  const current = cards[index];

  useEffect(() => {
    if (entered) return;
    const check = () => { if (window.scrollY > window.innerHeight * 0.6) setEntered(true); };
    check();
    window.addEventListener("scroll", check, { passive: true });
    return () => window.removeEventListener("scroll", check);
  }, [entered]);

  // A sheet that leaves the page scrolling underneath it feels broken, and on iOS the page keeps
  // its scroll position only if the lock is released the way it was applied.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const go = (anchor: string) => {
    setOpen(false);
    // Let the scroll lock lift before scrolling, or the target lands under the header.
    window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <>
      <div
        // Docked to the bottom, not pinned under the header: on a phone the reachable third of the
        // screen is the bottom, and a control you tap repeatedly belongs there. Held back until the
        // reader is a screen in, so it never covers the deck's own opening.
        // `invisible` and not opacity alone: a control faded to zero is still in the tab order and
        // still announced, so before this it was a button a keyboard or screen-reader user could
        // reach while it was deliberately not on screen. `visibility` is transitionable, so the
        // fade-in is unchanged.
        className={`fixed inset-x-0 z-30 px-4 transition-[opacity,transform,visibility] duration-300 lg:hidden ${
          entered
            ? "visible pointer-events-auto translate-y-0 opacity-100"
            : "invisible pointer-events-none translate-y-3 opacity-0"
        }`}
        // Clears the site's floating tab bar rather than sitting under it — which is what it did
        // before, making the control untappable on every phone. `--hushh-tabbar-clearance` collapses
        // to the safe area at `md`, where that bar is hidden, so one expression covers both.
        style={{ bottom: "calc(var(--hushh-tabbar-clearance) + 0.5rem)" }}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="mx-auto flex w-full max-w-[560px] items-center gap-3 rounded-full border border-[#1D1D1F]/[0.10] bg-white/85 px-4 py-2.5 text-left shadow-[0_10px_30px_-12px_rgba(29,29,31,0.45)] backdrop-blur-xl backdrop-saturate-150"
        >
          <span
            className="shrink-0 rounded-full bg-[#0066CC]/[0.10] px-2.5 py-1 text-[12px] font-semibold tabular-nums text-[#0066CC]"
            style={{ fontFamily: appleFont }}
          >
            {String(index + 1).padStart(2, "0")}/{cards.length}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#1D1D1F]"
            style={{ fontFamily: appleFont }}
          >
            {current?.title || "Contents"}
          </span>
          <span className="shrink-0 rotate-90 opacity-40">{Icon.chevronRight("#1D1D1F", 14)}</span>
        </button>
        {/* Position within the deck, at a glance, without opening anything. */}
      </div>

      {open ? (
        // Above the floating tab bar, which is also z-50 and would otherwise punch through a modal
        // sheet that is meant to own the screen.
        <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-label="Deck contents">
          <button
            type="button"
            aria-label="Close contents"
            className="absolute inset-0 bg-[#1D1D1F]/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[82dvh] flex-col rounded-t-[22px] bg-white pb-[calc(var(--hushh-tabbar-clearance)+1rem)] shadow-[0_-8px_40px_rgba(29,29,31,0.22)]">
            <div className="flex items-center justify-between border-b border-[#1D1D1F]/[0.08] px-5 py-4">
              <span
                className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1D1D1F]/45"
                style={{ fontFamily: appleFont }}
              >
                Contents · {cards.length} cards
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1D1D1F]/[0.06]"
              >
                {Icon.close("#1D1D1F", 12)}
              </button>
            </div>
            <ol className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
              {cards.map((card, cardIndex) => {
                const active = card.anchor === activeAnchor;
                return (
                  <li key={card.anchor}>
                    <button
                      type="button"
                      onClick={() => go(card.anchor)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full gap-3 rounded-[10px] px-3 py-2.5 text-left text-[15px] leading-[1.3] ${
                        active ? "bg-[#0066CC]/[0.08] font-medium text-[#0066CC]" : "text-[#1D1D1F]/75"
                      }`}
                      style={{ fontFamily: appleFont }}
                    >
                      <span className="shrink-0 tabular-nums opacity-45">
                        {String(cardIndex + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0">{card.title || "Untitled"}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Sticky table of contents with scroll-spy. A deck this long is unusable without one. */
function ContentsRail({ cards, activeAnchor }: { cards: DeckCard[]; activeAnchor: string }) {
  const listRef = useRef<HTMLOListElement | null>(null);

  // Keep the highlighted entry in view, but only when it has actually gone out of view. Scrolling
  // the list on every change made it lurch around while images were still loading and the observer
  // was firing for sections the reader had not reached.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !active) return;
    const top = active.offsetTop - list.scrollTop;
    if (top >= 0 && top + active.clientHeight <= list.clientHeight) return;
    list.scrollTo({ top: active.offsetTop - list.clientHeight / 2, behavior: "smooth" });
  }, [activeAnchor]);

  return (
    <nav aria-label="Deck contents" className="hidden lg:block">
      <div className="sticky top-[104px]">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1D1D1F]/40">
          Contents
        </p>
        <ol
          ref={listRef}
          className="max-h-[calc(100vh-190px)] overflow-y-auto pr-2 [scrollbar-width:thin]"
        >
          {cards.map((card, index) => {
            const active = card.anchor === activeAnchor;
            return (
              <li key={card.anchor}>
                <a
                  href={`#${card.anchor}`}
                  data-active={active}
                  aria-current={active ? "true" : undefined}
                  className={`flex gap-2.5 rounded-[8px] py-1.5 pl-2 pr-1 text-[13px] leading-[1.35] transition ${
                    active
                      ? "bg-[#0066CC]/[0.08] font-medium text-[#0066CC]"
                      : "text-[#1D1D1F]/55 hover:bg-[#1D1D1F]/[0.04] hover:text-[#1D1D1F]/80"
                  }`}
                  style={{ fontFamily: appleFont }}
                >
                  <span className="shrink-0 tabular-nums opacity-50">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">{card.title || "Untitled"}</span>
                </a>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------------------------------- */

/** Deck prose. Tables scroll inside their own box rather than pushing the page sideways. */
const deckProseClassName = [
  "prose prose-neutral max-w-none",
  "prose-headings:font-semibold prose-headings:tracking-[-0.02em]",
  // Gamma leans on h4 for the sub-points inside a card, and there are 140+ of them in a long deck.
  // At body size they read as ordinary paragraphs and the structure disappears, so give them their
  // own weight and colour rather than only extra margin.
  "prose-h3:text-[22px] prose-h3:mt-9 prose-h3:mb-3",
  "prose-h4:text-[15px] prose-h4:mt-7 prose-h4:mb-1.5 prose-h4:font-semibold",
  "prose-h4:uppercase prose-h4:tracking-[0.07em] prose-h4:text-[#1D1D1F]/45",
  "prose-p:text-[17px] prose-p:leading-[1.65] prose-p:text-[#1D1D1F]/80",
  "prose-li:text-[17px] prose-li:leading-[1.6] prose-li:text-[#1D1D1F]/80",
  "prose-a:text-[#0066CC] prose-strong:text-[#1D1D1F]",
  "prose-blockquote:border-l-[3px] prose-blockquote:border-[#0066CC] prose-blockquote:not-italic",
  "prose-blockquote:text-[#1D1D1F] prose-blockquote:font-medium",
  "min-w-0 break-words",
  // `h-auto` is required now that the converter emits real `width`/`height` attributes: without it
  // `w-full` would stretch every image to its recorded intrinsic height and distort it. With both,
  // the browser reserves the correct box before the bytes arrive and nothing reflows.
  "[&_img]:w-full [&_img]:h-auto [&_img]:rounded-[16px] [&_img]:my-6",
  "[&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:text-[14px]",
  "[&_th]:whitespace-nowrap [&_th]:bg-[#1D1D1F]/[0.04] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left",
  "[&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
  "[&_td_p]:my-0 [&_th_p]:my-0",
  // Gamma's chip row, marked by the converter. Without this the chips run together as one
  // unbroken string of bold words.
  "[&_p[data-badges]]:flex [&_p[data-badges]]:flex-wrap [&_p[data-badges]]:gap-2 [&_p[data-badges]]:my-4",
  "[&_span[data-badge]]:inline-flex [&_span[data-badge]]:items-center [&_span[data-badge]]:rounded-full",
  "[&_span[data-badge]]:bg-[#0066CC]/[0.08] [&_span[data-badge]]:px-3 [&_span[data-badge]]:py-1",
  "[&_span[data-badge]]:text-[12px] [&_span[data-badge]]:font-semibold [&_span[data-badge]]:tracking-[0.01em]",
  "[&_span[data-badge]]:text-[#0066CC] [&_span[data-badge]]:no-underline",

  /*
   * Gamma's own block semantics, carried through by the converter as data attributes.
   *
   * A stat block stores its headline figure on the item ("$2.5B", "66%", "60K+") with the heading
   * beside it as the caption. Rendered as ordinary prose those numbers are indistinguishable from
   * body text, which throws away the one thing the block exists to say. `data-figure` is rendered
   * as the figure, via a ::before so the DOM order stays caption-first for a screen reader.
   */
  "[&_div[data-layout='stats']]:grid [&_div[data-layout='stats']]:gap-5 [&_div[data-layout='stats']]:my-7",
  "[&_div[data-layout='stats']]:grid-cols-2 [&_div[data-layout='stats']]:md:grid-cols-4",
  "[&_div[data-figure]]:relative [&_div[data-figure]]:before:block",
  "[&_div[data-figure]]:before:content-[attr(data-figure)]",
  "[&_div[data-figure]]:before:text-[clamp(26px,4vw,38px)] [&_div[data-figure]]:before:font-semibold",
  "[&_div[data-figure]]:before:leading-[1.05] [&_div[data-figure]]:before:tracking-[-0.03em]",
  "[&_div[data-figure]]:before:text-[#0066CC] [&_div[data-figure]]:before:mb-1",
  "[&_div[data-figure]_h4]:mt-0 [&_div[data-figure]_h4]:mb-1 [&_div[data-figure]_h4]:normal-case",
  "[&_div[data-figure]_h4]:tracking-normal [&_div[data-figure]_h4]:text-[#1D1D1F] [&_div[data-figure]_h4]:text-[15px]",
  "[&_div[data-figure]_p]:text-[14px] [&_div[data-figure]_p]:leading-[1.45]",

  // Card grids: Gamma draws these as boxes, and as a plain stack they read as one long column.
  "[&_div[data-layout='solidBoxes']]:grid [&_div[data-layout='solidBoxes']]:gap-4 [&_div[data-layout='solidBoxes']]:my-6 [&_div[data-layout='solidBoxes']]:md:grid-cols-2",
  "[&_div[data-layout='outlineBoxes']]:grid [&_div[data-layout='outlineBoxes']]:gap-4 [&_div[data-layout='outlineBoxes']]:my-6 [&_div[data-layout='outlineBoxes']]:md:grid-cols-2",
  "[&_div[data-layout='solidBoxes']>div]:rounded-[14px] [&_div[data-layout='solidBoxes']>div]:bg-[#1D1D1F]/[0.03] [&_div[data-layout='solidBoxes']>div]:p-5",
  "[&_div[data-layout='outlineBoxes']>div]:rounded-[14px] [&_div[data-layout='outlineBoxes']>div]:ring-1 [&_div[data-layout='outlineBoxes']>div]:ring-[#1D1D1F]/[0.10] [&_div[data-layout='outlineBoxes']>div]:p-5",

  // Ordered narratives: a rule down the left is what makes a sequence read as a sequence.
  "[&_div[data-layout='timeline']>div]:border-l-2 [&_div[data-layout='timeline']>div]:border-[#0066CC]/25 [&_div[data-layout='timeline']>div]:pl-5 [&_div[data-layout='timeline']>div]:pb-4",
  "[&_div[data-layout='processSteps']>div]:border-l-2 [&_div[data-layout='processSteps']>div]:border-[#0066CC]/25 [&_div[data-layout='processSteps']>div]:pl-5 [&_div[data-layout='processSteps']>div]:pb-4",
  "[&_div[data-layout='outlineBoxesWithSideLine']>div]:border-l-2 [&_div[data-layout='outlineBoxesWithSideLine']>div]:border-[#1D1D1F]/10 [&_div[data-layout='outlineBoxesWithSideLine']>div]:pl-5 [&_div[data-layout='outlineBoxesWithSideLine']>div]:pb-4",
  "[&_div[data-layout='sideLineText']>div]:border-l-2 [&_div[data-layout='sideLineText']>div]:border-[#1D1D1F]/10 [&_div[data-layout='sideLineText']>div]:pl-5 [&_div[data-layout='sideLineText']>div]:pb-4",
].join(" ");

function ReadView({
  cards,
  gated,
  accessToken,
  onActiveChange,
}: {
  cards: DeckCard[];
  gated: boolean;
  accessToken?: string;
  onActiveChange: (anchor: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sections = containerRef.current?.querySelectorAll<HTMLElement>("section[id]");
    if (!sections?.length) return;
    // Sections are card-sized and can be taller than the viewport, so "is intersecting" is a poor
    // proxy for "is being read". Track which section headings have passed the reading line and take
    // the last one — the section the reader is inside — recomputed on scroll rather than on
    // intersection alone, so image loading shifting the layout cannot leave a stale highlight.
    const READING_LINE = 140;
    let frame = 0;
    const update = () => {
      frame = 0;
      // At the foot of the document no further scrolling is possible, so a final section shorter
      // than the gap between the reading line and the bottom would never activate. Claim it.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        const last = sections[sections.length - 1];
        if (last?.id) onActiveChange(last.id);
        return;
      }
      let current = sections[0];
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= READING_LINE) current = section;
        else break;
      }
      if (current?.id) onActiveChange(current.id);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }, [cards, onActiveChange]);

  return (
    <div ref={containerRef}>
      {cards.map((card, index) => (
        <section
          key={card.anchor}
          id={card.anchor}
          className="scroll-mt-[96px] border-t border-[#1D1D1F]/[0.07] py-10 first:border-t-0 first:pt-2"
        >
          <p
            className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1D1D1F]/35"
            style={{ fontFamily: appleFont }}
          >
            {String(index + 1).padStart(2, "0")} / {String(cards.length).padStart(2, "0")}
          </p>
          {card.title ? (
            <h2
              className="mb-4 text-[clamp(24px,3vw,32px)] font-semibold leading-[1.15] tracking-[-0.025em] text-[#1D1D1F]"
              style={{ fontFamily: appleDisplayFont }}
            >
              {card.title}
            </h2>
          ) : null}
          {/* Gated images cannot load from an <img> src, so they are pulled out and fetched with
              the reader's token instead; the rest of the card renders as-is. */}
          {gated ? (
            <>
              {card.images.map((image) => (
                <GatedImage
                  key={image}
                  src={image}
                  alt={`${card.title || "Deck"} illustration`}
                  accessToken={accessToken}
                  className="my-6"
                />
              ))}
              <div
                className={deckProseClassName}
                dangerouslySetInnerHTML={{ __html: stripImages(card.html) }}
              />
            </>
          ) : (
            <div className={deckProseClassName} dangerouslySetInnerHTML={{ __html: card.html }} />
          )}
        </section>
      ))}
    </div>
  );
}

/** Removes `<img>` elements the gated path renders separately, so they are not requested twice. */
const stripImages = (html: string) => html.replace(/<img\b[^>]*\/?>/g, "");

/* ------------------------------------------------------------------------------------------- */

function SlidesView({
  title,
  imageBaseSrc,
  imagePageCount,
  gated,
  accessToken,
}: {
  title: string;
  imageBaseSrc: string;
  imagePageCount: number;
  gated: boolean;
  accessToken?: string;
}) {
  const pages = useMemo(
    () =>
      Array.from({ length: imagePageCount }, (_, index) => ({
        number: index + 1,
        src: `${imageBaseSrc}/page-${String(index + 1).padStart(3, "0")}.jpg`,
      })),
    [imageBaseSrc, imagePageCount],
  );

  return (
    <div className="space-y-5">
      {pages.map((page) => (
        <figure key={page.src} className="overflow-hidden rounded-[18px] bg-[#F5F5F7]">
          {gated ? (
            <GatedImage src={page.src} alt={`${title} page ${page.number}`} accessToken={accessToken} />
          ) : (
            <img
              src={page.src}
              alt={`${title} page ${page.number}`}
              className="block h-auto w-full"
              loading={page.number <= 2 ? "eager" : "lazy"}
              decoding="async"
            />
          )}
          <figcaption className="px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#1D1D1F]/35">
            {page.number} / {imagePageCount}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */

export default function DeckReader({
  title,
  description,
  cardsSrc,
  imageBaseSrc,
  imagePageCount,
  cardCount,
  accessLevel,
  publishedAt,
  category,
  fallbackHtml,
}: DeckReaderProps) {
  const { session } = useAuthSession();
  const accessToken = session?.access_token;
  const gated = accessLevel === "NDA";

  const [cards, setCards] = useState<DeckCard[] | null>(null);
  // A deck with no cards object has nothing to fetch, so it starts in the fallback state.
  const [loadFailed, setLoadFailed] = useState(() => !cardsSrc);
  // Slides only exist where a page-image export does. Offering an empty tab would be worse than
  // not offering one.
  const hasSlides = imagePageCount > 0;
  const [view, setView] = useState<View>("read");
  const [activeAnchor, setActiveAnchor] = useState("");

  useEffect(() => {
    if (!cardsSrc) return;
    if (gated && !accessToken) return; // wait for the session rather than firing a doomed request
    let cancelled = false;

    fetch(cardsSrc, {
      headers: gated && accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((document: DeckCardDocument) => {
        if (cancelled) return;
        setCards(Array.isArray(document?.cards) ? document.cards : []);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });

    return () => { cancelled = true; };
  }, [cardsSrc, gated, accessToken]);

  // A deep link to a card only works once that card exists in the DOM.
  useEffect(() => {
    if (!cards?.length || view !== "read") return;
    const anchor = window.location.hash.slice(1);
    if (!anchor) return;
    const target = document.getElementById(anchor);
    if (target) window.requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
  }, [cards, view]);

  // A deck with no slide export is Read-only, whatever `view` happens to hold.
  const showRead = view === "read" || !hasSlides;

  const words = cards ? wordCount(cards) : 0;
  const minutes = words ? readingMinutes(words) : 0;

  const meta = [
    category,
    `${cardCount || cards?.length || imagePageCount} cards`,
    minutes ? `${minutes} min read` : "",
    formatDate(publishedAt),
  ].filter(Boolean);

  return (
    <>
      <ReadingProgress />

      <header className="border-b border-[#1D1D1F]/[0.07] bg-white px-5 pb-8 pt-10 md:px-8 md:pt-14">
        <div className="mx-auto w-full max-w-[1180px]">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            {gated ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1D1D1F]/[0.06] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#1D1D1F]/70"
                style={{ fontFamily: appleFont }}
              >
                {Icon.lock("currentColor", 11)} NDA
              </span>
            ) : null}
            {meta.map((item, index) => (
              <span
                key={item}
                className="text-[12px] font-medium uppercase tracking-[0.1em] text-[#1D1D1F]/45"
                style={{ fontFamily: appleFont }}
              >
                {index > 0 ? <span className="mr-2.5 text-[#1D1D1F]/25">·</span> : null}
                {item}
              </span>
            ))}
          </div>

          <h1
            className="mt-3 max-w-[20ch] text-[clamp(32px,5vw,54px)] font-semibold leading-[1.05] tracking-[-0.03em] text-[#1D1D1F]"
            style={{ fontFamily: appleDisplayFont }}
          >
            {title}
          </h1>
          {description ? (
            <p
              className="mt-4 max-w-[62ch] text-[clamp(17px,1.7vw,20px)] leading-[1.5] text-[#1D1D1F]/62"
              style={{ fontFamily: appleFont }}
            >
              {description}
            </p>
          ) : null}

          {hasSlides ? (
          <div
            className="mt-7 inline-flex rounded-[12px] bg-[#767680]/[0.10] p-1"
            role="tablist"
            aria-label="Deck view"
          >
            {(["read", "slides"] as View[]).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={view === option}
                onClick={() => setView(option)}
                className={`flex min-h-[44px] items-center rounded-[9px] px-5 text-[14px] font-medium capitalize transition ${
                  view === option ? "bg-white text-[#1D1D1F] shadow-sm" : "text-[#1D1D1F]/55"
                }`}
                style={{ fontFamily: appleFont }}
              >
                {option}
              </button>
            ))}
          </div>
          ) : null}
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1180px] px-5 pb-32 pt-8 md:px-8">
        <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-12">
          {showRead && cards?.length ? (
            <ContentsRail cards={cards} activeAnchor={activeAnchor} />
          ) : (
            <div className="hidden lg:block" />
          )}

          {/* Nothing below lg had any way to navigate a 105-card deck. */}
          {showRead && cards?.length ? (
            <MobileContents cards={cards} activeAnchor={activeAnchor} />
          ) : null}

          <div className="min-w-0">
            {!showRead ? (
              <SlidesView
                title={title}
                imageBaseSrc={imageBaseSrc}
                imagePageCount={imagePageCount}
                gated={gated}
                accessToken={accessToken}
              />
            ) : cards?.length ? (
              <ReadView
                cards={cards}
                gated={gated}
                accessToken={accessToken}
                onActiveChange={setActiveAnchor}
              />
            ) : loadFailed && fallbackHtml ? (
              <div className={deckProseClassName} dangerouslySetInnerHTML={{ __html: fallbackHtml }} />
            ) : loadFailed ? (
              <p className="text-[17px] text-[#1D1D1F]/60" style={{ fontFamily: appleFont }}>
                The reading view could not be loaded. Switch to Slides to view this deck.
              </p>
            ) : (
              <div className="space-y-4" aria-busy="true">
                {[0, 1, 2, 3].map((row) => (
                  <div key={row} className="h-5 animate-pulse rounded bg-[#1D1D1F]/[0.05]" style={{ width: `${90 - row * 12}%` }} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
