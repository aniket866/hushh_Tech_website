import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createFinnhubQuoteAdapter,
  createGeocodingAdapter,
} from "../src/adapters/investor-read-only.js";
import { createApp } from "../src/app.js";
import { FUNCTION_CONTRACTS } from "../src/contracts.js";
import {
  createInvestorReadOnlyHandlers,
  LEGACY_STOCK_SYMBOLS,
} from "../src/handlers/investor-read-only.js";
import {
  LEGACY_FUNCTION_REGISTRY,
  LEGACY_FUNCTIONS,
} from "../src/registry.js";
import { errorCode, request } from "./helpers.js";

const INTERNAL_CALLER = Object.freeze({
  kind: "google-service",
  email: "hushh-tech-web-uat@hushh-tech-uat.iam.gserviceaccount.com",
  subject: "gateway-subject",
});
const FIREBASE_ACTOR = Object.freeze({
  kind: "firebase",
  uid: "firebase-user-1",
  authTime: 1_999_999_999,
});
const FIXED_NOW = new Date("2026-08-21T12:00:00.000Z");
const BROWSER_STOCK_SYMBOLS = Object.freeze([
  "2222.SR",
  "GOOG",
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "BRK.B",
  "META",
  "JPM",
  "1398.HK",
  "601939.SS",
  "XOM",
  "601288.SS",
  "TSM",
  "601988.SS",
  "TM",
  "0857.HK",
  "WMT",
  "TCEHY",
  "BAC",
  "EQNR",
  "JNJ",
  "DTE.DE",
  "CMCSA",
  "UNH",
  "HSBC",
  "SHEL",
]);

function adapters(overrides = {}) {
  return {
    geocoder: {
      reverse: async ({ latitude, longitude }) => ({
        country: "United States",
        countryCode: "US",
        state: "California",
        stateCode: "CA",
        city: "San Francisco",
        postalCode: "94105",
        phoneDialCode: "+1",
        timezone: "America/New_York",
        formattedAddress: "San Francisco, CA, USA",
        latitude,
        longitude,
      }),
    },
    stockQuotes: {
      configured: true,
      quote: async (symbol) => ({
        symbol,
        currentPrice: 10,
        change: 1,
        percentChange: 10,
        high: 11,
        low: 9,
        open: 9.5,
        previousClose: 9,
        timestamp: 1_700_000_000,
      }),
    },
    now: () => FIXED_NOW,
    delay: async () => {},
    ...overrides,
  };
}

function handlers(overrides = {}) {
  return createInvestorReadOnlyHandlers(adapters(overrides));
}

function directContext({ body = null, signal } = {}) {
  return {
    request: {
      method: "POST",
      headers: Object.freeze({}),
      route: Object.freeze({
        slug: "test",
        suffix: Object.freeze([]),
        search: "",
      }),
      requestId: "request-test",
      body,
    },
    actor: FIREBASE_ACTOR,
    googleCaller: INTERNAL_CALLER,
    database: Object.freeze({}),
    entry: Object.freeze({}),
    signal: signal ?? new AbortController().signal,
  };
}

function appDependencies(overrides = {}) {
  return {
    config: {
      serviceOwner: "investor-api",
      requestBodyLimitBytes: 16_384,
      requestRateLimit: 100,
      databaseStatementTimeoutMs: 15_000,
      handlerDeadlineMs: 20_000,
    },
    database: { pool: {} },
    verifyGoogleServiceRequest: async () => INTERNAL_CALLER,
    verifyFirebaseProductRequest: async () => FIREBASE_ACTOR,
    verifyWebhookRequest: async () => {
      throw new Error("not a webhook service");
    },
    verifyReadiness: async () => true,
    sharedRateLimiter: {
      consume: async () => ({ allowed: true }),
      verifyReady: async () => true,
    },
    handlers: handlers(),
    contracts: FUNCTION_CONTRACTS,
    ...overrides,
  };
}

function stagedRegistry(slug) {
  return {
    [slug]: Object.freeze({
      ...LEGACY_FUNCTION_REGISTRY[slug],
      migration_state: "PORTED_AND_VERIFIED",
    }),
  };
}

function jsonBodyOfSize(size) {
  const empty = Buffer.byteLength(JSON.stringify({ pad: "" }));
  assert.ok(size >= empty);
  const body = Buffer.from(JSON.stringify({ pad: "x".repeat(size - empty) }));
  assert.equal(body.length, size);
  return body;
}

