/**
 * Client service to call the same-origin Cloud Run API for investor profile generation.
 */

import { InvestorProfileInput, DerivedContext, InvestorProfile } from "../../types/investorProfile";
import { enrichContext, enrichWithPlaidData } from "./enrichContext";
import resources from "../../resources/resources";
import { getAuthenticatedSession } from "../../auth/session";
import { getSafeInvestorProfileErrorMessage } from "./errorMessages";

export interface GenerateProfileResponse {
  success: boolean;
  profile: InvestorProfile;
  error?: string;
}

/**
 * Calls the GCP Cloud Run API to generate an investor profile with server-side Gemini.
 */
export async function generateInvestorProfile(
  input: InvestorProfileInput
): Promise<GenerateProfileResponse> {
  try {
    const gcpBackend = resources.config.gcpBackendClient;
    
    if (!gcpBackend) {
      throw new Error("GcpBackend client not initialized");
    }

    // 1. Get authenticated user session for Authorization header
    const session = await getAuthenticatedSession(
      gcpBackend,
      "User not logged in. Please sign in to generate investor profile."
    );

    // 2. Enrich the context from the input
    const context: Record<string, any> = await enrichContext(input);

    // 2b. Enrich with Plaid financial data (non-blocking — skips if no Plaid link)
    const plaidData = await enrichWithPlaidData(session.user.id);
    if (plaidData) {
      context.financial_context = plaidData;
    }

    // 3. Call the same-origin GCP API route. The browser never receives the AI key.
    const gcpApiBaseUrl = (import.meta as any).env.VITE_GCP_API_BASE_URL;
    const response = await fetch("/api/generate-investor-profile", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        input,
        context,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMessage = getSafeInvestorProfileErrorMessage(
        data.error || `Investor profile service failed with status ${response.status}`,
        response.status
      );
      throw new Error(errorMessage);
    }

    if (!data.success || !data.profile) {
      throw new Error('Invalid response from investor profile service');
    }

    // 5. Fire NWS score email notification (non-blocking) if Plaid data was used
    if (plaidData) {
      const nwsPayload = {
        user_email: input.email,
        user_name: input.name,
        nws_score: plaidData.nws_score,
        nws_tier: plaidData.nws_tier,
        total_cash_balance: plaidData.total_cash_balance,
        total_investment_value: plaidData.total_investment_value,
        num_accounts: plaidData.num_accounts,
        account_types: plaidData.account_types,
        primary_institution: plaidData.primary_institution,
        address_city: plaidData.address_city,
        address_state: plaidData.address_state,
        identity_verification_score: plaidData.identity_verification_score,
      };

      // Fire-and-forget — don't block profile creation
      fetch(`${gcpApiBaseUrl}/functions/v1/nws-score-notification`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(nwsPayload),
      }).catch((err) => console.warn("NWS email notification failed (non-blocking):", err));

      // Also save NWS score to onboarding_data (fire-and-forget)
      gcpBackend
        .from("onboarding_data")
        .update({ nws_score: plaidData.nws_score })
        .eq("user_id", session.user.id)
        .then(
          () => {},
          (err: any) => console.warn("NWS score save failed:", err)
        );
    }

    return {
      success: true,
      profile: data.profile,
    };
  } catch (error) {
    console.error('Error generating investor profile:', error);
    return {
      success: false,
      profile: {} as InvestorProfile,
      error: getSafeInvestorProfileErrorMessage(error),
    };
  }
}
