import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays,
  LineChart,
  MapPin,
  Phone,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import config from '../../../resources/config/config';
import { trackCta, trackStepCompleted } from '../../../services/onboarding/onboardingAnalytics';
import { submitApplication, getProofOfFunds, getFundingNameMatch } from '../../../services/onboarding/inviteService';
import { REVIEW_GATE_REASON_LABELS } from '../../../services/onboarding/reviewGate';
import { PROOF_OF_FUNDS_LABELS, type ProofOfFundsStatus } from '../../../services/onboarding/proofOfFunds';
import { FUNDING_NAME_MATCH_LABELS, type FundingNameMatchStatus } from '../../../services/onboarding/fundingNameMatch';
import { useReviewAccountTypeGate } from './accountTypeGate';
import HushhTechBackHeader from '../../../components/hushh-tech-back-header/HushhTechBackHeader';
import OnboardingBankReviewChip from '../../../components/onboarding-bank-review-chip/OnboardingBankReviewChip';
import { OnboardingStepJumpNav } from '../../../components/onboarding/OnboardingStepJumpNav';
import HushhTechCta, {
  HushhTechCtaVariant,
} from '../../../components/hushh-tech-cta/HushhTechCta';
import {
  getOnboardingDisplayMeta,
  isCurrentLocalOnboardingPreview,
  withLocalOnboardingPreview,
} from '../../../services/onboarding/flow';
import {
  AppleLineIcon,
  Display,
  Eyebrow,
  Lede,
  appleFont,
} from '../../../components/hushh-tech-ui/HushhAppleUI';
import {
  OptionalMarker,
  RequiredAsterisk,
} from '../../../components/onboarding-field-marker/FieldMarkers';

interface ReviewSummary {
  legal_first_name: string | null;
  legal_last_name: string | null;
  date_of_birth: string | null;
  phone_number: string | null;
  phone_country_code: string | null;
  citizenship_country: string | null;
  residence_country: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  address_country: string | null;
  ssn_encrypted: string | null;
  account_type: string | null;
  class_a_units: number | null;
  class_b_units: number | null;
  class_c_units: number | null;
  initial_investment_amount: number | null;
  recurring_amount: number | null;
  recurring_frequency: string | null;
  recurring_day_of_month: number | null;
}

const DISPLAY_META = getOnboardingDisplayMeta('/onboarding/step-5');
const PROGRESS_PCT = Math.round((DISPLAY_META.displayStep / DISPLAY_META.totalSteps) * 100);
const primaryCtaClass =
  "!rounded-full !border-[#0066CC] !bg-[#0066CC] !text-white !font-medium !tracking-[-0.01em] !shadow-none";
const secondaryCtaClass =
  "!rounded-full !border-[#1D1D1F]/15 !bg-white !text-[#1D1D1F] !font-medium !tracking-[-0.01em] !shadow-none";

const formatCurrency = (amount: number | null | undefined) => {
  if (!amount) return 'Not set';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
};

const formatRecurringSummary = (data: ReviewSummary) => {
  if (!data.recurring_amount) return 'Optional recurring investment not added';
  const frequency = (data.recurring_frequency || 'once_a_month').replace(/_/g, ' ');
  const day = data.recurring_day_of_month === 31 ? 'Last day' : `Day ${data.recurring_day_of_month || 1}`;
  return `${formatCurrency(data.recurring_amount)} • ${frequency} • ${day}`;
};

const joinParts = (parts: Array<string | null | undefined>, fallback = 'Not provided') => {
  const value = parts.map((part) => (part || '').trim()).filter(Boolean).join(', ');
  return value || fallback;
};

