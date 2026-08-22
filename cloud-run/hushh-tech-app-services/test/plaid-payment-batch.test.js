import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import test from "node:test";

import { RuntimeError } from "../src/errors.js";
import {
  calculatePlaidPaymentApprovalBinding,
  calculatePlaidPaymentEndMetadataBinding,
  createPlaidPaymentCandidateHandlers,
  PLAID_PAYMENT_AUTHORITATIVE_BLOCKERS,
  PLAID_PAYMENT_LEDGER_CONTRACT,
  PLAID_PAYMENT_SLUGS,
  PLAID_PAYMENT_SOURCE_EVIDENCE,
  PLAID_PAYMENT_SOURCE_PINS,
  verifyPlaidWebhookSignature,
} from "../src/handlers/plaid-payment-batch.js";

const UID = "firebase-user-0001";
const KEY = "client-operation-0001";
const FENCE = "fence-token-00000001";
const GOOGLE_CALLER_EMAIL =
  "financial-api-worker-uat@hushh-tech-uat.iam.gserviceaccount.com";
const GOOGLE_ACTOR = Object.freeze({
  kind: "google-service",
  email: GOOGLE_CALLER_EMAIL,
  subject: "financial-api-worker-subject",
});
const TRANSACTION_DURABILITY_FOR_TEST =
  "cloud_sql_serializable_transaction_v1";
