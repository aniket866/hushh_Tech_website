import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as signDetached,
} from "node:crypto";
import test from "node:test";

import { RuntimeError } from "../src/errors.js";
import {
  __testing,
  GITHUB_DEVOPS_NOTIFY_APPROVAL_TRUST_ANCHOR,
  createGithubDevopsNotifyCandidate,
  parseUniqueJson,
  verifyRawDetachedApproval,
  verifyGitHubWebhookSignature,
} from "../src/handlers/github-devops-notify.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const SECRET = "github-webhook-secret-material-000000000000000000000000";
const DELIVERY = "123e4567-e89b-42d3-a456-426614174000";
const SIGNAL = new AbortController().signal;
const { publicKey: APPROVAL_PUBLIC_KEY, privateKey: APPROVAL_PRIVATE_KEY } =
  generateKeyPairSync("ed25519");
const APPROVAL_PUBLIC_KEY_BYTES = APPROVAL_PUBLIC_KEY.export({
  format: "der",
  type: "spki",
});
const TEST_APPROVAL_TRUST_ANCHOR = Object.freeze({
  schemaVersion: 1,
  provisioningState: "PROVISIONED",
  algorithm: "Ed25519",
  keyId: "github-devops-notify-independent-reviewer-v1",
  publicKeySpkiDerBase64url: APPROVAL_PUBLIC_KEY_BYTES.toString("base64url"),
  publicKeySha256: createHash("sha256")
    .update(APPROVAL_PUBLIC_KEY_BYTES)
    .digest("hex"),
  reviewerIdentity: "independent-edge-reviewer",
});
const EXPECTED_APPROVAL_BINDING = await __testing.loadExpectedApprovalBinding();

function approvalClaims(overrides = {}) {
  return {
    schema_version: 1,
    scope: EXPECTED_APPROVAL_BINDING.scope,
    target_project: EXPECTED_APPROVAL_BINDING.targetProject,
    target_region: EXPECTED_APPROVAL_BINDING.targetRegion,
    handler_file_sha256: EXPECTED_APPROVAL_BINDING.handlerFileSha256,
    manifest_file_sha256: EXPECTED_APPROVAL_BINDING.manifestFileSha256,
    manifest_self_digest: EXPECTED_APPROVAL_BINDING.manifestSelfDigest,
    reviewed_commit: EXPECTED_APPROVAL_BINDING.reviewedCommit,
    reviewed_tree: EXPECTED_APPROVAL_BINDING.reviewedTree,
    source_pins: structuredClone(EXPECTED_APPROVAL_BINDING.sourcePins),
    issued_at_ms: NOW.getTime() - 1_000,
    expires_at_ms: NOW.getTime() + 300_000,
    reviewer_identity: TEST_APPROVAL_TRUST_ANCHOR.reviewerIdentity,
    independent_reviewer: true,
    ...overrides,
  };
}

function approvalReceipt({ claims = {}, envelope = {}, signature } = {}) {
  const payloadBytes = Buffer.from(
    JSON.stringify(approvalClaims(claims)),
    "utf8",
  );
  const signatureBytes =
    signature ?? signDetached(null, payloadBytes, APPROVAL_PRIVATE_KEY);
  return Buffer.from(
    JSON.stringify({
      schema_version: 1,
      algorithm: "Ed25519",
      key_id: TEST_APPROVAL_TRUST_ANCHOR.keyId,
      payload_base64url: payloadBytes.toString("base64url"),
      signature_base64url: signatureBytes.toString("base64url"),
      ...envelope,
    }),
    "utf8",
  );
}

function payload(overrides = {}) {
  return {
    action: "closed",
    repository: {
      full_name: "hushh-labs/hushh_Tech_website",
      html_url: "https://github.com/hushh-labs/hushh_Tech_website",
      ...overrides.repository,
    },
    pull_request: {
      number: 1965,
      title: "Merge migration evidence",
      html_url:
        "https://github.com/hushh-labs/hushh_Tech_website/pull/1965",
      merged: true,
      merged_at: "2026-08-22T10:00:00.000Z",
      base: { ref: "main" },
      head: { ref: "codex/no-hybrid-execution" },
      user: { login: "review-author" },
      merged_by: { login: "merge-owner" },
      changed_files: 5,
      additions: 120,
      deletions: 10,
      labels: [{ name: "migration" }],
      ...overrides.pull_request,
    },
    ...overrides.root,
  };
}

