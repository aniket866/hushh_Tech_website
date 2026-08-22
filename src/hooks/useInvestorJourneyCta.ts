/**
 * useInvestorJourneyCta — single source of truth for "where should this
 * user go next" across every Hushh Fund entry point (home page, Hero,
 * Navbar, nav drawer, profile pages, AuthCallback resume).
 *
 * Replaces 4 duplicate copies of the same branching logic that previously
 * lived in:
 *   - src/hooks/useHushhProfileCta.ts
 *   - src/components/Hero.tsx (getPrimaryCTA)
 *   - src/components/profile/profilePage.tsx (getPrimaryCTAContent)
 *   - src/pages/profile/logic.ts (getPrimaryCTAContent)
 *
 * Each of those bypassed the InvestorAccessRoute state machine, which
 * caused users to land on misleading pages (e.g., "Invest with Hushh" →
 * /onboarding/step-1 despite never having seen the FL page in this
 * session). This hook consumes `getInvestorAccessState` so every CTA
 * agrees on the user's actual journey position.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Session, GcpBackendClient } from "@/services/gcpBackend/types";
import { useAuthSession } from "../auth/AuthSessionProvider";
import config from "../resources/config/config";
import {
  FINANCIAL_LINK_ROUTE,
  getCanonicalOnboardingRoute,
  getOnboardingDisplayMeta,
} from "../services/onboarding/flow";
import { fetchResolvedOnboardingProgress } from "../services/onboarding/progress";
import {
  hasHushhResearchProfileMetadata,
  readHushhResearchCompatibilityIfActive,
} from "../services/hushhResearch/compatibility";
import { isHushhResearchAuthMode } from "../services/hushhResearch/firebaseAuth";
import { HUSHH_RESEARCH_SOURCE } from "../services/hushhResearch/contracts";
import {
  ACCESS_DENIED_ROUTE,
  MEET_CEO_ROUTE,
  PROFILE_ROUTE,
  STEP_9_ROUTE,
  getInvestorAccessState,
  type InvestorAccessState,
} from "../services/investorAccess/state";

export interface InvestorJourneyCta {
  /** What the user sees on the button. Always honest about the action. */
  text: string;
  /** Where the click takes them. */
  action: () => void;
  /** True while the underlying state is still being fetched. */
  loading: boolean;
  /** The derived investor-access state (for callers that branch UI on this). */
  state:
    | InvestorAccessState
    | "unauthenticated"
    | "loading"
    | "research_ready"
    | "research_unavailable";
  /** True when the user has cleared the Stripe payment gate. */
  isInvestor: boolean;
  /**
   * Subtle progress hint for mid-flow users, e.g. "Step 4 of 9". Null when
   * progress messaging would be misleading (loading, unauthenticated, or
   * users who are not mid-onboarding).
   */
  progressLabel: string | null;
}

export interface UseInvestorJourneyCtaOptions {
  /** Defer state fetch (e.g., drawer is closed). Defaults to true. */
  enabled?: boolean;
}

export interface InvestorJourneyResult {
  session: Session | null;
  primaryCTA: InvestorJourneyCta;
}

type JourneyState =
  | "loading"
  | "unauthenticated"
  | "research_ready"
  | "research_unavailable"
  | InvestorAccessState;

const RESEARCH_PROFILE_ROUTE = "/profile" as const;

interface InvestorProfileStatusRecord {
  id?: string | number | null;
  slug?: string | null;
  name?: string | null;
  email?: string | null;
  user_confirmed?: boolean | null;
  confirmed_at?: string | null;
  investor_profile?: unknown | null;
  shadow_profile?: unknown | null;
  profile_research?: unknown | null;
  analyst_summary?: string | null;
  enriched_company?: string | null;
  enriched_title?: string | null;
  enriched_bio?: string | null;
  enriched_linkedin_url?: string | null;
  enriched_location?: string | null;
}

