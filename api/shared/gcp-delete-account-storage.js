import { createHash } from "node:crypto";

const GCS_API_ORIGIN = "https://storage.googleapis.com";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const MIGRATION_NAMESPACE = "_hushh_migrations/supabase-cutover-v1";
const TOMBSTONE_NAMESPACE = "_hushh_deletions/delete-account-v1";
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOMBSTONE_BYTES = 16 * 1024;
const MAX_LISTED_OBJECTS = 10_000;
const MAX_LIST_PAGES = 100;
const MAX_DELETE_OBJECTS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

const UAT_BUCKETS = Object.freeze({
  assets: Object.freeze({
    targetBucket: "hushh-tech-cutover-v1-assets-legal-uat",
    targetAccessMode: "PRIVATE_SERVICE_OR_SIGNED_URL",
  }),
  "hushh-ai-media": Object.freeze({
    targetBucket: "hushh-tech-cutover-v1-ai-media-uat",
    targetAccessMode: "PRIVATE_OWNER_SIGNED_URL",
  }),
});

const MIGRATION_METADATA_KEYS = Object.freeze([
  "hushh-access-mode",
  "hushh-migration-schema",
  "hushh-source-bucket",
  "hushh-source-cache-control-b64",
  "hushh-source-fingerprint",
  "hushh-source-object-id",
  "hushh-source-object-key-b64",
  "hushh-source-sha256",
  "hushh-source-updated-at",
]);

const TOMBSTONE_KEYS = Object.freeze([
  "deletedAt",
  "reason",
  "schemaVersion",
  "sourceBucket",
  "sourceFingerprintSha256",
  "sourceObjectId",
  "sourceSha256",
  "targetBucket",
  "targetGeneration",
  "targetObjectNameSha256",
]);

const TOMBSTONE_METADATA_KEYS = Object.freeze([
  "hushh-delete-tombstone-body-sha256",
  "hushh-delete-tombstone-schema",
  "hushh-source-object-id",
  "hushh-target-generation",
]);

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const md5Base64 = (value) =>
  createHash("md5").update(value).digest("base64");

const canonicalJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const gcpDeleteAccountStorageBucketMappingDigestSha256 = () =>
  sha256(canonicalJson(UAT_BUCKETS));

const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireExactKeys = (value, expectedKeys, code, label) => {
  if (!isPlainObject(value)) fail(code, `${label} is invalid.`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(code, `${label} does not have the exact schema.`);
  }
};

const assertSafeSourcePath = (value, label = "source object path") => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1_024 ||
    /[\0\r\n]/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("GCP_STORAGE_SOURCE_PATH_INVALID", `${label} is invalid.`);
  }
  return value;
};

const assertSafePrefix = (value) => {
  if (value === "") return value;
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  assertSafeSourcePath(normalized, "source object prefix");
  return normalized;
};

const assertSha256 = (value, label) => {
  if (!/^[a-f0-9]{64}$/.test(value || "")) {
    fail("GCP_STORAGE_METADATA_INVALID", `${label} is invalid.`);
  }
  return value;
};

const assertGeneration = (value) => {
  if (!/^[1-9][0-9]*$/.test(String(value || ""))) {
    fail("GCP_STORAGE_GENERATION_INVALID", "A target generation is invalid.");
  }
  return String(value);
};

const decodeCanonicalBase64 = (value, label, { allowEmpty = false } = {}) => {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > 2_048
  ) {
    fail("GCP_STORAGE_METADATA_INVALID", `${label} is invalid.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    fail("GCP_STORAGE_METADATA_INVALID", `${label} is not canonical base64.`);
  }
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    fail("GCP_STORAGE_METADATA_INVALID", `${label} is not valid UTF-8.`);
  }
  return decoded;
};

const assertIsoTimestamp = (value, label) => {
  if (typeof value !== "string" || value.length > 64) {
    fail("GCP_STORAGE_METADATA_INVALID", `${label} is invalid.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail("GCP_STORAGE_METADATA_INVALID", `${label} is not a canonical timestamp.`);
  }
  return value;
};

const assertBoundedReason = (value) => {
  if (value !== "account-deletion") {
    fail("GCP_STORAGE_DELETE_REASON_INVALID", "The storage delete reason is invalid.");
  }
  return value;
};