function rawBody(value = payload()) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function signature(body, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function request(body = rawBody(), overrides = {}) {
  return {
    method: "POST",
    route: { search: "" },
    headers: {
      "content-type": "application/json",
      "x-github-delivery": DELIVERY,
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature(body),
      ...overrides.headers,
    },
    body,
    ...overrides.request,
  };
}

function ledger({ beforeClaim, beforeInvoked, beforeComplete } = {}) {
  const operations = new Map();
  const calls = [];
  let sequence = 0;
  let clock = 1_000_000;
  const owns = (input) => {
    const row = operations.get(input.operationKey);
    if (
      !row ||
      row.payloadHash !== input.payloadHash ||
      row.attempt !== input.attempt ||
      row.fencingToken !== input.fencingToken
    ) {
      throw new Error("stale fence");
    }
    return row;
  };
  return {
    configured: true,
    durability: "cloud_sql_leased_fenced_webhook_delivery_v1",
    operations,
    calls,
    advance(milliseconds) {
      clock += milliseconds;
    },
    async claim(input) {
      calls.push({ method: "claim", input });
      await beforeClaim?.(input);
      const row = operations.get(input.operationKey);
      if (row && row.payloadHash !== input.payloadHash) {
        return { disposition: "PAYLOAD_CONFLICT" };
      }
      if (row?.state === "COMPLETED") {
        return { disposition: "COMPLETED", response: row.response };
      }
      if (row?.state === "UNKNOWN" || row?.state === "SENT") {
        return { disposition: "UNKNOWN" };
      }
      if (row?.state === "PROCESSING" && row.leaseExpiresAt > clock) {
        return { disposition: "PROCESSING" };
      }
      const attempt = (row?.attempt ?? 0) + 1;
      const fencingToken = `github-fence-${String(++sequence).padStart(16, "0")}`;
      operations.set(input.operationKey, {
        state: "PROCESSING",
        payloadHash: input.payloadHash,
        attempt,
        fencingToken,
        leaseExpiresAt: clock + input.leaseDurationMs,
      });
      return { disposition: "ACQUIRED", acquired: true, attempt, fencingToken };
    },
    async markProviderInvoked(input) {
      calls.push({ method: "markProviderInvoked", input });
      await beforeInvoked?.(input);
      const row = owns(input);
      assert.equal(row.state, "PROCESSING");
      row.state = "UNKNOWN";
      return { state: "UNKNOWN" };
    },
    async markSent(input) {
      calls.push({ method: "markSent", input });
      const row = owns(input);
      assert.equal(row.state, "UNKNOWN");
      row.state = "SENT";
      row.providerMessageIdSha256 = input.providerMessageIdSha256;
      return { state: "SENT" };
    },
    async complete(input) {
      calls.push({ method: "complete", input });
      await beforeComplete?.(input);
      const row = owns(input);
      assert.equal(row.state, "SENT");
      row.state = "COMPLETED";
      row.response = input.response;
      return { state: "COMPLETED" };
    },
    async markRetryable(input) {
      calls.push({ method: "markRetryable", input });
      const row = owns(input);
      assert.equal(row.state, "PROCESSING");
      row.state = "RETRYABLE";
      return { state: "RETRYABLE" };
    },
  };
}

function mailer({ send } = {}) {
  const calls = [];
  return {
    configured: true,
    authMode: "workload_identity_domain_delegation",
    calls,
    async sendGroupMessage(input) {
      calls.push(input);
      return send?.(input) ?? {
        accepted: true,
        providerMessageId: "gmail-message-1",
      };
    },
  };
}

function candidate(overrides = {}) {
  const operationLedger = overrides.operationLedger ?? ledger();
  const mailProvider = overrides.mailer ?? mailer();
  const options = {
    approvalReceipt: overrides.approvalReceipt ?? approvalReceipt(),
    createOperationLedger:
      overrides.createOperationLedger ?? (async () => operationLedger),
    createMailer: overrides.createMailer ?? (async () => mailProvider),
    webhookSecret: SECRET,
    recipientGroup: "groups/hushh-tech-devops-notify",
    now: () => NOW,
    ...overrides,
  };
  delete options.operationLedger;
  delete options.mailer;
  return {
    operationLedger,
    mailProvider,
    handle: __testing.createGithubDevopsNotifyCandidateWithTrustAnchor(
      TEST_APPROVAL_TRUST_ANCHOR,
      options,
    ),
  };
}

function runtimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  return true;
}

