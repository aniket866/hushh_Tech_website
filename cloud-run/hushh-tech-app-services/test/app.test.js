import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

import { createApp } from "../src/app.js";
import { createFunctionContracts } from "../src/contracts.js";
import { RuntimeError } from "../src/errors.js";
import { createRateLimiter } from "../src/rate-limit.js";
import { errorCode, request } from "./helpers.js";

const INTERNAL_CALLER = Object.freeze({
  kind: "google-service",
  email: "hushh-tech-web-gateway-uat@hushh-tech-uat.iam.gserviceaccount.com",
  subject: "gateway-subject",
});
const FIREBASE_ACTOR = Object.freeze({
  kind: "firebase",
  uid: "firebase-user-1",
  authTime: 1_999_999_999,
  launchAuthorizationId: "launch-1",
});

function config(serviceOwner = "identity-api", overrides = {}) {
  return {
    serviceOwner,
    requestBodyLimitBytes: 16_384,
    requestRateLimit: 10,
    databaseStatementTimeoutMs: 15_000,
    handlerDeadlineMs: 20_000,
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    config: config(),
    database: { pool: {} },
    verifyGoogleServiceRequest: async () => INTERNAL_CALLER,
    verifyFirebaseProductRequest: async () => FIREBASE_ACTOR,
    verifyWebhookRequest: async () => ({
      kind: "provider-webhook",
      provider: "test",
      eventId: "event-1",
    }),
    verifyReadiness: async () => true,
    sharedRateLimiter: {
      consume: async () => ({ allowed: true }),
      verifyReady: async () => true,
    },
    webhookLedger: {
      claim: async ({ eventKeyHash, payloadHash }) => ({
        state: "PROCESSING",
        acquired: true,
        eventKeyHash,
        payloadHash,
        claimToken: "claim-token-default",
        attempt: 1,
        leaseExpiresAtMs: Date.now() + 30_000,
      }),
      complete: async ({
        eventKeyHash,
        payloadHash,
        responseHash,
        outbox,
      }) => ({
        state: "COMPLETED",
        eventKeyHash,
        payloadHash,
        responseHash,
        outboxCount: outbox.length,
      }),
      markRetryable: async ({ eventKeyHash, payloadHash }) => ({
        state: "RETRYABLE",
        eventKeyHash,
        payloadHash,
      }),
      verifyReady: async () => true,
    },
    ...overrides,
  };
}

function portedEntry(overrides = {}) {
  return Object.freeze({
    slug: "synthetic-user",
    owner_group: "identity-api",
    auth_mode: "firebase_bearer",
    migration_state: "PORTED_AND_VERIFIED",
    final_disposition: "PORT_TO_GCP",
    ...overrides,
  });
}

function contractsFor(entry, overrides = {}) {
  return createFunctionContracts({
    [entry.slug]: {
      methods: ["POST"],
      subpaths: [""],
      query: {},
      body: "required",
      mediaTypes: ["application/json"],
      ...overrides,
    },
  });
}

test("health and readiness expose only bounded scaffold metadata", async () => {
  let internalAuthCalls = 0;
  const app = createApp(
    dependencies({
      verifyGoogleServiceRequest: async () => {
        internalAuthCalls += 1;
        return INTERNAL_CALLER;
      },
    }),
  );
  const health = await request(app, "/healthz");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, {
    status: "ok",
    service_owner: "identity-api",
    registry_version: 1,
    registry_count: 112,
  });
  assert.equal(health.response.headers.get("x-powered-by"), null);
  assert.equal(
    health.response.headers.get("cache-control"),
    "private, no-store",
  );

  const ready = await request(app, "/readyz");
  assert.equal(ready.response.status, 200);
  assert.equal(ready.body.status, "ready");
  assert.equal(internalAuthCalls, 0);

  const unavailable = createApp(
    dependencies({
      verifyReadiness: async () => Promise.reject(new Error("down")),
    }),
  );
  const notReady = await request(unavailable, "/readyz");
  assert.equal(notReady.response.status, 503);
  assert.equal(notReady.body.status, "not_ready");
});

