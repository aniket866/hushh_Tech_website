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
  createNotifyWriteBatchHandlers,
  NOTIFY_WRITE_SLUGS,
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
  return Object.fromEntries(NOTIFY_WRITE_SLUGS.map((slug) => [slug, {
    approved: true,
    sourceSha256: NOTIFY_WRITE_SOURCE_PINS[slug].source,
    liveBundleSha256: NOTIFY_WRITE_SOURCE_PINS[slug].live,
    ...overrides[slug],
  }]));
}

function context({ slug, actor = FIREBASE, body = {}, method = "POST", search = "", database = null } = {}) {
  return {
    actor,
    database,
    request: { method, headers: {}, route: { slug, suffix: [], search }, requestId: "request-test-1", body },
    signal: SIGNAL,
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
  assert.deepEqual(matrix.functions.map(({ slug }) => slug).sort(), NOTIFY_WRITE_SLUGS);
  for (const row of matrix.functions) {
    assert.equal(row.source_sha256, NOTIFY_WRITE_SOURCE_PINS[row.slug].source);
    assert.equal(row.live_bundle_sha256, NOTIFY_WRITE_SOURCE_PINS[row.slug].live);
    assert.equal(LEGACY_FUNCTION_REGISTRY[row.slug].migration_state, "INVENTORY_FROZEN");
    assert.ok(row.blockers.length > 0);
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
    evidence: evidence({ "ceo-calendar-booking": { liveBundleSha256: "0".repeat(64) } }),
    calendar: { configured: true, availability: async () => { sideEffects += 1; }, book: async () => { sideEffects += 1; } },
  });
  await assert.rejects(handlers["ceo-calendar-booking"](context({ slug: "ceo-calendar-booking", method: "GET" })), (error) => code(error, "CANDIDATE_EVIDENCE_REQUIRED"));
  assert.equal(sideEffects, 0);
  const unavailable = createNotifyWriteBatchHandlers();
  for (const slug of NOTIFY_WRITE_SLUGS) {
    await assert.rejects(unavailable[slug](context({ slug })), (error) => code(error, "CANDIDATE_EVIDENCE_REQUIRED"), slug);
  }
});

test("coin notifications bind Firebase recipients, reject forged authority, and return no PII", async () => {
  const sends = [];
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(), identityDirectory: identityDirectory(),
    mailer: { configured: true, send: async (mail) => { sends.push(mail); return { success: true, messageId: "message-1" }; } },
  });
  const credit = await handlers["coins-credit-notification"](context({
    slug: "coins-credit-notification", body: { recipientEmail: "user@example.com", recipientName: "Ada", coinsAwarded: 25 },
  }));
  assert.deepEqual(credit.body, { success: true, message: "Coins credit email sent", messageId: "message-1" });
  assert.equal(JSON.stringify(credit.body).includes("user@example.com"), false);
  assert.equal(credit.headers["access-control-allow-origin"], undefined);
  await assert.rejects(handlers["coins-deduction-notification"](context({
    slug: "coins-deduction-notification", actor: { ...FIREBASE, fundAdmin: "true" }, body: { recipientEmail: "victim@example.com" },
  })), (error) => code(error, "RECIPIENT_MISMATCH", 403));
  assert.equal(sends.length, 1);
});

test("calendar validates one-hour future slots, checks table first, then records provider result", async () => {
  const order = [];
  const database = db((text) => { order.push(text.startsWith("SELECT") ? "preflight" : "update"); return { rows: [{ ok: 1 }] }; });
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(), identityDirectory: identityDirectory(), now: () => NOW,
    calendar: {
      configured: true,
      availability: async ({ days }) => [{ date: "2026-08-24", slots: [], days }],
      book: async ({ attendeeEmail }) => { order.push(`book:${attendeeEmail}`); return { eventId: "event-1", meetLink: "https://meet.google.com/abc" }; },
    },
  });
  const available = await handlers["ceo-calendar-booking"](context({ slug: "ceo-calendar-booking", method: "GET", search: "?days=3", body: null }));
  assert.equal(available.body.availability[0].days, 3);
  const booked = await handlers["ceo-calendar-booking"](context({ slug: "ceo-calendar-booking", database, body: { startTime: "2026-08-24T18:00:00.000Z", endTime: "2026-08-24T19:00:00.000Z", attendeeName: "Ada" } }));
  assert.deepEqual(order, ["preflight", "book:user@example.com", "update"]);
  assert.equal(booked.body.eventId, "event-1");
  await assert.rejects(handlers["ceo-calendar-booking"](context({ slug: "ceo-calendar-booking", database, body: { startTime: "2026-08-24T18:00:00.000Z", endTime: "2026-08-24T20:00:00.000Z" } })), (error) => code(error, "INVALID_REQUEST", 400));
});

test("verification fail-closes on table readiness and prevents metadata or return-url takeover", async () => {
  const providerCalls = [];
  const database = db((text) => /RETURNING id/.test(text) ? { rows: [{ id: "verification-1" }] } : { rows: [] });
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(), identityDirectory: identityDirectory(), siteUrl: "https://uat.hushhtech.com", now: () => NOW,
    verificationProvider: { configured: true, create: async (input) => { providerCalls.push(input); return { id: "vs_1", url: "https://verify.example/session", status: "requires_input", clientSecret: "secret_ephemeral" }; } },
  });
  await assert.rejects(handlers["create-verification-session"](context({ slug: "create-verification-session", database, body: { metadata: { user_id: "attacker" } } })), (error) => code(error, "INVALID_REQUEST", 400));
  const result = await handlers["create-verification-session"](context({ slug: "create-verification-session", database, body: { email: "user@example.com", returnUrl: "https://evil.example/phish", metadata: { campaign: "uat" } } }));
  assert.equal(providerCalls[0].returnUrl, "https://uat.hushhtech.com/onboarding/verify-complete");
  assert.equal(providerCalls[0].metadata.user_id, "user-1");
  assert.equal(result.body.verification_id, "verification-1");
});

test("NDA sends only configured admin and signer copies, logs delivery, and rejects client IP forgery", async () => {
  const sends = [];
  const database = db((text) => /current_setting/.test(text) ? { rows: [{ user_id: "user-1" }] } : { rows: [] });
  const handlers = createNotifyWriteBatchHandlers({
    evidence: evidence(), identityDirectory: identityDirectory(), now: () => NOW,
    mailer: { configured: true, adminRecipients: ["manish@hushh.ai", "ankit@hushh.ai"], send: async (mail) => { sends.push(mail); return { success: true, messageId: `mail-${sends.length}` }; } },
  });
  await assert.rejects(handlers["nda-signed-notification"](context({ slug: "nda-signed-notification", actor: GOOGLE, database, body: { signerName: "Ada", signerIp: "1.2.3.4" } })), (error) => code(error, "INVALID_REQUEST", 400));
  const result = await handlers["nda-signed-notification"](context({ slug: "nda-signed-notification", actor: GOOGLE, database, body: { signerName: "Ada", ndaVersion: "v1", documentsAcknowledged: ["NDA"] } }));
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].recipients, ["manish@hushh.ai", "ankit@hushh.ai"]);
  assert.deepEqual(sends[1].recipients, ["user@example.com"]);
  assert.equal(JSON.stringify(result.body).includes("user@example.com"), false);
  assert.equal(database.calls.filter(({ text }) => /fund_payment_notifications/.test(text)).length, 2);
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
