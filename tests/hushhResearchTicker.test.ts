// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useStockQuotesMock = vi.hoisted(() => vi.fn());
const researchModeMock = vi.hoisted(() => vi.fn());
const authHarness = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    app_metadata: Record<string, unknown>;
  },
}));

vi.mock("../src/hooks/useStockQuotes", () => ({
  useStockQuotes: (...args: unknown[]) => useStockQuotesMock(...args),
}));

vi.mock("../src/hooks/useConstantTickerMotion", () => ({
  useConstantTickerMotion: vi.fn(),
}));

vi.mock("../src/auth/AuthSessionProvider", () => ({
  useAuthSession: () => ({ user: authHarness.user }),
  useOptionalAuthSession: () => ({ user: authHarness.user }),
}));

vi.mock("../src/services/hushhResearch/firebaseAuth", () => ({
  isHushhResearchAuthMode: (...args: unknown[]) => researchModeMock(...args),
}));

import HushhTechTicker from "../src/components/hushh-tech-ticker/HushhTechTicker";

describe("HushhTechTicker Research boundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    researchModeMock.mockReset().mockReturnValue(false);
    useStockQuotesMock.mockReset().mockReturnValue({
      quotes: [],
      loading: false,
      lastUpdated: null,
    });
    authHarness.user = null;
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it.each(["/", "/profile"])(
    "disables the Supabase ticker on Research %s",
    async (pathname) => {
      authHarness.user = {
        id: "hushh-tech-uat-synthetic-ada-001",
        app_metadata: { auth_source: "hushh-research" },
      };

      await act(async () => {
        root.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: [pathname] },
            React.createElement(HushhTechTicker),
          ),
        );
      });

      expect(useStockQuotesMock).toHaveBeenCalledWith(120000, false);
    },
  );

  it("preserves the legacy ticker request outside Research mode", async () => {
    authHarness.user = {
      id: "legacy-user",
      app_metadata: { provider: "google" },
    };

    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          React.createElement(HushhTechTicker),
        ),
      );
    });

    expect(useStockQuotesMock).toHaveBeenCalledWith(120000, true);
  });
});