const PLAID_NOW_SECONDS = 1_800_000_000;
const PLAID_KEY_ID = "bfbd5111-8e33-4643-8ced-b2e642a72f3c";
const PLAID_SIGNING_KEYS = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PLAID_PUBLIC_JWK = PLAID_SIGNING_KEYS.publicKey.export({ format: "jwk" });
const PLAID_VERIFICATION_KEY = Object.freeze({
  alg: "ES256",
  crv: "P-256",
  created_at: PLAID_NOW_SECONDS - 3_600,
  expired_at: null,
  kid: PLAID_KEY_ID,
  kty: "EC",
  use: "sig",
  x: PLAID_PUBLIC_JWK.x,
  y: PLAID_PUBLIC_JWK.y,
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function plaidEventKeyHash(rawBody) {
  return sha256(
    Buffer.from(
      JSON.stringify([1, "plaid-data-webhook", sha256(rawBody)]),
      "utf8",
    ),
  );
}

function plaidJwt(rawBody, { header = {}, claims = {} } = {}) {
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: PLAID_KEY_ID, typ: "JWT", ...header }),
    "utf8",
  ).toString("base64url");
  const encodedClaims = Buffer.from(
    JSON.stringify({
      iat: PLAID_NOW_SECONDS,
      request_body_sha256: sha256(rawBody),
      ...claims,
    }),
    "utf8",
  ).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = signBytes("sha256", Buffer.from(signingInput, "ascii"), {
    key: PLAID_SIGNING_KEYS.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function corruptJwtSignature(token) {
  const parts = token.split(".");
  const signature = Buffer.from(parts[2], "base64url");
  signature[0] ^= 1;
  parts[2] = signature.toString("base64url");
  return parts.join(".");
}

function runtimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
  return true;
}

function approval(slug, overrides = {}) {
  const pin = PLAID_PAYMENT_SOURCE_PINS[slug];
  const row = {
    approved: true,
    schemaVersion: 1,
    checkedInSourceSha256: pin.source,
    liveV2BundleSha256: pin.live,
    functionId: pin.functionId,
    manifestVersion: pin.manifestVersion,
    sourceVersion: pin.sourceVersion,
    verifyJwt: pin.verifyJwt,
    requestCount30d: pin.requestCount30d,
    metadataEndCheckPassed: true,
    metadataEndCheckDigestSha256: "",
    deploymentBindingSha256: pin.deploymentBindingSha256,
    ...PLAID_PAYMENT_SOURCE_EVIDENCE,
    authoritativeBlockers: PLAID_PAYMENT_AUTHORITATIVE_BLOCKERS[slug].map(
      (blocker) => ({ ...blocker }),
    ),
    bindingSha256: "",
    ...overrides,
  };
  row.metadataEndCheckDigestSha256 = calculatePlaidPaymentEndMetadataBinding(
    slug,
    row,
  );
  row.bindingSha256 = calculatePlaidPaymentApprovalBinding(slug, row);
  return row;
}

function allApprovals() {
  return Object.fromEntries(PLAID_PAYMENT_SLUGS.map((slug) => [slug, approval(slug)]));
}

function defaultResults() {
  return {
    processPlaidWebhook: { accepted: true, queued_products: 1 },
    appendPlaidDiagnostic: { accepted: true },
    getFundPaymentStatus: {
      success: true,
      latest_request: null,
      payments: [],
      reviews: [],
    },
    createLinkToken: {
      link_token: "link-sandbox-short-lived",
      expiration: "2026-08-23T00:00:00.000Z",
    },
    exchangePublicToken: {
      item_id: "item-display-id",
      institution: { id: "ins_1", name: "Test Bank" },
      accounts: [{ account_id: "acct_1", name: "Checking", mask: "1234" }],
    },
    startPlaidDataSync: {
      status: "partial",
      products_available: 3,
      can_proceed: true,
      available_products: { accounts: true, balance: true, auth: true },
    },
    redeemFundCoupon: {
      success: true,
      already_redeemed: false,
      payment_request_id: "request-1",
      status: "paid",
      coins_awarded: 300000,
    },
    createFundPaymentRequest: {
      success: true,
      reused: false,
      payment_request_id: "request-1",
      request_reference: "HF-1",
      payment_url: "https://uat.hushhtech.com/fund/pay?t=sealed",
      status: "payment_link_sent",
    },
  };
}

function harness({
  replay = false,
  resultOverrides = {},
  ledgerOverrides = {},
  approvedSourceEvidence = allApprovals(),
} = {}) {
  const calls = [];
  const inputs = [];
  const results = { ...defaultResults(), ...resultOverrides };
  const operations = {
    configured: true,
    ...Object.fromEntries(
      Object.keys(results).map((method) => [
        method,
        async (input) => {
          calls.push({ method, input });
          return results[method];
        },
      ]),
    ),
  };
  const replayResults = new Map();
  const ledger = {
    configured: true,
    durability: "cloud_sql_serializable_fenced_operation_v1",
    resultProtection: "cloud_kms_envelope_v1",
    async run(input, execute) {
      inputs.push(input);
      const prior = replayResults.get(input.operationKeyHash);
      if (replay && prior) {
        if (prior.payloadHash !== input.payloadHash) {
          throw new RuntimeError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key conflicts with a prior request.",
            409,
          );
        }
        return {
          state: "COMPLETED",
          operationKeyHash: input.operationKeyHash,
          payloadHash: input.payloadHash,
          resultProtection: "cloud_kms_envelope_v1",
          replayed: true,
          result: prior.result,
        };
      }
      const result = await execute({
        fenceToken: FENCE,
        transaction: {
          configured: true,
          durability: "cloud_sql_serializable_transaction_v1",
        },
      });
      replayResults.set(input.operationKeyHash, {
        payloadHash: input.payloadHash,
        result,
      });
      return {
        state: "COMPLETED",
        operationKeyHash: input.operationKeyHash,
        payloadHash: input.payloadHash,
        resultProtection: "cloud_kms_envelope_v1",
        replayed: false,
        result,
      };
    },
    ...ledgerOverrides,
  };
  return {
    calls,
    inputs,
    handlers: createPlaidPaymentCandidateHandlers({
      operationLedger: ledger,
      operations,
      allowedRedirectOrigins: ["https://uat.hushhtech.com"],
      allowedGoogleServiceCallers: [GOOGLE_CALLER_EMAIL],
      approvedSourceEvidence,
    }),
  };
}