test("reviewed contracts stay default-off except verified geocode", async () => {
  assert.deepEqual(Object.keys(FUNCTION_CONTRACTS).sort(), [
    "chat-check-access",
    "fund-payment-admin-analytics",
    "fund-payment-admin-overview",
    "fund-payment-admin-overview-list",
    "fund-payment-admin-overview-metrics",
    "generate-investor-profile",
    "get-locations",
    "hushh-location-geocode",
    "nda-admin-fetch",
    "investor-og-image",
    "stock-quotes",
  ]);
  assert.equal(FUNCTION_CONTRACTS["hushh-dob-inference"], undefined);
  assert.equal(LEGACY_FUNCTIONS.length, 112);
  assert.equal(
    LEGACY_FUNCTIONS.filter(
      ({ migration_state }) => migration_state === "INVENTORY_FROZEN",
    ).length,
    111,
  );
  assert.match(
    readFileSync(new URL("../src/server.js", import.meta.url), "utf8"),
    /handlers:\s*runtimeHandlers\.handlers/,
  );

  let calls = 0;
  const app = createApp(
    appDependencies({
      registry: {
        ...LEGACY_FUNCTION_REGISTRY,
        "hushh-location-geocode": Object.freeze({
          ...LEGACY_FUNCTION_REGISTRY["hushh-location-geocode"],
          migration_state: "INVENTORY_FROZEN",
        }),
      },
      handlers: {
        "hushh-location-geocode": async () => {
          calls += 1;
          return { status: 200, body: { impossible: true } };
        },
      },
    }),
  );
  const result = await request(
    app,
    "/api/v1/legacy-functions/hushh-location-geocode",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"latitude":0,"longitude":0}'),
    },
  );
  assert.equal(result.response.status, 503);
  assert.equal(errorCode(result), "FUNCTION_NOT_MIGRATED");
  assert.equal(calls, 0);
});