test("GitHub HMAC is mandatory, raw-byte exact, and constant-time comparable", () => {
  const body = rawBody();
  assert.equal(
    verifyGitHubWebhookSignature({ body, rawBody: body, signature: signature(body), secret: SECRET }),
    true,
  );
  const changed = Buffer.concat([body, Buffer.from(" ")]);
  assert.equal(
    verifyGitHubWebhookSignature({ rawBody: changed, signature: signature(body), secret: SECRET }),
    false,
  );
  assert.equal(
    verifyGitHubWebhookSignature({ rawBody: body, signature: "", secret: SECRET }),
    false,
  );
  assert.equal(
    verifyGitHubWebhookSignature({ rawBody: body, signature: signature(body), secret: "short" }),
    false,
  );
});

test("raw detached approval binds every reviewed artifact and rejects signed mutations", () => {
  const verified = verifyRawDetachedApproval({
    rawReceipt: approvalReceipt(),
    trustAnchor: TEST_APPROVAL_TRUST_ANCHOR,
    expectedBinding: EXPECTED_APPROVAL_BINDING,
    now: () => NOW,
  });
  assert.equal(verified.reviewerIdentity, "independent-edge-reviewer");
  assert.match(verified.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal("valid" in verified, false);

  const attacks = [
    approvalReceipt({ claims: { scope: "widened-scope" } }),
    approvalReceipt({ claims: { handler_file_sha256: "0".repeat(64) } }),
    approvalReceipt({ claims: { manifest_file_sha256: "0".repeat(64) } }),
    approvalReceipt({ claims: { manifest_self_digest: "0".repeat(64) } }),
    approvalReceipt({ claims: { reviewed_commit: "1".repeat(40) } }),
    approvalReceipt({ claims: { reviewed_tree: "2".repeat(40) } }),
    approvalReceipt({
      claims: {
        source_pins: {
          ...EXPECTED_APPROVAL_BINDING.sourcePins,
          sourceVersion: 6208,
        },
      },
    }),
    approvalReceipt({ claims: { expires_at_ms: NOW.getTime() - 1 } }),
    approvalReceipt({ claims: { reviewer_identity: "different-reviewer" } }),
    approvalReceipt({ claims: { valid: true } }),
    approvalReceipt({ envelope: { valid: true } }),
  ];
  const signatureAttack = JSON.parse(approvalReceipt().toString("utf8"));
  const finalCharacter = signatureAttack.signature_base64url.at(-1);
  signatureAttack.signature_base64url =
    signatureAttack.signature_base64url.slice(0, -1) +
    (finalCharacter === "A" ? "B" : "A");
  attacks.push(Buffer.from(JSON.stringify(signatureAttack), "utf8"));

  for (const attack of attacks) {
    assert.throws(
      () =>
        verifyRawDetachedApproval({
          rawReceipt: attack,
          trustAnchor: TEST_APPROVAL_TRUST_ANCHOR,
          expectedBinding: EXPECTED_APPROVAL_BINDING,
          now: () => NOW,
        }),
      (error) =>
        runtimeCode(error, "DETACHED_CANDIDATE_NOT_APPROVED", 503),
    );
  }
});

test("valid merged-main event sends one escaped local notification and records hashes only", async () => {
  const body = rawBody(
    payload({ pull_request: { title: '<img src=x onerror="steal()"> & merged' } }),
  );
  const { handle, operationLedger, mailProvider } = candidate();
  const response = await handle({ request: request(body), signal: SIGNAL });
  assert.deepEqual(response, {
    status: 200,
    headers: { "cache-control": "private, no-store", "content-type": "application/json" },
    body: { success: true, delivery_id: DELIVERY, notification_state: "sent" },
  });
  assert.equal(mailProvider.calls.length, 1);
  assert.equal(mailProvider.calls[0].html.includes("<img"), false);
  assert.equal(mailProvider.calls[0].html.includes("&lt;img"), true);
  assert.equal(mailProvider.calls[0].groupResource, "groups/hushh-tech-devops-notify");
  assert.equal(operationLedger.calls.some(({ input }) => "rawBody" in input), false);
  assert.match(
    operationLedger.operations.get(`github:${DELIVERY}`).providerMessageIdSha256,
    /^[a-f0-9]{64}$/,
  );
});

test("duplicate semantic keys, unsafe URLs, repository drift, and master branch fail closed", async () => {
  const duplicate = Buffer.from(
    '{"action":"closed","action":"opened","pull_request":{},"repository":{}}',
  );
  assert.throws(() => parseUniqueJson(duplicate), (error) =>
    runtimeCode(error, "DUPLICATE_JSON_KEY", 400),
  );

  for (const [value, code, status] of [
    [payload({ repository: { full_name: "attacker/repo", html_url: "https://github.com/attacker/repo" } }), "REPOSITORY_NOT_ALLOWED", 403],
    [payload({ pull_request: { base: { ref: "master" } } }), "EVENT_NOT_ACTIONABLE", 202],
    [payload({ pull_request: { html_url: "https://evil.example/pull/1965" } }), "UNTRUSTED_GITHUB_URL", 400],
  ]) {
    const body = rawBody(value);
    const { handle, mailProvider } = candidate();
    await assert.rejects(
      handle({ request: request(body), signal: SIGNAL }),
      (error) => runtimeCode(error, code, status),
    );
    assert.equal(mailProvider.calls.length, 0);
  }
});

test("method, media, query, authorization, delivery, and size boundaries reject before mail", async () => {
  const cases = [
    [request(rawBody(), { request: { method: "GET" } }), "METHOD_NOT_ALLOWED", 405],
    [request(rawBody(), { headers: { "content-type": "text/plain" } }), "UNSUPPORTED_MEDIA_TYPE", 415],
    [request(rawBody(), { request: { route: { search: "?secret=x" } } }), "QUERY_NOT_ALLOWED", 400],
    [request(rawBody(), { headers: { authorization: "Bearer secret" } }), "AUTHORIZATION_NOT_ALLOWED", 400],
    [request(rawBody(), { headers: { "x-github-delivery": "not-a-uuid" } }), "INVALID_GITHUB_HEADERS", 400],
    [request(Buffer.alloc(1_048_577), { headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) } }), "PAYLOAD_TOO_LARGE", 413],
  ];
  for (const [input, code, status] of cases) {
    const { handle, mailProvider } = candidate();
    await assert.rejects(
      handle({ request: input, signal: SIGNAL }),
      (error) => runtimeCode(error, code, status),
    );
    assert.equal(mailProvider.calls.length, 0);
  }
});