function context(slug, body, overrides = {}) {
  return {
    actor: {
      kind: "firebase",
      uid: UID,
      email: "investor@example.test",
      recentAuth: true,
    },
    request: {
      headers: { "idempotency-key": KEY },
      body,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("candidate remains fail-closed without exact end-metadata approval", async () => {
  const missing = harness({ approvedSourceEvidence: {} });
  await assert.rejects(
    missing.handlers["create-link-token"](
      context("create-link-token", { userId: UID }),
    ),
    (error) => runtimeCode(error, "CANDIDATE_EVIDENCE_REQUIRED", 503),
  );
  const forged = allApprovals();
  forged["create-link-token"] = {
    ...forged["create-link-token"],
    requestCount30d: 35,
  };
  const forgedHarness = harness({ approvedSourceEvidence: forged });
  await assert.rejects(
    forgedHarness.handlers["create-link-token"](
      context("create-link-token", { userId: UID }),
    ),
    (error) => runtimeCode(error, "CANDIDATE_EVIDENCE_REQUIRED", 503),
  );
  assert.equal(missing.calls.length, 0);
  assert.equal(forgedHarness.calls.length, 0);
});

test("all eight candidates exist but browser writes require recent Firebase auth and idempotency", async () => {
  const { handlers, calls } = harness();
  assert.deepEqual(Object.keys(handlers).sort(), PLAID_PAYMENT_SLUGS);
  await assert.rejects(
    handlers["fund-coupon-redeem"]({
      ...context("fund-coupon-redeem", { userId: "other", couponCode: "code" }),
    }),
    (error) => runtimeCode(error, "ACCESS_DENIED", 403),
  );
  await assert.rejects(
    handlers["fund-payment-request-create"]({
      ...context("fund-payment-request-create", {
        userId: UID,
        firstPaymentAmount: 1,
      }),
      request: {
        headers: {},
        body: { userId: UID, firstPaymentAmount: 1 },
      },
    }),
    (error) => runtimeCode(error, "IDEMPOTENCY_KEY_REQUIRED", 400),
  );
  await assert.rejects(
    handlers["plaid-data-sync-start"]({
      ...context("plaid-data-sync-start", { userId: UID }),
      actor: { kind: "firebase", uid: UID, recentAuth: false },
    }),
    (error) => runtimeCode(error, "ACCESS_DENIED", 403),
  );
  assert.equal(calls.length, 0);
});

test("seven user candidates accept only an allowlisted Google service identity for an explicit user", async () => {
  const { handlers, calls } = harness();
  const invokeAsService = (slug, body) =>
    handlers[slug]({
      ...context(slug, body),
      actor: GOOGLE_ACTOR,
    });

  await invokeAsService("plaid-diagnostics-log", {
    user_id: UID,
    event_type: "LINK_EXIT",
  });
  await invokeAsService("fund-payment-status", { userId: UID });
  await invokeAsService("create-link-token", { userId: UID });
  await invokeAsService("exchange-public-token", {
    userId: UID,
    publicToken: "public-sandbox-sensitive-credential",
  });
  await invokeAsService("plaid-data-sync-start", { userId: UID });
  await invokeAsService("fund-coupon-redeem", {
    userId: UID,
    couponCode: "test-code",
  });
  await invokeAsService("fund-payment-request-create", {
    userId: UID,
    firstPaymentAmount: 1,
  });

  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.equal(call.input.actorUid, UID);
    assert.equal(call.input.callerKind, "google-service");
    assert.match(call.input.callerPrincipalHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(call.input).includes(GOOGLE_CALLER_EMAIL), false);
  }

  const before = calls.length;
  await assert.rejects(
    handlers["fund-payment-status"]({
      ...context("fund-payment-status", { userId: UID }),
      actor: {
        ...GOOGLE_ACTOR,
        email: "attacker@other-project.iam.gserviceaccount.com",
      },
    }),
    (error) => runtimeCode(error, "ACCESS_DENIED", 403),
  );
  assert.equal(calls.length, before);
});

test("Plaid webhook accepts only a verified provider actor and exact claimed raw bytes", async () => {
  const { handlers, calls, inputs } = harness();
  const rawBody = Buffer.from(
    JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-sensitive-reference",
      webhook_id: "provider-field-not-needed-for-sync",
      consent_expiration_time: "2026-08-24T00:00:00.000Z",
      user_email: "must-not-enter-the-operation",
    }),
    "utf8",
  );
  const claim = {
    eventKeyHash: plaidEventKeyHash(rawBody),
    payloadHash: sha256(rawBody),
    claimToken: "outer-fence-token-0001",
  };
  const providerActor = {
    kind: "provider-webhook",
    provider: "plaid",
    eventId: sha256(rawBody),
    eventKeyHash: claim.eventKeyHash,
  };
  const base = {
    ...context("plaid-data-webhook", undefined),
    request: { headers: {}, rawBody },
    webhookClaim: claim,
  };

  await assert.rejects(
    handlers["plaid-data-webhook"]({
      ...base,
      actor: { kind: "firebase", uid: UID, recentAuth: true },
    }),
    (error) => runtimeCode(error, "WEBHOOK_SIGNATURE_INVALID", 401),
  );
  await assert.rejects(
    handlers["plaid-data-webhook"]({
      ...base,
      actor: { ...providerActor, eventKeyHash: sha256("forged-event-key") },
    }),
    (error) => runtimeCode(error, "WEBHOOK_REPLAY_CONFLICT", 409),
  );
  await assert.rejects(
    handlers["plaid-data-webhook"]({
      ...base,
      actor: providerActor,
      request: {
        headers: {},
        rawBody: Buffer.from(
          JSON.stringify({
            webhook_type: "TRANSACTIONS",
            webhook_code: "SYNC_UPDATES_AVAILABLE",
            item_id: "tampered",
          }),
        ),
      },
    }),
    (error) => runtimeCode(error, "WEBHOOK_REPLAY_CONFLICT", 409),
  );
  const customSecretRaw = Buffer.from(
    JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-sensitive-reference",
      webhook_secret: "body-secret-is-never-auth",
    }),
  );
  const customEventKeyHash = plaidEventKeyHash(customSecretRaw);
  await assert.rejects(
    handlers["plaid-data-webhook"]({
      ...base,
      actor: {
        kind: "provider-webhook",
        provider: "plaid",
        eventId: sha256(customSecretRaw),
        eventKeyHash: customEventKeyHash,
      },
      request: {
        headers: {},
        rawBody: customSecretRaw,
      },
      webhookClaim: {
        ...claim,
        payloadHash: sha256(customSecretRaw),
        eventKeyHash: customEventKeyHash,
      },
    }),
    (error) => runtimeCode(error, "INVALID_REQUEST", 400),
  );
  await assert.rejects(
    handlers["plaid-data-webhook"]({
      ...base,
      actor: providerActor,
      request: {
        ...base.request,
        route: { search: "?webhook_secret=body-auth-is-forbidden" },
      },
    }),
    (error) => runtimeCode(error, "INVALID_REQUEST", 400),
  );

  const response = await handlers["plaid-data-webhook"]({
    ...base,
    actor: providerActor,
  });
  assert.deepEqual(response.body, { accepted: true, queued_products: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "processPlaidWebhook");
  assert.deepEqual(calls[0].input.event, {
    webhook_type: "TRANSACTIONS",
    webhook_code: "SYNC_UPDATES_AVAILABLE",
    item_id: "item-sensitive-reference",
  });
  assert.equal(JSON.stringify(calls[0].input.event).includes("user_email"), false);
  assert.equal(calls[0].input.payloadHash, sha256(rawBody));
  assert.equal(calls[0].input.fenceToken, FENCE);
  assert.equal(calls[0].input.outerFenceToken, claim.claimToken);
  assert.equal("rawBody" in calls[0].input, false);
  assert.deepEqual(Object.keys(inputs[0]).sort(), [
    "actorUidHash",
    "operationKeyHash",
    "payloadHash",
    "schemaVersion",
    "scope",
    "signal",
  ]);
  assert.equal(JSON.stringify(inputs[0]).includes("item-sensitive-reference"), false);
});

