import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

describe("financial-link render safety net", () => {
  it("keeps bottom breathing room additive to the device safe area", () => {
    const ui = read("src/pages/onboarding/financial-link/ui.tsx");
    const mainClass = ui.match(/<main className="([^"]+)"/)?.[1];
    expect(mainClass).toContain("pb-[calc(env(safe-area-inset-bottom)+2.5rem)]");
  });

  it("ErrorBoundary forwards uncaught render errors into plaid_link_diagnostics", () => {
    const boundary = read("src/components/ErrorBoundary.tsx");
    expect(boundary).toContain("logPlaidEvent('uncaught_react_error'");
    expect(boundary).toContain("beginPlaidSession");
    // The TODO comment about Sentry must be gone — we wire diagnostics
    // instead so PROD crashes leave a row.
    expect(boundary).not.toContain("TODO: Send to error tracking service");
    // Support handoff: the diagnostic id surfaces in the fallback UI.
    expect(boundary).toContain("data-testid=\"error-diagnostic-id\"");
  });

  it("financial-link sandbox / block-local env factories never throw", () => {
    const logic = read("src/pages/onboarding/financial-link/logic.ts");

    // Both factories wrap their env-access in try/catch so a single
    // exception (e.g., missing window during SSR-style probing or a
    // restricted iframe) cannot bring down the entire FL render.
    const sandboxBlock = logic.slice(
      logic.indexOf("const shouldUsePlaidSandboxDirectConnect ="),
      logic.indexOf("const PRODUCT_SYNC_DISPLAY"),
    );
    expect(sandboxBlock).toContain("try {");
    expect(sandboxBlock).toContain("return false");
    expect(sandboxBlock.match(/try\s*\{/g)?.length).toBeGreaterThanOrEqual(2);

    // The host probe also guards `window`.
    expect(logic).toContain("typeof window === 'undefined'");
  });

  it("diagnostics mount effect guards each emit + global listener install", () => {
    const logic = read("src/pages/onboarding/financial-link/logic.ts");

    // Every diagnostics call inside the mount effect must be try/catch
    // wrapped so the FL surface keeps rendering even when telemetry is
    // misbehaving (sessionStorage disabled, CSP blocking fetch, etc.).
    const mountEffect = logic.slice(
      logic.indexOf("Plaid Link diagnostics"),
      logic.indexOf("Cross-tab BroadcastChannel listener"),
    );
    expect(mountEffect).toContain("installGlobalPlaidErrorListener failed");
    expect(mountEffect).toContain("beginPlaidSession failed");
    expect(mountEffect).toContain("mount diagnostic emit failed");
  });

  it("declares the Plaid cross-tab listener after the Plaid hook", () => {
    const logic = read("src/pages/onboarding/financial-link/logic.ts");
    const plaidHookIndex = logic.indexOf("const plaid = usePlaidLink");
    const broadcastListenerIndex = logic.indexOf(
      "Cross-tab BroadcastChannel listener",
    );

    expect(plaidHookIndex).toBeGreaterThan(-1);
    expect(broadcastListenerIndex).toBeGreaterThan(plaidHookIndex);
    expect(logic).toContain("temporal dead zone");
  });
});