const formatDate = (date: string | null | undefined) => {
  if (!date) return 'Missing required detail';
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

const isUnitedStates = (value: string | null | undefined) =>
  ['united states', 'usa', 'us', 'united states of america'].includes(
    (value || '').trim().toLowerCase()
  );

const SummaryRow = ({
  icon,
  label,
  value,
  editLabel,
  onEdit,
  required = false,
  optional = false,
  missing = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  editLabel: string;
  onEdit: () => void;
  required?: boolean;
  optional?: boolean;
  missing?: boolean;
}) => (
  <div
    className={`rounded-[20px] bg-white p-4 sm:rounded-[22px] ${
      missing
        ? 'shadow-[inset_0_0_0_1px_rgba(255,59,48,0.28)]'
        : 'shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.10)]'
    }`}
  >
    <div className="flex items-start gap-4">
      <AppleLineIcon icon={icon} size={42} />
      <div className="flex-1 min-w-0">
        <span className="mb-1 block text-[14px] font-medium text-[#1D1D1F]">
          {label}
          {required && <RequiredAsterisk />}
          {optional && <OptionalMarker />}
        </span>
        <span
          className={`text-[13px] font-normal leading-relaxed ${
            missing ? 'text-[#B42318]' : 'text-[#1D1D1F]/60'
          }`}
        >
          {value}
        </span>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 rounded-full bg-[#F5F5F7] px-3 py-1.5 text-[12px] font-medium text-[#0066CC] transition hover:bg-[#ECECF0]"
      >
        {editLabel}
      </button>
    </div>
  </div>
);

export default function OnboardingReviewStep() {
  const navigate = useNavigate();
  const isPreview = isCurrentLocalOnboardingPreview();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.classList.add('onboarding-page-scroll');
    document.body.classList.add('onboarding-page-scroll');

    return () => {
      document.documentElement.classList.remove('onboarding-page-scroll');
      document.body.classList.remove('onboarding-page-scroll');
    };
  }, []);

  useEffect(() => {
    const loadSummary = async () => {
      if (isPreview) {
        const saved = window.localStorage.getItem('hushh_onboarding_preview');
        setSummary((saved ? JSON.parse(saved) : null) as ReviewSummary | null);
        setLoading(false);
        return;
      }

      if (!config.gcpBackendClient) {
        setError('Configuration error');
        setLoading(false);
        return;
      }

      const { data: { user } } = await config.gcpBackendClient.auth.getUser();
      if (!user) {
        navigate('/login', { replace: true });
        return;
      }

      const { data, error: fetchError } = await config.gcpBackendClient
        .from('onboarding_data')
        .select(`
          legal_first_name, legal_last_name, date_of_birth,
          phone_number, phone_country_code,
          ssn_encrypted, account_type,
          citizenship_country, residence_country,
          address_line_1, address_line_2, city, state, zip_code, address_country,
          class_a_units, class_b_units, class_c_units,
          initial_investment_amount,
          recurring_amount, recurring_frequency, recurring_day_of_month
        `)
        .eq('user_id', user.id)
        .maybeSingle();

      if (fetchError) {
        setError('Failed to load your onboarding summary');
        setLoading(false);
        return;
      }

      setSummary((data || null) as ReviewSummary | null);
      setLoading(false);
    };

    loadSummary();
  }, [isPreview, navigate]);

  const fullName = joinParts([
    summary?.legal_first_name,
    summary?.legal_last_name,
  ]);
  const isFullNameMissing = !summary?.legal_first_name?.trim() || !summary?.legal_last_name?.trim();
  const isDateOfBirthMissing = !summary?.date_of_birth;

  const phone = joinParts([
    summary?.phone_country_code,
    summary?.phone_number,
  ]);
  const isPhoneMissing = !summary?.phone_number?.trim();

  const residence = joinParts([
    summary?.residence_country,
    summary?.citizenship_country ? `Citizen of ${summary.citizenship_country}` : null,
  ]);
  const isResidenceMissing = !summary?.residence_country?.trim() || !summary?.citizenship_country?.trim();

  const address = joinParts([
    summary?.address_line_1,
    summary?.city,
    summary?.state,
    summary?.zip_code,
    summary?.address_country,
  ]);
  const isAddressMissing =
    !summary?.address_line_1?.trim() ||
    !summary?.city?.trim() ||
    !summary?.state?.trim() ||
    !summary?.zip_code?.trim();

  const shareUnits = [
    summary?.class_a_units ? `${summary.class_a_units} Class A` : null,
    summary?.class_b_units ? `${summary.class_b_units} Class B` : null,
    summary?.class_c_units ? `${summary.class_c_units} Class C` : null,
  ].filter(Boolean).join(' • ') || 'No share units selected';

  // US-person determination must consider citizenship OR residence (consistent
  // with step-3/step-6) — a US citizen residing abroad is still a US person for
  // SSN/tax. Using residence-only here let that case slip through review.
  const isUsInvestor =
    isUnitedStates(summary?.residence_country) || isUnitedStates(summary?.citizenship_country);
  const isSsnMissing = isUsInvestor && (!summary?.ssn_encrypted || summary.ssn_encrypted === '999-99-9999');
  const ssnStatus = summary?.ssn_encrypted && summary.ssn_encrypted !== '999-99-9999'
    ? 'Provided for tax reporting'
    : isUsInvestor ? 'Missing required detail' : 'Optional for non-US investors';
  const accountType = summary?.account_type
    ? summary.account_type.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
    : 'Not selected';
  const isAccountTypeMissing = !summary?.account_type;
  const isInvestmentMissing = !summary?.initial_investment_amount || shareUnits === 'No share units selected';
  const requiredMissing =
    isAccountTypeMissing ||
    isFullNameMissing ||
    isDateOfBirthMissing ||
    isPhoneMissing ||
    isResidenceMissing ||
    isAddressMissing ||
    isSsnMissing ||
    isInvestmentMissing;
  const goTo = (route: string) => navigate(withLocalOnboardingPreview(route));
  const atGate = useReviewAccountTypeGate();
  const [submitting, setSubmitting] = useState(false);
  const [proofOfFunds, setProofOfFunds] = useState<ProofOfFundsStatus | null>(null);
  const [fundingNameMatch, setFundingNameMatch] = useState<FundingNameMatchStatus | null>(null);

  useEffect(() => {
    let active = true;
    getProofOfFunds()
      .then((r) => { if (active) setProofOfFunds(r.status); })
      .catch(() => {});
    // Trust/retirement: surface the bank holder-name vs entity/custodian match.
    getFundingNameMatch()
      .then((r) => { if (active && r.applicable) setFundingNameMatch(r.status); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const handleContinueToPayment = async () => {
    trackCta('continue', 'step-5');
    // Account-type accounts (Joint/Retirement/Trust) must clear the parties +
    // signatory + account-type-fields gate, server-validated, before proceeding.
    if (atGate.accountType && atGate.accountType !== 'individual') {
      setSubmitting(true);
      try {
        await submitApplication();
      } catch (e) {
        await atGate.refresh();
        setError(e instanceof Error ? e.message : 'Application is not ready to submit yet.');
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }
    trackStepCompleted('step-5', 5);
    goTo('/onboarding/step-6');
  };

  return (
    <div
      className="flex min-h-screen flex-col bg-[#FFFFFF] text-[#1D1D1F] antialiased selection:bg-[#0066CC] selection:text-[#F5F5F7]"
      style={{ fontFamily: appleFont }}
    >
      <HushhTechBackHeader onBackClick={() => navigate('/onboarding/step-4')} rightLabel="FAQ" />
      <OnboardingBankReviewChip />

      <main className="mx-auto w-full max-w-[680px] flex-grow px-4 pb-48 sm:px-5">
        <div className="pb-6 pt-5">
          <div className="mb-3 flex justify-between text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
            <span>Step {DISPLAY_META.displayStep}/{DISPLAY_META.totalSteps}</span>
            <span>{PROGRESS_PCT}% Complete</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-[#1D1D1F]/10">
            <div className="h-full rounded-full bg-[#0066CC] transition-all duration-500" style={{ width: `${PROGRESS_PCT}%` }} />
          </div>
          <OnboardingStepJumpNav currentStep={DISPLAY_META.displayStep} totalSteps={DISPLAY_META.totalSteps} />
        </div>

        <section className="pb-8 pt-8 text-center">
          <Eyebrow>Review</Eyebrow>
          <Display as="h1" size="xs" maxWidth="max-w-[500px]">
            Review your application.
            <RequiredAsterisk />
          </Display>
          <Lede className="max-w-[500px]">
            Check the important investor details once. Edit anything that needs correction.
          </Lede>
        </section>

        {loading && (
          <div className="grid animate-pulse gap-3">
            {[1, 2, 3, 4].map((item) => (
              <div key={item} className="h-20 rounded-[20px] bg-[#F5F5F7] shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]" />
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="mb-6 flex items-center gap-3 rounded-[18px] bg-[#FF3B30]/10 px-4 py-4 shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
            <AppleLineIcon icon={ShieldCheck} size={40} className="text-[#FF3B30]" />
            <p className="text-[14px] font-medium text-[#B42318]">{error}</p>
          </div>
        )}

        {!loading && !error && (
          <>
            <section className="mb-8 rounded-[24px] bg-[#F5F5F7] p-3 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)] sm:p-4">
              <div className="py-4">
                <h3 className="px-1 text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
                  Required Application Details
                  <RequiredAsterisk />
                </h3>
                {requiredMissing && (
                  <p className="mt-2 px-1 text-[12px] font-normal leading-[1.45] text-[#B42318]">
                    Complete the missing required details before moving to payment.
                  </p>
                )}
              </div>
              <div className="grid gap-3">
              <SummaryRow
                icon={ShieldCheck}
                label="Account Type"
                value={isAccountTypeMissing ? 'Missing required detail' : accountType}
                editLabel="Edit"
                onEdit={() => goTo('/onboarding/step-2?from=review')}
                required
                missing={isAccountTypeMissing}
              />
              <SummaryRow
                icon={UserRound}
                label="Legal Name"
                value={isFullNameMissing ? 'Missing required detail' : fullName}
                editLabel="Edit"
                onEdit={() => goTo('/onboarding/step-3?from=review')}
                required
                missing={isFullNameMissing}
              />
              <SummaryRow
                icon={CalendarDays}
                label="Date of Birth"
                value={formatDate(summary?.date_of_birth)}
                editLabel="Edit"
                onEdit={() => goTo('/onboarding/step-3?from=review')}
                required
                missing={isDateOfBirthMissing}
              />
              <SummaryRow
                icon={Phone}
                label="Contact Number"
                value={
                  isPhoneMissing
                    ? 'Missing required detail'
                    : phone
                }
                editLabel="Edit"
                onEdit={() => goTo('/onboarding/step-3?from=review')}
                required
                missing={isPhoneMissing}
              />
              <SummaryRow
                icon={MapPin}
                label="Residence"
                value={isResidenceMissing ? 'Missing required detail' : residence}
                editLabel="Edit"
                onEdit={() => goTo('/onboarding/step-3?from=review')}
                required
                missing={isResidenceMissing}
              />
              <SummaryRow
                icon={MapPin}
                label="Address"
                value={isAddressMissing ? 'Missing required detail' : address}
                editLabel="Edit"
                onEdit={() => goTo('/onboarding/step-3?from=review')}
                required
                missing={isAddressMissing}
              />
              <SummaryRow
                icon={ShieldCheck}
                label="Tax Reporting"
                value={ssnStatus}
                editLabel="Edit"
                onEdit={() => goTo('/onboarding/step-3?from=review')}
                required={isUsInvestor}
                optional={!isUsInvestor}
                missing={isSsnMissing}
              />
              <SummaryRow
                icon={LineChart}
                label="Investment"
                value={
                  isInvestmentMissing
                    ? 'Missing required detail'
                    : `${formatCurrency(summary?.initial_investment_amount)} • ${shareUnits}`
                }
                editLabel="Edit"
                onEdit={() => goTo('/onboarding/step-4?from=review')}
                required
                missing={isInvestmentMissing}
              />
              </div>
            </section>

            <section className="mb-8 rounded-[24px] bg-[#F5F5F7] p-3 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)] sm:p-4">
              <div className="py-4">
                <h3 className="px-1 text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
                  Skippable Details
                  <OptionalMarker />
                </h3>
              </div>
              <div className="grid gap-3">
                <SummaryRow
                  icon={MapPin}
                  label="Apt / Suite"
                  value={summary?.address_line_2?.trim() || 'Skipped'}
                  editLabel="Edit"
                  onEdit={() => goTo('/onboarding/step-3?from=review')}
                  optional
                />
                <SummaryRow
                  icon={LineChart}
                  label="Recurring Investment"
                  value={formatRecurringSummary(summary || {} as ReviewSummary)}
                  editLabel="Edit"
                  onEdit={() => goTo('/onboarding/step-4?from=review')}
                  optional
                />
              </div>
            </section>

            {proofOfFunds && (
              <section className="mb-4 flex items-center justify-between rounded-[18px] bg-[#F5F5F7] px-4 py-3 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
                <span className="text-[12px] font-medium uppercase tracking-[1.3px] text-[#1D1D1F]/55">
                  Proof of funds
                </span>
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                    proofOfFunds === 'funds_sufficient'
                      ? 'bg-[#34C759]/12 text-[#1E7A33]'
                      : proofOfFunds === 'funds_insufficient'
                      ? 'bg-[#FF9500]/12 text-[#B25E00]'
                      : 'bg-[#1D1D1F]/8 text-[#1D1D1F]/60'
                  }`}
                >
                  {PROOF_OF_FUNDS_LABELS[proofOfFunds]}
                </span>
              </section>
            )}

            {fundingNameMatch && (
              <section className="mb-4 flex items-center justify-between rounded-[18px] bg-[#F5F5F7] px-4 py-3 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
                <span className="text-[12px] font-medium uppercase tracking-[1.3px] text-[#1D1D1F]/55">
                  Bank account name
                </span>
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                    fundingNameMatch === 'match'
                      ? 'bg-[#34C759]/12 text-[#1E7A33]'
                      : fundingNameMatch === 'mismatch'
                      ? 'bg-[#FF9500]/12 text-[#B25E00]'
                      : 'bg-[#1D1D1F]/8 text-[#1D1D1F]/60'
                  }`}
                >
                  {FUNDING_NAME_MATCH_LABELS[fundingNameMatch]}
                </span>
              </section>
            )}

            {!atGate.ok && atGate.reasons.length > 0 && (
              <section className="mb-4 rounded-[18px] bg-[#FF9500]/10 px-4 py-4 shadow-[inset_0_0_0_1px_rgba(255,149,0,0.22)]">
                <p className="text-[12px] font-medium uppercase tracking-[1.4px] text-[#B25E00]">
                  Finish before submitting
                </p>
                <ul className="mt-2 space-y-1">
                  {atGate.reasons.map((reason) => (
                    <li key={reason} className="text-[13px] font-normal text-[#1D1D1F]/70">
                      • {REVIEW_GATE_REASON_LABELS[reason]}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="pb-12 space-y-3">
              <HushhTechCta
                variant={HushhTechCtaVariant.BLACK}
                onClick={handleContinueToPayment}
                disabled={requiredMissing || !atGate.ok || atGate.loading || submitting}
                className={primaryCtaClass}
              >
                {submitting ? 'Submitting…' : 'Continue to Payment'}
              </HushhTechCta>
              <HushhTechCta
                variant={HushhTechCtaVariant.WHITE}
                onClick={() => goTo('/onboarding/step-4')}
                className={secondaryCtaClass}
              >
                Back to Investment Summary
              </HushhTechCta>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