test("unknown, wrong-owner, retired, and unported functions fail closed", async () => {
  let firebaseCalls = 0;
  let handlerCalls = 0;
  const app = createApp(
    dependencies({
      verifyFirebaseProductRequest: async () => {
        firebaseCalls += 1;
        return FIREBASE_ACTOR;
      },
      handlers: {
        "get-secrets": async () => {
          handlerCalls += 1;
          return { status: 200, body: { unsafe: true } };
        },
        "create-verification-session": async () => {
          handlerCalls += 1;
          return { status: 200, body: { unsafe: true } };
        },
      },
    }),
  );

  const unknown = await request(app, "/api/v1/legacy-functions/not-listed");
  assert.equal(unknown.response.status, 404);
  assert.equal(errorCode(unknown), "INVALID_ROUTE");

  const wrongOwner = await request(
    app,
    "/api/v1/legacy-functions/fund-stripe-webhook",
  );
  assert.equal(wrongOwner.response.status, 404);
  assert.equal(errorCode(wrongOwner), "INVALID_ROUTE");

  const retired = await request(app, "/api/v1/legacy-functions/get-secrets");
  assert.equal(retired.response.status, 410);
  assert.equal(errorCode(retired), "FEATURE_RETIRED");

  const frozen = await request(
    app,
    "/api/v1/legacy-functions/create-verification-session",
  );
  assert.equal(frozen.response.status, 503);
  assert.equal(errorCode(frozen), "FUNCTION_NOT_MIGRATED");
  assert.equal(firebaseCalls, 0);
  assert.equal(handlerCalls, 0);
});

test("ported user seams require both internal and Firebase identities", async () => {
  const entry = portedEntry();
  const calls = [];
  const app = createApp(
    dependencies({
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry),
      verifyGoogleServiceRequest: async () => {
        calls.push("google");
        return INTERNAL_CALLER;
      },
      verifyFirebaseProductRequest: async (_request, verifiedEntry) => {
        calls.push("firebase");
        assert.equal(verifiedEntry, entry);
        return FIREBASE_ACTOR;
      },
      handlers: {
        [entry.slug]: async ({ actor, googleCaller, request: input }) => {
          calls.push("handler");
          assert.equal("rawBody" in input, false);
          assert.deepEqual(input.body, { ok: true });
          assert.equal(input.headers["content-type"], "application/json");
          assert.equal(input.headers["idempotency-key"], "idempotency-1");
          assert.equal(
            Object.keys(input.headers).every((name) =>
              [
                "accept",
                "content-type",
                "idempotency-key",
                "if-match",
                "if-none-match",
              ].includes(name),
            ),
            true,
          );
          assert.equal(Object.isFrozen(input.headers), true);
          for (const secretName of [
            "authorization",
            "cookie",
            "x-api-key",
            "x-hushh-firebase-authorization",
            "x-hushh-firebase-uid",
            "x-hushh-firebase-auth-time",
            "stripe-signature",
          ]) {
            assert.equal(secretName in input.headers, false);
          }
          return {
            status: 200,
            body: { uid: actor.uid, caller: googleCaller.email },
          };
        },
      },
    }),
  );
  const result = await request(app, `/api/v1/legacy-functions/${entry.slug}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idempotency-1",
      authorization: "Bearer internal-token-must-not-reach-handler",
      cookie: "session=must-not-reach-handler",
      "x-api-key": "must-not-reach-handler",
      "x-hushh-firebase-authorization":
        "Bearer firebase-token-must-not-reach-handler",
      "x-hushh-firebase-uid": "firebase-user-1",
      "x-hushh-firebase-auth-time": "1999999999",
      "stripe-signature": "must-not-reach-handler",
    },
    body: Buffer.from('{"ok":true}'),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(calls, ["google", "firebase", "handler"]);
  assert.equal(result.body.uid, "firebase-user-1");
});

test("worker accepts direct private Google OIDC actor without Firebase", async () => {
  const entry = portedEntry({
    slug: "synthetic-worker",
    owner_group: "financial-api-worker",
    auth_mode: "firebase_bearer_or_google_service_identity",
  });
  let googleCalls = 0;
  let firebaseCalls = 0;
  const app = createApp(
    dependencies({
      config: config("worker"),
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry),
      verifyGoogleServiceRequest: async () => {
        googleCalls += 1;
        return INTERNAL_CALLER;
      },
      verifyFirebaseProductRequest: async () => {
        firebaseCalls += 1;
        throw new Error("must not be called");
      },
      handlers: {
        [entry.slug]: async ({ actor }) => ({
          status: 202,
          body: { kind: actor.kind, subject: actor.subject },
        }),
      },
    }),
  );
  const result = await request(app, `/api/v1/legacy-functions/${entry.slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
  });
  assert.equal(result.response.status, 202);
  assert.equal(result.body.kind, "google-service");
  assert.equal(googleCalls, 1);
  assert.equal(firebaseCalls, 0);
});

