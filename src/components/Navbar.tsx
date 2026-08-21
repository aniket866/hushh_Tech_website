import React, { useEffect, useState, useRef } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { FiMenu, FiX } from "react-icons/fi";
import { useTranslation } from "react-i18next";
import { Image, useToast, useBreakpointValue, useDisclosure } from "@chakra-ui/react";
import hushhLogo from "../components/images/Hushhogo.png";
import LanguageSwitcher from "./LanguageSwitcher";
import DeleteAccountModal from "./DeleteAccountModal";
import { useStockQuotes, StockQuote } from "../hooks/useStockQuotes";
import { useConstantTickerMotion } from "../hooks/useConstantTickerMotion";
import config from "../resources/config/config";
import { useAuthSession } from "../auth/AuthSessionProvider";
import { useInvestorJourneyCta } from "../hooks/useInvestorJourneyCta";
import { SkipToContentLink } from "./ui/SkipToContentLink";
import {
  isHushhResearchProductBoundary,
  readHushhCoinsBalance,
} from "../services/hushhResearch/legacyProductData";

const WELCOME_TOAST_PENDING_KEY = "showWelcomeToast";
const WELCOME_TOAST_USER_KEY = "showWelcomeToastUserId";
const TICKER_SCROLL_PIXELS_PER_SECOND = 168;

// Chip-based ticker component - Light theme design
const TickerChip = ({ quote, isLoading }: { quote: StockQuote; isLoading?: boolean }) => {
  return (
    <div className="group flex h-10 shrink-0 items-center gap-2 rounded-full bg-white border border-gray-200 shadow-sm pl-2 pr-3.5 hover:shadow-md transition-all">
      {/* Logo in gray circle */}
      <div className="flex w-7 h-7 items-center justify-center rounded-full bg-gray-100 shrink-0 overflow-hidden">
        {quote.logo ? (
          <img
            src={quote.logo}
            alt={`${quote.displaySymbol} logo`}
            className="w-4 h-4 object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span className="text-[10px] font-bold text-gray-600">{quote.displaySymbol.charAt(0)}</span>
        )}
      </div>
      {/* Stock symbol - use displaySymbol for cleaner display */}
      <span className="text-[12px] font-bold text-gray-800 leading-none">{quote.displaySymbol}</span>
      {/* Percent change with arrow */}
      <div className={`ml-0.5 flex items-center gap-0.5 ${quote.isUp ? 'text-green-600' : 'text-red-500'}`}>
        <span className="text-[10px]">{quote.isUp ? '▲' : '▼'}</span>
        <span className={`text-[11px] font-semibold ${isLoading ? 'animate-pulse' : ''}`}>
          {Math.abs(quote.percentChange).toFixed(1)}%
        </span>
      </div>
    </div>
  );
};

