import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import config from '../../resources/config/config';
import { useAuthSession } from '../../auth/AuthSessionProvider';
import { toCsv, downloadCsv } from './csv';

export type InvestorStage =
  | 'manual_approved'
  | 'manual_rejected'
  | 'awaiting_manual_review'
  | 'payment_started'
  | 'onboarding_complete'
  | 'bank_linked'
  | 'in_onboarding'
  | 'nda_signed'
  | 'lead';

export interface FundFunnelMoney {
  committed: string;
  approved: string;
  collected: string;
}

export interface FundFunnel {
  ndaSigned: number;
  bankLinked: number;
  financialDataReady: number;
  financialDataPartial: number;
  onboardingComplete: number;
  paymentLinkSent: number;
  meetCeoDone: number;
  firstPaymentPaid: number;
  pendingReview: number;
  verified: number;
  rejected: number;
  needsAttention: number;
  totalInvestors: number;
  money: FundFunnelMoney;
}

/**
 * One investor row from `fund-payment-admin-overview-list`. Every person who
 * entered the funnel (NDA OR onboarding OR payment) appears here, deduped by
 * user with their furthest-reached `stage`.
 */
export interface FundInvestorRow {
  userId: string;
  recipientName: string;
  userEmail: string | null;
  stage: InvestorStage;
  requestReference: string | null;
  selectedFund: string | null;
  commitmentLabel: string | null;
  status: string | null;
  paymentRequestStatus: string | null;
  manualReviewStatus: string | null;
  manualInvestorStatus: string | null;
  paidAt: string | null;
  firstPaymentPaid: boolean;
  verifiedAt: string | null;
  rejectedAt: string | null;
  ndaSignedAt: string | null;
  ndaSigned: boolean;
  meetCeoDone: boolean;
  currentStep: number | null;
  onboardingComplete: boolean;
  financialLinkStatus: string | null;
  bankLinked: boolean;
  institutionName: string | null;
  financialDataStatus: string;
  plaidProductCount: number;
  plaidAccountCount: number;
  kycStatus: string | null;
  riskFlags: string[];
  missingPieces: string[];
  dataSources: string[];
}

export interface SourceWarning {
  source: string;
  code?: string | null;
  message: string;
}

export type FundAdminTab =
  | 'needs_attention'
  | 'completed_onboarding'
  | 'bank_linked'
  | 'payment_review'
  | 'manually_approved'
  | 'all';

interface MetricsResponse {
  success: boolean;
  funnel?: FundFunnel;
  sourceWarnings?: SourceWarning[];
  error?: string;
}

interface ListResponse {
  success: boolean;
  investors?: FundInvestorRow[];
  page?: number;
  pageSize?: number;
  total?: number;
  counts?: Record<FundAdminTab, number>;
  sourceWarnings?: SourceWarning[];
  error?: string;
}

const PAGE_SIZE = 10;
const EXPORT_PAGE_SIZE = 100;
const EXPORT_PAGE_CAP = 50; // safety bound: up to 5,000 rows per export
const SEARCH_DEBOUNCE_MS = 250;

const EMPTY_COUNTS: Record<FundAdminTab, number> = {
  needs_attention: 0,
  completed_onboarding: 0,
  bank_linked: 0,
  payment_review: 0,
  manually_approved: 0,
  all: 0,
};

const functionUrl = (name: string) => `${config.GCP_API_BASE_URL}/functions/v1/${name}`;

function dedupeWarnings(warnings: SourceWarning[]): SourceWarning[] {
  const seen = new Set<string>();
  const out: SourceWarning[] = [];
  for (const w of warnings) {
    if (seen.has(w.source)) continue;
    seen.add(w.source);
    out.push(w);
  }
  return out;
}

/**
 * Drives the /fund-admin overview against the split, paginated edge functions:
 * - `-overview-metrics` for the whole-population funnel (loaded once / on refresh)
 * - `-overview-list` for the tab/search/paginated investor rows (server owns
 *   filtering + counts; we accumulate pages behind a "Load more" button).
 *
 * This replaces the old single endpoint that shipped the entire population to
 * the client and looped every auth user server-side to attach emails.
 */
