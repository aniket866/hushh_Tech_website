/**
 * usePlaidLink — Plaid Link hook with OAuth + State Persistence
 * 
 * Flow: Create token → Open Link → Exchange → Fetch data
 * OAuth: Detects oauth_state_id in URL → resumes session automatically
 * Persistence: Saves completed state to sessionStorage → survives page reloads
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { usePlaidLink as usePlaidLinkSDK, PlaidLinkOnSuccess, PlaidLinkOnExit, PlaidLinkOnEvent } from 'react-plaid-link';
import {
  createLinkToken,
  exchangeToken,
  checkAssetReport,
  financialDataFromSyncResult,
  getProductStatus,
  startPlaidDataSync,
  type FinancialDataResponse,
  type ProductFetchStatus,
} from './plaidService';
import {
  resolvePlaidRedirectUri,
  shouldUsePlaidRedirectUri,
} from './redirect';
import { endPlaidSession, logPlaidEvent } from './plaidDiagnostics';
import { trackFinancialLink } from '../onboarding/onboardingAnalytics';

// =====================================================
// Types
// =====================================================

export interface PlaidLinkState {
  step: 'idle' | 'creating_token' | 'ready' | 'linking' | 'exchanging' | 'fetching' | 'done' | 'error';
  linkToken: string | null;
  error: string | null;
  plaidItemId: string | null;
  institution: { name: string; id: string } | null;
  balanceStatus: ProductFetchStatus;
  assetsStatus: ProductFetchStatus;
  investmentsStatus: ProductFetchStatus;
  financialData: FinancialDataResponse | null;
  canProceed: boolean;
  productsAvailable: number;
}

export interface UsePlaidLinkReturn extends PlaidLinkState {
  openPlaidLink: () => void;
  retry: () => void;
  refreshFromDatabase: () => Promise<PlaidLinkState | null>;
  isDatabaseRestoreComplete: boolean;
  isReady: boolean;
  open: () => void;
}

export interface UsePlaidLinkOptions {
  skipAutoInit?: boolean;
}

// =====================================================
// Session Storage Persistence
// =====================================================

const STORAGE_KEY = 'plaid_link_state';
const OAUTH_RESUME_KEY_PREFIX = 'plaid_oauth_resume:';

interface PersistedState {
  linkToken: string | null;
  expiration: string | null;
  step: PlaidLinkState['step'];
  plaidItemId: string | null;
  institution: PlaidLinkState['institution'];
  financialData: FinancialDataResponse | null;
  canProceed: boolean;
  productsAvailable: number;
  balanceStatus: ProductFetchStatus;
  assetsStatus: ProductFetchStatus;
  investmentsStatus: ProductFetchStatus;
  savedAt: number;
}

interface OAuthResumeState {
  linkToken: string;
  expiration: string | null;
  redirectUri: string;
  savedAt: number;
}

/** Save current state to sessionStorage */
const persistState = (state: PlaidLinkState, expiration?: string | null) => {
  try {
    const persisted: PersistedState = {
      linkToken: state.step === 'done' ? state.linkToken : null,
      expiration: expiration || null,
      step: state.step,
      plaidItemId: state.plaidItemId,
      institution: state.institution,
      financialData: state.financialData,
      canProceed: state.canProceed,
      productsAvailable: state.productsAvailable,
      balanceStatus: state.balanceStatus,
      assetsStatus: state.assetsStatus,
      investmentsStatus: state.investmentsStatus,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // sessionStorage not available — silently ignore
  }
};

/** Load persisted state from sessionStorage */
const loadPersistedState = (): PersistedState | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedState;
  } catch {
    return null;
  }
};

/** Clear persisted state */
const clearPersistedState = () => {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // silent
  }
};

const oauthResumeKey = (userId: string) => `${OAUTH_RESUME_KEY_PREFIX}${userId}`;

const isTokenExpired = (expiration: string | null | undefined) => {
  if (!expiration) return false;
  const expiresAt = Date.parse(expiration);
  if (Number.isNaN(expiresAt)) return false;
  return Date.now() > expiresAt - 60_000;
};

