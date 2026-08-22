/**
 * Plaid Service — Clean API calls to GcpBackend Edge Functions
 * 
 * Simple, no-frills service. All sensitive operations happen server-side.
 */

import { getAuthenticatedSession } from "../../auth/session";

// =====================================================
// Types
// =====================================================

export type ProductFetchStatus = 'idle' | 'loading' | 'success' | 'unavailable' | 'error' | 'pending';

export interface ProductResult {
  available: boolean;
  data: any | null;
  error: string | null;
  reason: 'not_supported' | 'error' | null;
}

export interface FinancialDataResponse {
  status: 'complete' | 'partial' | 'failed';
  balance: ProductResult;
  assets: ProductResult;
  investments: ProductResult;
  identity: ProductResult;
  authNumbers: ProductResult;
  identityMatch: ProductResult;
  summary: {
    products_available: number;
    products_total: number;
    can_proceed: boolean;
  };
}

export interface ExchangeTokenResponse {
  item_id: string;
  institution: { name: string | null; id: string | null };
  accounts: Array<{
    account_id: string;
    name: string;
    official_name?: string | null;
    mask?: string | null;
    type?: string | null;
    subtype?: string | null;
  }>;
}

export interface PlaidDataSyncResponse {
  status: 'complete' | 'partial' | 'failed';
  item_id: string;
  institution: { id?: string | null; name?: string | null };
  available_products: Record<string, boolean>;
  products_available: number;
  fetch_errors: Record<string, { error?: string; error_code?: string | null }>;
  can_proceed: boolean;
  background_products?: string[];
  background_sync_started?: boolean;
}

export type PlaidDataProduct =
  | 'accounts'
  | 'balance'
  | 'auth'
  | 'identity'
  | 'identity_match'
  | 'investments'
  | 'investment_transactions'
  | 'liabilities'
  | 'signal'
  | 'transactions'
  | 'assets'
  | 'statements'
  | 'income';

export type PlaidProductSyncStatusValue =
  | 'pending'
  | 'syncing'
  | 'complete'
  | 'partial'
  | 'unsupported'
  | 'access_required'
  | 'failed';

export interface PlaidProductSyncStatus {
  product: PlaidDataProduct;
  status: PlaidProductSyncStatusValue;
  available: boolean;
  records_count?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
}

export interface PlaidProductSyncResponse {
  success: boolean;
  item_id: string;
  result: {
    product: PlaidDataProduct;
    status: PlaidProductSyncStatusValue;
    available: boolean;
    recordsCount?: number | null;
    error?: string | null;
    errorCode?: string | null;
  };
}

export interface LinkedTransferAccount {
  id: string;
  plaid_account_id: string;
  plaid_item_id: string;
  institution_name?: string | null;
  institution_id?: string | null;
  name?: string | null;
  official_name?: string | null;
  type?: string | null;
  subtype?: string | null;
  mask?: string | null;
  iso_currency_code?: string | null;
  available_balance?: number | null;
  current_balance?: number | null;
  status?: string | null;
}

const isAchTransferEligibleLinkedAccount = (account: LinkedTransferAccount): boolean => {
  const type = String(account.type || '').toLowerCase();
  const subtype = String(account.subtype || '').toLowerCase();
  const currency = String(account.iso_currency_code || 'USD').toUpperCase();
  return (
    type === 'depository' &&
    ['checking', 'savings', 'cash management', 'money market'].includes(subtype) &&
    currency === 'USD'
  );
};

export interface FundTransferSandboxResponse {
  success: boolean;
  sandbox_mode: boolean;
  plan: any;
  transfer: any;
  recurring_transfer: any | null;
}

export interface PlaidUnlinkResponse {
  success: boolean;
  removed_items: number;
  financial_link_status: 'pending';
}

// =====================================================
// Config
// =====================================================

const GCP_API_BASE_URL = import.meta.env.VITE_GCP_API_BASE_URL || '';
const GCP_FUNCTIONS_URL = `${GCP_API_BASE_URL}/functions/v1`;

const getAnonKey = (): string => {
  try {
    // @ts-ignore
    return import.meta.env?.VITE_FIREBASE_API_KEY || '';
  } catch { return ''; }
};

const getUserAccessToken = async (): Promise<string> => {
  try {
    const config = (await import('../../resources/config/config')).default;
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) return getAnonKey();
    const session = await getAuthenticatedSession(gcpBackend);
    return session.access_token || getAnonKey();
  } catch { return getAnonKey(); }
};

