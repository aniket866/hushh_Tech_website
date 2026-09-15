/**
 * Profile Page — UI / Presentation (Revamped)
 * Apple iOS colors, SF-style headings, proper English capitalization.
 * Matches Home + Fund A + Community design language.
 * Logic stays in logic.ts via useProfileLogic().
 */
import React from 'react';
import HushhTechBackHeader from '../../components/hushh-tech-back-header/HushhTechBackHeader';
import HushhTechFooter, { HushhFooterTab } from '../../components/hushh-tech-footer/HushhTechFooter';
import {
  AppIcon,
  Icon,
  appleFont,
} from '../../components/hushh-tech-ui/HushhAppleUI';
import { useProfileLogic } from './logic';

const ProfilePage: React.FC = () => {
  const {
    onboardingStatus,
    primaryCTA,
    handleDiscoverFundA,
  } = useProfileLogic();
  const primaryCtaText =
    primaryCTA.state === 'unauthenticated'
      ? 'Complete Investment'
      : primaryCTA.text;

  return (
    <div
      className="flex min-h-screen flex-col bg-[#FFFFFF] text-[#1D1D1F] antialiased selection:bg-[#0066CC] selection:text-[#F5F5F7]"
      style={{ fontFamily: appleFont }}
    >
      {/* header */}
      <HushhTechBackHeader rightType="hamburger" showTicker />

      {/* scrollable content */}
      <main className="relative flex min-h-[100svh] flex-1 flex-col items-center justify-center overflow-hidden bg-white px-6 pb-[clamp(120px,15vh,150px)] pt-[clamp(140px,16vh,190px)] text-center">
        <style>
          {`
            @keyframes hh-profile-float {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-7px); }
            }
            @keyframes hh-breathe {
              0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: .85; }
              50% { transform: translate(-50%, -50%) scale(1.07); opacity: 1; }
            }
            @media (prefers-reduced-motion: reduce) {
              .hh-profile-float,
              .hh-profile-halo { animation: none !important; }
            }
          `}
        </style>

        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-[4%] z-0 h-[min(64vw,700px)] w-[min(82vw,940px)] -translate-x-1/2 rounded-full"
          style={{
            background:
              'radial-gradient(ellipse at 50% 40%, rgba(0,113,227,.09), rgba(0,113,227,0) 64%)',
          }}
        />

        <div
          aria-hidden="true"
          className="hh-profile-halo pointer-events-none absolute left-1/2 top-[34%] z-0 h-[min(108vw,1120px)] w-[min(108vw,1120px)] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background:
              'repeating-radial-gradient(circle at 50% 50%, rgba(0,113,227,0.07) 0, rgba(0,113,227,0.07) 1px, transparent 1px, transparent 92px)',
            WebkitMaskImage:
              'radial-gradient(circle at 50% 50%, #000 0%, rgba(0,0,0,0.5) 42%, transparent 66%)',
            maskImage:
              'radial-gradient(circle at 50% 50%, #000 0%, rgba(0,0,0,0.5) 42%, transparent 66%)',
            animation: 'hh-breathe 9s ease-in-out infinite',
          }}
        />

        <div className="relative z-[1] mx-auto flex w-full max-w-[860px] flex-col items-center">
          <span
            className="hh-profile-float mb-[26px] inline-flex h-[62px] w-[62px] items-center justify-center rounded-[20px]"
            style={{
              animation: 'hh-profile-float 4s ease-in-out infinite',
            }}
          >
            <AppIcon kind="profile" size={62} />
          </span>

          <div
            className="mb-[22px] text-[13px] font-bold uppercase leading-none text-[#0071e3]"
            style={{ letterSpacing: '.14em' }}
          >
            Profile
          </div>

          <h1 className="m-0 text-balance text-[clamp(36px,5.2vw,62px)] font-semibold leading-[1.06] tracking-[-.03em] text-[#1d1d1f]">
            Investing in the future.
          </h1>

          <p className="mx-auto mb-0 mt-6 max-w-[44ch] text-pretty text-[clamp(17px,1.6vw,20px)] font-normal leading-[1.5] tracking-[-.01em] text-[rgba(0,0,0,.62)]">
            The AI-powered Berkshire Hathaway. We combine AI and human expertise
            to invest in exceptional businesses for long-term value creation.
          </p>

          {/* action buttons */}
          <div
            className="mt-[clamp(34px,5vh,46px)] grid w-full max-w-[560px] grid-cols-1 items-center justify-center gap-3 sm:grid-cols-2"
            data-testid="profile-cta-group"
          >
            <button
              onClick={primaryCTA.action}
              disabled={onboardingStatus.loading}
              className="inline-flex min-h-[54px] w-full items-center justify-center whitespace-nowrap rounded-full border-0 bg-[#0071e3] px-8 text-[17px] font-semibold text-white shadow-[0_8px_24px_rgba(0,113,227,.26)] transition-[background,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:bg-[#0077ed] hover:shadow-[0_14px_34px_rgba(0,113,227,.34)] active:scale-[.97] disabled:pointer-events-none disabled:opacity-60"
              type="button"
            >
              {onboardingStatus.loading ? 'Loading...' : primaryCtaText}
            </button>
            <button
              onClick={handleDiscoverFundA}
              className="inline-flex min-h-[54px] w-full items-center justify-center gap-[5px] rounded-full border border-[rgba(0,0,0,.18)] bg-transparent px-8 text-[17px] font-medium text-[#0066cc] transition-[background,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-[rgba(0,0,0,.4)] hover:bg-[rgba(0,0,0,.03)] active:scale-[.97]"
              type="button"
            >
              Discover Fund A
              {Icon.chevronRight("#0066CC", 14)}
            </button>
          </div>

          {/* trust indicators */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#34C759]" />
              <p className="text-[11px] font-medium uppercase tracking-[1.6px] text-[#1D1D1F]/50">
                Private Markets
              </p>
            </div>
            <div className="flex items-center gap-2">
              {Icon.lock("#0066CC", 14)}
              <p className="text-[11px] font-medium uppercase tracking-[1.6px] text-[#1D1D1F]/50">
                Bank Level Security
              </p>
            </div>
          </div>

          {/* tagline */}
          <p className="mt-6 text-[13px] font-light tracking-normal text-[#1D1D1F]/45">
            Secure. Private. AI-Powered.
          </p>
        </div>
      </main>

      {/* ═══ Footer Nav ═══ */}
      <HushhTechFooter activeTab={HushhFooterTab.PROFILE} />
    </div>
  );
};

export default ProfilePage;
