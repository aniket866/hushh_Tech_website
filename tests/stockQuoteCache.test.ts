import { describe, expect, it, vi } from "vitest";

import {
  US_MARKET_CLOSED_TTL_SECONDS,
  US_MARKET_OPEN_TTL_SECONDS,
  createStockQuoteCache,
  quoteTtlSeconds,
  usMarketIsOpen,
} from "../api/shared/stockQuoteCache.js";

/**
 * The cache exists so provider traffic stops scaling with readers. Every assertion here is about
 * that: one upstream call per window however many callers arrive, a much longer window when the
 * market is shut, and never a cached failure.
 */

/** A moment in New York, expressed as the UTC instant it corresponds to. */
const ny = (iso: string) => new Date(iso);

describe("US market hours", () => {
  it("is open on a weekday between the bell and the close", () => {
    // 2026-09-10 is a Thursday. 14:00Z is 10:00 in New York during daylight time.
    expect(usMarketIsOpen(ny("2026-09-10T14:00:00Z"))).toBe(true);
  });

  it("is shut before the opening bell and after the close", () => {
    expect(usMarketIsOpen(ny("2026-09-10T13:29:00Z"))).toBe(false); // 09:29 ET
    expect(usMarketIsOpen(ny("2026-09-10T20:01:00Z"))).toBe(false); // 16:01 ET
  });

  it("is shut at the weekend", () => {
    // 2026-09-12 is a Saturday; mid-session on a weekday, but the market is closed.
    expect(usMarketIsOpen(ny("2026-09-12T14:00:00Z"))).toBe(false);
  });

  it("holds a quote far longer while the market is shut", () => {
    expect(quoteTtlSeconds(ny("2026-09-10T14:00:00Z"))).toBe(US_MARKET_OPEN_TTL_SECONDS);
    expect(quoteTtlSeconds(ny("2026-09-12T14:00:00Z"))).toBe(US_MARKET_CLOSED_TTL_SECONDS);
    // The whole point: overnight and at weekends the upstream is hit 15x less often.
    expect(US_MARKET_CLOSED_TTL_SECONDS / US_MARKET_OPEN_TTL_SECONDS).toBe(15);
  });
});

describe("quote cache", () => {
  it("serves a second caller from cache rather than the provider", async () => {
    let clock = 0;
    const cache = createStockQuoteCache({ now: () => clock, ttlSeconds: () => 120 });
    const load = vi.fn().mockResolvedValue("quotes");

    expect(await cache.resolve("set", load)).toEqual({ value: "quotes", cached: false });
    expect(await cache.resolve("set", load)).toEqual({ value: "quotes", cached: true });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refetches once the entry is stale", async () => {
    let clock = 0;
    const cache = createStockQuoteCache({ now: () => clock, ttlSeconds: () => 120 });
    const load = vi.fn().mockResolvedValue("quotes");

    await cache.resolve("set", load);
    clock = 119_000;
    await cache.resolve("set", load);
    expect(load).toHaveBeenCalledTimes(1);

    clock = 121_000;
    await cache.resolve("set", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("makes ONE upstream call when a cold cache is hit by many callers at once", async () => {
    // This is the case a plain TTL cache still gets wrong, and the exact moment a rate limit
    // bites: fifty readers arrive together, all miss, and all call the provider.
    let release: (value: string) => void = () => {};
    const load = vi.fn(
      () => new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const cache = createStockQuoteCache({ now: () => 0, ttlSeconds: () => 120 });

    const callers = Promise.all(Array.from({ length: 50 }, () => cache.resolve("set", load)));
    release("quotes");
    const results = await callers;

    expect(load).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.value === "quotes")).toBe(true);
  });

  it("never caches a failure", async () => {
    // A failed fetch pinned for thirty minutes would turn one bad moment into a half-hour outage.
    const cache = createStockQuoteCache({ now: () => 0, ttlSeconds: () => 120 });
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValue("quotes");

    await expect(cache.resolve("set", load)).rejects.toThrow("upstream down");
    expect(await cache.resolve("set", load)).toEqual({ value: "quotes", cached: false });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed load to everyone waiting on it", async () => {
    const cache = createStockQuoteCache({ now: () => 0, ttlSeconds: () => 120 });
    let reject: (error: Error) => void = () => {};
    const load = vi.fn(
      () => new Promise<string>((_resolve, rejectFn) => {
        reject = rejectFn;
      }),
    );

    const first = cache.resolve("set", load);
    const second = cache.resolve("set", load);
    reject(new Error("upstream down"));

    await expect(first).rejects.toThrow("upstream down");
    await expect(second).rejects.toThrow("upstream down");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps different symbol sets apart", async () => {
    const cache = createStockQuoteCache({ now: () => 0, ttlSeconds: () => 120 });
    const load = vi.fn(async () => "quotes");

    await cache.resolve("set-a", load);
    await cache.resolve("set-b", load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(2);
  });
});