const getHeaders = (token?: string) => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token || getAnonKey()}`,
});

const getFunctionsUrl = (): string => {
  if (!GCP_API_BASE_URL) {
    throw new Error('VITE_GCP_API_BASE_URL is not configured');
  }
  return GCP_FUNCTIONS_URL;
};

// =====================================================
// API Calls
// =====================================================

/** Create a Plaid Link token (supports OAuth redirect/resume) */
export const createLinkToken = async (
  userId: string,
  userEmail?: string,
  redirectUri?: string,
  receivedRedirectUri?: string,
) => {
  console.log('[Plaid:createLinkToken] Starting...', { userId: userId?.slice(0, 8), redirectUri, hasReceivedRedirectUri: Boolean(receivedRedirectUri) });
  const token = await getUserAccessToken();
  const body: Record<string, any> = { userId, userEmail };
  if (redirectUri) body.redirectUri = redirectUri;
  if (receivedRedirectUri) body.receivedRedirectUri = receivedRedirectUri;

  console.log('[Plaid:createLinkToken] POST', `${getFunctionsUrl()}/create-link-token`);
  const res = await fetch(`${getFunctionsUrl()}/create-link-token`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify(body),
  });
  console.log('[Plaid:createLinkToken] Response status:', res.status, res.statusText);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('[Plaid:createLinkToken] ❌ FAILED:', err);
    throw new Error(err.error || 'Failed to create link token');
  }
  const result = await res.json();
  console.log('[Plaid:createLinkToken] Got link_token', { expires: result.expiration });
  return result as { link_token: string; expiration: string };
};

/** Exchange public token for access token */
export const exchangeToken = async (
  publicToken: string, userId: string,
  institutionName?: string, institutionId?: string,
  accounts?: any[],
) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/exchange-public-token`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ publicToken, userId, institutionName, institutionId, accounts }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to exchange token');
  }
  return res.json() as Promise<ExchangeTokenResponse>;
};

const unavailableProduct = (error: string | null = null): ProductResult => ({
  available: false,
  data: null,
  error,
  reason: error ? 'error' : 'not_supported',
});

export const financialDataFromSyncResult = (sync: PlaidDataSyncResponse): FinancialDataResponse => {
  const available = sync.available_products || {};
  const errors = sync.fetch_errors || {};
  const product = (key: string): ProductResult => {
    if (available[key]) {
      return { available: true, data: null, error: null, reason: null };
    }
    const error = errors[key]?.error || null;
    return unavailableProduct(error);
  };

  return {
    status: sync.status,
    balance: product('balance'),
    assets: product('assets'),
    investments: product('investments'),
    identity: product('identity'),
    authNumbers: product('auth'),
    identityMatch: unavailableProduct(),
    summary: {
      products_available: sync.products_available,
      products_total: Object.keys(available).length || 12,
      can_proceed: sync.can_proceed,
    },
  };
};

export const startPlaidDataSync = async (
  userId: string,
  itemId?: string,
): Promise<PlaidDataSyncResponse> => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/plaid-data-sync-start`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ userId, itemId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to sync Plaid data');
  }
  return res.json() as Promise<PlaidDataSyncResponse>;
};

/** Backward-compatible alias: starts the fast sync and background fanout. */
export const syncPlaidData = startPlaidDataSync;

export const getPlaidSyncStatus = async (
  userId: string,
): Promise<PlaidProductSyncStatus[]> => {
  try {
    const config = (await import('../../resources/config/config')).default;
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) return [];

    const { data, error } = await gcpBackend
      .from('plaid_product_sync_statuses')
      .select('product, status, available, records_count, error_code, error_message, completed_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      console.warn('[Plaid] Product sync status query failed:', error.message);
      return [];
    }

    return (data || []) as PlaidProductSyncStatus[];
  } catch (error) {
    console.warn('[Plaid] Product sync status unavailable:', error);
    return [];
  }
};

export const refreshPlaidProduct = async (
  userId: string,
  product: PlaidDataProduct,
  itemId?: string,
): Promise<PlaidProductSyncResponse> => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/plaid-data-sync-product`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ userId, product, itemId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Failed to sync ${product}`);
  }
  return data as PlaidProductSyncResponse;
};

export const fetchLinkedTransferAccounts = async (
  userId: string,
): Promise<LinkedTransferAccount[]> => {
  const config = (await import('../../resources/config/config')).default;
  const gcpBackend = config.gcpBackendClient;
  if (!gcpBackend) return [];

  const { data, error } = await gcpBackend
    .from('plaid_transfer_accounts')
    .select(`
      id, plaid_account_id, plaid_item_id, institution_name, institution_id,
      name, official_name, type, subtype, mask, iso_currency_code,
      available_balance, current_balance, status
    `)
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('[Plaid] Linked transfer accounts query failed:', error.message);
    return [];
  }
  return ((data || []) as LinkedTransferAccount[]).filter(isAchTransferEligibleLinkedAccount);
};

export const startFundTransferSandbox = async (params: {
  userId: string;
  accountId?: string | null;
  achAuthorized: boolean;
  sandboxAmount?: string;
  sandboxRecurringAmount?: string;
}): Promise<FundTransferSandboxResponse> => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/fund-transfer-sandbox-start`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to start sandbox transfer');
  }
  return data as FundTransferSandboxResponse;
};

