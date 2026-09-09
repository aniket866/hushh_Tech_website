import React, { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import HushhTechFaqSheet from "../hushh-tech-faq-sheet/HushhTechFaqSheet";
import HushhTechNavDrawer from "../hushh-tech-nav-drawer/HushhTechNavDrawer";
import HushhTechTicker from "../hushh-tech-ticker/HushhTechTicker";
import { GlassPill, HushhMark, Icon, appleFont } from "../hushh-tech-ui/HushhAppleUI";

interface HushhTechBackHeaderProps {
  onBackClick?: () => void;
  rightType?: "label" | "hamburger";
  rightLabel?: string;
  onRightClick?: () => void;
  showRightButton?: boolean;
  showTicker?: boolean;
  className?: string;
}

const HushhTechBackHeader: React.FC<HushhTechBackHeaderProps> = ({
  onBackClick,
  rightType = "label",
  rightLabel = "FAQ",
  onRightClick,
  showRightButton = true,
  showTicker = false,
  className = "",
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isFaqOpen, setIsFaqOpen] = useState(false);

  const handleRightClick = () => {
    if (onRightClick) {
      onRightClick();
      return;
    }

    if (!["faq", "faqs"].includes(rightLabel?.toLowerCase() ?? "")) return;

    if (location.pathname.startsWith("/onboarding")) {
      setIsFaqOpen(true);
      return;
    }

    if (location.pathname !== "/faq") {
      navigate("/faq");
    }
  };

  const handleBackClick = () => {
    if (onBackClick) {
      onBackClick();
      return;
    }

    if (window.history.length > 1) {
      navigate(-1);
      return;
    }

    navigate("/");
  };

  const handleBrandClick = () => navigate("/");
  const headerClassName = `fixed left-0 right-0 top-0 z-50 border-b border-[#1D1D1F]/[0.08] ${className}`;

  const brandButton = (
    <button
      type="button"
      onClick={handleBrandClick}
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

  return (
    <>
      <header
        className={headerClassName}
        data-hushh-back-header
        style={{
          // Apple "Liquid Glass": translucent + blurred/saturated backdrop +
          // specular top edge + depth shadow. Matches HushhTechHeader so page
          // content does not bleed through the header/ticker on scroll.
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.66) 0%, rgba(255,255,255,0.52) 100%)",
          WebkitBackdropFilter: "blur(24px) saturate(180%)",
          backdropFilter: "blur(24px) saturate(180%)",
          boxShadow:
            "0 12px 34px rgba(29,29,31,0.10), inset 0 1px 0 rgba(255,255,255,0.92), inset 0 -0.5px 0 rgba(29,29,31,0.05)",
        }}
      >
        <div className="relative flex w-full items-center justify-between px-3 pb-3 pt-[max(env(safe-area-inset-top),0.85rem)] sm:px-5">
          <div className="relative flex min-w-0 items-center">
            <GlassPill className="relative min-w-0 shrink">
              <div className="flex min-w-0 items-center">
                <button
                  type="button"
                  onClick={handleBackClick}
                  className="flex h-11 w-11 items-center justify-center text-[#1D1D1F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35 focus-visible:ring-offset-2"
                  aria-label="Go back"
                >
                  {Icon.back("currentColor", 18)}
                </button>
                <span aria-hidden className="h-6 w-px bg-[#1D1D1F]/10" />
                {brandButton}
              </div>
            </GlassPill>
          </div>

          {showRightButton && rightType === "hamburger" ? (
            <div className="flex items-center gap-1.5">
              <GlassPill className="relative">
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
          ) : null}

          {showRightButton && rightType === "label" ? (
            <GlassPill className="relative">
              <button
                type="button"
                onClick={handleRightClick}
                className="flex h-11 items-center justify-center px-5 text-[12px] font-medium tracking-[0.08em] text-[#1D1D1F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35 focus-visible:ring-offset-2"
                aria-label={rightLabel}
                style={{ fontFamily: appleFont }}
              >
                {rightLabel}
              </button>
            </GlassPill>
          ) : null}
        </div>

        {showTicker ? <HushhTechTicker /> : null}
      </header>

      <div className={showTicker ? "h-[146px]" : "h-[72px]"} />

      {rightType === "hamburger" ? (
        <HushhTechNavDrawer
          isOpen={isDrawerOpen}
          onClose={() => setIsDrawerOpen(false)}
        />
      ) : null}

      <HushhTechFaqSheet
        isOpen={isFaqOpen}
        onClose={() => setIsFaqOpen(false)}
      />
    </>
  );
};

export default HushhTechBackHeader;
