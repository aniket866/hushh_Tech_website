import React, { useEffect, useRef, useState } from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";

import HushhTechNavDrawer from "../hushh-tech-nav-drawer/HushhTechNavDrawer";
import { useChromeVisibility } from "../../hooks/useChromeVisibility";
import HushhTechTicker from "../hushh-tech-ticker/HushhTechTicker";
import { SkipToContentLink } from "../ui/SkipToContentLink";
import { GlassPill, HushhMark, Icon, appleFont } from "../hushh-tech-ui/HushhAppleUI";
import { useTickerSearch } from "../../hooks/useTickerSearch";

const BrandButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex h-9 items-center gap-1.5 py-0.5 pl-1 pr-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35 focus-visible:ring-offset-2"
    aria-label="Go to Hushh Technologies home"
  >
    <HushhMark size={28} />
    <span className="flex flex-col leading-none">
      <span
        className="text-[14px] font-semibold tracking-[-0.015em] text-[#1D1D1F]"
        style={{ fontFamily: appleFont }}
      >
        hushh
      </span>
      <span
        className="mt-0.5 text-[8px] font-medium uppercase tracking-[0.12em] text-[#1D1D1F]/55"
        style={{ fontFamily: appleFont }}
      >
        Technologies
      </span>
    </span>
  </button>
);

const RoutedBrandButton = () => {
  const navigate = useNavigate();
  return <BrandButton onClick={() => navigate("/")} />;
};

const SearchButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex h-9 w-9 items-center justify-center text-[#1D1D1F] transition-transform duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35 focus-visible:ring-offset-2"
    aria-label="Search HushhTech"
  >
    {Icon.search("currentColor", 16)}
  </button>
);

const SITE_SEARCH_ITEMS = [
  { label: "Home", hint: "AI-powered Berkshire Hathaway", path: "/" },
  { label: "Fund A", hint: "Strategy, share classes, documents", path: "/discover-fund-a" },
  { label: "Community", hint: "Research, posts, fund documents", path: "/community" },
  { label: "Careers", hint: "Open roles and teams", path: "/career" },
  { label: "Benefits", hint: "Compensation, health, growth", path: "/benefits" },
  { label: "Contact", hint: "Get in touch with Hushh", path: "/contact" },
  { label: "FAQ", hint: "Common investor questions", path: "/faq" },
  { label: "Profile", hint: "Investor profile and onboarding", path: "/profile" },
  { label: "Disclosures", hint: "Risk disclosures", path: "/risk-disclosures" },
  { label: "Privacy", hint: "Website privacy policy", path: "/privacy-policy" },
  { label: "Terms", hint: "Website terms of use", path: "/terms" },
  { label: "Support", hint: "Investor and website support", path: "/support" },
] as const;

