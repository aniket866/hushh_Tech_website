import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeError } from "../src/errors.js";
import {
  consumeSharedRateLimit,
  createUnavailableSharedRateLimiter,
  verifySharedRateLimiter,
} from "../src/shared-rate-limit.js";
import {
  buildWebhookCompletion,
  buildWebhookLedgerClaim,
  claimWebhookEvent,
  completeWebhookEvent,
  createUnavailableWebhookLedger,
  markWebhookEventRetryable,
  verifyWebhookLedger,
} from "../src/webhook-ledger.js";

function runtimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  return true;
}

const ACTOR = Object.freeze({
  kind: "provider-webhook",
  provider: "stripe",
  eventId: "evt_state_1",
});
const BODY = Buffer.from('{"value":1}');

function statefulLedger() {
  const records = new Map();
  return {
    records,
    verifyReady: async () => true,
    claim: async ({ eventKeyHash, payloadHash, leaseMs }) => {
      let record = records.get(eventKeyHash);
      if (record && record.payloadHash !== payloadHash) {
        return {
          state: record.state,
          acquired: false,
          eventKeyHash,
          payloadHash: record.payloadHash,
          responseHash: record.responseHash,
        };
      }
      if (record?.state === "COMPLETED") {
        return {
          state: record.state,
          acquired: false,
          eventKeyHash,
          payloadHash,
          responseHash: record.responseHash,
        };
      }
      if (record?.state === "PROCESSING") {
        return {
          state: record.state,
          acquired: false,
          eventKeyHash,
          payloadHash,
        };
      }
      const attempt = (record?.attempt ?? 0) + 1;
      record = {
        state: "PROCESSING",
        payloadHash,
        claimToken: `claim-token-attempt-${attempt}`,
        attempt,
      };
      records.set(eventKeyHash, record);
      return {
        state: record.state,
        acquired: true,
        eventKeyHash,
        payloadHash,
        claimToken: record.claimToken,
        attempt,
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
      const record = records.get(eventKeyHash);
      assert.equal(record.state, "PROCESSING");
      assert.equal(record.claimToken, claimToken);
      record.state = "COMPLETED";
      record.responseHash = responseHash;
      record.outbox = outbox;
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
      const record = records.get(eventKeyHash);
      assert.equal(record.claimToken, claimToken);
      record.state = "RETRYABLE";
      record.failureCode = failureCode;
      return { state: record.state, eventKeyHash, payloadHash };
    },
  };
}

test("webhook ledger keys hash provider identity and exact payload bytes", () => {
  const first = buildWebhookLedgerClaim(ACTOR, BODY);
  const same = buildWebhookLedgerClaim(ACTOR, BODY);
  const otherEvent = buildWebhookLedgerClaim(
    { ...ACTOR, eventId: "evt_state_2" },
    BODY,
  );
  const otherPayload = buildWebhookLedgerClaim(
    ACTOR,
    Buffer.from('{"value":2}'),
  );

  assert.deepEqual(first, same);
  assert.match(first.eventKeyHash, /^[a-f0-9]{64}$/);
  assert.match(first.payloadHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.eventKeyHash, otherEvent.eventKeyHash);
  assert.equal(first.payloadHash, otherEvent.payloadHash);
  assert.notEqual(first.payloadHash, otherPayload.payloadHash);
  assert.equal(JSON.stringify(first).includes(ACTOR.eventId), false);
  assert.equal(Object.isFrozen(first), true);
});

test("webhook ledger rejects unavailable, conflicting, and malformed claims", async () => {
  await assert.rejects(
    claimWebhookEvent(createUnavailableWebhookLedger(), ACTOR, BODY),
    (error) => runtimeCode(error, "WEBHOOK_LEDGER_UNAVAILABLE", 503),
  );
  const claim = buildWebhookLedgerClaim(ACTOR, BODY);
  await assert.rejects(
    claimWebhookEvent(
      {
        claim: async () => ({
          state: "PROCESSING",
          acquired: false,
          eventKeyHash: claim.eventKeyHash,
          payloadHash: claim.payloadHash,
        }),
      },
      ACTOR,
      BODY,
    ),
    (error) => runtimeCode(error, "WEBHOOK_IN_PROGRESS", 409),
  );
  await assert.rejects(
    claimWebhookEvent(
      {
        claim: async () => ({
          state: "PROCESSING",
          acquired: false,
          eventKeyHash: claim.eventKeyHash,
          payloadHash: "a".repeat(64),
        }),
      },
      ACTOR,
      BODY,
    ),
    (error) => runtimeCode(error, "WEBHOOK_REPLAY_CONFLICT", 409),
  );
  await assert.rejects(
    claimWebhookEvent(
      {
        claim: async () => ({
          state: "PROCESSING",
          acquired: true,
          eventKeyHash: claim.eventKeyHash,
          payloadHash: claim.payloadHash,
        }),
      },
      ACTOR,
      BODY,
    ),
    (error) => runtimeCode(error, "WEBHOOK_LEDGER_UNAVAILABLE", 503),
  );
  await assert.rejects(
    claimWebhookEvent(
      {
        claim: async () => ({
          state: "PROCESSING",
          acquired: true,
          eventKeyHash: claim.eventKeyHash,
          payloadHash: claim.payloadHash,
          claimToken: "claim-token-expired",
          attempt: 1,
          leaseExpiresAtMs: 999,
        }),
      },
      ACTOR,
      BODY,
      { now: () => 1_000 },
    ),
    (error) => runtimeCode(error, "WEBHOOK_LEDGER_UNAVAILABLE", 503),
  );
});

test("webhook completion is atomic with a bounded idempotent outbox", async () => {
  const ledger = statefulLedger();
  assert.equal(await verifyWebhookLedger(ledger), true);
  const acquired = await claimWebhookEvent(ledger, ACTOR, BODY);
  assert.equal(acquired.disposition, "ACQUIRED");
  const completion = buildWebhookCompletion(
    {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { received: true },
    },
    [
      {
        topic: "webhook.processing",
        idempotencyKey: "outbox-event-1",
        payload: { event: "evt_state_1" },
      },
    ],
  );
  const completed = await completeWebhookEvent(
    ledger,
    acquired.claim,
    completion,
  );
  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.outboxCount, 1);
  const record = ledger.records.get(acquired.claim.eventKeyHash);
  assert.equal(record.state, "COMPLETED");
  assert.equal(record.outbox.length, 1);
  assert.match(record.outbox[0].payloadHash, /^[a-f0-9]{64}$/);

  const duplicate = await claimWebhookEvent(ledger, ACTOR, BODY);
  assert.equal(duplicate.disposition, "COMPLETED");
  assert.equal(duplicate.responseHash, completion.responseHash);

  assert.throws(
    () => buildWebhookCompletion({ status: 503, headers: {}, body: null }),
    (error) => runtimeCode(error, "HANDLER_CONTRACT_INVALID", 503),
  );
  assert.throws(
    () =>
      buildWebhookCompletion(
        { status: 204, headers: {}, body: null },
        [
          { topic: "a", idempotencyKey: "duplicate-key", payload: {} },
          { topic: "b", idempotencyKey: "duplicate-key", payload: {} },
        ],
      ),
    (error) => runtimeCode(error, "HANDLER_CONTRACT_INVALID", 503),
  );
});

