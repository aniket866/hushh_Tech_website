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
    overviewList: async () => ({
      investors: [],
      total: 0,
      counts: {
        needs_attention: 0,
        completed_onboarding: 0,
        bank_linked: 0,
        payment_review: 0,
        manually_approved: 0,
        all: 0,
      },
      sourceWarnings: [],
    }),
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
  assert.equal(invalid.headers["cache-control"], "private, no-store");
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

test("GCS catalog cancels an oversized stream before buffering beyond 25 MiB", async () => {
  let cancelled = 0;
  let reads = 0;
  const maxBytes = 25 * 1024 * 1024;
  const reader = {
    async read() {
      reads += 1;
      if (reads === 1) return { done: false, value: new Uint8Array(maxBytes) };
      return { done: false, value: new Uint8Array(1) };
    },
    async cancel() { cancelled += 1; },
    releaseLock() {},
  };
  const adapter = createGcsLocationCatalogAdapter({
    bucket: "hushh-tech-uat-catalogs",
    object: "locations/v1.json",
    generation: "123",
    sha256: "a".repeat(64),
    getAccessToken: async () => "identity-token",
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      body: { getReader: () => reader },
    }),
  });
  await assert.rejects(adapter.countries(SIGNAL), /integrity/);
  assert.equal(reads, 2);
  assert.equal(cancelled, 1);
});

test("GCS catalog cancels a declared oversized body before its first read", async () => {
  let cancelled = 0;
  let reads = 0;
  const adapter = createGcsLocationCatalogAdapter({
    bucket: "hushh-tech-uat-catalogs",
    object: "locations/v1.json",
    generation: "123",
    sha256: "a".repeat(64),
    getAccessToken: async () => "identity-token",
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers({ "content-length": String(25 * 1024 * 1024 + 1) }),
      body: { getReader: () => ({
        async read() { reads += 1; return { done: true }; },
        async cancel() { cancelled += 1; },
        releaseLock() {},
      }) },
    }),
  });
  await assert.rejects(adapter.countries(SIGNAL), /integrity/);
  assert.equal(reads, 0);
  assert.equal(cancelled, 1);
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

test("metrics Cloud SQL loading never reads the user email table", async () => {
  const statements = [];
  const database = { transaction: async (work) => work({
    async query(text) {
      statements.push(text);
      return { rows: [] };
    },
  }) };
  const result = await createCloudSqlReadBatchAdapter().overview({
    database,
    actor: ADMIN,
    includeUsers: false,
    signal: SIGNAL,
  });
  assert.deepEqual(result.userRows, []);
  assert.equal(statements.some((text) => /FROM public\.users/.test(text)), false);
});

test("admin overview/list/metrics/analytics return bounded deterministic shapes", async () => {
  const overviewCalls = [];
  const listCalls = [];
  const populated = emptyOverview({
    ndaRows: [{ user_id: "u1", signer_name: "Ada", signed_at: "2026-08-20T00:00:00Z" }],
    onboardingRows: [{ user_id: "u1", is_completed: true, financial_link_status: "completed" }],
    paymentRows: [{ user_id: "u1", status: "verified_investor", commitment_amount: 10, paid_at: "2026-08-21T00:00:00Z", created_at: "2026-08-20T00:00:00Z" }],
    userRows: [{ id: "u1", email: "ada@example.com" }],
  });
  const handlers = createGcpReadBatchHandlers({
    dataAdapter: dataAdapter({
      overview: async (options) => { overviewCalls.push(options); return populated; },
      overviewList: async (options) => {
        listCalls.push(options);
        return {
          investors: [{ userId: "u1" }],
          total: 1,
          counts: { needs_attention: 0, completed_onboarding: 1, bank_linked: 0,
            payment_review: 1, manually_approved: 1, all: 1 },
          sourceWarnings: [],
        };
      },
      analytics: async () => populated,
    }),
  });
  assert.equal((await handlers["fund-payment-admin-overview"](context({ body: {} }))).body.investors.length, 1);
  assert.equal((await handlers["fund-payment-admin-overview-metrics"](context({ body: {} }))).body.funnel.verified, 1);
  assert.equal(overviewCalls.at(-1).includeUsers, false);
  const list = await handlers["fund-payment-admin-overview-list"](
    context({ body: { page: 2, pageSize: 500, tab: "all", search: "ada" } }),
  );
  assert.equal(list.body.pageSize, 100);
  assert.equal(list.body.investors.length, 1);
  assert.deepEqual(
    { page: listCalls[0].page, pageSize: listCalls[0].pageSize, tab: listCalls[0].tab, search: listCalls[0].search },
    { page: 2, pageSize: 100, tab: "all", search: "ada" },
  );
  assert.equal((await handlers["fund-payment-admin-analytics"](context({ body: {} }))).body.success, true);
});

