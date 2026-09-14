import { describe, expect, it, vi } from "vitest";

import {
  createPreferredQuoteProvider,
  createResearchQuoteProvider,
  mapResearchQuote,
} from "../api/shared/researchQuotes.js";

/**
 * The shared-cache quote client, and the rung order behind it.
 *
 * hushh-research keeps the L1/L2 cache and the market-aware cadence; this project reads it rather
 * than maintaining a second copy. What has to hold is the fallback: a cross-service call means a
 * marquee that could blank while the other service redeploys, and that is not an acceptable trade
 * for removing a duplicate.
 */

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const row = (symbol: string, price: number, pct: number) => ({
  symbol,
  price,
  change_percent: pct,
  company_name: `${symbol} Inc.`,
});

describe("mapping a shared-cache row", () => {
  it("recovers the previous close from the percentage so the shape matches the Yahoo rung", () => {
    // The service reports a percentage, the ticker renders an absolute move. Nothing downstream
    // should be able to tell which rung answered.
    const quote = mapResearchQuote(row("AAPL", 110, 10));
    expect(quote).toMatchObject({ symbol: "AAPL", currentPrice: 110, percentChange: 10, hasQuote: true });
    expect(quote?.previousClose).toBeCloseTo(100, 6);
    expect(quote?.change).toBeCloseTo(10, 6);
  });

  it("reports no move rather than dividing by a ratio of zero", () => {
    const quote = mapResearchQuote(row("X", 50, -100));
    expect(quote?.previousClose).toBe(0);
    expect(quote?.change).toBe(0);
  });

  it("drops a row with no usable price rather than rendering a zero", () => {
    expect(mapResearchQuote({ symbol: "AAPL", price: 0 })).toBeNull();
    expect(mapResearchQuote({ symbol: "", price: 10 })).toBeNull();
  });
});

describe("the shared-cache provider", () => {
  it("asks the shared endpoint once for the whole batch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ quotes: [row("AAPL", 10, 1), row("MSFT", 20, 2)] }));
    const provider = createResearchQuoteProvider({ baseUrl: "https://api.uat.hushh.ai/", fetchImpl, now: () => 0 });
    const result = await provider(["AAPL", "MSFT"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://api.uat.hushh.ai/api/market/quotes?symbols=AAPL%2CMSFT",
    );
    expect(result.quotes.map((q: { symbol: string }) => q.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(result.source).toContain("hushh-research");
  });

  it("returns rows in the order asked for", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ quotes: [row("MSFT", 20, 2), row("AAPL", 10, 1)] }));
    const provider = createResearchQuoteProvider({ baseUrl: "https://x.invalid", fetchImpl, now: () => 0 });
    const result = await provider(["AAPL", "MSFT"]);
    expect(result.quotes.map((q: { symbol: string }) => q.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  it("backs off after a 5xx instead of asking again", async () => {
    let clock = 0;
    const fetchImpl = vi.fn().mockResolvedValue(response({}, 503));
    const provider = createResearchQuoteProvider({ baseUrl: "https://x.invalid", fetchImpl, now: () => clock });

    await expect(provider(["AAPL"])).rejects.toThrow(/503/);
    await expect(provider(["AAPL"])).rejects.toThrow(/cooldown/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 121_000;
    await expect(provider(["AAPL"])).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats an empty answer as a failure so the fallback runs", async () => {
    // An empty strip is the failure this whole path exists to avoid; it must not look like success.
    const fetchImpl = vi.fn().mockResolvedValue(response({ quotes: [] }));
    const provider = createResearchQuoteProvider({ baseUrl: "https://x.invalid", fetchImpl, now: () => 0 });
    await expect(provider(["AAPL"])).rejects.toThrow(/no usable rows/);
  });
});

describe("rung order", () => {
  const good = async () => ({ success: true, quotes: [{ symbol: "AAPL" }], count: 1 });

  it("uses the shared cache when it answers", async () => {
    const fallback = vi.fn();
    const provider = createPreferredQuoteProvider({ preferred: good, fallback });
    await provider(["AAPL"]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to the local client when the shared cache cannot answer", async () => {
    const fallback = vi.fn().mockResolvedValue({ success: true, quotes: [], count: 0 });
    const provider = createPreferredQuoteProvider({
      preferred: async () => {
        throw new Error("connect ECONNREFUSED https://api.uat.hushh.ai");
      },
      fallback,
    });
    await provider(["AAPL"]);
    expect(fallback).toHaveBeenCalledWith(["AAPL"]);
  });

  it("never lets the upstream message escape, only that a fallback happened", async () => {
    const seen: unknown[] = [];
    const provider = createPreferredQuoteProvider({
      preferred: async () => {
        throw new Error("connect ECONNREFUSED https://api.uat.hushh.ai");
      },
      fallback: async () => ({ success: true, quotes: [], count: 0 }),
      onFallback: (error: unknown) => seen.push(error),
    });
    const result = await provider(["AAPL"]);
    // The reason reaches the operator hook; the caller gets the fallback's answer and nothing else.
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("hushh.ai");
  });

  it("is the plain local client when no shared endpoint is configured", async () => {
    const fallback = vi.fn().mockResolvedValue({ success: true, quotes: [], count: 0 });
    expect(createPreferredQuoteProvider({ preferred: undefined, fallback })).toBe(fallback);
  });
});