const parseBoundedJson = async (response, code) => {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_JSON_RESPONSE_BYTES) {
    fail(code, "A Google Cloud response exceeded its size limit.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_RESPONSE_BYTES) {
    fail(code, "A Google Cloud response exceeded its size limit.");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    fail(code, "A Google Cloud response was not valid JSON.");
  }
};

const readBoundedBytes = async (response, maximumBytes, code) => {
  const declaredLength = response.headers?.get?.("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    fail(code, "A Google Cloud response exceeded its size limit.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) {
    fail(code, "A Google Cloud response exceeded its size limit.");
  }
  return bytes;
};

const normalizeDeletePaths = (paths) => {
  if (!Array.isArray(paths) || paths.length > MAX_DELETE_OBJECTS) {
    fail("GCP_STORAGE_DELETE_SET_INVALID", "The delete path set is invalid.");
  }
  const normalized = [...new Set(paths.map((path) => assertSafeSourcePath(path)))].sort();
  return normalized;
};

const parseMigrationObject = (sourceBucket, targetBucket, object) => {
  if (!isPlainObject(object) || object.bucket !== targetBucket) {
    fail("GCP_STORAGE_OBJECT_INVALID", "A listed target object is invalid.");
  }
  const prefix = `${MIGRATION_NAMESPACE}/${sourceBucket}/`;
  const suffix = typeof object.name === "string" && object.name.startsWith(prefix)
    ? object.name.slice(prefix.length)
    : "";
  const match = /^([a-f0-9]{64})\/([a-f0-9]{64})$/.exec(suffix);
  if (!match) {
    fail("GCP_STORAGE_NAMESPACE_OCCUPIED", "The migration namespace contains an invalid object name.");
  }
  const metadata = object.metadata;
  requireExactKeys(
    metadata,
    MIGRATION_METADATA_KEYS,
    "GCP_STORAGE_METADATA_INVALID",
    "Migration object provenance metadata"
  );
  const sourceObjectKey = assertSafeSourcePath(
    decodeCanonicalBase64(metadata["hushh-source-object-key-b64"], "source object key")
  );
  const objectId = sha256(`${sourceBucket}\0${sourceObjectKey}`);
  const sourceFingerprintSha256 = assertSha256(
    metadata["hushh-source-fingerprint"],
    "source fingerprint"
  );
  const sizeBytes = Number(object.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    fail("GCP_STORAGE_OBJECT_INVALID", "A listed target object has an invalid size.");
  }
  if (
    typeof object.contentType !== "string" ||
    object.contentType.length === 0 ||
    object.contentType.length > 255 ||
    object.cacheControl !== "private, no-store" ||
    !/^[A-Za-z0-9+/]{6}==$/.test(object.crc32c || "") ||
    !/^[A-Za-z0-9+/]{22}==$/.test(object.md5Hash || "")
  ) {
    fail("GCP_STORAGE_OBJECT_INVALID", "A listed target object failed immutable byte metadata checks.");
  }
  const sourceUpdatedAt = assertIsoTimestamp(
    metadata["hushh-source-updated-at"],
    "source update time"
  );
  const sourceCacheControl = metadata["hushh-source-cache-control-b64"] === "-"
    ? null
    : decodeCanonicalBase64(
        metadata["hushh-source-cache-control-b64"],
        "source cache control",
        { allowEmpty: true }
      );
  const sourceSha256 = assertSha256(metadata["hushh-source-sha256"], "source SHA-256");
  const recomputedFingerprint = sha256(canonicalJson({
    bucketId: sourceBucket,
    objectKey: sourceObjectKey,
    sizeBytes,
    mimeType: object.contentType,
    sourceUpdatedAt,
    cacheControl: sourceCacheControl,
    sha256: sourceSha256,
  }));
  const expectedAccessMode = UAT_BUCKETS[sourceBucket]?.targetAccessMode;
  if (
    metadata["hushh-migration-schema"] !== "supabase-cutover-v1" ||
    metadata["hushh-source-bucket"] !== sourceBucket ||
    metadata["hushh-source-object-id"] !== objectId ||
    match[1] !== objectId ||
    match[2] !== sourceFingerprintSha256 ||
    recomputedFingerprint !== sourceFingerprintSha256 ||
    metadata["hushh-access-mode"] !== expectedAccessMode
  ) {
    fail("GCP_STORAGE_METADATA_INVALID", "Migration object provenance does not match its immutable name.");
  }
  return {
    sourceBucket,
    sourceObjectKey,
    objectId,
    sourceFingerprintSha256,
    sourceSha256,
    targetBucket,
    targetObjectName: object.name,
    generation: assertGeneration(object.generation),
    sizeBytes,
  };
};

