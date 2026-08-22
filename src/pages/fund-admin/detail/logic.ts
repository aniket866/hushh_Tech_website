import { useCallback, useEffect, useMemo, useState } from 'react';
import config from '../../../resources/config/config';
import { useAuthSession } from '../../../auth/AuthSessionProvider';

export type FundReviewDecision = 'verified_investor' | 'rejected';

export interface PlaidAccountSummary {
  name: string;
  type: string | null;
  subtype: string | null;
  mask: string | null;
  balance: string | null;
}

export interface PlaidProductSync {
  product: string;
  status: string;
  available: boolean;
  records: number | null;
}

export interface InvestorReview {
  status: string;
  notes: string | null;
  reviewedAt: string | null;
  reviewerEmail: string | null;
  flags: string[];
}

export interface InvestorDetail {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  dobMasked: string | null;
  ssnProvided: boolean;
  accountType: string | null;
  applicationStatus?: string | null;
  accountTypeDetails?: Record<string, unknown> | null;
  signatory?: { isPrimary: boolean | null; confirmedAt: string | null } | null;
  parties?: Array<{
    role: string;
    displayName: string | null;
    email: string | null;
    status: string;
    completedAt: string | null;
    required: boolean;
  }>;
  currentStep: number | null;
  onboardingComplete: boolean;
  verificationStatus: string | null;
  audit: {
    ndaSigned: boolean;
    bankLinked: boolean;
    financialDataStatus: string;
    financialLinkStatus: string | null;
    firstPaymentPaid: boolean;
    paymentRequestStatus: string | null;
    manualReviewStatus: string | null;
    manualInvestorStatus: string | null;
    kycStatus: string | null;
    proofOfFunds?: string | null;
    missingPieces: string[];
    dataSources: string[];
  };
  timeline: {
    ndaSignedAt: string | null;
    ndaVersion: string | null;
    ndaPdfUrl: string | null;
    meetCeo: { paid: boolean; calendlyBooked: boolean; meetingStartTime: string | null } | null;
    firstPaidAt: string | null;
    verifiedAt: string | null;
    rejectedAt: string | null;
  };
  investment: {
    paymentRequestId: string;
    requestReference: string | null;
    status: string;
    selectedFund: string | null;
    commitment: string;
    firstPayment: string;
    units: { a: number; b: number; c: number };
    recurring: string | null;
    riskFlags: string[];
    reviewerNote: string | null;
  } | null;
  plaid: {
    institution: string | null;
    syncStatus: string | null;
    accounts: PlaidAccountSummary[];
    products: PlaidProductSync[];
  };
  kyc: {
    status: string | null;
    riskBand: string | null;
    riskScore: number | null;
    provider: string | null;
    verifiedAt: string | null;
    expiresAt: string | null;
    sanctionsChecked: boolean;
    pepChecked: boolean;
    amlScore: number | null;
    verificationLevel: string | null;
  } | null;
  reviews: InvestorReview[];
  notes: InvestorNote[];
  tags: string[];
}

export interface InvestorNote {
  id: string;
  body: string;
  authorEmail: string | null;
  createdAt: string;
}

interface DetailResponse {
  success: boolean;
  investor?: InvestorDetail;
  sourceWarnings?: SourceWarning[];
  error?: string;
}

export interface SourceWarning {
  source: string;
  code?: string | null;
  message: string;
}

interface KycGateInfo {
  present: boolean;
  status: string | null;
  riskBand: string | null;
}

interface VerifyResponse {
  success?: boolean;
  investor_verification_status?: string;
  already_reviewed?: boolean;
  message?: string;
  error?: string;
  code?: string;
  kyc?: KycGateInfo;
}

const functionUrl = (name: string) => `${config.GCP_API_BASE_URL}/functions/v1/${name}`;