const saveOAuthResumeState = (
  userId: string,
  linkToken: string,
  expiration: string | null,
  redirectUri: string,
) => {
  try {
    const payload: OAuthResumeState = {
      linkToken,
      expiration,
      redirectUri,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(oauthResumeKey(userId), JSON.stringify(payload));
  } catch {
    // sessionStorage not available — the user can restart Link if OAuth returns.
  }
};

const loadOAuthResumeState = (userId: string): OAuthResumeState | null => {
  try {
    const raw = sessionStorage.getItem(oauthResumeKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OAuthResumeState;
    if (!parsed.linkToken || isTokenExpired(parsed.expiration)) {
      sessionStorage.removeItem(oauthResumeKey(userId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const clearOAuthResumeState = (userId: string) => {
  try {
    sessionStorage.removeItem(oauthResumeKey(userId));
  } catch {
    // silent
  }
};

const hasDisplayableFinancialData = (
  financialData: FinancialDataResponse | null
) => Boolean(
  financialData?.balance?.data ||
  financialData?.assets?.data ||
  financialData?.investments?.data ||
  financialData?.identity?.data
);

// =====================================================
// Database Restore — Most Stable
// =====================================================

/** Load completed financial data from GcpBackend database */
const loadFromDatabase = async (userId: string): Promise<PlaidLinkState | null> => {
  try {
    const config = (await import('../../resources/config/config')).default;
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) {
      console.warn('[Plaid] Database restore skipped: GcpBackend client not available');
      return null;
    }

    const { data, error } = await gcpBackend
      .from('user_financial_data')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.warn('[Plaid] Database restore query error (ignoring):', error.message);
      return null;
    }

    if (!data) {
      console.log('[Plaid] No financial data found in database');
      return null;
    }

    // Reconstruct state from database
    if (data.status === 'complete' || data.status === 'partial') {
      console.log('[Plaid] 🔄 Restoring from database:', {
        status: data.status,
        institution: data.institution_name,
        products: data.available_products,
      });

      const available = data.available_products || {};
      const productsAvailable = Object.values(available).filter(Boolean).length;
      const canProceed = Boolean(available.accounts && available.balance && available.auth);
      const assetReportStatus = data.asset_report_status;

      return {
        step: 'done',
        linkToken: null,
        error: null,
        plaidItemId: data.plaid_item_id || null,
        institution: data.institution_name && data.institution_id
          ? { name: data.institution_name, id: data.institution_id }
          : null,
        balanceStatus: available.balance ? 'success' : (data.fetch_errors?.balance ? 'error' : 'unavailable'),
        assetsStatus: available.assets
          ? 'success'
          : assetReportStatus === 'pending'
            ? 'pending'
            : (data.fetch_errors?.assets ? 'error' : 'unavailable'),
        investmentsStatus: available.investments ? 'success' : (data.fetch_errors?.investments ? 'error' : 'unavailable'),
        financialData: {
          status: data.status,
          balance: {
            available: available.balance || false,
            data: data.balances || null,
            error: data.fetch_errors?.balance || null,
            reason: data.fetch_errors?.balance ? 'error' as const : null,
          },
          assets: {
            available: available.assets || false,
            data: data.asset_report || null,
            error: data.fetch_errors?.assets || null,
            reason: data.fetch_errors?.assets ? 'error' as const : null,
          },
          investments: {
            available: available.investments || false,
            data: data.investments || null,
            error: data.fetch_errors?.investments || null,
            reason: data.fetch_errors?.investments ? 'error' as const : null,
          },
          identity: {
            available: available.identity || false,
            data: data.identity_data || null,
            error: data.fetch_errors?.identity || null,
            reason: data.fetch_errors?.identity ? 'error' as const : null,
          },
          authNumbers: {
            available: available.auth || false,
            data: data.auth_numbers || null,
            error: data.fetch_errors?.auth || null,
            reason: data.fetch_errors?.auth ? 'error' as const : null,
          },
          identityMatch: {
            available: available.identity_match || false,
            data: data.identity_match || null,
            error: data.fetch_errors?.identity_match || null,
            reason: data.fetch_errors?.identity_match ? 'error' as const : null,
          },
          summary: {
            products_available: productsAvailable,
            products_total: 13,
            can_proceed: canProceed,
          },
        },
        canProceed,
        productsAvailable,
      };
    }

    return null;
  } catch (err) {
    console.warn('[Plaid] Database restore failed:', err);
    return null;
  }
};

// =====================================================
// Hook
// =====================================================

export const usePlaidLinkHook = (
  userId: string,
  userEmail?: string,
  options: UsePlaidLinkOptions = {}
): UsePlaidLinkReturn => {
  // Try to restore state from sessionStorage on first render
  const cached = useRef(loadPersistedState());
  const expirationRef = useRef<string | null>(cached.current?.expiration || null);

  const getInitialState = (): PlaidLinkState => {
    const c = cached.current;
    if (!c) return defaultState();

    // If we have completed data, restore it immediately
    if (c.step === 'done' && hasDisplayableFinancialData(c.financialData)) {
      console.log('[Plaid] 🔄 Restoring completed state from sessionStorage');
      return {
        step: 'done',
        linkToken: c.linkToken,
        error: null,
        plaidItemId: c.plaidItemId || null,
        institution: c.institution,
        balanceStatus: c.balanceStatus,
        assetsStatus: c.assetsStatus,
        investmentsStatus: c.investmentsStatus,
        financialData: c.financialData,
        canProceed: c.canProceed,
        productsAvailable: c.productsAvailable,
      };
    }

    // Link tokens are cheap and can carry half-failed Link state after retries,
    // so only completed data is restored. Normal reloads create a fresh token.
    return defaultState();
  };

  const [state, setState] = useState<PlaidLinkState>(getInitialState);
  const [dbRestoreComplete, setDbRestoreComplete] = useState(false);
  const dbRestoreAttempted = useRef(false);

  const assetPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initializedRef = useRef(false);
  const isOAuthResumeRef = useRef(false);

  // Persist state on every change
  useEffect(() => {
    persistState(state, expirationRef.current);
  }, [state]);

  // Detect OAuth redirect: URL has ?oauth_state_id=...
  const getOAuthState = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('oauth_state_id');
  }, []);

  // Get the redirect URI (current page without query params)
  const getRedirectUri = useCallback(() => {
    return resolvePlaidRedirectUri(
      import.meta.env?.VITE_PLAID_REDIRECT_URI,
      window.location.origin,
      window.location.pathname
    );
  }, []);

  // Step 1: Create link token (with OAuth support)
  const initToken = useCallback(async () => {
    if (!userId) return;
    setState(s => ({ ...s, step: 'creating_token', error: null }));

    try {
      const oauthStateId = getOAuthState();
      const redirectUri = getRedirectUri();

      if (oauthStateId) {
        // OAuth RESUME — Plaid requires the same link_token from the initial session.
        const receivedRedirectUri = window.location.href;
        console.log('[Plaid] 🔄 OAuth resume detected:', { oauthStateId, receivedRedirectUri });
        isOAuthResumeRef.current = true;

        const resumeState = loadOAuthResumeState(userId);
        if (!resumeState) {
          console.warn('[Plaid] OAuth resume token missing or expired; restarting is required');
          logPlaidEvent('oauth_resume_session_missing', {
            plaidStep: 'error',
            userId,
            errorDetails: { oauthStateId },
          });
          setState(s => ({
            ...s,
            step: 'error',
            linkToken: null,
            error: 'Bank verification session expired. Please start bank connection again.',
          }));
          return;
        }

        logPlaidEvent('oauth_resume_recovered', {
          plaidStep: 'ready',
          userId,
          plaidMetadata: { oauthStateId },
        });
        expirationRef.current = resumeState.expiration;
        setState(s => ({ ...s, step: 'ready', linkToken: resumeState.linkToken }));
      } else {
        // Normal flow — include redirect_uri for OAuth banks
        const canUseRedirectUri = shouldUsePlaidRedirectUri(redirectUri);

        if (!canUseRedirectUri) {
          // Plaid requires HTTPS redirect_uri. Skip on local HTTP so non-OAuth institutions still work.
          console.warn('[Plaid] Skipping redirect_uri because it is not HTTPS:', redirectUri);
        }

        console.log('[Plaid] Creating link token with redirect_uri:', canUseRedirectUri ? redirectUri : 'none');
        const result = await createLinkToken(
          userId,
          userEmail,
          canUseRedirectUri ? redirectUri : undefined,
        );
        expirationRef.current = result.expiration;
        if (canUseRedirectUri) {
          saveOAuthResumeState(userId, result.link_token, result.expiration, redirectUri);
        }
        setState(s => ({ ...s, step: 'ready', linkToken: result.link_token }));
      }
    } catch (err: any) {
      console.error('[Plaid] ❌ Token creation failed:', err);
      logPlaidEvent('create_link_token_failed', {
        plaidStep: 'error',
        userId,
        errorDetails: {
          message: err?.message || 'Failed to initialize',
          stack: err?.stack ? String(err.stack).slice(0, 2048) : null,
        },
      });
      setState(s => ({ ...s, step: 'error', error: err.message || 'Failed to initialize' }));
    }
  }, [userId, userEmail, getOAuthState, getRedirectUri]);

  const refreshFromDatabase = useCallback(async () => {
    if (!userId) return null;
    const dbState = await loadFromDatabase(userId);
    if (dbState) {
      setState(s => ({
        ...s,
        ...dbState,
        step: 'done',
        linkToken: null,
        error: null,
      }));
      console.log('[Plaid] ✅ Refreshed financial data from database');
    }
    return dbState;
  }, [userId]);

  // Database restore — try once on mount before anything else
  useEffect(() => {
    if (!userId || dbRestoreAttempted.current) return;
    dbRestoreAttempted.current = true;

    const hadCompletedSessionState = state.step === 'done' && hasDisplayableFinancialData(state.financialData);
    if (hadCompletedSessionState) {
      console.log('[Plaid] ✅ SessionStorage completed state restored; refreshing database truth');
    }

    // Try to restore from database with timeout
    const timeoutId = setTimeout(() => {
      console.warn('[Plaid] Database restore timeout after 5s, proceeding anyway');
      setDbRestoreComplete(true);
    }, 5000);

    (async () => {
      try {
        const dbState = await loadFromDatabase(userId);
        if (dbState) {
          setState(dbState);
          console.log('[Plaid] ✅ Restored from database');
        } else if (hadCompletedSessionState) {
          console.warn('[Plaid] SessionStorage completed state had no database match; resetting Plaid state');
          clearPersistedState();
          setState(defaultState());
        }
      } catch (err) {
        console.error('[Plaid] Database restore error:', err);
      } finally {
        clearTimeout(timeoutId);
        setDbRestoreComplete(true);
      }
    })();
  }, [userId, state.step, state.financialData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-init — only if we don't already have a valid state
  // IMPORTANT: Wait for DB restore to complete first
  useEffect(() => {
    if (!userId || initializedRef.current) return;

    // Wait for DB restore to complete before initializing
    if (!dbRestoreComplete) return;

    if (options.skipAutoInit) {
      console.log('[Plaid] Local sandbox direct connect enabled; skipping Link token auto-init');
      initializedRef.current = true;
      return;
    }

    initializedRef.current = true;

    const oauthStateId = getOAuthState();

    // If OAuth resume → always create new token (required by Plaid)
    if (oauthStateId) {
      initToken();
      return;
    }

    // If we restored a completed state → no need to init
    if (state.step === 'done' && state.financialData) {
      console.log('[Plaid] ✅ Already completed — skipping token creation');
      return;
    }

    // No completed state → create a fresh token
    initToken();
  }, [
    userId,
    initToken,
    getOAuthState,
    state.step,
    state.financialData,
    dbRestoreComplete,
    options.skipAutoInit,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 2: Handle Plaid Link success
  const handleSuccess: PlaidLinkOnSuccess = useCallback(async (publicToken, metadata) => {
    console.log('[Plaid] ✅ onSuccess', { institution: metadata?.institution?.name });

    const inst = {
      name: metadata.institution?.name || 'Unknown',
      id: metadata.institution?.institution_id || '',
    };

    logPlaidEvent('plaid_link_success', {
      plaidStep: 'exchanging',
      userId,
      plaidMetadata: {
        institutionName: inst.name,
        institutionId: inst.id,
        accountsCount: metadata.accounts?.length ?? 0,
      },
    });

    setState(s => ({
      ...s, step: 'exchanging', institution: inst,
      balanceStatus: 'loading', assetsStatus: 'loading', investmentsStatus: 'loading',
    }));

    try {
      // Exchange token
      console.log('[Plaid] Exchanging token...');
      const exchange = await exchangeToken(publicToken, userId, inst.name, inst.id, metadata.accounts);
      console.log('[Plaid] ✅ Exchange done:', { item_id: exchange.item_id });
      trackFinancialLink('completed');
      logPlaidEvent('exchange_token_succeeded', {
        plaidStep: 'fetching',
        userId,
        plaidMetadata: { itemId: exchange.item_id, institutionId: inst.id },
      });
      clearOAuthResumeState(userId);

      setState(s => ({ ...s, step: 'fetching' }));

      // Sync financial data server-side. Browser never receives Plaid access_token.
      console.log('[Plaid] Syncing financial data server-side...');
      const syncResult = await startPlaidDataSync(userId, exchange.item_id);
      const dbState = await loadFromDatabase(userId);
      if (dbState?.financialData) {
        console.log('[Plaid] ✅ Loaded synced financial data from database');
        setState(s => ({
          ...s,
          ...dbState,
          step: 'done',
          linkToken: null,
          error: null,
          plaidItemId: dbState.plaidItemId,
          institution: dbState.institution || inst,
        }));
        return;
      }

      const result = financialDataFromSyncResult(syncResult);
      console.log('[Plaid] ✅ Result:', {
        status: result.status,
        balance: result.balance.available,
        assets: result.assets.available,
        investments: result.investments.available,
      });

      setState(s => ({
        ...s, step: 'done', financialData: result,
        plaidItemId: syncResult.item_id || exchange.item_id,
        balanceStatus: getProductStatus(result.balance),
        assetsStatus: getProductStatus(result.assets),
        investmentsStatus: getProductStatus(result.investments),
        canProceed: result.summary.can_proceed,
        productsAvailable: result.summary.products_available,
      }));

      logPlaidEvent('plaid_link_done', {
        plaidStep: 'done',
        userId,
        plaidMetadata: {
          itemId: syncResult.item_id || exchange.item_id,
          institutionId: inst.id,
          canProceed: result.summary.can_proceed,
          productsAvailable: result.summary.products_available,
        },
      });
      endPlaidSession();

      // Poll assets if pending
      if (getProductStatus(result.assets) === 'pending' && result.assets.data?.asset_report_token) {
        pollAssets(result.assets.data.asset_report_token);
      }
    } catch (err: any) {
      console.error('[Plaid] ❌ Error:', err);
      logPlaidEvent('exchange_or_sync_failed', {
        plaidStep: 'error',
        userId,
        errorDetails: {
          message: err?.message || 'Failed to connect',
          stack: err?.stack ? String(err.stack).slice(0, 2048) : null,
        },
      });
      setState(s => ({
        ...s, step: 'error', error: err.message || 'Failed to connect',
        balanceStatus: 'error', assetsStatus: 'error', investmentsStatus: 'error',
      }));
    }
  }, [userId]);

  // Handle exit
  const handleExit: PlaidLinkOnExit = useCallback((err, metadata) => {
    console.log('[Plaid] 🚪 onExit', { error: err, status: metadata?.status });
    logPlaidEvent('plaid_link_exit', {
      userId,
      plaidMetadata: {
        exitStatus: metadata?.status || null,
        institutionName: metadata?.institution?.name || null,
        requestId: metadata?.request_id || null,
      },
      errorDetails: err
        ? {
            errorCode: err.error_code || null,
            errorType: err.error_type || null,
            errorMessage: err.error_message || null,
            displayMessage: err.display_message || null,
          }
        : {},
    });
    if (err) {
      trackFinancialLink('failed', { errorCategory: err.error_code || err.error_type || 'exit_error' });
      clearOAuthResumeState(userId);
      setState(s => ({
        ...s, step: 'error',
        error: `Connection interrupted: ${err.display_message || err.error_message || 'Unknown error'}`,
      }));
    } else {
      // User closed Plaid Link without an error (cancelled). openPlaidLink set
      // step='linking' before opening, so without this reset the primary button
      // stays stuck on "Connecting..." (isReady=false, since isReady requires
      // step==='ready') and only a full page refresh recovers. Return to 'ready'
      // so the existing link_token can be re-opened on the next click.
      setState(s => (s.step === 'linking' ? { ...s, step: 'ready' } : s));
    }
  }, [userId]);

  // Log events
  const handleEvent: PlaidLinkOnEvent = useCallback((eventName, metadata) => {
    console.log(`[Plaid] 📡 ${eventName}`, metadata);
    // Mirror the SDK event stream so we can replay user attempts. Skip the
    // noisy heartbeat events; only ship view transitions + errors.
    const interesting =
      typeof eventName === 'string' &&
      (eventName.includes('ERROR') ||
        eventName.includes('SUBMIT') ||
        eventName.includes('OPEN') ||
        eventName.includes('TRANSITION_VIEW') ||
        eventName.includes('EXIT') ||
        eventName.includes('SELECT_INSTITUTION') ||
        eventName.includes('HANDOFF'));
    if (!interesting) return;
    logPlaidEvent('plaid_sdk_event', {
      plaidMetadata: {
        eventName: String(eventName),
        viewName: metadata?.view_name || null,
        errorCode: metadata?.error_code || null,
        errorMessage: metadata?.error_message || null,
        institutionName: metadata?.institution_name || null,
        requestId: metadata?.request_id || null,
      },
    });
  }, []);

  // Asset polling
  const pollAssets = useCallback((token: string) => {
    if (assetPollRef.current) clearInterval(assetPollRef.current);
    let attempts = 0;

    assetPollRef.current = setInterval(async () => {
      if (++attempts > 10) { clearInterval(assetPollRef.current!); return; }
      try {
        const result = await checkAssetReport(token, userId);
        if (result.status === 'complete') {
          clearInterval(assetPollRef.current!);
          setState(s => ({
            ...s, assetsStatus: 'success',
            productsAvailable: (s.productsAvailable || 0) + 1,
            financialData: s.financialData ? {
              ...s.financialData,
              assets: { available: true, data: result.data, error: null, reason: null },
            } : s.financialData,
          }));
        }
      } catch { /* silent */ }
    }, 5000);
  }, [userId]);

  // Cleanup
  useEffect(() => () => { if (assetPollRef.current) clearInterval(assetPollRef.current); }, []);

  // Plaid SDK — receivedRedirectUri tells SDK this is an OAuth resume
  const { open, ready } = usePlaidLinkSDK({
    token: state.linkToken,
    onSuccess: handleSuccess,
    onExit: handleExit,
    onEvent: handleEvent,
    receivedRedirectUri: isOAuthResumeRef.current ? window.location.href : undefined,
  });

  // Auto-open on OAuth resume: when token is ready and it's an OAuth return
  useEffect(() => {
    if (ready && isOAuthResumeRef.current && state.step === 'ready') {
      console.log('[Plaid] 🔄 Auto-opening Plaid Link for OAuth resume...');
      setState(s => ({ ...s, step: 'linking' }));
      open();
      // Clean up the oauth_state_id from URL without reload
      const cleanUrl = `${window.location.origin}${window.location.pathname}`;
      window.history.replaceState({}, '', cleanUrl);
      isOAuthResumeRef.current = false;
    }
  }, [ready, state.step, open]);

  // Public API
  const openPlaidLink = useCallback(() => {
    if (ready) { setState(s => ({ ...s, step: 'linking' })); open(); }
  }, [ready, open]);

  const retry = useCallback(() => {
    clearPersistedState();
    clearOAuthResumeState(userId);
    setState(defaultState());
    initializedRef.current = false;
    expirationRef.current = null;
    initToken();
  }, [initToken, userId]);

  return {
    ...state, openPlaidLink, retry, refreshFromDatabase,
    isDatabaseRestoreComplete: dbRestoreComplete,
    isReady: ready && state.step === 'ready',
    open: openPlaidLink,
  };
};

// Default empty state
const defaultState = (): PlaidLinkState => ({
  step: 'idle',
  linkToken: null,
  error: null,
  plaidItemId: null,
  institution: null,
  balanceStatus: 'idle',
  assetsStatus: 'idle',
  investmentsStatus: 'idle',
  financialData: null,
  canProceed: false,
  productsAvailable: 0,
});

export default usePlaidLinkHook;
