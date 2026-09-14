import { describe, expect, it, vi } from "vitest";

import { createYahooQuoteProvider, mapQuote } from "../api/shared/yahooQuotes.js";

/**
 * The free rung of hushh-research's provider ladder, which is the whole ladder here — this project
 * holds no Finnhub or FMP secret.
 */

/** One chart response. The endpoint takes a single symbol, so each call answers for one. */
const chart = (meta: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ chart: { result: [{ meta }] } }),
});

describe("yahoo quote mapping", () => {
  it("derives the move from the previous close", () => {
    // The chart endpoint gives no change field, only the previous close, so the move is computed.
    const quote = mapQuote({
      symbol: "AAPL",
      regularMarketPrice: 332.27,
      chartPreviousClose: 326.57,
      longName: "Apple Inc.",
    });
    expect(quote?.currentPrice).toBe(332.27);
    expect(quote?.change).toBeCloseTo(5.7, 5);
    expect(quote?.percentChange).toBeCloseTo(1.745, 2);
    expect(quote).toMatchObject({ symbol: "AAPL", name: "Apple Inc.", hasQuote: true });
  });

  it("reports no move rather than Infinity when the previous close is missing", () => {
    // Dividing by a zero previous close is how a ticker ends up rendering "Infinity%".
    const quote = mapQuote({ symbol: "X", regularMarketPrice: 10 });
    expect(quote?.percentChange).toBe(0);
    expect(Number.isFinite(quote?.change ?? NaN)).toBe(true);
  });

  it("drops a row with no price rather than defaulting it to zero", () => {
    // A zero price rendered as a quote is the same defect as a random one: plausible and wrong.
    expect(mapQuote({ symbol: "AAPL" })).toBeNull();
    expect(mapQuote({ symbol: "", regularMarketPrice: 10 })).toBeNull();
  });


});

describe("yahoo quote provider", () => {
  it("asks once per symbol and returns them in the order requested", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const symbol = decodeURIComponent(String(url).split("/chart/")[1].split("?")[0]);
      return chart({ symbol, regularMarketPrice: 10, chartPreviousClose: 10 });
    });
    const provider = createYahooQuoteProvider({ fetchImpl, now: () => 0 });
    const result = await provider(["AAPL", "MSFT", "GOOG"]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // The fan-out finishes out of order; the ticker must not reshuffle on every refresh.
    expect(result.quotes.map((q: { symbol: string }) => q.symbol)).toEqual(["AAPL", "MSFT", "GOOG"]);
  });

  it("de-duplicates the requested symbols", async () => {
    const fetchImpl = vi.fn(async () => chart({ symbol: "AAPL", regularMarketPrice: 1 }));
    const provider = createYahooQuoteProvider({ fetchImpl, now: () => 0 });
    await provider(["AAPL", "AAPL", " AAPL "]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the symbols that answered when one of them fails", async () => {
    // One delisted or mistyped symbol must not blank the whole strip.
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("BAD")
        ? { ok: false, status: 404 }
        : chart({ symbol: "AAPL", regularMarketPrice: 5, chartPreviousClose: 4 }),
    );
    const provider = createYahooQuoteProvider({ fetchImpl, now: () => 0 });
    const result = await provider(["AAPL", "BAD"]);
    expect(result.count).toBe(1);
    expect(result.success).toBe(true);
  });

  it("reports success false when the provider returns nothing usable", async () => {
    // The ticker hides itself unless a row carries a real quote, so this has to be honest.
    const fetchImpl = vi.fn().mockResolvedValue(chart({ symbol: "AAPL" }));
    const provider = createYahooQuoteProvider({ fetchImpl, now: () => 0 });
    const result = await provider(["AAPL"]);
    expect(result).toMatchObject({ success: false, count: 0, quotes: [] });
  });

  it("backs off after a 429 instead of asking again", async () => {
    let clock = 0;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const provider = createYahooQuoteProvider({ fetchImpl, now: () => clock });

    expect((await provider(["AAPL"])).count).toBe(0);
    await expect(provider(["AAPL"])).rejects.toThrow(/cooldown/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 181_000;
    expect((await provider(["AAPL"])).count).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not punish the provider for one bad symbol", async () => {
    // A 404 is usually one delisted ticker. Benching Yahoo for three minutes over it would turn a
    // stale symbol list into a dead strip.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const provider = createYahooQuoteProvider({ fetchImpl, now: () => 0 });
    await provider(["AAPL"]);
    await provider(["AAPL"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off after a network failure or timeout", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("aborted"));
    const provider = createYahooQuoteProvider({ fetchImpl, now: () => 0 });
    expect((await provider(["AAPL"])).count).toBe(0);
    await expect(provider(["AAPL"])).rejects.toThrow(/cooldown/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty symbol list rather than asking for everything", async () => {
    const fetchImpl = vi.fn();
    const provider = createYahooQuoteProvider({ fetchImpl, now: () => 0 });
    await expect(provider([])).rejects.toThrow(/no symbols/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