test("signed webhook owner preserves raw bytes for its verification seam", async () => {
  const entry = portedEntry({
    slug: "fund-stripe-webhook",
    owner_group: "signed-webhook-service",
    auth_mode: "provider_signature_raw_body",
  });
  const rawBody = Buffer.from('{"raw":"a  b"}', "utf8");
  let verifiedBody = null;
  let ledgerClaim = null;
  let ledgerCompletion = null;
  const app = createApp(
    dependencies({
      config: config("signed-webhook-service"),
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry),
      verifyWebhookRequest: async (requestToVerify) => {
        verifiedBody = Buffer.from(requestToVerify.body);
        return {
          kind: "provider-webhook",
          provider: "stripe",
          eventId: "event-1",
        };
      },
      webhookLedger: {
        verifyReady: async () => true,
        claim: async ({ version, eventKeyHash, payloadHash, leaseMs }) => {
          ledgerClaim = { version, eventKeyHash, payloadHash };
          return {
            state: "PROCESSING",
            acquired: true,
            eventKeyHash,
            payloadHash,
            claimToken: "claim-token-raw-body",
            attempt: 1,
            leaseExpiresAtMs: Date.now() + leaseMs,
          };
        },
        complete: async ({
          eventKeyHash,
          payloadHash,
          responseHash,
          outbox,
        }) => {
          ledgerCompletion = { responseHash, outbox };
          return {
            state: "COMPLETED",
            eventKeyHash,
            payloadHash,
            responseHash,
            outboxCount: outbox.length,
          };
        },
        markRetryable: async ({ eventKeyHash, payloadHash }) => ({
          state: "RETRYABLE",
          eventKeyHash,
          payloadHash,
        }),
      },
      handlers: {
        [entry.slug]: async ({ actor, database, webhookClaim }) => {
          assert.equal(actor.eventId, "event-1");
          assert.deepEqual(Object.keys(database), []);
          assert.equal(webhookClaim.eventKeyHash, ledgerClaim.eventKeyHash);
          assert.equal(webhookClaim.payloadHash, ledgerClaim.payloadHash);
          assert.equal(webhookClaim.claimToken, "claim-token-raw-body");
          return { status: 204, body: null };
        },
      },
    }),
  );
  const result = await request(app, `/api/v1/legacy-functions/${entry.slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
  assert.equal(result.response.status, 204);
  assert.equal(verifiedBody.equals(rawBody), true);
  assert.match(ledgerClaim.eventKeyHash, /^[a-f0-9]{64}$/);
  assert.match(ledgerClaim.payloadHash, /^[a-f0-9]{64}$/);
  assert.match(ledgerCompletion.responseHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(ledgerCompletion.outbox, []);
});

test("a handler cannot run without an exact local request contract", async () => {
  const entry = portedEntry();
  let handlerCalls = 0;
  const handler = async () => {
    handlerCalls += 1;
    return { status: 200, body: { ok: true } };
  };
  const noContract = createApp(
    dependencies({
      registry: { [entry.slug]: entry },
      handlers: { [entry.slug]: handler },
    }),
  );
  const missing = await request(
    noContract,
    `/api/v1/legacy-functions/${entry.slug}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    },
  );
  assert.equal(missing.response.status, 503);
  assert.equal(errorCode(missing), "FUNCTION_CONTRACT_MISSING");
  assert.equal(handlerCalls, 0);

  const exactContract = contractsFor(entry, {
    subpaths: ["items/:item_id"],
    query: {
      mode: { required: true, multiple: false, maxLength: 8 },
    },
  });
  const app = createApp(
    dependencies({
      registry: { [entry.slug]: entry },
      contracts: exactContract,
      handlers: { [entry.slug]: handler },
    }),
  );
  const cases = [
    {
      path: `/api/v1/legacy-functions/${entry.slug}/items/123?mode=full`,
      options: { method: "GET" },
      status: 405,
      code: "METHOD_NOT_ALLOWED",
    },
    {
      path: `/api/v1/legacy-functions/${entry.slug}/other/123?mode=full`,
      options: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
      },
      status: 404,
      code: "INVALID_ROUTE",
    },
    {
      path: `/api/v1/legacy-functions/${entry.slug}/items/123?unknown=x`,
      options: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
      },
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      path: `/api/v1/legacy-functions/${entry.slug}/items/123?mode=a&mode=b`,
      options: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
      },
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      path: `/api/v1/legacy-functions/${entry.slug}/items/123?mode=full`,
      options: {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: Buffer.from("{}"),
      },
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    },
  ];
  for (const example of cases) {
    const result = await request(app, example.path, example.options);
    assert.equal(result.response.status, example.status);
    assert.equal(errorCode(result), example.code);
  }
  assert.equal(handlerCalls, 0);

  const accepted = await request(
    app,
    `/api/v1/legacy-functions/${entry.slug}/items/123?mode=full`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    },
  );
  assert.equal(accepted.response.status, 200);
  assert.equal(handlerCalls, 1);
});

