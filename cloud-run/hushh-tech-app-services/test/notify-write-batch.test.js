import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createApp } from "../src/app.js";
import {
  assertFunctionRequestContract,
  NOTIFY_WRITE_FUNCTION_CONTRACTS,
} from "../src/contracts.js";
import { RuntimeError } from "../src/errors.js";
import {
  calculateNotifyWriteApprovalBinding,
  calculateNotifyWriteEndMetadataBinding,
  createNotifyWriteBatchHandlers,
  NOTIFY_WRITE_AUTHORITATIVE_BLOCKERS,
  NOTIFY_WRITE_DURABLE_LEASES,
  NOTIFY_WRITE_SLUGS,
  NOTIFY_WRITE_SOURCE_EVIDENCE,
  NOTIFY_WRITE_SOURCE_PINS,
} from "../src/handlers/notify-write-batch.js";
import { LEGACY_FUNCTION_REGISTRY } from "../src/registry.js";
import { errorCode, request } from "./helpers.js";

const SIGNAL = new AbortController().signal;
const NOW = new Date("2026-08-22T12:00:00.000Z");
const FIREBASE = Object.freeze({ kind: "firebase", uid: "user-1", fundAdmin: false });
const GOOGLE = Object.freeze({ kind: "google-service", email: "worker@hushh-tech-uat.iam.gserviceaccount.com", subject: "worker-1" });
const INTERNAL = Object.freeze({ kind: "google-service", email: "gateway@hushh-tech-uat.iam.gserviceaccount.com", subject: "gateway-1" });

function evidence(overrides = {}) {
  return Object.fromEntries(NOTIFY_WRITE_SLUGS.map((slug) => {
    const pin = NOTIFY_WRITE_SOURCE_PINS[slug];
    const override = overrides[slug] ?? {};
    const row = {
      approved: true,
      schemaVersion: 1,
      checkedInSourceSha256: pin.source,
      liveV2BundleSha256: pin.live,
      functionId: pin.functionId,
      manifestVersion: pin.manifestVersion,
      sourceVersion: pin.sourceVersion,
      verifyJwt: pin.verifyJwt,
      metadataEndCheckPassed: true,
      metadataEndCheckDigestSha256: null,
      deploymentBindingSha256: pin.deploymentBindingSha256,
      ...NOTIFY_WRITE_SOURCE_EVIDENCE,
      authoritativeBlockers: NOTIFY_WRITE_AUTHORITATIVE_BLOCKERS[slug],
      ...override,
    };
    row.metadataEndCheckDigestSha256 = override.metadataEndCheckDigestSha256 ?? calculateNotifyWriteEndMetadataBinding(slug, row);
    row.bindingSha256 = override.bindingSha256 ?? calculateNotifyWriteApprovalBinding(slug, row);
    return [slug, row];
  }));
}

function context({ slug, actor = FIREBASE, body = {}, method = "POST", search = "", database = null, idempotencyKey = "idempotency-test-0001", requestId = "request-test-1", signal = SIGNAL } = {}) {
  return {
    actor,
    database,
    request: { method, headers: idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey }, route: { slug, suffix: [], search }, requestId, body },
    signal,
  };
}

function identityDirectory() {
  return { configured: true, getUser: async (uid) => ({ uid, email: "user@example.com", name: "Ada User" }) };
}

function db(responder) {
  const calls = [];
  return {
    calls,
    transaction: async (work) => work({
      async query(text, values = []) {
        calls.push({ text, values });
        return responder?.(text, values) ?? { rows: [] };
      },
    }),
  };
}