test("Plaid detached verifier rejects body tampering, forgery, stale JWTs, and algorithm confusion", async () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-sensitive-reference",
    }),
    "utf8",
  );
  const token = plaidJwt(rawBody);
  const resolverCalls = [];
  const verified = await verifyPlaidWebhookSignature({
    rawBody,
    signedJwt: token,
    resolveVerificationKey: async (input) => {
      resolverCalls.push(input);
      return PLAID_VERIFICATION_KEY;
    },
    nowMs: PLAID_NOW_SECONDS * 1_000,
    signal: new AbortController().signal,
  });
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].keyId, PLAID_KEY_ID);
  assert.deepEqual(verified.actor, {
    kind: "provider-webhook",
    provider: "plaid",
    eventId: sha256(rawBody),
    eventKeyHash: plaidEventKeyHash(rawBody),
  });
  assert.equal(verified.signatureProof.algorithm, "ES256");
  assert.equal(verified.signatureProof.payloadHash, sha256(rawBody));
  assert.match(verified.signatureProof.eventKeyHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(verified).includes(token), false);
  assert.equal(JSON.stringify(verified).includes(rawBody.toString("utf8")), false);

  const tamperedBody = Buffer.from(rawBody);
  tamperedBody[tamperedBody.length - 2] ^= 1;
  const invalidCases = [
    {
      name: "body tampering",
      rawBody: tamperedBody,
      signedJwt: token,
      key: PLAID_VERIFICATION_KEY,
    },
    {
      name: "signature forgery",
      rawBody,
      signedJwt: corruptJwtSignature(token),
      key: PLAID_VERIFICATION_KEY,
    },
    {
      name: "stale issued-at",
      rawBody,
      signedJwt: plaidJwt(rawBody, {
        claims: { iat: PLAID_NOW_SECONDS - 301 },
      }),
      key: PLAID_VERIFICATION_KEY,
    },
    {
      name: "future issued-at",
      rawBody,
      signedJwt: plaidJwt(rawBody, {
        claims: { iat: PLAID_NOW_SECONDS + 31 },
      }),
      key: PLAID_VERIFICATION_KEY,
    },
    {
      name: "algorithm confusion",
      rawBody,
      signedJwt: plaidJwt(rawBody, { header: { alg: "HS256" } }),
      key: PLAID_VERIFICATION_KEY,
    },
    {
      name: "private key material from resolver",
      rawBody,
      signedJwt: token,
      key: { ...PLAID_VERIFICATION_KEY, d: "must-not-cross-boundary" },
    },
  ];
  for (const invalid of invalidCases) {
    await assert.rejects(
      verifyPlaidWebhookSignature({
        rawBody: invalid.rawBody,
        signedJwt: invalid.signedJwt,
        resolveVerificationKey: async () => invalid.key,
        nowMs: PLAID_NOW_SECONDS * 1_000,
      }),
      (error) => {
        assert.equal(error.message, "Webhook rejected.", invalid.name);
        return runtimeCode(error, "WEBHOOK_SIGNATURE_INVALID", 401);
      },
    );
  }
});

