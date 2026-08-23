// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Hushh Research stock-quote boundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  it("does not invoke the stock gateway when disabled on first render", async () => {
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

  it("uses the same-origin GCP stock gateway without browser credentials", async () => {
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
    const { STOCK_SYMBOLS, useStockQuotes } = await import(
      "../src/hooks/useStockQuotes"
    );

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
      "/api/stock-quotes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        credentials: "same-origin",
      }),
    );
    const headers = (legacyFetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("apikey");
    const [, requestInit] = legacyFetch.mock.calls[0] as [string, RequestInit];
    const requestBody = String(requestInit.body);
    const parsedBody = JSON.parse(requestBody) as Record<string, unknown>;
    expect(Object.keys(parsedBody)).toEqual(["symbols"]);
    expect(parsedBody.symbols).toEqual(STOCK_SYMBOLS);
    expect(new TextEncoder().encode(requestBody).byteLength).toBe(222);
    expect(container.textContent).toBe("false");
  });
});
