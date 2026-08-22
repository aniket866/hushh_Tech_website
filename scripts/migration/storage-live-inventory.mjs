#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  STORAGE_CUTOVER_CONTRACT,
  calculateSourceArtifactDigest,
  calculateSourceInventoryDigest,
  normalizeIamBindings,
  parseJsonLines,
  validateCheckpoint,
  validateSourceInventory,
} from "./storage-cutover-contract.mjs";
import {
  MAXIMUM_PRIVATE_INPUT_BYTES,
  calculateSelfBoundDigest,
  canonicalJson,
  contractFileDigestSha256,
  createCrc32c,
  fail,
  isPlainObject,
  readPrivateArtifact,
  readStreamWithDeadline,
  requireExactKeys,
  requireIsoTimestamp,
  requireSha256,
  runCommand,
  runCommandJson,
  safeErrorResult,
  sha256,
  writePrivateArtifact,
} from "./storage-live-common.mjs";
import {
  COPY_POLICY_CANDIDATE,
  assertSafeSourceObjectKey,
  buildMigrationTargetObjectKey,
  copyPolicyCandidateFileDigestSha256,
  validateCopyPolicyCandidate,
} from "./storage-live-policy.mjs";
import { SEVEN_BUCKET_CONTRACT } from "./storage-seven-bucket-contract.mjs";
import {
  ISOLATED_CUTOVER_CONTRACT,
  expectedPreCopyBucketIamBindings,
  isolatedCutoverContractFileDigestSha256,
  validateIsolatedBucketAccessEvidence,
  validateIsolatedCutoverContract,
} from "./storage-isolated-cutover-contract.mjs";

export const SOURCE_COLLECTION_EVIDENCE_SCHEMA =
  "supabase-storage-live-collection-evidence-v1";
export const TARGET_COPY_PREFLIGHT_SCHEMA = "gcs-storage-copy-preflight-v1";
const SOURCE_LIST_PAGE_SIZE = 100;
const MAXIMUM_SOURCE_LIST_ENTRIES = 10_000;
const MAXIMUM_SOURCE_PREFIX_DEPTH = 128;
const MAXIMUM_HTTP_JSON_BYTES = 8_388_608;
const MAXIMUM_OBJECT_BYTES = STORAGE_CUTOVER_CONTRACT.sourceSnapshot.totalBytes;
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const encodeSourceObjectPath = (key) => {
  assertSafeSourceObjectKey(key);
  const encoded = key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  if (/^(?:\.|\.\.)(?:\/|$)/.test(encoded) || /\/(?:\.|\.\.)(?:\/|$)/.test(encoded)) {
    fail("SOURCE_OBJECT_KEY_DOT_SEGMENT", "A source object key escaped into a dot segment.");
  }
  return encoded;
};

const parseBoundedJsonResponse = async (response, code) => {
  const rawDeclaredLength = response.headers.get("content-length");
  const declaredLength = rawDeclaredLength === null ? null : Number(rawDeclaredLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > MAXIMUM_HTTP_JSON_BYTES) {
    await response.body?.cancel();
    fail(code, "A live inventory response exceeded the JSON size limit.");
  }
  if (!response.body) fail(code, "A live inventory response did not include a body.");
  const reader = response.body.getReader();
  const deadlineAt = Date.now() + REQUEST_TIMEOUT_MS;
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await readStreamWithDeadline(
        reader,
        deadlineAt,
        code,
        "A live inventory response exceeded its read deadline.",
      );
      if (done) break;
      const bytes = Buffer.from(value);
      totalBytes += bytes.length;
      if (totalBytes > MAXIMUM_HTTP_JSON_BYTES) {
        await reader.cancel();
        fail(code, "A live inventory response exceeded the JSON size limit.");
      }
      chunks.push(bytes);
    }
  } finally {
    try { reader.releaseLock(); } catch { void 0; }
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "A live inventory response was not valid JSON.");
  }
};

export const hashBoundedObjectResponse = async (
  response,
  expectedBytes,
  maximumBytes = MAXIMUM_OBJECT_BYTES,
  code = "SOURCE_OBJECT_DOWNLOAD_INVALID",
) => {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0
  ) {
    fail(code, "An object response has an invalid byte bound.");
  }
  if (!response.body) fail(code, "An object response did not include a body.");
  const digest = createHash("sha256");
  const md5 = createHash("md5");
  const crc32c = createCrc32c();
  let sizeBytes = 0;
  const reader = response.body.getReader();
  const deadlineAt = Date.now() + REQUEST_TIMEOUT_MS;
  try {
    for (;;) {
      const { done, value } = await readStreamWithDeadline(
        reader,
        deadlineAt,
        code,
        "An object response exceeded its read deadline.",
      );
      if (done) break;
      const bytes = Buffer.from(value);
      sizeBytes += bytes.length;
      if (sizeBytes > Math.min(expectedBytes, maximumBytes)) {
        await reader.cancel();
        fail(code, "An object response exceeded its exact byte bound.");
      }
      digest.update(bytes);
      md5.update(bytes);
      crc32c.update(bytes);
    }
  } finally {
    try { reader.releaseLock(); } catch { void 0; }
  }
  if (sizeBytes !== expectedBytes) {
    fail(code, "An object response did not match its exact byte count.");
  }
  return {
    sizeBytes,
    sha256: digest.digest("hex"),
    md5Base64: md5.digest("base64"),
    crc32cBase64: crc32c.digestBase64(),
  };
};

const requestWithSafeRetry = async (
  fetchImpl,
  url,
  options,
  { attempts = 3, sleepImpl = sleep, code = "LIVE_READ_FAILED" } = {},
) => {
  let lastStatus = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok || response.status === 404) return response;
      lastStatus = response.status;
      if (response.status < 500 && response.status !== 429) break;
    } catch {
      lastStatus = null;
    }
    if (attempt < attempts) await sleepImpl(100 * 2 ** (attempt - 1));
  }
  fail(code, `A read-only provider request failed${lastStatus ? ` with status ${lastStatus}` : ""}.`);
};

export class SupabaseReadOnlyStorageClient {
  constructor({ serviceRoleKey, fetchImpl = fetch, sleepImpl = sleep } = {}) {
    if (typeof serviceRoleKey !== "string" || serviceRoleKey.length < 20) {
      fail("SOURCE_CREDENTIAL_MISSING", "A server-only source credential is required.");
    }
    this.serviceRoleKey = serviceRoleKey;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
    this.baseUrl = `https://${STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef}.supabase.co/storage/v1`;
  }