function durableLedger({
  beforeClaim = null,
  afterClaimPersist = null,
  beforeReserve = null,
  afterReservePersist = null,
  beforeFinish = null,
} = {}) {
  const operations = new Map();
  const deliveries = new Map();
  const calls = [];
  let currentTimeMs = 10_000_000;
  let fenceSequence = 0;
  const nextFence = (kind) => `${kind}-fence-${String(++fenceSequence).padStart(8, "0")}`;
  const unavailable = () => {
    throw new RuntimeError("DURABLE_OPERATION_LEDGER_UNAVAILABLE", "Service unavailable.", 503);
  };
  const operationOwner = (input) => {
    const row = operations.get(input.operationKey);
    if (
      !row ||
      row.payloadHash !== input.payloadHash ||
      row.attempt !== input.attempt ||
      row.fencingToken !== input.fencingToken
    ) {
      unavailable();
    }
    return row;
  };
  const deliveryOwner = (input) => {
    const row = deliveries.get(input.deliveryKey);
    if (
      !row ||
      row.attempt !== input.attempt ||
      row.fencingToken !== input.fencingToken
    ) {
      unavailable();
    }
    return row;
  };
  return {
    configured: true,
    durability: "cloud_sql_leased_fenced_operation_key_v2",
    operations,
    deliveries,
    calls,
    advance(ms) {
      assert.ok(Number.isSafeInteger(ms) && ms >= 0);
      currentTimeMs += ms;
    },
    async claim(input) {
      calls.push({ name: "claim", input });
      await beforeClaim?.(input);
      const existing = operations.get(input.operationKey);
      if (existing && existing.payloadHash !== input.payloadHash) {
        return { disposition: "PAYLOAD_CONFLICT", acquired: false, operationKey: input.operationKey, payloadHash: input.payloadHash };
      }
      if (existing?.state === "COMPLETED") {
        return { disposition: "COMPLETED", acquired: false, operationKey: input.operationKey, payloadHash: input.payloadHash, response: existing.response };
      }
      if (existing?.state === "PROCESSING" && existing.leaseExpiresAtMs > currentTimeMs) {
        return { disposition: "PROCESSING", acquired: false, operationKey: input.operationKey, payloadHash: input.payloadHash };
      }
      const attempt = (existing?.attempt ?? 0) + 1;
      const fencingToken = nextFence("operation");
      const leaseExpiresAtMs = currentTimeMs + input.leaseDurationMs;
      const row = { state: "PROCESSING", payloadHash: input.payloadHash, attempt, fencingToken, leaseExpiresAtMs };
      operations.set(input.operationKey, row);
      await afterClaimPersist?.(input, row);
      return { disposition: "ACQUIRED", acquired: true, operationKey: input.operationKey, payloadHash: input.payloadHash, attempt, fencingToken, leaseDurationMs: input.leaseDurationMs, leaseExpiresAtMs };
    },
    async complete(input) {
      calls.push({ name: "complete", input });
      const existing = operationOwner(input);
      if (existing.state !== "PROCESSING") unavailable();
      operations.set(input.operationKey, { ...existing, state: "COMPLETED", response: input.response });
      return { state: "COMPLETED", operationKey: input.operationKey, payloadHash: input.payloadHash, attempt: input.attempt, fencingToken: input.fencingToken };
    },
    async markRetryable(input) {
      calls.push({ name: "markRetryable", input });
      const existing = operationOwner(input);
      if (existing.state === "COMPLETED") {
        return { state: "COMPLETED", operationKey: input.operationKey, payloadHash: input.payloadHash, attempt: input.attempt, fencingToken: input.fencingToken };
      }
      if (existing.state !== "PROCESSING") unavailable();
      operations.set(input.operationKey, { ...existing, state: "RETRYABLE" });
      return { state: "RETRYABLE", operationKey: input.operationKey, payloadHash: input.payloadHash, attempt: input.attempt, fencingToken: input.fencingToken };
    },
    async reserveDelivery(input) {
      calls.push({ name: "reserveDelivery", input });
      await beforeReserve?.(input);
      const operation = operationOwner({
        operationKey: input.operationKey,
        payloadHash: operations.get(input.operationKey)?.payloadHash,
        attempt: input.operationAttempt,
        fencingToken: input.operationFencingToken,
      });
      if (operation.state !== "PROCESSING") unavailable();
      const existing = deliveries.get(input.deliveryKey);
      if (existing?.state === "SENT") {
        return { state: "SENT", acquired: false, persisted: true, deliveryKey: input.deliveryKey, attempt: existing.attempt, fencingToken: existing.fencingToken, providerMessageId: existing.providerMessageId };
      }
      if (existing?.state === "UNKNOWN") {
        return { state: "UNKNOWN", acquired: false, persisted: true, deliveryKey: input.deliveryKey, attempt: existing.attempt, fencingToken: existing.fencingToken };
      }
      if (existing?.state === "PENDING" && existing.leaseExpiresAtMs > currentTimeMs) {
        return { state: "PENDING", acquired: false, persisted: true, deliveryKey: input.deliveryKey, attempt: existing.attempt, fencingToken: existing.fencingToken };
      }
      const attempt = (existing?.attempt ?? 0) + 1;
      const fencingToken = nextFence("delivery");
      const leaseExpiresAtMs = currentTimeMs + input.leaseDurationMs;
      const row = { state: "PENDING", attempt, fencingToken, leaseExpiresAtMs };
      deliveries.set(input.deliveryKey, row);
      await afterReservePersist?.(input, row);
      return { state: "PENDING", acquired: true, persisted: true, deliveryKey: input.deliveryKey, attempt, fencingToken, leaseDurationMs: input.leaseDurationMs, leaseExpiresAtMs };
    },
    async markDeliveryInvoked(input) {
      calls.push({ name: "markDeliveryInvoked", input });
      const operation = operationOwner({
        operationKey: input.operationKey,
        payloadHash: operations.get(input.operationKey)?.payloadHash,
        attempt: input.operationAttempt,
        fencingToken: input.operationFencingToken,
      });
      if (operation.state !== "PROCESSING") unavailable();
      const existing = deliveryOwner(input);
      if (existing.state !== "PENDING") unavailable();
      deliveries.set(input.deliveryKey, { ...existing, state: "UNKNOWN", providerInvocationStarted: true });
      return { state: "UNKNOWN", deliveryKey: input.deliveryKey, attempt: input.attempt, fencingToken: input.fencingToken };
    },
    async finishDelivery(input) {
      calls.push({ name: "finishDelivery", input });
      await beforeFinish?.(input);
      const operation = operationOwner({
        operationKey: input.operationKey,
        payloadHash: operations.get(input.operationKey)?.payloadHash,
        attempt: input.operationAttempt,
        fencingToken: input.operationFencingToken,
      });
      if (operation.state !== "PROCESSING") unavailable();
      const previous = deliveryOwner(input);
      if (previous.state !== "UNKNOWN") unavailable();
      deliveries.set(input.deliveryKey, { ...previous, state: input.status, providerMessageId: input.providerMessageId ?? null, failureCode: input.failureCode ?? null });
      return { state: input.status, deliveryKey: input.deliveryKey, attempt: input.attempt, fencingToken: input.fencingToken };
    },
  };
}

function code(error, expected, status = 503) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, expected);
  assert.equal(error.statusCode, status);
  return true;
}

