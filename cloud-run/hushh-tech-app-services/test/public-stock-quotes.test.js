import assert from "node:assert/strict";
import test from "node:test";

import { createFinnhubQuoteAdapter } from "../src/adapters/investor-read-only.js";
import { createApp } from "../src/app.js";
import { createRuntimeHandlers } from "../src/runtime-handlers.js";
import { errorCode, request } from "./helpers.js";

const RATE_KEY = "a".repeat(64);
const GOOGLE_CALLER = Object.freeze({
  kind: "google-service",
  email: "hushh-tech-web-uat@hushh-tech-uat.iam.gserviceaccount.com",
  subject: "gateway-subject",
});

function config(overrides = {}) {
  return {
    serviceOwner: "investor-api",
    requestBodyLimitBytes: 16_384,
    requestRateLimit: 100,
    publicStockQuotesEnabled: true,
    publicStockQuotesRateLimit: 30,
    publicStockQuotesProviderRequestRateLimit: 2,
    databaseStatementTimeoutMs: 15_000,
    handlerDeadlineMs: 20_000,
    ...overrides,
  };
}

function successHandler(observed = null) {
  return async (context) => {
    if (observed) observed.push(context);
    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      },
      body: {
        success: true,
        quotes: [],
        fetchedAt: "2026-08-22T00:00:00.000Z",
        count: 0,
      },
    };
  };
}

function dependencies(overrides = {}) {
  return {
    config: config(),
    database: { pool: {} },
    verifyGoogleServiceRequest: async () => GOOGLE_CALLER,
    verifyFirebaseProductRequest: async () => {
      throw new Error("public route must not verify a Firebase session");
    },
    verifyWebhookRequest: async () => {
      throw new Error("not a webhook service");
    },
    verifyReadiness: async () => true,
    verifyPublicHandlerReadiness: async (slug) => slug === "stock-quotes",
    sharedRateLimiter: {
      consume: async () => ({ allowed: true }),
      verifyReady: async () => true,
    },
    handlers: Object.freeze({ "stock-quotes": successHandler() }),
    ...overrides,
  };
}

function publicHeaders(overrides = {}) {
  return {
    "x-hushh-public-rate-key": RATE_KEY,
    ...overrides,
  };
}

test("public stock quotes stay default-off before auth, rate limits, or handlers", async () => {
  const calls = { google: 0, shared: 0, handler: 0 };
  const app = createApp(
    dependencies({
      config: config({ publicStockQuotesEnabled: false }),
      verifyGoogleServiceRequest: async () => {
        calls.google += 1;
        return GOOGLE_CALLER;
      },
      sharedRateLimiter: {
        consume: async () => {
          calls.shared += 1;
          return { allowed: true };
        },
        verifyReady: async () => true,
      },
      handlers: {
        "stock-quotes": async () => {
          calls.handler += 1;
          return { status: 204, body: null };
        },
      },
    }),
  );
  const result = await request(app, "/api/v1/public/stock-quotes", {
    method: "POST",
    headers: publicHeaders({ "content-type": "application/json" }),
    body: Buffer.alloc(32_000, 120),
  });
  assert.equal(result.response.status, 404);
  assert.deepEqual(calls, { google: 0, shared: 0, handler: 0 });
  assert.equal(result.response.headers.get("access-control-allow-origin"), null);
  assert.equal(
    result.response.headers.get("cache-control"),
    "private, no-store",
  );
});

test("investor-api serves the frozen stock candidate without Firebase or database access", async () => {
  const observed = [];
  let firebaseCalls = 0;
  const app = createApp(
    dependencies({
      verifyFirebaseProductRequest: async () => {
        firebaseCalls += 1;
        throw new Error("must not run");
      },
      handlers: Object.freeze({
        "stock-quotes": successHandler(observed),
      }),
    }),
  );
  const result = await request(app, "/api/v1/public/stock-quotes", {
    headers: publicHeaders(),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(firebaseCalls, 0);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].actor.kind, "public");
  assert.equal(observed[0].actor.subject, RATE_KEY);
  assert.deepEqual(observed[0].database, {});
  assert.equal(observed[0].entry.slug, "stock-quotes");
  assert.equal(observed[0].entry.migration_state, "INVENTORY_FROZEN");
  assert.equal(result.response.headers.get("access-control-allow-origin"), null);
  assert.equal(
    result.response.headers.get("cache-control"),
    "private, no-store",
  );

  const legacy = await request(
    app,
    "/api/v1/legacy-functions/stock-quotes",
    { headers: publicHeaders() },
  );
  assert.equal(legacy.response.status, 503);
  assert.equal(errorCode(legacy), "FUNCTION_NOT_MIGRATED");
  assert.equal(observed.length, 1);
});