const buildTombstone = (object, deletedAt, reason) => ({
  schemaVersion: "hushh-tech-storage-delete-tombstone-v1",
  sourceBucket: object.sourceBucket,
  sourceObjectId: object.objectId,
  sourceFingerprintSha256: object.sourceFingerprintSha256,
  sourceSha256: object.sourceSha256,
  targetBucket: object.targetBucket,
  targetObjectNameSha256: sha256(object.targetObjectName),
  targetGeneration: object.generation,
  deletedAt,
  reason,
});

const tombstoneObjectName = (object) =>
  `${TOMBSTONE_NAMESPACE}/${object.sourceBucket}/${object.objectId}/${object.sourceFingerprintSha256}/${object.generation}.json`;

export const buildGcpDeleteAccountStorageBindingDigest = ({
  project,
  environment,
  manifestDigestSha256,
  activationDigestSha256,
}) => sha256(canonicalJson({
  schemaVersion: "hushh-tech-delete-account-storage-activation-binding-v1",
  project,
  environment,
  manifestDigestSha256,
  activationDigestSha256,
  bucketMappingDigestSha256: gcpDeleteAccountStorageBucketMappingDigestSha256(),
}));

export function createMetadataServerTokenProvider({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached = null;
  return async () => {
    const timestamp = now();
    if (cached && cached.expiresAt - timestamp > 60_000) return cached.token;
    const response = await fetchImpl(METADATA_TOKEN_URL, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      fail("GCP_STORAGE_TOKEN_FAILED", "The Cloud Run service identity token is unavailable.");
    }
    const payload = await parseBoundedJson(response, "GCP_STORAGE_TOKEN_INVALID");
    if (
      typeof payload.access_token !== "string" ||
      payload.access_token.length < 20 ||
      payload.access_token.length > 8_192 ||
      /[\0\r\n]/.test(payload.access_token) ||
      !Number.isFinite(payload.expires_in) ||
      payload.expires_in <= 0
    ) {
      fail("GCP_STORAGE_TOKEN_INVALID", "The Cloud Run service identity token is invalid.");
    }
    cached = {
      token: payload.access_token,
      expiresAt: timestamp + Math.min(payload.expires_in, 3_600) * 1_000,
    };
    return cached.token;
  };
}

export class GcpDeleteAccountStorageAdapter {
  constructor({
    project,
    environment,
    manifestDigestSha256,
    activationDigestSha256,
    bindingDigestSha256,
    fetchImpl = fetch,
    tokenProvider = createMetadataServerTokenProvider({ fetchImpl }),
    now = () => new Date().toISOString(),
  } = {}) {
    if (project !== "hushh-tech-uat" || environment !== "uat") {
      fail("GCP_STORAGE_SCOPE_BLOCKED", "Delete-account storage is restricted to Hushh Tech UAT.");
    }
    assertSha256(manifestDigestSha256, "storage manifest digest");
    assertSha256(activationDigestSha256, "storage activation digest");
    assertSha256(bindingDigestSha256, "storage activation binding digest");
    const expectedBindingDigest = buildGcpDeleteAccountStorageBindingDigest({
      project,
      environment,
      manifestDigestSha256,
      activationDigestSha256,
    });
    if (bindingDigestSha256 !== expectedBindingDigest) {
      fail(
        "GCP_STORAGE_NOT_RECONCILED",
        "Delete-account storage is not bound to the reconciled manifest and activation."
      );
    }
    this.project = project;
    this.environment = environment;
    this.manifestDigestSha256 = manifestDigestSha256;
    this.activationDigestSha256 = activationDigestSha256;
    this.bindingDigestSha256 = bindingDigestSha256;
    this.fetchImpl = fetchImpl;
    this.tokenProvider = tokenProvider;
    this.now = now;
  }

  targetBucket(sourceBucket) {
    const bucket = UAT_BUCKETS[sourceBucket];
    if (!bucket) {
      fail("GCP_STORAGE_BUCKET_BLOCKED", "Delete-account storage received an unknown source bucket.");
    }
    return bucket.targetBucket;
  }

  async request(url, options = {}) {
    const parsed = new URL(url);
    if (
      parsed.origin !== GCS_API_ORIGIN ||
      !parsed.pathname.startsWith("/storage/v1/b/") &&
        !parsed.pathname.startsWith("/upload/storage/v1/b/") &&
        !parsed.pathname.startsWith("/download/storage/v1/b/")
    ) {
      fail("GCP_STORAGE_ENDPOINT_BLOCKED", "A Google Cloud Storage endpoint was not allowlisted.");
    }
    const token = await this.tokenProvider();
    return this.fetchImpl(parsed, {
      ...options,
      headers: {
        ...(options.headers || {}),
        authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async listSourcePrefix(sourceBucket, rawPrefix = "") {
    const targetBucket = this.targetBucket(sourceBucket);
    const prefix = assertSafePrefix(rawPrefix);
    const migrationPrefix = `${MIGRATION_NAMESPACE}/${sourceBucket}/`;
    const objects = [];
    const seenTargetVersions = new Set();
    let scannedObjectCount = 0;
    let pageCount = 0;
    let pageToken = null;
    const seenTokens = new Set();
    do {
      if (
        pageToken !== null &&
        (typeof pageToken !== "string" ||
          pageToken.length === 0 ||
          pageToken.length > 4_096 ||
          /[\0\r\n]/.test(pageToken) ||
          seenTokens.has(pageToken))
      ) {
        fail("GCP_STORAGE_PAGE_TOKEN_INVALID", "Google Cloud Storage returned an invalid page token.");
      }
      if (pageToken) seenTokens.add(pageToken);
      pageCount += 1;
      if (pageCount > MAX_LIST_PAGES) {
        fail("GCP_STORAGE_LIST_LIMIT", "The migrated object list exceeded its page limit.");
      }
      const url = new URL(
        `${GCS_API_ORIGIN}/storage/v1/b/${encodeURIComponent(targetBucket)}/o`
      );
      url.searchParams.set("prefix", migrationPrefix);
      url.searchParams.set("projection", "full");
      url.searchParams.set("maxResults", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.request(url, { method: "GET" });
      if (!response.ok) {
        fail("GCP_STORAGE_LIST_FAILED", "Failed to list migrated Google Cloud Storage objects.");
      }
      const payload = await parseBoundedJson(response, "GCP_STORAGE_LIST_INVALID");
      if (payload.items !== undefined && !Array.isArray(payload.items)) {
        fail("GCP_STORAGE_LIST_INVALID", "Google Cloud Storage returned an invalid object list.");
      }
      for (const item of payload.items || []) {
        scannedObjectCount += 1;
        if (scannedObjectCount > MAX_LISTED_OBJECTS) {
          fail("GCP_STORAGE_LIST_LIMIT", "The migrated object list exceeded its safety limit.");
        }
        const parsedObject = parseMigrationObject(sourceBucket, targetBucket, item);
        const targetVersion = `${parsedObject.targetObjectName}\0${parsedObject.generation}`;
        if (seenTargetVersions.has(targetVersion)) {
          fail("GCP_STORAGE_LIST_INVALID", "Google Cloud Storage returned a duplicate target version.");
        }
        seenTargetVersions.add(targetVersion);
        if (
          prefix === "" ||
          parsedObject.sourceObjectKey === prefix ||
          parsedObject.sourceObjectKey.startsWith(`${prefix}/`)
        ) {
          objects.push(parsedObject);
          if (objects.length > MAX_LISTED_OBJECTS) {
            fail("GCP_STORAGE_LIST_LIMIT", "The migrated object list exceeded its safety limit.");
          }
        }
      }
      pageToken = payload.nextPageToken ?? null;
    } while (pageToken !== null);
    return objects.sort((left, right) =>
      left.sourceObjectKey.localeCompare(right.sourceObjectKey) ||
      left.generation.localeCompare(right.generation)
    );
  }

  async readObjectMetadata(bucket, objectName) {
    const url = new URL(
      `${GCS_API_ORIGIN}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`
    );
    url.searchParams.set("projection", "full");
    const response = await this.request(url, { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) {
      fail("GCP_STORAGE_OBJECT_READ_FAILED", "Failed to read Google Cloud Storage object metadata.");
    }
    return parseBoundedJson(response, "GCP_STORAGE_OBJECT_READ_INVALID");
  }

  async readObjectBody(bucket, objectName, generation) {
    const url = new URL(
      `${GCS_API_ORIGIN}/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", assertGeneration(generation));
    const response = await this.request(url, { method: "GET" });
    if (!response.ok) {
      fail("GCP_STORAGE_OBJECT_READ_FAILED", "Failed to read a Google Cloud Storage object body.");
    }
    return readBoundedBytes(response, MAX_TOMBSTONE_BYTES, "GCP_STORAGE_OBJECT_READ_INVALID");
  }

  validateExistingTombstone(object, existing, body, expectedReason) {
    const objectName = tombstoneObjectName(object);
    if (
      !isPlainObject(existing) ||
      existing.bucket !== object.targetBucket ||
      existing.name !== objectName ||
      existing.contentType !== "application/json" ||
      existing.cacheControl !== "private, no-store" ||
      existing.size !== String(body.length) ||
      existing.md5Hash !== md5Base64(body)
    ) {
      fail("GCP_STORAGE_TOMBSTONE_COLLISION", "An existing tombstone has invalid object metadata.");
    }
    const generation = assertGeneration(existing.generation);
    requireExactKeys(
      existing.metadata,
      TOMBSTONE_METADATA_KEYS,
      "GCP_STORAGE_TOMBSTONE_COLLISION",
      "Existing tombstone metadata"
    );
    const bodySha256 = sha256(body);
    if (
      existing.metadata["hushh-delete-tombstone-schema"] !==
        "hushh-tech-storage-delete-tombstone-v1" ||
      existing.metadata["hushh-delete-tombstone-body-sha256"] !== bodySha256 ||
      existing.metadata["hushh-source-object-id"] !== object.objectId ||
      existing.metadata["hushh-target-generation"] !== object.generation
    ) {
      fail("GCP_STORAGE_TOMBSTONE_COLLISION", "An existing tombstone failed its digest binding.");
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      fail("GCP_STORAGE_TOMBSTONE_COLLISION", "An existing tombstone body is not valid JSON.");
    }
    requireExactKeys(
      parsed,
      TOMBSTONE_KEYS,
      "GCP_STORAGE_TOMBSTONE_COLLISION",
      "Existing tombstone body"
    );
    const deletedAt = assertIsoTimestamp(parsed.deletedAt, "tombstone delete time");
    const expected = buildTombstone(object, deletedAt, expectedReason);
    if (canonicalJson(parsed) !== canonicalJson(expected)) {
      fail("GCP_STORAGE_TOMBSTONE_COLLISION", "An existing tombstone does not match the target version.");
    }
    return generation;
  }

  async createTombstone(object, tombstone) {
    const objectName = tombstoneObjectName(object);
    const url = new URL(
      `${GCS_API_ORIGIN}/upload/storage/v1/b/${encodeURIComponent(object.targetBucket)}/o`
    );
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("name", objectName);
    url.searchParams.set("ifGenerationMatch", "0");
    requireExactKeys(
      tombstone,
      TOMBSTONE_KEYS,
      "GCP_STORAGE_TOMBSTONE_INVALID",
      "Delete tombstone"
    );
    const bodyBytes = Buffer.from(`${canonicalJson(tombstone)}\n`);
    const bodySha256 = sha256(bodyBytes);
    const objectMetadata = {
      name: objectName,
      contentType: "application/json",
      cacheControl: "private, no-store",
      metadata: {
        "hushh-delete-tombstone-schema": "hushh-tech-storage-delete-tombstone-v1",
        "hushh-delete-tombstone-body-sha256": bodySha256,
        "hushh-source-object-id": object.objectId,
        "hushh-target-generation": object.generation,
      },
    };
    const boundary = `hushh-${bodySha256.slice(0, 32)}`;
    const bytes = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(objectMetadata)}\r\n` +
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n`
      ),
      bodyBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await this.request(url, {
      method: "POST",
      headers: {
        "content-type": `multipart/related; boundary=${boundary}`,
        "content-length": String(bytes.length),
      },
      body: bytes,
    });
    if (response.status === 412) {
      const existing = await this.readObjectMetadata(object.targetBucket, objectName);
      if (!existing) {
        fail("GCP_STORAGE_TOMBSTONE_COLLISION", "An existing tombstone could not be verified.");
      }
      const existingGeneration = assertGeneration(existing.generation);
      const existingBody = await this.readObjectBody(
        object.targetBucket,
        objectName,
        existingGeneration
      );
      this.validateExistingTombstone(object, existing, existingBody, tombstone.reason);
      return { objectName, replay: true };
    }
    if (!response.ok) {
      fail("GCP_STORAGE_TOMBSTONE_FAILED", "Failed to create the delete tombstone.");
    }
    const created = await parseBoundedJson(response, "GCP_STORAGE_TOMBSTONE_INVALID");
    this.validateExistingTombstone(object, created, bodyBytes, tombstone.reason);
    return { objectName, replay: false };
  }

  async deleteVersion(object) {
    const url = new URL(
      `${GCS_API_ORIGIN}/storage/v1/b/${encodeURIComponent(object.targetBucket)}/o/${encodeURIComponent(object.targetObjectName)}`
    );
    url.searchParams.set("ifGenerationMatch", object.generation);
    const response = await this.request(url, { method: "DELETE" });
    if (response.status === 404) return { alreadyAbsent: true };
    if (response.status === 412) {
      fail("GCP_STORAGE_GENERATION_CHANGED", "A migrated object generation changed before deletion.");
    }
    if (!response.ok) {
      fail("GCP_STORAGE_DELETE_FAILED", "Failed to delete a migrated Google Cloud Storage object.");
    }
    return { alreadyAbsent: false };
  }

  async deleteSourcePaths(sourceBucket, paths, { reason = "account-deletion" } = {}) {
    const requestedPaths = normalizeDeletePaths(paths);
    if (requestedPaths.length === 0) return 0;
    assertBoundedReason(reason);
    const liveObjects = await this.listSourcePrefix(sourceBucket, "");
    const requested = new Set(requestedPaths);
    const selected = liveObjects.filter((object) => requested.has(object.sourceObjectKey));
    for (const object of selected) {
      const deletedAt = this.now();
      try {
        assertIsoTimestamp(deletedAt, "delete timestamp");
      } catch {
        fail("GCP_STORAGE_CLOCK_INVALID", "The delete timestamp is invalid.");
      }
      const tombstone = buildTombstone(object, deletedAt, reason);
      await this.createTombstone(object, tombstone);
      await this.deleteVersion(object);
    }
    return selected.length;
  }
}

export function createGcpDeleteAccountStorageAdapterFromEnv(env = process.env, dependencies = {}) {
  if (env.GCP_DELETE_ACCOUNT_STORAGE_ENABLED !== "true") {
    fail(
      "GCP_DELETE_ACCOUNT_STORAGE_DISABLED",
      "Delete-account storage is disabled until the GCP copy is reconciled."
    );
  }
  return new GcpDeleteAccountStorageAdapter({
    project: env.GCP_DELETE_ACCOUNT_STORAGE_PROJECT,
    environment: env.GCP_DELETE_ACCOUNT_STORAGE_ENVIRONMENT,
    manifestDigestSha256: env.GCP_DELETE_ACCOUNT_STORAGE_MANIFEST_DIGEST,
    activationDigestSha256: env.GCP_DELETE_ACCOUNT_STORAGE_ACTIVATION_DIGEST,
    bindingDigestSha256: env.GCP_DELETE_ACCOUNT_STORAGE_BINDING_DIGEST,
    ...dependencies,
  });
}

export const __testing = {
  MIGRATION_NAMESPACE,
  TOMBSTONE_NAMESPACE,
  UAT_BUCKETS,
  buildTombstone,
  canonicalJson,
  parseMigrationObject,
  tombstoneObjectName,
};