test("fenced ledger hashes credentials, uses one serializable transaction, and replays once", async () => {
  const { handlers, calls, inputs } = harness({ replay: true });
  const request = context("exchange-public-token", {
    publicToken: "public-sandbox-sensitive-credential",
    userId: UID,
    institutionName: "Test Bank",
    institutionId: "ins_1",
    accounts: [{ id: "acct-sensitive-id", name: "Checking", mask: "1234" }],
  });
  const first = await handlers["exchange-public-token"](request);
  const second = await handlers["exchange-public-token"](request);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "exchangePublicToken");
  assert.equal(calls[0].input.publicToken, "public-sandbox-sensitive-credential");
  assert.equal(calls[0].input.fenceToken, FENCE);
  assert.deepEqual(calls[0].input.transaction, {
    configured: true,
    durability: "cloud_sql_serializable_transaction_v1",
  });
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    const serialized = JSON.stringify(input);
    assert.equal(serialized.includes("public-sandbox-sensitive-credential"), false);
    assert.equal(serialized.includes("acct-sensitive-id"), false);
    assert.equal(serialized.includes(UID), false);
    assert.match(input.actorUidHash, /^[a-f0-9]{64}$/);
    assert.match(input.payloadHash, /^[a-f0-9]{64}$/);
    assert.match(input.operationKeyHash, /^[a-f0-9]{64}$/);
  }
  assert.equal(PLAID_PAYMENT_LEDGER_CONTRACT.rawPayloadPersistence, "forbidden");
  assert.equal(PLAID_PAYMENT_LEDGER_CONTRACT.rawCredentialPersistence, "forbidden");
});