test("geocoding rejects missing, non-finite, and out-of-range coordinates", async () => {
  const handler = handlers()["hushh-location-geocode"];
  const missing = await handler(directContext({ body: { latitude: 1 } }));
  assert.deepEqual(missing.body, {
    success: false,
    error: "Missing latitude or longitude",
  });

  for (const body of [
    { latitude: "nan", longitude: 2 },
    { latitude: -90.000001, longitude: 0 },
    { latitude: 90.000001, longitude: 0 },
    { latitude: 0, longitude: -180.000001 },
    { latitude: 0, longitude: 180.000001 },
  ]) {
    const invalid = await handler(directContext({ body }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, {
      success: false,
      error: "Invalid latitude or longitude",
    });
  }

  for (const body of [
    { latitude: -90, longitude: -180 },
    { latitude: "90", longitude: "180" },
  ]) {
    const valid = await handler(directContext({ body }));
    assert.equal(valid.status, 200);
    assert.equal(valid.body.success, true);
  }
});

test("geocoding preserves provider success and error response shapes", async () => {
  const success = await handlers()["hushh-location-geocode"](
    directContext({ body: { latitude: "37.5", longitude: -122.4 } }),
  );
  assert.equal(success.status, 200);
  assert.equal(success.body.data.latitude, 37.5);
  assert.equal(success.headers["cache-control"], "private, no-store");

  const failure = await handlers({
    geocoder: {
      reverse: async () => {
        throw new Error("provider failed");
      },
    },
  })["hushh-location-geocode"](
    directContext({ body: { latitude: 1, longitude: 2 } }),
  );
  assert.deepEqual(failure.body, {
    success: false,
    error: "provider failed",
  });
});

test("geocoding adapter enforces bounds and uses Google then Nominatim", async () => {
  const calls = [];
  const controller = new AbortController();
  const adapter = createGeocodingAdapter({
    googleMapsApiKey: "test-key-not-a-secret",
    nominatimUserAgent: "hushh-test/1.0",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith("https://maps.googleapis.com/")) {
        return new Response(
          JSON.stringify({ status: "ZERO_RESULTS", results: [] }),
        );
      }
      return new Response(
        JSON.stringify({
          address: {
            country: "India",
            country_code: "in",
            state: "Maharashtra",
            "ISO3166-2-lvl4": "IN-MH",
            city: "Pune",
            postcode: "411001",
          },
          display_name: "Pune, Maharashtra, India",
        }),
        { status: 200 },
      );
    },
  });
  await assert.rejects(
    adapter.reverse({
      latitude: 91,
      longitude: 0,
      signal: controller.signal,
    }),
    /Invalid latitude or longitude/,
  );
  assert.equal(calls.length, 0);

  const result = await adapter.reverse({
    latitude: 18.52,
    longitude: 73.85,
    signal: controller.signal,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.match(
    calls[1].url,
    /^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/,
  );
  assert.equal(result.countryCode, "IN");
  assert.equal(result.stateCode, "MH");
  assert.equal(result.phoneDialCode, "+91");
});

test("stock quotes preserves fixed watchlist, batching, and partial failures", async () => {
  const quoted = [];
  const delays = [];
  const handler = handlers({
    stockQuotes: {
      configured: true,
      quote: async (symbol) => {
        quoted.push(symbol);
        return symbol === "META"
          ? null
          : { symbol, currentPrice: 1, change: 0, percentChange: 0 };
      },
    },
    delay: async (milliseconds) => delays.push(milliseconds),
  })["stock-quotes"];
  const result = await handler(
    directContext({ body: { symbols: ["NOT-USED"] } }),
  );
  assert.deepEqual(quoted, LEGACY_STOCK_SYMBOLS);
  assert.deepEqual(delays, [200, 200]);
  assert.equal(result.body.success, true);
  assert.equal(result.body.count, 26);
  assert.equal(result.body.fetchedAt, FIXED_NOW.toISOString());
  assert.equal(result.headers["cache-control"], "private, no-store");

  const unavailable = await handlers({
    stockQuotes: { configured: false, quote: async () => null },
  })["stock-quotes"](directContext());
  assert.deepEqual(unavailable.body, {
    error: "Stock API not configured",
    quotes: [],
  });
});

test("Finnhub adapter encodes symbols and projects the exact quote fields", async () => {
  const calls = [];
  const adapter = createFinnhubQuoteAdapter({
    apiKey: "test-key-not-a-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(
        JSON.stringify({
          c: 10,
          d: 1,
          dp: 11.1,
          h: 12,
          l: 8,
          o: 9,
          pc: 9,
          t: 7,
        }),
      );
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await adapter.quote("BRK.B", { signal }), {
    symbol: "BRK.B",
    currentPrice: 10,
    change: 1,
    percentChange: 11.1,
    high: 12,
    low: 8,
    open: 9,
    previousClose: 9,
    timestamp: 7,
  });
  assert.match(calls[0].url, /symbol=BRK\.B/);
  assert.notEqual(calls[0].options.signal, signal);
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(calls[0].options.redirect, "error");
});

test("stock quote adapter and handler preserve the observed fixed response list while ignoring the browser list", async () => {
  const providerSymbols = [];
  const delays = [];
  const stockQuotes = createFinnhubQuoteAdapter({
    apiKey: "test-key-not-a-secret",
    fetchImpl: async (url, options) => {
      const symbol = new URL(url).searchParams.get("symbol");
      providerSymbols.push(symbol);
      assert.equal(options.redirect, "error");
      return new Response(
        JSON.stringify({
          c: 10,
          d: 1,
          dp: 10,
          h: 11,
          l: 9,
          o: 9.5,
          pc: 9,
          t: 1_700_000_000,
        }),
      );
    },
  });
  const result = await handlers({
    stockQuotes,
    delay: async (milliseconds) => delays.push(milliseconds),
  })["stock-quotes"](
    directContext({ body: { symbols: BROWSER_STOCK_SYMBOLS } }),
  );

  assert.equal(
    Buffer.byteLength(JSON.stringify({ symbols: BROWSER_STOCK_SYMBOLS })),
    222,
  );
  assert.notDeepEqual(BROWSER_STOCK_SYMBOLS, LEGACY_STOCK_SYMBOLS);
  assert.deepEqual(providerSymbols, LEGACY_STOCK_SYMBOLS);
  assert.deepEqual(delays, [200, 200]);
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.headers["cache-control"], "private, no-store");
  assert.deepEqual(Object.keys(result.body).sort(), [
    "count",
    "fetchedAt",
    "quotes",
    "success",
  ]);
  assert.equal(result.body.success, true);
  assert.equal(result.body.count, 27);
  assert.equal(result.body.quotes.length, 27);
  assert.deepEqual(
    result.body.quotes.map(({ symbol }) => symbol),
    LEGACY_STOCK_SYMBOLS,
  );
  assert.deepEqual(Object.keys(result.body.quotes[0]).sort(), [
    "change",
    "currentPrice",
    "high",
    "low",
    "open",
    "percentChange",
    "previousClose",
    "symbol",
    "timestamp",
  ]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.body.quotes[0]).map(([key, value]) => [
        key,
        typeof value,
      ]),
    ),
    {
      symbol: "string",
      currentPrice: "number",
      change: "number",
      percentChange: "number",
      high: "number",
      low: "number",
      open: "number",
      previousClose: "number",
      timestamp: "number",
    },
  );
});