export function useFundAdminOverview() {
  const { user, session, status } = useAuthSession();
  const [searchParams] = useSearchParams();
  const highlightRef = searchParams.get('ref');

  const accessToken = session?.access_token ?? null;

  const [funnel, setFunnel] = useState<FundFunnel | null>(null);
  const [investors, setInvestors] = useState<FundInvestorRow[]>([]);
  const [counts, setCounts] = useState<Record<FundAdminTab, number>>(EMPTY_COUNTS);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sourceWarnings, setSourceWarnings] = useState<SourceWarning[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<FundAdminTab>('needs_attention');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [exporting, setExporting] = useState(false);

  const authHeaders = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken ?? ''}` }),
    [accessToken],
  );

  // Debounce the search box so each keystroke doesn't hit the server.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  const requestList = useCallback(
    async (pageArg: number, pageSizeArg: number, tabArg: FundAdminTab, searchArg: string): Promise<ListResponse> => {
      const res = await fetch(functionUrl('fund-payment-admin-overview-list'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ page: pageArg, pageSize: pageSizeArg, tab: tabArg, search: searchArg }),
      });
      const data: ListResponse = await res
        .json()
        .catch(() => ({ success: false, error: 'Invalid response from server' }));
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Request failed (HTTP ${res.status})`);
      }
      return data;
    },
    [authHeaders],
  );

  const fetchMetrics = useCallback(async () => {
    if (!accessToken) return;
    setMetricsLoading(true);
    try {
      const res = await fetch(functionUrl('fund-payment-admin-overview-metrics'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      const data: MetricsResponse = await res
        .json()
        .catch(() => ({ success: false, error: 'Invalid response from server' }));
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Request failed (HTTP ${res.status})`);
      }
      setFunnel(data.funnel ?? null);
      if (data.sourceWarnings?.length) setSourceWarnings(dedupeWarnings(data.sourceWarnings));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load funnel metrics');
    } finally {
      setMetricsLoading(false);
    }
  }, [accessToken, authHeaders]);

  const fetchPage = useCallback(
    async (pageArg: number, append: boolean) => {
      if (!accessToken) return;
      setListLoading(true);
      if (!append) setError(null);
      try {
        const data = await requestList(pageArg, PAGE_SIZE, tab, debouncedSearch);
        const rows = data.investors ?? [];
        setInvestors((prev) => (append ? [...prev, ...rows] : rows));
        setCounts(data.counts ?? EMPTY_COUNTS);
        setTotal(data.total ?? rows.length);
        setPage(data.page ?? pageArg);
        if (data.sourceWarnings?.length) setSourceWarnings(dedupeWarnings(data.sourceWarnings));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load investors');
      } finally {
        setListLoading(false);
      }
    },
    [accessToken, requestList, tab, debouncedSearch],
  );

  // Metrics load once authenticated (and on refresh).
  useEffect(() => {
    if (status === 'authenticated') void fetchMetrics();
  }, [status, fetchMetrics]);

  // List reloads from page 1 whenever the tab or (debounced) search changes.
  useEffect(() => {
    if (status === 'authenticated') void fetchPage(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, tab, debouncedSearch, accessToken]);

  const hasMore = investors.length < total;
  const loadMore = useCallback(() => {
    if (listLoading || !hasMore) return;
    void fetchPage(page + 1, true);
  }, [listLoading, hasMore, fetchPage, page]);

  const refresh = useCallback(() => {
    void fetchMetrics();
    void fetchPage(1, false);
  }, [fetchMetrics, fetchPage]);

  const reviewerEmail = useMemo(() => user?.email ?? null, [user]);

  // Export the full current tab+search selection (not just the loaded page) as
  // CSV — paginate the list endpoint server-side until we have every match.
  // PII-light: no DOB/SSN/phone/address (those aren't in the list projection).
  const exportCsv = useCallback(async () => {
    if (!accessToken || exporting) return;
    setExporting(true);
    try {
      const all: FundInvestorRow[] = [];
      for (let p = 1; p <= EXPORT_PAGE_CAP; p += 1) {
        const data = await requestList(p, EXPORT_PAGE_SIZE, tab, debouncedSearch);
        const rows = data.investors ?? [];
        all.push(...rows);
        if (rows.length === 0 || all.length >= (data.total ?? all.length)) break;
      }
      if (all.length === 0) return;
      const header = [
        'Name', 'Email', 'Stage', 'Payment status', 'Manual investor status',
        'Commitment', 'First payment paid', 'Paid at', 'Verified at', 'Rejected at',
        'NDA signed', 'Bank linked', 'Financial data', 'Institution', 'KYC status',
        'Risk flags', 'Missing pieces', 'Reference', 'User ID',
      ];
      const rows = all.map((r) => [
        r.recipientName, r.userEmail ?? '', r.stage, r.status ?? '', r.manualInvestorStatus ?? '',
        r.commitmentLabel ?? '', r.firstPaymentPaid ? 'yes' : 'no', r.paidAt ?? '', r.verifiedAt ?? '', r.rejectedAt ?? '',
        r.ndaSigned ? 'yes' : 'no', r.bankLinked ? 'yes' : 'no', r.financialDataStatus, r.institutionName ?? '', r.kycStatus ?? '',
        r.riskFlags.join('; '), r.missingPieces.join('; '), r.requestReference ?? '', r.userId,
      ]);
      const date = new Date().toISOString().slice(0, 10);
      downloadCsv(`hushh-fund-investors-${tab}-${date}.csv`, toCsv([header, ...rows]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export CSV');
    } finally {
      setExporting(false);
    }
  }, [accessToken, exporting, requestList, tab, debouncedSearch]);

  return {
    reviewerEmail,
    highlightRef,
    funnel,
    investors,
    sourceWarnings,
    loading: metricsLoading,
    listLoading,
    error,
    tab,
    setTab,
    search,
    setSearch,
    counts,
    // `filtered` is the server-filtered, page-accumulated list (the UI renders this).
    filtered: investors,
    total,
    hasMore,
    loadMore,
    exporting,
    exportCsv,
    refresh,
  };
}