export const unlinkPlaidAccount = async (
  userId: string,
  itemId?: string,
): Promise<PlaidUnlinkResponse> => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/plaid-unlink-item`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ userId, itemId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data.error ||
      data.message ||
      (res.status === 409
        ? 'Bank changes are locked after transfer setup starts'
        : 'Failed to change linked bank');
    throw new Error(message);
  }
  return data as PlaidUnlinkResponse;
};

/** Fetch redacted Auth metadata from Plaid via server-side token lookup. */
export const fetchAuthNumbers = async (userId: string, itemId?: string) => {
  try {
    const token = await getUserAccessToken();
    const res = await fetch(`${getFunctionsUrl()}/get-auth-numbers`, {
      method: 'POST',
      headers: getHeaders(token),
      body: JSON.stringify({ userId, itemId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[Plaid] Auth numbers error:', err);
      return null;
    }
    const data = await res.json();
    console.log('[Plaid] Auth numbers fetched successfully');
    return data as {
      accounts: Array<{ account_id: string; name: string; subtype: string; type: string }>;
      numbers: { ach: Array<{ account_mask: string | null; routing_mask: string | null; wire_routing_mask: string | null; account_id: string }> };
      sensitive_redacted: boolean;
    };
  } catch (e: any) {
    console.error('[Plaid] Auth numbers fetch failed:', e.message);
    return null;
  }
};

/** Check asset report status */
export const checkAssetReport = async (assetReportToken: string, userId: string) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/asset-report-create`, {
    method: 'POST', headers: getHeaders(token),
    body: JSON.stringify({ assetReportToken, userId, action: 'get' }),
  });
  if (!res.ok) throw new Error('Failed to check asset report');
  return res.json() as Promise<{ status: 'complete' | 'pending'; data?: any }>;
};