test("strict request, response, method, handler, and rate limits fail closed", async () => {
  const entry = portedEntry();
  const base = dependencies({
    registry: { [entry.slug]: entry },
    contracts: contractsFor(entry, {
      methods: ["GET", "POST"],
      body: "optional",
    }),
  });

  const missingHandler = createApp(base);
  const missing = await request(
    missingHandler,
    `/api/v1/legacy-functions/${entry.slug}`,
  );
  assert.equal(missing.response.status, 503);
  assert.equal(errorCode(missing), "FUNCTION_NOT_IMPLEMENTED");

  const oversized = createApp({
    ...base,
    config: config("identity-api", { requestBodyLimitBytes: 32 }),
    handlers: {
      [entry.slug]: async () => ({ status: 204, body: null }),
    },
  });
  const tooLarge = await request(
    oversized,
    `/api/v1/legacy-functions/${entry.slug}`,
    { method: "POST", body: Buffer.alloc(33, "x") },
  );
  assert.equal(tooLarge.response.status, 413);
  assert.equal(errorCode(tooLarge), "PAYLOAD_TOO_LARGE");

  const invalidResponse = createApp({
    ...base,
    handlers: {
      [entry.slug]: async () => ({
        status: 200,
        headers: { "cache-control": "public, max-age=3600" },
        body: { ok: true },
      }),
    },
  });
  const badResponse = await request(
    invalidResponse,
    `/api/v1/legacy-functions/${entry.slug}`,
  );
  assert.equal(badResponse.response.status, 503);
  assert.equal(errorCode(badResponse), "HANDLER_CONTRACT_INVALID");
  assert.equal(
    badResponse.response.headers.get("cache-control"),
    "private, no-store",
  );

  const wrongMethod = await request(
    invalidResponse,
    `/api/v1/legacy-functions/${entry.slug}`,
    { method: "OPTIONS" },
  );
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(errorCode(wrongMethod), "METHOD_NOT_ALLOWED");

  const limited = createApp({
    ...base,
    rateLimiter: createRateLimiter({ limit: 1 }),
    handlers: {
      [entry.slug]: async () => ({ status: 200, body: { ok: true } }),
    },
  });
  const first = await request(
    limited,
    `/api/v1/legacy-functions/${entry.slug}`,
  );
  const second = await request(
    limited,
    `/api/v1/legacy-functions/${entry.slug}`,
  );
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 429);
  assert.equal(errorCode(second), "RATE_LIMITED");
});

