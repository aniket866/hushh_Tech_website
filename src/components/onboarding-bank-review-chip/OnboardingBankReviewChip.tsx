/**
 * OnboardingBankReviewChip — subtle "Review bank verification" link that
 * any onboarding step page can drop in just below the back header. Solves
 * P0.B discoverability: a user mid-KYC (e.g., step 5) who wants to change
 * their linked bank no longer has to back-chain through every prior step
 * to reach financial-link review mode.
 *
 * Render notes:
 * - Designed to be unobtrusive — small text, blue link, no background card.
 * - Renders nothing when the user has no onboarding row yet (e.g., a fresh
 *   visitor accidentally on a step page). Real discoverability only
 *   matters once Plaid has been touched.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuthSession } from "../../auth/AuthSessionProvider";
import config from "../../resources/config/config";
import {
  FINANCIAL_LINK_REVIEW_ROUTE,
  normalizeFinancialLinkStatus,
  type FinancialLinkStatus,
} from "../../services/onboarding/flow";
import { appleFont } from "../hushh-tech-ui/HushhAppleUI";

interface OnboardingBankReviewChipProps {
  /** Optional override for the visible label. */
  label?: string;
  /** Hide the chip when the access state is in a "post-payment" position. */
  hideWhenInvestor?: boolean;
}

const labelForStatus = (status: FinancialLinkStatus): string => {
  if (status === "completed") return "Review or change your linked bank";
  if (status === "skipped") return "Connect a bank to speed up review";
  return "Set up your bank verification";
};

const iconForStatus = (status: FinancialLinkStatus): string => {
  if (status === "completed") return "swap_horiz";
  if (status === "skipped") return "add_link";
  return "verified_user";
};

const OnboardingBankReviewChip: React.FC<OnboardingBankReviewChipProps> = ({
  label,
  hideWhenInvestor = true,
}) => {
  const { session } = useAuthSession();
  const [status, setStatus] = useState<FinancialLinkStatus | null>(null);
  const [shouldRender, setShouldRender] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!session?.user?.id || !config.gcpBackendClient) {
        if (!cancelled) setShouldRender(false);
        return;
      }
      try {
        const { data } = await config.gcpBackendClient
          .from("onboarding_data")
          .select("financial_link_status, fund_payment_status")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (cancelled) return;
        if (!data) {
          setShouldRender(false);
          return;
        }
        const normalized = normalizeFinancialLinkStatus(data.financial_link_status);
        const paidStatuses = ["paid", "pending_manual_verification"];
        const isInvestor = paidStatuses.includes(String(data.fund_payment_status || ""));
        // Hide once payment locks the bank anyway.
        if (hideWhenInvestor && isInvestor) {
          setShouldRender(false);
          return;
        }
        setStatus(normalized);
        setShouldRender(true);
      } catch {
        if (!cancelled) setShouldRender(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, hideWhenInvestor]);

  if (!shouldRender || !status) return null;

  const display = label ?? labelForStatus(status);
  const icon = iconForStatus(status);

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pt-3 sm:px-5" style={{ fontFamily: appleFont }}>
      <Link
        to={FINANCIAL_LINK_REVIEW_ROUTE}
        className="inline-flex items-center gap-1.5 rounded-full bg-[#0066CC]/[0.06] px-3 py-1.5 text-[12px] font-medium text-[#0066CC] transition hover:bg-[#0066CC]/[0.12]"
      >
        <span className="material-symbols-outlined text-[15px]">{icon}</span>
        <span>{display}</span>
      </Link>
    </div>
  );
};

export default OnboardingBankReviewChip;
