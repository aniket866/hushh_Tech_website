import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { app as webApp } from "../server.js";
import { createStockQuotesHandler } from "../api/stock-quotes.js";
import {
  createPublicStockQuotesGateway,
  PUBLIC_STOCK_QUOTES_GATEWAY_CONTRACT,
  readPublicStockQuotesGatewayConfig,
} from "../api/shared/publicStockQuotesGateway.js";

const SERVICE_TOKEN = "service-token-" + "x".repeat(64);
const UAT_SERVICE =
  "https://hushh-tech-investor-api-175298245599.us-central1.run.app";

type GatewayRequest = {
  method: string;
  originalUrl: string;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: Buffer;
};

type TestResponse = {
  statusCode: number;
  body: unknown;
  headers: Map<string, string>;
  setHeader: (name: string, value: unknown) => TestResponse;
  removeHeader: (name: string) => TestResponse;
  status: (value: number) => TestResponse;
  json: (value: unknown) => TestResponse;
  send: (value: unknown) => TestResponse;
};

type CapturedFetchOptions = RequestInit & { headers: Headers };

function env(overrides: Record<string, string> = {}) {
  return {
    HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED: "true",
    GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
    HUSHH_TECH_INVESTOR_API_URL: UAT_SERVICE,
    HUSHH_TECH_PUBLIC_RATE_LIMIT_SALT:
      "unit-test-only-rate-limit-salt-32-bytes-minimum",
    PUBLIC_STOCK_QUOTES_GATEWAY_RATE_LIMIT: "30",
    PUBLIC_STOCK_QUOTES_GATEWAY_TIMEOUT_MS: "25000",
    ...overrides,
  };
}

function request(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    method: "GET",
    originalUrl: "/api/stock-quotes",
    headers: {
      host: "uat.hushhtech.com",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.7, 198.51.100.4",
      origin: "https://uat.hushhtech.com",
      referer: "https://uat.hushhtech.com/discover-fund-a",
      "sec-fetch-site": "same-origin",
    },
    ...overrides,
  };
}

function response(): TestResponse {
  const headers = new Map<string, string>();
  const result: TestResponse = {
    statusCode: 0,
    body: null as unknown,
    headers,
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), String(value));
      return result;
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
      return result;
    },
    status(value: number) {
      result.statusCode = value;
      return result;
    },
    json(value: unknown) {
      result.body = value;
      return result;
    },
    send(value: unknown) {
      result.body = value;
      return result;
    },
  };
  return result;
}