test("database facade rejects userless work and never exposes the pool", async () => {
  const entry = portedEntry({
    slug: "synthetic-worker",
    owner_group: "financial-api-worker",
    auth_mode: "firebase_bearer_or_google_service_identity",
  });
  const app = createApp(
    dependencies({
      config: config("worker"),
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry),
      handlers: {
        [entry.slug]: async ({ database }) => {
          assert.deepEqual(Object.keys(database), ["transaction"]);
          await database.transaction(async () => "unsafe");
          return { status: 200, body: { ok: true } };
        },
      },
    }),
  );
  const result = await request(app, `/api/v1/legacy-functions/${entry.slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
  });
  assert.equal(result.response.status, 403);
  assert.equal(errorCode(result), "OWNERSHIP_CONTEXT_REQUIRED");
});

test("malformed and traversal-like routes never reach handlers", async () => {
  const entry = portedEntry();
  let calls = 0;
  const app = createApp(
    dependencies({
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry, {
        methods: ["GET"],
        body: "forbidden",
        mediaTypes: [],
      }),
      handlers: {
        [entry.slug]: async () => {
          calls += 1;
          return { status: 200, body: { ok: true } };
        },
      },
    }),
  );
  for (const path of [
    "/api/v1/legacy-functions/../synthetic-user",
    "/api/v1/legacy-functions/synthetic-user/%2e%2e",
    "/api/v1/legacy-functions/Synthetic-User",
  ]) {
    const result = await request(app, path);
    assert.equal(result.response.status, 404);
  }
  assert.equal(calls, 0);
});

test("ported routes require a ready shared limiter before handlers or readiness", async () => {
  const entry = portedEntry();
  let handlerCalls = 0;
  const deps = dependencies({
    registry: { [entry.slug]: entry },
    contracts: contractsFor(entry),
    handlers: {
      [entry.slug]: async () => {
        handlerCalls += 1;
        return { status: 200, body: { unsafe: true } };
      },
    },
  });
  delete deps.sharedRateLimiter;
  const app = createApp(deps);

  const ready = await request(app, "/readyz");
  assert.equal(ready.response.status, 503);
  assert.equal(ready.body.status, "not_ready");

  const result = await request(app, `/api/v1/legacy-functions/${entry.slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
  });
  assert.equal(result.response.status, 503);
  assert.equal(errorCode(result), "SHARED_RATE_LIMIT_UNAVAILABLE");
  assert.equal(handlerCalls, 0);
});

test("ported webhooks require a durable ledger before handlers or readiness", async () => {
  const entry = portedEntry({
    slug: "fund-stripe-webhook",
    owner_group: "signed-webhook-service",
    auth_mode: "provider_signature_raw_body",
  });
  let handlerCalls = 0;
  const deps = dependencies({
    config: config("signed-webhook-service"),
    registry: { [entry.slug]: entry },
    contracts: contractsFor(entry),
    verifyWebhookRequest: async () => ({
      kind: "provider-webhook",
      provider: "stripe",
      eventId: "evt_missing_ledger",
    }),
    handlers: {
      [entry.slug]: async () => {
        handlerCalls += 1;
        return { status: 200, body: { unsafe: true } };
      },
    },
  });
  delete deps.webhookLedger;
  const app = createApp(deps);

  const ready = await request(app, "/readyz");
  assert.equal(ready.response.status, 503);

  const result = await request(app, `/api/v1/legacy-functions/${entry.slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
  });
  assert.equal(result.response.status, 503);
  assert.equal(errorCode(result), "WEBHOOK_LEDGER_UNAVAILABLE");
  assert.equal(handlerCalls, 0);
});

test("concurrent webhook replays are claimed once before handler execution", async () => {
  const entry = portedEntry({
    slug: "fund-stripe-webhook",
    owner_group: "signed-webhook-service",
    auth_mode: "provider_signature_raw_body",
  });
  const claims = new Map();
  let handlerCalls = 0;
  let markHandlerStarted;
  const handlerStarted = new Promise((resolve) => {
    markHandlerStarted = resolve;
  });
  let releaseHandler;
  const handlerRelease = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  const webhookLedger = {
    verifyReady: async () => true,
    claim: async ({ eventKeyHash, payloadHash, leaseMs }) => {
      const existing = claims.get(eventKeyHash);
      if (existing) {
        return {
          state: existing.state,
          acquired: false,
          eventKeyHash,
          payloadHash: existing.payloadHash,
          responseHash: existing.responseHash,
        };
      }
      const record = {
        state: "PROCESSING",
        payloadHash,
        claimToken: "claim-token-concurrent",
        attempt: 1,
      };
      claims.set(eventKeyHash, record);
      await Promise.resolve();
      return {
        state: record.state,
        acquired: true,
        eventKeyHash,
        payloadHash,
        claimToken: record.claimToken,
        attempt: record.attempt,
        leaseExpiresAtMs: Date.now() + leaseMs,
      };
    },
    complete: async ({
      eventKeyHash,
      payloadHash,
      claimToken,
      responseHash,
      outbox,
    }) => {
      const record = claims.get(eventKeyHash);
      assert.equal(record.claimToken, claimToken);
      record.state = "COMPLETED";
      record.responseHash = responseHash;
      return {
        state: record.state,
        eventKeyHash,
        payloadHash,
        responseHash,
        outboxCount: outbox.length,
      };
    },
    markRetryable: async ({ eventKeyHash, payloadHash }) => {
      const record = claims.get(eventKeyHash);
      record.state = "RETRYABLE";
      return { state: record.state, eventKeyHash, payloadHash };
    },
  };
  const app = createApp(
    dependencies({
      config: config("signed-webhook-service"),
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry),
      verifyWebhookRequest: async () => ({
        kind: "provider-webhook",
        provider: "stripe",
        eventId: "evt_concurrent_1",
      }),
      webhookLedger,
      handlers: {
        [entry.slug]: async () => {
          handlerCalls += 1;
          markHandlerStarted();
          await handlerRelease;
          return { status: 200, body: { ok: true } };
        },
      },
    }),
  );
  const send = (body) =>
    request(app, `/api/v1/legacy-functions/${entry.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from(body),
    });
  const firstPromise = send('{"value":1}');
  await handlerStarted;
  const inProgress = await send('{"value":1}');
  assert.equal(inProgress.response.status, 409);
  assert.equal(errorCode(inProgress), "WEBHOOK_IN_PROGRESS");
  releaseHandler();
  const first = await firstPromise;
  assert.equal(first.response.status, 200);
  assert.equal(handlerCalls, 1);

  const completedReplay = await send('{"value":1}');
  assert.equal(completedReplay.response.status, 204);
  assert.equal(handlerCalls, 1);

  const altered = await send('{"value":2}');
  assert.equal(altered.response.status, 409);
  assert.equal(errorCode(altered), "WEBHOOK_REPLAY_CONFLICT");
  assert.equal(handlerCalls, 1);
});

