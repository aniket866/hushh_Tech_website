/**
 * Signed-out / goodbye surface (PD-5).
 *
 * After signing out from inside the Hushh Fund app the user used to drop
 * straight onto /login with no acknowledgement that their progress was
 * saved. For a fund business this is a missed-trust moment: signing-out
 * mid-onboarding feels like "losing" your application even though the
 * server still has the row. This page reframes the exit as a pause.
 */
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import HushhTechBackHeader from "../../components/hushh-tech-back-header/HushhTechBackHeader";
import HushhTechCta, {
  HushhTechCtaVariant,
} from "../../components/hushh-tech-cta/HushhTechCta";
import {
  Display,
  Lede,
  appleFont,
} from "../../components/hushh-tech-ui/HushhAppleUI";

const primaryCtaClass =
  "!rounded-full !border-[#0066CC] !bg-[#0066CC] !text-white !font-medium !tracking-normal !shadow-none";
const secondaryCtaClass =
  "!rounded-full !border-[#1D1D1F]/15 !bg-white !text-[#1D1D1F] !font-medium !tracking-normal !shadow-none";

const REASONS: Record<string, { title: string; body: string }> = {
  default: {
    title: "You're signed out.",
    body: "Your progress is saved. Sign back in to pick up where you left off.",
  },
  deleted: {
    title: "Your Hushh account is closed.",
    body: "All your personal data and onboarding state have been removed. You can create a new account anytime to start fresh.",
  },
  expired: {
    title: "Your session ended for security.",
    body: "Sign back in to continue where you left off. Nothing you saved was lost.",
  },
};

export default function SignedOutPage() {
  const [searchParams] = useSearchParams();
  const reason = searchParams.get("reason") || "default";
  const copy = useMemo(() => REASONS[reason] || REASONS.default, [reason]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div
      className="flex min-h-screen flex-col bg-white text-[#1D1D1F] antialiased"
      style={{ fontFamily: appleFont }}
    >
      <HushhTechBackHeader
        onBackClick={() => window.location.assign("/")}
        rightLabel="FAQ"
      />

      <main className="mx-auto flex w-full max-w-[560px] flex-grow flex-col px-5 pb-24 pt-20 text-center">
        <Display as="h1" size="xs" maxWidth="max-w-[520px]">
          {copy.title}
        </Display>
        <Lede className="mx-auto max-w-[480px]">{copy.body}</Lede>

        <div className="mt-8 space-y-3">
          {reason !== "deleted" && (
            <HushhTechCta
              variant={HushhTechCtaVariant.BLACK}
              onClick={() => window.location.assign("/login")}
              className={primaryCtaClass}
            >
              Sign back in
            </HushhTechCta>
          )}
          <HushhTechCta
            variant={HushhTechCtaVariant.WHITE}
            onClick={() => window.location.assign("/")}
            className={secondaryCtaClass}
          >
            Back to Hushh Tech
          </HushhTechCta>
        </div>
      </main>
    </div>
  );
}
