// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Hushh Research stock-quote boundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://legacy.example.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "legacy-public-anon-key");
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not invoke the Supabase stock function when disabled on first render", async () => {
    const legacyFetch = vi.fn();
    vi.stubGlobal("fetch", legacyFetch);
    const { useStockQuotes } = await import("../src/hooks/useStockQuotes");

    const Probe = () => {
      const { loading } = useStockQuotes(0, false);
      return React.createElement("span", null, String(loading));
    };

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });

    expect(container.textContent).toBe("false");
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it("preserves the legacy stock-function request when enabled", async () => {
    const legacyFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        quotes: [
          {
            symbol: "AAPL",
            currentPrice: 200,
            change: 2,
            percentChange: 1,
            high: 201,
            low: 198,
            open: 199,
            previousClose: 198,
            timestamp: 1_787_227_200,
          },
        ],
        fetchedAt: "2026-08-20T12:00:00.000Z",
        count: 1,
      }),
    });
    vi.stubGlobal("fetch", legacyFetch);
    const { useStockQuotes } = await import("../src/hooks/useStockQuotes");

    const Probe = () => {
      const { loading } = useStockQuotes(0, true);
      return React.createElement("span", null, String(loading));
    };

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(legacyFetch).toHaveBeenCalledOnce();
    expect(legacyFetch).toHaveBeenCalledWith(
      "https://legacy.example.test/functions/v1/stock-quotes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer legacy-public-anon-key",
          apikey: "legacy-public-anon-key",
        }),
      }),
    );
    expect(container.textContent).toBe("false");
  });
});
