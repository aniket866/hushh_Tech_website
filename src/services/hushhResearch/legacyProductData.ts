import type { SupabaseClient, User } from "@supabase/supabase-js";

import {
  HUSHH_RESEARCH_SOURCE,
  isHushhResearchAuthRoute,
} from "./contracts";
import { isHushhResearchAuthMode } from "./firebaseAuth";

export type HushhCoinsBalanceResult =
  | { mode: "research" }
  | { mode: "legacy"; balance: number };

export function isHushhResearchProductSession(
  user: Pick<User, "app_metadata"> | null | undefined,
): boolean {
  return (
    isHushhResearchAuthMode() ||
    user?.app_metadata?.auth_source === HUSHH_RESEARCH_SOURCE
  );
}

export function isHushhResearchProductBoundary(
  pathname: string,
  user: Pick<User, "app_metadata"> | null | undefined,
): boolean {
  return (
    isHushhResearchAuthRoute(pathname) ||
    isHushhResearchProductSession(user)
  );
}

export async function readHushhCoinsBalance(
  client: SupabaseClient,
  user: Pick<User, "id" | "app_metadata">,
): Promise<HushhCoinsBalanceResult> {
  if (isHushhResearchProductSession(user)) {
    return { mode: "research" };
  }

  const { data } = await client
    .from("ceo_meeting_payments")
    .select("hushh_coins_awarded")
    .eq("user_id", user.id)
    .maybeSingle();

  return {
    mode: "legacy",
    balance:
      typeof data?.hushh_coins_awarded === "number"
        ? data.hushh_coins_awarded
        : 0,
  };
}
