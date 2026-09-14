import React, { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuthSession } from "../../auth/AuthSessionProvider";
import { useHushhProfileCta } from "../../hooks/useHushhProfileCta";
import { useModalKeyboardNavigation } from "../../hooks/useModalKeyboardNavigation";
import { moveFocusWithin } from "../../utils/keyboardNavigation";
import DeleteAccountModal from "../DeleteAccountModal";
import { AdaptiveSheet } from "../ui/AdaptiveSheet";
import { AppleButton, HushhMark, Icon, SYS, appleFont } from "../hushh-tech-ui/HushhAppleUI";

interface NavItem {
  icon: (color: string, size?: number) => React.ReactNode;
  label: string;
  path: string;
}

const PRIMARY_NAV: NavItem[] = [
  { icon: Icon.home, label: "Home", path: "/" },
  { icon: Icon.chart, label: "Fund A", path: "/discover-fund-a" },
  { icon: Icon.community, label: "Community", path: "/community" },
  { icon: Icon.mail, label: "Contact", path: "/contact" },
  { icon: Icon.community, label: "About Us", path: "/about/leadership" },
  { icon: Icon.help, label: "FAQ", path: "/faq" },
  { icon: Icon.briefcase, label: "Careers", path: "/career" },
];

interface HushhTechNavDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const MenuRow = ({
  item,
  isLast,
  isActive,
  onClick,
}: {
  item: NavItem;
  isLast: boolean;
  isActive: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="relative flex w-full items-center gap-3 bg-transparent px-1 py-3.5 text-left transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35"
    aria-current={isActive ? "page" : undefined}
  >
    <span className="flex h-6 w-6 shrink-0 items-center justify-center">
      {item.icon(isActive ? SYS.blue : SYS.text, 22)}
    </span>
    <span
      className="min-w-0 flex-1 text-[17px] font-medium tracking-[-0.01em] text-[#1D1D1F]"
      style={{ fontFamily: appleFont }}
    >
      {item.label}
    </span>
    {Icon.chevronRight("rgba(60,60,67,0.25)", 13)}
    {!isLast ? (
      <span className="absolute bottom-0 left-10 right-0 h-px bg-[#000000]/[0.10]" />
    ) : null}
  </button>
);

const HushhTechNavDrawer: React.FC<HushhTechNavDrawerProps> = ({
  isOpen,
  onClose,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, signOut } = useAuthSession();
  const isAuthenticated = status === "authenticated";
  const { primaryCTA } = useHushhProfileCta({ enabled: isOpen });
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useModalKeyboardNavigation({
    isOpen,
    containerRef: drawerRef,
    initialFocusRef: closeButtonRef,
    onClose,
  });

  const handleNavigate = (path: string) => {
    onClose();
    navigate(path);
  };

  const handleLogout = async () => {
    onClose();
    await signOut();
    // PD-5: goodbye page replaces the abrupt /login redirect.
    navigate("/signed-out");
  };

  const handleDeleteAccount = () => {
    setIsDeleteModalOpen(true);
  };

  const handleAccountDeleted = () => {
    setIsDeleteModalOpen(false);
    onClose();
    navigate("/");
  };

  const handleUnlockCoins = () => {
    onClose();
    primaryCTA.action();
  };

  const handleDrawerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    moveFocusWithin(drawerRef.current, event);
  };

  return (
    <>
    <AdaptiveSheet
      isOpen={isOpen}
      onClose={onClose}
      labelledBy="hushh-nav-drawer-title"
      panelRef={drawerRef}
      onKeyDown={handleDrawerKeyDown}
      className="selection:bg-[#0066CC] selection:text-[#F5F5F7]"
      header={({ isDesktop }) => (
        <div className="flex items-center justify-between px-5 py-5">
          <div className="flex items-center gap-3">
            <HushhMark size={34} />
            <span className="flex flex-col leading-none">
              <span
                id="hushh-nav-drawer-title"
                className="text-[17px] font-semibold tracking-[-0.015em] text-[#1D1D1F]"
                style={{ fontFamily: appleFont }}
              >
                hushh
              </span>
              <span
                className="mt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[#1D1D1F]/50"
                style={{ fontFamily: appleFont }}
              >
                Technologies
              </span>
            </span>
          </div>

          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className={`h-11 w-11 items-center justify-center rounded-full bg-[#767680]/15 text-[#1D1D1F] transition hover:bg-[#767680]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35 ${isDesktop ? "flex" : "hidden"}`}
            aria-label="Close menu"
          >
            {Icon.close("#1D1D1F", 13)}
          </button>
        </div>
      )}
    >
        <div className="px-5 pb-[calc(env(safe-area-inset-bottom,0px)+2rem)]">
          <button
            type="button"
            onClick={handleUnlockCoins}
            disabled={primaryCTA.loading}
            className="mb-3 flex w-full items-center gap-3 rounded-[14px] px-4 py-3.5 text-left transition active:scale-[0.98] disabled:opacity-55"
            style={{
              background:
                "linear-gradient(135deg, rgba(0,102,204,0.08) 0%, rgba(94,92,230,0.06) 100%)",
              boxShadow: "inset 0 0 0 1px rgba(0,102,204,0.16)",
              fontFamily: appleFont,
            }}
          >
            {Icon.lock(SYS.blue, 22)}
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-[15px] font-semibold tracking-[-0.01em] text-[#1D1D1F]">
                Unlock 300K Coins
              </span>
              <span className="mt-0.5 block text-[12px] font-normal tracking-normal text-[#1D1D1F]/55">
                $1 or use coupon code
              </span>
            </span>
            {Icon.arrowRight(SYS.blue, 14)}
          </button>

          <div className="rounded-[16px] bg-[#FFFFFF]">
            {PRIMARY_NAV.map((item, index) => (
              <MenuRow
                key={item.path}
                item={item}
                isLast={index === PRIMARY_NAV.length - 1}
                isActive={location.pathname === item.path}
                onClick={() => handleNavigate(item.path)}
              />
            ))}
          </div>

          {/* A signed-in user's own NDA + reviewed documents — always reachable
              here, independent of payment status (page is auth-only, not gated). */}
          {isAuthenticated ? (
            <div className="mt-3 rounded-[16px] bg-[#FFFFFF]">
              <MenuRow
                item={{ icon: Icon.shield, label: "My NDA & Documents", path: "/my-documents" }}
                isLast
                isActive={location.pathname.startsWith("/my-documents")}
                onClick={() => handleNavigate("/my-documents")}
              />
            </div>
          ) : null}

          {/* P0.G — Manage onboarding quick link. Renders only for signed-in
              users who have not yet been verified (the journey CTA exposes
              isInvestor=false for those states). Gives a single-click path to
              FL review mode from any page in the app. */}
          {isAuthenticated && !primaryCTA.isInvestor && !primaryCTA.loading && (
            <button
              type="button"
              onClick={() => handleNavigate("/onboarding/financial-link?mode=review")}
              className="mt-3 flex w-full items-center justify-between rounded-[16px] bg-[#FFFFFF] px-4 py-3 text-left text-[14px] font-medium text-[#1D1D1F] transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35"
              style={{ fontFamily: appleFont }}
            >
              <span className="flex items-center gap-3">
                <span className="material-symbols-outlined text-[18px] text-[#0066CC]">
                  account_balance
                </span>
                <span>Review bank connection</span>
              </span>
              {Icon.arrowRight(SYS.blue, 14)}
            </button>
          )}

          <div className="pt-7">
            {isAuthenticated ? (
              <div className="space-y-3">
                <AppleButton kind="tinted" onClick={() => handleNavigate("/hushh-user-profile")}>
                  View Profile
                </AppleButton>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="w-full py-2 text-center text-[14px] font-normal text-[#FF3B30] transition hover:opacity-80"
                  style={{ fontFamily: appleFont }}
                >
                  Log Out
                </button>
                <button
                  type="button"
                  onClick={handleDeleteAccount}
                  className="w-full py-2 text-center text-[13px] font-normal text-[#8E8E93] transition hover:text-[#FF3B30] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF3B30]/25"
                  style={{ fontFamily: appleFont }}
                >
                  Delete Account
                </button>
              </div>
            ) : (
              <>
                <AppleButton kind="tinted" onClick={() => handleNavigate("/signup")}>
                  Sign Up
                </AppleButton>
                <div className="mt-3 text-center">
                  <span
                    className="text-[14px] tracking-normal text-[#1D1D1F]/60"
                    style={{ fontFamily: appleFont }}
                  >
                    Already have an account?{" "}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleNavigate("/login")}
                    className="text-[14px] font-medium tracking-[-0.01em] text-[#0066CC]"
                    style={{ fontFamily: appleFont }}
                  >
                    Log In
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="h-6" />
        </div>
    </AdaptiveSheet>

    <DeleteAccountModal
      isOpen={isDeleteModalOpen}
      onClose={() => setIsDeleteModalOpen(false)}
      onAccountDeleted={handleAccountDeleted}
    />
    </>
  );
};

export default HushhTechNavDrawer;