test("webhook handler failure is released for retry and completion is idempotent", async () => {
  const entry = portedEntry({
    slug: "fund-stripe-webhook",
    owner_group: "signed-webhook-service",
    auth_mode: "provider_signature_raw_body",
  });
  let record = null;
  let handlerCalls = 0;
  const webhookLedger = {
    verifyReady: async () => true,
    claim: async ({ eventKeyHash, payloadHash, leaseMs }) => {
      if (record?.state === "COMPLETED") {
        return {
          state: record.state,
          acquired: false,
          eventKeyHash,
          payloadHash: record.payloadHash,
          responseHash: record.responseHash,
        };
      }
      const attempt = (record?.attempt ?? 0) + 1;
      record = {
        state: "PROCESSING",
        payloadHash,
        attempt,
        claimToken: `claim-token-retry-${attempt}`,
      };
      return {
        state: record.state,
        acquired: true,
        eventKeyHash,
        payloadHash,
        attempt,
        claimToken: record.claimToken,
        leaseExpiresAtMs: Date.now() + leaseMs,
      };
    },
    complete: async ({
      eventKeyHash,
      payloadHash,
      claimToken,
      responseHash,
      outbox,
    }) => {
      assert.equal(record.claimToken, claimToken);
      record.state = "COMPLETED";
      record.responseHash = responseHash;
      return {
        state: record.state,
        eventKeyHash,
        payloadHash,
        responseHash,
        outboxCount: outbox.length,
      };
    },
    markRetryable: async ({
      eventKeyHash,
      payloadHash,
      claimToken,
      failureCode,
    }) => {
      assert.equal(record.claimToken, claimToken);
      record.state = "RETRYABLE";
      record.failureCode = failureCode;
      return { state: record.state, eventKeyHash, payloadHash };
    },
  };
  const app = createApp(
    dependencies({
      config: config("signed-webhook-service"),
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry),
      verifyWebhookRequest: async () => ({
        kind: "provider-webhook",
        provider: "stripe",
        eventId: "evt_retryable_1",
      }),
      webhookLedger,
      handlers: {
        [entry.slug]: async () => {
          handlerCalls += 1;
          if (handlerCalls === 1) {
            throw new RuntimeError(
              "UPSTREAM_UNAVAILABLE",
              "Service unavailable.",
              503,
            );
          }
          return {
            status: 200,
            body: { ok: true },
            outbox: [
              {
                topic: "webhook.processed",
                idempotencyKey: "evt-retryable-1",
                payload: { ok: true },
              },
            ],
          };
        },
      },
    }),
  );
  const send = () =>
    request(app, `/api/v1/legacy-functions/${entry.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    });

  const failed = await send();
  assert.equal(failed.response.status, 503);
  assert.equal(errorCode(failed), "UPSTREAM_UNAVAILABLE");
  assert.equal(record.state, "RETRYABLE");
  assert.equal(record.failureCode, "UPSTREAM_UNAVAILABLE");

  const retried = await send();
  assert.equal(retried.response.status, 200);
  assert.equal(record.state, "COMPLETED");
  assert.equal(record.attempt, 2);
  assert.equal(handlerCalls, 2);

  const duplicate = await send();
  assert.equal(duplicate.response.status, 204);
  assert.equal(handlerCalls, 2);
});

test("webhook deadline records retryable state without completing", async () => {
  const entry = portedEntry({
    slug: "fund-stripe-webhook",
    owner_group: "signed-webhook-service",
    auth_mode: "provider_signature_raw_body",
  });
  let state = "NEW";
  let completedCalls = 0;
  let resolveRetryable;
  const retryable = new Promise((resolve) => {
    resolveRetryable = resolve;
  });
  const webhookLedger = {
    verifyReady: async () => true,
    claim: async ({ eventKeyHash, payloadHash, leaseMs }) => {
      state = "PROCESSING";
      return {
        state,
        acquired: true,
        eventKeyHash,
        payloadHash,
        attempt: 1,
        claimToken: "claim-token-timeout",
        leaseExpiresAtMs: Date.now() + leaseMs,
      };
    },
    complete: async () => {
      completedCalls += 1;
      throw new Error("must not complete");
    },
    markRetryable: async ({ eventKeyHash, payloadHash, failureCode }) => {
      state = "RETRYABLE";
      resolveRetryable(failureCode);
      return { state, eventKeyHash, payloadHash };
    },
  };
  const app = createApp(
    dependencies({
      config: config("signed-webhook-service", {
        handlerDeadlineMs: 25,
        databaseStatementTimeoutMs: 10,
      }),
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry),
      verifyWebhookRequest: async () => ({
        kind: "provider-webhook",
        provider: "stripe",
        eventId: "evt_timeout_1",
      }),
      webhookLedger,
      handlers: {
        [entry.slug]: async ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => resolve({ status: 200, body: { too_late: true } }),
              { once: true },
            );
          }),
      },
    }),
  );

  const result = await request(
    app,
    `/api/v1/legacy-functions/${entry.slug}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    },
  );
  assert.equal(result.response.status, 504);
  assert.equal(errorCode(result), "HANDLER_DEADLINE_EXCEEDED");
  assert.equal(await retryable, "HANDLER_DEADLINE_EXCEEDED");
  assert.equal(state, "RETRYABLE");
  assert.equal(completedCalls, 0);
});

