import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCloudSqlReadBatchAdapter,
  createGcsLocationCatalogAdapter,
  createStaticLocationCatalogAdapter,
} from "../src/adapters/gcp-read-batch.js";
import { createApp } from "../src/app.js";
import {
  createGcpReadBatchHandlers,
  GCP_READ_BATCH_PROFILE_SCHEMA,
  GCP_READ_BATCH_SLUGS,
} from "../src/handlers/gcp-read-batch.js";
import { LEGACY_FUNCTION_REGISTRY } from "../src/registry.js";
import { RuntimeError } from "../src/errors.js";
import { errorCode, request } from "./helpers.js";

const SIGNAL = new AbortController().signal;
const NOW = new Date("2026-08-22T12:00:00.000Z");
const INTERNAL_CALLER = Object.freeze({
  kind: "google-service",
  email: "hushh-tech-web-gateway-uat@hushh-tech-uat.iam.gserviceaccount.com",
  subject: "gateway-subject",
});
const ADMIN = Object.freeze({
  kind: "firebase",
  uid: "admin-1",
  email: "admin@example.com",
  fundAdmin: true,
});

function emptyOverview(overrides = {}) {
  return {
    paymentRows: [], ndaRows: [], ceoRows: [], onboardingRows: [], paidRows: [],
    financialRows: [], itemRows: [], accountRows: [], productRows: [], userRows: [],
    subscriptionRows: [], kycRows: [], sourceWarnings: [], ...overrides,
  };
}

function dataAdapter(overrides = {}) {
  return {
    chatAccess: async () => ({
      access_type: "free", messages_limit: 3, messages_sent_count: 0,
    }),
    publicInvestorProfile: async () => null,
    overview: async () => emptyOverview(),
    analytics: async () => emptyOverview(),
    ...overrides,
  };
}

function context({ body = null, search = "", actor = ADMIN, database = {} } = {}) {
  return {
    actor,
    database,
    request: {
      method: "POST",
      headers: {},
      route: { slug: "test", suffix: [], search },
      requestId: "request-test",
      body,
    },
    signal: SIGNAL,
  };
}