test("candidate manifest pins all eight checked-in and live sources while registry stays frozen", async () => {
  const matrix = JSON.parse(await readFile(new URL("../registry/candidates.notify-write-batch.v1.json", import.meta.url), "utf8"));
  assert.equal(matrix.deployment_state, "DEFAULT_OFF");
  assert.equal(matrix.required_registry_state, "INVENTORY_FROZEN");
  assert.equal(matrix.source_approval.status, "BLOCKED");
  assert.equal(matrix.source_approval.metadata_end_check_passed, false);
  assert.equal(matrix.durable_operation_ledger.status, "NOT_LIVE_PROVEN");
  assert.equal(matrix.durable_operation_ledger.required_durability, "cloud_sql_leased_fenced_operation_key_v2");
  assert.equal(matrix.durable_operation_ledger.operation_lease_duration_ms, NOTIFY_WRITE_DURABLE_LEASES.operationLeaseDurationMs);
  assert.equal(matrix.durable_operation_ledger.delivery_lease_duration_ms, NOTIFY_WRITE_DURABLE_LEASES.deliveryLeaseDurationMs);
  assert.deepEqual(matrix.functions.map(({ slug }) => slug).sort(), NOTIFY_WRITE_SLUGS);
  for (const row of matrix.functions) {
    assert.equal(row.source_sha256, NOTIFY_WRITE_SOURCE_PINS[row.slug].source);
    assert.equal(row.live_bundle_sha256, NOTIFY_WRITE_SOURCE_PINS[row.slug].live);
    assert.equal(row.source_version, NOTIFY_WRITE_SOURCE_PINS[row.slug].sourceVersion);
    assert.equal(row.deployment_binding_sha256, NOTIFY_WRITE_SOURCE_PINS[row.slug].deploymentBindingSha256);
    assert.equal(LEGACY_FUNCTION_REGISTRY[row.slug].migration_state, "INVENTORY_FROZEN");
    assert.deepEqual(row.blockers, NOTIFY_WRITE_AUTHORITATIVE_BLOCKERS[row.slug]);
    assert.equal(row.blockers.length, 6);
    assert.ok(row.candidate_activation_blockers.includes("DURABLE_OPERATION_LEDGER_CLOUD_SQL_LIVE_PROOF_MISSING"));
  }
});

test("contracts preserve methods, query/body limits, same-origin responses, and reject mutations", () => {
  assert.deepEqual(Object.keys(NOTIFY_WRITE_FUNCTION_CONTRACTS).sort(), NOTIFY_WRITE_SLUGS);
  assertFunctionRequestContract(NOTIFY_WRITE_FUNCTION_CONTRACTS["ceo-calendar-booking"], {
    method: "GET", route: { suffix: [], search: "?days=14" }, headers: {}, rawBody: Buffer.alloc(0),
  });
  assert.throws(() => assertFunctionRequestContract(NOTIFY_WRITE_FUNCTION_CONTRACTS["ceo-calendar-booking"], {
    method: "GET", route: { suffix: [], search: "?token=forged" }, headers: {}, rawBody: Buffer.alloc(0),
  }), (error) => code(error, "INVALID_REQUEST", 400));
  assert.throws(() => assertFunctionRequestContract(NOTIFY_WRITE_FUNCTION_CONTRACTS["coins-credit-notification"], {
    method: "OPTIONS", route: { suffix: [], search: "" }, headers: {}, rawBody: Buffer.alloc(0),
  }), (error) => code(error, "METHOD_NOT_ALLOWED", 405));
  assert.throws(() => assertFunctionRequestContract(NOTIFY_WRITE_FUNCTION_CONTRACTS["nda-signed-notification"], {
    method: "POST", route: { suffix: [], search: "" }, headers: { "content-type": "application/json" }, rawBody: Buffer.alloc(1_048_577),
  }), (error) => code(error, "PAYLOAD_TOO_LARGE", 413));
});

test("every handler rejects missing or forged approval before any provider or database call", async () => {
  let sideEffects = 0;
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence({ "ceo-calendar-booking": { liveV2BundleSha256: "0".repeat(64) } }),
    calendar: { configured: true, availability: async () => { sideEffects += 1; }, book: async () => { sideEffects += 1; } },
  });
  await assert.rejects(handlers["ceo-calendar-booking"](context({ slug: "ceo-calendar-booking", method: "GET" })), (error) => code(error, "CANDIDATE_EVIDENCE_REQUIRED"));
  assert.equal(sideEffects, 0);
  const unavailable = createNotifyWriteBatchHandlers();
  for (const slug of NOTIFY_WRITE_SLUGS) {
    await assert.rejects(unavailable[slug](context({ slug })), (error) => code(error, "CANDIDATE_EVIDENCE_REQUIRED"), slug);
  }
});