function hasProfilePayload(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function hasProfileShell(profile: InvestorProfileStatusRecord): boolean {
  return Boolean(
    hasProfilePayload(profile.slug) ||
      hasProfilePayload(profile.name) ||
      hasProfilePayload(profile.email) ||
      hasProfilePayload(profile.id),
  );
}

function hasBuiltInvestorProfile(
  profile: InvestorProfileStatusRecord | null | undefined,
): boolean {
  if (!profile) return false;

  return Boolean(
    hasProfileShell(profile) ||
      profile.user_confirmed ||
      profile.confirmed_at ||
      hasProfilePayload(profile.investor_profile) ||
      hasProfilePayload(profile.shadow_profile) ||
      hasProfilePayload(profile.profile_research) ||
      hasProfilePayload(profile.analyst_summary) ||
      hasProfilePayload(profile.enriched_company) ||
      hasProfilePayload(profile.enriched_title) ||
      hasProfilePayload(profile.enriched_bio) ||
      hasProfilePayload(profile.enriched_linkedin_url) ||
      hasProfilePayload(profile.enriched_location),
  );
}

const INVESTOR_PROFILE_STATUS_COLUMNS = [
  "id",
  "slug",
  "name",
  "email",
  "user_confirmed",
  "confirmed_at",
  "investor_profile",
  "shadow_profile",
  "profile_research",
  "analyst_summary",
  "enriched_company",
  "enriched_title",
  "enriched_bio",
  "enriched_linkedin_url",
  "enriched_location",
].join(", ");

const INVESTOR_PROFILE_STATUS_FALLBACK_COLUMNS = [
  "id",
  "slug",
  "name",
  "email",
  "user_confirmed",
  "confirmed_at",
  "investor_profile",
  "shadow_profile",
].join(", ");

const INVESTOR_PROFILE_STATUS_CORE_COLUMNS = [
  "id",
  "slug",
  "name",
  "email",
  "user_confirmed",
  "investor_profile",
].join(", ");

function isMissingProfileStatusColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; message?: string; details?: string };
  const text = `${candidate.code ?? ""} ${candidate.message ?? ""} ${candidate.details ?? ""}`.toLowerCase();
  return text.includes("column") && (
    text.includes("not found") ||
    text.includes("could not find") ||
    text.includes("does not exist")
  );
}

async function fetchInvestorProfileBuiltStatus(
  client: GcpBackendClient,
  userId: string,
): Promise<boolean> {
  const researchProfile = await readHushhResearchCompatibilityIfActive("profile");
  if (researchProfile.mode === "research") {
    return hasHushhResearchProfileMetadata(researchProfile.response.payload);
  }

  if (typeof client.from !== "function") return false;

  const selections = [
    INVESTOR_PROFILE_STATUS_COLUMNS,
    INVESTOR_PROFILE_STATUS_FALLBACK_COLUMNS,
    INVESTOR_PROFILE_STATUS_CORE_COLUMNS,
  ];
  let lastError: unknown = null;

  try {
    for (const columns of selections) {
      const { data, error } = await client
        .from("investor_profiles")
        .select(columns)
        .eq("user_id", userId)
        .maybeSingle();

      if (!error) return hasBuiltInvestorProfile(data);

      lastError = error;
      if (!isMissingProfileStatusColumnError(error)) break;
    }

    console.warn("[useInvestorJourneyCta] investor profile status fetch failed", lastError);
    return false;
  } catch (error) {
    console.warn("[useInvestorJourneyCta] investor profile status fetch failed", error);
    return false;
  }
}

async function resolveHushhResearchJourneyState(): Promise<
  "research_ready" | "research_unavailable"
> {
  const [profile, onboarding] = await Promise.all([
    readHushhResearchCompatibilityIfActive("profile", {
      researchBoundary: true,
    }),
    readHushhResearchCompatibilityIfActive("onboarding", {
      researchBoundary: true,
    }),
  ]);
  if (profile.mode !== "research" || onboarding.mode !== "research") {
    return "research_unavailable";
  }

  // Onboarding metadata is intentionally not translated into Fund, Plaid,
  // payment, or KYC actions for the Research cohort. Only safe profile
  // metadata can produce an actionable CTA.
  return hasHushhResearchProfileMetadata(profile.response.payload)
    ? "research_ready"
    : "research_unavailable";
}

/**
 * Canonical label + action map. PM decisions (PD-1, PD-6) live here so
 * every surface stays consistent.
 */
