/**
 * Client wrapper for the onboarding party-invite edge functions.
 * Authed calls (create/resend/revoke) carry the primary investor's JWT; token-only
 * calls (load/save/complete) are unauthenticated and authorize by token hash.
 * Mirrors src/services/fundPayment/fundPaymentService.ts.
 */
import { getAuthenticatedSession } from '../../auth/session';
import config from '../../resources/config/config';
import type { PartyFieldDef } from './partyRequirements';
import type { ProofOfFundsStatus } from './proofOfFunds';
import type { FundingNameMatchStatus } from './fundingNameMatch';

const getFunctionsUrl = (): string => {
  if (!config.GCP_API_BASE_URL) throw new Error('VITE_GCP_API_BASE_URL is not configured');
  return `${config.GCP_API_BASE_URL}/functions/v1`;
};

const getAnonKey = (): string => {
  try {
    return import.meta.env?.VITE_FIREBASE_API_KEY || '';
  } catch {
    return '';
  }
};

const getUserAccessToken = async (): Promise<string> => {
  if (!config.gcpBackendClient) return getAnonKey();
  const session = await getAuthenticatedSession(config.gcpBackendClient);
  return session.access_token || getAnonKey();
};

const authedHeaders = async () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${await getUserAccessToken()}`,
});

const tokenHeaders = { 'Content-Type': 'application/json' };

const postJson = async <T>(path: string, headers: HeadersInit, body: unknown): Promise<T> => {
  const res = await fetch(`${getFunctionsUrl()}/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error || `Request to ${path} failed`);
    (err as { details?: unknown }).details = data;
    throw err;
  }
  return data as T;
};

export type InviteState = 'active' | 'expired' | 'revoked' | 'completed';

export interface CreateInviteResult {
  success: boolean;
  party_id: string;
  invite_id: string;
  invite_reference: string;
  invite_url: string;
  expires_at: string;
  state: InviteState;
  email_sent: boolean;
}

export interface LoadInviteResult {
  success: boolean;
  state: InviteState;
  role: string;
  role_label: string;
  primary_name: string;
  fields: PartyFieldDef[];
  profile: Record<string, string>;
  /** Whether the invited party has already connected their own bank via Plaid. */
  bank_connected: boolean;
  expires_at: string;
}

export const createInvite = (params: { role: string; email: string; displayName?: string }) =>
  authedHeaders().then((headers) =>
    postJson<CreateInviteResult>('onboarding-invite-create', headers, params),
  );

export const loadInvite = (token: string) =>
  postJson<LoadInviteResult>('onboarding-invite-load', tokenHeaders, { token });

export const saveInviteSection = (token: string, profile: Record<string, string>) =>
  postJson<{ success: boolean }>('onboarding-invite-save', tokenHeaders, { token, profile });

export const completeInvite = (token: string, profile: Record<string, string>) =>
  postJson<{ success: boolean }>('onboarding-invite-complete', tokenHeaders, { token, profile });

/**
 * Mint a Plaid Link token for the invited party to connect their OWN bank.
 * Pass `redirectUri` for OAuth banks (must be registered in the Plaid dashboard).
 */
export const createInviteLinkToken = (token: string, redirectUri?: string) =>
  postJson<{ success: boolean; link_token: string; expiration: string }>(
    'onboarding-invite-link-token',
    tokenHeaders,
    { token, ...(redirectUri ? { redirect_uri: redirectUri } : {}) },
  );

export interface ExchangeInvitePlaidPayload {
  publicToken: string;
  institutionName?: string | null;
  institutionId?: string | null;
}

/** Exchange the invited party's Plaid public token and link the bank to the party. */
export const exchangeInvitePlaid = (token: string, payload: ExchangeInvitePlaidPayload) =>
  postJson<{ success: boolean; item_id: string; accounts: unknown[] }>(
    'onboarding-invite-plaid-exchange',
    tokenHeaders,
    { token, ...payload },
  );

export const resendInvite = async (inviteId: string) =>
  postJson<{ success: boolean; invite_url: string; expires_at: string; email_sent: boolean }>(
    'onboarding-invite-resend',
    await authedHeaders(),
    { invite_id: inviteId },
  );

export const revokeInvite = async (inviteId: string) =>
  postJson<{ success: boolean }>('onboarding-invite-revoke', await authedHeaders(), {
    invite_id: inviteId,
  });

/** Submit the application for compliance review (server re-validates the gate). */
export const submitApplication = async () =>
  postJson<{ success: boolean; application_status: string; submitted_at: string }>(
    'onboarding-submit-application',
    await authedHeaders(),
    {},
  );

/** Funding-readiness (proof-of-funds) status, where bank balance is available. */
export const getProofOfFunds = async () =>
  postJson<{
    success: boolean;
    status: ProofOfFundsStatus;
    balance_available: boolean;
    investment_selected: boolean;
  }>('onboarding-proof-of-funds', await authedHeaders(), {});

/**
 * Funding account-holder name match (trust/retirement). Computes + persists whether
 * the connected bank holder name matches the entity/custodian legal name, flagging
 * manual review on a mismatch. `applicable` is false for individual/joint.
 */
export const getFundingNameMatch = async () =>
  postJson<{
    success: boolean;
    applicable: boolean;
    status: FundingNameMatchStatus;
    holder_name_available?: boolean;
  }>('onboarding-funding-name-match', await authedHeaders(), {});