test("admin list adapter applies projection, filtering, LIMIT and OFFSET in Cloud SQL", async () => {
  const statements = [];
  const database = { transaction: async (work) => work({
    async query(text, values = []) {
      statements.push({ text, values });
      if (/WITH candidate_users/.test(text)) {
        return { rows: [{
          user_id: "u1",
          recipient_name: "Ada",
          stage: "manual_approved",
          payment_status: "verified_investor",
          commitment_amount: "10",
          onboarding_complete: true,
          bank_linked: false,
          meet_ceo_done: false,
          financial_data_status: "missing",
          plaid_product_count: 0,
          plaid_account_count: 0,
          kyc_status: "not_found",
          missing_pieces: [],
          data_sources: ["fund_stripe_payment_requests"],
          count_all: 9,
          count_needs_attention: 4,
          count_completed_onboarding: 5,
          count_bank_linked: 3,
          count_payment_review: 6,
          count_manually_approved: 2,
        }] };
      }
      return { rows: [] };
    },
  }) };
  const result = await createCloudSqlReadBatchAdapter().overviewList({
    database,
    actor: ADMIN,
    page: 3,
    pageSize: 25,
    tab: "all",
    search: "ada",
    signal: SIGNAL,
  });
  const statement = statements.find(({ text }) => /WITH candidate_users/.test(text));
  assert.ok(statement);
  assert.match(statement.text, /LIMIT \$3 OFFSET \$4/);
  assert.match(statement.text, /LEFT JOIN public\.users users ON users\.id = candidates\.user_id/);
  assert.doesNotMatch(statement.text, /SELECT\s+(?:\w+\.)?\*/i);
  const derived = statement.text.split("), derived AS (")[1].split("), projected AS (")[0];
  assert.doesNotMatch(derived, /\bkyc\./i);
  assert.deepEqual(statement.values, ["ada", "all", 25, 50]);
  assert.equal(result.investors.length, 1);
  assert.equal(result.total, 9);
  assert.equal(result.counts.manually_approved, 2);
});

test("admin list falls back only when the optional KYC relation is absent", async () => {
  const statements = [];
  let listAttempts = 0;
  const database = { transaction: async (work) => work({
    async query(text, values = []) {
      statements.push({ text, values });
      if (!/WITH candidate_users/.test(text)) return { rows: [] };
      listAttempts += 1;
      if (listAttempts === 1) {
        const error = new Error('relation "public.kyc_attestations" does not exist');
        error.code = "42P01";
        throw error;
      }
      assert.doesNotMatch(text, /kyc_attestations/i);
      return { rows: [{
        user_id: null,
        count_all: 0,
        count_needs_attention: 0,
        count_completed_onboarding: 0,
        count_bank_linked: 0,
        count_payment_review: 0,
        count_manually_approved: 0,
      }] };
    },
  }) };
  const result = await createCloudSqlReadBatchAdapter().overviewList({
    database,
    actor: ADMIN,
    page: 1,
    pageSize: 25,
    tab: "all",
    search: "",
    signal: SIGNAL,
  });
  assert.equal(listAttempts, 2);
  assert.deepEqual(result.investors, []);
  assert.deepEqual(result.sourceWarnings, [{
    source: "kyc_attestations",
    code: "SOURCE_UNAVAILABLE",
    message: "Optional source is unavailable",
  }]);
  assert.ok(statements.some(({ text }) => text === "ROLLBACK TO SAVEPOINT optional_kyc_admin_list"));
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