test("replay returns the durable result, concurrency sends once, and body conflicts reject", async () => {
  const operationLedger = ledger();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const mailProvider = mailer({
    send: async () => {
      entered();
      await blocked;
      return { accepted: true, providerMessageId: "message-concurrent" };
    },
  });
  const { handle } = candidate({ operationLedger, mailer: mailProvider });
  const first = handle({ request: request(), signal: SIGNAL });
  await started;
  await assert.rejects(
    handle({ request: request(), signal: SIGNAL }),
    (error) => runtimeCode(error, "DELIVERY_RECONCILIATION_REQUIRED", 409),
  );
  release();
  const response = await first;
  assert.equal(mailProvider.calls.length, 1);
  assert.deepEqual(await handle({ request: request(), signal: SIGNAL }), response);
  assert.equal(mailProvider.calls.length, 1);

  const changedBody = rawBody(payload({ pull_request: { title: "different" } }));
  await assert.rejects(
    handle({
      request: request(changedBody, {
        headers: { "x-hub-signature-256": signature(changedBody) },
      }),
      signal: SIGNAL,
    }),
    (error) => runtimeCode(error, "DELIVERY_PAYLOAD_CONFLICT", 409),
  );
});

test("abort before durable dispatch becomes retryable; provider ambiguity remains UNKNOWN", async () => {
  const abort = new AbortController();
  const preProviderLedger = ledger({
    beforeInvoked: () => {
      abort.abort(new Error("client left"));
      throw abort.signal.reason;
    },
  });
  const preProviderMailer = mailer();
  const first = candidate({ operationLedger: preProviderLedger, mailer: preProviderMailer });
  await assert.rejects(
    first.handle({ request: request(), signal: abort.signal }),
    (error) => {
      assert.equal(error.message.includes("client left"), false);
      return runtimeCode(error, "HANDLER_ABORTED", 503);
    },
  );
  assert.equal(preProviderMailer.calls.length, 0);
  assert.equal(preProviderLedger.operations.get(`github:${DELIVERY}`).state, "RETRYABLE");

  const ambiguousLedger = ledger();
  const ambiguousMailer = mailer({ send: async () => { throw new Error("socket reset with provider body secret"); } });
  const second = candidate({ operationLedger: ambiguousLedger, mailer: ambiguousMailer });
  await assert.rejects(
    second.handle({ request: request(), signal: SIGNAL }),
    (error) => {
      assert.equal(error.message.includes("provider body secret"), false);
      return runtimeCode(error, "DELIVERY_RECONCILIATION_REQUIRED", 503);
    },
  );
  assert.equal(ambiguousLedger.operations.get(`github:${DELIVERY}`).state, "UNKNOWN");
  await assert.rejects(
    second.handle({ request: request(), signal: SIGNAL }),
    (error) => runtimeCode(error, "DELIVERY_RECONCILIATION_REQUIRED", 409),
  );
  assert.equal(ambiguousMailer.calls.length, 1);
});

