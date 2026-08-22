import { getAuthenticatedSession } from "../../auth/session";
import config from "../../resources/config/config";

export interface FundPaymentRequestResponse {
  success: boolean;
  reused?: boolean;
  payment_request_id: string;
  request_reference: string;
  payment_url: string;
  expires_at: string;
  status: string;
  manual_verification_status: string;
  recurring_selected: boolean;
  risk_flags: string[];
  email_sent?: boolean;
  email_failure_reason?: string | null;
  email_delivery?: Record<string, unknown>;
}

export interface FundCouponRedeemResponse {
  success: boolean;
  already_redeemed?: boolean;
  payment_request_id?: string;
  request_reference?: string | null;
  status?: string;
  manual_verification_status?: string;
  coins_awarded?: number;
}

export interface FundCheckoutResponse {
  success: boolean;
  checkout_url?: string;
  session_id?: string;
  request_reference?: string;
  amount_label?: string;
  already_paid?: boolean;
  status?: string;
}

export interface FundTokenStatusResponse {
  success: boolean;
  status: string;
  access_granted: boolean;
  access_reversed: boolean;
  expired: boolean;
  request_reference?: string;
  expires_at?: string;
}

export interface FundPaymentStatusResponse {
  success: boolean;
  latest_request: {
    id: string;
    request_reference: string;
    selected_fund: string;
    class_a_units: number;
    class_b_units: number;
    class_c_units: number;
    commitment_amount: number;
    first_payment_amount: number;
    recurring_selected: boolean;
    recurring_amount: number | null;
    recurring_frequency: string | null;
    recurring_day_of_month: number | null;
    status: string;
    expires_at: string;
    paid_at: string | null;
    verified_at: string | null;
    rejected_at: string | null;
    risk_flags: string[];
    plaid_match_confidence: number | null;
    created_at: string;
  } | null;
  payments: Array<{
    id: string;
    amount_cents: number;
    currency: string;
    payment_kind: string;
    status: string;
    paid_at: string | null;
    failed_at: string | null;
    refunded_at: string | null;
    disputed_at: string | null;
  }>;
  reviews: Array<{
    id: string;
    status: string;
    flags: string[];
    notes: string | null;
    reviewed_at: string | null;
    created_at: string;
  }>;
}

const getFunctionsUrl = (): string => {
  if (!config.GCP_API_BASE_URL) {
    throw new Error("VITE_GCP_API_BASE_URL is not configured");
  }
  return `${config.GCP_API_BASE_URL}/functions/v1`;
};

const getAnonKey = (): string => {
  try {
    return import.meta.env?.VITE_FIREBASE_API_KEY || "";
  } catch {
    return "";
  }
};

const getUserAccessToken = async (): Promise<string> => {
  if (!config.gcpBackendClient) return getAnonKey();
  const session = await getAuthenticatedSession(config.gcpBackendClient);
  return session.access_token || getAnonKey();
};

const authedHeaders = async () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${await getUserAccessToken()}`,
});

export const createFundPaymentRequest = async (params: {
  userId: string;
  firstPaymentAmount: string | number;
}): Promise<FundPaymentRequestResponse> => {
  const res = await fetch(`${getFunctionsUrl()}/fund-payment-request-create`, {
    method: "POST",
    headers: await authedHeaders(),
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Failed to create Hushh Fund payment request");
  }
  return data as FundPaymentRequestResponse;
};

export const redeemFundCoupon = async (params: {
  userId: string;
  couponCode: string;
}): Promise<FundCouponRedeemResponse> => {
  const res = await fetch(`${getFunctionsUrl()}/fund-coupon-redeem`, {
    method: "POST",
    headers: await authedHeaders(),
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Failed to redeem coupon");
  }
  return data as FundCouponRedeemResponse;
};

export const getFundPaymentTokenStatus = async (
  token: string,
): Promise<FundTokenStatusResponse> => {
  const res = await fetch(`${getFunctionsUrl()}/fund-payment-token-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Failed to read payment token status");
  }
  return data as FundTokenStatusResponse;
};

export const createFundCheckout = async (token: string): Promise<FundCheckoutResponse> => {
  const res = await fetch(`${getFunctionsUrl()}/fund-payment-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Failed to open Stripe Checkout");
  }
  return data as FundCheckoutResponse;
};

export const getFundPaymentStatus = async (
  userId: string,
): Promise<FundPaymentStatusResponse> => {
  const res = await fetch(`${getFunctionsUrl()}/fund-payment-status`, {
    method: "POST",
    headers: await authedHeaders(),
    body: JSON.stringify({ userId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Failed to load Hushh Fund payment status");
  }
  return data as FundPaymentStatusResponse;
};