export function useFundAdminDetail(userId: string | undefined) {
  const { session, status } = useAuthSession();
  const accessToken = session?.access_token ?? null;

  const [investor, setInvestor] = useState<InvestorDetail | null>(null);
  const [sourceWarnings, setSourceWarnings] = useState<SourceWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [note, setNote] = useState('');
  const [actioning, setActioning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // P2 KYC gate: set when the server blocks approval pending a KYC acknowledgement.
  const [kycGate, setKycGate] = useState<KycGateInfo | null>(null);
  const [kycAck, setKycAck] = useState(false);

  const fetchDetail = useCallback(async () => {
    if (!accessToken || !userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(functionUrl('fund-payment-admin-detail'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ userId }),
      });
      const data: DetailResponse = await res
        .json()
        .catch(() => ({ success: false, error: 'Invalid response from server' }));
      if (!res.ok || !data.success || !data.investor) {
        throw new Error(data.error || `Request failed (HTTP ${res.status})`);
      }
      setInvestor(data.investor);
      setSourceWarnings(data.sourceWarnings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load investor');
    } finally {
      setLoading(false);
    }
  }, [accessToken, userId]);

  useEffect(() => {
    if (status === 'authenticated') {
      void fetchDetail();
    }
  }, [status, fetchDetail]);

  const act = useCallback(
    async (decision: FundReviewDecision) => {
      if (actioning) return; // never run two writes at once
      const paymentRequestId = investor?.investment?.paymentRequestId;
      if (!paymentRequestId) {
        setActionError('No payment request to review for this investor yet.');
        return;
      }
      const trimmed = note.trim();
      if (decision === 'rejected' && !trimmed) {
        setActionError('A note is required to reject an investor (compliance trail).');
        return;
      }
      if (!accessToken) {
        setActionError('Your session expired. Please sign in again.');
        return;
      }
      setActioning(true);
      setActionError(null);
      setBanner(null);
      try {
        const res = await fetch(functionUrl('fund-payment-admin-verify'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            paymentRequestId,
            decision,
            notes: trimmed || null,
            acknowledgeKycRisk: decision === 'verified_investor' ? kycAck : undefined,
          }),
        });
        const data: VerifyResponse = await res.json().catch(() => ({}));
        if (res.status === 409 && data.code === 'KYC_RISK_UNACKNOWLEDGED') {
          setKycGate(data.kyc ?? { present: false, status: null, riskBand: null });
          setActionError(data.error || 'KYC review needed before approval.');
          return;
        }
        if (!res.ok) {
          throw new Error(data.error || `Action failed (HTTP ${res.status})`);
        }
        setBanner(
          data.already_reviewed && data.message
            ? data.message
            : `${investor?.name ?? 'Investor'} ${
                decision === 'verified_investor'
                  ? 'approved as a verified investor'
                  : 'marked as rejected'
              }.`,
        );
        setNote('');
        setKycGate(null);
        setKycAck(false);
        await fetchDetail();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setActioning(false);
      }
    },
    [accessToken, actioning, investor, note, kycAck, fetchDetail],
  );

  // ── CRM (notes + tags) ──
  const [crmBusy, setCrmBusy] = useState(false);
  const [crmError, setCrmError] = useState<string | null>(null);
  const crmAction = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!accessToken || !userId || crmBusy) return;
      setCrmBusy(true);
      setCrmError(null);
      try {
        const res = await fetch(functionUrl('fund-payment-admin-crm'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ userId, ...payload }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
        setInvestor((prev) =>
          prev ? { ...prev, notes: data.notes ?? prev.notes, tags: data.tags ?? prev.tags } : prev,
        );
      } catch (err) {
        setCrmError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setCrmBusy(false);
      }
    },
    [accessToken, userId, crmBusy],
  );
  const addNote = useCallback((text: string) => crmAction({ action: 'add_note', body: text }), [crmAction]);
  const addTag = useCallback((tag: string) => crmAction({ action: 'add_tag', tag }), [crmAction]);
  const removeTag = useCallback((tag: string) => crmAction({ action: 'remove_tag', tag }), [crmAction]);

  // ── Ops actions (resend link, nudge email) ──
  const [opsBusy, setOpsBusy] = useState<string | null>(null);
  const [opsBanner, setOpsBanner] = useState<string | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const callOps = useCallback(
    async (fn: string, payload: Record<string, unknown>, key: string, successMsg: (data: any) => string) => {
      if (!accessToken || !userId || opsBusy) return;
      setOpsBusy(key);
      setOpsError(null);
      setOpsBanner(null);
      try {
        const res = await fetch(functionUrl(fn), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ userId, ...payload }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
        setOpsBanner(successMsg(data));
      } catch (err) {
        setOpsError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setOpsBusy(null);
      }
    },
    [accessToken, userId, opsBusy],
  );
  const resendLink = useCallback(
    () =>
      callOps('fund-payment-admin-resend', {}, 'resend', (d) =>
        d.email_sent ? 'Payment link re-sent to the investor.' : 'Active link found, but the email could not be sent.',
      ),
    [callOps],
  );
  const sendReminder = useCallback(
    (reminderType: string) =>
      callOps('fund-payment-admin-remind', { reminderType }, `remind:${reminderType}`, (d) =>
        d.email_sent ? 'Reminder sent to the investor.' : 'Could not send — no email on file.',
      ),
    [callOps],
  );

  // ── KYC review (record a manual sanctions/PEP outcome) ──
  const [kycBusy, setKycBusy] = useState(false);
  const [kycError, setKycError] = useState<string | null>(null);
  const recordKycReview = useCallback(
    async (payload: {
      decision: 'cleared' | 'flagged';
      riskBand?: string;
      sanctionsChecked?: boolean;
      pepChecked?: boolean;
      note?: string;
    }) => {
      if (!accessToken || !userId || kycBusy) return;
      setKycBusy(true);
      setKycError(null);
      setOpsBanner(null);
      try {
        const res = await fetch(functionUrl('fund-payment-admin-kyc-review'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ userId, ...payload }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
        setOpsBanner(
          payload.decision === 'cleared'
            ? 'KYC review recorded — investor cleared.'
            : 'KYC review recorded — investor flagged.',
        );
        // A fresh cleared review changes the approval gate; reset + reload.
        setKycGate(null);
        setKycAck(false);
        await fetchDetail();
      } catch (err) {
        setKycError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setKycBusy(false);
      }
    },
    [accessToken, userId, kycBusy, fetchDetail],
  );

  // ── Automated KYC screen (provider; inert until KYC_PROVIDER + key are set) ──
  const [screenBusy, setScreenBusy] = useState(false);
  const runAutomatedScreen = useCallback(async () => {
    if (!accessToken || !userId || screenBusy) return;
    setScreenBusy(true);
    setKycError(null);
    setOpsBanner(null);
    try {
      const res = await fetch(functionUrl('fund-payment-admin-kyc-screen'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
      setOpsBanner(
        data.decision === 'cleared'
          ? 'Automated screen: cleared (0 matches).'
          : `Automated screen: ${data.matchCount ?? 'some'} match(es) — flagged for review.`,
      );
      setKycGate(null);
      setKycAck(false);
      await fetchDetail();
    } catch (err) {
      setKycError(err instanceof Error ? err.message : 'Screening failed');
    } finally {
      setScreenBusy(false);
    }
  }, [accessToken, userId, screenBusy, fetchDetail]);

  const canReview = useMemo(
    () => investor?.investment?.status === 'pending_manual_verification' && Boolean(investor?.timeline.firstPaidAt),
    [investor],
  );

  return {
    investor,
    sourceWarnings,
    loading,
    error,
    note,
    setNote,
    actioning,
    actionError,
    banner,
    canReview,
    approve: () => act('verified_investor'),
    reject: () => act('rejected'),
    refresh: fetchDetail,
    // CRM
    addNote,
    addTag,
    removeTag,
    crmBusy,
    crmError,
    // Ops
    resendLink,
    sendReminder,
    opsBusy,
    opsBanner,
    opsError,
    // KYC gate
    kycGate,
    kycAck,
    setKycAck,
    // KYC review
    recordKycReview,
    kycBusy,
    kycError,
    // Automated screen
    runAutomatedScreen,
    screenBusy,
  };
}