function errorCode(result: TestResponse) {
  return (result.body as { detail?: { code?: string } } | null)?.detail?.code;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("public stock-quotes GCP gateway", () => {
  it("stops default-off before identity-token and upstream network work", async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const handler = createPublicStockQuotesGateway({
      env: { HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED: "false" },
      getServiceIdentityToken: async () => {
        tokenCalls += 1;
        return SERVICE_TOKEN;
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response();
      },
    });
    const res = response();
    await handler(request(), res);
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe("FEATURE_DISABLED");
    expect(tokenCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("keeps the real Express route default-off ahead of JSON parsing", async () => {
    const previous = process.env.HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED;
    process.env.HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED = "false";
    const server = webApp.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address() as AddressInfo;
      const result = await fetch(
        `http://127.0.0.1:${address.port}/api/stock-quotes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{malformed-json",
        },
      );
      expect(result.status).toBe(404);
      expect(await result.json()).toEqual({
        detail: { code: "FEATURE_DISABLED", message: "Not found." },
      });
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.has("access-control-allow-origin")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) {
        delete process.env.HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED;
      } else {
        process.env.HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED = previous;
      }
    }
  });

  it("uses only the canonical private investor service and an HMAC client key", async () => {
    const calls: Array<{ url: string; options: CapturedFetchOptions }> = [];
    // Pinned to the proxy path explicitly. The handler's default is now a direct provider — the
    // investor API has no /api/v1/public/stock-quotes route, so proxying answered Google's HTML
    // 404 and every request became a 502 — but the proxy path still exists for the day it does,
    // and this is what guards its audience and its client-key derivation.
    const handler = createStockQuotesHandler({
      quoteProvider: null,
      env: env(),
      getServiceIdentityToken: async (audience) => {
        expect(audience).toBe(UAT_SERVICE);
        return SERVICE_TOKEN;
      },
      requestId: () => "request-stock-gcp-1",
      fetchImpl: async (url, options) => {
        calls.push({
          url: String(url),
          options: options as CapturedFetchOptions,
        });
        return new Response(
          JSON.stringify({
            success: true,
            quotes: [],
            fetchedAt: "2026-08-22T00:00:00.000Z",
            count: 0,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=3600",
              "access-control-allow-origin": "*",
            },
          },
        );
      },
    });
    const res = response();
    await handler(request(), res);

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${UAT_SERVICE}/api/v1/public/stock-quotes`,
    );
    expect(calls[0].options.redirect).toBe("error");
    expect(calls[0].options.method).toBe("GET");
    expect(calls[0].options.headers.get("authorization")).toBe(
      `Bearer ${SERVICE_TOKEN}`,
    );
    const rateKey = calls[0].options.headers.get("x-hushh-public-rate-key");
    expect(rateKey).toMatch(/^[a-f0-9]{64}$/);
    expect(rateKey).not.toContain("203.0.113.7");
    expect(calls[0].options.headers.has("origin")).toBe(false);
    expect(calls[0].options.headers.has("apikey")).toBe(false);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
    expect(JSON.parse((res.body as Buffer).toString("utf8"))).toEqual({
      success: true,
      quotes: [],
      fetchedAt: "2026-08-22T00:00:00.000Z",
      count: 0,
    });
  });

  it("rejects cross-origin, credentialed, and ambiguous proxy requests before tokens", async () => {
    let tokenCalls = 0;
    const handler = createPublicStockQuotesGateway({
      env: env(),
      getServiceIdentityToken: async () => {
        tokenCalls += 1;
        return SERVICE_TOKEN;
      },
      fetchImpl: async () => new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
    });
    const cases = [
      request({
        headers: {
          ...request().headers,
          origin: "https://attacker.example",
        },
      }),
      request({
        headers: { ...request().headers, host: "attacker.example" },
      }),
      request({
        headers: { ...request().headers, "x-forwarded-proto": "http" },
      }),
      /*
       * Two X-Forwarded-For cases used to sit here, and both asserted the wrong model.
       *
       * A single-entry chain was expected to be refused — but that is precisely what Cloud Run
       * sends for every real browser, so this test was asserting that the feature could never
       * work, which is why nobody noticed it could not. A three-entry chain was expected to be
       * refused too; a caller can prepend as many hops as it likes and only the last one, which
       * Cloud Run appends, means anything.
       *
       * Which hop the limiter keys on is now pinned properly in
       * tests/publicStockQuotesClientIp.test.ts, including the forged-prefix case that used to
       * get through with a caller-chosen identity.
       */
      request({
        headers: { ...request().headers, authorization: "Bearer public" },
      }),
      request({ headers: { ...request().headers, apikey: "public" } }),
    ];
    for (const req of cases) {
      const res = response();
      await handler(req, res);
      expect([400, 403]).toContain(res.statusCode);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.has("access-control-allow-origin")).toBe(false);
    }
    expect(tokenCalls).toBe(0);
  });

  it("enforces the local public limit before issuing a second token", async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const handler = createPublicStockQuotesGateway({
      env: env({ PUBLIC_STOCK_QUOTES_GATEWAY_RATE_LIMIT: "1" }),
      now: () => 1_700_000_000_000,
      getServiceIdentityToken: async () => {
        tokenCalls += 1;
        return SERVICE_TOKEN;
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const first = response();
    const second = response();
    await handler(request(), first);
    await handler(request(), second);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(errorCode(second)).toBe("RATE_LIMITED");
    expect(second.headers.get("retry-after")).toBe("40");
    expect(tokenCalls).toBe(1);
    expect(fetchCalls).toBe(1);
  });

  it("preserves POST shape without accepting client credentials or oversized input", async () => {
    const calls: CapturedFetchOptions[] = [];
    const handler = createPublicStockQuotesGateway({
      env: env(),
      getServiceIdentityToken: async () => SERVICE_TOKEN,
      fetchImpl: async (_url, options) => {
        calls.push(options as CapturedFetchOptions);
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const body = Buffer.from(JSON.stringify({ symbols: ["AAPL"] }));
    const accepted = response();
    await handler(
      request({
        method: "POST",
        body: JSON.parse(body.toString("utf8")),
        headers: {
          ...request().headers,
          "content-type": "application/json",
        },
      }),
      accepted,
    );
    expect(accepted.statusCode).toBe(200);
    expect(Buffer.from(calls[0].body)).toEqual(body);
    expect(calls[0].headers.has("apikey")).toBe(false);

    const tooLarge = response();
    await handler(
      request({
        method: "POST",
        body: { pad: "x".repeat(8_193) },
        headers: {
          ...request().headers,
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.8, 198.51.100.4",
        },
      }),
      tooLarge,
    );
    expect(tooLarge.statusCode).toBe(413);
    expect(errorCode(tooLarge)).toBe("PAYLOAD_TOO_LARGE");
  });

  it("measures raw wire bytes before JSON parsing or token work", async () => {
    let tokenCalls = 0;
    const handler = createPublicStockQuotesGateway({
      env: env(),
      getServiceIdentityToken: async () => {
        tokenCalls += 1;
        return SERVICE_TOKEN;
      },
      fetchImpl: async () => new Response(),
    });
    const wireBody = Buffer.from(
      `{ "symbols": ["AAPL"]${" ".repeat(8_193)}}`,
      "utf8",
    );
    const rawRequest = Object.assign(
      Readable.from([wireBody]),
      request({
        method: "POST",
        headers: {
          ...request().headers,
          "content-type": "application/json",
        },
      }),
    );
    const result = response();
    await handler(rawRequest, result);
    expect(result.statusCode).toBe(413);
    expect(errorCode(result)).toBe("PAYLOAD_TOO_LARGE");
    expect(tokenCalls).toBe(0);
  });

  it("maps target timeouts and transport errors to private fail-closed responses", async () => {
    vi.useFakeTimers();
    const timedOut = createPublicStockQuotesGateway({
      env: env({ PUBLIC_STOCK_QUOTES_GATEWAY_TIMEOUT_MS: "1000" }),
      getServiceIdentityToken: async () => SERVICE_TOKEN,
      fetchImpl: async (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const timeoutResponse = response();
    const pending = timedOut(request(), timeoutResponse);
    await vi.advanceTimersByTimeAsync(1_001);
    await pending;
    expect(timeoutResponse.statusCode).toBe(503);
    expect(errorCode(timeoutResponse)).toBe("UPSTREAM_UNAVAILABLE");
    expect(timeoutResponse.headers.has("access-control-allow-origin")).toBe(false);

    vi.useRealTimers();
    const failed = createPublicStockQuotesGateway({
      env: env(),
      getServiceIdentityToken: async () => SERVICE_TOKEN,
      fetchImpl: async () => {
        throw new Error("network failed");
      },
    });
    const failedResponse = response();
    await failed(request(), failedResponse);
    expect(failedResponse.statusCode).toBe(503);
    expect(errorCode(failedResponse)).toBe("UPSTREAM_UNAVAILABLE");
    expect(failedResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("caps an untrusted response stream before buffering it", async () => {
    const handler = createPublicStockQuotesGateway({
      env: env(),
      getServiceIdentityToken: async () => SERVICE_TOKEN,
      fetchImpl: async () =>
        new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = response();
    await handler(request(), result);
    expect(result.statusCode).toBe(502);
    expect(errorCode(result)).toBe("UPSTREAM_UNAVAILABLE");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });

  it("aborts identity work when the client disconnects", async () => {
    let tokenSignal: AbortSignal | null = null;
    let tokenStarted = () => {};
    const started = new Promise<void>((resolve) => {
      tokenStarted = resolve;
    });
    let fetchCalls = 0;
    const handler = createPublicStockQuotesGateway({
      env: env(),
      getServiceIdentityToken: async (_audience, options) => {
        tokenSignal = options.signal;
        tokenStarted();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response();
      },
    });
    const disconnecting = Object.assign(
      new (await import("node:events")).EventEmitter(),
      request(),
    );
    const result = response();
    const pending = handler(disconnecting, result);
    await started;
    disconnecting.emit("aborted");
    await pending;
    expect(tokenSignal?.aborted).toBe(true);
    expect(fetchCalls).toBe(0);
    expect(result.statusCode).toBe(0);
  });

  it("rejects drifted project, target, and HMAC contracts", () => {
    expect(readPublicStockQuotesGatewayConfig({})).toEqual({ enabled: false });
    for (const drift of [
      { GOOGLE_CLOUD_PROJECT: "other-project" },
      { HUSHH_TECH_INVESTOR_API_URL: "https://attacker.example" },
      { HUSHH_TECH_PUBLIC_RATE_LIMIT_SALT: "short" },
      { HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED: "yes" },
    ]) {
      expect(() => readPublicStockQuotesGatewayConfig(env(drift))).toThrow();
    }
  });

  it("registers the same-origin route and removes the retired provider caller", () => {
    const serverSource = readFileSync(
      new URL("../server.js", import.meta.url),
      "utf8",
    );
    const hookSource = readFileSync(
      new URL("../src/hooks/useStockQuotes.ts", import.meta.url),
      "utf8",
    );
    const gatewaySource = readFileSync(
      new URL("../api/shared/publicStockQuotesGateway.js", import.meta.url),
      "utf8",
    );
    expect(serverSource).toContain("app.all('/api/stock-quotes'");
    expect(serverSource.indexOf("app.all('/api/stock-quotes'")).toBeLessThan(
      serverSource.indexOf("app.use(express.json"),
    );
    expect(hookSource).toContain("const STOCK_QUOTES_API_URL = '/api/stock-quotes'");
    expect(hookSource).toContain("fetch(STOCK_QUOTES_API_URL");
    expect(hookSource).toContain("credentials: 'same-origin'");
    expect(hookSource).not.toContain("/functions/v1/stock-quotes");
    expect(hookSource).not.toContain("apikey");
    expect(gatewaySource.toLowerCase()).not.toContain("supabase");
    expect(PUBLIC_STOCK_QUOTES_GATEWAY_CONTRACT).toMatchObject({
      publicPath: "/api/stock-quotes",
      privatePath: "/api/v1/public/stock-quotes",
      maxRequestBytes: 8_192,
    });
  });
});