test("same idempotency key with a changed payload conflicts before a second provider call", async () => {
  const { handlers, calls, inputs } = harness({ replay: true });
  const first = context("exchange-public-token", {
    publicToken: "public-sandbox-sensitive-credential-one",
    userId: UID,
  });
  await handlers["exchange-public-token"](first);
  await assert.rejects(
    handlers["exchange-public-token"]({
      ...first,
      request: {
        ...first.request,
        body: {
          ...first.request.body,
          publicToken: "public-sandbox-sensitive-credential-two",
        },
      },
    }),
    (error) => runtimeCode(error, "IDEMPOTENCY_CONFLICT", 409),
  );
  assert.equal(calls.length, 1);
  assert.equal(inputs.length, 2);
  assert.notEqual(inputs[0].payloadHash, inputs[1].payloadHash);
});

test("missing transaction durability or fencing rejects before mutation", async () => {
  const { handlers, calls } = harness({
    ledgerOverrides: {
      async run(_input, execute) {
        return execute({
          fenceToken: "short",
          transaction: { configured: true, durability: "read_committed" },
        });
      },
    },
  });
  await assert.rejects(
    handlers["fund-coupon-redeem"](
      context("fund-coupon-redeem", {
        userId: UID,
        couponCode: "test-code",
      }),
    ),
    (error) => runtimeCode(error, "OPERATION_LEDGER_UNAVAILABLE", 503),
  );
  assert.equal(calls.length, 0);
});

test("diagnostics are caller-owned, bounded, and redact financial and identity data", async () => {
  const { handlers, calls } = harness();
  const response = await handlers["plaid-diagnostics-log"](
    context("plaid-diagnostics-log", {
      user_id: UID,
      session_id: "2b64ece6-f25a-4fb8-9662-b6adf7280694",
      event_type: "LINK_EXIT",
      plaid_step: "oauth",
      page_state: {
        url: "https://uat.hushhtech.com/onboarding?token=leak#private",
        email: "investor@example.test",
      },
      plaid_metadata: {
        account_number: "000123456789",
        mask: "1234",
      },
      error_details: {
        message: "failed for second-investor@example.test",
        access_token: "secret",
      },
      browser_context: {
        user_agent: "bounded-browser",
        note: "Bearer eyJhbGciOiJIUzI1NiJ9.sensitive-payload.signature",
      },
    }),
  );
  assert.deepEqual(response.body, { accepted: true });
  const diagnostic = calls[0].input.diagnostic;
  assert.equal(diagnostic.pageState.email, "[redacted]");
  assert.equal(diagnostic.pageState.url, "https://uat.hushhtech.com/onboarding");
  assert.equal(diagnostic.plaidMetadata.account_number, "[redacted]");
  assert.equal(diagnostic.errorDetails.access_token, "[redacted]");
  assert.equal(diagnostic.errorDetails.message, "[redacted]");
  assert.equal(diagnostic.browserContext.note, "[redacted]");
  assert.equal(diagnostic.plaidMetadata.mask, "1234");

  await assert.rejects(
    handlers["plaid-diagnostics-log"]({
      ...context("plaid-diagnostics-log", {
        user_id: "other-user",
        event_type: "LINK_EXIT",
      }),
    }),
    (error) => runtimeCode(error, "ACCESS_DENIED", 403),
  );
});

