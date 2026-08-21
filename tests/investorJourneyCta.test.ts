import { describe, expect, it, vi } from "vitest";

import { __testing__, type InvestorJourneyCta } from "../src/hooks/useInvestorJourneyCta";
import type { InvestorAccessState } from "../src/services/investorAccess/state";

const {
  ctaForState,
  hasBuiltInvestorProfile,
  hasProfileShell,
  isMissingProfileStatusColumnError,
} = __testing__;

type JourneyState =
  | "loading"
  | "unauthenticated"
  | "research_ready"
  | "research_unavailable"
  | InvestorAccessState;

const navigatorOf = () => {
  const navigate = vi.fn();
  return { navigate, mock: navigate };
};

describe("useInvestorJourneyCta CTA matrix", () => {
  const cases: Array<{
    label: string;
    state: JourneyState;
    currentStep: number;
    expectedText: string;
    expectedRoute?: string;
    isInvestor: boolean;
  }> = [
    {
      label: "loading shows neutral copy",
      state: "loading",
      currentStep: 1,
      expectedText: "Loading...",
      isInvestor: false,
    },
    {
      label: "unauthenticated visitors are pulled into the funnel",
      state: "unauthenticated",
      currentStep: 1,
      expectedText: "Start investing",
      expectedRoute: "/onboarding/financial-link",
      isInvestor: false,
    },
    {
      label: "Research profile metadata opens only the safe public profile",
      state: "research_ready",
      currentStep: 1,
      expectedText: "View your profile",
      expectedRoute: "/profile",
      isInvestor: false,
    },
    {
      label: "unavailable Research data cannot enter the legacy funnel",
      state: "research_unavailable",
      currentStep: 1,
      expectedText: "Profile unavailable",
      isInvestor: false,
    },
    {
      label: "needs_onboarding + step 1 sends user through FL (PD-1 fresh restart)",
      state: "needs_onboarding",
      currentStep: 1,
      expectedText: "Start investing",
      expectedRoute: "/onboarding/financial-link",
      isInvestor: false,
    },
    {
      label: "needs_onboarding mid-flow resumes at the folded canonical step",
      state: "needs_onboarding",
      currentStep: 5,
      expectedText: "Continue from step 3",
      expectedRoute: "/onboarding/step-3",
      isInvestor: false,
    },
    {
      label: "needs_payment routes to step-6",
      state: "needs_payment",
      currentStep: 13,
      expectedText: "Complete your investment",
      expectedRoute: "/onboarding/step-6",
      isInvestor: false,
    },
    {
      label: "payment_in_review grants Meet CEO access",
      state: "payment_in_review",
      currentStep: 13,
      expectedText: "Continue to Meet the CEO",
      expectedRoute: "/onboarding/meet-ceo",
      isInvestor: true,
    },
    {
      label: "verified_investor lands on portfolio dashboard",
      state: "verified_investor",
      currentStep: 13,
      expectedText: "View your portfolio",
      expectedRoute: "/hushh-user-profile",
      isInvestor: true,
    },
    {
      label: "payment_reversed pushes user back to step-6 to retry",
      state: "payment_reversed",
      currentStep: 13,
      expectedText: "Resume your investment",
      expectedRoute: "/onboarding/step-6",
      isInvestor: false,
    },
    {
      label: "rejected_investor routes to access-denied",
      state: "rejected_investor",
      currentStep: 13,
      expectedText: "Application status",
      expectedRoute: "/onboarding/access-denied",
      isInvestor: false,
    },
  ];

  it.each(cases)("$label", ({ state, currentStep, expectedText, expectedRoute, isInvestor }) => {
    const { navigate, mock } = navigatorOf();
    const cta: InvestorJourneyCta = ctaForState(state, currentStep, navigate);
    expect(cta.text).toBe(expectedText);
    expect(cta.isInvestor).toBe(isInvestor);
    expect(cta.loading).toBe(state === "loading");

    cta.action();
    if (expectedRoute) {
      expect(mock).toHaveBeenCalledWith(expectedRoute);
    } else {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("never reuses the same misleading 'Invest with Hushh' label across all states", () => {
    const navigate = vi.fn();
    const allStates: JourneyState[] = [
      "loading",
      "unauthenticated",
      "research_ready",
      "research_unavailable",
      "needs_onboarding",
      "needs_payment",
      "payment_in_review",
      "verified_investor",
      "payment_reversed",
      "rejected_investor",
    ];
    for (const state of allStates) {
      expect(ctaForState(state, 1, navigate).text).not.toBe("Invest with Hushh");
    }
  });

  it("routes paid users with a built investor profile to their profile", () => {
    const { navigate, mock } = navigatorOf();
    const cta = ctaForState("payment_in_review", 13, navigate, {
      hasBuiltInvestorProfile: true,
    });

    expect(cta.text).toBe("View your profile");
    expect(cta.isInvestor).toBe(true);
    cta.action();
    expect(mock).toHaveBeenCalledWith("/hushh-user-profile");
  });

  it("keeps paid users without a built investor profile on Meet CEO", () => {
    const { navigate, mock } = navigatorOf();
    const cta = ctaForState("payment_in_review", 13, navigate, {
      hasBuiltInvestorProfile: false,
    });

    expect(cta.text).toBe("Continue to Meet the CEO");
    cta.action();
    expect(mock).toHaveBeenCalledWith("/onboarding/meet-ceo");
  });

  it("detects profile-ready rows and generated investor payloads as built", () => {
    expect(hasBuiltInvestorProfile({ id: "profile-row-1", user_confirmed: false, investor_profile: null })).toBe(true);
    expect(hasBuiltInvestorProfile({ slug: "manish", user_confirmed: false, investor_profile: null })).toBe(true);
    expect(hasBuiltInvestorProfile({ name: "MANISH", user_confirmed: false, investor_profile: null })).toBe(true);
    expect(hasBuiltInvestorProfile({ email: "manish@example.com", user_confirmed: false, investor_profile: null })).toBe(true);
    expect(hasBuiltInvestorProfile({ user_confirmed: true, investor_profile: null })).toBe(true);
    expect(hasBuiltInvestorProfile({ user_confirmed: false, confirmed_at: "2026-06-21T00:00:00Z" })).toBe(true);
    expect(
      hasBuiltInvestorProfile({
        user_confirmed: false,
        investor_profile: { risk_tolerance: "moderate" },
      }),
    ).toBe(true);
    expect(
      hasBuiltInvestorProfile({
        user_confirmed: false,
        investor_profile: null,
        shadow_profile: {
          profileIntelligence: {
            headline: "Profile intelligence ready",
          },
        },
      }),
    ).toBe(true);
    expect(
      hasBuiltInvestorProfile({
        user_confirmed: false,
        investor_profile: null,
        profile_research: { status: "completed" },
      }),
    ).toBe(true);
    expect(
      hasBuiltInvestorProfile({
        user_confirmed: false,
        investor_profile: null,
        analyst_summary: "Founder and investor profile available",
      }),
    ).toBe(true);
    expect(
      hasBuiltInvestorProfile({
        user_confirmed: false,
        investor_profile: null,
        enriched_title: "Founder",
      }),
    ).toBe(true);
    expect(hasBuiltInvestorProfile({ user_confirmed: false, investor_profile: null })).toBe(false);
    expect(hasBuiltInvestorProfile({ user_confirmed: false, investor_profile: {}, shadow_profile: {} })).toBe(false);
    expect(hasBuiltInvestorProfile(null)).toBe(false);
  });

  it("treats a visible profile shell as profile-ready even before AI enrichment", () => {
    expect(hasProfileShell({ slug: "manish", name: "", email: "", investor_profile: null })).toBe(true);
    expect(hasProfileShell({ id: "profile-row-1", investor_profile: null })).toBe(true);
    expect(hasProfileShell({ slug: "", name: "", email: "", investor_profile: null })).toBe(false);
  });

  it("only falls back on missing-column profile status errors", () => {
    expect(
      isMissingProfileStatusColumnError({
        code: "PGRST204",
        message: "Could not find the 'profile_research' column of 'investor_profiles'",
      }),
    ).toBe(true);
    expect(
      isMissingProfileStatusColumnError({
        code: "42501",
        message: "permission denied for table investor_profiles",
      }),
    ).toBe(false);
  });
});