  async request(path, { method = "GET", body } = {}) {
    const readOnlyGet =
      method === "GET" &&
      (path === "/bucket" || path.startsWith("/object/authenticated/"));
    const readOnlyList = method === "POST" && path.startsWith("/object/list/");
    if (!readOnlyGet && !readOnlyList) {
      fail("SOURCE_MUTATION_BLOCKED", "The source client only permits bucket/object reads and list requests.");
    }
    const requestUrl = new URL(`${this.baseUrl}${path}`);
    const base = new URL(this.baseUrl);
    if (
      requestUrl.origin !== base.origin ||
      !requestUrl.pathname.startsWith(`${base.pathname}/`)
    ) {
      fail("SOURCE_READ_ENDPOINT_BLOCKED", "A source object key escaped the fixed storage endpoint.");
    }
    return requestWithSafeRetry(
      this.fetchImpl,
      requestUrl,
      {
        method,
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      { sleepImpl: this.sleepImpl, code: "SOURCE_READ_FAILED" },
    );
  }

  async listBuckets() {
    const response = await this.request("/bucket");
    if (!response.ok) fail("SOURCE_BUCKET_LIST_FAILED", "Source bucket listing failed.");
    const payload = await parseBoundedJsonResponse(response, "SOURCE_BUCKET_LIST_FAILED");
    if (!Array.isArray(payload)) fail("SOURCE_BUCKET_LIST_INVALID", "Source bucket listing was invalid.");
    return payload;
  }

  async listPage(bucketId, prefix, offset) {
    const response = await this.request(`/object/list/${encodeURIComponent(bucketId)}`, {
      method: "POST",
      body: {
        prefix,
        limit: SOURCE_LIST_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      },
    });
    if (!response.ok) fail("SOURCE_OBJECT_LIST_FAILED", "Source object listing failed.");
    const payload = await parseBoundedJsonResponse(response, "SOURCE_OBJECT_LIST_FAILED");
    if (!Array.isArray(payload)) fail("SOURCE_OBJECT_LIST_INVALID", "Source object listing was invalid.");
    return payload;
  }

  async listObjects(bucketId) {
    const queue = [{ prefix: "", depth: 0 }];
    const visitedPrefixes = new Set();
    const objects = [];
    while (queue.length > 0) {
      const { prefix, depth } = queue.shift();
      if (visitedPrefixes.has(prefix)) fail("SOURCE_PREFIX_CYCLE", "Source folder traversal repeated a prefix.");
      visitedPrefixes.add(prefix);
      if (depth > MAXIMUM_SOURCE_PREFIX_DEPTH) {
        fail("SOURCE_PREFIX_DEPTH_EXCEEDED", "Source folder traversal exceeded its depth bound.");
      }
      for (let offset = 0; ; offset += SOURCE_LIST_PAGE_SIZE) {
        const page = await this.listPage(bucketId, prefix, offset);
        for (const entry of page) {
          if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
            fail("SOURCE_OBJECT_LIST_INVALID", "Source object listing contained an invalid entry.");
          }
          if (/[/\0\r\n]/.test(entry.name)) {
            fail("SOURCE_OBJECT_NAME_INVALID", "Source list entries must be immediate path components.");
          }
          const key = `${prefix}${entry.name}`;
          const isFolder = (entry.id === null || entry.id === undefined) && !entry.metadata;
          if (isFolder) {
            queue.push({ prefix: `${key}/`, depth: depth + 1 });
          } else {
            objects.push({ ...entry, objectKey: key });
          }
          if (objects.length + queue.length > MAXIMUM_SOURCE_LIST_ENTRIES) {
            fail("SOURCE_LIST_LIMIT_EXCEEDED", "Source inventory exceeded its object/folder bound.");
          }
        }
        if (page.length < SOURCE_LIST_PAGE_SIZE) break;
      }
    }
    return objects;
  }

  async hashObject(bucketId, objectKey, expectedBytes) {
    const response = await this.request(
      `/object/authenticated/${encodeURIComponent(bucketId)}/${encodeSourceObjectPath(objectKey)}`,
    );
    if (!response.ok) fail("SOURCE_OBJECT_DOWNLOAD_FAILED", "A source object read failed.");
    const rawDeclaredLength = response.headers.get("content-length");
    const declaredLength = rawDeclaredLength === null ? null : Number(rawDeclaredLength);
    if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength !== expectedBytes) {
      fail("SOURCE_OBJECT_SIZE_CHANGED", "A source object changed size during collection.");
    }
    return hashBoundedObjectResponse(
      response,
      expectedBytes,
      MAXIMUM_OBJECT_BYTES,
      "SOURCE_OBJECT_DOWNLOAD_INVALID",
    );
  }

  async hashSeventhObject(bucketId, objectKey, expectedBytes) {
    if (sha256(bucketId) !== SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256) {
      fail(
        "SEVENTH_SOURCE_BUCKET_IDENTITY_MISMATCH",
        "The higher object cap is restricted to the frozen seventh source bucket.",
      );
    }
    const response = await this.request(
      `/object/authenticated/${encodeURIComponent(bucketId)}/${encodeSourceObjectPath(objectKey)}`,
    );
    if (!response.ok) fail("SEVENTH_SOURCE_OBJECT_DOWNLOAD_FAILED", "A seventh source object read failed.");
    const rawDeclaredLength = response.headers.get("content-length");
    const declaredLength = rawDeclaredLength === null ? null : Number(rawDeclaredLength);
    if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength !== expectedBytes) {
      await response.body?.cancel();
      fail("SEVENTH_SOURCE_OBJECT_SIZE_CHANGED", "A seventh source object changed size during collection.");
    }
    return hashBoundedObjectResponse(
      response,
      expectedBytes,
      Math.min(expectedBytes, SEVEN_BUCKET_CONTRACT.seventh.maximumObjectBytes),
      "SEVENTH_SOURCE_OBJECT_DOWNLOAD_INVALID",
    );
  }
}

export const sourceObjectMetadataRecord = (bucketId, entry) => {
  assertSafeSourceObjectKey(entry.objectKey);
  const metadata = entry.metadata;
  if (!isPlainObject(metadata)) {
    fail("SOURCE_OBJECT_METADATA_MISSING", "A source object has no metadata.");
  }
  const rawSize = metadata.size;
  const sizeBytes = typeof rawSize === "string" && /^\d+$/.test(rawSize)
    ? Number(rawSize)
    : rawSize;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAXIMUM_OBJECT_BYTES) {
    fail("SOURCE_OBJECT_SIZE_INVALID", "A source object has an invalid byte count.");
  }
  const mimeType = metadata.mimetype ?? metadata.mimeType;
  if (
    typeof mimeType !== "string" ||
    mimeType.length === 0 ||
    mimeType.length > 512 ||
    /[\0\r\n]/.test(mimeType)
  ) {
    fail("SOURCE_OBJECT_MIME_INVALID", "A source object has invalid MIME metadata.");
  }
  const sourceUpdatedAt = entry.updated_at ?? entry.updatedAt;
  requireIsoTimestamp(sourceUpdatedAt, "SOURCE_OBJECT_TIMESTAMP_INVALID", "source update time");
  const rawCacheControl = metadata.cacheControl ?? metadata.cache_control ?? null;
  const cacheControl = rawCacheControl === null || rawCacheControl === undefined
    ? null
    : String(rawCacheControl);
  if (cacheControl !== null && (cacheControl.length > 1024 || /[\r\n\0]/.test(cacheControl))) {
    fail("SOURCE_OBJECT_CACHE_INVALID", "A source object has unsafe cache metadata.");
  }
  return {
    recordType: "sourceObject",
    bucketId,
    objectKey: entry.objectKey,
    sizeBytes,
    mimeType,
    sourceUpdatedAt,
    cacheControl,
  };
};

const metadataFingerprint = (records) => sha256(canonicalJson(
  records
    .map((record) => ({ ...record }))
    .sort((left, right) => `${left.bucketId}\0${left.objectKey}`.localeCompare(`${right.bucketId}\0${right.objectKey}`)),
));

const assertExactSourceBucketSet = (liveBuckets) => {
  const expected = STORAGE_CUTOVER_CONTRACT.buckets;
  if (liveBuckets.length !== expected.length) {
    fail("SOURCE_BUCKET_SET_DRIFT", "The live source bucket count changed.");
  }
  const byId = new Map();
  for (const bucket of liveBuckets) {
    const bucketId = bucket.id ?? bucket.name;
    if (typeof bucketId !== "string" || byId.has(bucketId)) {
      fail("SOURCE_BUCKET_SET_DRIFT", "The live source bucket set is invalid.");
    }
    byId.set(bucketId, bucket);
  }
  for (const expectedBucket of expected) {
    const live = byId.get(expectedBucket.sourceBucket);
    if (!live || live.public !== expectedBucket.sourcePublic) {
      fail("SOURCE_BUCKET_SET_DRIFT", "A live source bucket or public state changed.");
    }
  }
  if ([...byId.keys()].some((bucketId) => !expected.some((entry) => entry.sourceBucket === bucketId))) {
    fail("SOURCE_BUCKET_SET_DRIFT", "The live source includes an unknown bucket.");
  }
};

