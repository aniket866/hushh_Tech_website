/**
 * Step 9 - Hushh Fund payment request.
 * Plaid stays the verification layer; Stripe is the money collection layer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import config from "../../../resources/config/config";
import {
  createFundPaymentRequest,
  getFundPaymentStatus,
  redeemFundCoupon,
  type FundPaymentRequestResponse,
  type FundPaymentStatusResponse,
} from "../../../services/fundPayment/fundPaymentService";
import {
  fetchLinkedTransferAccounts,
  type LinkedTransferAccount,
} from "../../../services/plaid/plaidService";
import { upsertOnboardingData } from "../../../services/onboarding/upsertOnboardingData";
import { trackCta, trackStepCompleted } from "../../../services/onboarding/onboardingAnalytics";
import { CONSENT_VERSION } from "../../../services/consent/consentConfig";
import {
  FINANCIAL_LINK_ROUTE,
  isCurrentLocalOnboardingPreview,
  withLocalOnboardingPreview,
} from "../../../services/onboarding/flow";
import {
  FUND_PAYMENT_PAID_STATUSES,
  FUND_PAYMENT_REVERSED_STATUSES,
} from "../../../services/investorAccess/state";
import { consumeInvestorAccessFlash } from "../../../components/InvestorAccessRoute";
import { useFooterVisibility } from "../../../utils/useFooterVisibility";

export interface ShareClassInfo {
  id: string;
  name: string;
  unitPrice: number;
  color: string;
}

export const SHARE_CLASSES: ShareClassInfo[] = [
  { id: "class_a", name: "Class A", unitPrice: 25000000, color: "#6B7280" },
  { id: "class_b", name: "Class B", unitPrice: 5000000, color: "#B8860B" },
  { id: "class_c", name: "Class C", unitPrice: 1000000, color: "#0066CC" },
];

export interface PlaidAccount {
  accountId: string;
  name: string;
  mask: string;
  subtype: string;
  type: string;
  institutionName?: string | null;
  currentBalance?: number | null;
}

export const formatCurrency = (amount: number): string => {
  if (!Number.isFinite(amount)) return "$0";
  if (amount >= 1000000000) return `$${(amount / 1000000000).toFixed(1)}B`;
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(0)}M`;
  if (amount >= 1000) return `$${Math.round(amount).toLocaleString()}`;
  return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

export const parseCurrencyInput = (value: string): number => {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatRecurringFrequency = (value?: string | null): string => {
  if (!value) return "Not selected";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const formatRecurringDay = (day?: number | null): string => {
  if (!day) return "day 1";
  if (day === 31) return "last day of the month";
  return `day ${day}`;
};

const sanitizePaymentInput = (value: string): string => {
  const cleaned = value.replace(/[^\d.]/g, "");
  const [dollars, cents = ""] = cleaned.split(".");
  const safeDollars = dollars.slice(0, 12);
  const safeCents = cents.slice(0, 2);
  return cleaned.includes(".") ? `${safeDollars}.${safeCents}` : safeDollars;
};

export interface Step13Logic {
  loading: boolean;
  pageLoading: boolean;
  error: string | null;
  successMessage: string | null;
  isFooterVisible: boolean;
  plaidAccounts: PlaidAccount[];
  plaidInstitutionName: string;
  hasPlaidVerificationData: boolean;
  financialLinkStatus: string;
  shareUnits: { class_a_units: number; class_b_units: number; class_c_units: number };
  totalInvestment: number;
  hasAnyUnits: boolean;
  recurringEnabled: boolean;
  recurringAmount: number;
  recurringFrequency: string | null;
  recurringDayOfMonth: number | null;
  recurringSummary: string;
  firstPaymentAmount: string;
  firstPaymentValue: number;
  firstPaymentError: string | null;
  remainingAfterFirstPayment: number;
  paymentRequest: FundPaymentRequestResponse | null;
  latestPaymentStatus: FundPaymentStatusResponse["latest_request"];
  latestReviewStatus: string;
  /**
   * Derived step-9 UX state — drives which banner / CTAs the UI renders.
   */
  uxState:
    | "awaiting_request"
    | "request_sent"
    | "payment_in_review"
    | "verified"
    | "payment_reversed";
  flashBanner: "needs_payment" | "payment_reversed" | null;
  /** Whether the "start over" affordance should be visible on this page. */
  canStartOver: boolean;
  /** Modal open + busy + error state for the start-over confirmation. */
  isStartOverConfirmOpen: boolean;
  isStartingOver: boolean;
  startOverError: string | null;
  openStartOverConfirm: () => void;
  closeStartOverConfirm: () => void;
  handleConfirmStartOver: () => Promise<void>;
  /** Single combined commitment acknowledgment (risk + eligibility + Subscription). */
  commitmentAcknowledged: boolean;
  commitmentAckError: boolean;
  handleCommitmentAckChange: (checked: boolean) => void;
  /** Coupon redemption (skip $1, same outcome). */
  couponCode: string;
  couponError: string | null;
  couponLoading: boolean;
  setCouponCode: (value: string) => void;
  handleApplyCoupon: () => Promise<void>;
  getUnits: (classId: string) => number;
  setFirstPaymentAmount: (value: string) => void;
  handleBack: () => void;
  handleCreatePaymentLink: () => Promise<void>;
  handleContinueToMeetCeo: () => void;
  openPaymentLink: () => void;
}