test("source approval rejects sentinel versions, missing end checks, digest drift, extra fields, and forged bindings", async () => {
  const mutations = [
    { sourceVersion: -1 },
    { metadataEndCheckPassed: false },
    { metadataEndCheckDigestSha256: "0".repeat(64) },
    { deploymentBindingSha256: "0".repeat(64) },
    { sourceEvidenceFileSha256: "0".repeat(64) },
    { sourceEvidenceDigest: "0".repeat(64) },
    { canonicalSourceTreeDigest: "0".repeat(64) },
    { currentMetadataDigest: "0".repeat(64) },
    { trafficEvidenceFileSha256: "0".repeat(64) },
    { trafficEvidenceDigest: "0".repeat(64) },
    { deploymentInventoryDigest: "0".repeat(64) },
    { terminalMatrixFileSha256: "0".repeat(64) },
    { terminalMatrixEvidenceDigest: "0".repeat(64) },
    { authoritativeBlockers: [] },
    { bindingSha256: "0".repeat(64) },
    { unexpected: true },
  ];
  for (const mutation of mutations) {
    let providerCalls = 0;
    const handlers = createNotifyWriteBatchHandlers({
      evidence: evidence({ "ceo-calendar-booking": mutation }),
      calendar: { configured: true, availability: async () => { providerCalls += 1; return []; }, book: async () => { providerCalls += 1; } },
    });
    await assert.rejects(
      handlers["ceo-calendar-booking"](context({ slug: "ceo-calendar-booking", method: "GET" })),
      (error) => code(error, "CANDIDATE_EVIDENCE_REQUIRED"),
    );
    assert.equal(providerCalls, 0);
  }
});

test("coin notifications bind Firebase recipients, reject forged authority, and return no PII", async () => {
  const sends = [];
  const ledger = durableLedger();
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(), operationLedger: ledger, identityDirectory: identityDirectory(),
    mailer: { configured: true, send: async (mail) => { sends.push(mail); return { success: true, messageId: "message-1" }; } },
  });
  const credit = await handlers["coins-credit-notification"](context({
    slug: "coins-credit-notification", body: { recipientEmail: "user@example.com", recipientName: "Ada", coinsAwarded: 25 },
  }));
  assert.deepEqual(credit.body, { success: true, message: "Coins credit email sent", messageId: "message-1" });
  assert.equal(JSON.stringify(credit.body).includes("user@example.com"), false);
  assert.equal(credit.headers["access-control-allow-origin"], undefined);
  assert.match(sends[0].idempotencyKey, /^coins-credit-notification:[a-f0-9]{64}:coins_credit$/);
  assert.equal("requestId" in sends[0], false);
  assert.deepEqual(ledger.calls.slice(0, 5).map(({ name }) => name), ["claim", "reserveDelivery", "markDeliveryInvoked", "finishDelivery", "complete"]);
  await assert.rejects(handlers["coins-deduction-notification"](context({
    slug: "coins-deduction-notification", actor: { ...FIREBASE, fundAdmin: "true" }, body: { recipientEmail: "victim@example.com" },
  })), (error) => code(error, "RECIPIENT_MISMATCH", 403));
  assert.equal(sends.length, 1);
});

test("calendar validates one-hour future slots, checks table first, then records provider result", async () => {
  const order = [];
  let bookingInput = null;
  const database = db((text) => { order.push(text.startsWith("SELECT") ? "preflight" : "update"); return { rows: [{ ok: 1 }] }; });
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(), operationLedger: durableLedger(), identityDirectory: identityDirectory(), now: () => NOW,
    calendar: {
      configured: true,
      availability: async ({ days }) => [{ date: "2026-08-24", slots: [], days }],
      book: async (input) => { bookingInput = input; order.push(`book:${input.attendeeEmail}`); return { eventId: "event-1", meetLink: "https://meet.google.com/abc" }; },
    },
  });
  const available = await handlers["ceo-calendar-booking"](context({ slug: "ceo-calendar-booking", method: "GET", search: "?days=3", body: null }));
  assert.equal(available.body.availability[0].days, 3);
  const booked = await handlers["ceo-calendar-booking"](context({ slug: "ceo-calendar-booking", database, body: { startTime: "2026-08-24T18:00:00.000Z", endTime: "2026-08-24T19:00:00.000Z", attendeeName: "Ada" } }));
  assert.deepEqual(order, ["preflight", "book:user@example.com", "update"]);
  assert.equal(booked.body.eventId, "event-1");
  assert.match(bookingInput.idempotencyKey, /^ceo-calendar-booking:[a-f0-9]{64}$/);
  assert.equal("requestId" in bookingInput, false);
  await assert.rejects(handlers["ceo-calendar-booking"](context({ slug: "ceo-calendar-booking", database, body: { startTime: "2026-08-24T18:00:00.000Z", endTime: "2026-08-24T20:00:00.000Z" } })), (error) => code(error, "INVALID_REQUEST", 400));
});

test("verification fail-closes on table readiness and prevents metadata or return-url takeover", async () => {
  const providerCalls = [];
  const database = db((text) => /RETURNING id/.test(text) ? { rows: [{ id: "verification-1" }] } : { rows: [] });
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(), operationLedger: durableLedger(), identityDirectory: identityDirectory(), siteUrl: "https://uat.hushhtech.com", now: () => NOW,
    verificationProvider: { configured: true, create: async (input) => { providerCalls.push(input); return { id: "vs_1", url: "https://verify.example/session", status: "requires_input", clientSecret: "secret_ephemeral" }; } },
  });
  await assert.rejects(handlers["create-verification-session"](context({ slug: "create-verification-session", database, body: { metadata: { user_id: "attacker" } } })), (error) => code(error, "INVALID_REQUEST", 400));
  const result = await handlers["create-verification-session"](context({ slug: "create-verification-session", database, body: { email: "user@example.com", returnUrl: "https://evil.example/phish", metadata: { campaign: "uat" } } }));
  assert.equal(providerCalls[0].returnUrl, "https://uat.hushhtech.com/onboarding/verify-complete");
  assert.equal(providerCalls[0].metadata.user_id, "user-1");
  assert.match(providerCalls[0].idempotencyKey, /^create-verification-session:[a-f0-9]{64}$/);
  assert.equal("requestId" in providerCalls[0], false);
  assert.equal(result.body.verification_id, "verification-1");
});

