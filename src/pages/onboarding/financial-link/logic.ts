/**
 * FinancialLink — All Business Logic
 * Pre-onboarding financial verification via Plaid.
 * Uses usePlaidLinkHook for the full Plaid Link flow.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import config from '../../../resources/config/config';
import { trackFinancialLink } from '../../../services/onboarding/onboardingAnalytics';
import { usePlaidLinkHook } from '../../../services/plaid/usePlaidLink';
import {
  createSandboxTestItem,
  formatCurrency,
  getProductStatus,
  getPlaidSyncStatus,
  startPlaidDataSync,
  unlinkPlaidAccount,
  type PlaidDataProduct,
  type ProductFetchStatus,
  type PlaidProductSyncStatus,
  type PlaidProductSyncStatusValue,
} from '../../../services/plaid/plaidService';
import { buildFinancialVerificationRows } from './verificationRows';
import { upsertOnboardingData } from '../../../services/onboarding/upsertOnboardingData';
import { CONSENT_VERSION } from '../../../services/consent/consentConfig';
import {
  FINANCIAL_LINK_ROUTE,
  getFinancialLinkContinuationRoute,
  isFinancialLinkReviewMode,
  resolveFinancialLinkStatus,
} from '../../../services/onboarding/flow';
import { fetchOnboardingProgress } from '../../../services/onboarding/progress';
import {
  getInvestorAccessState,
  getResumeRouteForState,
} from '../../../services/investorAccess/state';
import {
  beginPlaidSession,
  installGlobalPlaidErrorListener,
  logPlaidEvent,
} from '../../../services/plaid/plaidDiagnostics';

export { formatCurrency };

type ProductSyncUiStatus = 'success' | 'loading' | 'pending' | 'unavailable' | 'error';
type ProductSyncBackfillState = 'idle' | 'starting' | 'started' | 'needs_relink' | 'error';

const CORE_SYNC_PRODUCTS: PlaidDataProduct[] = ['accounts', 'balance', 'auth'];
const LOCAL_SANDBOX_INSTITUTION_ID = 'ins_109508';

const isLocalPlaidHost = () => {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
};

// Defensive wrappers: these factories run inside React `useMemo` during
// the FinancialLink render path. If they throw the whole page crashes to
// the ErrorBoundary fallback, so we treat any env-access exception as
// "production-prod, don't take the sandbox / block branch."
const shouldUsePlaidSandboxDirectConnect = () => {
  try {
    const forcedMode = import.meta.env?.VITE_PLAID_LINK_MODE;
    if (forcedMode === 'link') return false;
    if (forcedMode === 'sandbox-direct') return true;

    return isLocalPlaidHost()
      && import.meta.env?.VITE_PLAID_ENV === 'sandbox'
      && import.meta.env?.VITE_PLAID_DISABLE_LOCAL_SANDBOX_DIRECT !== 'true';
  } catch {
    return false;
  }
};

const shouldBlockLocalPlaidLink = () => {
  try {
    const forcedMode = import.meta.env?.VITE_PLAID_LINK_MODE;
    if (forcedMode === 'link' || forcedMode === 'sandbox-direct') return false;

    return isLocalPlaidHost()
      && import.meta.env?.VITE_PLAID_ENV !== 'sandbox'
      && import.meta.env?.VITE_ALLOW_LOCAL_PLAID_LINK !== 'true';
  } catch {
    return false;
  }
};

const PRODUCT_SYNC_DISPLAY: Array<{
  product: PlaidDataProduct;
  title: string;
  icon: string;
}> = [
  { product: 'accounts', title: 'Accounts', icon: 'account_balance' },
  { product: 'balance', title: 'Balance', icon: 'account_balance_wallet' },
  { product: 'auth', title: 'Bank verification', icon: 'verified_user' },
  { product: 'identity', title: 'Identity', icon: 'badge' },
  { product: 'identity_match', title: 'Identity match', icon: 'how_to_reg' },
  { product: 'transactions', title: 'Transactions', icon: 'receipt_long' },
  { product: 'assets', title: 'Assets report', icon: 'inventory' },
  { product: 'investments', title: 'Investments', icon: 'monitoring' },
  { product: 'investment_transactions', title: 'Investment activity', icon: 'timeline' },
  { product: 'liabilities', title: 'Liabilities', icon: 'credit_card' },
  { product: 'statements', title: 'Statements', icon: 'description' },
  { product: 'income', title: 'Income', icon: 'payments' },
  { product: 'signal', title: 'ACH risk', icon: 'health_and_safety' },
];

const PRODUCT_SYNC_STATUS_TO_UI: Record<PlaidProductSyncStatusValue, ProductSyncUiStatus> = {
  complete: 'success',
  partial: 'success',
  syncing: 'loading',
  pending: 'pending',
  unsupported: 'unavailable',
  access_required: 'unavailable',
  failed: 'error',
};

const resolveVerificationProductStatus = (
  status: ProductFetchStatus,
  plaidStep: ReturnType<typeof usePlaidLinkHook>['step'],
): ProductFetchStatus => {
  if (status !== 'idle') return status;
  if (plaidStep === 'exchanging' || plaidStep === 'fetching') return 'loading';
  if (plaidStep === 'done') return 'unavailable';
  // A link-token/configuration failure happens before any product endpoint is
  // requested. Keep those cards idle rather than falsely reporting three
  // independent retrieval failures; the page-level error identifies the
  // failed initialization step.
  return 'idle';
};

const getProductStatusSubtitle = (
  product: PlaidDataProduct,
  status?: PlaidProductSyncStatus
) => {
  if (!status) return 'Queued';

  if (status.status === 'syncing') return 'Syncing in background';
  if (status.status === 'pending') {
    if (product === 'assets') return 'Generating report';
    if (product === 'identity_match') return 'Waiting for legal details';
    return 'Queued';
  }
  if (status.status === 'unsupported') return 'Not supported by this bank';
  if (status.status === 'access_required') return 'Needs additional consent';
  if (status.status === 'failed') return 'Will retry later';
  if (status.status === 'partial') return 'Partially ready';
  if (!status.available) return 'No records found';

  return status.records_count != null
    ? `${status.records_count} records ready`
    : 'Ready';
};

const isMissingCoreSyncStatus = (statuses: PlaidProductSyncStatus[]) => {
  if (statuses.length === 0) return true;
  const products = new Set(statuses.map((status) => status.product));
  return CORE_SYNC_PRODUCTS.some((product) => !products.has(product));
};

const getMissingProductFallback = (
  backfillState: ProductSyncBackfillState,
  hasPlaidItem: boolean,
  isDatabaseRestoreComplete: boolean
): { status: ProductSyncUiStatus; subtitle: string } => {
  if (backfillState === 'needs_relink' || (!hasPlaidItem && isDatabaseRestoreComplete)) {
    return { status: 'unavailable', subtitle: 'Reconnect bank' };
  }
  if (backfillState === 'error') {
    return { status: 'error', subtitle: 'Will retry later' };
  }
  if (backfillState === 'started') {
    return { status: 'loading', subtitle: 'Syncing in background' };
  }
  return { status: 'loading', subtitle: 'Starting background sync' };
};

export const useFinancialLinkLogic = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [userId, setUserId] = useState<string>('');
  const [userEmail, setUserEmail] = useState<string | undefined>(undefined);
  const [isReady, setIsReady] = useState(false);
  const [currentOnboardingStep, setCurrentOnboardingStep] = useState(1);
  const [resumeRoute, setResumeRoute] = useState<string>(getFinancialLinkContinuationRoute(1));
  const [isChangeBankConfirmOpen, setIsChangeBankConfirmOpen] = useState(false);
  const [isChangingBank, setIsChangingBank] = useState(false);
  const [isSandboxConnecting, setIsSandboxConnecting] = useState(false);
  const [changeBankError, setChangeBankError] = useState<string | null>(null);
  /* Plaid data-sharing consent gate. Default unchecked; if the user already
     consented in a prior session we flip it true on load so we never re-prompt. */
  const [plaidConsentChecked, setPlaidConsentChecked] = useState(false);
  const [plaidConsentPersisted, setPlaidConsentPersisted] = useState(false);
  const [plaidConsentError, setPlaidConsentError] = useState(false);
  const [productSyncStatuses, setProductSyncStatuses] = useState<PlaidProductSyncStatus[]>([]);
  const [productSyncBackfillState, setProductSyncBackfillState] =
    useState<ProductSyncBackfillState>('idle');
  const hasInitialized = useRef(false);
  const syncBackfillAttemptedRef = useRef<string | null>(null);
  const isReviewMode = useMemo(
    () => isFinancialLinkReviewMode(location.search),
    [location.search]
  );
  const useSandboxDirectConnect = useMemo(shouldUsePlaidSandboxDirectConnect, []);
  const blockLocalPlaidLink = useMemo(shouldBlockLocalPlaidLink, []);

  /* Scroll to top */
  useEffect(() => { window.scrollTo(0, 0); }, []);

  /* Plaid Link diagnostics — fire a fresh session id on every financial-link
     mount so each user attempt clusters together in the
     plaid_link_diagnostics table. The global window error listener is
     idempotent and captures Plaid CDN findScriptTag failures even when
     they bubble outside our React tree. */
  useEffect(() => {
    // RED.2 defensive: a failing diagnostics dependency (clipped sessionStorage,
    // sandbox CSP blocking BroadcastChannel etc.) must never crash the FL
    // mount. Each call is independently guarded.
    let sessionId: string | null = null;
    try {
      installGlobalPlaidErrorListener();
    } catch (err) {
      console.warn('[FinancialLink] installGlobalPlaidErrorListener failed', err);
    }
    try {
      sessionId = beginPlaidSession();
    } catch (err) {
      console.warn('[FinancialLink] beginPlaidSession failed', err);
    }
    try {
      logPlaidEvent('financial_link_mount', {
        pageState: {
          sessionId,
          isReviewMode,
          useSandboxDirectConnect,
          blockLocalPlaidLink,
        },
      });
    } catch (err) {
      console.warn('[FinancialLink] mount diagnostic emit failed', err);
    }
    return () => {
      try {
        logPlaidEvent('financial_link_unmount', {
          pageState: { sessionId, isReviewMode },
        });
      } catch {
        // Unmount-time emit failures must never throw.
      }
    };
  }, [isReviewMode, useSandboxDirectConnect, blockLocalPlaidLink]);

  /* Get authenticated user — runs only once */
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    const getUser = async () => {
      if (!config.gcpBackendClient) { navigate('/login'); return; }
      const { data: { user } } = await config.gcpBackendClient.auth.getUser();
      if (!user) {
        const redirectTarget = `${FINANCIAL_LINK_ROUTE}${isReviewMode ? '?mode=review' : ''}`;
        navigate(`/login?redirect=${encodeURIComponent(redirectTarget)}`, {
          replace: true,
        });
        return;
      }

      setUserId(user.id);
      setUserEmail(user.email || undefined);

      /* Best-effort: if this user already consented to Plaid data sharing
         UNDER THE CURRENT consent version, pre-check the box so we don't ask
         again. If the consent copy changed (CONSENT_VERSION bumped) or the row
         predates versioning, leave the box unchecked so the user must
         re-acknowledge the new wording — a regulated-fund compliance need.
         Swallow errors so a pending migration (column not yet present) never
         blocks the page (a thrown select just leaves the box unchecked). */
      try {
        const { data: consentRow } = await config.gcpBackendClient
          .from('onboarding_data')
          .select('plaid_consent_at, consent_version')
          .eq('user_id', user.id)
          .maybeSingle();
        if (
          consentRow?.plaid_consent_at &&
          consentRow?.consent_version === CONSENT_VERSION
        ) {
          setPlaidConsentChecked(true);
          setPlaidConsentPersisted(true);
        }
      } catch {
        // Columns may not exist yet (migration pending) — ignore (re-prompt).
      }

      try {
        const onboardingProgress = await fetchOnboardingProgress(
          config.gcpBackendClient,
          user.id
        );
        const { data: financialData, error: fetchError } = await config.gcpBackendClient
          .from('user_financial_data').select('status').eq('user_id', user.id).maybeSingle();
        if (fetchError) console.warn('[FinancialLink] GcpBackend query error (ignoring):', fetchError.message);
        const effectiveStatus = resolveFinancialLinkStatus(
          onboardingProgress?.financial_link_status,
          financialData?.status
        );

        if (
          effectiveStatus === 'completed' &&
          onboardingProgress?.financial_link_status !== 'completed'
        ) {
          void upsertOnboardingData(user.id, { financial_link_status: 'completed' });
        }

        // Status-aware resume routing: if the user already paid (or beyond),
        // skip past financial-link entirely and land them on the right
        // post-payment surface. Falls back to the legacy continuation route
        // when no payment state is set yet.
        //
        // CRITICAL guards that suppress this redirect:
        // 1. `?mode=review`: user explicitly came to manage their bank.
        // 2. `?oauth_state_id=...`: Plaid is mid-OAuth-resume — Plaid drops
        //    our `mode=review` param when it redirects back from the bank,
        //    so we must detect the resume independently.
        // If we redirect during either case, React unmounts the page before
        // Plaid Link can finish its OAuth resume, the SDK fails its
        // findScriptTag() lookup, the console logs
        //   "Failed to find script" from cdn.plaid.com/link/v2/stable/...
        // and the user sees Plaid's "Something went wrong" modal.
        const isPlaidOAuthResume = new URLSearchParams(location.search).has('oauth_state_id');
        const suppressResumeRedirect = isReviewMode || isPlaidOAuthResume;
        if (suppressResumeRedirect) {
          logPlaidEvent('financial_link_redirect_suppressed', {
            userId: user.id,
            pageState: {
              isReviewMode,
              isPlaidOAuthResume,
              isCompleted: Boolean(onboardingProgress?.is_completed),
              accessStatePreCompute: getInvestorAccessState(onboardingProgress),
            },
          });
        }

        const accessState = getInvestorAccessState(onboardingProgress);
        if (
          !suppressResumeRedirect &&
          (accessState === 'verified_investor' ||
            accessState === 'payment_in_review' ||
            accessState === 'rejected_investor')
        ) {
          logPlaidEvent('financial_link_resume_redirect', {
            userId: user.id,
            pageState: {
              accessState,
              isPlaidOAuthResume,
              isReviewMode,
              currentStep: onboardingProgress?.current_step,
            },
          });
          navigate(
            getResumeRouteForState(accessState, onboardingProgress?.current_step),
            { replace: true },
          );
          return;
        }

        if (onboardingProgress?.is_completed && !suppressResumeRedirect) {
          logPlaidEvent('financial_link_completed_redirect', {
            userId: user.id,
            pageState: {
              isPlaidOAuthResume,
              isReviewMode,
              currentStep: onboardingProgress?.current_step,
            },
          });
          navigate(
            getResumeRouteForState(accessState, onboardingProgress?.current_step),
            { replace: true },
          );
          return;
        }

        const nextRoute = getFinancialLinkContinuationRoute(
          onboardingProgress?.current_step || 1
        );
        setCurrentOnboardingStep(onboardingProgress?.current_step || 1);
        setResumeRoute(nextRoute);

        if (effectiveStatus !== 'pending' && !suppressResumeRedirect) {
          navigate(nextRoute, { replace: true });
          return;
        }
      } catch (err) {
        console.warn('[FinancialLink] Error checking financial data (ignoring):', err);
      }

      setIsReady(true);
    };

    getUser();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Plaid hook — the real integration ─── */
  const plaid = usePlaidLinkHook(userId, userEmail, {
    skipAutoInit: useSandboxDirectConnect || blockLocalPlaidLink,
  });

  /* P0.F — Cross-tab BroadcastChannel listener. If another tab unlinks the
     Plaid bank, this tab forces a Plaid state reset so the UI does not show
     stale "Connected" data. Declared after `plaid` so the dependency array
     does not read it inside its temporal dead zone (prod build TDZ crash). */
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel('hushh:plaid-state');
    } catch {
      return;
    }
    const handle = (event: MessageEvent) => {
      const payload = event.data as { type?: string; userId?: string } | null;
      if (!payload || payload.type !== 'unlinked') return;
      if (payload.userId && userId && payload.userId !== userId) return;
      console.log('[FinancialLink] Cross-tab unlink received, refreshing state');
      try {
        sessionStorage.removeItem('plaid_link_state');
      } catch {
        // ignore
      }
      plaid.retry();
    };
    channel.addEventListener('message', handle);
    return () => {
      channel.removeEventListener('message', handle);
      channel.close();
    };
  }, [plaid, userId]);

  /* ─── Extract all accounts from balance data ─── */
  const allAccounts = useMemo(() => {
    return plaid.financialData?.balance?.data?.accounts || [];
  }, [plaid.financialData]);

  /* ─── Group accounts by type ─── */
  const accountGroups = useMemo(() => {
    const groups: Record<string, any[]> = {};
    for (const acc of allAccounts) {
      const key = acc.type || 'other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(acc);
    }
    return groups;
  }, [allAccounts]);

  /* ─── Total balance ─── */
  const totalBalance = useMemo(() => {
    return allAccounts.reduce((sum: number, acc: any) => {
      const bal = acc.balances?.current ?? acc.balances?.available ?? 0;
      return sum + bal;
    }, 0);
  }, [allAccounts]);

  /* ─── Identity data ─── */
  const identityInfo = useMemo(() => {
    const id = plaid.financialData?.identity?.data;
    if (!id) return null;
    const accounts = id.accounts || [];
    if (accounts.length === 0) return null;
    const owners = accounts[0]?.owners || [];
    if (owners.length === 0) return null;
    const owner = owners[0];
    const rawEmails = (owner.emails || []).map((e: any) => e.data).filter(Boolean);
    const uniqueEmails = [...new Set(rawEmails.map((e: string) => e.toLowerCase()))];
    const rawPhones = (owner.phone_numbers || []).map((p: any) => p.data).filter(Boolean);
    const uniquePhones = [...new Set(rawPhones)];
    return {
      names: owner.names || [],
      emails: uniqueEmails,
      phones: uniquePhones,
      addresses: (owner.addresses || []).map((a: any) => {
        const d = a.data || {};
        return [d.street, d.city, d.region, d.postal_code, d.country].filter(Boolean).join(', ');
      }),
    };
  }, [plaid.financialData]);

  /* ─── Investment holdings ─── */
  const investmentHoldings = useMemo(() => {
    return plaid.financialData?.investments?.data?.holdings || [];
  }, [plaid.financialData]);

  const investmentAccounts = useMemo(() => {
    return plaid.financialData?.investments?.data?.accounts || [];
  }, [plaid.financialData]);

  /* ─── UI state derived from Plaid ─── */
  const isProcessing = ['creating_token', 'exchanging', 'fetching'].includes(plaid.step);
  const isInitializing =
    !useSandboxDirectConnect && (plaid.step === 'idle' || plaid.step === 'creating_token');
  const isDone = plaid.step === 'done';
  const canProceed = isDone && plaid.canProceed;
  const localPlaidNotice = blockLocalPlaidLink
    ? 'Plaid bank connection is paused on localhost for this production Plaid setup. Use the secure test URL, or switch local Plaid to sandbox mode for clean testing.'
    : null;

  useEffect(() => {
    if (!userId || !isDone) {
      setProductSyncStatuses([]);
      setProductSyncBackfillState('idle');
      return;
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const maybeStartBackfill = async (statuses: PlaidProductSyncStatus[]) => {
      if (!isMissingCoreSyncStatus(statuses)) {
        if (!cancelled) setProductSyncBackfillState('idle');
        return;
      }

      if (!plaid.isDatabaseRestoreComplete) {
        if (!cancelled) setProductSyncBackfillState('starting');
        return;
      }

      if (!plaid.plaidItemId) {
        if (!cancelled) setProductSyncBackfillState('needs_relink');
        return;
      }

      const attemptKey = `${userId}:${plaid.plaidItemId}`;
      if (syncBackfillAttemptedRef.current === attemptKey) {
        return;
      }
      syncBackfillAttemptedRef.current = attemptKey;

      if (!cancelled) setProductSyncBackfillState('starting');
      try {
        console.log('[Plaid] Starting missing product sync backfill', {
          itemId: plaid.plaidItemId,
          statusRows: statuses.length,
        });
        await startPlaidDataSync(userId, plaid.plaidItemId);
        if (cancelled) return;

        setProductSyncBackfillState('started');
        const refreshedStatuses = await getPlaidSyncStatus(userId);
        if (!cancelled) setProductSyncStatuses(refreshedStatuses);
        await plaid.refreshFromDatabase();
      } catch (err) {
        console.warn('[Plaid] Product sync backfill failed:', err);
        if (!cancelled) setProductSyncBackfillState('error');
      }
    };

    const loadStatuses = async () => {
      const statuses = await getPlaidSyncStatus(userId);
      if (cancelled) return;
      setProductSyncStatuses(statuses);
      void maybeStartBackfill(statuses);
    };

    void loadStatuses();
    intervalId = setInterval(loadStatuses, 5000);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [isDone, userId, plaid.plaidItemId, plaid.isDatabaseRestoreComplete, plaid.refreshFromDatabase]);

  const buttonText = useMemo(() => {
    if (isSandboxConnecting) return 'Connecting Sandbox Bank...';
    if (blockLocalPlaidLink && !isDone) return 'Use secure test URL';
    if (useSandboxDirectConnect && (plaid.step === 'error' || (isDone && !plaid.canProceed))) return 'Try Again';
    if (useSandboxDirectConnect && !isDone) return 'Connect Sandbox Bank';
    if (plaid.step === 'idle' || plaid.step === 'creating_token') return 'Preparing...';
    if (plaid.step === 'linking') return 'Connecting...';
    if (plaid.step === 'exchanging') return 'Securing Connection...';
    if (plaid.step === 'fetching') return 'Fetching Financial Data...';
    if (isDone && canProceed) return 'Continue to KYC';
    if (plaid.step === 'error' || (isDone && !plaid.canProceed)) return 'Try Again';
    if (useSandboxDirectConnect) return 'Connect Sandbox Bank';
    return 'Connect Bank Account';
  }, [
    canProceed,
    isDone,
    isSandboxConnecting,
    blockLocalPlaidLink,
    plaid.canProceed,
    plaid.step,
    useSandboxDirectConnect,
  ]);

  const showPrimaryButtonSpinner = isInitializing || isProcessing || isSandboxConnecting;
  const isButtonDisabled =
    showPrimaryButtonSpinner ||
    Boolean(localPlaidNotice && !isDone) ||
    (!isDone && !plaidConsentChecked);

  /* ─── Verification row statuses ─── */
  const verificationRows = useMemo(() => {
    const identityProductStatus = plaid.financialData?.identity
      ? getProductStatus(plaid.financialData.identity)
      : 'idle';

    return buildFinancialVerificationRows({
      assetsStatus: resolveVerificationProductStatus(plaid.assetsStatus, plaid.step),
      investmentsStatus: resolveVerificationProductStatus(plaid.investmentsStatus, plaid.step),
      identityStatus: resolveVerificationProductStatus(identityProductStatus, plaid.step),
      identityInfo,
      investmentHoldingsCount: investmentHoldings.length,
      investmentAccountsCount: investmentAccounts.length,
    });
  }, [plaid.assetsStatus, plaid.financialData?.identity, plaid.investmentsStatus, plaid.step, identityInfo, investmentAccounts.length, investmentHoldings.length]);

  const productSyncRows = useMemo(() => {
    if (!isDone && productSyncStatuses.length === 0) return [];

    const statusByProduct = new Map<PlaidDataProduct, PlaidProductSyncStatus>();
    for (const status of productSyncStatuses) {
      statusByProduct.set(status.product, status);
    }

    return PRODUCT_SYNC_DISPLAY.map((productMeta) => {
      const status = statusByProduct.get(productMeta.product);
      if (!status) {
        const fallback = getMissingProductFallback(
          productSyncBackfillState,
          Boolean(plaid.plaidItemId),
          plaid.isDatabaseRestoreComplete
        );
        return {
          ...productMeta,
          status: fallback.status,
          subtitle: fallback.subtitle,
        };
      }
      const statusValue = status?.status || 'pending';
      return {
        ...productMeta,
        status: PRODUCT_SYNC_STATUS_TO_UI[statusValue],
        subtitle: getProductStatusSubtitle(productMeta.product, status),
      };
    });
  }, [
    isDone,
    plaid.isDatabaseRestoreComplete,
    plaid.plaidItemId,
    productSyncBackfillState,
    productSyncStatuses,
  ]);

  const handleBack = useCallback(() => {
    // Back must not use the forward onboarding destination: its guard can
    // immediately send an unfinished user back to this page.
    if (window.history.state?.idx > 0) {
      navigate(-1);
      return;
    }
    navigate('/', { replace: true });
  }, [navigate]);

  /* Record the Plaid data-sharing consent once. Reuses the onboarding_data
     row; upsert silently drops the columns if the migration hasn't landed. */
  const persistPlaidConsent = useCallback(async () => {
    if (plaidConsentPersisted || !userId) return true;
    setPlaidConsentPersisted(true);
    const { error } = await upsertOnboardingData(userId, {
      plaid_consent_at: new Date().toISOString(),
      consent_version: CONSENT_VERSION,
    });
    if (error) {
      setPlaidConsentPersisted(false);
      setChangeBankError(error.message || 'Unable to save consent. Please try again.');
      return false;
    }
    return true;
  }, [plaidConsentPersisted, userId]);

  const handlePlaidConsentChange = useCallback((checked: boolean) => {
    setPlaidConsentChecked(checked);
    if (checked) setPlaidConsentError(false);
  }, []);

  /* ─── Main button handler — Plaid flow ─── */
  const handleButtonClick = useCallback(async () => {
    if (isDone && canProceed) {
      const { error: completeError } = await upsertOnboardingData(userId, {
        current_step: currentOnboardingStep,
        financial_link_status: 'completed',
      });
      if (completeError) {
        // Non-blocking: financial_link_status self-heals downstream because
        // resolveFinancialLinkStatus reads BOTH onboarding_data and the
        // user_financial_data 'complete' status. The bank IS linked, so we
        // proceed rather than trap a user who genuinely finished — but we log
        // the write failure for observability instead of swallowing it.
        console.warn(
          '[FinancialLink] Failed to persist completed status (continuing, self-heals):',
          completeError.message,
        );
      }
      navigate(resumeRoute, { replace: true });
      return;
    }
    if (blockLocalPlaidLink) {
      return;
    }
    /* Consent gate — block a fresh bank connection until the user has agreed
       to share their Plaid data. The continue path above is exempt (already
       connected); the retry paths below keep the prior session's consent. */
    if (!plaidConsentChecked) {
      setPlaidConsentError(true);
      return;
    }
    const consentSaved = await persistPlaidConsent();
    if (!consentSaved) {
      return;
    }
    if (useSandboxDirectConnect) {
      setIsSandboxConnecting(true);
      setChangeBankError(null);
      try {
        const sandboxItem = await createSandboxTestItem(userId, LOCAL_SANDBOX_INSTITUTION_ID);
        await startPlaidDataSync(userId, sandboxItem.item_id);
        const dbState = await plaid.refreshFromDatabase();

        if (!dbState?.canProceed) {
          throw new Error('Sandbox bank connected, but verification data is still syncing. Please try again.');
        }
      } catch (err) {
        const message = err instanceof Error
          ? err.message
          : 'Sandbox bank connection failed';
        setChangeBankError(message);
      } finally {
        setIsSandboxConnecting(false);
      }
      return;
    }
    if (plaid.step === 'error' || (isDone && !plaid.canProceed)) {
      plaid.retry();
      return;
    }
    if (plaid.isReady) {
      trackFinancialLink('started');
      plaid.openPlaidLink();
    }
  }, [
    canProceed,
    currentOnboardingStep,
    isDone,
    navigate,
    plaid,
    resumeRoute,
    blockLocalPlaidLink,
    useSandboxDirectConnect,
    userId,
    plaidConsentChecked,
    persistPlaidConsent,
  ]);

  const closeChangeBankConfirm = useCallback(() => {
    if (isChangingBank) return;
    setIsChangeBankConfirmOpen(false);
    setChangeBankError(null);
  }, [isChangingBank]);

  const openChangeBankConfirm = useCallback(() => {
    setChangeBankError(null);
    setIsChangeBankConfirmOpen(true);
  }, []);

  const handleConfirmChangeBank = useCallback(async () => {
    if (!userId) return;

    setIsChangingBank(true);
    setChangeBankError(null);
    try {
      await unlinkPlaidAccount(userId);
      try {
        sessionStorage.removeItem('plaid_link_state');
      } catch {
        // sessionStorage may be unavailable in private browsing contexts.
      }
      setIsChangeBankConfirmOpen(false);
      await upsertOnboardingData(userId, {
        current_step: currentOnboardingStep,
        financial_link_status: 'pending',
      });
      // P0.F — Broadcast unlink to other tabs so stale UI corrects itself
      // without waiting for the next focus / poll.
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          const channel = new BroadcastChannel('hushh:plaid-state');
          channel.postMessage({ type: 'unlinked', userId, at: Date.now() });
          channel.close();
        }
      } catch {
        // BroadcastChannel may be unavailable (older browsers, embedded webviews).
      }
      plaid.retry();
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : 'Failed to change linked bank';
      setChangeBankError(message);
    } finally {
      setIsChangingBank(false);
    }
  }, [currentOnboardingStep, plaid, userId]);

  return {
    userId,
    userEmail,
    isReady,
    isReviewMode,
    /* Plaid state */
    plaidStep: plaid.step,
    institution: plaid.institution,
    isDone,
    canProceed,
    isProcessing,
    isButtonDisabled,
    showPrimaryButtonSpinner,
    buttonText,
    error: plaid.error,
    localPlaidNotice,
    /* Data */
    verificationRows,
    allAccounts,
    accountGroups,
    totalBalance,
    identityInfo,
    investmentHoldings,
    investmentAccounts,
    productSyncRows,
    /* Actions */
    handleBack,
    handleButtonClick,
    openChangeBankConfirm,
    closeChangeBankConfirm,
    handleConfirmChangeBank,
    openPlaidLink: plaid.openPlaidLink,
    retry: plaid.retry,
    /* Change bank state */
    isChangeBankConfirmOpen,
    isChangingBank,
    changeBankError,
    /* Plaid consent gate */
    plaidConsentChecked,
    plaidConsentError,
    handlePlaidConsentChange,
  };
};
