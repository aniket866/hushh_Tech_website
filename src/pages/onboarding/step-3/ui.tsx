/**
 * Step 3 — Confirm Your Residence & Address (Combined)
 *
 * Single page merging country/residence detection + full address entry.
 * Current location is displayed and stored separately; legal residence/address
 * come from bank data or the user's own entry, never live GPS.
 */
import { useRef, useState } from "react";
import {
  useCombinedLocationLogic,
  countries,
  TOTAL_STEPS,
  PROGRESS_PCT,
} from "./logic";
import HushhTechBackHeader from "../../../components/hushh-tech-back-header/HushhTechBackHeader";
import OnboardingBankReviewChip from "../../../components/onboarding-bank-review-chip/OnboardingBankReviewChip";
import { OnboardingStepJumpNav } from "../../../components/onboarding/OnboardingStepJumpNav";
import HushhTechCta, {
  HushhTechCtaVariant,
} from "../../../components/hushh-tech-cta/HushhTechCta";
import PermissionHelpModal from "../../../components/PermissionHelpModal";
import ConsentCheckbox from "../../../components/consent/ConsentCheckbox";
import { useModalKeyboardNavigation } from "../../../hooks/useModalKeyboardNavigation";
import {
  Display,
  Eyebrow,
  Lede,
  appleFont,
} from "../../../components/hushh-tech-ui/HushhAppleUI";
import {
  BankVerifiedMarker,
  OptionalMarker,
  RequiredAsterisk,
} from "../../../components/onboarding-field-marker/FieldMarkers";

const DISPLAY_STEP = 3;
const primaryCtaClass =
  "!rounded-full !border-[#0066CC] !bg-[#0066CC] !text-white !font-medium !tracking-[-0.01em] !shadow-none";
const secondaryCtaClass =
  "!rounded-full !border-[#1D1D1F]/15 !bg-white !text-[#1D1D1F] !font-medium !tracking-[-0.01em] !shadow-none";
const panelClass =
  "rounded-[28px] bg-white p-5 shadow-[0_18px_48px_rgba(29,29,31,0.06),inset_0_0_0_0.5px_rgba(29,29,31,0.08)] sm:p-6";
const fieldClass =
  "min-h-[74px] rounded-[18px] bg-[#F5F5F7] px-4 py-3.5 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]";
const compactFieldClass =
  "min-h-[60px] rounded-[16px] bg-white px-4 py-3 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.12)]";
const labelClass =
  "mb-1 block text-[11px] font-medium uppercase tracking-[1.3px] text-[#1D1D1F]/55";
const compactLabelClass =
  "mb-1 block text-[10px] font-medium uppercase tracking-[1.2px] text-[#1D1D1F]/48";
const inputClass =
  "w-full border-none bg-transparent p-0 text-[16px] font-medium text-[#1D1D1F] outline-none placeholder:text-[#1D1D1F]/42 focus:ring-0";
const selectClass =
  "w-full cursor-pointer appearance-none border-none bg-transparent p-0 pr-7 text-[16px] font-medium text-[#1D1D1F] outline-none";
const compactSelectClass =
  "w-full cursor-pointer appearance-none border-none bg-transparent p-0 pr-7 text-[15px] font-medium text-[#1D1D1F] outline-none";

