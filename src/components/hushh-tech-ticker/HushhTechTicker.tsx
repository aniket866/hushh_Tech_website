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

const TICKER_SCROLL_PIXELS_PER_SECOND = 168;

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
      className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-[#FFFFFF] py-2 pl-2 pr-3"
      style={{
        boxShadow:
          "0 0 0 0.5px rgba(60,60,67,0.08), 0 1px 2px rgba(0,0,0,0.03)",
        fontFamily: appleFont,
      }}
    >
      <div
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-full text-[10.5px] font-medium text-[#1D1D1F]"
        style={{ background: logoTint[index % logoTint.length] }}
      >
        {quote.logo ? (
          <img
            src={quote.logo}
            alt={`${quote.displaySymbol} logo`}
            width="14"
            height="14"
            className="h-3.5 w-3.5 object-contain mix-blend-multiply"
            loading="lazy"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : (
          quote.displaySymbol.charAt(0)
        )}
      </div>
      <span className="text-[13.5px] font-medium leading-none tracking-[-0.01em] text-[#1D1D1F]">
        {quote.displaySymbol}
      </span>
      <span className="flex items-center gap-1">
        {quote.isUp ? Icon.triUp(tint) : Icon.triDown(tint)}
        <span
          className={`text-[12.5px] font-semibold tabular-nums tracking-[-0.01em] ${isLoading ? "animate-pulse" : ""}`}
          style={{ color: tint }}
        >
          {Math.abs(quote.percentChange).toFixed(1)}%
        </span>
      </span>
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

  useConstantTickerMotion({
    enabled: quotes.length > 0,
    loopRef: tickerLoopRef,
    trackRef: tickerTrackRef,
    pixelsPerSecond: TICKER_SCROLL_PIXELS_PER_SECOND,
  });

  return (
    <section
      className="mt-1.5 overflow-hidden border-t border-[#1D1D1F]/[0.06] py-2 opacity-100"
      data-hushh-ticker
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.40) 0%, rgba(255,255,255,0.25) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.6)",
      }}
    >
      <div className="mb-2 flex items-center justify-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-[#34C759]" />
        <span
          className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#1D1D1F]/55"
          style={{ fontFamily: appleFont }}
        >
          Markets Live
        </span>
        {lastUpdated ? (
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