export const useStep13Logic = (): Step13Logic => {
  const navigate = useNavigate();
  const isPreview = isCurrentLocalOnboardingPreview();
  const isFooterVisible = useFooterVisibility();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccount[]>([]);
  const [plaidInstitutionName, setPlaidInstitutionName] = useState("");
  const [financialLinkStatus, setFinancialLinkStatus] = useState("unknown");
  const [paymentRequest, setPaymentRequest] = useState<FundPaymentRequestResponse | null>(null);
  const [latestPaymentStatus, setLatestPaymentStatus] = useState<FundPaymentStatusResponse["latest_request"]>(null);
  const [latestReviewStatus, setLatestReviewStatus] = useState("not_started");
  const [shareUnits, setShareUnits] = useState({
    class_a_units: 0,
    class_b_units: 0,
    class_c_units: 0,
  });
  const [recurringAmount, setRecurringAmount] = useState(0);
  const [recurringFrequency, setRecurringFrequency] = useState<string | null>(null);
  const [recurringDayOfMonth, setRecurringDayOfMonth] = useState<number | null>(null);
  const [firstPaymentAmount, setFirstPaymentAmountState] = useState("1");
  const [flashBanner, setFlashBanner] = useState<"needs_payment" | "payment_reversed" | null>(null);
  const [isStartOverConfirmOpen, setIsStartOverConfirmOpen] = useState(false);
  const [isStartingOver, setIsStartingOver] = useState(false);
  const [startOverError, setStartOverError] = useState<string | null>(null);
  /* Combined money-commitment acknowledgment (risk + eligibility + Subscription).
     Pre-checked if the user already acknowledged in a prior session. */
  const [commitmentAcknowledged, setCommitmentAcknowledged] = useState(false);
  const [commitmentAckPersisted, setCommitmentAckPersisted] = useState(false);
  const [commitmentAckError, setCommitmentAckError] = useState(false);
  const [couponCodeState, setCouponCodeState] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponLoading, setCouponLoading] = useState(false);
  const isMountedRef = useRef(true);

  // Pull the one-time flash set by InvestorAccessRoute when it redirected
  // the user here (e.g., because they URL-pasted /onboarding/meet-ceo without
  // paying, or their payment was refunded).
  useEffect(() => {
    const reason = consumeInvestorAccessFlash();
    if (reason === "needs_payment" || reason === "payment_reversed") {
      setFlashBanner(reason);
    }
  }, []);

  const totalInvestment = useMemo(() => (
    shareUnits.class_a_units * 25000000 +
    shareUnits.class_b_units * 5000000 +
    shareUnits.class_c_units * 1000000
  ), [shareUnits]);

  const hasAnyUnits = totalInvestment > 0;
  const hasPlaidVerificationData = financialLinkStatus === "completed" || plaidAccounts.length > 0;
  const recurringEnabled = recurringAmount > 0 && Boolean(recurringFrequency);
  const firstPaymentValue = parseCurrencyInput(firstPaymentAmount);
  const remainingAfterFirstPayment = Math.max(0, totalInvestment - firstPaymentValue);

  const firstPaymentError = useMemo(() => {
    if (!firstPaymentAmount.trim()) return "Enter a first payment amount";
    if (firstPaymentValue < 1) return "Minimum first payment is $1";
    if (hasAnyUnits && firstPaymentValue > totalInvestment) {
      return "First payment cannot exceed your selected commitment";
    }
    return null;
  }, [firstPaymentAmount, firstPaymentValue, hasAnyUnits, totalInvestment]);

  const recurringSummary = recurringEnabled
    ? `${formatCurrency(recurringAmount)} ${formatRecurringFrequency(recurringFrequency).toLowerCase()} on ${formatRecurringDay(recurringDayOfMonth)}`
    : "Not selected";

  /**
   * Reads from both the freshly-created paymentRequest (if user just hit
   * Send) and latestPaymentStatus loaded from the backend (so multi-device
   * payment flips propagate through polling).
   */
  const uxState = useMemo<Step13Logic["uxState"]>(() => {
    const liveStatus = String(
      paymentRequest?.status || latestPaymentStatus?.status || "",
    ).toLowerCase();
    const verification = String(latestReviewStatus || "").toLowerCase();
    if (verification === "verified_investor") return "verified";
    if (FUND_PAYMENT_REVERSED_STATUSES.includes(liveStatus)) return "payment_reversed";
    if (FUND_PAYMENT_PAID_STATUSES.includes(liveStatus)) return "payment_in_review";
    if (paymentRequest || latestPaymentStatus) return "request_sent";
    return "awaiting_request";
  }, [paymentRequest, latestPaymentStatus, latestReviewStatus]);

  // Once payment is confirmed (Stripe webhook poll) or the investor is verified,
  // there's nothing left to do on this screen — forward straight to Meet the CEO
  // instead of parking the user on a confirmation page. This also catches a
  // returning, already-paid user who lands back on the payment step. (Coupon
  // redemption navigates directly; this is the safety net for the payment path.)
  useEffect(() => {
    if (pageLoading || isPreview) return;
    if (uxState === "payment_in_review" || uxState === "verified") {
      trackStepCompleted("step-6", 6, "paid");
      navigate(withLocalOnboardingPreview("/onboarding/meet-ceo"), { replace: true });
    }
  }, [uxState, pageLoading, isPreview, navigate]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.classList.add("onboarding-page-scroll");
    document.body.classList.add("onboarding-page-scroll");
    return () => {
      document.documentElement.classList.remove("onboarding-page-scroll");
      document.body.classList.remove("onboarding-page-scroll");
    };
  }, []);

  const loadData = useCallback(async (options: { silent?: boolean } = {}) => {
    if (isPreview) {
      setUserId("local-preview");
      setShareUnits({
        class_a_units: 0,
        class_b_units: 0,
        class_c_units: 1,
      });
      setFinancialLinkStatus("completed");
      setLatestReviewStatus("not_started");
      setPageLoading(false);
      return;
    }

    if (!config.gcpBackendClient) {
      if (!options.silent) setPageLoading(false);
      return;
    }

    try {
      const { data: { user } } = await config.gcpBackendClient.auth.getUser();
      if (!user) {
        navigate("/login");
        return;
      }
      setUserId(user.id);

      /* Best-effort: if the user already acknowledged the commitment in a prior
         session, pre-check the box so we never re-prompt. Separate query +
         swallowed errors so a pending migration never breaks the main load. */
      try {
        const { data: ackRow } = await config.gcpBackendClient
          .from("onboarding_data")
          .select("subscription_agreement_ack_at")
          .eq("user_id", user.id)
          .maybeSingle();
        if (ackRow?.subscription_agreement_ack_at && isMountedRef.current) {
          setCommitmentAcknowledged(true);
          setCommitmentAckPersisted(true);
        }
      } catch {
        // Columns may not exist yet (migration pending) — ignore.
      }

      const { data: onboarding } = await config.gcpBackendClient
        .from("onboarding_data")
        .select(`
          class_a_units, class_b_units, class_c_units,
          initial_investment_amount, recurring_frequency, recurring_amount,
          recurring_day_of_month, financial_link_status,
          fund_payment_status, fund_investor_verification_status
        `)
        .eq("user_id", user.id)
        .maybeSingle();

      if (onboarding) {
        setShareUnits({
          class_a_units: onboarding.class_a_units || 0,
          class_b_units: onboarding.class_b_units || 0,
          class_c_units: onboarding.class_c_units || 0,
        });
        setRecurringAmount(Number(onboarding.recurring_amount || 0));
        setRecurringFrequency(onboarding.recurring_frequency || null);
        setRecurringDayOfMonth(onboarding.recurring_day_of_month || null);
        setFinancialLinkStatus(onboarding.financial_link_status || "unknown");
        if (onboarding.fund_investor_verification_status) {
          setLatestReviewStatus(String(onboarding.fund_investor_verification_status));
        }
      }

      try {
        const linkedAccounts = await fetchLinkedTransferAccounts(user.id);
        if (isMountedRef.current) {
          const mapped = linkedAccounts.map((account: LinkedTransferAccount) => ({
            accountId: account.plaid_account_id,
            name: account.name || account.official_name || "Linked account",
            mask: account.mask || "****",
            subtype: account.subtype || account.type || "account",
            type: account.type || "depository",
            institutionName: account.institution_name,
            currentBalance: account.current_balance,
          }));
          setPlaidAccounts(mapped);
          setPlaidInstitutionName(linkedAccounts[0]?.institution_name || "");
        }
      } catch (plaidError) {
        console.warn("[Step9] Plaid verification summary unavailable:", plaidError);
      }

      try {
        const status = await getFundPaymentStatus(user.id);
        if (isMountedRef.current) {
          setLatestPaymentStatus(status.latest_request);
          setLatestReviewStatus(status.reviews[0]?.status || onboarding?.fund_investor_verification_status || "not_started");
          if (!options.silent && status.latest_request?.first_payment_amount) {
            setFirstPaymentAmountState(String(status.latest_request.first_payment_amount));
          }
        }
      } catch (statusError) {
        console.warn("[Step9] Fund payment status unavailable:", statusError);
      }
    } catch (err) {
      console.error("[Step9] Error loading payment request data:", err);
      if (isMountedRef.current && !options.silent) setError("Unable to load your fund payment details.");
    } finally {
      if (isMountedRef.current && !options.silent) setPageLoading(false);
    }
  }, [isPreview, navigate]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Refresh on tab focus / visibility change so that completing Plaid in
  // another tab, or the Stripe webhook updating the payment row, surfaces
  // without forcing the user to manually reload.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadData({ silent: true });
      }
    };
    const handleFocus = () => {
      void loadData({ silent: true });
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loadData]);

  // Poll fund-payment-status every 10s once a payment request is live and not
  // yet paid, so the UI reflects Stripe webhook progression without a manual
  // refresh.
  useEffect(() => {
    if (!userId) return;
    const liveStatus = paymentRequest?.status || latestPaymentStatus?.status;
    if (!liveStatus) return;
    const terminalStatuses = ["paid", "pending_manual_verification", "verified_investor", "rejected", "refunded", "disputed", "cancelled", "expired"];
    if (terminalStatuses.includes(String(liveStatus))) return;

    const intervalId = setInterval(() => {
      void loadData({ silent: true });
    }, 10_000);
    return () => clearInterval(intervalId);
  }, [userId, paymentRequest?.status, latestPaymentStatus?.status, loadData]);

  const setFirstPaymentAmount = (value: string) => {
    setError(null);
    setSuccessMessage(null);
    setFirstPaymentAmountState(sanitizePaymentInput(value));
  };

  const getUnits = (classId: string): number => {
    if (classId === "class_a") return shareUnits.class_a_units;
    if (classId === "class_b") return shareUnits.class_b_units;
    if (classId === "class_c") return shareUnits.class_c_units;
    return 0;
  };

  const handleCommitmentAckChange = (checked: boolean) => {
    setCommitmentAcknowledged(checked);
    if (checked) setCommitmentAckError(false);
  };

  /* Record the single combined acknowledgment once. One timestamp per gated
     document so the audit trail captures each attestation; upsert drops the
     columns gracefully if the migration hasn't landed. */
  const persistCommitmentAck = async () => {
    if (commitmentAckPersisted || !userId) return true;
    setCommitmentAckPersisted(true);
    const now = new Date().toISOString();
    const { error } = await upsertOnboardingData(userId, {
      risk_acknowledged_at: now,
      eligibility_attested_at: now,
      subscription_agreement_ack_at: now,
      consent_version: CONSENT_VERSION,
    });
    if (error) {
      setCommitmentAckPersisted(false);
      setError(error.message || "Unable to save acknowledgment. Please try again.");
      return false;
    }
    return true;
  };

  const handleCreatePaymentLink = async () => {
    trackCta("send_payment_link", "step-6");
    if (!userId) {
      setError("Not authenticated");
      return;
    }
    if (!hasAnyUnits) {
      setError("Select at least one Hushh Fund unit before creating a payment link.");
      return;
    }
    if (firstPaymentError) {
      setError(firstPaymentError);
      return;
    }
    if (!commitmentAcknowledged) {
      setCommitmentAckError(true);
      setError("Please confirm the acknowledgment below before continuing.");
      return;
    }

    if (isPreview) {
      setError(null);
      setSuccessMessage("Preview only: no secure payment link was created.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const acknowledgmentSaved = await persistCommitmentAck();
    if (!acknowledgmentSaved) {
      return;
    }
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const response = await createFundPaymentRequest({
        userId,
        firstPaymentAmount,
      });
      setPaymentRequest(response);
      setLatestReviewStatus(response.manual_verification_status || "not_started");
      const emailSent = response.email_sent !== false;
      const reused = response.reused === true;
      if (!emailSent) {
        setSuccessMessage(
          reused
            ? "Your existing payment link is still valid. We couldn't email it — use the button below to open it now."
            : "Payment link created. We couldn't send the email — use the button below to open it now.",
        );
      } else {
        setSuccessMessage(
          reused
            ? "Your existing payment link is still valid and has been re-sent to your email."
            : "Secure payment link created and emailed. It is valid for seven days.",
        );
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create payment link");
    } finally {
      setLoading(false);
    }
  };

  const setCouponCode = (value: string) => {
    setCouponError(null);
    setCouponCodeState(value);
  };

  // Coupon path — same gates and outcome as the $1 payment, but the server
  // waives the charge. Mirrors handleCreatePaymentLink's prerequisites
  // (units + commitment acknowledgment) before calling the redeem function.
  const handleApplyCoupon = async () => {
    trackCta("apply_coupon", "step-6");
    if (!userId) {
      setCouponError("Not authenticated");
      return;
    }
    if (!hasAnyUnits) {
      setCouponError("Select at least one Hushh Fund unit before applying a coupon.");
      return;
    }
    if (!commitmentAcknowledged) {
      setCommitmentAckError(true);
      setCouponError("Please confirm the acknowledgment below before continuing.");
      return;
    }
    const trimmedCoupon = couponCodeState.trim();
    if (!trimmedCoupon) {
      setCouponError("Enter a coupon code.");
      return;
    }

    if (isPreview) {
      setCouponError(null);
      setSuccessMessage("Preview only: coupon was not redeemed.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const acknowledgmentSaved = await persistCommitmentAck();
    if (!acknowledgmentSaved) {
      return;
    }
    setCouponLoading(true);
    setCouponError(null);
    setError(null);
    setSuccessMessage(null);
    try {
      await redeemFundCoupon({ userId, couponCode: trimmedCoupon });
      trackStepCompleted("step-6", 6, "coupon");
      // Coupon waives the payment and puts the investor into review — forward
      // straight to Meet the CEO instead of parking them on this confirmation
      // screen.
      navigate(withLocalOnboardingPreview("/onboarding/meet-ceo"), { replace: true });
    } catch (err) {
      setCouponError(err instanceof Error ? err.message : "Failed to redeem coupon");
    } finally {
      setCouponLoading(false);
    }
  };

  const handleBack = () => {
    navigate(withLocalOnboardingPreview("/onboarding/step-5"));
  };

  const openPaymentLink = () => {
    const url = paymentRequest?.payment_url;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleContinueToMeetCeo = () => {
    trackCta("meet_ceo_continue", "step-6");
    navigate(withLocalOnboardingPreview("/onboarding/meet-ceo"));
  };

  // PD-? (P2.1 — "Start over"): pre-payment users can request a clean
  // restart of their onboarding without contacting support. Hidden once
  // payment is confirmed because the post-payment state is intentionally
  // hard to walk away from.
  const openStartOverConfirm = () => {
    setStartOverError(null);
    setIsStartOverConfirmOpen(true);
  };
  const closeStartOverConfirm = () => {
    if (isStartingOver) return;
    setIsStartOverConfirmOpen(false);
    setStartOverError(null);
  };
  const handleConfirmStartOver = async () => {
    if (!userId) return;
    if (isPreview) {
      setIsStartOverConfirmOpen(false);
      navigate(withLocalOnboardingPreview("/onboarding/step-1"), { replace: true });
      return;
    }
    setIsStartingOver(true);
    setStartOverError(null);
    try {
      // Note: payment history (fund_stripe_payment_requests, fund_stripe_payments)
      // is intentionally untouched. We only reset the onboarding shell so the
      // user can re-pick units, recurring schedule, KYC data.
      const { error: upsertError } = await upsertOnboardingData(userId, {
        current_step: 1,
        is_completed: false,
        financial_link_status: "pending",
        fund_payment_status: "not_started",
        class_a_units: 0,
        class_b_units: 0,
        class_c_units: 0,
        recurring_amount: 0,
        recurring_frequency: null,
        recurring_day_of_month: null,
      });
      if (upsertError) {
        setStartOverError(upsertError.message || "Failed to reset onboarding");
        return;
      }
      setIsStartOverConfirmOpen(false);
      navigate(FINANCIAL_LINK_ROUTE, { replace: true });
    } catch (err) {
      setStartOverError(err instanceof Error ? err.message : "Failed to reset onboarding");
    } finally {
      setIsStartingOver(false);
    }
  };

  return {
    loading,
    pageLoading,
    error,
    successMessage,
    isFooterVisible,
    plaidAccounts,
    plaidInstitutionName,
    hasPlaidVerificationData,
    financialLinkStatus,
    shareUnits,
    totalInvestment,
    hasAnyUnits,
    recurringEnabled,
    recurringAmount,
    recurringFrequency,
    recurringDayOfMonth,
    recurringSummary,
    firstPaymentAmount,
    firstPaymentValue,
    firstPaymentError,
    remainingAfterFirstPayment,
    paymentRequest,
    latestPaymentStatus,
    latestReviewStatus,
    uxState,
    flashBanner,
    canStartOver: uxState === "awaiting_request" || uxState === "request_sent",
    isStartOverConfirmOpen,
    isStartingOver,
    startOverError,
    openStartOverConfirm,
    closeStartOverConfirm,
    handleConfirmStartOver,
    commitmentAcknowledged,
    commitmentAckError,
    handleCommitmentAckChange,
    couponCode: couponCodeState,
    couponError,
    couponLoading,
    setCouponCode,
    handleApplyCoupon,
    getUnits,
    setFirstPaymentAmount,
    handleBack,
    handleCreatePaymentLink,
    handleContinueToMeetCeo,
    openPaymentLink,
  };
};