export const collectLiveSourceInventory = async ({
  sourceClient,
  collectedAt = new Date().toISOString(),
  exportRunId = `source-live-${randomUUID()}`,
  previousCheckpoint = null,
  previousCheckpointFileDigestSha256 = null,
} = {}) => {
  validateCopyPolicyCandidate();
  requireIsoTimestamp(collectedAt, "SOURCE_COLLECTION_TIME_INVALID", "collection time");
  const checkpoint = previousCheckpoint === null ? null : validateCheckpoint(previousCheckpoint);
  if (
    (checkpoint === null && previousCheckpointFileDigestSha256 !== null) ||
    (checkpoint !== null && !/^[a-f0-9]{64}$/.test(previousCheckpointFileDigestSha256 || ""))
  ) {
    fail("SOURCE_CHECKPOINT_BINDING_INVALID", "Source delta collection requires the exact prior checkpoint file digest.");
  }
  if (checkpoint && Date.parse(collectedAt) <= Date.parse(checkpoint.sourceFrozenAt)) {
    fail("SOURCE_DELTA_TIME_INVALID", "Source delta collection time must follow the prior checkpoint.");
  }
  const liveBuckets = await sourceClient.listBuckets();
  assertExactSourceBucketSet(liveBuckets);
  const firstMetadata = [];
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const listed = await sourceClient.listObjects(bucket.sourceBucket);
    firstMetadata.push(...listed.map((entry) => sourceObjectMetadataRecord(bucket.sourceBucket, entry)));
  }
  const seenKeys = new Set();
  for (const record of firstMetadata) {
    const identity = `${record.bucketId}\0${record.objectKey}`;
    if (seenKeys.has(identity)) fail("DUPLICATE_SOURCE_OBJECT", "The live source returned a duplicate object.");
    seenKeys.add(identity);
  }
  const sourceObjects = [];
  for (const metadata of firstMetadata) {
    const hashed = await sourceClient.hashObject(
      metadata.bucketId,
      metadata.objectKey,
      metadata.sizeBytes,
    );
    if (
      hashed.sizeBytes !== metadata.sizeBytes ||
      !/^[a-f0-9]{64}$/.test(hashed.sha256 || "")
    ) {
      fail("SOURCE_OBJECT_DOWNLOAD_INVALID", "A source object hash result did not match its exact metadata bound.");
    }
    sourceObjects.push({ ...metadata, sha256: hashed.sha256 });
  }
  const secondMetadata = [];
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const listed = await sourceClient.listObjects(bucket.sourceBucket);
    secondMetadata.push(...listed.map((entry) => sourceObjectMetadataRecord(bucket.sourceBucket, entry)));
  }
  if (metadataFingerprint(firstMetadata) !== metadataFingerprint(secondMetadata)) {
    fail("SOURCE_CHANGED_DURING_COLLECTION", "The source changed during its read-only collection window.");
  }

  const bucketRecords = STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => {
    const objects = sourceObjects.filter((object) => object.bucketId === bucket.sourceBucket);
    return {
      recordType: "sourceBucket",
      bucketId: bucket.sourceBucket,
      public: bucket.sourcePublic,
      objectCount: objects.length,
      totalBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0),
    };
  });
  const orderedObjects = [...sourceObjects].sort((left, right) =>
    `${left.bucketId}\0${left.objectKey}`.localeCompare(`${right.bucketId}\0${right.objectKey}`),
  );
  const currentObjectIds = new Set(orderedObjects.map((object) => sourceObjectId(object)));
  const newlyDeletedEntries = checkpoint
    ? checkpoint.entries.filter((entry) => !currentObjectIds.has(entry.objectId))
    : [];
  const deltaEvidenceDigestSha256 = checkpoint
    ? sha256(canonicalJson({
        schemaVersion: "supabase-storage-read-only-delta-evidence-v1",
        collectedAt,
        exportRunId,
        previousCheckpointFileDigestSha256,
        previousCheckpointDigestSha256: checkpoint.checkpointDigestSha256,
        firstMetadataDigestSha256: metadataFingerprint(firstMetadata),
        secondMetadataDigestSha256: metadataFingerprint(secondMetadata),
        currentObjectVersions: orderedObjects.map((object) => ({
          objectId: sourceObjectId(object),
          sourceFingerprintSha256: sha256(canonicalJson({
            bucketId: object.bucketId,
            objectKey: object.objectKey,
            sizeBytes: object.sizeBytes,
            mimeType: object.mimeType,
            sourceUpdatedAt: object.sourceUpdatedAt,
            cacheControl: object.cacheControl,
            sha256: object.sha256,
          })),
        })),
        deletedObjectIds: newlyDeletedEntries.map((entry) => entry.objectId).sort(),
      }))
    : null;
  const header = {
    recordType: "sourceInventory",
    schemaVersion: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.inventorySchema,
    snapshotKind: checkpoint ? "RECORDED_DELTA" : "FROZEN_BASELINE",
    sourceProjectRef: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef,
    frozenAt: checkpoint ? collectedAt : STORAGE_CUTOVER_CONTRACT.frozenAt,
    snapshotSequence: checkpoint ? checkpoint.snapshotSequence + 1 : 0,
    exportRunId,
    bucketCount: bucketRecords.length,
    objectCount: sourceObjects.length,
    totalBytes: sourceObjects.reduce((sum, object) => sum + object.sizeBytes, 0),
    tombstoneCount: newlyDeletedEntries.length,
    deltaEvidenceDigestSha256,
    previousCheckpointDigestSha256: checkpoint?.checkpointDigestSha256 ?? null,
    previousSourceInventoryDigestSha256: checkpoint?.sourceInventoryDigestSha256 ?? null,
    previousSourceArtifactDigestSha256: checkpoint?.sourceArtifactDigestSha256 ?? null,
    previousDeltaEvidenceDigestSha256: checkpoint?.deltaEvidenceDigestSha256 ?? null,
    inventoryDigestSha256: "0".repeat(64),
    sourceArtifactDigestSha256: "0".repeat(64),
  };
  const tombstones = newlyDeletedEntries.map((entry) => ({
    recordType: "sourceTombstone",
    objectId: entry.objectId,
    priorSourceFingerprintSha256: entry.sourceFingerprintSha256,
    deletedAt: collectedAt,
    deletionReason: "Absent from stable two-pass read-only source relist.",
    previousSourceInventoryDigestSha256: checkpoint.sourceInventoryDigestSha256,
    deltaEvidenceDigestSha256,
    sourceArtifactDigestSha256: "0".repeat(64),
  })).sort((left, right) => left.objectId.localeCompare(right.objectId));
  const records = [header, ...bucketRecords, ...orderedObjects, ...tombstones];
  header.inventoryDigestSha256 = calculateSourceInventoryDigest(records);
  header.sourceArtifactDigestSha256 = calculateSourceArtifactDigest(records);
  for (const tombstone of tombstones) {
    tombstone.sourceArtifactDigestSha256 = header.sourceArtifactDigestSha256;
  }
  const validated = validateSourceInventory(records, { previousCheckpoint });
  const jsonLines = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const evidence = {
    schemaVersion: SOURCE_COLLECTION_EVIDENCE_SCHEMA,
    collectedAt,
    sourceProjectRefSha256: sha256(STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef),
    contractFileDigestSha256: contractFileDigestSha256(),
    copyPolicyCandidateFileDigestSha256: copyPolicyCandidateFileDigestSha256(),
    sourceInventoryDigestSha256: validated.digestSha256,
    sourceArtifactDigestSha256: validated.sourceArtifactDigestSha256,
    sourceInventoryFileDigestSha256: sha256(jsonLines),
    snapshotKind: validated.snapshotKind,
    snapshotSequence: validated.snapshotSequence,
    previousCheckpointFileDigestSha256,
    previousCheckpointDigestSha256: checkpoint?.checkpointDigestSha256 ?? null,
    bucketCount: validated.bucketRecords.length,
    objectCount: validated.objectCount,
    totalBytes: validated.totalBytes,
    tombstoneCount: validated.tombstones.length,
    dispositionCount: validated.objectCount + validated.tombstones.length,
    readOnlyMethods: ["GET", "POST_LIST_ONLY"],
    sourceMutationAllowed: false,
    evidenceDigestSha256: null,
  };
  evidence.evidenceDigestSha256 = calculateSelfBoundDigest(evidence, "evidenceDigestSha256");
  return { records, jsonLines, evidence };
};

