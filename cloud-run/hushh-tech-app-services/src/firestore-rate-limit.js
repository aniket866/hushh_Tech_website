import { createHash } from "node:crypto";

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { GoogleAuth } from "google-auth-library";

const COLLECTION = "hushh_tech_shared_rate_limits_v1";
const SCHEMA_VERSION = 1;
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const READINESS_CACHE_MS = 60_000;
const METADATA_TIMEOUT_MS = 5_000;
const DOCUMENT_TTL_GRACE_MS = 300_000;
const SATURATED_CACHE_MAX = 5_000;
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const EXPLICIT_FIELD_FILTER =
  "indexConfig.usesAncestorConfig:false OR ttlConfig:*";
const ALLOWED_PROJECTS = new Set(["hushh-tech-uat", "hushh-tech-prod"]);
const SERVICE_DATABASES = Object.freeze({
  "investor-api": "hushh-tech-rate-investor",
  "identity-api": "hushh-tech-rate-identity",
  "financial-api": "hushh-tech-rate-financial",
  "content-api": "hushh-tech-rate-content",
  "engagement-api-worker": "hushh-tech-rate-engagement",
  "signed-webhook-service": "hushh-tech-runtime",
  worker: "hushh-tech-rate-worker",
});
const UNINDEXED_FIELDS = Object.freeze([
  "bucket_key_sha256",
  "count",
  "created_at",
  "expires_at",
  "limit",
  "reset_at_ms",
  "schema_version",
  "service_owner",
  "updated_at",
  "verified_at",
  "window_ms",
  "window_start_ms",
]);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertAdapterConfig(config) {
  if (
    !config ||
    !ALLOWED_PROJECTS.has(config.projectId) ||
    typeof config.serviceOwner !== "string" ||
    !SERVICE_DATABASES[config.serviceOwner]
  ) {
    throw new Error("The shared rate-limit authority is not configured.");
  }
}

