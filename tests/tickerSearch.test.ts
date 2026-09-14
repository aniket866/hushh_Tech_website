import { describe, expect, it, vi } from "vitest";

import {
  createResearchTickerSearch,
  mapTicker,
  normalizeLimit,
  normalizeQuery,
} from "../api/shared/researchTickerSearch.js";
import { assertSearchOrigin, createTickerSearchHandler } from "../api/ticker-search.js";

/**
 * Ticker search, served by hushh-research rather than reimplemented here.
 *
 * The route exists so the browser never calls that service directly, so most of what is worth
 * testing is the guards it would otherwise lose: same-origin, the rate limiter, the cache that
 * keeps a keystroke from becoming a request, and an upstream failure that reveals nothing.
 */

const ENV = {
  HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED: "true",
  GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
  HUSHH_TECH_PUBLIC_RATE_LIMIT_SALT: "x".repeat(48),
  HUSHH_RESEARCH_API_BASE_URL: "https://api.uat.hushh.ai",
};

const request = (url: string, headers: Record<string, string> = {}) => ({
  method: "GET",
  url,
  headers: {
    host: "uat.hushhtech.com",
    "x-forwarded-proto": "https",
    "x-forwarded-for": "50.35.60.144",
    ...headers,
  },
});

/** Minimal response double: enough to record what the handler wrote. */
const response = () => {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk: string) {
      this.body = chunk;
    },
  };
  return res;
};

const call = async (handler: ReturnType<typeof createTickerSearchHandler>, req = request("/api/ticker-search?q=AAPL")) => {
  const res = response();
  await handler(req as never, res as never);
  return { status: res.statusCode, json: JSON.parse(res.body || "{}"), headers: res.headers };
};

describe("query and limit normalisation", () => {
  it("accepts symbols and company names", () => {
    for (const q of ["AAPL", "BRK-B", "Berkshire Hathaway", "AT&T", "O'Reilly"]) {
      expect(normalizeQuery(q)).toBe(q);
    }
  });

  it("rejects anything that is not a symbol or a name", () => {
    // The value is interpolated into a URL. encodeURIComponent handles that, and rejecting here
    // means a malformed query never costs an upstream request at all.
    for (const q of ["", "  ", "../../etc", "a".repeat(65), "<script>", "?q=x"]) {
      expect(normalizeQuery(q)).toBeNull();
    }
  });

  it("bounds the limit rather than passing a caller's number through", () => {
    expect(normalizeLimit("5")).toBe(5);
    expect(normalizeLimit("9999")).toBe(25);
    expect(normalizeLimit("0")).toBe(8);
    expect(normalizeLimit(undefined)).toBe(8);
  });
});

describe("mapping a registry row", () => {
  it("keeps what a result renders and drops what a browser has no business seeing", () => {
    const row = mapTicker({
      ticker: "aapl",
      title: "Apple Inc.",
      cik: "0000320193",
      exchange: "Nasdaq",
      sic_code: "3571",
      sector_primary: "Technology",
    });
    expect(row).toEqual({ symbol: "AAPL", name: "Apple Inc.", exchange: "Nasdaq", sector: "Technology" });
    expect(JSON.stringify(row)).not.toContain("0000320193");
  });

  it("drops a row with no symbol instead of rendering a blank one", () => {
    expect(mapTicker({ title: "Nameless" })).toBeNull();
  });
});