const normalizePolicyBindings = (bindings = []) => bindings.map((binding) => ({
  role: binding.role,
  members: [...(binding.members || [])].sort(),
  conditionDigestSha256: binding.conditionDigestSha256 ??
    (binding.condition ? sha256(canonicalJson(binding.condition)) : null),
  ...(binding.scope ? { scope: binding.scope } : {}),
})).sort((left, right) => `${left.scope || ""}\0${left.role}\0${left.conditionDigestSha256 || ""}`.localeCompare(`${right.scope || ""}\0${right.role}\0${right.conditionDigestSha256 || ""}`));

const mergeSimpleBindings = (bindings) => {
  const roles = new Map();
  for (const binding of bindings) {
    if (binding.conditionDigestSha256 !== null) continue;
    const members = roles.get(binding.role) || new Set();
    for (const member of binding.members) members.add(member);
    roles.set(binding.role, members);
  }
  return [...roles.entries()].map(([role, members]) => ({
    role,
    members: [...members].sort(),
  })).sort((left, right) => left.role.localeCompare(right.role));
};

const isStorageRoleName = (role) =>
  ["roles/owner", "roles/editor", "roles/viewer"].includes(role) ||
  role.includes("legacy") ||
  role.startsWith("roles/storage.");

export class GoogleCloudReadOnlyStorageClient {
  constructor({ project = "hushh-tech-uat", fetchImpl = fetch } = {}) {
    if (project !== "hushh-tech-uat") fail("TARGET_PROJECT_BLOCKED", "Only hushh-tech-uat reads are allowed.");
    this.project = project;
    this.fetchImpl = fetchImpl;
    this.roleCache = new Map();
    this.roleDefinitionCache = new Map();
    this.accessToken = null;
    this.inheritedPolicyCache = null;
    this.isolationDenyPolicyCache = null;
  }

  token() {
    if (!this.accessToken) {
      const token = runCommand("gcloud", ["auth", "print-access-token"]).trim();
      if (typeof token !== "string" || token.length < 20) {
        fail("GCP_READ_CREDENTIAL_MISSING", "Google Cloud read credentials are unavailable.");
      }
      this.accessToken = token;
    }
    return this.accessToken;
  }

  async getJson(url, code) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "storage.googleapis.com") {
      fail("GCP_READ_ENDPOINT_BLOCKED", "Only the Google Cloud Storage JSON API is allowed.");
    }
    const response = await requestWithSafeRetry(
      this.fetchImpl,
      parsed,
      { method: "GET", headers: { authorization: `Bearer ${this.token()}` } },
      { code },
    );
    if (!response.ok) fail(code, "A Google Cloud read failed.");
    return parseBoundedJsonResponse(response, code);
  }

  async getBucket(bucketName) {
    return this.getJson(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}?projection=full`,
      "TARGET_BUCKET_READ_FAILED",
    );
  }

  async getBucketIam(bucketName) {
    return this.getJson(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/iam`,
      "TARGET_IAM_READ_FAILED",
    );
  }

  async listObjects(bucketName) {
    const objects = [];
    let pageToken = null;
    const visitedPageTokens = new Set();
    do {
      if (pageToken !== null) {
        if (
          typeof pageToken !== "string" ||
          pageToken.length === 0 ||
          pageToken.length > 4_096 ||
          /[\0\r\n]/.test(pageToken) ||
          visitedPageTokens.has(pageToken)
        ) {
          fail("TARGET_OBJECT_PAGE_TOKEN_INVALID", "Target object pagination returned an unsafe token.");
        }
        visitedPageTokens.add(pageToken);
      }
      const url = new URL(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o`,
      );
      url.searchParams.set("maxResults", "1000");
      url.searchParams.set("projection", "full");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const payload = await this.getJson(url, "TARGET_OBJECT_LIST_FAILED");
      if (payload.items !== undefined && !Array.isArray(payload.items)) {
        fail("TARGET_OBJECT_LIST_INVALID", "Google Cloud returned an invalid object list.");
      }
      objects.push(...(payload.items || []));
      if (objects.length > 100_000) fail("TARGET_OBJECT_LIST_LIMIT", "Target object listing exceeded its safety bound.");
      pageToken = payload.nextPageToken ?? null;
    } while (pageToken);
    return objects;
  }

  async hashObject(bucketName, object) {
    const url = new URL(
      `https://storage.googleapis.com/download/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(object.name)}`,
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", object.generation);
    const response = await requestWithSafeRetry(
      this.fetchImpl,
      url,
      { method: "GET", headers: { authorization: `Bearer ${this.token()}` } },
      { code: "TARGET_OBJECT_READ_FAILED" },
    );
    if (!response.ok) fail("TARGET_OBJECT_READ_FAILED", "A target object read failed.");
    return hashBoundedObjectResponse(
      response,
      Number(object.size),
      MAXIMUM_OBJECT_BYTES,
      "TARGET_OBJECT_READ_INVALID",
    );
  }

  projectAndAncestorPolicies() {
    if (this.inheritedPolicyCache) return this.inheritedPolicyCache;
    const policies = [{
      scope: `projects/${this.project}`,
      policy: runCommandJson("gcloud", [
        "projects",
        "get-iam-policy",
        this.project,
        "--format=json",
      ]),
    }];
    const ancestors = runCommandJson("gcloud", [
      "projects",
      "get-ancestors",
      this.project,
      "--format=json",
    ]);
    for (const ancestor of ancestors) {
      if (ancestor.type === "folder") {
        policies.push({
          scope: `folders/${ancestor.id}`,
          policy: runCommandJson("gcloud", [
            "resource-manager",
            "folders",
            "get-iam-policy",
            String(ancestor.id),
            "--format=json",
          ]),
        });
      } else if (ancestor.type === "organization") {
        policies.push({
          scope: `organizations/${ancestor.id}`,
          policy: runCommandJson("gcloud", [
            "organizations",
            "get-iam-policy",
            String(ancestor.id),
            "--format=json",
          ]),
        });
      }
    }
    this.inheritedPolicyCache = policies;
    return policies;
  }

  roleDefinition(role) {
    if (this.roleDefinitionCache.has(role)) return this.roleDefinitionCache.get(role);
    let args;
    if (role.startsWith("projects/")) {
      const [, project, , roleName] = role.split("/");
      args = ["iam", "roles", "describe", roleName, `--project=${project}`, "--format=json"];
    } else if (role.startsWith("organizations/")) {
      const [, organization, , roleName] = role.split("/");
      args = ["iam", "roles", "describe", roleName, `--organization=${organization}`, "--format=json"];
    } else {
      args = ["iam", "roles", "describe", role, "--format=json"];
    }
    const description = runCommandJson("gcloud", args);
    if (!Array.isArray(description.includedPermissions)) {
      fail("TARGET_IAM_ROLE_UNRESOLVED", "A target IAM role could not be resolved safely.");
    }
    const definition = {
      includedPermissions: [...description.includedPermissions].sort(),
    };
    this.roleDefinitionCache.set(role, definition);
    return definition;
  }

  roleIncludesStorage(role) {
    if (isStorageRoleName(role)) return true;
    if (this.roleCache.has(role)) return this.roleCache.get(role);
    const description = this.roleDefinition(role);
    const relevant = description.includedPermissions.some((permission) =>
      permission.startsWith("storage."),
    );
    this.roleCache.set(role, relevant);
    return relevant;
  }

  inspectIam(bucketPolicy) {
    const bucketBindings = normalizePolicyBindings(bucketPolicy.bindings || []);
    const inheritedBindings = [];
    for (const { scope, policy } of this.projectAndAncestorPolicies()) {
      for (const binding of normalizePolicyBindings(policy.bindings || [])) {
        if (!this.roleIncludesStorage(binding.role)) continue;
        if (binding.role === ISOLATED_CUTOVER_CONTRACT.inspectorRole) {
          const definition = this.roleDefinition(binding.role);
          inheritedBindings.push({
            ...binding,
            scope,
            roleIncludedPermissions: definition.includedPermissions,
            rolePermissionDigestSha256: sha256(canonicalJson(definition.includedPermissions)),
          });
        } else {
          inheritedBindings.push({ ...binding, scope });
        }
      }
    }
    return { bucketBindings, inheritedBindings };
  }

  inspectIsolation(bucketName, inheritedBindings) {
    validateIsolatedCutoverContract();
    const tagBindings = runCommandJson("gcloud", [
      "resource-manager",
      "tags",
      "bindings",
      "list",
      `--parent=//storage.googleapis.com/projects/_/buckets/${bucketName}`,
      "--location=us-central1",
      "--format=json",
    ]);
    if (!this.isolationDenyPolicyCache) {
      this.isolationDenyPolicyCache = runCommandJson("gcloud", [
        "iam",
        "policies",
        "get",
        ISOLATED_CUTOVER_CONTRACT.denyPolicyId,
        `--attachment-point=cloudresourcemanager.googleapis.com/projects/${ISOLATED_CUTOVER_CONTRACT.projectNumber}`,
        "--kind=denypolicies",
        "--format=json",
      ]);
    }
    return validateIsolatedBucketAccessEvidence({
      bucketName,
      tagBindings,
      denyPolicy: this.isolationDenyPolicyCache,
      inheritedBindings,
    });
  }
}

export const sourceObjectId = (sourceObject) =>
  sha256(`${sourceObject.bucketId}\0${sourceObject.objectKey}`);

export const buildExpectedTargetMetadata = (sourceObject) => {
  const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
    (entry) => entry.sourceBucket === sourceObject.bucketId,
  );
  if (!bucket) fail("UNKNOWN_SOURCE_BUCKET", "A target metadata record uses an unknown bucket.");
  const metadata = {
    "hushh-migration-schema": "supabase-cutover-v1",
    "hushh-source-bucket": sourceObject.bucketId,
    "hushh-source-object-id": sourceObjectId(sourceObject),
    "hushh-source-fingerprint": sourceObject.fingerprint,
    "hushh-source-object-key-b64": Buffer.from(sourceObject.objectKey, "utf8").toString("base64"),
    "hushh-source-sha256": sourceObject.sha256,
    "hushh-source-updated-at": sourceObject.sourceUpdatedAt,
    "hushh-source-cache-control-b64": sourceObject.cacheControl === null
      ? "-"
      : Buffer.from(sourceObject.cacheControl, "utf8").toString("base64"),
    "hushh-access-mode": bucket.targetAccessMode,
  };
  if (Buffer.byteLength(canonicalJson(metadata)) > 7_000) {
    fail("TARGET_METADATA_TOO_LARGE", "Target provenance metadata exceeds its safety bound.");
  }
  return metadata;
};