function assertConsumeInput(input) {
  if (
    !input ||
    !KEY_PATTERN.test(input.key) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 10_000 ||
    !Number.isSafeInteger(input.windowMs) ||
    input.windowMs < 1_000 ||
    input.windowMs > 3_600_000
  ) {
    throw new Error("The shared rate-limit request is invalid.");
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("The shared rate-limit request was aborted.");
}

function raceWithAbort(operation, signal) {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("The shared rate-limit request was aborted."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function createFirestore(projectId, databaseId) {
  const name = `hushh-tech-rate-limit-${projectId}-${databaseId}`;
  const app =
    getApps().find((candidate) => candidate.name === name) ??
    initializeApp({ projectId }, name);
  return getFirestore(app, databaseId);
}

async function defaultAccessToken() {
  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result?.token;
  if (typeof token !== "string" || !token) {
    throw new Error("The Firestore metadata authority is unavailable.");
  }
  return token;
}

export async function verifyFirestoreIndexContract({
  projectId,
  databaseId,
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultAccessToken,
} = {}) {
  if (
    !ALLOWED_PROJECTS.has(projectId) ||
    !Object.values(SERVICE_DATABASES).includes(databaseId) ||
    typeof fetchImpl !== "function" ||
    typeof getAccessToken !== "function"
  ) {
    throw new Error("The Firestore index contract is not configured.");
  }
  const signal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
  let token;
  let response;
  let body;
  try {
    token = await raceWithAbort(Promise.resolve().then(getAccessToken), signal);
    if (typeof token !== "string" || !token) {
      throw new Error("The Firestore metadata authority is unavailable.");
    }
    const url =
      `https://firestore.googleapis.com/v1/projects/${projectId}` +
      `/databases/${databaseId}/collectionGroups/${COLLECTION}/fields` +
      `?filter=${encodeURIComponent(EXPLICIT_FIELD_FILTER)}`;
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal,
    });
    if (!response?.ok) {
      throw new Error("The Firestore index contract is unavailable.");
    }
    body = await response.json();
  } catch {
    throw new Error("The Firestore index contract is unavailable.");
  }
  if (
    !body ||
    !Array.isArray(body.fields) ||
    body.nextPageToken ||
    body.fields.length !== UNINDEXED_FIELDS.length
  ) {
    throw new Error("The Firestore index contract drifted.");
  }
  const observed = new Map();
  for (const field of body.fields) {
    const prefix =
      `projects/${projectId}/databases/${databaseId}` +
      `/collectionGroups/${COLLECTION}/fields/`;
    if (typeof field?.name !== "string" || !field.name.startsWith(prefix)) {
      throw new Error("The Firestore index contract drifted.");
    }
    const name = field.name.slice(prefix.length);
    if (observed.has(name)) {
      throw new Error("The Firestore index contract drifted.");
    }
    const indexes = field.indexConfig?.indexes ?? [];
    const expectedAncestor =
      `projects/${projectId}/databases/${databaseId}` +
      "/collectionGroups/__default__/fields/*";
    if (
      !UNINDEXED_FIELDS.includes(name) ||
      !Array.isArray(indexes) ||
      indexes.length !== 0 ||
      field.indexConfig?.ancestorField !== expectedAncestor ||
      field.indexConfig?.usesAncestorConfig === true ||
      field.indexConfig?.reverting === true ||
      (name === "expires_at"
        ? field.ttlConfig?.state !== "ACTIVE"
        : field.ttlConfig !== undefined)
    ) {
      throw new Error("The Firestore index contract drifted.");
    }
    observed.set(name, true);
  }
  if (UNINDEXED_FIELDS.some((name) => !observed.has(name))) {
    throw new Error("The Firestore index contract drifted.");
  }
  return true;
}

function documentIdentity({
  serviceOwner,
  key,
  limit,
  windowMs,
  windowStartMs,
}) {
  return sha256(
    JSON.stringify([
      SCHEMA_VERSION,
      serviceOwner,
      key,
      limit,
      windowMs,
      windowStartMs,
    ]),
  );
}

function assertStoredBucket(data, expected) {
  if (
    !data ||
    data.schema_version !== SCHEMA_VERSION ||
    data.bucket_key_sha256 !== expected.key ||
    data.service_owner !== expected.serviceOwner ||
    data.limit !== expected.limit ||
    data.window_ms !== expected.windowMs ||
    data.window_start_ms !== expected.windowStartMs ||
    data.reset_at_ms !== expected.resetAtMs ||
    !Number.isSafeInteger(data.count) ||
    data.count < 1 ||
    data.count > expected.limit + 1
  ) {
    throw new Error("The shared rate-limit record is invalid.");
  }
  return data.count;
}

/**
 * Creates a fixed-window, cross-instance limiter backed by the Hushh Tech
 * project's service-specific Firestore database. Document IDs and stored keys
 * are
 * SHA-256 values only; no Firebase UID, provider event ID, token, or request
 * body is persisted. A Firestore TTL policy on `expires_at` is an operational
 * enablement requirement.
 */
export function createFirestoreSharedRateLimiter({
  config,
  firestore = null,
  now = Date.now,
  verifyIndexContract = verifyFirestoreIndexContract,
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultAccessToken,
  createReadinessSignal = () => AbortSignal.timeout(METADATA_TIMEOUT_MS),
} = {}) {
  assertAdapterConfig(config);
  if (typeof now !== "function") {
    throw new Error("A shared rate-limit clock is required.");
  }
  const databaseId = SERVICE_DATABASES[config.serviceOwner];
  const store = firestore ?? createFirestore(config.projectId, databaseId);
  if (
    !store ||
    typeof store.collection !== "function" ||
    typeof store.runTransaction !== "function"
  ) {
    throw new Error("A Firestore transaction adapter is required.");
  }
  if (typeof verifyIndexContract !== "function") {
    throw new Error("A Firestore index verifier is required.");
  }
  if (typeof createReadinessSignal !== "function") {
    throw new Error("A Firestore readiness deadline is required.");
  }

  const collection = store.collection(COLLECTION);
  const saturatedUntil = new Map();
  let readyUntilMs = 0;
  let readiness = null;

  function rememberSaturated(documentId, resetAtMs, timestamp) {
    if (saturatedUntil.size >= SATURATED_CACHE_MAX) {
      for (const [key, expiry] of saturatedUntil) {
        if (expiry <= timestamp) saturatedUntil.delete(key);
      }
    }
    if (
      saturatedUntil.size < SATURATED_CACHE_MAX ||
      saturatedUntil.has(documentId)
    ) {
      saturatedUntil.set(documentId, resetAtMs);
    }
  }

  async function verifyReady() {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error("The shared rate-limit clock is invalid.");
    }
    if (timestamp < readyUntilMs) return true;
    if (!readiness) {
      const documentId = sha256(
        JSON.stringify([
          SCHEMA_VERSION,
          "readiness",
          config.projectId,
          databaseId,
          config.serviceOwner,
        ]),
      );
      const reference = collection.doc(documentId);
      readiness = store
        .runTransaction(async (transaction) => {
          await transaction.get(reference);
          transaction.set(reference, {
            schema_version: SCHEMA_VERSION,
            service_owner: config.serviceOwner,
            verified_at: new Date(timestamp),
            expires_at: new Date(timestamp + DOCUMENT_TTL_GRACE_MS),
          });
          return true;
        })
        .then(async (result) => {
          if (result !== true) {
            throw new Error("The shared rate-limit readiness write failed.");
          }
          const indexReady = await verifyIndexContract({
            projectId: config.projectId,
            databaseId,
            fetchImpl,
            getAccessToken,
          });
          if (indexReady !== true) {
            throw new Error("The Firestore index contract is unavailable.");
          }
          readyUntilMs = timestamp + READINESS_CACHE_MS;
          return true;
        })
        .finally(() => {
          readiness = null;
        });
    }
    const signal = createReadinessSignal();
    if (
      !signal ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function"
    ) {
      throw new Error("The Firestore readiness deadline is invalid.");
    }
    return raceWithAbort(readiness, signal);
  }

  async function consume(input) {
    assertConsumeInput(input);
    throwIfAborted(input.signal);
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error("The shared rate-limit clock is invalid.");
    }
    const windowStartMs =
      Math.floor(timestamp / input.windowMs) * input.windowMs;
    const resetAtMs = windowStartMs + input.windowMs;
    const expected = Object.freeze({
      serviceOwner: config.serviceOwner,
      key: input.key,
      limit: input.limit,
      windowMs: input.windowMs,
      windowStartMs,
      resetAtMs,
    });
    const documentId = documentIdentity(expected);
    const cachedSaturation = saturatedUntil.get(documentId);
    if (cachedSaturation !== undefined) {
      if (timestamp < cachedSaturation) {
        return Object.freeze({
          allowed: false,
          remaining: 0,
          resetAt: resetAtMs,
        });
      }
      saturatedUntil.delete(documentId);
    }
    const reference = collection.doc(documentId);
    const operation = store.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      throwIfAborted(input.signal);
      let count;
      if (!snapshot.exists) {
        count = 1;
        transaction.create(reference, {
          schema_version: SCHEMA_VERSION,
          bucket_key_sha256: input.key,
          service_owner: config.serviceOwner,
          limit: input.limit,
          window_ms: input.windowMs,
          window_start_ms: windowStartMs,
          reset_at_ms: resetAtMs,
          count,
          created_at: new Date(timestamp),
          updated_at: new Date(timestamp),
          expires_at: new Date(resetAtMs + DOCUMENT_TTL_GRACE_MS),
        });
      } else {
        const previous = assertStoredBucket(snapshot.data(), expected);
        count = Math.min(previous + 1, input.limit + 1);
        if (count !== previous) {
          transaction.update(reference, {
            count,
            updated_at: new Date(timestamp),
          });
        }
      }
      return Object.freeze({
        allowed: count <= input.limit,
        remaining: Math.max(0, input.limit - count),
        resetAt: resetAtMs,
      });
    });
    const result = await raceWithAbort(operation, input.signal);
    throwIfAborted(input.signal);
    if (
      !result ||
      typeof result.allowed !== "boolean" ||
      !Number.isSafeInteger(result.remaining) ||
      result.remaining < 0 ||
      result.remaining > input.limit ||
      result.resetAt !== resetAtMs
    ) {
      throw new Error("The shared rate-limit result is invalid.");
    }
    if (!result.allowed) {
      rememberSaturated(documentId, resetAtMs, timestamp);
    }
    return Object.freeze({ ...result });
  }

  return Object.freeze({ verifyReady, consume });
}

export const FIRESTORE_RATE_LIMIT_CONTRACT = Object.freeze({
  projectIds: Object.freeze([...ALLOWED_PROJECTS]),
  serviceDatabases: SERVICE_DATABASES,
  collection: COLLECTION,
  schemaVersion: SCHEMA_VERSION,
  ttlField: "expires_at",
  readinessCacheMs: READINESS_CACHE_MS,
  metadataTimeoutMs: METADATA_TIMEOUT_MS,
  saturatedCacheMax: SATURATED_CACHE_MAX,
  unindexedFields: UNINDEXED_FIELDS,
});