test("NDA sends only configured admin and signer copies, logs delivery, and rejects client IP forgery", async () => {
  const sends = [];
  const ledger = durableLedger();
  const database = db((text) => /current_setting/.test(text) ? { rows: [{ user_id: "user-1" }] } : { rows: [] });
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(), operationLedger: ledger, identityDirectory: identityDirectory(), now: () => NOW,
    mailer: { configured: true, adminRecipients: ["manish@hushh.ai", "ankit@hushh.ai"], send: async (mail) => { sends.push(mail); return { success: true, messageId: `mail-${sends.length}` }; } },
  });
  await assert.rejects(handlers["nda-signed-notification"](context({ slug: "nda-signed-notification", actor: GOOGLE, database, body: { signerName: "Ada", signerIp: "1.2.3.4" } })), (error) => code(error, "INVALID_REQUEST", 400));
  const result = await handlers["nda-signed-notification"](context({ slug: "nda-signed-notification", actor: GOOGLE, database, body: { signerName: "Ada", ndaVersion: "v1", documentsAcknowledged: ["NDA"] } }));
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].recipients, ["manish@hushh.ai", "ankit@hushh.ai"]);
  assert.deepEqual(sends[1].recipients, ["user@example.com"]);
  assert.equal(JSON.stringify(result.body).includes("user@example.com"), false);
  assert.deepEqual([...ledger.deliveries.values()].map(({ state }) => state), ["SENT", "SENT"]);
  const reserveIndexes = ledger.calls.map(({ name }) => name).reduce((out, name, index) => name === "reserveDelivery" ? [...out, index] : out, []);
  assert.equal(reserveIndexes.length, 2);
  assert.ok(reserveIndexes[0] < ledger.calls.findIndex(({ name }) => name === "finishDelivery"));
});

test("canonical Idempotency-Key replays the prior result and never derives provider keys from requestId", async () => {
  let sends = 0;
  const ledger = durableLedger();
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: identityDirectory(),
    mailer: {
      configured: true,
      send: async ({ idempotencyKey }) => {
        sends += 1;
        assert.match(idempotencyKey, /^coins-credit-notification:[a-f0-9]{64}:coins_credit$/);
        assert.equal(idempotencyKey.includes("fresh-request"), false);
        return { success: true, messageId: "message-replay" };
      },
    },
  });
  const input = {
    slug: "coins-credit-notification",
    body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
    idempotencyKey: "stable-client-key-0001",
  };
  const first = await handlers["coins-credit-notification"](context({ ...input, requestId: "fresh-request-0001" }));
  const replay = await handlers["coins-credit-notification"](context({ ...input, requestId: "fresh-request-0002" }));
  assert.deepEqual(replay, first);
  assert.equal(sends, 1);
  assert.equal(ledger.calls.filter(({ name }) => name === "claim").length, 2);
  assert.equal(ledger.calls.filter(({ name }) => name === "complete").length, 1);
});

test("mutating providers reject missing, short, padded, or malformed Idempotency-Key before a persisted claim", async () => {
  let sends = 0;
  const ledger = durableLedger();
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: identityDirectory(),
    mailer: { configured: true, send: async () => { sends += 1; return { success: true }; } },
  });
  for (const idempotencyKey of [null, "short", " padded-client-key-0001", "bad key with spaces"]) {
    await assert.rejects(
      handlers["coins-credit-notification"](context({
        slug: "coins-credit-notification",
        body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
        idempotencyKey,
      })),
      (error) => code(error, "IDEMPOTENCY_KEY_REQUIRED", 400),
    );
  }
  assert.equal(sends, 0);
  assert.equal(ledger.calls.length, 0);

  const ndaDatabase = db((text) => /current_setting/.test(text) ? { rows: [{ user_id: "user-1" }] } : { rows: [] });
  const ndaHandlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: identityDirectory(),
    mailer: {
      configured: true,
      adminRecipients: ["admin@hushh.ai"],
      send: async () => { sends += 1; return { success: true }; },
    },
  });
  await assert.rejects(
    ndaHandlers["nda-signed-notification"](context({
      slug: "nda-signed-notification",
      actor: GOOGLE,
      database: ndaDatabase,
      idempotencyKey: null,
      body: { signerName: "Ada" },
    })),
    (error) => code(error, "IDEMPOTENCY_KEY_REQUIRED", 400),
  );
  assert.equal(ndaDatabase.calls.length, 0);
  assert.equal(sends, 0);
  assert.equal(ledger.calls.length, 0);
});

test("raw identity provider errors are bounded before any mail send", async () => {
  let sends = 0;
  const ledger = durableLedger();
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: {
      configured: true,
      getUser: async () => {
        throw new RuntimeError("PRIVATE_PROVIDER_CODE", "private identity user@example.com", 503);
      },
    },
    mailer: { configured: true, send: async () => { sends += 1; return { success: true }; } },
  });
  await assert.rejects(
    handlers["coins-credit-notification"](context({
      slug: "coins-credit-notification",
      body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
    })),
    (error) => {
      assert.equal(code(error, "IDENTITY_DIRECTORY_FAILED"), true);
      assert.equal(error.message.includes("private identity"), false);
      return true;
    },
  );
  assert.equal(sends, 0);
  assert.equal([...ledger.operations.values()][0].state, "RETRYABLE");
});