const decodeStrictBase64 = (value, code, label) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    fail(code, `${label} is not bounded base64 text.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(code, `${label} is not canonical base64.`);
  return bytes.toString("utf8");
};

const parseVersionedMigrationName = (bucket, objectName) => {
  const prefix = `${COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace}/${bucket.sourceBucket}/`;
  if (!objectName.startsWith(prefix)) {
    fail("TARGET_MIGRATION_NAMESPACE_OCCUPIED", "A migration object is stored under the wrong bucket namespace.");
  }
  const suffix = objectName.slice(prefix.length);
  const match = /^([a-f0-9]{64})\/([a-f0-9]{64})$/.exec(suffix);
  if (!match) {
    fail("TARGET_MIGRATION_NAMESPACE_OCCUPIED", "A migration object name does not match the immutable versioned schema.");
  }
  return { objectId: match[1], sourceFingerprintSha256: match[2] };
};

export const verifyRetainedHistoricalTargetObject = async (
  gcsClient,
  bucket,
  targetObject,
  allowedObjectIds,
) => {
  const parsed = parseVersionedMigrationName(bucket, targetObject.name);
  if (!allowedObjectIds.has(parsed.objectId)) {
    fail("TARGET_MIGRATION_NAMESPACE_OCCUPIED", "A migration object has no live object or typed tombstone.");
  }
  const metadata = targetObject.metadata;
  requireExactKeys(
    metadata,
    [
      "hushh-migration-schema",
      "hushh-source-bucket",
      "hushh-source-object-id",
      "hushh-source-fingerprint",
      "hushh-source-object-key-b64",
      "hushh-source-sha256",
      "hushh-source-updated-at",
      "hushh-source-cache-control-b64",
      "hushh-access-mode",
    ],
    "TARGET_RETAINED_VERSION_INVALID",
    "retained target metadata",
  );
  const objectKey = decodeStrictBase64(
    metadata["hushh-source-object-key-b64"],
    "TARGET_RETAINED_VERSION_INVALID",
    "retained source key",
  );
  assertSafeSourceObjectKey(objectKey);
  const sizeBytes = Number(targetObject.size);
  const sourceCacheControl = metadata["hushh-source-cache-control-b64"] === "-"
    ? null
    : decodeStrictBase64(
        metadata["hushh-source-cache-control-b64"],
        "TARGET_RETAINED_VERSION_INVALID",
        "retained cache provenance",
      );
  requireIsoTimestamp(
    metadata["hushh-source-updated-at"],
    "TARGET_RETAINED_VERSION_INVALID",
    "retained source update time",
  );
  for (const field of [
    "hushh-source-object-id",
    "hushh-source-fingerprint",
    "hushh-source-sha256",
  ]) {
    requireSha256(metadata[field], "TARGET_RETAINED_VERSION_INVALID", field);
  }
  const recomputedFingerprint = sha256(canonicalJson({
    bucketId: bucket.sourceBucket,
    objectKey,
    sizeBytes,
    mimeType: targetObject.contentType,
    sourceUpdatedAt: metadata["hushh-source-updated-at"],
    cacheControl: sourceCacheControl,
    sha256: metadata["hushh-source-sha256"],
  }));
  if (
    targetObject.bucket !== bucket.targetBucket ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    targetObject.cacheControl !== bucket.targetServingCacheControl ||
    typeof targetObject.contentType !== "string" ||
    !/^[1-9]\d*$/.test(targetObject.generation || "") ||
    !/^[A-Za-z0-9+/]{6}==$/.test(targetObject.crc32c || "") ||
    !/^[A-Za-z0-9+/]{22}==$/.test(targetObject.md5Hash || "") ||
    metadata["hushh-migration-schema"] !== "supabase-cutover-v1" ||
    metadata["hushh-source-bucket"] !== bucket.sourceBucket ||
    metadata["hushh-source-object-id"] !== parsed.objectId ||
    metadata["hushh-source-object-id"] !== sourceObjectId({ bucketId: bucket.sourceBucket, objectKey }) ||
    metadata["hushh-source-fingerprint"] !== parsed.sourceFingerprintSha256 ||
    recomputedFingerprint !== parsed.sourceFingerprintSha256 ||
    metadata["hushh-access-mode"] !== bucket.targetAccessMode
  ) {
    fail("TARGET_RETAINED_VERSION_INVALID", "A retained immutable target version failed provenance checks.");
  }
  const hashed = await gcsClient.hashObject(bucket.targetBucket, targetObject);
  if (
    hashed.sizeBytes !== sizeBytes ||
    hashed.sha256 !== metadata["hushh-source-sha256"] ||
    hashed.crc32cBase64 !== targetObject.crc32c ||
    hashed.md5Base64 !== targetObject.md5Hash
  ) {
    fail("TARGET_RETAINED_VERSION_INVALID", "A retained immutable target version failed byte checks.");
  }
  return {
    objectId: parsed.objectId,
    sourceBucket: bucket.sourceBucket,
    sourceFingerprintSha256: parsed.sourceFingerprintSha256,
    targetBucket: bucket.targetBucket,
    targetObjectKeyDigestSha256: sha256(targetObject.name),
    generation: targetObject.generation,
    sizeBytes,
    sha256: hashed.sha256,
    crc32cBase64: hashed.crc32cBase64,
    md5Hash: hashed.md5Base64,
    targetMetadataDigestSha256: sha256(canonicalJson(metadata)),
  };
};

export const verifyExistingTargetObject = async (
  gcsClient,
  sourceObject,
  sourceInventory,
  targetObject,
) => {
  const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
    (entry) => entry.sourceBucket === sourceObject.bucketId,
  );
  const expectedMetadata = buildExpectedTargetMetadata(sourceObject, sourceInventory);
  const exact =
    targetObject.name === buildMigrationTargetObjectKey(
      sourceObject.bucketId,
      sourceObject.objectKey,
      sourceObject.fingerprint,
    ) &&
    targetObject.bucket === bucket.targetBucket &&
    targetObject.contentType === sourceObject.mimeType &&
    targetObject.cacheControl === bucket.targetServingCacheControl &&
    Number(targetObject.size) === sourceObject.sizeBytes &&
    /^[1-9]\d*$/.test(targetObject.generation || "") &&
    /^[A-Za-z0-9+/]{6}==$/.test(targetObject.crc32c || "") &&
    /^[A-Za-z0-9+/]{22}==$/.test(targetObject.md5Hash || "") &&
    canonicalJson(targetObject.metadata || {}) === canonicalJson(expectedMetadata);
  if (!exact) fail("TARGET_PREEXISTING_COLLISION", "A migration target key is occupied by non-matching data.");
  const hashed = await gcsClient.hashObject(bucket.targetBucket, targetObject);
  if (
    hashed.sha256 !== sourceObject.sha256 ||
    hashed.crc32cBase64 !== targetObject.crc32c ||
    hashed.md5Base64 !== targetObject.md5Hash
  ) {
    fail("TARGET_PREEXISTING_COLLISION", "A migration target object hash does not match its source.");
  }
  return {
    state: "PRESENT_EXACT",
    generation: targetObject.generation,
    verifiedSha256: hashed.sha256,
    verifiedCrc32c: hashed.crc32cBase64,
    verifiedMd5Hash: hashed.md5Base64,
    targetMetadataDigestSha256: sha256(canonicalJson(expectedMetadata)),
  };
};

export const collectLiveTargetPreflight = async ({
  gcsClient,
  sourceRecords,
  previousCheckpoint = null,
  previousCheckpointFileDigestSha256 = null,
  collectedAt = new Date().toISOString(),
} = {}) => {
  validateCopyPolicyCandidate();
  validateIsolatedCutoverContract();
  requireIsoTimestamp(collectedAt, "TARGET_COLLECTION_TIME_INVALID", "target collection time");
  const source = validateSourceInventory(sourceRecords, { previousCheckpoint });
  if (typeof gcsClient?.roleDefinition !== "function") {
    fail(
      "TARGET_MIGRATION_WRITER_ROLE_UNRESOLVED",
      "The exact migration writer role definition is unavailable.",
    );
  }
  const migrationWriterRoleDefinition = gcsClient.roleDefinition(
    ISOLATED_CUTOVER_CONTRACT.migrationWriterRole,
  );
  const migrationWriterRolePermissions = [
    ...(migrationWriterRoleDefinition?.includedPermissions || []),
  ].sort();
  const migrationWriterRoleExact =
    canonicalJson(migrationWriterRolePermissions) ===
    canonicalJson(ISOLATED_CUTOVER_CONTRACT.migrationWriterPermissions);
  const migrationWriterRolePermissionDigestSha256 = sha256(
    canonicalJson(migrationWriterRolePermissions),
  );
  source.previousCheckpointFileDigestSha256 = previousCheckpointFileDigestSha256;
  if (
    (source.snapshotKind === "RECORDED_DELTA" &&
      !/^[a-f0-9]{64}$/.test(previousCheckpointFileDigestSha256 || "")) ||
    (source.snapshotKind === "FROZEN_BASELINE" &&
      (previousCheckpoint !== null || previousCheckpointFileDigestSha256 !== null))
  ) {
    fail("TARGET_CHECKPOINT_BINDING_INVALID", "Target preflight checkpoint binding does not match the source snapshot.");
  }
  const expectedByBucket = new Map(
    STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => [bucket.targetBucket, []]),
  );
  for (const object of source.objects) {
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === object.bucketId,
    );
    expectedByBucket.get(bucket.targetBucket).push(object);
  }
  const bucketEvidence = [];
  const objectEvidence = [];
  let totalUnmanagedObjects = 0;
  let totalUnmanagedBytes = 0;
  let existingMigrationObjects = 0;
  const retainedHistoricalObjects = [];
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const [configuration, bucketPolicy, liveObjects] = await Promise.all([
      gcsClient.getBucket(bucket.targetBucket),
      gcsClient.getBucketIam(bucket.targetBucket),
      gcsClient.listObjects(bucket.targetBucket),
    ]);
    const iam = await gcsClient.inspectIam(bucketPolicy);
    const isolation = await gcsClient.inspectIsolation(
      bucket.targetBucket,
      iam.inheritedBindings,
    );
    const expectedObjects = expectedByBucket.get(bucket.targetBucket);
    const expectedTargetNames = new Map(expectedObjects.map((sourceObject) => [
      buildMigrationTargetObjectKey(
        sourceObject.bucketId,
        sourceObject.objectKey,
        sourceObject.fingerprint,
      ),
      sourceObject,
    ]));
    const allowedHistoricalObjectIds = new Set([
      ...source.objects.map((object) => sourceObjectId(object)),
      ...source.tombstones.map((tombstone) => tombstone.objectId),
    ]);
    const byName = new Map();
    for (const object of liveObjects) {
      if (!isPlainObject(object) || typeof object.name !== "string" || byName.has(object.name)) {
        fail("TARGET_OBJECT_LIST_INVALID", "Target object listing contains an invalid or duplicate name.");
      }
      byName.set(object.name, object);
    }
    const namespacePrefix = `${COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace}/`;
    const historicalCandidates = liveObjects.filter(
      (object) => object.name.startsWith(namespacePrefix) && !expectedTargetNames.has(object.name),
    );
    const bucketHistoricalObjects = [];
    for (const object of historicalCandidates) {
      bucketHistoricalObjects.push(await verifyRetainedHistoricalTargetObject(
        gcsClient,
        bucket,
        object,
        allowedHistoricalObjectIds,
      ));
    }
    retainedHistoricalObjects.push(...bucketHistoricalObjects);
    const unmanaged = liveObjects.filter((object) => !object.name.startsWith(namespacePrefix));
    const unmanagedBytes = unmanaged.reduce((sum, object) => {
      const size = Number(object.size);
      if (!Number.isSafeInteger(size) || size < 0) fail("TARGET_OBJECT_SIZE_INVALID", "Target object size is invalid.");
      const next = sum + size;
      if (!Number.isSafeInteger(next)) fail("TARGET_OBJECT_SIZE_INVALID", "Target object totals exceed the safe integer bound.");
      return next;
    }, 0);
    totalUnmanagedObjects += unmanaged.length;
    totalUnmanagedBytes += unmanagedBytes;
    if (!Number.isSafeInteger(totalUnmanagedObjects) || !Number.isSafeInteger(totalUnmanagedBytes)) {
      fail("TARGET_OBJECT_SIZE_INVALID", "Target object aggregates exceed the safe integer bound.");
    }
    const unmanagedDigestSha256 = sha256(canonicalJson(unmanaged.map((object) => ({
      nameSha256: sha256(object.name),
      generation: object.generation,
      size: object.size,
    })).sort((left, right) => left.nameSha256.localeCompare(right.nameSha256))));
    for (const sourceObject of expectedObjects) {
      const objectId = sourceObjectId(sourceObject);
      const targetKey = buildMigrationTargetObjectKey(
        sourceObject.bucketId,
        sourceObject.objectKey,
        sourceObject.fingerprint,
      );
      const existing = byName.get(targetKey);
      const state = existing
        ? await verifyExistingTargetObject(gcsClient, sourceObject, source, existing)
        : {
            state: "ABSENT",
            generation: null,
            verifiedSha256: null,
            verifiedCrc32c: null,
            verifiedMd5Hash: null,
            targetMetadataDigestSha256: sha256(canonicalJson(
              buildExpectedTargetMetadata(sourceObject, source),
            )),
          };
      if (state.state === "PRESENT_EXACT") existingMigrationObjects += 1;
      objectEvidence.push({
        objectId,
        targetBucket: bucket.targetBucket,
        targetObjectKeyDigestSha256: sha256(targetKey),
        expectedBytes: sourceObject.sizeBytes,
        expectedSha256: sourceObject.sha256,
        ...state,
      });
    }
    const bucketBindings = normalizePolicyBindings(iam.bucketBindings);
    const inheritedBindings = normalizePolicyBindings(iam.inheritedBindings);
    const noBucketConditions = bucketBindings.every(
      (binding) => binding.conditionDigestSha256 === null,
    );
    const simpleBucketBindings = mergeSimpleBindings(bucketBindings);
    const prohibitedPreCopyPrincipals = new Set(
      ISOLATED_CUTOVER_CONTRACT.prohibitedPreCopyBucketPrincipals,
    );
    const prohibitedPreCopyBucketPrincipalCount = bucketBindings
      .flatMap((binding) => binding.members)
      .filter((member) => prohibitedPreCopyPrincipals.has(member)).length;
    const iamMatchesFrozenAllowlist =
      noBucketConditions &&
      canonicalJson(normalizeIamBindings(simpleBucketBindings)) ===
        canonicalJson(normalizeIamBindings(expectedPreCopyBucketIamBindings())) &&
      prohibitedPreCopyBucketPrincipalCount === 0 &&
      migrationWriterRoleExact &&
      isolation.isolationSafe === true &&
      isolation.inheritedAccessNeutralized === true;
    const publicIamMemberCount = [...bucketBindings, ...inheritedBindings]
      .flatMap((binding) => binding.members)
      .filter((member) => ["allUsers", "allAuthenticatedUsers"].includes(member)).length;
    const bucketConfigurationSafe =
      configuration.location === STORAGE_CUTOVER_CONTRACT.targetPolicy.bucketLocation &&
      configuration.storageClass === ISOLATED_CUTOVER_CONTRACT.storageClass &&
      configuration.iamConfiguration?.uniformBucketLevelAccess?.enabled === true &&
      configuration.iamConfiguration?.publicAccessPrevention === "enforced" &&
      configuration.versioning?.enabled === true &&
      Number(configuration.retentionPolicy?.retentionPeriod) ===
        ISOLATED_CUTOVER_CONTRACT.retentionPeriodSeconds &&
      configuration.retentionPolicy?.isLocked !== true &&
      Number(configuration.softDeletePolicy?.retentionDurationSeconds) ===
        ISOLATED_CUTOVER_CONTRACT.softDeleteRetentionSeconds &&
      publicIamMemberCount === 0;
    bucketEvidence.push({
      bucketName: bucket.targetBucket,
      bucketConfigurationSafe,
      iamMatchesFrozenAllowlist,
      location: configuration.location ?? null,
      storageClass: configuration.storageClass ?? null,
      uniformBucketLevelAccess:
        configuration.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
      publicAccessPrevention:
        configuration.iamConfiguration?.publicAccessPrevention ?? null,
      versioningEnabled: configuration.versioning?.enabled === true,
      retentionPeriodSeconds:
        Number(configuration.retentionPolicy?.retentionPeriod) || null,
      retentionPolicyLocked: configuration.retentionPolicy?.isLocked === true,
      softDeleteRetentionSeconds:
        Number(configuration.softDeletePolicy?.retentionDurationSeconds) || null,
      isolationSafe: isolation.isolationSafe,
      inheritedAccessNeutralized: isolation.inheritedAccessNeutralized,
      isolationTagValueNamespacedName: isolation.tagValueNamespacedName,
      isolationTagBindingDigestSha256: isolation.tagBindingDigestSha256,
      isolationDenyPolicyDigestSha256: isolation.denyPolicyDigestSha256,
      isolationDenyRuleDigestSha256: isolation.denyRuleDigestSha256,
      isolationExceptionPrincipalDigestSha256:
        isolation.exceptionPrincipalDigestSha256,
      isolationInheritedIamDigestSha256: isolation.inheritedStorageIamDigestSha256,
      bucketIamEvidenceDigestSha256: sha256(canonicalJson(bucketBindings)),
      inheritedIamEvidenceDigestSha256:
        isolation.inheritedStorageIamDigestSha256,
      bucketIamBindingCount: bucketBindings.length,
      inheritedStorageIamBindingCount: inheritedBindings.length,
      publicIamMemberCount,
      prohibitedPreCopyBucketPrincipalCount,
      expectedMigrationObjectCount: expectedObjects.length,
      existingMigrationObjectCount: objectEvidence.filter(
        (entry) => entry.targetBucket === bucket.targetBucket && entry.state === "PRESENT_EXACT",
      ).length,
      unknownMigrationObjectCount: 0,
      retainedHistoricalObjectCount: bucketHistoricalObjects.length,
      retainedHistoricalTotalBytes: bucketHistoricalObjects.reduce(
        (sum, object) => sum + object.sizeBytes,
        0,
      ),
      retainedHistoricalObjectSetDigestSha256: sha256(canonicalJson(
        bucketHistoricalObjects.sort((left, right) =>
          `${left.objectId}\0${left.sourceFingerprintSha256}`.localeCompare(
            `${right.objectId}\0${right.sourceFingerprintSha256}`,
          )),
      )),
      unmanagedObjectCount: unmanaged.length,
      unmanagedTotalBytes: unmanagedBytes,
      unmanagedInventoryDigestSha256: unmanagedDigestSha256,
    });
  }
  const blockers = [];
  if (bucketEvidence.some((bucket) => !bucket.bucketConfigurationSafe)) blockers.push("TARGET_BUCKET_CONFIGURATION_UNSAFE");
  if (bucketEvidence.some((bucket) => !bucket.iamMatchesFrozenAllowlist)) blockers.push("TARGET_IAM_NOT_FROZEN_ALLOWLIST");
  if (!migrationWriterRoleExact) blockers.push("TARGET_MIGRATION_WRITER_ROLE_DRIFT");
  if (!COPY_POLICY_CANDIDATE.executionActivated) blockers.push("COPY_POLICY_NOT_ACTIVATED");
  if (!COPY_POLICY_CANDIDATE.copyExecutionAllowed) blockers.push("COPY_EXECUTION_NOT_ALLOWED");
  const artifact = {
    schemaVersion: TARGET_COPY_PREFLIGHT_SCHEMA,
    collectedAt,
    environment: "uat",
    project: "hushh-tech-uat",
    region: "us-central1",
    contractFileDigestSha256: contractFileDigestSha256(),
    isolatedCutoverContractFileDigestSha256:
      isolatedCutoverContractFileDigestSha256(),
    migrationWriterRole: ISOLATED_CUTOVER_CONTRACT.migrationWriterRole,
    migrationWriterRolePermissions,
    migrationWriterRolePermissionDigestSha256,
    migrationWriterRoleExact,
    copyPolicyCandidateFileDigestSha256: copyPolicyCandidateFileDigestSha256(),
    sourceInventoryDigestSha256: source.digestSha256,
    sourceArtifactDigestSha256: source.sourceArtifactDigestSha256,
    previousCheckpointFileDigestSha256,
    previousCheckpointDigestSha256: source.previousCheckpoint?.checkpointDigestSha256 ?? null,
    migrationNamespace: COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace,
    bucketCount: bucketEvidence.length,
    expectedObjectCount: source.objectCount,
    expectedTotalBytes: source.totalBytes,
    existingMigrationObjectCount: existingMigrationObjects,
    unmanagedObjectCount: totalUnmanagedObjects,
    unmanagedTotalBytes: totalUnmanagedBytes,
    retainedHistoricalObjectCount: retainedHistoricalObjects.length,
    retainedHistoricalTotalBytes: retainedHistoricalObjects.reduce(
      (sum, object) => sum + object.sizeBytes,
      0,
    ),
    buckets: bucketEvidence.sort((left, right) => left.bucketName.localeCompare(right.bucketName)),
    objects: objectEvidence.sort((left, right) => left.objectId.localeCompare(right.objectId)),
    retainedHistoricalObjects: retainedHistoricalObjects.sort((left, right) =>
      `${left.objectId}\0${left.sourceFingerprintSha256}`.localeCompare(
        `${right.objectId}\0${right.sourceFingerprintSha256}`,
      )),
    blockers,
    safeForCopy: blockers.length === 0,
    preflightDigestSha256: null,
  };
  artifact.preflightDigestSha256 = calculateSelfBoundDigest(artifact, "preflightDigestSha256");
  return artifact;
};

const parseArguments = (argv) => {
  const flags = new Set(["--allow-read-only-live"]);
  const valueFlags = new Set([
    "--mode",
    "--environment",
    "--project",
    "--output",
    "--evidence-output",
    "--source-inventory",
    "--source-file-digest-sha256",
    "--previous-checkpoint",
    "--previous-checkpoint-file-digest-sha256",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      if (values.has(argument)) fail("DUPLICATE_ARGUMENT", "A collector flag was duplicated.");
      values.set(argument, true);
      continue;
    }
    if (!valueFlags.has(argument)) fail("UNSUPPORTED_ARGUMENT", "Only documented collector arguments are accepted.");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("MISSING_ARGUMENT_VALUE", "A collector argument is missing its value.");
    if (values.has(argument)) fail("DUPLICATE_ARGUMENT", "A collector argument was duplicated.");
    values.set(argument, value);
    index += 1;
  }
  return values;
};

const requiredValue = (values, flag) => {
  const value = values.get(flag);
  if (typeof value !== "string" || value.length === 0) fail("MISSING_ARGUMENT", `${flag} is required.`);
  return value;
};

const loadCheckpointBinding = (values) => {
  const checkpointPath = values.get("--previous-checkpoint");
  const expectedCheckpointFileDigest = values.get("--previous-checkpoint-file-digest-sha256");
  if ((checkpointPath === undefined) !== (expectedCheckpointFileDigest === undefined)) {
    fail("TARGET_CHECKPOINT_BINDING_INVALID", "Both checkpoint path and exact file digest are required together.");
  }
  if (checkpointPath === undefined) return null;
  requireSha256(expectedCheckpointFileDigest, "TARGET_CHECKPOINT_FILE_DIGEST_INVALID", "checkpoint file digest");
  const checkpointArtifact = readPrivateArtifact(checkpointPath, {
    maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES,
  });
  if (checkpointArtifact.fileDigestSha256 !== expectedCheckpointFileDigest) {
    fail("TARGET_CHECKPOINT_FILE_DIGEST_MISMATCH", "The checkpoint file digest changed.");
  }
  let rawCheckpoint;
  try {
    rawCheckpoint = JSON.parse(checkpointArtifact.bytes.toString("utf8"));
    validateCheckpoint(rawCheckpoint);
  } catch (error) {
    if (error?.code) throw error;
    fail("TARGET_CHECKPOINT_JSON_INVALID", "The previous checkpoint is not valid JSON.");
  }
  return {
    checkpoint: rawCheckpoint,
    fileDigestSha256: checkpointArtifact.fileDigestSha256,
  };
};

export const runLiveInventoryCli = async (argv, dependencies = {}) => {
  const values = parseArguments(argv);
  const mode = values.get("--mode") || "source";
  if (!new Set(["source", "target"]).has(mode)) fail("UNSUPPORTED_MODE", "Collector mode must be source or target.");
  const environment = values.get("--environment") || "uat";
  const project = values.get("--project") || "hushh-tech-uat";
  if (environment !== "uat" || project !== "hushh-tech-uat") {
    fail("COLLECTOR_SCOPE_BLOCKED", "Live collectors are restricted to the UAT cutover scope.");
  }
  const policy = validateCopyPolicyCandidate();
  if (!values.has("--allow-read-only-live")) {
    return {
      ok: true,
      mode,
      dryRun: true,
      readOnlyLiveExecuted: false,
      executionAllowed: false,
      candidateDigestSha256: policy.candidateDigestSha256,
    };
  }
  if (!COPY_POLICY_CANDIDATE.readOnlyCollectorsAllowedWithExplicitFlag) {
    fail("READ_ONLY_COLLECTION_BLOCKED", "The candidate policy does not permit live reads.");
  }
  const output = requiredValue(values, "--output");
  if (mode === "source") {
    const checkpointBinding = loadCheckpointBinding(values);
    const evidenceOutput = requiredValue(values, "--evidence-output");
    const serviceRoleKey = dependencies.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sourceClient = dependencies.sourceClient || new SupabaseReadOnlyStorageClient({ serviceRoleKey });
    const collected = await collectLiveSourceInventory({
      sourceClient,
      previousCheckpoint: checkpointBinding?.checkpoint ?? null,
      previousCheckpointFileDigestSha256: checkpointBinding?.fileDigestSha256 ?? null,
    });
    writePrivateArtifact(output, collected.jsonLines);
    const evidenceBytes = Buffer.from(`${JSON.stringify(collected.evidence, null, 2)}\n`);
    writePrivateArtifact(evidenceOutput, evidenceBytes);
    return {
      ok: true,
      mode,
      dryRun: false,
      readOnlyLiveExecuted: true,
      sourceMutationAllowed: false,
      sourceInventoryFileDigestSha256: sha256(collected.jsonLines),
      sourceEvidenceFileDigestSha256: sha256(evidenceBytes),
      sourceInventoryDigestSha256: collected.evidence.sourceInventoryDigestSha256,
      sourceArtifactDigestSha256: collected.evidence.sourceArtifactDigestSha256,
      snapshotKind: collected.evidence.snapshotKind,
      snapshotSequence: collected.evidence.snapshotSequence,
      previousCheckpointFileDigestSha256:
        collected.evidence.previousCheckpointFileDigestSha256,
      previousCheckpointDigestSha256: collected.evidence.previousCheckpointDigestSha256,
      bucketCount: collected.evidence.bucketCount,
      objectCount: collected.evidence.objectCount,
      totalBytes: collected.evidence.totalBytes,
      tombstoneCount: collected.evidence.tombstoneCount,
      dispositionCount: collected.evidence.dispositionCount,
    };
  }
  const sourcePath = requiredValue(values, "--source-inventory");
  const expectedSourceFileDigest = requiredValue(values, "--source-file-digest-sha256");
  requireSha256(expectedSourceFileDigest, "SOURCE_FILE_DIGEST_INVALID", "source file digest");
  const sourceArtifact = readPrivateArtifact(sourcePath, {
    maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES,
  });
  if (sourceArtifact.fileDigestSha256 !== expectedSourceFileDigest) {
    fail("SOURCE_FILE_DIGEST_MISMATCH", "The source inventory file digest changed.");
  }
  const sourceRecords = parseJsonLines(
    sourceArtifact.bytes.toString("utf8"),
    "source inventory",
  );
  const checkpointBinding = loadCheckpointBinding(values);
  const gcsClient = dependencies.gcsClient || new GoogleCloudReadOnlyStorageClient({ project });
  const artifact = await collectLiveTargetPreflight({
    gcsClient,
    sourceRecords,
    previousCheckpoint: checkpointBinding?.checkpoint ?? null,
    previousCheckpointFileDigestSha256: checkpointBinding?.fileDigestSha256 ?? null,
  });
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  writePrivateArtifact(output, bytes);
  return {
    ok: true,
    mode,
    dryRun: false,
    readOnlyLiveExecuted: true,
    targetMutationAllowed: false,
    targetPreflightFileDigestSha256: sha256(bytes),
    targetPreflightDigestSha256: artifact.preflightDigestSha256,
    previousCheckpointFileDigestSha256: artifact.previousCheckpointFileDigestSha256,
    previousCheckpointDigestSha256: artifact.previousCheckpointDigestSha256,
    bucketCount: artifact.bucketCount,
    expectedObjectCount: artifact.expectedObjectCount,
    expectedTotalBytes: artifact.expectedTotalBytes,
    existingMigrationObjectCount: artifact.existingMigrationObjectCount,
    unmanagedObjectCount: artifact.unmanagedObjectCount,
    unmanagedTotalBytes: artifact.unmanagedTotalBytes,
    blockers: artifact.blockers,
    safeForCopy: artifact.safeForCopy,
  };
};

const invokedAsScript = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
if (invokedAsScript) {
  runLiveInventoryCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(safeErrorResult(error, "LIVE_INVENTORY_FAILED"))}\n`);
      process.exitCode = 1;
    });
}