test("OAuth redirects, verified email, amount bounds, and response secret leakage fail closed", async () => {
  const { handlers, calls } = harness();
  await assert.rejects(
    handlers["create-link-token"](
      context("create-link-token", {
        userId: UID,
        userEmail: "attacker@example.test",
      }),
    ),
    (error) => runtimeCode(error, "ACCESS_DENIED", 403),
  );
  await assert.rejects(
    handlers["create-link-token"](
      context("create-link-token", {
        userId: UID,
        redirectUri: "https://evil.example/callback",
      }),
    ),
    (error) => runtimeCode(error, "INVALID_REDIRECT", 400),
  );
  await assert.rejects(
    handlers["fund-payment-request-create"](
      context("fund-payment-request-create", {
        userId: UID,
        firstPaymentAmount: 0.5,
      }),
    ),
    (error) => runtimeCode(error, "INVALID_REQUEST", 400),
  );
  for (const firstPaymentAmount of [true, "1e2", 1.001]) {
    await assert.rejects(
      handlers["fund-payment-request-create"](
        context("fund-payment-request-create", {
          userId: UID,
          firstPaymentAmount,
        }),
      ),
      (error) => runtimeCode(error, "INVALID_REQUEST", 400),
    );
  }
  await assert.rejects(
    handlers["fund-payment-status"](
      context("fund-payment-status", {
        userId: UID,
        user_id: "conflicting-user",
      }),
    ),
    (error) => runtimeCode(error, "INVALID_REQUEST", 400),
  );
  await assert.rejects(
    handlers["exchange-public-token"](
      context("exchange-public-token", {
        userId: UID,
        publicToken: "public-sandbox-sensitive-credential-one",
        public_token: "public-sandbox-sensitive-credential-two",
      }),
    ),
    (error) => runtimeCode(error, "INVALID_REQUEST", 400),
  );
  assert.equal(calls.length, 0);

  const leaking = harness({
    resultOverrides: {
      exchangePublicToken: {
        item_id: "item-1",
        access_token: "must-never-leave-server",
      },
    },
  });
  await assert.rejects(
    leaking.handlers["exchange-public-token"](
      context("exchange-public-token", {
        publicToken: "public-sandbox-sensitive-credential",
        userId: UID,
      }),
    ),
    (error) => runtimeCode(error, "HANDLER_CONTRACT_INVALID", 503),
  );

  const leakingEmailDelivery = harness({
    resultOverrides: {
      createFundPaymentRequest: {
        ...defaultResults().createFundPaymentRequest,
        email_delivery: {
          user: { recipient_email: "investor@example.test" },
        },
      },
    },
  });
  await assert.rejects(
    leakingEmailDelivery.handlers["fund-payment-request-create"](
      context("fund-payment-request-create", {
        userId: UID,
        firstPaymentAmount: 1,
      }),
    ),
    (error) => runtimeCode(error, "HANDLER_CONTRACT_INVALID", 503),
  );
});

test("status is a caller-owned read and every remaining write receives the fence", async () => {
  const { handlers, calls } = harness();
  const status = await handlers["fund-payment-status"](
    context("fund-payment-status", { userId: UID }),
  );
  assert.equal(status.body.success, true);
  assert.equal(Object.isFrozen(status.body), true);
  assert.equal(Object.isFrozen(status.body.payments), true);

  await handlers["create-link-token"](
    context("create-link-token", {
      userId: UID,
      userEmail: "investor@example.test",
      redirectUri: "https://uat.hushhtech.com/auth/callback",
    }),
  );
  await handlers["plaid-data-sync-start"](
    context("plaid-data-sync-start", { userId: UID, itemId: "item-1" }),
  );
  await handlers["fund-coupon-redeem"](
    context("fund-coupon-redeem", { userId: UID, couponCode: "test-code" }),
  );
  await handlers["fund-payment-request-create"](
    context("fund-payment-request-create", {
      userId: UID,
      firstPaymentAmount: 1,
    }),
  );

  assert.deepEqual(
    calls.map(({ method }) => method),
    [
      "getFundPaymentStatus",
      "createLinkToken",
      "startPlaidDataSync",
      "redeemFundCoupon",
      "createFundPaymentRequest",
    ],
  );
  for (const call of calls.slice(1)) {
    assert.equal(call.input.fenceToken, FENCE);
    assert.equal(call.input.transaction.durability, TRANSACTION_DURABILITY_FOR_TEST);
  }
});