const SiteSearchSheet = ({
  isOpen,
  onClose,
  onNavigate,
}: {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
}) => {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      return;
    }

    const id = window.setTimeout(() => inputRef.current?.focus(), 80);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(id);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, onClose]);

  // Called unconditionally: hooks cannot sit behind the `isOpen` early return below. An empty
  // query is the closed state, and the hook makes no request for one.
  const { tickers, loading: tickersLoading } = useTickerSearch(isOpen ? query : "");

  if (!isOpen) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const results = normalizedQuery
    ? SITE_SEARCH_ITEMS.filter((item) =>
        `${item.label} ${item.hint}`.toLowerCase().includes(normalizedQuery),
      )
    : SITE_SEARCH_ITEMS.slice(0, 7);

  const handleNavigate = (path: string) => {
    onClose();
    onNavigate(path);
  };

  return (
    <div
      className="fixed inset-0 z-[110] bg-[#000000]/25 px-3 pt-[max(env(safe-area-inset-top),0.5rem)] backdrop-blur-[8px] sm:px-5"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search HushhTech"
        className="ml-auto w-full max-w-[420px] overflow-hidden rounded-[28px] bg-white/88 shadow-[0_20px_70px_rgba(29,29,31,0.22),inset_0_1px_0_rgba(255,255,255,0.85)] ring-1 ring-black/[0.06]"
        onClick={(event) => event.stopPropagation()}
        style={{
          WebkitBackdropFilter: "blur(28px) saturate(180%)",
          backdropFilter: "blur(28px) saturate(180%)",
          fontFamily: appleFont,
        }}
      >
        <div className="flex items-center gap-3 border-b border-black/[0.08] px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#F5F5F7] text-[#1D1D1F]/70">
            {Icon.search("currentColor", 16)}
          </span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search HushhTech"
            className="min-w-0 flex-1 bg-transparent text-[17px] font-medium tracking-[-0.01em] text-[#1D1D1F] placeholder:text-[#1D1D1F]/35 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#767680]/15 text-[#1D1D1F] transition hover:bg-[#767680]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35"
            aria-label="Close search"
          >
            {Icon.close("#1D1D1F", 12)}
          </button>
        </div>

        <div className="max-h-[min(70dvh,520px)] overflow-y-auto p-2">
          {/*
            Tickers first. The search was asked for as a quick ticker lookup, and the rows come
            from hushh-research's registry rather than a list maintained here — see
            api/ticker-search.js. Pages stay below because a header search that cannot find /faq
            would be a regression.
          */}
          {normalizedQuery && (tickers.length > 0 || tickersLoading) ? (
            <div className="mb-1">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#1D1D1F]/40">
                Tickers
              </p>
              {tickers.map((ticker) => (
                <div
                  key={ticker.symbol}
                  className="flex w-full items-center gap-3 rounded-[18px] px-3 py-2.5 text-left"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#0066CC]/10 text-[12px] font-semibold tracking-[-0.01em] text-[#0066CC]">
                    {ticker.symbol.slice(0, 5)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold tracking-[-0.01em] text-[#1D1D1F]">
                      {ticker.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-[#1D1D1F]/55">
                      {[ticker.exchange, ticker.sector].filter(Boolean).join(" · ") || ticker.symbol}
                    </span>
                  </span>
                </div>
              ))}
              {tickersLoading && tickers.length === 0 ? (
                <p className="px-3 py-2 text-[13px] text-[#1D1D1F]/45">Searching…</p>
              ) : null}
            </div>
          ) : null}

          {results.length ? (
            results.map((item) => (
              <button
                key={item.path}
                type="button"
                onClick={() => handleNavigate(item.path)}
                className="flex w-full items-center gap-3 rounded-[18px] px-3 py-3 text-left transition hover:bg-[#F5F5F7] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#F5F5F7] text-[#0066CC]">
                  {Icon.search("currentColor", 15)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold tracking-[-0.01em] text-[#1D1D1F]">
                    {item.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-[#1D1D1F]/55">
                    {item.hint}
                  </span>
                </span>
                {Icon.chevronRight("rgba(60,60,67,0.28)", 13)}
              </button>
            ))
          ) : (
            tickers.length === 0 && !tickersLoading ? (
              <p className="px-4 py-8 text-center text-[14px] text-[#1D1D1F]/55">
                No matching tickers or pages.
              </p>
            ) : null
          )}
        </div>
      </div>
    </div>
  );
};

const RoutedSiteSearchSheet = ({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) => {
  const navigate = useNavigate();
  return (
    <SiteSearchSheet
      isOpen={isOpen}
      onClose={onClose}
      onNavigate={(path) => navigate(path)}
    />
  );
};

interface HushhTechHeaderProps {
  showTicker?: boolean;
  showSearch?: boolean;
  className?: string;
}

const HushhTechHeader: React.FC<HushhTechHeaderProps> = ({
  showTicker = true,
  showSearch = true,
  className = "",
}) => {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const hasRouter = useInRouterContext();

  // Pinned while the drawer or the search sheet is open: chrome that slides away underneath an
  // open overlay reads as a rendering fault, and closing the overlay would reveal a missing header.
  const chromeHidden = useChromeVisibility({ pinned: isDrawerOpen || isSearchOpen });

  // The spacer below mirrors whatever the header actually measures, including while it is
  // translated out of view -- `offsetHeight` is unaffected by a transform, so a hidden header
  // still reserves its space and the page does not jump when it comes back.
  /*
   * The header's real height, published as CSS variables rather than held in React state.
   *
   * Two consumers: the spacer below, which reserves the height so content never sits under the
   * bar, and anything on a page that pins itself beneath the chrome. Both used written-down
   * numbers and both drifted — the spacer said 102px against a real 95, and /community pinned its
   * category rail at 140px against a header that measures 52, which is why that rail floated a
   * third of the way down the page.
   *
   * `--hushh-header-height` is always the measured height. `--hushh-header-offset` is that height
   * while the header is on screen and 0 while it is scrolled away, so a sticky bar rises to the
   * very top with it instead of hovering over the gap the header left behind.
   *
   * Deliberately not state: the observer writes straight to the element, so a resize costs no
   * re-render, and there is no setState-in-effect to trip over.
   */
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      const height = el.offsetHeight;
      root.style.setProperty("--hushh-header-height", `${height}px`);
      // `offsetHeight` ignores the transform that hides the header, so read the flag, not the box.
      root.style.setProperty(
        "--hushh-header-offset",
        el.dataset.chromeHidden === "true" ? "0px" : `${height}px`,
      );
    };

    // ResizeObserver fires once on observe, so it does the first measurement too.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    if (observer) observer.observe(el);
    else publish();

    return () => observer?.disconnect();
  }, []);

  // The offset half changes on scroll rather than on resize, so it is republished here as well.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    document.documentElement.style.setProperty(
      "--hushh-header-offset",
      chromeHidden ? "0px" : `${el.offsetHeight}px`,
    );
  }, [chromeHidden]);

  return (
    <>
      <SkipToContentLink />

      <header
        className={`fixed left-0 right-0 top-0 z-50 motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out ${className}`}
        ref={headerRef}
        data-hushh-header
        data-chrome-hidden={chromeHidden ? "true" : "false"}
        style={{
          transform: chromeHidden ? "translate3d(0, -100%, 0)" : "translate3d(0, 0, 0)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.78) 75%, rgba(255,255,255,0.65) 100%)",
          WebkitBackdropFilter: "blur(24px) saturate(180%)",
          backdropFilter: "blur(24px) saturate(180%)",
          boxShadow:
            "0 1px 0 rgba(0,0,0,0.06), 0 4px 20px rgba(0,0,0,0.03)",
        }}
      >
        {/*
          Layout margins, per HIG: content is inset from the display edge rather than run into it.
          The bar itself stays full-bleed so the glass reaches both edges, but its contents sit in a
          centred track with a real gutter — 16px on a phone opening to 40px on a large display, and
          capped at 1440 so a 27-inch monitor does not stretch the brand and the menu two feet
          apart. The previous 12/20px read as no padding at all once past about 1600px wide.

          Vertical padding was the other half: the row had a 5.6px top pad and no bottom pad, so the
          pills sat against the bottom edge of their own bar.
        */}
        <div className="pointer-events-none px-4 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] sm:px-6 lg:px-10">
          <div className="pointer-events-auto mx-auto flex w-full max-w-[1440px] items-center justify-between gap-3">
            <GlassPill>
              {hasRouter ? (
                <RoutedBrandButton />
              ) : (
                <BrandButton onClick={() => window.location.assign("/")} />
              )}
            </GlassPill>

            {/*
              Search sits outboard of the menu, hard against the right edge -- the corner a thumb
              reaches first on a phone and the first place a reader looks for it.
            */}
            <div className="flex shrink-0 items-center gap-1.5">
              <GlassPill>
                <button
                  type="button"
                  onClick={() => setIsDrawerOpen(true)}
                  className="flex h-9 w-9 items-center justify-center text-[#1D1D1F] transition-transform duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35 focus-visible:ring-offset-2"
                  aria-label="Open menu"
                >
                  {Icon.menu("currentColor", 16)}
                </button>
              </GlassPill>
              {showSearch ? (
                <GlassPill>
                  <SearchButton onClick={() => setIsSearchOpen(true)} />
                </GlassPill>
              ) : null}
            </div>
          </div>
        </div>

        {showTicker ? <HushhTechTicker /> : null}
      </header>

      {/*
        Reserves exactly the header's height so content never sits under it.

        Measured at runtime rather than written down. Every hard-coded value here has drifted from
        reality at some point -- it was 102px against a real 95px -- and the height genuinely moves:
        the notch inset changes it, and so does the ticker's own content, which shrank by 4px the
        day its chips stopped rendering a percentage. A ResizeObserver cannot fall out of date.
      */}
      <div aria-hidden="true" style={{ height: "var(--hushh-header-height, 0px)" }} />

      <HushhTechNavDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
      />
      {hasRouter ? (
        <RoutedSiteSearchSheet
          isOpen={isSearchOpen}
          onClose={() => setIsSearchOpen(false)}
        />
      ) : (
        <SiteSearchSheet
          isOpen={isSearchOpen}
          onClose={() => setIsSearchOpen(false)}
          onNavigate={(path) => window.location.assign(path)}
        />
      )}

    </>
  );
};

export default HushhTechHeader;
