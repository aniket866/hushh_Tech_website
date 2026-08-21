import { createHash } from "node:crypto";

import { RuntimeError } from "./errors.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const OUTBOX_TOPIC_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const MAX_OUTBOX_EVENTS = 64;
const MAX_OUTBOX_EVENT_BYTES = 262_144;
const MAX_OUTBOX_TOTAL_BYTES = 1_048_576;
const MAX_WEBHOOK_RESPONSE_BYTES = 65_536;

function unavailable(error) {
  if (
    error instanceof RuntimeError &&
    error.code === "WEBHOOK_LEDGER_UNAVAILABLE"
  ) {
    return error;
  }
  return new RuntimeError(
    "WEBHOOK_LEDGER_UNAVAILABLE",
    "Webhook unavailable.",
    503,
    error ? { cause: error } : {},
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function exactReceipt(result, claim) {
  const resultPayloadHash = String(result?.payloadHash ?? "");
  if (!HASH_PATTERN.test(resultPayloadHash)) throw unavailable();
  if (resultPayloadHash !== claim.payloadHash) {
    throw new RuntimeError(
      "WEBHOOK_REPLAY_CONFLICT",
      "Webhook already received.",
      409,
    );
  }
  if (result.eventKeyHash !== claim.eventKeyHash) throw unavailable();
}

function normalizeOutbox(outbox) {
  if (outbox === undefined) return Object.freeze([]);
  if (!Array.isArray(outbox) || outbox.length > MAX_OUTBOX_EVENTS) {
    throw new RuntimeError(
      "HANDLER_CONTRACT_INVALID",
      "Service unavailable.",
      503,
    );
  }

  let totalBytes = 0;
  const seen = new Set();
  const normalized = outbox.map((entry) => {
    const topic = String(entry?.topic ?? "").trim();
    const idempotencyKey = String(entry?.idempotencyKey ?? "").trim();
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !OUTBOX_TOPIC_PATTERN.test(topic) ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 256 ||
      hasControlCharacters(idempotencyKey) ||
      !("payload" in entry) ||
      Object.keys(entry).some(
        (key) => !["topic", "idempotencyKey", "payload"].includes(key),
      ) ||
      seen.has(idempotencyKey)
    ) {
      throw new RuntimeError(
        "HANDLER_CONTRACT_INVALID",
        "Service unavailable.",
        503,
      );
    }

    let payloadJson;
    try {
      payloadJson = JSON.stringify(entry.payload);
    } catch {
      payloadJson = null;
    }
    const payloadBytes =
      typeof payloadJson === "string"
        ? Buffer.byteLength(payloadJson, "utf8")
        : MAX_OUTBOX_EVENT_BYTES + 1;
    totalBytes += payloadBytes;
    if (
      payloadBytes < 2 ||
      payloadBytes > MAX_OUTBOX_EVENT_BYTES ||
      totalBytes > MAX_OUTBOX_TOTAL_BYTES
    ) {
      throw new RuntimeError(
        "HANDLER_CONTRACT_INVALID",
        "Service unavailable.",
        503,
      );
    }
    seen.add(idempotencyKey);
    return Object.freeze({
      topic,
      idempotencyKey,
      payloadJson,
      payloadHash: sha256(Buffer.from(payloadJson, "utf8")),
    });
  });
  return Object.freeze(normalized);
}

function responseFingerprint(response) {
  const headers = Object.entries(response.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  let bodyKind = "empty";
  let bodyBytes = Buffer.alloc(0);
  if (Buffer.isBuffer(response.body)) {
    bodyKind = "binary";
    bodyBytes = response.body;
  } else if (response.body !== undefined && response.body !== null) {
    bodyKind = "json";
    let serialized;
    try {
      serialized = JSON.stringify(response.body);
    } catch {
      serialized = null;
    }
    if (typeof serialized !== "string") {
      throw new RuntimeError(
        "HANDLER_CONTRACT_INVALID",
        "Service unavailable.",
        503,
      );
    }
    bodyBytes = Buffer.from(serialized, "utf8");
  }
  if (bodyBytes.length > MAX_WEBHOOK_RESPONSE_BYTES) {
    throw new RuntimeError(
      "HANDLER_CONTRACT_INVALID",
      "Service unavailable.",
      503,
    );
  }
  return sha256(
    Buffer.from(
      JSON.stringify([
        1,
        response.status,
        headers,
        bodyKind,
        bodyBytes.toString("base64"),
      ]),
      "utf8",
    ),
  );
}

export function buildWebhookLedgerClaim(actor, rawBody) {
  const provider = String(actor?.provider ?? "").trim();
  const eventId = String(actor?.eventId ?? "").trim();
  if (
    actor?.kind !== "provider-webhook" ||
    !provider ||
    provider.length > 64 ||
    hasControlCharacters(provider) ||
    !eventId ||
    eventId.length > 256 ||
    hasControlCharacters(eventId) ||
    !Buffer.isBuffer(rawBody) ||
    rawBody.length === 0
  ) {
    throw new RuntimeError("WEBHOOK_LEDGER_INVALID", "Webhook rejected.", 400);
  }

  return Object.freeze({
    version: 1,
    eventKeyHash: sha256(
      Buffer.from(JSON.stringify([1, provider, eventId]), "utf8"),
    ),
    payloadHash: sha256(rawBody),
  });
}

export function buildWebhookCompletion(response, outbox) {
  if (
    !response ||
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status > 299
  ) {
    throw new RuntimeError(
      "HANDLER_CONTRACT_INVALID",
      "Service unavailable.",
      503,
    );
  }
  const normalizedOutbox = normalizeOutbox(outbox);
  return Object.freeze({
    responseHash: responseFingerprint(response),
    outbox: normalizedOutbox,
  });
}

export function createUnavailableWebhookLedger() {
  const reject = async () => {
    throw unavailable();
  };
  return Object.freeze({
    claim: reject,
    complete: reject,
    markRetryable: reject,
    verifyReady: reject,
  });
}

export async function verifyWebhookLedger(ledger) {
  if (
    !ledger ||
    typeof ledger.claim !== "function" ||
    typeof ledger.complete !== "function" ||
    typeof ledger.markRetryable !== "function" ||
    typeof ledger.verifyReady !== "function"
  ) {
    throw unavailable();
  }
  let ready;
  try {
    ready = await ledger.verifyReady();
  } catch (error) {
    throw unavailable(error);
  }
  if (ready !== true) throw unavailable();
  return true;
}

export async function claimWebhookEvent(
  ledger,
  actor,
  rawBody,
  { signal, leaseMs = 30_000, now = Date.now } = {},
) {
  const claim = buildWebhookLedgerClaim(actor, rawBody);
  if (
    !ledger ||
    typeof ledger.claim !== "function" ||
    typeof now !== "function" ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1_000 ||
    leaseMs > 120_000
  ) {
    throw unavailable();
  }
  if (signal?.aborted) throw signal.reason ?? unavailable();

  let result;
  try {
    result = await ledger.claim(
      Object.freeze({ ...claim, leaseMs, signal }),
    );
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw error;
    throw unavailable(error);
  }
  if (signal?.aborted) throw signal.reason ?? unavailable();
  exactReceipt(result, claim);

  if (result.state === "COMPLETED" && result.acquired === false) {
    if (!HASH_PATTERN.test(String(result.responseHash ?? ""))) {
      throw unavailable();
    }
    return Object.freeze({
      disposition: "COMPLETED",
      eventKeyHash: claim.eventKeyHash,
      payloadHash: claim.payloadHash,
      responseHash: result.responseHash,
    });
  }

  if (result.state !== "PROCESSING") throw unavailable();
  if (result.acquired === false) {
    throw new RuntimeError(
      "WEBHOOK_IN_PROGRESS",
      "Webhook is already processing.",
      409,
    );
  }
  const claimToken = String(result.claimToken ?? "");
  const attempt = Number(result.attempt);
  const leaseExpiresAtMs = Number(result.leaseExpiresAtMs);
  const observedAtMs = Number(now());
  if (
    result.acquired !== true ||
    !CLAIM_TOKEN_PATTERN.test(claimToken) ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 1_000_000 ||
    !Number.isSafeInteger(leaseExpiresAtMs) ||
    !Number.isSafeInteger(observedAtMs) ||
    leaseExpiresAtMs <= observedAtMs ||
    leaseExpiresAtMs > observedAtMs + leaseMs + 30_000
  ) {
    throw unavailable();
  }
  return Object.freeze({
    disposition: "ACQUIRED",
    claim: Object.freeze({
      ...claim,
      claimToken,
      attempt,
      leaseExpiresAtMs,
    }),
  });
}

export async function completeWebhookEvent(
  ledger,
  claim,
  completion,
  { signal } = {},
) {
  if (
    !ledger ||
    typeof ledger.complete !== "function" ||
    !claim ||
    !HASH_PATTERN.test(String(claim.eventKeyHash ?? "")) ||
    !HASH_PATTERN.test(String(claim.payloadHash ?? "")) ||
    !CLAIM_TOKEN_PATTERN.test(String(claim.claimToken ?? "")) ||
    !completion ||
    !HASH_PATTERN.test(String(completion.responseHash ?? "")) ||
    !Array.isArray(completion.outbox)
  ) {
    throw unavailable();
  }
  if (signal?.aborted) throw signal.reason ?? unavailable();

  let result;
  try {
    result = await ledger.complete(
      Object.freeze({
        version: 1,
        eventKeyHash: claim.eventKeyHash,
        payloadHash: claim.payloadHash,
        claimToken: claim.claimToken,
        responseHash: completion.responseHash,
        outbox: completion.outbox,
        signal,
      }),
    );
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw error;
    throw unavailable(error);
  }
  if (signal?.aborted) throw signal.reason ?? unavailable();
  exactReceipt(result, claim);
  if (
    result.state !== "COMPLETED" ||
    result.responseHash !== completion.responseHash ||
    Number(result.outboxCount) !== completion.outbox.length
  ) {
    throw unavailable();
  }
  return Object.freeze({
    state: "COMPLETED",
    responseHash: completion.responseHash,
    outboxCount: completion.outbox.length,
  });
}

export async function markWebhookEventRetryable(ledger, claim, error) {
  if (
    !ledger ||
    typeof ledger.markRetryable !== "function" ||
    !claim ||
    !HASH_PATTERN.test(String(claim.eventKeyHash ?? "")) ||
    !HASH_PATTERN.test(String(claim.payloadHash ?? "")) ||
    !CLAIM_TOKEN_PATTERN.test(String(claim.claimToken ?? ""))
  ) {
    throw unavailable();
  }
  const failureCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(error?.code ?? ""))
    ? error.code
    : "INTERNAL_ERROR";
  let result;
  try {
    result = await ledger.markRetryable(
      Object.freeze({
        version: 1,
        eventKeyHash: claim.eventKeyHash,
        payloadHash: claim.payloadHash,
        claimToken: claim.claimToken,
        failureCode,
      }),
    );
  } catch (ledgerError) {
    throw unavailable(ledgerError);
  }
  exactReceipt(result, claim);
  if (!["RETRYABLE", "COMPLETED"].includes(result.state)) {
    throw unavailable();
  }
  return Object.freeze({ state: result.state });
}
