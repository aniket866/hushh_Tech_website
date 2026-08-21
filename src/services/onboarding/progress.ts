import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeFinancialLinkStatus,
  resolveFinancialLinkStatus,
  type FinancialLinkStatus,
} from "./flow";
import {
  readHushhResearchCompatibilityIfActive,
  type CompatibilityRequestOptions,
  type HushhResearchOnboardingPayload,
} from "../hushhResearch/compatibility";

interface PostgrestErrorLike {
  code?: string;
  message?: string;
}

export interface OnboardingProgressRecord {
  current_step: number | null;
  is_completed: boolean;
  financial_link_status: FinancialLinkStatus;
  fund_payment_status: string | null;
  fund_investor_verification_status: string | null;
}

const isMissingFinancialLinkStatusColumn = (error: PostgrestErrorLike | null | undefined) =>
  error?.code === "PGRST204" &&
  typeof error.message === "string" &&
  error.message.includes("financial_link_status");

const isMissingFundStatusColumn = (error: PostgrestErrorLike | null | undefined) =>
  error?.code === "PGRST204" &&
  typeof error.message === "string" &&
    (error.message.includes("fund_payment_status") ||
      error.message.includes("fund_investor_verification_status"));

const TERMINAL_ONBOARDING_STEP = 13;

export function translateHushhResearchOnboardingProgress(
  payload: HushhResearchOnboardingPayload,
): OnboardingProgressRecord {
  const isCompleted = payload.status === "complete";
  const currentStep = isCompleted
    ? TERMINAL_ONBOARDING_STEP
    : Math.min(
        TERMINAL_ONBOARDING_STEP,
        Math.max(1, payload.completed_steps.length + 1),
      );

  return {
    current_step: currentStep,
    is_completed: isCompleted,
    // Plaid is outside the Research cohort. Marking this skipped preserves the
    // existing wizard contract without claiming a financial connection.
    financial_link_status: "skipped",
    // Payments and investor verification remain legacy-only and cannot be
    // inferred from Research access-state metadata.
    fund_payment_status: null,
    fund_investor_verification_status: null,
  };
}

async function readResearchOnboardingProgress(
  options: Pick<CompatibilityRequestOptions, "researchBoundary"> = {},
): Promise<
  OnboardingProgressRecord | "legacy"
> {
  const result = await readHushhResearchCompatibilityIfActive(
    "onboarding",
    options,
  );
  return result.mode === "research"
    ? translateHushhResearchOnboardingProgress(result.response.payload)
    : "legacy";
}

async function fetchLegacyOnboardingProgress(
  client: SupabaseClient,
  userId: string,
): Promise<OnboardingProgressRecord | null> {
  const primaryQuery = await client
    .from("onboarding_data")
    .select(
      "current_step, is_completed, financial_link_status, fund_payment_status, fund_investor_verification_status"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (!primaryQuery.error) {
    if (!primaryQuery.data) {
      return null;
    }

    return {
      current_step:
        typeof primaryQuery.data.current_step === "number"
          ? primaryQuery.data.current_step
          : Number(primaryQuery.data.current_step || 0) || 1,
      is_completed: Boolean(primaryQuery.data.is_completed),
      financial_link_status: normalizeFinancialLinkStatus(
        primaryQuery.data.financial_link_status
      ),
      fund_payment_status: primaryQuery.data.fund_payment_status ?? null,
      fund_investor_verification_status:
        primaryQuery.data.fund_investor_verification_status ?? null,
    };
  }

  if (
    !isMissingFinancialLinkStatusColumn(primaryQuery.error) &&
    !isMissingFundStatusColumn(primaryQuery.error)
  ) {
    throw primaryQuery.error;
  }

  // Older deployments may lack one or both of the newer columns. Fall back to
  // the smallest column set everyone has and treat the missing columns as
  // null / pending.
  const fallbackQuery = await client
    .from("onboarding_data")
    .select("current_step, is_completed")
    .eq("user_id", userId)
    .maybeSingle();

  if (fallbackQuery.error) {
    throw fallbackQuery.error;
  }

  if (!fallbackQuery.data) {
    return null;
  }

  return {
    current_step:
      typeof fallbackQuery.data.current_step === "number"
        ? fallbackQuery.data.current_step
        : Number(fallbackQuery.data.current_step || 0) || 1,
    is_completed: Boolean(fallbackQuery.data.is_completed),
    financial_link_status: "pending",
    fund_payment_status: null,
    fund_investor_verification_status: null,
  };
}

export async function fetchOnboardingProgress(
  client: SupabaseClient | undefined,
  userId: string,
  options: Pick<CompatibilityRequestOptions, "researchBoundary"> = {},
): Promise<OnboardingProgressRecord | null> {
  const researchProgress = await readResearchOnboardingProgress(options);
  if (researchProgress !== "legacy") {
    return researchProgress;
  }
  if (!client) {
    throw new Error("Supabase client is unavailable outside Research mode.");
  }
  return fetchLegacyOnboardingProgress(client, userId);
}

export async function fetchResolvedOnboardingProgress(
  client: SupabaseClient | undefined,
  userId: string,
  options: Pick<CompatibilityRequestOptions, "researchBoundary"> = {},
): Promise<OnboardingProgressRecord | null> {
  const researchProgress = await readResearchOnboardingProgress(options);
  if (researchProgress !== "legacy") {
    return researchProgress;
  }
  if (!client) {
    throw new Error("Supabase client is unavailable outside Research mode.");
  }

  const onboardingProgress = await fetchLegacyOnboardingProgress(client, userId);
  const { data: financialData, error } = await client
    .from("user_financial_data")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn(
      "[onboarding.progress] Unable to read financial-link status fallback:",
      error.message
    );
  }

  const resolvedFinancialLinkStatus = resolveFinancialLinkStatus(
    onboardingProgress?.financial_link_status,
    financialData?.status
  );

  if (onboardingProgress) {
    return {
      ...onboardingProgress,
      financial_link_status: resolvedFinancialLinkStatus,
    };
  }

  if (resolvedFinancialLinkStatus !== "pending") {
    return {
      current_step: 1,
      is_completed: false,
      financial_link_status: resolvedFinancialLinkStatus,
      fund_payment_status: null,
      fund_investor_verification_status: null,
    };
  }

  return null;
}