export default function Navbar() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [toastShown, setToastShown] = useState(false);
  const previousUserIdRef = useRef<string | null>(null);
  const { isOpen: isDeleteModalOpen, onOpen: onDeleteModalOpen, onClose: onDeleteModalClose } = useDisclosure();
  const navigate = useNavigate();
  const location = useLocation();
  const drawerRef = useRef<HTMLDivElement>(null);
  const tickerLoopRef = useRef<HTMLDivElement>(null);
  const tickerTrackRef = useRef<HTMLDivElement>(null);
  const [hushhCoins, setHushhCoins] = useState<number | null>(null);
  const toast = useToast();
  const isMobile = useBreakpointValue({ base: true, lg: false });
  const isDesktop = isMobile === false;
  const { session, user, status, signOut } = useAuthSession();

  // Hide ticker strip on onboarding & profile pages to keep UX clean
  const isOnboarding = location.pathname.startsWith('/onboarding');
  const isProfilePage = location.pathname.startsWith('/hushh-user-profile');
  const hideTicker = isOnboarding || isProfilePage;
  const isResearchBoundary = isHushhResearchProductBoundary(
    location.pathname,
    user,
  );

  // Fetch real-time stock quotes (refreshes every 2 minutes for 27 stocks)
  const { quotes, loading: quotesLoading, lastUpdated } = useStockQuotes(
    120000,
    !isResearchBoundary,
  );

  // quotes already includes fallback data from the hook, so we can use it directly
  const displayQuotes = quotes;

  useConstantTickerMotion({
    enabled: !hideTicker && displayQuotes.length > 0,
    loopRef: tickerLoopRef,
    trackRef: tickerTrackRef,
    pixelsPerSecond: TICKER_SCROLL_PIXELS_PER_SECOND,
  });

  useEffect(() => {
    const currentUserId = user?.id ?? null;
    if (previousUserIdRef.current !== currentUserId) {
      setToastShown(false);
      previousUserIdRef.current = currentUserId;
    }
  }, [user?.id]);

  const handleLogout = async () => {
    await signOut();
    // PD-5: route to the goodbye surface so the user sees an explicit
    // acknowledgement that their progress is saved, instead of the bare
    // /login page.
    navigate("/signed-out");
  };

  // Show welcome toast when a user is signed in (only once)
  // But skip if account was just deleted (to prevent showing welcome after deletion)
  useEffect(() => {
    if (!session || toastShown) return;

    // Check if account was just deleted - if so, don't show welcome toast
    const accountJustDeleted = localStorage.getItem("accountJustDeleted");
    if (accountJustDeleted === "true") {
      localStorage.removeItem("accountJustDeleted");
      queueMicrotask(() => setToastShown(true));
      return;
    }

    const shouldShowWelcomeToast = sessionStorage.getItem(WELCOME_TOAST_PENDING_KEY) === "true";
    const pendingToastUserId = sessionStorage.getItem(WELCOME_TOAST_USER_KEY);
    const currentUserId = user?.id ?? null;
    const isPendingForCurrentUser = shouldShowWelcomeToast && (!pendingToastUserId || pendingToastUserId === currentUserId);

    if (!isPendingForCurrentUser) {
      queueMicrotask(() => setToastShown(true));
      return;
    }
    
    toast({
      title: t('common.welcome'),
      description: t('common.signInMessage'),
      status: "success",
      duration: 5000,
      isClosable: true,
    });
    sessionStorage.removeItem(WELCOME_TOAST_PENDING_KEY);
    sessionStorage.removeItem(WELCOME_TOAST_USER_KEY);
    queueMicrotask(() => setToastShown(true));
  }, [session, toastShown, toast, t, user?.id]);

  // Fetch Hushh Coins balance when authenticated
  useEffect(() => {
    if (!user?.id || !config.supabaseClient) {
      queueMicrotask(() => setHushhCoins(null));
      return;
    }
    if (isResearchBoundary) {
      queueMicrotask(() => setHushhCoins(null));
      return;
    }
    const fetchCoins = async () => {
      try {
        const result = await readHushhCoinsBalance(
          config.supabaseClient!,
          user,
        );
        setHushhCoins(result.mode === "legacy" ? result.balance : null);
      } catch { setHushhCoins(0); }
    };
    fetchCoins();
  }, [isResearchBoundary, user]);

  const isAuthenticated = status === "authenticated";

  const primaryNavLinks = [
    { path: "/", label: t('nav.home') },
    { path: "/discover-fund-a", label: t('nav.fundA') },
    { path: "/community", label: t('nav.community') },
    { path: "/contact", label: t('nav.contact') },
    { path: "/faq", label: t('nav.faq') },
  ];

  const toggleDrawer = () => setIsOpen((prev) => !prev);
  const handleLinkClick = (path: string) => {
    navigate(path);
    setIsOpen(false);
  };

  // Investor-access aware routing for the Hushh Coins / Book Consultation
  // CTAs. The original code routed straight to /onboarding/meet-ceo which
  // let unpaid fund users skip FL + KYC + Stripe payment. We now consult
  // the journey hook: paid investors keep the original Meet CEO route,
  // unpaid users are routed to whatever step the journey says is next
  // (typically /onboarding/step-9 with a banner).
  const { primaryCTA: journeyCta } = useInvestorJourneyCta();
  const handleMeetCeoClick = () => {
    setIsOpen(false);
    if (journeyCta.isInvestor) {
      navigate("/onboarding/meet-ceo");
      return;
    }
    journeyCta.action();
  };

  const isActive = (path: string) => location.pathname === path;

  const handleAccountDeleted = () => {
    // Reset states immediately for proper UI update
    setToastShown(true); // Prevent welcome toast from showing
    setIsOpen(false); // Close sidebar drawer immediately
    onDeleteModalClose();
    
    // Navigate to home after a brief delay for cleanup
    setTimeout(() => {
      navigate("/");
    }, 100);
  };

  return (
    <>
      <SkipToContentLink />

      {/* Fixed Header with Navigation + Ticker - Light Theme */}
      <header className="fixed w-full z-[999] top-0">
        {/* Main Navigation Bar - Soft Light Background */}
        <nav className="flex w-full items-center justify-between bg-[#F8F9FA] px-4 lg:px-8 h-16 border-b border-gray-200 transition-colors duration-300">
          {/* Left: Brand Lockup */}
          <Link to="/" className="flex items-center gap-3">
            {/* Hushh Logo Image in Circle with subtle gradient */}
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 border border-gray-200/50 shadow-sm shrink-0 overflow-hidden">
              <Image 
                src={hushhLogo} 
                alt="Hushh Logo" 
                className="w-7 h-7 object-contain"
              />
            </div>
            {/* Brand Text - Stacked Layout */}
            <div className="flex flex-col">
              <span className="text-[18px] font-bold leading-none tracking-tight text-gray-900">Hushh</span>
              <span className="text-[13px] text-gray-500 font-medium mt-0.5">Technologies</span>
            </div>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden lg:flex items-center gap-1">
            {primaryNavLinks.map(({ path, label }) => {
              const active = isActive(path);
              return (
                <button
                  key={path}
                  onClick={() => handleLinkClick(path)}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                    active
                      ? 'bg-[#2F80ED]/10 text-[#1f6cc7]'
                      : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Right: Utilities */}
          <div className="flex items-center gap-3">
            {/* Language Selector */}
            <LanguageSwitcher variant="light" />

            {/* Desktop Utility Actions */}
            {isDesktop && (
              <>
                {isAuthenticated ? (
                  <>
                    <button
                      onClick={() => navigate('/hushh-user-profile')}
                      className="hidden xl:inline-flex items-center justify-center rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100 transition-colors"
                    >
                      {t('nav.viewProfile')}
                    </button>
                    <button
                      onClick={handleLogout}
                      className="inline-flex items-center justify-center rounded-full bg-[#2F80ED] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1f6cc7] transition-colors"
                    >
                      {t('nav.logout')}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => navigate('/Login')}
                    className="inline-flex items-center justify-center rounded-full bg-[#2F80ED] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1f6cc7] transition-colors"
                  >
                    {t('nav.login')}
                  </button>
                )}
              </>
            )}

            {/* Mobile Hamburger */}
            {!isDesktop && (
              <button
                onClick={toggleDrawer}
                className="flex items-center justify-center w-11 h-11 rounded-full bg-[#2F80ED] text-white active:scale-95 transition-transform shadow-lg shadow-blue-500/30 hover:bg-blue-600"
                aria-label="Toggle menu"
              >
                <FiMenu className="w-5 h-5" />
              </button>
            )}
          </div>
        </nav>

        {/* Chip-based Ticker Strip - BELOW Navigation (hidden on onboarding & profile pages) */}
        {!hideTicker && (
          <section aria-label="Live stock ticker" className="relative w-full bg-[#F8F9FA] py-2.5 border-b border-gray-200">
          {/* Ticker Marquee with Fade Mask */}
          <div className="ticker-mask relative flex w-full overflow-hidden">
            <div
              ref={tickerTrackRef}
              className="ticker-track flex items-center"
              data-ticker-motion="constant-raf"
            >
              {[0, 1].map((loopIndex) => (
                <div
                  key={loopIndex}
                  ref={loopIndex === 0 ? tickerLoopRef : undefined}
                  aria-hidden={loopIndex === 1}
                  className="ticker-loop flex shrink-0 items-center gap-3 px-4"
                >
                  {displayQuotes.map((quote, idx) => (
                    <TickerChip
                      key={`${loopIndex}-${quote.symbol}-${idx}`}
                      quote={quote}
                      isLoading={quotesLoading && quotes.length === 0}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Live Indicator - Small dot on right */}
          {lastUpdated && (
            <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
              <span className="text-[9px] font-medium text-gray-700">
                {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          )}
        </section>
        )}
      </header>

      {/* Spacer for fixed header — shorter when ticker is hidden */}
      <div className={hideTicker ? "h-16" : "h-28"} />

      {/* iOS Native Side Menu */}
      {isOpen && (
        <div
          className="fixed inset-0 z-[1000] transition-opacity duration-300"
          style={{ background: "rgba(0, 0, 0, 0.25)" }}
          onClick={toggleDrawer}
        >
          <div
         ref={drawerRef}  
         role="dialog"
         aria-modal="true"
         aria-label="Navigation menu"
         className="fixed inset-0 bg-[#F2F2F7] overflow-y-auto"
         onClick={(e) => e.stopPropagation()}
       >
            <div className="flex flex-col min-h-full max-w-md mx-auto w-full px-4 pb-10">
              {/* Header: Menu title + Close button */}
              <div className="flex items-center justify-between pt-14 pb-4 px-0">
                <h2 className="text-[34px] font-bold text-black tracking-tight leading-none">
                  {t('nav.menu', 'Menu')}
                </h2>
                <button
                  onClick={toggleDrawer}
                  className="w-[30px] h-[30px] flex items-center justify-center rounded-full bg-[#E3E3E8] text-[#8E8E93] active:bg-[#D1D1D6] transition-colors"
                  aria-label="Close menu"
                >
                  <FiX size={18} strokeWidth={3} />
                </button>
              </div>

              {/* Section 1: Primary Navigation */}
              <div className="bg-white rounded-[10px] overflow-hidden mb-5 shadow-sm">
                {[
                  { path: "/", label: t('nav.home'), icon: "home", bg: "#007AFF" },
                  { path: "/discover-fund-a", label: t('nav.fundA'), icon: "pie_chart", bg: "#5856D6" },
                  { path: "/community", label: t('nav.community'), icon: "groups", bg: "#FF9500" },
                ].map(({ path, label, icon, bg }, idx, arr) => (
                  <button
                    key={path}
                    onClick={() => handleLinkClick(path)}
                    aria-current={isActive(path) ? "page" : undefined}
                    className="flex items-center w-full min-h-[44px] py-2.5 pr-4 pl-4 active:bg-[#E5E5EA] transition-colors relative"
                  >
                    <div
                      className="w-[29px] h-[29px] rounded-[7px] flex items-center justify-center mr-3 shrink-0"
                      style={{ backgroundColor: bg }}
                    >
                      <span className="material-symbols-outlined text-white text-[18px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 500" }}>{icon}</span>
                    </div>
                    <span className={`text-[17px] flex-grow text-left leading-none ${isActive(path) ? 'font-semibold text-[#007AFF]' : 'text-black'}`}>
                      {label}
                    </span>
                    <svg className="w-[7px] h-[12px] text-[#C7C7CC] shrink-0" viewBox="0 0 7 12" fill="none">
                      <path d="M1 1L6 6L1 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    {/* Separator line (skip last item) */}
                    {idx < arr.length - 1 && (
                      <div className="absolute bottom-0 right-0 h-[0.5px] bg-[#C6C6C8]" style={{ width: 'calc(100% - 56px)', marginLeft: '56px' }} />
                    )}
                  </button>
                ))}
              </div>

              {/* Section 2: Contact & FAQ */}
              <div className="bg-white rounded-[10px] overflow-hidden mb-5 shadow-sm">
                {[
                  { path: "/contact", label: t('nav.contact'), icon: "mail", bg: "#8E8E93" },
                  { path: "/faq", label: t('nav.faq'), icon: "help", bg: "#FF9500" },
                ].map(({ path, label, icon, bg }, idx, arr) => (
                  <button
                    key={path}
                    onClick={() => handleLinkClick(path)}
                    aria-current={isActive(path) ? "page" : undefined}
                    className="flex items-center w-full min-h-[44px] py-2.5 pr-4 pl-4 active:bg-[#E5E5EA] transition-colors relative"
                  >
                    <div
                      className="w-[29px] h-[29px] rounded-[7px] flex items-center justify-center mr-3 shrink-0"
                      style={{ backgroundColor: bg }}
                    >
                      <span className="material-symbols-outlined text-white text-[18px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 500" }}>{icon}</span>
                    </div>
                    <span className={`text-[17px] flex-grow text-left leading-none ${isActive(path) ? 'font-semibold text-[#007AFF]' : 'text-black'}`}>
                      {label}
                    </span>
                    <svg className="w-[7px] h-[12px] text-[#C7C7CC] shrink-0" viewBox="0 0 7 12" fill="none">
                      <path d="M1 1L6 6L1 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    {idx < arr.length - 1 && (
                      <div className="absolute bottom-0 right-0 h-[0.5px] bg-[#C6C6C8]" style={{ width: 'calc(100% - 56px)', marginLeft: '56px' }} />
                    )}
                  </button>
                ))}
              </div>

              {/* Section 3: Hushh Coins — unlock CTA when 0, full card when > 0 */}
              {isAuthenticated && hushhCoins !== null && hushhCoins === 0 && (
                <div className="bg-white rounded-[10px] overflow-hidden mb-5 shadow-sm">
                  <button
                    onClick={handleMeetCeoClick}
                    className="flex items-center w-full min-h-[52px] py-3 pr-4 pl-4 active:bg-[#E5E5EA] transition-colors"
                  >
                    <div className="w-[29px] h-[29px] rounded-[7px] bg-[#FF9F0A] flex items-center justify-center mr-3 shrink-0">
                      <span className="material-symbols-outlined text-white text-[18px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 500" }}>lock</span>
                    </div>
                    <div className="flex flex-col flex-grow text-left">
                      <span className="text-[17px] text-black font-medium leading-tight">
                        {journeyCta.isInvestor ? "Unlock 300K Coins" : "Complete your investment"}
                      </span>
                      <span className="text-[13px] text-[#8E8E93] leading-tight mt-0.5">
                        {journeyCta.isInvestor ? "$1 or use coupon code" : "Your fund payment unlocks coins"}
                      </span>
                    </div>
                    <svg className="w-[7px] h-[12px] text-[#C7C7CC] shrink-0" viewBox="0 0 7 12" fill="none">
                      <path d="M1 1L6 6L1 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              )}
              {isAuthenticated && hushhCoins !== null && hushhCoins > 0 && (
                <div className="rounded-[10px] overflow-hidden mb-5 shadow-sm">
                  {/* Coins Balance Card — iOS Wallet style */}
                  <div className="bg-gradient-to-br from-[#1C1C1E] to-[#2C2C2E] p-4 rounded-t-[10px]">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-[29px] h-[29px] rounded-[7px] bg-[#FF9F0A] flex items-center justify-center shrink-0">
                          <span className="material-symbols-outlined text-white text-[18px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 500" }}>monetization_on</span>
                        </div>
                        <span className="text-[15px] font-semibold text-white/90">Hushh Coins</span>
                      </div>
                      <span className="text-[11px] text-white/40 font-medium">HC</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-[32px] font-bold text-white leading-none tracking-tight">
                        {hushhCoins !== null ? hushhCoins.toLocaleString() : '—'}
                      </span>
                      <span className="text-[13px] text-white/50 font-medium">coins</span>
                    </div>
                    {hushhCoins !== null && hushhCoins > 0 && (
                      <p className="text-[12px] text-white/40 mt-1.5">≈ ${(hushhCoins / 100).toLocaleString()} value</p>
                    )}
                  </div>
                  {/* Coins Actions — iOS grouped list style */}
                  <div className="bg-white rounded-b-[10px]">
                    <button
                      onClick={handleMeetCeoClick}
                      className="flex items-center w-full min-h-[44px] py-2.5 pr-4 pl-4 active:bg-[#E5E5EA] transition-colors relative"
                    >
                      <div className="w-[29px] h-[29px] rounded-[7px] bg-[#34C759] flex items-center justify-center mr-3 shrink-0">
                        <span className="material-symbols-outlined text-white text-[18px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 500" }}>calendar_month</span>
                      </div>
                      <span className="text-[17px] text-black flex-grow text-left leading-none">
                        {journeyCta.isInvestor ? "Book Consultation" : "Complete your investment"}
                      </span>
                      <svg className="w-[7px] h-[12px] text-[#C7C7CC] shrink-0" viewBox="0 0 7 12" fill="none">
                        <path d="M1 1L6 6L1 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <div className="absolute bottom-0 right-0 h-[0.5px] bg-[#C6C6C8]" style={{ width: 'calc(100% - 56px)', marginLeft: '56px' }} />
                    </button>
                    <button
                      onClick={() => handleLinkClick("/hushh-user-profile")}
                      className="flex items-center w-full min-h-[44px] py-2.5 pr-4 pl-4 active:bg-[#E5E5EA] transition-colors"
                    >
                      <div className="w-[29px] h-[29px] rounded-[7px] bg-[#5856D6] flex items-center justify-center mr-3 shrink-0">
                        <span className="material-symbols-outlined text-white text-[18px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 500" }}>receipt_long</span>
                      </div>
                      <span className="text-[17px] text-black flex-grow text-left leading-none">Transaction History</span>
                      <svg className="w-[7px] h-[12px] text-[#C7C7CC] shrink-0" viewBox="0 0 7 12" fill="none">
                        <path d="M1 1L6 6L1 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </div>
                </div>
              )}

              {/* Section 4: Profile & Account (only when authenticated) */}
              {isAuthenticated && (
                <div className="bg-white rounded-[10px] overflow-hidden mb-5 shadow-sm">
                  <button
                    onClick={() => handleLinkClick("/hushh-user-profile")}
                    className="flex items-center w-full min-h-[44px] py-2.5 pr-4 pl-4 active:bg-[#E5E5EA] transition-colors relative"
                  >
                    <div className="w-[29px] h-[29px] rounded-[7px] bg-[#007AFF] flex items-center justify-center mr-3 shrink-0">
                      <span className="material-symbols-outlined text-white text-[18px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 500" }}>person</span>
                    </div>
                    <span className="text-[17px] text-black flex-grow text-left leading-none">
                      {t('nav.viewProfile')}
                    </span>
                    <svg className="w-[7px] h-[12px] text-[#C7C7CC] shrink-0" viewBox="0 0 7 12" fill="none">
                      <path d="M1 1L6 6L1 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <div className="absolute bottom-0 right-0 h-[0.5px] bg-[#C6C6C8]" style={{ width: 'calc(100% - 56px)', marginLeft: '56px' }} />
                  </button>
                  <button
                    onClick={() => {
                      setIsOpen(false);
                      onDeleteModalOpen();
                    }}
                    className="flex items-center w-full min-h-[44px] py-2.5 pr-4 pl-4 active:bg-[#E5E5EA] transition-colors"
                  >
                    <span className="text-[17px] text-[#FF3B30] flex-grow text-left leading-none pl-0">
                      {t('nav.deleteAccount')}
                    </span>
                  </button>
                </div>
              )}

              {/* Spacer to push logout to bottom */}
              <div className="flex-grow" />

              {/* Log Out / Login Button */}
              <div className="mt-auto pt-2 pb-6 flex flex-col items-center">
                {isAuthenticated ? (
                  <button
                    onClick={handleLogout}
                    className="w-full h-[50px] rounded-[12px] bg-white text-[#007AFF] font-semibold text-[17px] active:scale-[0.98] active:opacity-90 transition-all flex items-center justify-center shadow-sm"
                  >
                    {t('nav.logout')}
                  </button>
                ) : (
                  <button
                    onClick={() => handleLinkClick("/Login")}
                    className="w-full h-[50px] rounded-[12px] bg-[#007AFF] text-white font-semibold text-[17px] active:scale-[0.98] active:opacity-90 transition-all flex items-center justify-center shadow-sm"
                  >
                    {t('nav.login')}
                  </button>
                )}
                <p className="text-center text-[13px] text-[#8E8E93] font-normal mt-4">
                  Version 2.4.0 (Build 302)
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Account Modal */}
      <DeleteAccountModal
        isOpen={isDeleteModalOpen}
        onClose={onDeleteModalClose}
        onAccountDeleted={handleAccountDeleted}
      />

      {/* Chip-based Ticker Styles */}
      <style>{`
        /* Ticker mask for fade edges */
        .ticker-mask {
          mask-image: linear-gradient(to right, transparent, black 5%, black 95%, transparent);
          -webkit-mask-image: linear-gradient(to right, transparent, black 5%, black 95%, transparent);
        }
        
        /* Ticker animation */
        .ticker-track {
          display: flex;
          width: max-content;
          transform: translate3d(0, 0, 0);
          will-change: transform;
        }

        .ticker-loop {
          min-width: max-content;
        }
        
        /* Scroll indicator bounce animation */
        .scroll-indicator-arrow {
          animation: bounce-down 1.5s ease-in-out infinite;
        }
        
        @keyframes bounce-down {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(4px);
          }
        }
      `}</style>
    </>
  );
}