test("candidate matrix covers exactly eight frozen, source-backed slugs", async () => {
  const matrix = JSON.parse(await readFile(
    new URL("../registry/candidates.gcp-read-batch.v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(matrix.deployment_state, "DEFAULT_OFF");
  assert.deepEqual(matrix.functions.map(({ slug }) => slug).sort(), [
    ...GCP_READ_BATCH_SLUGS,
  ]);
  for (const row of matrix.functions) {
    assert.match(row.source_sha256, /^[a-f0-9]{64}$/);
    assert.match(row.live_bundle_sha256, /^[a-f0-9]{64}$/);
    assert.equal(LEGACY_FUNCTION_REGISTRY[row.slug].migration_state, "INVENTORY_FROZEN");
    assert.ok(row.blockers.length > 0);
  }
});

test("location handler enforces the query contract and emits immutable data", async () => {
  const locationCatalog = createStaticLocationCatalogAdapter({
    countries: [{ isoCode: "US", name: "United States", states: [
      { isoCode: "CA", name: "California", cities: ["San Francisco"] },
    ] }],
  });
  const handler = createGcpReadBatchHandlers({
    dataAdapter: dataAdapter(), locationCatalog, now: () => NOW,
  })["get-locations"];
  const countries = await handler(context({ search: "?type=countries" }));
  assert.equal(countries.status, 200);
  assert.equal(countries.headers["cache-control"], "public, max-age=86400");
  assert.deepEqual(countries.body.data, [{ isoCode: "US", name: "United States" }]);
  const invalid = await handler(context({ search: "?type=cities&country=US" }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers["cache-control"], undefined);
});

test("GCS catalog rejects unpinned data before parsing", async () => {
  const bytes = Buffer.from(JSON.stringify({ countries: [] }));
  const adapter = createGcsLocationCatalogAdapter({
    bucket: "hushh-tech-uat-catalogs",
    object: "locations/v1.json",
    generation: "123",
    sha256: createHash("sha256").update("different").digest("hex"),
    getAccessToken: async () => "identity-token",
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).searchParams.get("generation"), "123");
      assert.equal(options.redirect, "error");
      return new Response(bytes);
    },
  });
  await assert.rejects(adapter.countries(SIGNAL), /integrity/);
});

test("chat access validates identifiers and preserves free, paid, and limit decisions", async () => {
  let calls = 0;
  const handlerFor = (token) => createGcpReadBatchHandlers({
    dataAdapter: dataAdapter({ chatAccess: async () => { calls += 1; return token; } }),
    now: () => NOW,
  })["chat-check-access"];
  const invalid = await handlerFor({})(context({ body: { visitorId: "bad space", slug: "x" } }));
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  const free = await handlerFor({ access_type: "free", messages_limit: 3, messages_sent_count: 1 })(
    context({ body: { visitorId: "visitor-1", slug: "investor-1" } }),
  );
  assert.deepEqual(free.body, { canChat: true, needsPayment: false, accessType: "free", messagesRemaining: 2 });
  const limited = await handlerFor({ access_type: "paid", expires_at: "2026-08-22T12:30:00Z", hourly_message_count: 50 })(
    context({ body: { visitorId: "visitor-1", slug: "investor-1" } }),
  );
  assert.equal(limited.body.messagesRemaining, "rate_limited");
});

test("Cloud SQL chat adapter locks, inserts once, and never stores network PII", async () => {
  const calls = [];
  const client = { async query(text, values = []) {
    calls.push({ text, values });
    if (/SELECT id, access_type/.test(text)) return { rows: [] };
    if (/INSERT INTO public\.chat_access_tokens/.test(text)) {
      assert.match(text, /ip_address, user_agent/);
      assert.match(text, /NULL, NULL/);
      return { rows: [{ id: 1, access_type: "free", messages_limit: 3, messages_sent_count: 0 }] };
    }
    return { rows: [] };
  } };
  const database = { transaction: async (work) => work(client) };
  const token = await createCloudSqlReadBatchAdapter().chatAccess({
    database, visitorId: "visitor-1", slug: "investor-1", now: NOW, signal: SIGNAL,
  });
  assert.equal(token.access_type, "free");
  assert.match(calls[0].text, /pg_advisory_xact_lock/);
  assert.equal(calls.some(({ text }) => /INSERT INTO public\.chat_access_tokens/.test(text)), true);
});

test("OG handler queries only publishable profiles and escapes hostile SVG text", async () => {
  let requestedSlug = null;
  const handler = createGcpReadBatchHandlers({
    dataAdapter: dataAdapter({ publicInvestorProfile: async ({ slug }) => {
      requestedSlug = slug;
      return { name: "<script>alert(1)</script>", organisation: "A&B", investor_profile: {} };
    } }),
  })["investor-og-image"];
  const result = await handler(context({ search: "?slug=Profile_1" }));
  assert.equal(requestedSlug, "profile_1");
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "image/svg+xml");
  const svg = result.body.toString("utf8");
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /A&amp;B/);
});

test("every fund admin handler rejects non-boolean authority before data access", async () => {
  let calls = 0;
  const handlers = createGcpReadBatchHandlers({
    dataAdapter: dataAdapter({
      overview: async () => { calls += 1; return emptyOverview(); },
      analytics: async () => { calls += 1; return emptyOverview(); },
    }),
  });
  for (const slug of GCP_READ_BATCH_SLUGS.filter((slug) => slug.startsWith("fund-payment-admin-"))) {
    await assert.rejects(
      handlers[slug](context({ actor: { kind: "firebase", uid: "admin-1", fundAdmin: "true" }, body: {} })),
      (error) => error instanceof RuntimeError && error.code === "FUND_ADMIN_REQUIRED",
    );
  }
  assert.equal(calls, 0);
});

