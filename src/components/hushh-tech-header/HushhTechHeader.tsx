import React, { useEffect, useRef, useState } from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";

import HushhTechNavDrawer from "../hushh-tech-nav-drawer/HushhTechNavDrawer";
import HushhTechTicker from "../hushh-tech-ticker/HushhTechTicker";
import { SkipToContentLink } from "../ui/SkipToContentLink";
import { GlassPill, HushhMark, Icon, appleFont } from "../hushh-tech-ui/HushhAppleUI";

const BrandButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex h-11 items-center gap-2 py-1 pl-1 pr-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35 focus-visible:ring-offset-2"
    aria-label="Go to Hushh Technologies home"
  >
    <HushhMark size={36} />
    <span className="flex flex-col leading-none">
      <span
        className="text-[16px] font-semibold tracking-[-0.015em] text-[#1D1D1F]"
        style={{ fontFamily: appleFont }}
      >
        hushh
      </span>
      <span
        className="mt-1 text-[9px] font-medium uppercase tracking-[0.12em] text-[#1D1D1F]/55"
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
    className="flex h-11 w-11 items-center justify-center text-[#1D1D1F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35 focus-visible:ring-offset-2"
    aria-label="Search HushhTech"
  >
    {Icon.search("currentColor", 18)}
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
      className="fixed inset-0 z-[110] bg-[#000000]/25 px-3 pt-[max(env(safe-area-inset-top),0.85rem)] backdrop-blur-[8px] sm:px-5"
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
            <p className="px-4 py-8 text-center text-[14px] text-[#1D1D1F]/55">
              No matching pages.
            </p>
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

  return (
    <>
      <SkipToContentLink />

      <header
        className={`fixed left-0 right-0 top-0 z-50 transition-transform duration-300 ${className}`}
        data-hushh-header
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.78) 75%, rgba(255,255,255,0.65) 100%)",
          WebkitBackdropFilter: "blur(24px) saturate(180%)",
          backdropFilter: "blur(24px) saturate(180%)",
          boxShadow:
            "0 1px 0 rgba(0,0,0,0.06), 0 4px 20px rgba(0,0,0,0.03)",
        }}
      >
        <div className="pointer-events-none px-3 pt-[max(env(safe-area-inset-top),0.85rem)] sm:px-5">
          <div className="pointer-events-auto flex items-center justify-between gap-3">
            <GlassPill>
              {hasRouter ? (
                <RoutedBrandButton />
              ) : (
                <BrandButton onClick={() => window.location.assign("/")} />
              )}
            </GlassPill>

            <div className="flex shrink-0 items-center gap-1.5">
              {showSearch ? (
                <GlassPill>
                  <SearchButton onClick={() => setIsSearchOpen(true)} />
                </GlassPill>
              ) : null}
              <GlassPill>
                <button
                  type="button"
                  onClick={() => setIsDrawerOpen(true)}
                  className="flex h-11 w-11 items-center justify-center text-[#1D1D1F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35 focus-visible:ring-offset-2"
                  aria-label="Open menu"
                >
                  {Icon.menu("currentColor", 18)}
                </button>
              </GlassPill>
            </div>
          </div>
        </div>

        {showTicker ? <HushhTechTicker /> : null}
      </header>

      <div className={showTicker ? "h-[146px]" : "h-[72px]"} />

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
