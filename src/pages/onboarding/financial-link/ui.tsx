/**
 * FinancialLink — UI / Presentation
 * Same design language as step 1-8.
 * Plaid integration restored via logic.ts (usePlaidLinkHook).
 * Continue → opens Plaid Link → fetches data → proceeds to step 1.
 */
import { useFinancialLinkLogic, formatCurrency } from "./logic";
import HushhTechCta, {
  HushhTechCtaVariant,
} from "../../../components/hushh-tech-cta/HushhTechCta";
import HushhTechBackHeader from "../../../components/hushh-tech-back-header/HushhTechBackHeader";
import {
  Display,
  Eyebrow,
  Lede,
  SmallSpinner,
  appleFont,
} from "../../../components/hushh-tech-ui/HushhAppleUI";
import ConsentCheckbox from "../../../components/consent/ConsentCheckbox";
import { CONSENT_COPY, CONSENT_LINKS } from "../../../services/consent/consentConfig";

const primaryCtaClass =
  "!rounded-full !border-[#0066CC] !bg-[#0066CC] !text-white !font-medium !tracking-[-0.01em] !shadow-none";
const secondaryCtaClass =
  "!rounded-full !border-[#1D1D1F]/15 !bg-white !text-[#1D1D1F] !font-medium !tracking-[-0.01em] !shadow-none";