export default function OnboardingStep3Combined() {
  const s = useCombinedLocationLogic();
  const [isSsnHelpOpen, setIsSsnHelpOpen] = useState(false);
  const locationModalRef = useRef<HTMLDivElement>(null);
  const allowLocationButtonRef = useRef<HTMLButtonElement>(null);

  useModalKeyboardNavigation({
    isOpen: s.showLocationModal,
    containerRef: locationModalRef,
    initialFocusRef: allowLocationButtonRef,
    onClose: s.handleDontAllow,
  });

  return (
    <div
      className="relative flex min-h-screen flex-col overflow-hidden bg-[#FFFFFF] text-[#1D1D1F] antialiased selection:bg-[#0066CC] selection:text-[#F5F5F7]"
      style={{ fontFamily: appleFont }}
    >
      {/* ═══ Background layer (blurs when location modal is open) ═══ */}
      <div
        className={`flex-1 flex flex-col transition-all duration-300 ${
          s.showLocationModal
            ? "scale-[0.98] blur-[2px] opacity-40 pointer-events-none select-none"
            : ""
        }`}
      >
        {/* ═══ Header ═══ */}
        <HushhTechBackHeader onBackClick={s.handleBack} rightLabel="FAQ" />
        <OnboardingBankReviewChip />

        <main className="mx-auto w-full max-w-[700px] flex-grow px-4 pb-48 sm:px-5">
          {/* ── Progress Bar ── */}
          <div className="pb-5 pt-4">
            <div className="mb-3 flex justify-between text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
              <span>
                Step {DISPLAY_STEP}/{TOTAL_STEPS}
              </span>
              <span>{PROGRESS_PCT}% Complete</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[#1D1D1F]/10">
              <div
                className="h-full rounded-full bg-[#0066CC] transition-all duration-500"
                style={{ width: `${PROGRESS_PCT}%` }}
              />
            </div>
            <OnboardingStepJumpNav currentStep={DISPLAY_STEP} totalSteps={TOTAL_STEPS} />
          </div>

          {/* ── Title Section ── */}
          <section className="pb-6 pt-5 text-center">
            <Eyebrow>Personal Details</Eyebrow>
            <Display as="h1" size="xs" maxWidth="max-w-[500px]">
              Confirm your details.
              <RequiredAsterisk />
            </Display>
            <Lede className="max-w-[460px]">
              Add your legal name, date of birth, and residence so we can
              prepare the secure investor review.
            </Lede>
          </section>

          {/* ── Location Status Banners ── */}
          {s.locationStatus === "detecting" && (
            <div className="mb-4 flex items-center gap-3 rounded-[18px] bg-[#F5F5F7] px-4 py-4 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-white">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#0066CC]/25 border-t-[#0066CC]" />
              </div>
              <p className="text-[14px] font-medium text-[#1D1D1F]/70">
                Detecting your location...
              </p>
            </div>
          )}

          {s.isSuccessStatus && !s.isAutoFilling && !s.detectionStatus && (
            <div className="mb-6 flex items-center gap-4 rounded-[18px] bg-[#34C759]/10 px-4 py-4 shadow-[inset_0_0_0_1px_rgba(52,199,89,0.20)]">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-white">
                <span
                  className="material-symbols-outlined text-lg text-[#34C759]"
                  style={{ fontVariationSettings: "'FILL' 1, 'wght' 600" }}
                >
                  check
                </span>
              </div>
              <div>
                <p className="text-[14px] font-medium text-[#1D1D1F]">
                  Current location
                </p>
                <p className="text-[12px] font-normal text-[#1D1D1F]/55">
                  {s.detectedLocation} · used for security checks, not your legal residence
                </p>
              </div>
            </div>
          )}

          {/* Auto-fill status */}
          {s.detectionStatus && (
            <div className="mb-4 flex items-center gap-3 rounded-[18px] bg-[#34C759]/10 px-4 py-4 transition-colors shadow-[inset_0_0_0_1px_rgba(52,199,89,0.20)]">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-white">
                <span
                  className="material-symbols-outlined text-lg text-[#34C759]"
                  style={{ fontVariationSettings: "'FILL' 1, 'wght' 600" }}
                >
                  check
                </span>
              </div>
              <p className="text-[14px] font-medium text-[#1D1D1F]/70">
                {s.detectionStatus}
              </p>
            </div>
          )}

          {s.isErrorStatus && (
            <div className="mb-6">
              <div className="flex items-center justify-between rounded-[18px] bg-[#FF3B30]/10 px-4 py-4 shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-white">
                    <span
                      className="material-symbols-outlined text-lg text-[#FF3B30]"
                      style={{ fontVariationSettings: "'FILL' 1, 'wght' 600" }}
                    >
                      error
                    </span>
                  </div>
                  <p className="text-[14px] font-medium text-[#1D1D1F]/70">
                    {s.locationStatus === "denied"
                      ? "Location access denied"
                      : "Could not detect location"}
                  </p>
                </div>
                <button
                  onClick={s.handleRetry}
                  className="shrink-0 text-[12px] font-medium uppercase tracking-[1.2px] text-[#1D1D1F] hover:underline"
                >
                  Retry
                </button>
              </div>
              {s.locationStatus === "denied" && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    s.setShowPermissionHelp(true);
                  }}
                  className="ml-14 mt-2 text-[11px] font-medium text-[#1D1D1F]/55 underline transition-colors hover:text-[#0066CC]"
                >
                  How to enable location
                </button>
              )}
            </div>
          )}

          {/* ── General Error ── */}
          {s.error && (
            <div className="mb-6 flex items-center gap-3 rounded-[18px] bg-[#FF3B30]/10 px-4 py-4 shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-white">
                <span
                  className="material-symbols-outlined text-lg text-[#FF3B30]"
                  style={{ fontVariationSettings: "'FILL' 1, 'wght' 600" }}
                >
                  error
                </span>
              </div>
              <p className="text-[14px] font-medium text-[#B42318]">{s.error}</p>
            </div>
          )}

          {s.hasBankPrefill && (
            <div className="mb-6 flex items-center gap-4 rounded-[18px] bg-[#0066CC]/[0.07] px-4 py-4 shadow-[inset_0_0_0_1px_rgba(0,102,204,0.16)]">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-white">
                <span
                  className="material-symbols-outlined text-lg text-[#0066CC]"
                  style={{ fontVariationSettings: "'FILL' 1, 'wght' 600" }}
                >
                  account_balance
                </span>
              </div>
              <div>
                <p className="text-[14px] font-medium text-[#1D1D1F]">
                  Verified from your linked bank
                </p>
                <p className="text-[12px] font-normal text-[#1D1D1F]/55">
                  These details are locked to your bank record. To change them, use
                  &ldquo;Review or change your linked bank&rdquo; above.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-5">
            <section className={panelClass}>
              <div className="mb-5">
                <h3 className="text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
                  Personal Details
                </h3>
                <p className="mt-1 text-[13px] font-normal leading-[1.45] text-[#1D1D1F]/50">
                  Enter your full legal name.
                </p>
                <p className="mt-2 text-[11px] font-normal leading-[1.45] text-[#1D1D1F]/40">
                  <RequiredAsterisk className="ml-0" /> Required fields
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className={compactFieldClass} htmlFor="legalFirstName">
                  <span className={compactLabelClass}>
                    First Name
                    <RequiredAsterisk />
                    {s.fieldSources["legal_first_name"] === "plaid" && <BankVerifiedMarker />}
                  </span>
                  <input
                    id="legalFirstName"
                    type="text"
                    value={s.legalFirstName}
                    onChange={(e) => {
                      s.setLegalFirstName(e.target.value);
                      s.markFieldEdited("legal_first_name");
                    }}
                    placeholder="First name"
                    readOnly={s.isPlaidLocked("legal_first_name")}
                    className={`${inputClass}${s.isPlaidLocked("legal_first_name") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                    autoComplete="given-name"
                  />
                </label>
                <label className={compactFieldClass} htmlFor="legalLastName">
                  <span className={compactLabelClass}>
                    Last Name
                    <RequiredAsterisk />
                    {s.fieldSources["legal_last_name"] === "plaid" && <BankVerifiedMarker />}
                  </span>
                  <input
                    id="legalLastName"
                    type="text"
                    value={s.legalLastName}
                    onChange={(e) => {
                      s.setLegalLastName(e.target.value);
                      s.markFieldEdited("legal_last_name");
                    }}
                    placeholder="Last name"
                    readOnly={s.isPlaidLocked("legal_last_name")}
                    className={`${inputClass}${s.isPlaidLocked("legal_last_name") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                    autoComplete="family-name"
                  />
                </label>
              </div>

              <div className="mt-4">
                <span className={compactLabelClass}>
                  Date of Birth
                  <RequiredAsterisk />
                </span>
                <div className="mt-2 grid gap-2 sm:grid-cols-[1.35fr_0.75fr_0.9fr]">
                  <div className={compactFieldClass}>
                    <div className="relative">
                    <select
                      value={s.dobMonth}
                      onChange={(e) => s.setDobMonth(e.target.value)}
                      className={compactSelectClass}
                      aria-label="Birth month"
                    >
                      <option value="" disabled>
                        Month
                      </option>
                      {s.monthNames.map((name, index) => (
                        <option
                          key={name}
                          value={String(index + 1).padStart(2, "0")}
                        >
                          {name}
                        </option>
                      ))}
                    </select>
                    <span className="material-symbols-outlined pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-base text-[#1D1D1F]/30">
                      expand_more
                    </span>
                    </div>
                  </div>
                  <div className={compactFieldClass}>
                    <div className="relative">
                    <select
                      value={s.dobDay}
                      onChange={(e) => s.setDobDay(e.target.value)}
                      className={compactSelectClass}
                      aria-label="Birth day"
                    >
                      <option value="" disabled>
                        Day
                      </option>
                      {s.dayOptions.map((day) => (
                        <option key={day} value={day}>
                          {parseInt(day, 10)}
                        </option>
                      ))}
                    </select>
                    <span className="material-symbols-outlined pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-base text-[#1D1D1F]/30">
                      expand_more
                    </span>
                    </div>
                  </div>
                  <div className={compactFieldClass}>
                    <div className="relative">
                    <select
                      value={s.dobYear}
                      onChange={(e) => s.setDobYear(e.target.value)}
                      className={compactSelectClass}
                      aria-label="Birth year"
                    >
                      <option value="" disabled>
                        Year
                      </option>
                      {s.yearOptions.map((year) => (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                    <span className="material-symbols-outlined pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-base text-[#1D1D1F]/30">
                      expand_more
                    </span>
                    </div>
                  </div>
                </div>
                {s.isUnder18 && s.ageError && (
                  <p className="mt-3 text-[12px] text-[#FF3B30]">
                    {s.ageError}
                  </p>
                )}
              </div>
            </section>

            <section className={panelClass}>
              <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
                    Residence
                  </h3>
                  <p className="mt-1 text-[13px] font-normal leading-[1.45] text-[#1D1D1F]/50">
                    Add your legal residence and address for investor verification.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={s.handleDetectClick}
                  disabled={s.isDetectingLocation}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[#EAF4FF] px-4 text-[13px] font-medium text-[#0066CC] transition hover:bg-[#DDEFFF] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    my_location
                  </span>
                  {s.isDetectingLocation ? "Locating..." : "Use current location"}
                </button>
              </div>

              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={fieldClass}>
                    <span className={labelClass}>
                      Citizenship
                      <RequiredAsterisk />
                    </span>
                    <div className="relative">
                      <select
                        value={s.citizenshipCountry}
                        onChange={(e) => s.handleCitizenshipChange(e.target.value)}
                        disabled={s.isDetectingLocation}
                        className={selectClass}
                        aria-label="Select citizenship country"
                      >
                        <option disabled value="">
                          Select country
                        </option>
                        {countries.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <span className="material-symbols-outlined pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-base text-[#1D1D1F]/30">
                        expand_more
                      </span>
                    </div>
                  </label>
                  <label className={fieldClass}>
                    <span className={labelClass}>
                      Residence
                      <RequiredAsterisk />
                      {s.fieldSources["residence_country"] === "plaid" && <BankVerifiedMarker />}
                    </span>
                    <div className="relative">
                      <select
                        value={s.residenceCountry}
                        onChange={(e) => s.handleResidenceChange(e.target.value)}
                        disabled={s.isDetectingLocation || s.isPlaidLocked("residence_country")}
                        className={`${selectClass}${s.isPlaidLocked("residence_country") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                        aria-label="Select residence country"
                      >
                        <option disabled value="">
                          Select country
                        </option>
                        {countries.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <span className="material-symbols-outlined pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-base text-[#1D1D1F]/30">
                        expand_more
                      </span>
                    </div>
                  </label>
                </div>

                <div className="flex items-start gap-3 rounded-[18px] bg-[#F5F5F7]/70 px-4 py-3 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.06)]">
                  <span className="material-symbols-outlined mt-0.5 text-[18px] text-[#1D1D1F]/35">
                    location_on
                  </span>
                  <p className="text-[13px] font-normal leading-[1.45] text-[#1D1D1F]/50">
                    {s.hasBankResidence
                      ? "Bank-provided residence is shown separately from your live location, which is tracked for security checks."
                      : "Live location is tracked separately for security checks. Enter your legal residence and address below; GPS will not fill them."}
                  </p>
                </div>

                <div className="grid gap-3 border-t border-[#1D1D1F]/[0.06] pt-4">
                  <label className={fieldClass} htmlFor="addressLine1">
                    <span className={labelClass}>
                      Street Address
                      <RequiredAsterisk />
                      {s.fieldSources["address_line_1"] === "plaid" && <BankVerifiedMarker />}
                    </span>
                    <input
                      id="addressLine1"
                      type="text"
                      value={s.addressLine1}
                      onChange={(e) => s.handleAddressLine1Change(e.target.value)}
                      onBlur={() => s.handleBlur("addressLine1", s.addressLine1)}
                      placeholder="Street address"
                      readOnly={s.isPlaidLocked("address_line_1")}
                      className={`${inputClass}${s.isPlaidLocked("address_line_1") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                      autoComplete="address-line1"
                    />
                  </label>
                  {s.touched.addressLine1 && s.errors.addressLine1 && (
                    <p className="px-1 text-[12px] text-[#FF3B30]">
                      {s.errors.addressLine1}
                    </p>
                  )}

                  <label className={fieldClass} htmlFor="addressLine2">
                    <span className={labelClass}>
                      Apt / Suite
                      <OptionalMarker />
                      {s.fieldSources["address_line_2"] === "plaid" && <BankVerifiedMarker />}
                    </span>
                    <input
                      id="addressLine2"
                      type="text"
                      value={s.addressLine2}
                      onChange={(e) => s.handleAddressLine2Change(e.target.value)}
                      placeholder="Apartment, suite, unit"
                      readOnly={s.isPlaidLocked("address_line_2")}
                      className={`${inputClass}${s.isPlaidLocked("address_line_2") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                      autoComplete="address-line2"
                    />
                  </label>

                  <div className="grid gap-3 sm:grid-cols-[1fr_0.8fr_0.65fr]">
                    <label className={fieldClass} htmlFor="city">
                      <span className={labelClass}>
                        City
                        <RequiredAsterisk />
                        {s.fieldSources["city"] === "plaid" && <BankVerifiedMarker />}
                      </span>
                      <input
                        id="city"
                        type="text"
                        value={s.addressCity}
                        onChange={(e) => s.handleAddressCityChange(e.target.value)}
                        onBlur={() => s.handleBlur("addressCity", s.addressCity)}
                        placeholder="City"
                        readOnly={s.isPlaidLocked("city")}
                        className={`${inputClass}${s.isPlaidLocked("city") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                        autoComplete="address-level2"
                      />
                    </label>
                    <label className={fieldClass} htmlFor="state">
                      <span className={labelClass}>
                        State / Region
                        <RequiredAsterisk />
                        {s.fieldSources["state"] === "plaid" && <BankVerifiedMarker />}
                      </span>
                      <input
                        id="state"
                        type="text"
                        value={s.addressState}
                        onChange={(e) => s.handleAddressStateChange(e.target.value)}
                        onBlur={() => s.handleBlur("addressState", s.addressState)}
                        placeholder="State"
                        readOnly={s.isPlaidLocked("state")}
                        className={`${inputClass}${s.isPlaidLocked("state") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                        autoComplete="address-level1"
                      />
                    </label>
                    <label className={fieldClass} htmlFor="zipCode">
                      <span className={labelClass}>
                        Postal Code
                        <RequiredAsterisk />
                        {s.fieldSources["zip_code"] === "plaid" && <BankVerifiedMarker />}
                      </span>
                      <input
                        id="zipCode"
                        type="text"
                        value={s.zipCode}
                        inputMode="text"
                        onChange={(e) => s.handleZipCodeChange(e.target.value)}
                        onBlur={() => s.handleBlur("zipCode", s.zipCode)}
                        placeholder="10001"
                        readOnly={s.isPlaidLocked("zip_code")}
                        className={`${inputClass}${s.isPlaidLocked("zip_code") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                        autoComplete="postal-code"
                      />
                    </label>
                  </div>
                  {(s.touched.addressCity && s.errors.addressCity) ||
                  (s.touched.addressState && s.errors.addressState) ? (
                    <div className="grid gap-1 px-1 text-[12px] text-[#FF3B30] sm:grid-cols-[1fr_0.8fr_0.65fr]">
                      <p>{s.touched.addressCity ? s.errors.addressCity : ""}</p>
                      <p>{s.touched.addressState ? s.errors.addressState : ""}</p>
                      <span />
                    </div>
                  ) : null}
                  {s.touched.zipCode && s.errors.zipCode && (
                    <p className="px-1 text-[12px] text-[#FF3B30]">
                      {s.errors.zipCode}
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className={panelClass}>
              <div className="mb-4">
                <h3 className="text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
                  Tax Reporting
                </h3>
                <p className="mt-1 text-[13px] font-normal leading-[1.45] text-[#1D1D1F]/50">
                  SSN is required for US investors and tax reporting.
                </p>
              </div>

              <div className="grid gap-3">
                <label className={fieldClass} htmlFor="ssn">
                  <span className={labelClass}>
                    SSN
                    {s.isUsInvestor ? <RequiredAsterisk /> : <OptionalMarker />}
                  </span>
                  <input
                    id="ssn"
                    type="text"
                    value={s.ssn}
                    onChange={s.handleSSNChange}
                    placeholder="000-00-0000"
                    maxLength={11}
                    inputMode="numeric"
                    className={inputClass}
                    autoComplete="off"
                  />
                </label>

                <div className="overflow-hidden rounded-[18px] bg-[#F5F5F7] shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.06)]">
                  <button
                    type="button"
                    onClick={() => setIsSsnHelpOpen((value) => !value)}
                    className="flex w-full items-center gap-4 px-4 py-4 text-left"
                    aria-expanded={isSsnHelpOpen}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-white text-[#1D1D1F]/55 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
                      <span
                        className="material-symbols-outlined text-[19px]"
                        style={{ fontVariationSettings: "'wght' 400" }}
                      >
                        info
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium text-[#1D1D1F]">
                        Why do we need your SSN?
                      </span>
                      <span className="mt-0.5 block text-[12px] font-normal text-[#1D1D1F]/45">
                        Tap to learn more
                      </span>
                    </span>
                    <span
                      className={`material-symbols-outlined text-[20px] text-[#1D1D1F]/35 transition-transform ${
                        isSsnHelpOpen ? "rotate-180" : ""
                      }`}
                    >
                      expand_more
                    </span>
                  </button>
                  {isSsnHelpOpen && (
                    <div className="border-t border-[#1D1D1F]/[0.06] px-4 pb-4 pl-[68px] text-[12px] font-normal leading-[1.5] text-[#1D1D1F]/55">
                      We use SSN only for US tax reporting, identity checks, and
                      investor eligibility review. It is stored securely and never
                      shown in full after submission.
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className={panelClass}>
              <div className="mb-4">
                <h3 className="text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
                  Contact
                </h3>
                <p className="mt-1 text-[13px] font-normal leading-[1.45] text-[#1D1D1F]/50">
                  We'll use this to share investor-review updates.
                </p>
              </div>

              <div className="grid gap-3">

                <div className="grid gap-3 sm:grid-cols-[132px_1fr]">
                  <label className={fieldClass}>
                    <span className={labelClass}>
                      Code
                      <RequiredAsterisk />
                    </span>
                    <select
                      value={`${s.selectedDialOption.iso}|${s.selectedDialOption.code}`}
                      onChange={(event) => {
                        const [iso, code] = event.target.value.split("|");
                        const next = s.phoneDialCodes.find(
                          (option) => option.iso === iso && option.code === code
                        );
                        if (next) s.handleSelectDialCode(next);
                      }}
                      disabled={s.isPlaidLocked("phone_number")}
                      className={`${selectClass}${s.isPlaidLocked("phone_number") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                      aria-label="Phone country code"
                    >
                      {s.phoneDialCodes.map((option) => (
                        <option
                          key={`${option.iso}-${option.code}`}
                          value={`${option.iso}|${option.code}`}
                        >
                          {option.iso} {option.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={fieldClass} htmlFor="phoneNumber">
                    <span className={labelClass}>
                      Contact Number
                      <RequiredAsterisk />
                      {s.fieldSources["phone_number"] === "plaid" && <BankVerifiedMarker />}
                    </span>
                    <input
                      id="phoneNumber"
                      type="tel"
                      value={s.formatPhoneNumber(s.phoneNumber)}
                      onChange={s.handlePhoneChange}
                      placeholder="(000) 000-0000"
                      readOnly={s.isPlaidLocked("phone_number")}
                      className={`${inputClass}${s.isPlaidLocked("phone_number") ? " cursor-not-allowed text-[#1D1D1F]/55" : ""}`}
                      autoComplete="tel"
                    />
                  </label>
                </div>

                {!s.isValidPhone && s.phoneNumber && (
                  <p className="px-1 text-[11px] font-medium text-[#FF3B30]">
                    Enter 8 to 15 digits before sending the code.
                  </p>
                )}
              </div>
            </section>
          </div>

          {/* ── Legal-residence attestation — only when there is a bank-verified
               residence to attest (v1 Plaid pivot). ── */}
          {s.hasBankResidence && (
          <section className="pt-2">
            <ConsentCheckbox
              id="residence-attest"
              checked={s.residenceAttested}
              onChange={s.handleResidenceAttestChange}
              error={s.residenceAttestError}
            >
              I confirm the details above are my legal/permanent residence used for
              investor verification — not a temporary or current travel location.
            </ConsentCheckbox>
          </section>
          )}

          {/* ── CTAs — Continue & Skip ── */}
          <section className="pb-12 space-y-3 mt-4">
            <HushhTechCta
              variant={HushhTechCtaVariant.BLACK}
              onClick={s.handleContinue}
              disabled={
                !s.canContinue || s.isLoading || s.isDetectingLocation || s.isAutoFilling
              }
              className={primaryCtaClass}
            >
              {s.isDetectingLocation
                ? "Detecting..."
                : s.isAutoFilling
                ? "Auto-filling..."
                : s.isLoading
                ? "Saving..."
                : s.returnToReview
                ? "Save & return to Review"
                : "Continue"}
            </HushhTechCta>

          </section>

          {/* ── Trust Badges ── */}
          <section className="flex flex-col items-center justify-center text-center gap-2 pb-8">
            <div className="flex items-center gap-1">
              <span className="material-symbols-outlined text-[12px] text-[#0066CC]">
                lock
              </span>
              <span className="text-[10px] font-medium uppercase tracking-[1.6px] text-[#1D1D1F]/50">
                256 Bit Encryption
              </span>
            </div>
          </section>
        </main>
      </div>

      {/* ═══ Location Permission Modal ═══ */}
      {s.showLocationModal && (
        <>
          <div className="fixed inset-0 z-40 bg-white/60 backdrop-blur-sm" />
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-6 sm:pb-0">
            <div
              ref={locationModalRef}
              className="relative flex w-full max-w-sm flex-col items-center rounded-[28px] bg-white p-8 text-center shadow-[0_24px_60px_rgba(29,29,31,0.18),inset_0_0_0_0.5px_rgba(29,29,31,0.08)]"
              role="dialog"
              aria-modal="true"
              aria-labelledby="step3-location-modal-title"
              tabIndex={-1}
            >
              <div className="mb-8">
                <div className="flex h-20 w-20 items-center justify-center rounded-[24px] bg-[#F5F5F7] shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
                  <span
                    className="material-symbols-outlined text-[2rem] text-[#1D1D1F]"
                    style={{ fontVariationSettings: "'wght' 200" }}
                  >
                    location_on
                  </span>
                </div>
              </div>
              <div className="mb-10 space-y-4 px-2">
                <h2
                  id="step3-location-modal-title"
                  className="text-[28px] font-medium leading-[1.06] tracking-[-0.028em] text-[#1D1D1F]"
                  style={{ fontFamily: appleFont }}
                >
                  Enable Location Access
                </h2>
                <p className="mx-auto max-w-[90%] text-[14px] font-light leading-[1.45] text-[#1D1D1F]/60">
                  Hushh uses your location to automatically fill your country,
                  address, and streamline the secure verification process.
                </p>
              </div>
              <div className="w-full space-y-4">
                <button
                  ref={allowLocationButtonRef}
                  onClick={s.handleAllowLocation}
                  className="flex h-12 w-full items-center justify-center rounded-full border border-[#0066CC] bg-[#0066CC] text-[14px] font-medium text-white transition-all hover:opacity-90 active:scale-[0.99]"
                >
                  Allow while using app
                </button>
                <button
                  onClick={s.handleAllowLocation}
                  className="h-12 w-full rounded-full border border-[#1D1D1F]/15 bg-white text-[14px] font-medium text-[#1D1D1F] transition-colors hover:bg-[#F5F5F7] active:scale-[0.99]"
                >
                  Allow once
                </button>
                <div className="pt-2">
                  <button
                    onClick={s.handleDontAllow}
                    className="text-[12px] font-medium text-[#1D1D1F]/45 transition-colors hover:text-[#1D1D1F]"
                  >
                    Don&apos;t allow
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══ Permission Help Modal ═══ */}
      <PermissionHelpModal
        isOpen={s.showPermissionHelp}
        onClose={() => s.setShowPermissionHelp(false)}
      />
    </div>
  );
}