describe("the research client", () => {
  const ok = (rows: unknown[]) => ({ ok: true, status: 200, json: async () => rows });

  it("asks the registry and returns mapped rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([{ ticker: "AAPL", title: "Apple Inc." }]));
    const search = createResearchTickerSearch({ baseUrl: "https://api.uat.hushh.ai/", fetchImpl, now: () => 0 });
    const results = await search("AAPL", 3);

    expect(results).toEqual([{ symbol: "AAPL", name: "Apple Inc.", exchange: null, sector: null }]);
    const url = String(fetchImpl.mock.calls[0][0]);
    // The trailing slash on the base must not become a double slash in the path.
    expect(url).toBe("https://api.uat.hushh.ai/api/tickers/search?q=AAPL&limit=3");
  });

  it("backs off after a 5xx instead of asking again", async () => {
    let clock = 0;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const search = createResearchTickerSearch({ baseUrl: "https://x.invalid", fetchImpl, now: () => clock });

    await expect(search("AAPL")).rejects.toThrow(/503/);
    await expect(search("AAPL")).rejects.toThrow(/cooldown/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 121_000;
    await expect(search("AAPL")).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not bench the service over one bad query", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 422 });
    const search = createResearchTickerSearch({ baseUrl: "https://x.invalid", fetchImpl, now: () => 0 });
    await expect(search("AAPL")).rejects.toThrow();
    await expect(search("AAPL")).rejects.toThrow(/422/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("the route", () => {
  it("answers a search and never leaks the upstream shape", async () => {
    const search = vi.fn().mockResolvedValue([{ symbol: "AAPL", name: "Apple Inc.", exchange: "Nasdaq", sector: "Technology" }]);
    const result = await call(createTickerSearchHandler({ env: ENV, search, now: () => 0 }));
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ success: true, query: "AAPL", count: 1 });
    expect(result.json.results[0].symbol).toBe("AAPL");
  });

  it("serves a repeated query from cache rather than the service", async () => {
    // A search box calls this on every keystroke. Without the cache, so does the registry.
    const search = vi.fn().mockResolvedValue([]);
    const handler = createTickerSearchHandler({ env: ENV, search, now: () => 0 });
    await call(handler);
    await call(handler);
    await call(handler, request("/api/ticker-search?q=aapl"));
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("refuses a cross-origin caller", async () => {
    const search = vi.fn();
    const handler = createTickerSearchHandler({ env: ENV, search, now: () => 0 });
    const result = await call(handler, request("/api/ticker-search?q=AAPL", { host: "evil.example" }));
    expect(result.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });

  it("requires https, so a plain-http hop cannot reach it", async () => {
    const handler = createTickerSearchHandler({ env: ENV, search: vi.fn(), now: () => 0 });
    const result = await call(handler, request("/api/ticker-search?q=AAPL", { "x-forwarded-proto": "http" }));
    expect(result.status).toBe(403);
  });

  it("tolerates a missing Origin header, which a same-origin GET often has", () => {
    expect(() =>
      assertSearchOrigin(request("/api/ticker-search?q=A"), { publicOrigin: "https://uat.hushhtech.com" }),
    ).not.toThrow();
  });

  it("rejects an empty or malformed query before it costs a request", async () => {
    const search = vi.fn();
    const handler = createTickerSearchHandler({ env: ENV, search, now: () => 0 });
    expect((await call(handler, request("/api/ticker-search"))).status).toBe(400);
    expect((await call(handler, request("/api/ticker-search?q=%3Cscript%3E"))).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it("is 404 when the public market surface is switched off", async () => {
    const handler = createTickerSearchHandler({ env: { ...ENV, HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED: "false" }, search: vi.fn() });
    expect((await call(handler)).status).toBe(404);
  });

  it("reports an upstream failure without repeating what it said", async () => {
    // A provider error message can carry the upstream URL, and this response is public.
    const search = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED https://api.uat.hushh.ai"));
    const result = await call(createTickerSearchHandler({ env: ENV, search, now: () => 0 }));
    expect(result.status).toBe(503);
    expect(result.json).toEqual({ success: false, code: "UPSTREAM_UNAVAILABLE", error: "Service unavailable." });
    expect(result.json.error).not.toContain("hushh.ai");
  });

  it("rate-limits a single client", async () => {
    const search = vi.fn().mockImplementation(async (q: string) => [{ symbol: q, name: q, exchange: null, sector: null }]);
    const handler = createTickerSearchHandler({ env: { ...ENV, PUBLIC_STOCK_QUOTES_GATEWAY_RATE_LIMIT: "2" }, search, now: () => 0 });
    const statuses: number[] = [];
    for (const q of ["AAPL", "MSFT", "NVDA", "GOOG"]) {
      statuses.push((await call(handler, request(`/api/ticker-search?q=${q}`))).status);
    }
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses.at(-1)).toBe(429);
  });
});