export default function OnboardingFinancialLink() {
  const {
    userId,
    isReady,
    /* Plaid state */
    plaidStep,
    institution,
    isDone,
    canProceed,
    isProcessing,
    isButtonDisabled,
    showPrimaryButtonSpinner,
    buttonText,
    error,
    localPlaidNotice,
    isChangeBankConfirmOpen,
    isChangingBank,
    changeBankError,
    /* Data */
    verificationRows,
    productSyncRows,
    allAccounts,
    accountGroups,
    totalBalance,
    identityInfo,
    investmentHoldings,
    /* Actions */
    handleBack,
    handleButtonClick,
    openChangeBankConfirm,
    closeChangeBankConfirm,
    handleConfirmChangeBank,
    /* Plaid consent gate */
    plaidConsentChecked,
    plaidConsentError,
    handlePlaidConsentChange,
  } = useFinancialLinkLogic();

  /* Loading state */
  if (!isReady || !userId) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-[#FFFFFF] px-6 text-[#1D1D1F]"
        style={{ fontFamily: appleFont }}
      >
        <SmallSpinner label="Preparing your secure onboarding" />
      </div>
    );
  }

  return (
    <div
      className="flex min-h-screen flex-col bg-[#FFFFFF] text-[#1D1D1F] antialiased selection:bg-[#0066CC] selection:text-[#F5F5F7]"
      style={{ fontFamily: appleFont }}
    >
      {/* Header — back + FAQ */}
      <HushhTechBackHeader
        onBackClick={handleBack}
        rightLabel="FAQ"
      />

      {/* Main Content */}
      <main className="mx-auto mt-4 w-full max-w-[520px] flex-grow px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] sm:mt-6 sm:px-5">
        {/* Title Section */}
        <section className="mb-8 pt-8 text-center sm:mb-10 sm:pt-12">
          <Eyebrow>Link your account</Eyebrow>
          <Display as="h1" size="sm" maxWidth="max-w-[440px]">
            Verify your financial profile.
          </Display>
          <Lede className="text-[16px] md:text-[18px]">
            {isDone && institution
              ? `Connected to ${institution.name}. You can continue to the next step.`
              : "We'll securely check your financial profile before starting KYC verification to ensure compliance."}
          </Lede>
        </section>

        {/* Connected Badge */}
        {isDone && institution && (
          <div className="mb-6 flex justify-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#34C759]/10 px-3 py-1.5 text-[12px] font-medium text-[#1D1D1F] shadow-[inset_0_0_0_1px_rgba(52,199,89,0.22)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#34C759]" />
              Connected to {institution.name}
            </span>
          </div>
        )}

        {/* ── Accounts Summary (shown after Plaid connects) ── */}
        {allAccounts.length > 0 && (
          <section className="mb-8">
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
              Total Balance
            </h3>
            <div className="mb-4 rounded-[18px] bg-[#F5F5F7] px-5 py-4 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
              <p className="mb-1 text-[12px] text-[#1D1D1F]/55">
                All Accounts ({allAccounts.length})
              </p>
              <p className="font-mono text-[28px] font-medium tracking-[-0.028em] text-[#1D1D1F]">
                {formatCurrency(totalBalance)}
              </p>
            </div>

            {/* Account groups */}
            {Object.entries(accountGroups).map(([type, accounts]) => (
              <div key={type} className="mb-4">
                <h4 className="mb-2 text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
                  {type === 'depository' ? 'Checking & Savings' : type === 'credit' ? 'Credit Cards' : type}
                  {' '}({(accounts as any[]).length})
                </h4>
                <div className="overflow-hidden rounded-[18px] bg-white shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.10)]">
                  {(accounts as any[]).map((acc: any, i: number) => {
                    const balance = acc.balances?.current ?? acc.balances?.available;
                    const currency = acc.balances?.iso_currency_code || 'USD';
                    return (
                      <div key={acc.account_id || i} className="flex items-center border-b border-[#1D1D1F]/[0.08] px-4 py-3 last:border-b-0">
                        <div className="mr-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#F5F5F7]">
                          <span
                            className="material-symbols-outlined text-lg text-[#1D1D1F]/70"
                            style={{ fontVariationSettings: "'wght' 300" }}
                          >
                            account_balance
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-[14px] font-medium text-[#1D1D1F]">
                            {acc.name || `account ...${acc.mask}`}
                          </p>
                          <p className="text-[12px] text-[#1D1D1F]/50">
                            {acc.subtype || acc.type} {acc.mask ? `···${acc.mask}` : ''}
                          </p>
                        </div>
                        <p className="ml-2 shrink-0 font-mono text-[14px] font-medium text-[#1D1D1F]">
                          {balance != null ? formatCurrency(balance, currency) : '—'}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ── Identity Data (shown after Plaid connects) ── */}
        {identityInfo && (
          <section className="mb-8">
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
              Bank-Verified Identity
            </h3>
            <div className="overflow-hidden rounded-[18px] bg-white shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.10)]">
              {identityInfo.names.length > 0 && (
                <div className="flex items-center gap-3 border-b border-[#1D1D1F]/[0.08] px-4 py-3">
                  <span className="material-symbols-outlined text-lg text-[#1D1D1F]/35" style={{ fontVariationSettings: "'wght' 300" }}>person</span>
                  <div><p className="text-[12px] text-[#1D1D1F]/50">Name</p><p className="text-[14px] font-medium text-[#1D1D1F]">{identityInfo.names.join(', ')}</p></div>
                </div>
              )}
              {identityInfo.emails.length > 0 && (
                <div className="flex items-center gap-3 border-b border-[#1D1D1F]/[0.08] px-4 py-3">
                  <span className="material-symbols-outlined text-lg text-[#1D1D1F]/35" style={{ fontVariationSettings: "'wght' 300" }}>email</span>
                  <div><p className="text-[12px] text-[#1D1D1F]/50">Email</p><p className="text-[14px] font-medium text-[#1D1D1F]">{identityInfo.emails.join(', ')}</p></div>
                </div>
              )}
              {identityInfo.phones.length > 0 && (
                <div className="flex items-center gap-3 border-b border-[#1D1D1F]/[0.08] px-4 py-3">
                  <span className="material-symbols-outlined text-lg text-[#1D1D1F]/35" style={{ fontVariationSettings: "'wght' 300" }}>phone</span>
                  <div><p className="text-[12px] text-[#1D1D1F]/50">Phone</p><p className="text-[14px] font-medium text-[#1D1D1F]">{identityInfo.phones.join(', ')}</p></div>
                </div>
              )}
              {identityInfo.addresses.length > 0 && (
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="material-symbols-outlined text-lg text-[#1D1D1F]/35" style={{ fontVariationSettings: "'wght' 300" }}>location_on</span>
                  <div><p className="text-[12px] text-[#1D1D1F]/50">Address</p><p className="text-[14px] font-medium text-[#1D1D1F]">{identityInfo.addresses[0]}</p></div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Verification Rows (product status) ── */}
        <section className="overflow-hidden rounded-[20px] bg-[#F5F5F7] shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
          {verificationRows.map((row) => (
            <div
              key={row.title}
              className="group flex items-center justify-between gap-3 border-b border-[#1D1D1F]/[0.08] px-4 py-4 sm:py-5 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-4 sm:gap-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-white shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
                  <span
                    className="material-symbols-outlined text-[20px] text-[#1D1D1F]"
                    style={{ fontVariationSettings: "'wght' 200" }}
                  >
                    {row.icon}
                  </span>
                </div>
                <div className="flex min-w-0 flex-col">
                  <span className="text-[15px] font-medium text-[#1D1D1F]">
                    {row.title}
                  </span>
                  <span className={`text-[13px] font-light leading-5 ${
                    row.status === 'success'
                      ? 'text-[#1D1D1F]/70'
                      : row.status === 'error'
                        ? 'text-[#B42318]'
                        : 'text-[#1D1D1F]/45'
                  }`}>
                    {(row.status === 'loading' || row.status === 'pending') && (
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border border-hushh-blue border-t-transparent motion-reduce:animate-none" />
                        {row.subtitle}
                      </span>
                    )}
                    {row.status !== 'loading' && row.status !== 'pending' && row.subtitle}
                  </span>
                </div>
              </div>
              <span
                className={`material-symbols-outlined shrink-0 text-[20px] ${
                  row.status === 'success'
                    ? 'text-[#34C759]'
                    : row.status === 'error'
                      ? 'text-[#FF3B30]'
                      : row.status === 'loading' || row.status === 'pending'
                        ? 'animate-spin text-[#0066CC] motion-reduce:animate-none'
                        : 'text-[#1D1D1F]/30'
                }`}
                style={{ fontVariationSettings: "'wght' 200" }}
              >
                {row.status === 'success'
                  ? 'check_circle'
                  : row.status === 'error'
                    ? 'error'
                    : row.status === 'loading' || row.status === 'pending'
                      ? 'progress_activity'
                      : 'east'}
              </span>
            </div>
          ))}
        </section>

        {isDone && productSyncRows.length > 0 && (
          <section className="mt-8">
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
              Plaid data sync
            </h3>
            <div className="overflow-hidden rounded-[20px] bg-white shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.10)]">
              {productSyncRows.map((row) => (
                <div
                  key={row.product}
                  className="flex items-center justify-between gap-4 border-b border-[#1D1D1F]/[0.08] px-4 py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[#F5F5F7]">
                      <span
                        className="material-symbols-outlined text-[18px] text-[#1D1D1F]/70"
                        style={{ fontVariationSettings: "'wght' 250" }}
                      >
                        {row.icon}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-medium text-[#1D1D1F]">
                        {row.title}
                      </p>
                      <p className="truncate text-[12px] text-[#1D1D1F]/52">
                        {row.subtitle}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`material-symbols-outlined shrink-0 text-[19px] ${
                      row.status === 'success'
                        ? 'text-[#34C759]'
                        : row.status === 'loading'
                          ? 'animate-spin text-[#0066CC]'
                          : row.status === 'error'
                            ? 'text-[#FF3B30]'
                            : 'text-[#1D1D1F]/30'
                    }`}
                    style={{ fontVariationSettings: "'wght' 220" }}
                  >
                    {row.status === 'success'
                      ? 'check_circle'
                      : row.status === 'loading'
                        ? 'progress_activity'
                        : row.status === 'error'
                          ? 'error'
                          : 'schedule'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Error message */}
        {error && plaidStep === 'error' && (
          <div role="alert" className="mt-4 rounded-[16px] bg-[#FF3B30]/10 p-3 text-center shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
            <p className="text-[12px] font-medium text-[#B42318]">{error}</p>
          </div>
        )}

        {/* P0.E — Partial Plaid: bank connected but core products missing.
             User sees "Try Again" button on the primary CTA but without this
             banner they don't know why their bank looks linked yet still
             can't proceed. */}
        {isDone && !canProceed && (
          <div className="mt-4 rounded-[16px] bg-[#FF9500]/10 p-3 text-center shadow-[inset_0_0_0_1px_rgba(255,149,0,0.2)]">
            <p className="text-[12px] font-medium leading-[1.45] text-[#B45309]">
              Your bank connected but some verification data didn't sync.
              Press <strong>Try Again</strong> to refresh, or change banks to
              complete verification.
            </p>
          </div>
        )}

        {changeBankError && (
          <div className="mt-4 rounded-[16px] bg-[#FF3B30]/10 p-3 text-center shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
            <p className="text-[12px] font-medium text-[#B42318]">{changeBankError}</p>
          </div>
        )}

        {localPlaidNotice && (
          <div className="mt-4 rounded-[16px] bg-[#0066CC]/10 p-3 text-center shadow-[inset_0_0_0_1px_rgba(0,102,204,0.16)]">
            <p className="text-[12px] font-medium leading-5 text-[#1D1D1F]/70">
              {localPlaidNotice}
            </p>
          </div>
        )}

        {/* Trust Badges */}
        <section className="mt-7 flex flex-col items-center justify-center gap-3 py-4 text-center sm:mt-8 sm:py-6">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 opacity-60">
            <span className="text-[10px] font-medium uppercase tracking-[1.6px] text-[#1D1D1F]/55">
              PCI DSS
            </span>
            <span className="text-[10px] uppercase text-[#1D1D1F]/45">
              256 Bit Encryption
            </span>
            <div className="flex items-center gap-2 border-l border-[#1D1D1F]/20 pl-2">
              <div className="flex -space-x-1">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
              </div>
              <span className="text-[10px] font-medium text-[#0066CC]">
                Visa
              </span>
              <span className="text-[10px] font-bold text-teal-600">
                RuPay
              </span>
            </div>
          </div>
        </section>

        {/* CTAs — Plaid connection is required before onboarding can continue. */}
        <section className="space-y-3">
          {/* Plaid data-sharing consent — shown only before a bank is linked.
              Inline, single acknowledgment; links open the Privacy Policy
              without toggling the box. */}
          {!isDone && (
            <ConsentCheckbox
              id="plaid-consent"
              checked={plaidConsentChecked}
              onChange={handlePlaidConsentChange}
              error={plaidConsentError}
            >
              {CONSENT_COPY.plaidDataSharing}{" "}
              <a
                href={CONSENT_LINKS.privacyPolicy}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="font-medium text-[#0066CC] underline"
              >
                Privacy Policy
              </a>
              .
            </ConsentCheckbox>
          )}

          <HushhTechCta
            variant={HushhTechCtaVariant.BLACK}
            onClick={handleButtonClick}
            disabled={isButtonDisabled}
            className={primaryCtaClass}
          >
            {showPrimaryButtonSpinner && (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2 inline-block" />
            )}
            {buttonText}
          </HushhTechCta>

          {isDone && (
            <HushhTechCta
              variant={HushhTechCtaVariant.WHITE}
              onClick={openChangeBankConfirm}
              disabled={isChangingBank}
              className={secondaryCtaClass}
            >
              Change bank
            </HushhTechCta>
          )}
        </section>
      </main>

      {isChangeBankConfirmOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-[#000000]/35 backdrop-blur-[14px]" />
          <div className="fixed inset-0 z-50 flex items-end justify-center px-4 pb-6 sm:items-center sm:pb-0">
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="change-bank-title"
              className="w-full max-w-[390px] rounded-[24px] bg-white p-5 text-[#1D1D1F] shadow-[0_24px_72px_rgba(0,0,0,0.22)]"
            >
              <div className="mb-5 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#FF9500]/12">
                  <span
                    className="material-symbols-outlined text-[22px] text-[#B45309]"
                    style={{ fontVariationSettings: "'wght' 300" }}
                  >
                    account_balance
                  </span>
                </div>
                <h2 id="change-bank-title" className="text-[19px] font-semibold text-[#1D1D1F]">
                  Change linked bank?
                </h2>
                <p className="mx-auto mt-2 max-w-[320px] text-[14px] leading-5 text-[#1D1D1F]/65">
                  This permanently disconnects the current Plaid bank. Once
                  removed, the old bank's data cannot be restored. If your new
                  bank connection fails, you can retry or connect a different
                  bank to complete verification.
                  Your fund selections stay saved.
                </p>
              </div>

              {changeBankError && (
                <div className="mb-4 rounded-[16px] bg-[#FF3B30]/10 p-3 text-center shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
                  <p className="text-[12px] font-medium text-[#B42318]">{changeBankError}</p>
                  {/* P0.C — When a paid user hits the transfer lock, surface
                       a direct path to support so they don't bounce off. */}
                  {changeBankError.toLowerCase().includes("locked after transfer setup starts") && (
                    <p className="mt-2 text-[11px] leading-[1.45] text-[#B42318]">
                      Need to change the bank on a verified investor account?{" "}
                      <a
                        href="mailto:support@hushh.ai?subject=Change%20linked%20bank%20after%20transfer%20setup"
                        className="font-semibold underline"
                      >
                        Email support@hushh.ai
                      </a>
                      .
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-3">
                <HushhTechCta
                  variant={HushhTechCtaVariant.BLACK}
                  onClick={handleConfirmChangeBank}
                  disabled={isChangingBank}
                  className={primaryCtaClass}
                >
                  {isChangingBank && (
                    <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  )}
                  Disconnect
                </HushhTechCta>
                <HushhTechCta
                  variant={HushhTechCtaVariant.WHITE}
                  onClick={closeChangeBankConfirm}
                  disabled={isChangingBank}
                  className={secondaryCtaClass}
                >
                  Cancel
                </HushhTechCta>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