test("the candidate rejects wrong owners, browser headers, and unhashed rate keys", async () => {
  let googleCalls = 0;
  const verifyGoogleServiceRequest = async () => {
    googleCalls += 1;
    return GOOGLE_CALLER;
  };
  const wrongOwner = createApp(
    dependencies({
      config: config({ serviceOwner: "identity-api" }),
      verifyGoogleServiceRequest,
    }),
  );
  const hidden = await request(
    wrongOwner,
    "/api/v1/public/stock-quotes",
    { headers: publicHeaders() },
  );
  assert.equal(hidden.response.status, 404);

  const app = createApp(dependencies({ verifyGoogleServiceRequest }));
  for (const headers of [
    publicHeaders({ origin: "https://uat.hushhtech.com" }),
    publicHeaders({ "sec-fetch-site": "same-origin" }),
  ]) {
    const rejected = await request(app, "/api/v1/public/stock-quotes", {
      headers,
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(errorCode(rejected), "CROSS_ORIGIN_FORBIDDEN");
    assert.equal(rejected.response.headers.get("access-control-allow-origin"), null);
  }
  const raw = await request(app, "/api/v1/public/stock-quotes", {
    headers: publicHeaders({ "x-hushh-public-rate-key": "203.0.113.7" }),
  });
  assert.equal(raw.response.status, 400);
  assert.equal(errorCode(raw), "INVALID_REQUEST");
  assert.equal(googleCalls, 0);
});

test("local and shared public rate limits fail closed before the handler", async () => {
  let localHandlerCalls = 0;
  const local = createApp(
    dependencies({
      config: config({ publicStockQuotesRateLimit: 1 }),
      handlers: {
        "stock-quotes": async () => {
          localHandlerCalls += 1;
          return { status: 204, body: null };
        },
      },
    }),
  );
  const first = await request(local, "/api/v1/public/stock-quotes", {
    headers: publicHeaders(),
  });
  const second = await request(local, "/api/v1/public/stock-quotes", {
    headers: publicHeaders(),
  });
  assert.equal(first.response.status, 204);
  assert.equal(second.response.status, 429);
  assert.equal(errorCode(second), "RATE_LIMITED");
  assert.equal(localHandlerCalls, 1);

  let sharedHandlerCalls = 0;
  const shared = createApp(
    dependencies({
      sharedRateLimiter: {
        consume: async () => ({ allowed: false }),
        verifyReady: async () => true,
      },
      handlers: {
        "stock-quotes": async () => {
          sharedHandlerCalls += 1;
          return { status: 204, body: null };
        },
      },
    }),
  );
  const denied = await request(shared, "/api/v1/public/stock-quotes", {
    headers: publicHeaders(),
  });
  assert.equal(denied.response.status, 429);
  assert.equal(errorCode(denied), "RATE_LIMITED");
  assert.equal(sharedHandlerCalls, 0);
});

test("the provider-wide budget spans distinct public client keys", async () => {
  let handlerCalls = 0;
  const app = createApp(
    dependencies({
      config: config({ publicStockQuotesProviderRequestRateLimit: 2 }),
      handlers: {
        "stock-quotes": async () => {
          handlerCalls += 1;
          return { status: 204, body: null };
        },
      },
    }),
  );
  for (const suffix of ["a", "b"]) {
    const accepted = await request(app, "/api/v1/public/stock-quotes", {
      headers: publicHeaders({
        "x-hushh-public-rate-key": suffix.repeat(64),
      }),
    });
    assert.equal(accepted.response.status, 204);
  }
  const denied = await request(app, "/api/v1/public/stock-quotes", {
    headers: publicHeaders({ "x-hushh-public-rate-key": "c".repeat(64) }),
  });
  assert.equal(denied.response.status, 429);
  assert.equal(errorCode(denied), "RATE_LIMITED");
  assert.equal(handlerCalls, 2);
});

test("readiness requires the provider seam and shared limiter when enabled", async () => {
  const ready = createApp(dependencies());
  const accepted = await request(ready, "/readyz");
  assert.equal(accepted.response.status, 200);

  for (const overrides of [
    { verifyPublicHandlerReadiness: async () => false },
    {
      sharedRateLimiter: {
        consume: async () => ({ allowed: true }),
        verifyReady: async () => false,
      },
    },
  ]) {
    const unavailable = createApp(dependencies(overrides));
    const result = await request(unavailable, "/readyz");
    assert.equal(result.response.status, 503);
  }
});

test("runtime wiring installs private geocode plus optional stock without startup fetch", async () => {
  let fetchCalls = 0;
  const disabled = createRuntimeHandlers({
    config: config({ publicStockQuotesEnabled: false }),
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.deepEqual(Object.keys(disabled.handlers), ["hushh-location-geocode"]);
  assert.equal(disabled.databaseRequired, false);

  assert.throws(
    () =>
      createRuntimeHandlers({
        config: config({ serviceOwner: "identity-api" }),
        fetchImpl: async () => new Response(),
      }),
    /only to investor-api/,
  );

  const investor = createRuntimeHandlers({
    config: {
      ...config(),
      finnhubApiKey: "test-key-not-a-secret",
      finnhubQuoteTimeoutMs: 100,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 500 });
    },
    delay: async () => {},
  });
  assert.deepEqual(Object.keys(investor.handlers), [
    "hushh-location-geocode",
    "stock-quotes",
  ]);
  assert.equal(await investor.verifyPublicHandlerReadiness("stock-quotes"), true);
  assert.equal(investor.databaseRequired, false);
  assert.equal(fetchCalls, 0);
});

test("Finnhub timeout and provider errors become partial misses while parent aborts propagate", async () => {
  const timedOut = createFinnhubQuoteAdapter({
    apiKey: "test-key-not-a-secret",
    timeoutMs: 100,
    fetchImpl: async (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  assert.equal(await timedOut.quote("AAPL"), null);

  const failed = createFinnhubQuoteAdapter({
    apiKey: "test-key-not-a-secret",
    timeoutMs: 100,
    fetchImpl: async () => new Response("{}", { status: 503 }),
  });
  assert.equal(await failed.quote("AAPL"), null);

  for (const payload of [
    {},
    { c: "10", d: 1, dp: 1, h: 11, l: 9, o: 9, pc: 9, t: 1 },
    { c: 10, d: 1, dp: 1, h: 11, l: 9, o: 9, pc: 9 },
  ]) {
    const malformed = createFinnhubQuoteAdapter({
      apiKey: "test-key-not-a-secret",
      timeoutMs: 100,
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    assert.equal(await malformed.quote("AAPL"), null);
  }

  const controller = new AbortController();
  controller.abort(new Error("parent stopped"));
  await assert.rejects(
    timedOut.quote("AAPL", { signal: controller.signal }),
    /parent stopped/,
  );
});