test("service boundary enforces the same exact body limits as the gateway", async () => {
  assert.equal(
    FUNCTION_CONTRACTS["hushh-location-geocode"].maxRequestBytes,
    16_384,
  );
  assert.equal(FUNCTION_CONTRACTS["stock-quotes"].maxRequestBytes, 8_192);

  let stockCalls = 0;
  const stockApp = createApp(
    appDependencies({
      registry: stagedRegistry("stock-quotes"),
      handlers: {
        "stock-quotes": async () => {
          stockCalls += 1;
          return { status: 204, body: null };
        },
      },
    }),
  );
  const accepted = await request(
    stockApp,
    "/api/v1/legacy-functions/stock-quotes",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonBodyOfSize(8_192),
    },
  );
  assert.equal(accepted.response.status, 204);
  assert.equal(stockCalls, 1);

  const rejected = await request(
    stockApp,
    "/api/v1/legacy-functions/stock-quotes",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonBodyOfSize(8_193),
    },
  );
  assert.equal(rejected.response.status, 413);
  assert.equal(errorCode(rejected), "PAYLOAD_TOO_LARGE");
  assert.equal(stockCalls, 1);

  let geocodeCalls = 0;
  const geocodeApp = createApp(
    appDependencies({
      registry: stagedRegistry("hushh-location-geocode"),
      handlers: {
        "hushh-location-geocode": async () => {
          geocodeCalls += 1;
          return { status: 204, body: null };
        },
      },
    }),
  );
  const exact = await request(
    geocodeApp,
    "/api/v1/legacy-functions/hushh-location-geocode",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonBodyOfSize(16_384),
    },
  );
  assert.equal(exact.response.status, 204);
  assert.equal(geocodeCalls, 1);
});

test("remaining contracts reject wrong method, query, media type, and cache", async () => {
  const app = createApp(
    appDependencies({
      registry: stagedRegistry("hushh-location-geocode"),
      handlers: {
        "hushh-location-geocode": async () => ({ status: 204, body: null }),
      },
    }),
  );
  const wrongMethod = await request(
    app,
    "/api/v1/legacy-functions/hushh-location-geocode",
  );
  assert.equal(wrongMethod.response.status, 405);

  const query = await request(
    app,
    "/api/v1/legacy-functions/hushh-location-geocode?extra=1",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    },
  );
  assert.equal(query.response.status, 400);

  const media = await request(
    app,
    "/api/v1/legacy-functions/hushh-location-geocode",
    {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("{}"),
    },
  );
  assert.equal(media.response.status, 415);

  const badCache = createApp(
    appDependencies({
      registry: stagedRegistry("hushh-location-geocode"),
      handlers: {
        "hushh-location-geocode": async () => ({
          status: 200,
          headers: { "cache-control": "public, max-age=3600" },
          body: { ok: true },
        }),
      },
    }),
  );
  const rejectedCache = await request(
    badCache,
    "/api/v1/legacy-functions/hushh-location-geocode",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    },
  );
  assert.equal(rejectedCache.response.status, 503);
  assert.equal(errorCode(rejectedCache), "HANDLER_CONTRACT_INVALID");
});

test("service deadline aborts remaining handler work", async () => {
  let observedSignal;
  const app = createApp(
    appDependencies({
      config: {
        ...appDependencies().config,
        handlerDeadlineMs: 25,
        databaseStatementTimeoutMs: 10,
      },
      registry: stagedRegistry("hushh-location-geocode"),
      handlers: {
        "hushh-location-geocode": async ({ signal }) => {
          observedSignal = signal;
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve),
          );
          return { status: 204, body: null };
        },
      },
    }),
  );
  const timedOut = await request(
    app,
    "/api/v1/legacy-functions/hushh-location-geocode",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    },
  );
  assert.equal(timedOut.response.status, 504);
  assert.equal(errorCode(timedOut), "HANDLER_DEADLINE_EXCEEDED");
  assert.equal(observedSignal.aborted, true);
});