test("NDA preserves a second-send failure, then retries only the failed unique delivery", async () => {
  const sends = [];
  const ledger = durableLedger();
  const database = db((text) => /current_setting/.test(text) ? { rows: [{ user_id: "user-1" }] } : { rows: [] });
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: identityDirectory(),
    now: () => NOW,
    mailer: {
      configured: true,
      adminRecipients: ["admin@hushh.ai"],
      send: async (mail) => {
        sends.push(mail.template);
        if (sends.length === 2) {
          return { success: false, error: "raw provider failure for user@example.com" };
        }
        return { success: true, messageId: `message-${sends.length}` };
      },
    },
  });
  const input = context({
    slug: "nda-signed-notification",
    actor: GOOGLE,
    database,
    idempotencyKey: "nda-partial-retry-0001",
    body: { signerName: "Ada", ndaVersion: "v1", documentsAcknowledged: ["NDA"] },
  });
  await assert.rejects(
    handlers["nda-signed-notification"](input),
    (error) => code(error, "NDA_DELIVERY_PARTIAL"),
  );
  assert.deepEqual(sends, ["nda_admin", "nda_signer"]);
  assert.deepEqual([...ledger.deliveries.values()].map(({ state }) => state), ["SENT", "FAILED"]);
  assert.equal(JSON.stringify(ledger.calls).includes("raw provider failure"), false);
  assert.equal(JSON.stringify(ledger.calls).includes("user@example.com"), true);
  const retry = await handlers["nda-signed-notification"](input);
  assert.deepEqual(sends, ["nda_admin", "nda_signer", "nda_signer"]);
  assert.equal(retry.body.email_delivery.admin.replayed, true);
  assert.equal(retry.body.email_delivery.signer.replayed, false);
  assert.deepEqual([...ledger.deliveries.values()].map(({ state }) => state), ["SENT", "SENT"]);
});

test("ambiguous mail timeout is redacted, stored as UNKNOWN, and never auto-resends", async () => {
  let sends = 0;
  const ledger = durableLedger();
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: identityDirectory(),
    mailer: {
      configured: true,
      send: async () => {
        sends += 1;
        const error = new Error("timeout delivering private recipient user@example.com");
        error.code = "ETIMEDOUT";
        throw error;
      },
    },
  });
  const input = context({
    slug: "coins-credit-notification",
    idempotencyKey: "ambiguous-timeout-0001",
    body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
  });
  await assert.rejects(
    handlers["coins-credit-notification"](input),
    (error) => code(error, "MAIL_SEND_TIMEOUT"),
  );
  assert.equal([...ledger.deliveries.values()][0].state, "UNKNOWN");
  assert.equal([...ledger.deliveries.values()][0].failureCode, "MAIL_SEND_TIMEOUT");
  assert.equal(JSON.stringify(ledger.calls).includes("private recipient"), false);
  await assert.rejects(
    handlers["coins-credit-notification"](input),
    (error) => code(error, "DELIVERY_OUTCOME_UNKNOWN"),
  );
  assert.equal(sends, 1);
});

test("pre-provider Cloud SQL reservation failure sends nothing and exposes no raw database error", async () => {
  let sends = 0;
  const ledger = durableLedger({
    beforeReserve: async () => {
      throw new Error("private Cloud SQL host and user@example.com");
    },
  });
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: identityDirectory(),
    mailer: { configured: true, send: async () => { sends += 1; return { success: true }; } },
  });
  await assert.rejects(
    handlers["coins-credit-notification"](context({
      slug: "coins-credit-notification",
      body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
    })),
    (error) => {
      assert.equal(code(error, "DURABLE_OPERATION_LEDGER_UNAVAILABLE"), true);
      assert.equal(error.message.includes("private Cloud SQL"), false);
      return true;
    },
  );
  assert.equal(sends, 0);
  assert.equal(ledger.calls.some(({ name }) => name === "markRetryable"), true);
});

test("a committed claim releases on abort and recovers after a lost claim response without provider execution", async () => {
  let abortSends = 0;
  let abortOnce = true;
  const controller = new AbortController();
  const abortLedger = durableLedger({
    afterClaimPersist: async () => {
      if (abortOnce) {
        abortOnce = false;
        controller.abort(new Error("private abort reason"));
      }
    },
  });
  const abortHandlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: abortLedger,
    identityDirectory: identityDirectory(),
    mailer: { configured: true, send: async () => { abortSends += 1; return { success: true }; } },
  });
  const abortInput = {
    slug: "coins-credit-notification",
    idempotencyKey: "claim-abort-recovery-0001",
    body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
  };
  await assert.rejects(
    abortHandlers["coins-credit-notification"](context({ ...abortInput, signal: controller.signal })),
    (error) => {
      assert.equal(code(error, "HANDLER_ABORTED"), true);
      assert.equal(error.message.includes("private abort reason"), false);
      return true;
    },
  );
  assert.equal(abortSends, 0);
  assert.equal([...abortLedger.operations.values()][0].state, "RETRYABLE");
  await abortHandlers["coins-credit-notification"](context(abortInput));
  assert.equal(abortSends, 1);

  let lostSends = 0;
  let loseResponse = true;
  const lostLedger = durableLedger({
    afterClaimPersist: async () => {
      if (loseResponse) {
        loseResponse = false;
        throw new Error("private committed claim response loss");
      }
    },
  });
  const lostHandlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: lostLedger,
    identityDirectory: identityDirectory(),
    mailer: { configured: true, send: async () => { lostSends += 1; return { success: true }; } },
  });
  const lostInput = {
    slug: "coins-credit-notification",
    idempotencyKey: "claim-response-lost-0001",
    body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
  };
  await assert.rejects(
    lostHandlers["coins-credit-notification"](context(lostInput)),
    (error) => code(error, "DURABLE_OPERATION_LEDGER_UNAVAILABLE"),
  );
  assert.equal(lostSends, 0);
  await assert.rejects(
    lostHandlers["coins-credit-notification"](context(lostInput)),
    (error) => code(error, "OPERATION_IN_PROGRESS", 409),
  );
  lostLedger.advance(NOTIFY_WRITE_DURABLE_LEASES.operationLeaseDurationMs + 1);
  await lostHandlers["coins-credit-notification"](context(lostInput));
  assert.equal(lostSends, 1);
  assert.equal([...lostLedger.operations.values()][0].attempt, 2);
});