test("handler deadline aborts work and returns a typed timeout", async () => {
  const entry = portedEntry();
  let observedAbort = false;
  const app = createApp(
    dependencies({
      config: config("identity-api", {
        handlerDeadlineMs: 25,
        databaseStatementTimeoutMs: 10,
      }),
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry),
      handlers: {
        [entry.slug]: async ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve({ status: 200, body: { must_not_send: true } });
              },
              { once: true },
            );
          }),
      },
    }),
  );
  const result = await request(app, `/api/v1/legacy-functions/${entry.slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
  });
  assert.equal(result.response.status, 504);
  assert.equal(errorCode(result), "HANDLER_DEADLINE_EXCEEDED");
  assert.equal(observedAbort, true);
});

test("client close aborts a handler and no response is produced afterward", async () => {
  const entry = portedEntry();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let markAborted;
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  let responseReads = 0;
  const app = createApp(
    dependencies({
      registry: { [entry.slug]: entry },
      contracts: contractsFor(entry),
      handlers: {
        [entry.slug]: async ({ signal }) => {
          markStarted();
          return new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                markAborted();
                const output = { body: null };
                Object.defineProperty(output, "status", {
                  get() {
                    responseReads += 1;
                    return 204;
                  },
                });
                resolve(output);
              },
              { once: true },
            );
          });
        },
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = http.request({
    host: "127.0.0.1",
    port: server.address().port,
    path: `/api/v1/legacy-functions/${entry.slug}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "2",
    },
  });
  client.on("error", () => {});
  client.end("{}");
  await started;
  client.destroy();
  await aborted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responseReads, 0);
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