test("prevalidated claims and unprovisioned approval fail before dependency factories", async () => {
  const operationLedger = ledger();
  const mailProvider = mailer();
  let ledgerFactoryCalls = 0;
  let mailFactoryCalls = 0;
  const prevalidatedClaim = createGithubDevopsNotifyCandidate({
    approvalReceipt: {
      valid: true,
      reviewerIdentity: "caller-prevalidated",
    },
    webhookSecret: SECRET,
    createOperationLedger: async () => {
      ledgerFactoryCalls += 1;
      return operationLedger;
    },
    createMailer: async () => {
      mailFactoryCalls += 1;
      return mailProvider;
    },
    recipientGroup: "groups/hushh-tech-devops-notify",
    now: () => NOW,
  });
  await assert.rejects(
    prevalidatedClaim({ request: request(), signal: SIGNAL }),
    (error) => runtimeCode(error, "DETACHED_CANDIDATE_NOT_APPROVED", 503),
  );
  assert.equal(ledgerFactoryCalls, 0);
  assert.equal(mailFactoryCalls, 0);
  assert.equal(operationLedger.calls.length, 0);
  assert.equal(mailProvider.calls.length, 0);

  const signedButUnprovisioned = createGithubDevopsNotifyCandidate({
    approvalReceipt: approvalReceipt(),
    webhookSecret: SECRET,
    createOperationLedger: async () => {
      ledgerFactoryCalls += 1;
      return operationLedger;
    },
    createMailer: async () => {
      mailFactoryCalls += 1;
      return mailProvider;
    },
    recipientGroup: "groups/hushh-tech-devops-notify",
    now: () => NOW,
  });
  await assert.rejects(
    signedButUnprovisioned({ request: request(), signal: SIGNAL }),
    (error) => runtimeCode(error, "DETACHED_CANDIDATE_NOT_APPROVED", 503),
  );
  assert.equal(GITHUB_DEVOPS_NOTIFY_APPROVAL_TRUST_ANCHOR.provisioningState, "UNPROVISIONED");
  assert.equal(ledgerFactoryCalls, 0);
  assert.equal(mailFactoryCalls, 0);
});

test("dependency and repository allowlist gates fail before provider calls", async () => {

  assert.throws(
    () => candidate({ repositoryAllowlist: ["hushh-labs/hushh_Tech_website", "hushh-labs/hushh_Tech_website"] }),
    (error) => runtimeCode(error, "REPOSITORY_ALLOWLIST_INVALID", 503),
  );
  assert.throws(
    () => candidate({ repositoryAllowlist: ["attacker/repo"] }),
    (error) => runtimeCode(error, "REPOSITORY_ALLOWLIST_INVALID", 503),
  );
  assert.throws(
    () => candidate({ recipientGroup: "groups/attacker-notify" }),
    (error) => runtimeCode(error, "RECIPIENT_GROUP_UNAVAILABLE", 503),
  );
});

test("raw ledger failures and corrupted replay rows never escape or reach mail", async () => {
  const brokenLedger = ledger({
    beforeClaim: () => {
      throw new Error("postgres host and password leaked");
    },
  });
  const firstMailer = mailer();
  const first = candidate({ operationLedger: brokenLedger, mailer: firstMailer });
  await assert.rejects(
    first.handle({ request: request(), signal: SIGNAL }),
    (error) => {
      assert.equal(error.message.includes("postgres"), false);
      return runtimeCode(error, "DURABLE_LEDGER_UNAVAILABLE", 503);
    },
  );
  assert.equal(firstMailer.calls.length, 0);

  const corruptLedger = ledger();
  corruptLedger.operations.set(`github:${DELIVERY}`, {
    state: "COMPLETED",
    payloadHash: "placeholder",
    attempt: 1,
    fencingToken: "github-fence-corrupt",
    response: {
      status: 200,
      headers: { "cache-control": "public", "content-type": "application/json" },
      body: { success: true, delivery_id: DELIVERY, notification_state: "sent", email: "private@example.com" },
    },
  });
  const body = rawBody();
  corruptLedger.operations.get(`github:${DELIVERY}`).payloadHash =
    createHash("sha256").update(body).digest("hex");
  const secondMailer = mailer();
  const second = candidate({ operationLedger: corruptLedger, mailer: secondMailer });
  await assert.rejects(
    second.handle({ request: request(body), signal: SIGNAL }),
    (error) => runtimeCode(error, "DURABLE_LEDGER_UNAVAILABLE", 503),
  );
  assert.equal(secondMailer.calls.length, 0);
});