test("a persisted pre-provider delivery reservation is reclaimed after lease expiry and sends exactly once", async () => {
  let sends = 0;
  let loseReservationResponse = true;
  const ledger = durableLedger({
    afterReservePersist: async () => {
      if (loseReservationResponse) {
        loseReservationResponse = false;
        throw new Error("private delivery reservation response loss");
      }
    },
  });
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: identityDirectory(),
    mailer: { configured: true, send: async () => { sends += 1; return { success: true, messageId: "lease-recovered" }; } },
  });
  const input = {
    slug: "coins-credit-notification",
    idempotencyKey: "delivery-lease-recovery-0001",
    body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
  };
  await assert.rejects(
    handlers["coins-credit-notification"](context(input)),
    (error) => code(error, "DURABLE_OPERATION_LEDGER_UNAVAILABLE"),
  );
  assert.equal(sends, 0);
  assert.equal([...ledger.deliveries.values()][0].state, "PENDING");
  ledger.advance(NOTIFY_WRITE_DURABLE_LEASES.deliveryLeaseDurationMs + 1);
  await handlers["coins-credit-notification"](context(input));
  assert.equal(sends, 1);
  assert.deepEqual(
    [...ledger.deliveries.values()].map(({ state, attempt }) => ({ state, attempt })),
    [{ state: "SENT", attempt: 2 }],
  );
});

test("concurrent identical requests execute the provider exactly once", async () => {
  let sends = 0;
  let releaseProvider;
  let announceProvider;
  const providerStarted = new Promise((resolve) => { announceProvider = resolve; });
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const ledger = durableLedger();
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: identityDirectory(),
    mailer: {
      configured: true,
      send: async () => {
        sends += 1;
        announceProvider();
        await providerGate;
        return { success: true, messageId: "concurrent-once" };
      },
    },
  });
  const input = context({
    slug: "coins-credit-notification",
    idempotencyKey: "concurrent-identical-0001",
    body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
  });
  const first = handlers["coins-credit-notification"](input);
  await providerStarted;
  await assert.rejects(
    handlers["coins-credit-notification"](input),
    (error) => code(error, "OPERATION_IN_PROGRESS", 409),
  );
  assert.equal(sends, 1);
  releaseProvider();
  await first;
  assert.equal(sends, 1);
});

test("an altered payload conflicts after a retryable failure for the same Idempotency-Key", async () => {
  let sends = 0;
  const ledger = durableLedger();
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(),
    operationLedger: ledger,
    identityDirectory: identityDirectory(),
    mailer: { configured: true, send: async () => { sends += 1; return { success: false }; } },
  });
  const base = {
    slug: "coins-credit-notification",
    idempotencyKey: "payload-conflict-retryable-0001",
    body: { recipientEmail: "user@example.com", coinsAwarded: 25 },
  };
  await assert.rejects(
    handlers["coins-credit-notification"](context(base)),
    (error) => code(error, "MAIL_SEND_REJECTED"),
  );
  assert.equal([...ledger.operations.values()][0].state, "RETRYABLE");
  await assert.rejects(
    handlers["coins-credit-notification"](context({ ...base, body: { ...base.body, coinsAwarded: 26 } })),
    (error) => code(error, "IDEMPOTENCY_KEY_CONFLICT", 409),
  );
  assert.equal(sends, 1);
  assert.equal([...ledger.operations.values()][0].state, "RETRYABLE");
});