/** Save financial data to GcpBackend */
export const saveFinancialDataToSupabase = async (
  userId: string, data: FinancialDataResponse,
  institutionName?: string, institutionId?: string, itemId?: string, accessToken?: string,
) => {
  try {
    const config = (await import('../../resources/config/config')).default;
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) return;

    const errors: Record<string, string> = {};
    if (data.balance.error) errors.balance = data.balance.error;
    if (data.assets.error) errors.assets = data.assets.error;
    if (data.investments.error) errors.investments = data.investments.error;
    if (data.identity?.error) errors.identity = data.identity.error;
    if (data.authNumbers?.error) errors.auth = data.authNumbers.error;
    if (data.identityMatch?.error) errors.identity_match = data.identityMatch.error;

    await gcpBackend.from('user_financial_data').upsert({
      user_id: userId,
      plaid_item_id: itemId || null,
      plaid_access_token: null,
      institution_name: institutionName || null,
      institution_id: institutionId || null,
      balances: data.balance.available ? data.balance.data : null,
      asset_report: data.assets.available ? data.assets.data : null,
      asset_report_token: data.assets.data?.asset_report_token || null,
      investments: data.investments.available ? data.investments.data : null,
      identity_data: data.identity?.available ? data.identity.data : null,
      auth_numbers: data.authNumbers?.available ? data.authNumbers.data : null,
      identity_match: data.identityMatch?.available ? data.identityMatch.data : null,
      available_products: {
        balance: data.balance.available,
        assets: data.assets.available,
        investments: data.investments.available,
        identity: data.identity?.available || false,
        auth: data.authNumbers?.available || false,
        identity_match: data.identityMatch?.available || false,
      },
      status: data.status,
      fetch_errors: Object.keys(errors).length > 0 ? errors : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    console.log('[Plaid] ✅ Data saved to GcpBackend');
  } catch (err) {
    console.warn('[Plaid] Save failed:', err);
  }
};

// =====================================================
// Utilities
// =====================================================

export const formatCurrency = (amount: number | null | undefined, currency = 'USD'): string => {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(amount);
};

export const getHeaderTitle = (count: number): string => {
  if (count === 3) return '✨ Complete Financial Profile';
  if (count === 2) return '📊 Financial Profile Verified';
  if (count === 1) return '💰 Account Verified';
  return '⚠️ Unable to Verify';
};

export const getProductStatus = (product: ProductResult): ProductFetchStatus => {
  if (product.available) return product.data?.status === 'pending' ? 'pending' : 'success';
  if (product.reason === 'not_supported') return 'unavailable';
  if (product.error) return 'error';
  if (product.data?.status === 'pending') return 'pending';
  return 'idle';
};

// =====================================================
// Signal — ACH Transaction Risk Assessment
// =====================================================

/** Evaluate ACH transaction return risk */
export const signalEvaluate = async (params: {
  accessToken: string;
  accountId: string;
  clientTransactionId: string;
  amount: number;
  clientUserId?: string;
  isRecurring?: boolean;
  defaultPaymentMethod?: 'SAME_DAY_ACH' | 'STANDARD_ACH' | 'MULTIPLE_PAYMENT_METHODS';
  rulesetKey?: string;
  user?: { name?: { given_name?: string; family_name?: string }; phone_number?: string; email_address?: string; address?: any };
  device?: { ip_address?: string; user_agent?: string };
}) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/signal-evaluate`, {
    method: 'POST', headers: getHeaders(token),
    body: JSON.stringify({
      accessToken: params.accessToken,
      account_id: params.accountId,
      client_transaction_id: params.clientTransactionId,
      amount: params.amount,
      client_user_id: params.clientUserId,
      is_recurring: params.isRecurring,
      default_payment_method: params.defaultPaymentMethod,
      ruleset_key: params.rulesetKey,
      user: params.user,
      device: params.device,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Signal evaluate failed');
  }
  return res.json() as Promise<{
    scores: {
      customer_initiated_return_risk: { score: number; risk_tier: number };
      bank_initiated_return_risk: { score: number; risk_tier: number };
    };
    core_attributes: Record<string, any>;
    ruleset?: { ruleset_key: string; result: 'ACCEPT' | 'REROUTE' | 'REVIEW'; triggered_rule_details?: any };
    warnings: any[];
    request_id: string;
  }>;
};

/** Report whether you initiated an ACH transaction */
export const signalDecisionReport = async (params: {
  clientTransactionId: string;
  initiated: boolean;
  decisionOutcome?: 'APPROVE' | 'REVIEW' | 'REJECT' | 'TAKE_OTHER_RISK_MEASURES' | 'NOT_EVALUATED';
  paymentMethod?: 'SAME_DAY_ACH' | 'STANDARD_ACH' | 'MULTIPLE_PAYMENT_METHODS';
  daysFundsOnHold?: number;
  amountInstantlyAvailable?: number;
}) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/signal-decision-report`, {
    method: 'POST', headers: getHeaders(token),
    body: JSON.stringify({
      client_transaction_id: params.clientTransactionId,
      initiated: params.initiated,
      decision_outcome: params.decisionOutcome,
      payment_method: params.paymentMethod,
      days_funds_on_hold: params.daysFundsOnHold,
      amount_instantly_available: params.amountInstantlyAvailable,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Signal decision report failed');
  }
  return res.json() as Promise<{ request_id: string }>;
};

/** Report a return for an ACH transaction */
export const signalReturnReport = async (params: {
  clientTransactionId: string;
  returnCode: string;
  returnedAt?: string;
}) => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/signal-return-report`, {
    method: 'POST', headers: getHeaders(token),
    body: JSON.stringify({
      client_transaction_id: params.clientTransactionId,
      return_code: params.returnCode,
      returned_at: params.returnedAt,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Signal return report failed');
  }
  return res.json() as Promise<{ request_id: string }>;
};

// =====================================================
// Sandbox Testing — Bypass Plaid Link UI
// =====================================================

export interface SandboxTestResult {
  success: boolean;
  item_id: string;
  institution: { name: string; id: string };
  products: {
    balance: { available: boolean; accounts: number; error: string | null };
    investments: { available: boolean; holdings: number; error: string | null };
    assets: { available: boolean; token: string | null; error: string | null };
  };
  summary: {
    products_available: number;
    products_total: number;
    status: string;
    saved_to_db: boolean;
  };
}

/**
 * Create a sandbox test Item (bypasses Plaid Link UI).
 * Uses /sandbox/public_token/create → exchange → fetch all → save.
 * SANDBOX ONLY.
 */
export const createSandboxTestItem = async (
  userId: string,
  institutionId = 'ins_109508',
): Promise<SandboxTestResult> => {
  const token = await getUserAccessToken();
  const res = await fetch(`${getFunctionsUrl()}/sandbox-create-test-item`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ userId, institutionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Sandbox test item creation failed');
  }
  return res.json() as Promise<SandboxTestResult>;
};