test("failed webhook work becomes retryable before a later attempt completes", async () => {
  const ledger = statefulLedger();
  const first = await claimWebhookEvent(ledger, ACTOR, BODY);
  const retryable = await markWebhookEventRetryable(
    ledger,
    first.claim,
    new RuntimeError("HANDLER_DEADLINE_EXCEEDED", "Unavailable.", 504),
  );
  assert.equal(retryable.state, "RETRYABLE");
  const second = await claimWebhookEvent(ledger, ACTOR, BODY);
  assert.equal(second.disposition, "ACQUIRED");
  assert.equal(second.claim.attempt, 2);
  assert.notEqual(second.claim.claimToken, first.claim.claimToken);
  assert.equal(
    ledger.records.get(second.claim.eventKeyHash).failureCode,
    undefined,
  );
});

test("webhook readiness requires every durable state transition", async () => {
  await assert.rejects(
    verifyWebhookLedger({
      claim: async () => {},
      complete: async () => {},
      verifyReady: async () => true,
    }),
    (error) => runtimeCode(error, "WEBHOOK_LEDGER_UNAVAILABLE", 503),
  );
});

test("shared limiter is mandatory, readiness-aware, and fail closed", async () => {
  const unavailable = createUnavailableSharedRateLimiter();
  await assert.rejects(verifySharedRateLimiter(unavailable), (error) =>
    runtimeCode(error, "SHARED_RATE_LIMIT_UNAVAILABLE", 503),
  );
  await assert.rejects(
    consumeSharedRateLimit(unavailable, { key: "a".repeat(64) }),
    (error) => runtimeCode(error, "SHARED_RATE_LIMIT_UNAVAILABLE", 503),
  );
  await assert.rejects(
    verifySharedRateLimiter({
      verifyReady: async () => {
        throw new RuntimeError("ADAPTER_ERROR", "Do not expose me.", 418);
      },
    }),
    (error) => runtimeCode(error, "SHARED_RATE_LIMIT_UNAVAILABLE", 503),
  );
  await assert.rejects(
    consumeSharedRateLimit(
      { consume: async () => ({ allowed: false }) },
      { key: "b".repeat(64) },
    ),
    (error) => runtimeCode(error, "RATE_LIMITED", 429),
  );
  await assert.rejects(
    consumeSharedRateLimit(
      {
        consume: async () => {
          throw new RuntimeError("ADAPTER_ERROR", "Do not expose me.", 418);
        },
      },
      { key: "c".repeat(64) },
    ),
    (error) => runtimeCode(error, "SHARED_RATE_LIMIT_UNAVAILABLE", 503),
  );

  const controller = new AbortController();
  const deadline = new RuntimeError(
    "HANDLER_DEADLINE_EXCEEDED",
    "Unavailable.",
    504,
  );
  controller.abort(deadline);
  await assert.rejects(
    consumeSharedRateLimit(
      { consume: async () => ({ allowed: true }) },
      { key: "d".repeat(64), signal: controller.signal },
    ),
    (error) => error === deadline,
  );
  assert.equal(
    await verifySharedRateLimiter({ verifyReady: async () => true }),
    true,
  );
});