test("stale operation and delivery fencing tokens cannot complete or overwrite newer attempts", async () => {
  const ledger = durableLedger();
  const operationInput = {
    schemaVersion: 1,
    slug: "coins-credit-notification",
    operationKey: `coins-credit-notification:${"a".repeat(64)}`,
    scopeHash: "b".repeat(64),
    idempotencyKeyHash: "c".repeat(64),
    payloadHash: "d".repeat(64),
    leaseDurationMs: NOTIFY_WRITE_DURABLE_LEASES.operationLeaseDurationMs,
    signal: SIGNAL,
  };
  const operationAttemptOne = await ledger.claim(operationInput);
  ledger.advance(NOTIFY_WRITE_DURABLE_LEASES.operationLeaseDurationMs + 1);
  const operationAttemptTwo = await ledger.claim(operationInput);
  assert.equal(operationAttemptTwo.attempt, 2);
  assert.notEqual(operationAttemptTwo.fencingToken, operationAttemptOne.fencingToken);

  const deliveryInput = {
    schemaVersion: 1,
    operationKey: operationInput.operationKey,
    operationAttempt: operationAttemptTwo.attempt,
    operationFencingToken: operationAttemptTwo.fencingToken,
    deliveryKey: `${operationInput.operationKey}:coins_credit`,
    channel: "email",
    template: "coins_credit",
    recipients: ["user@example.com"],
    leaseDurationMs: NOTIFY_WRITE_DURABLE_LEASES.deliveryLeaseDurationMs,
    signal: SIGNAL,
  };
  const deliveryAttemptOne = await ledger.reserveDelivery(deliveryInput);
  ledger.advance(NOTIFY_WRITE_DURABLE_LEASES.deliveryLeaseDurationMs + 1);
  const deliveryAttemptTwo = await ledger.reserveDelivery(deliveryInput);
  await ledger.markDeliveryInvoked({
    ...deliveryInput,
    attempt: deliveryAttemptTwo.attempt,
    fencingToken: deliveryAttemptTwo.fencingToken,
  });
  await assert.rejects(
    ledger.finishDelivery({
      ...deliveryInput,
      attempt: deliveryAttemptOne.attempt,
      fencingToken: deliveryAttemptOne.fencingToken,
      status: "SENT",
    }),
    (error) => code(error, "DURABLE_OPERATION_LEDGER_UNAVAILABLE"),
  );
  assert.equal(ledger.deliveries.get(deliveryInput.deliveryKey).state, "UNKNOWN");
  assert.equal(ledger.deliveries.get(deliveryInput.deliveryKey).attempt, 2);

  await assert.rejects(
    ledger.complete({
      operationKey: operationInput.operationKey,
      payloadHash: operationInput.payloadHash,
      attempt: operationAttemptOne.attempt,
      fencingToken: operationAttemptOne.fencingToken,
      response: { status: 200, headers: {}, body: {} },
    }),
    (error) => code(error, "DURABLE_OPERATION_LEDGER_UNAVAILABLE"),
  );
  assert.equal(ledger.operations.get(operationInput.operationKey).state, "PROCESSING");
  assert.equal(ledger.operations.get(operationInput.operationKey).attempt, 2);
});

test("funding handlers preserve status parity without leaking holder names or balances", async () => {
  const nameDb = db((text) => {
    if (/current_setting/.test(text)) return { rows: [{ user_id: "user-1" }] };
    if (/account_structure/.test(text)) return { rows: [{ account_structure: "trust", entity_legal_name: "Ada Family Trust" }] };
    if (/identity_data/.test(text)) return { rows: [{ identity_data: { accounts: [{ owners: [{ names: ["Ada Family"] }] }] } }] };
    return { rows: [] };
  });
  const handlers = createNotifyWriteBatchHandlers({ evidence: evidence(), now: () => NOW });
  const match = await handlers["onboarding-funding-name-match"](context({ slug: "onboarding-funding-name-match", actor: GOOGLE, database: nameDb }));
  assert.deepEqual(match.body, { success: true, applicable: true, status: "match", holder_name_available: true });
  assert.equal(JSON.stringify(match.body).includes("Ada Family"), false);

  const fundsDb = db((text) => {
    if (/current_setting/.test(text)) return { rows: [{ user_id: "user-1" }] };
    if (/initial_investment_amount/.test(text)) return { rows: [{ initial_investment_amount: 100 }] };
    if (/plaid_item_id FROM/.test(text)) return { rows: [{ plaid_item_id: "item-1" }] };
    if (/current_balance/.test(text)) return { rows: [{ available_balance: 150 }] };
    return { rows: [] };
  });
  const proof = await handlers["onboarding-proof-of-funds"](context({ slug: "onboarding-proof-of-funds", actor: GOOGLE, database: fundsDb }));
  assert.deepEqual(proof.body, { success: true, status: "funds_sufficient", balance_available: true, investment_selected: true });
  assert.equal(JSON.stringify(proof.body).includes("150"), false);
});

test("gateway returns frozen 503 before auth, contract, or candidate handler for all eight", async () => {
  const owners = { "ceo-calendar-booking": "investor-api", "create-verification-session": "identity-api", "onboarding-funding-name-match": "financial-api", "onboarding-proof-of-funds": "financial-api" };
  for (const slug of NOTIFY_WRITE_SLUGS) {
    let handlerCalls = 0;
    let authCalls = 0;
    const app = createApp({
      config: { serviceOwner: owners[slug] ?? "engagement-api-worker", requestBodyLimitBytes: 1_048_576, requestRateLimit: 20, databaseStatementTimeoutMs: 5_000, handlerDeadlineMs: 10_000 },
      database: { pool: {} }, registry: LEGACY_FUNCTION_REGISTRY,
      handlers: { [slug]: async () => { handlerCalls += 1; return { status: 200, headers: {}, body: {} }; } },
      verifyGoogleServiceRequest: async () => INTERNAL,
      verifyFirebaseProductRequest: async () => { authCalls += 1; return FIREBASE; },
      verifyWebhookRequest: async () => { throw new Error("unexpected webhook"); },
      verifyReadiness: async () => true, verifyPublicHandlerReadiness: async () => false,
      sharedRateLimiter: { consume: async () => ({ allowed: true }), verifyReady: async () => true },
      webhookLedger: { verifyReady: async () => true },
    });
    const result = await request(app, `/api/v1/legacy-functions/${slug}`, { method: "POST" });
    assert.equal(result.response.status, 503, slug);
    assert.equal(errorCode(result), "FUNCTION_NOT_MIGRATED", slug);
    assert.equal(handlerCalls, 0, slug);
    assert.equal(authCalls, 0, slug);
  }
});