test("admin overview/list/metrics/analytics return bounded deterministic shapes", async () => {
  const populated = emptyOverview({
    ndaRows: [{ user_id: "u1", signer_name: "Ada", signed_at: "2026-08-20T00:00:00Z" }],
    onboardingRows: [{ user_id: "u1", is_completed: true, financial_link_status: "completed" }],
    paymentRows: [{ user_id: "u1", status: "verified_investor", commitment_amount: 10, paid_at: "2026-08-21T00:00:00Z", created_at: "2026-08-20T00:00:00Z" }],
    userRows: [{ id: "u1", email: "ada@example.com" }],
  });
  const handlers = createGcpReadBatchHandlers({
    dataAdapter: dataAdapter({ overview: async () => populated, analytics: async () => populated }),
  });
  assert.equal((await handlers["fund-payment-admin-overview"](context({ body: {} }))).body.investors.length, 1);
  assert.equal((await handlers["fund-payment-admin-overview-metrics"](context({ body: {} }))).body.funnel.verified, 1);
  assert.equal((await handlers["fund-payment-admin-overview-list"](context({ body: { pageSize: 500, tab: "all" } }))).body.pageSize, 100);
  assert.equal((await handlers["fund-payment-admin-analytics"](context({ body: {} }))).body.success, true);
});

test("profile generation accepts only the strict twelve-field Vertex schema", async () => {
  const investor_profile = Object.fromEntries(Object.entries(GCP_READ_BATCH_PROFILE_SCHEMA).map(
    ([field, options]) => [field, {
      value: ["asset_class_preference", "sector_preferences"].includes(field)
        ? options.slice(0, 2) : options[0],
      confidence: 0.5,
      rationale: "Caller-provided context supports this conservative value.",
    }],
  ));
  const handler = createGcpReadBatchHandlers({
    dataAdapter: dataAdapter(),
    vertexProfile: { configured: true, generate: async () => JSON.stringify({ investor_profile }) },
  })["generate-investor-profile"];
  const result = await handler(context({ actor: { kind: "firebase", uid: "u1" }, body: { input: { goal: "growth" }, context: { horizon: "long" } } }));
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body.profile).sort(), Object.keys(GCP_READ_BATCH_PROFILE_SCHEMA).sort());
  const missing = await handler(context({ actor: { kind: "firebase", uid: "u1" }, body: { input: {} } }));
  assert.equal(missing.status, 400);
});

test("gateway returns frozen 503 for each candidate before its handler or user auth", async () => {
  for (const slug of GCP_READ_BATCH_SLUGS) {
    let handlerCalls = 0;
    let userAuthCalls = 0;
    const entry = LEGACY_FUNCTION_REGISTRY[slug];
    const serviceOwner = entry.owner_group === "financial-api-worker"
      ? "financial-api"
      : entry.owner_group;
    const app = createApp({
      config: { serviceOwner, requestBodyLimitBytes: 65_536,
        requestRateLimit: 20, databaseStatementTimeoutMs: 5_000, handlerDeadlineMs: 10_000 },
      database: { pool: {} },
      registry: LEGACY_FUNCTION_REGISTRY,
      handlers: { [slug]: async () => { handlerCalls += 1; return { status: 200, body: {} }; } },
      verifyGoogleServiceRequest: async () => INTERNAL_CALLER,
      verifyFirebaseProductRequest: async () => { userAuthCalls += 1; return ADMIN; },
      verifyWebhookRequest: async () => { throw new Error("unexpected webhook"); },
      verifyReadiness: async () => true,
      verifyPublicHandlerReadiness: async () => false,
      sharedRateLimiter: { consume: async () => ({ allowed: true }), verifyReady: async () => true },
      webhookLedger: { verifyReady: async () => true },
    });
    const result = await request(app, `/api/v1/legacy-functions/${slug}`, { method: "POST" });
    assert.equal(result.response.status, 503, slug);
    assert.equal(errorCode(result), "FUNCTION_NOT_MIGRATED", slug);
    assert.equal(handlerCalls, 0, slug);
    assert.equal(userAuthCalls, 0, slug);
  }
});
