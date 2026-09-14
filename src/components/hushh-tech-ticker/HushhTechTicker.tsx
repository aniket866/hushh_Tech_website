import { useRef } from "react";

import { useOptionalAuthSession } from "../../auth/AuthSessionProvider";
import { useConstantTickerMotion } from "../../hooks/useConstantTickerMotion";
import { StockQuote, useStockQuotes } from "../../hooks/useStockQuotes";
import { isHushhResearchProductBoundary } from "../../services/hushhResearch/legacyProductData";
import { Icon, SYS, appleFont } from "../hushh-tech-ui/HushhAppleUI";

const logoTint = [
  "#EAF3FF",
  "#EEFBEF",
  "#FFF4E6",
  "#F4ECFF",
];

/**
 * Reading speed, not stock-exchange speed. At 168 the strip was faster than the eye can fix on a
 * symbol, so it registered as motion rather than as information and pulled attention off the page
 * underneath it. A little over 50 gives a chip roughly a second and a half in view.
 */
const TICKER_SCROLL_PIXELS_PER_SECOND = 52;

const TickerChip = ({
  quote,
  isLoading,
  index,
}: {
  quote: StockQuote;
  isLoading?: boolean;
  index: number;
}) => {
  const tint = quote.isUp ? SYS.green : SYS.red;

  return (
    <div
      className="flex h-7.5 shrink-0 items-center gap-1.5 rounded-full bg-[#FFFFFF] py-1 pl-1.5 pr-2.5"
      style={{
        boxShadow:
          "0 0 0 0.5px rgba(60,60,67,0.08), 0 1px 2px rgba(0,0,0,0.03)",
        fontFamily: appleFont,
      }}
    >
      <div
        className="flex h-4.5 w-4.5 shrink-0 items-center justify-center overflow-hidden rounded-full text-[9.5px] font-medium text-[#1D1D1F]"
        style={{ background: logoTint[index % logoTint.length] }}
      >
        {quote.logo ? (
          <img
            src={quote.logo}
            alt={`${quote.displaySymbol} logo`}
            width="12"
            height="12"
            className="h-3 w-3 object-contain mix-blend-multiply"
            loading="lazy"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : (
          quote.displaySymbol.charAt(0)
        )}
      </div>
      <span className="text-[12px] font-medium leading-none tracking-[-0.01em] text-[#1D1D1F]">
        {quote.displaySymbol}
      </span>
      {/*
        No quote, no number and no direction arrow. A row without market data shows its symbol
        alone rather than a plausible-looking percentage, so an outage reads as an outage.
      */}
      {quote.hasQuote ? (
        <span className="flex items-center gap-0.5">
          {quote.isUp ? Icon.triUp(tint) : Icon.triDown(tint)}
          <span
            className={`text-[11px] font-semibold tabular-nums tracking-[-0.01em] ${isLoading ? "animate-pulse" : ""}`}
            style={{ color: tint }}
          >
            {Math.abs(quote.percentChange).toFixed(1)}%
          </span>
        </span>
      ) : (
        <span
          className="text-[11px] font-medium leading-none tracking-[-0.01em] text-[#1D1D1F]/30"
          aria-label="Quote unavailable"
        >
          --
        </span>
      )}
    </div>
  );
};

export default function HushhTechTicker() {
  const user = useOptionalAuthSession()?.user;
  const tickerLoopRef = useRef<HTMLDivElement>(null);
  const tickerTrackRef = useRef<HTMLDivElement>(null);
  const pathname =
    typeof window === "undefined" ? "" : window.location.pathname;
  const isResearchBoundary = isHushhResearchProductBoundary(
    pathname,
    user,
  );
  const { quotes, loading: quotesLoading, lastUpdated } = useStockQuotes(
    120000,
    !isResearchBoundary,
  );

  // "Live" means at least one real quote came back, not merely that the strip is on screen.
  const isLive = quotes.some((quote) => quote.hasQuote);


  useConstantTickerMotion({
    enabled: quotes.length > 0,
    loopRef: tickerLoopRef,
    trackRef: tickerTrackRef,
    pixelsPerSecond: TICKER_SCROLL_PIXELS_PER_SECOND,
  });

  /*
   * No real quotes, no strip.
   *
   * `/api/stock-quotes` answers 404 FEATURE_DISABLED in every environment -- the enable flag and
   * the rate-limit salt are set on neither Cloud Run service -- so there is nothing to show. The
   * honest placeholder state this replaces (27 symbols, each reading "--", under "Markets
   * Unavailable") was accurate and still worse than an empty header: it spent the most valuable
   * strip on the page telling readers something was broken.
   *
   * The header spacer measures the header, so removing this costs no layout fix. The strip returns
   * on its own the first time a quote arrives.
   */
  if (!isLive) return null;

  // No border, no background and no top margin: the strip sits directly on the header's own glass.
  // Each of those three drew its own edge a couple of pixels below the controls -- a rule, a white
  // inset highlight, and a sliver of page showing through a lighter panel -- which together made
  // the ticker look bolted on underneath the header rather than part of it.
  return (
    <section className="overflow-hidden py-1 opacity-100" data-hushh-ticker>
      {/*
        The dot and the word "Live" are a claim about the data. They are earned by a real quote
        having arrived, not by the component having rendered.
      */}
      <div className="mb-1 flex items-center justify-center gap-1.5">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: isLive ? "#34C759" : "rgba(29,29,31,0.25)" }}
        />
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#1D1D1F]/55"
          style={{ fontFamily: appleFont }}
        >
          {isLive ? "Markets Live" : "Markets Unavailable"}
        </span>
        {isLive && lastUpdated ? (
          <span
            className="hidden text-[11px] font-normal text-[#1D1D1F]/35 sm:inline"
            style={{ fontFamily: appleFont }}
          >
            {lastUpdated.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        ) : null}
      </div>
      <div className="hushh-ticker-mask relative flex w-full overflow-hidden">
        <div
          ref={tickerTrackRef}
          className="hushh-ticker-track flex w-max items-center"
          data-ticker-motion="constant-raf"
        >
          {[0, 1].map((loopIndex) => (
            <div
              key={loopIndex}
              ref={loopIndex === 0 ? tickerLoopRef : undefined}
              aria-hidden={loopIndex === 1}
              className="hushh-ticker-loop flex shrink-0 items-center gap-2 px-5"
            >
              {quotes.map((quote, idx) => (
                <TickerChip
                  key={`${loopIndex}-${quote.symbol}-${idx}`}
                  quote={quote}
                  index={idx}
                  isLoading={quotesLoading && quotes.length === 0}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .hushh-ticker-mask {
          mask-image: linear-gradient(to right, transparent, black 4%, black 96%, transparent);
          -webkit-mask-image: linear-gradient(to right, transparent, black 4%, black 96%, transparent);
        }
        .hushh-ticker-track {
          transform: translate3d(0, 0, 0);
          will-change: transform;
        }
        .hushh-ticker-loop {
          min-width: max-content;
        }
      `}</style>
    </section>
  );
}
