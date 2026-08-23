import { useCallback, useEffect, useState } from 'react';
import config from '../../../resources/config/config';
import { useAuthSession } from '../../../auth/AuthSessionProvider';

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  conversionFromPrev: number | null;
  conversionFromTop: number | null;
}

export interface CapitalWeek {
  weekStart: string;
  collected: string;
  collectedCents: number;
  payments: number;
}

export interface FundBreakdown {
  fund: string;
  label: string;
  investors: number;
  committed: string;
  approved: string;
  committedCents: number;
  approvedCents: number;
}

export interface AnalyticsData {
  funnel: FunnelStage[];
  timeInStageDays: {
    ndaToOnboarding: number | null;
    onboardingToPaid: number | null;
    paidToVerified: number | null;
  };
  capitalWeekly: CapitalWeek[];
  byFund: FundBreakdown[];
  byShareClass: { a: number; b: number; c: number };
  totals: {
    committed: string;
    approved: string;
    collected: string;
    aum: string;
    recurringMonthly: string;
    recurringCount: number;
    recurringCollected: string;
  };
  kyc: {
    covered: number;
    coveragePct: number | null;
    riskBands: { LOW: number; MEDIUM: number; HIGH: number; unknown: number };
  };
  meetCeoDone: number;
  totalInvestors: number;
}

interface AnalyticsResponse extends Partial<AnalyticsData> {
  success: boolean;
  error?: string;
}

const functionUrl = (name: string) => `${config.GCP_API_BASE_URL}/functions/v1/${name}`;

export function useFundAdminAnalytics() {
  const { session, status } = useAuthSession();
  const accessToken = session?.access_token ?? null;

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(functionUrl('fund-payment-admin-analytics'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({}),
      });
      const json: AnalyticsResponse = await res
        .json()
        .catch(() => ({ success: false, error: 'Invalid response from server' }));
      if (!res.ok || !json.success) {
        throw new Error(json.error || `Request failed (HTTP ${res.status})`);
      }
      setData(json as AnalyticsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (status === 'authenticated') {
      void fetchData();
    }
  }, [status, fetchData]);

  return { data, loading, error, refresh: fetchData };
}
