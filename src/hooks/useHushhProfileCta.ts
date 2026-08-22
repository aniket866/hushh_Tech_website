/**
 * @deprecated Use {@link useInvestorJourneyCta} instead.
 *
 * This hook used to maintain its own copy of the "where should this user
 * go next" decision logic. It bypassed the InvestorAccessRoute state
 * machine, which caused the home page CTA bug where users with cleared
 * FL state were dropped on /onboarding/step-1 despite the label promising
 * "Invest with Hushh".
 *
 * The implementation now thin-wraps {@link useInvestorJourneyCta}. Kept
 * as an export so callers that import the old name keep working; new
 * code should import from `./useInvestorJourneyCta` directly.
 */
import {
  useInvestorJourneyCta,
  type InvestorJourneyCta,
  type UseInvestorJourneyCtaOptions,
} from "./useInvestorJourneyCta";
import { Session } from "@/services/gcpBackend/types";

export type HushhProfileCta = InvestorJourneyCta;

export interface HushhProfileCtaResult {
  session: Session | null;
  primaryCTA: HushhProfileCta;
}

export const useHushhProfileCta = (
  options: UseInvestorJourneyCtaOptions = {},
): HushhProfileCtaResult => useInvestorJourneyCta(options);