function ctaForState(
  state: JourneyState,
  currentStep: number,
  navigate: (to: string) => void,
  options: { hasBuiltInvestorProfile?: boolean } = {},
): InvestorJourneyCta {
  const base = {
    loading: state === "loading",
    state,
    isInvestor: false,
    progressLabel: null as string | null,
  };
  switch (state) {
    case "loading":
      return { ...base, text: "Loading...", action: () => {} };
    case "research_ready":
      return {
        ...base,
        text: "View your profile",
        action: () => navigate(RESEARCH_PROFILE_ROUTE),
      };
    case "research_unavailable":
      return {
        ...base,
        text: "Profile unavailable",
        action: () => {},
      };
    case "unauthenticated":
      return {
        ...base,
        text: "Start investing",
        action: () => navigate(FINANCIAL_LINK_ROUTE),
      };
    case "needs_onboarding": {
      // PD-1 (fresh restart bias): if the user never made progress past
      // step-1, always send them through financial-link so the first
      // visible page is the canonical funnel entry, not a half-filled
      // form. This is the bug that the home page CTA exposed today.
      if (currentStep <= 1) {
        return {
          ...base,
          text: "Start investing",
          action: () => navigate(FINANCIAL_LINK_ROUTE),
        };
      }
      // Translate the raw `current_step` to the canonical display step (1-9)
      // before showing it in the label. Raw values can collide on the same
      // displayed step (e.g., raw 4 and raw 8 both display as step 3 after
      // the address-folding refactor).
      const stepRoute = getCanonicalOnboardingRoute(currentStep);
      const { displayStep, totalSteps } = getOnboardingDisplayMeta(stepRoute);
      return {
        ...base,
        text: `Continue from step ${displayStep}`,
        action: () => navigate(stepRoute),
        progressLabel: `Step ${displayStep} of ${totalSteps}`,
      };
    }
    case "needs_payment":
      return {
        ...base,
        text: "Complete your investment",
        action: () => navigate(STEP_9_ROUTE),
        progressLabel: "Final step",
      };
    case "payment_in_review":
      if (options.hasBuiltInvestorProfile) {
        return {
          ...base,
          text: "View your profile",
          action: () => navigate(PROFILE_ROUTE),
          isInvestor: true,
        };
      }
      return {
        ...base,
        text: "Continue to Meet the CEO",
        action: () => navigate(MEET_CEO_ROUTE),
        isInvestor: true,
      };
    case "verified_investor":
      return {
        ...base,
        text: "View your portfolio",
        action: () => navigate(PROFILE_ROUTE),
        isInvestor: true,
      };
    case "payment_reversed":
      return {
        ...base,
        text: "Resume your investment",
        action: () => navigate(STEP_9_ROUTE),
      };
    case "rejected_investor":
      return {
        ...base,
        text: "Application status",
        action: () => navigate(ACCESS_DENIED_ROUTE),
      };
  }
}

/**
 * The hook itself. Drop-in replacement for `useHushhProfileCta`.
 */
export function useInvestorJourneyCta(
  options: UseInvestorJourneyCtaOptions = {},
): InvestorJourneyResult {
  const { enabled = true } = options;
  const navigate = useNavigate();
  const { session, status } = useAuthSession();
  const isResearchSession =
    isHushhResearchAuthMode() ||
    session?.user?.app_metadata?.auth_source === HUSHH_RESEARCH_SOURCE;

  const [state, setState] = useState<JourneyState>("loading");
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [profileBuilt, setProfileBuilt] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const resolve = async () => {
      if (status === "booting") return;
      if (isResearchSession) {
        try {
          const researchState = await resolveHushhResearchJourneyState();
          if (!cancelled) {
            setState(researchState);
            setCurrentStep(1);
            setProfileBuilt(researchState === "research_ready");
          }
        } catch {
          if (!cancelled) {
            setState("research_unavailable");
            setCurrentStep(1);
            setProfileBuilt(false);
          }
        }
        return;
      }
      if (!session?.user?.id) {
        if (!cancelled) {
          setState("unauthenticated");
          setCurrentStep(1);
          setProfileBuilt(false);
        }
        return;
      }
      if (!config.gcpBackendClient) {
        if (!cancelled) {
          setState("unauthenticated");
          setProfileBuilt(false);
        }
        return;
      }
      try {
        const [onboarding, hasProfileBuilt] = await Promise.all([
          fetchResolvedOnboardingProgress(config.gcpBackendClient, session.user.id),
          fetchInvestorProfileBuiltStatus(config.gcpBackendClient, session.user.id),
        ]);
        if (cancelled) return;
        const derived = getInvestorAccessState(onboarding);
        setState(derived);
        setCurrentStep(onboarding?.current_step || 1);
        setProfileBuilt(hasProfileBuilt);
      } catch (error) {
        if (cancelled) return;
        console.warn("[useInvestorJourneyCta] state fetch failed", error);
        // Fail soft: treat as needs_onboarding (FL is always safe).
        setState("needs_onboarding");
        setCurrentStep(1);
        setProfileBuilt(false);
      }
    };

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [enabled, isResearchSession, session?.user?.id, status]);

  const navigateMemo = useCallback((to: string) => navigate(to), [navigate]);

  const primaryCTA = useMemo<InvestorJourneyCta>(
    () =>
      ctaForState(state, currentStep, navigateMemo, {
        hasBuiltInvestorProfile: profileBuilt,
      }),
    [state, currentStep, navigateMemo, profileBuilt],
  );

  return { session, primaryCTA };
}

/**
 * Pure helper exported so tests can table-drive the label/action matrix
 * without spinning up React.
 */
export const __testing__ = {
  ctaForState,
  hasBuiltInvestorProfile,
  hasProfilePayload,
  hasProfileShell,
  INVESTOR_PROFILE_STATUS_COLUMNS,
  INVESTOR_PROFILE_STATUS_FALLBACK_COLUMNS,
  INVESTOR_PROFILE_STATUS_CORE_COLUMNS,
  isMissingProfileStatusColumnError,
  fetchInvestorProfileBuiltStatus,
  resolveHushhResearchJourneyState,
};
