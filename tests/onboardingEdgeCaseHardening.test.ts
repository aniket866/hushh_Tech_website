import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/**
 * P0 edge-case hardening for the onboarding / financial-link flow.
 * These are source-contract tests (matching the repo's existing
 * financialLinkRenderSafety / onboardingConsentContract style) because the
 * behaviors live inside React hooks/callbacks that the repo does not render in
 * unit tests.
 */
describe("onboarding edge-case hardening (P0)", () => {
  it("GAP-1: Plaid handleExit resets a cancelled 'linking' state back to 'ready'", () => {
    const hook = read("src/services/plaid/usePlaidLink.ts");
    const handleExit = hook.slice(
      hook.indexOf("const handleExit: PlaidLinkOnExit"),
      hook.indexOf("// Log events"),
    );

    // On a no-error exit (user closed the modal), step must return to 'ready'
    // so the primary button is not stuck on "Connecting..." forever.
    expect(handleExit).toContain("} else {");
    expect(handleExit).toContain("s.step === 'linking' ? { ...s, step: 'ready' } : s");
    // The error path is unchanged.
    expect(handleExit).toContain("step: 'error'");
  });

  it("GAP-2: Plaid token initialization is single-flight and retry refuses concurrent initialization", () => {
    const hook = read("src/services/plaid/usePlaidLink.ts");
    const initToken = hook.slice(
      hook.indexOf("const initToken = useCallback"),
      hook.indexOf("const refreshFromDatabase"),
    );
    const retry = hook.slice(
      hook.indexOf("const retry = useCallback"),
      hook.indexOf("return {", hook.indexOf("const retry = useCallback")),
    );

    expect(hook).toContain("const initTokenInFlightRef = useRef(false);");
    expect(initToken).toContain("if (!userId || initTokenInFlightRef.current) return;");
    expect(initToken).toContain("initTokenInFlightRef.current = true;");
    expect(initToken).toContain("} finally {");
    expect(initToken).toContain("initTokenInFlightRef.current = false;");

    expect(retry).toContain("if (initTokenInFlightRef.current) return;");
    expect(retry.indexOf("if (initTokenInFlightRef.current) return;")).toBeLessThan(
      retry.indexOf("clearPersistedState();"),
    );
    expect(retry).toContain("void initToken();");
  });

  it("GAP-3: a link-token failure does not masquerade as product fetch failures", () => {
    const logic = read("src/pages/onboarding/financial-link/logic.ts");
    const resolver = logic.slice(
      logic.indexOf("const resolveVerificationProductStatus"),
      logic.indexOf("const getProductStatusSubtitle"),
    );

    expect(resolver).not.toContain("plaidStep === 'error'");
    expect(resolver).toContain("plaidStep === 'exchanging' || plaidStep === 'fetching'");
    expect(resolver).toContain("return 'idle';");
  });

  it("GAP-01: financial-link pre-checks consent only when the persisted version matches CONSENT_VERSION", () => {
    const logic = read("src/pages/onboarding/financial-link/logic.ts");

    expect(logic).toContain("CONSENT_VERSION");
    expect(logic).toContain(".select('plaid_consent_at, consent_version')");
    expect(logic).toContain("consentRow?.consent_version === CONSENT_VERSION");
    // The old version-blind pre-check (any plaid_consent_at => checked) is gone.
    expect(logic).not.toContain(".select('plaid_consent_at')");
  });

  it("GAP-05: financial-link has no Plaid skip bypass", () => {
    const logic = read("src/pages/onboarding/financial-link/logic.ts");
    const ui = read("src/pages/onboarding/financial-link/ui.tsx");

    expect(logic).not.toContain("handleConfirmSkip");
    expect(logic).not.toContain("openSkipConfirm");
    expect(logic).not.toContain("isSkipConfirmOpen");
    expect(logic).not.toContain("financial_link_status: 'skipped'");
    expect(logic).not.toContain("trackFinancialLink('skipped')");

    expect(ui).not.toContain("Skip Plaid verification?");
    expect(ui).not.toContain("Skip and continue");
    expect(ui).not.toContain("openSkipConfirm");
    expect(ui).not.toMatch(/>\s*Skip\s*</);
  });

  it("GAP-03: continue-to-KYC logs (does not silently swallow) a failed completed-status write", () => {
    const logic = read("src/pages/onboarding/financial-link/logic.ts");
    expect(logic).toContain("const { error: completeError } = await upsertOnboardingData");
    expect(logic).toContain("Failed to persist completed status (continuing, self-heals)");
  });
});
