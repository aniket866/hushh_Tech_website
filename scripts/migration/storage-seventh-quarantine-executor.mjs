import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SEVEN_BUCKET_CONTRACT,
  buildSeventhTargetMetadata,
  seventhSourceFingerprint,
  seventhSourceObjectId,
  seventhTargetObjectKey,
} from "./storage-seven-bucket-contract.mjs";
import {
  canonicalJson,
  createCrc32c,
  fail,
  readStreamWithDeadline,
  requireExactKeys,
  sha256,
} from "./storage-live-common.mjs";
import { encodeSourceObjectPath } from "./storage-live-inventory.mjs";

const GCS_ORIGIN = "https://storage.googleapis.com";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_JSON_BYTES = 8_388_608;
const HASH_BUFFER_BYTES = 1_048_576;
const TARGET_METADATA_KEYS = [
  "hushh-access-mode",
  "hushh-migration-schema",
  "hushh-source-bucket-id-sha256",
  "hushh-source-cache-control-b64",
  "hushh-source-fingerprint",
  "hushh-source-object-id",
  "hushh-source-object-key-b64",
  "hushh-source-sha256",
  "hushh-source-updated-at",
];

const boundedJson = async (response, code) => {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    fail(code, "A Google Cloud response exceeded its byte bound.");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    fail(code, "A Google Cloud response was not valid JSON.");
  }
};

const hashDescriptor = (descriptor, expectedBytes) => {
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    fail("SEVENTH_SOURCE_DESCRIPTOR_INVALID", "The verified seventh source descriptor is missing.");
  }
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > SEVEN_BUCKET_CONTRACT.seventh.maximumObjectBytes
  ) {
    fail("SEVENTH_SOURCE_DESCRIPTOR_INVALID", "The verified seventh source byte bound is invalid.");
  }
  const status = fstatSync(descriptor);
  if (!status.isFile() || status.size !== expectedBytes || status.nlink !== 0) {
    fail("SEVENTH_SOURCE_DESCRIPTOR_CHANGED", "The seventh source descriptor is not sealed and unlinked.");
  }
  const digest = createHash("sha256");
  const md5 = createHash("md5");
  const crc32c = createCrc32c();
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, Math.max(expectedBytes, 1)));
  let offset = 0;
  while (offset < expectedBytes) {
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
    if (count <= 0) fail("SEVENTH_SOURCE_DESCRIPTOR_CHANGED", "The seventh source descriptor ended early.");
    const bytes = buffer.subarray(0, count);
    digest.update(bytes);
    md5.update(bytes);
    crc32c.update(bytes);
    offset += count;
  }
  const probe = Buffer.allocUnsafe(1);
  if (readSync(descriptor, probe, 0, 1, offset) !== 0) {
    fail("SEVENTH_SOURCE_DESCRIPTOR_CHANGED", "The seventh source descriptor grew during verification.");
  }
  const after = fstatSync(descriptor);
  if (
    after.dev !== status.dev ||
    after.ino !== status.ino ||
    after.size !== status.size ||
    after.nlink !== 0 ||
    after.mtimeMs !== status.mtimeMs ||
    after.ctimeMs !== status.ctimeMs
  ) {
    fail("SEVENTH_SOURCE_DESCRIPTOR_CHANGED", "The seventh source descriptor changed during verification.");
  }
  return {
    sizeBytes: offset,
    sha256: digest.digest("hex"),
    md5Base64: md5.digest("base64"),
    crc32cBase64: crc32c.digestBase64(),
  };
};

export const downloadVerifiedSeventhSource = async (sourceClient, sourceObject) => {
  const directory = mkdtempSync(join(tmpdir(), "hushh-storage-seventh-"));
  const path = join(directory, seventhSourceObjectId(sourceObject));
  let writer;
  let readerDescriptor;
  try {
    writer = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    const response = await sourceClient.request(
      `/object/authenticated/${encodeURIComponent(sourceObject.bucketId)}/${encodeSourceObjectPath(sourceObject.objectKey)}`,
    );
    if (!response.ok || !response.body) {
      fail("SEVENTH_SOURCE_DOWNLOAD_FAILED", "A seventh-bucket source object read failed.");
    }
    const digest = createHash("sha256");
    const md5 = createHash("md5");
    const crc32c = createCrc32c();
    let sizeBytes = 0;
    const bodyReader = response.body.getReader();
    const deadlineAt = Date.now() + REQUEST_TIMEOUT_MS;
    try {
      for (;;) {
        const { done, value } = await readStreamWithDeadline(
          bodyReader,
          deadlineAt,
          "SEVENTH_SOURCE_DOWNLOAD_FAILED",
          "A seventh-bucket source object exceeded its read deadline.",
        );
        if (done) break;
        const bytes = Buffer.from(value);
        sizeBytes += bytes.length;
        if (sizeBytes > sourceObject.sizeBytes || sizeBytes > SEVEN_BUCKET_CONTRACT.seventh.maximumObjectBytes) {
          await bodyReader.cancel();
          fail("SEVENTH_SOURCE_CHANGED", "A seventh-bucket source object exceeded its approved size.");
        }
        digest.update(bytes);
        md5.update(bytes);
        crc32c.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          offset += writeSync(writer, bytes, offset, bytes.length - offset);
        }
      }
    } finally {
      try { bodyReader.releaseLock(); } catch { void 0; }
    }
    fsyncSync(writer);
    const downloaded = {
      sizeBytes,
      sha256: digest.digest("hex"),
      md5Base64: md5.digest("base64"),
      crc32cBase64: crc32c.digestBase64(),
    };
    if (
      downloaded.sizeBytes !== sourceObject.sizeBytes ||
      downloaded.sha256 !== sourceObject.sha256 ||
      downloaded.md5Base64 !== sourceObject.md5Base64 ||
      downloaded.crc32cBase64 !== sourceObject.crc32cBase64
    ) {
      fail("SEVENTH_SOURCE_CHANGED", "A seventh-bucket source object changed after approval.");
    }
    readerDescriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const writerStatus = fstatSync(writer);
    const readerStatus = fstatSync(readerDescriptor);
    if (
      writerStatus.dev !== readerStatus.dev ||
      writerStatus.ino !== readerStatus.ino ||
      writerStatus.size !== readerStatus.size
    ) {
      fail("SEVENTH_SOURCE_DESCRIPTOR_CHANGED", "The seventh source temp path changed before sealing.");
    }
    unlinkSync(path);
    rmdirSync(directory);
    closeSync(writer);
    writer = undefined;
    const sealed = hashDescriptor(readerDescriptor, sourceObject.sizeBytes);
    if (canonicalJson(sealed) !== canonicalJson(downloaded)) {
      fail("SEVENTH_SOURCE_DESCRIPTOR_CHANGED", "The sealed seventh source descriptor changed.");
    }
    return { fileDescriptor: readerDescriptor, ...sealed };
  } catch (error) {
    if (readerDescriptor !== undefined) closeSync(readerDescriptor);
    if (writer !== undefined) closeSync(writer);
    try { unlinkSync(path); } catch { void 0; }
    try { rmdirSync(directory); } catch { void 0; }
    throw error;
  }
};

export class SeventhQuarantineCreateOnlyClient {
  constructor({ fetchImpl = fetch, tokenProvider } = {}) {
    this.fetchImpl = fetchImpl;
    this.tokenProvider = tokenProvider;
  }

  token() {
    const token = this.tokenProvider?.();
    if (typeof token !== "string" || token.length < 20 || /[\0\r\n]/.test(token)) {
      fail("SEVENTH_GCP_CREDENTIAL_MISSING", "The migration writer access token is unavailable.");
    }
    return token;
  }

  assertTarget(bucketName, objectKey) {
    const prefix = `${SEVEN_BUCKET_CONTRACT.seventh.targetPrefix}/`;
    if (
      bucketName !== SEVEN_BUCKET_CONTRACT.seventh.targetBucket ||
      typeof objectKey !== "string" ||
      !objectKey.startsWith(prefix) ||
      !/^[a-f0-9]{64}\/[a-f0-9]{64}$/.test(objectKey.slice(prefix.length)) ||
      objectKey.length !== prefix.length + 129
    ) {
      fail("SEVENTH_GCP_TARGET_BLOCKED", "The seventh writer only permits the exact quarantine namespace.");
    }
  }

  assertUrl(value, { resumable = false } = {}) {
    const url = new URL(value);
    if (
      url.origin !== GCS_ORIGIN ||
      url.username !== "" ||
      url.password !== "" ||
      (resumable &&
        url.pathname !==
          `/upload/storage/v1/b/${encodeURIComponent(SEVEN_BUCKET_CONTRACT.seventh.targetBucket)}/o`)
    ) {
      fail("SEVENTH_GCP_ENDPOINT_BLOCKED", "A seventh-bucket Google Cloud endpoint was not allowlisted.");
    }
    return url;
  }

  async getObject(bucketName, objectKey) {
    this.assertTarget(bucketName, objectKey);
    const url = this.assertUrl(
      `${GCS_ORIGIN}/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectKey)}?projection=full`,
    );
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token()}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) fail("SEVENTH_TARGET_READ_FAILED", "A quarantine target metadata read failed.");
    return boundedJson(response, "SEVENTH_TARGET_READ_INVALID");
  }

  async listObjects() {
    const objects = [];
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
        fail("SEVENTH_TARGET_LIST_INVALID", "Quarantine pagination returned an unsafe token.");
      }
      if (pageToken) seenTokens.add(pageToken);
      const url = this.assertUrl(
        `${GCS_ORIGIN}/storage/v1/b/${encodeURIComponent(SEVEN_BUCKET_CONTRACT.seventh.targetBucket)}/o`,
      );
      url.searchParams.set("prefix", `${SEVEN_BUCKET_CONTRACT.seventh.targetPrefix}/`);
      url.searchParams.set("projection", "full");
      url.searchParams.set("maxResults", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token()}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) fail("SEVENTH_TARGET_LIST_FAILED", "The quarantine namespace list failed.");
      const payload = await boundedJson(response, "SEVENTH_TARGET_LIST_INVALID");
      if (payload.items !== undefined && !Array.isArray(payload.items)) {
        fail("SEVENTH_TARGET_LIST_INVALID", "The quarantine namespace list was invalid.");
      }
      for (const object of payload.items || []) {
        this.assertTarget(SEVEN_BUCKET_CONTRACT.seventh.targetBucket, object?.name);
        objects.push(object);
        if (objects.length > SEVEN_BUCKET_CONTRACT.seventh.objectCount) {
          fail("SEVENTH_TARGET_NAMESPACE_OCCUPIED", "The quarantine namespace contains an extra object.");
        }
      }
      pageToken = payload.nextPageToken ?? null;
    } while (pageToken !== null);
    return objects;
  }

  async hashObject(object) {
    this.assertTarget(SEVEN_BUCKET_CONTRACT.seventh.targetBucket, object?.name);
    const url = this.assertUrl(
      `${GCS_ORIGIN}/download/storage/v1/b/${encodeURIComponent(SEVEN_BUCKET_CONTRACT.seventh.targetBucket)}/o/${encodeURIComponent(object.name)}?alt=media&generation=${encodeURIComponent(object.generation)}`,
    );
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token()}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) fail("SEVENTH_TARGET_READ_FAILED", "A quarantine target body read failed.");
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
          "SEVENTH_TARGET_READ_FAILED",
          "A quarantine target body exceeded its read deadline.",
        );
        if (done) break;
        const bytes = Buffer.from(value);
        sizeBytes += bytes.length;
        if (sizeBytes > Number(object.size) || sizeBytes > SEVEN_BUCKET_CONTRACT.seventh.maximumObjectBytes) {
          await reader.cancel();
          fail("SEVENTH_TARGET_READ_INVALID", "A quarantine target body exceeded its byte bound.");
        }
        digest.update(bytes);
        md5.update(bytes);
        crc32c.update(bytes);
      }
    } finally {
      try { reader.releaseLock(); } catch { void 0; }
    }
    return {
      sizeBytes,
      sha256: digest.digest("hex"),
      md5Base64: md5.digest("base64"),
      crc32cBase64: crc32c.digestBase64(),
    };
  }

  async uploadCreateOnly({ sourceObject, temporary }) {
    const bucketName = SEVEN_BUCKET_CONTRACT.seventh.targetBucket;
    const objectKey = seventhTargetObjectKey(sourceObject);
    this.assertTarget(bucketName, objectKey);
    const before = hashDescriptor(temporary.fileDescriptor, sourceObject.sizeBytes);
    if (
      before.sha256 !== sourceObject.sha256 ||
      before.md5Base64 !== sourceObject.md5Base64 ||
      before.crc32cBase64 !== sourceObject.crc32cBase64
    ) {
      fail("SEVENTH_SOURCE_DESCRIPTOR_CHANGED", "The seventh source descriptor changed before upload.");
    }
    const url = this.assertUrl(
      `${GCS_ORIGIN}/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o`,
      { resumable: true },
    );
    url.searchParams.set("uploadType", "resumable");
    url.searchParams.set("name", objectKey);
    url.searchParams.set("ifGenerationMatch", "0");
    const token = this.token();
    const initiate = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        "x-upload-content-length": String(sourceObject.sizeBytes),
        "x-upload-content-type": sourceObject.mimeType,
      },
      body: JSON.stringify({
        name: objectKey,
        contentType: sourceObject.mimeType,
        cacheControl: SEVEN_BUCKET_CONTRACT.seventh.targetCacheControl,
        metadata: buildSeventhTargetMetadata(sourceObject),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (initiate.status === 412) return { collision: true };
    if (!initiate.ok) fail("SEVENTH_TARGET_UPLOAD_INIT_FAILED", "The quarantine upload did not initialize.");
    const session = this.assertUrl(initiate.headers.get("location"), { resumable: true });
    const final = hashDescriptor(temporary.fileDescriptor, sourceObject.sizeBytes);
    if (canonicalJson(before) !== canonicalJson(final)) {
      fail("SEVENTH_SOURCE_DESCRIPTOR_CHANGED", "The seventh source descriptor changed before final upload.");
    }
    const upload = await this.fetchImpl(session, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": String(sourceObject.sizeBytes),
        "content-type": sourceObject.mimeType,
        "content-range": sourceObject.sizeBytes === 0
          ? "bytes */0"
          : `bytes 0-${sourceObject.sizeBytes - 1}/${sourceObject.sizeBytes}`,
        "x-goog-hash": `crc32c=${sourceObject.crc32cBase64},md5=${sourceObject.md5Base64}`,
      },
      body: createReadStream("", {
        fd: temporary.fileDescriptor,
        autoClose: false,
        start: 0,
        ...(sourceObject.sizeBytes > 0 ? { end: sourceObject.sizeBytes - 1 } : {}),
      }),
      duplex: "half",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (upload.status === 412) return { collision: true };
    if (!upload.ok) fail("SEVENTH_TARGET_UPLOAD_FAILED", "The quarantine create-only upload failed.");
    const object = await boundedJson(upload, "SEVENTH_TARGET_UPLOAD_INVALID");
    if (object.crc32c !== sourceObject.crc32cBase64 || object.md5Hash !== sourceObject.md5Base64) {
      fail("SEVENTH_TARGET_UPLOAD_CHECKSUM", "Google Cloud did not confirm the quarantine upload checksums.");
    }
    return { collision: false, object };
  }
}

export const verifySeventhTargetObject = async (gcsClient, sourceObject, targetObject) => {
  const expectedName = seventhTargetObjectKey(sourceObject);
  const expectedMetadata = buildSeventhTargetMetadata(sourceObject);
  requireExactKeys(
    targetObject?.metadata,
    TARGET_METADATA_KEYS,
    "SEVENTH_TARGET_METADATA_INVALID",
    "quarantine target metadata",
  );
  const sizeBytes = Number(targetObject?.size);
  if (
    targetObject?.bucket !== SEVEN_BUCKET_CONTRACT.seventh.targetBucket ||
    targetObject?.name !== expectedName ||
    !/^[1-9]\d*$/.test(targetObject?.generation || "") ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes !== sourceObject.sizeBytes ||
    targetObject?.contentType !== sourceObject.mimeType ||
    targetObject?.cacheControl !== SEVEN_BUCKET_CONTRACT.seventh.targetCacheControl ||
    targetObject?.crc32c !== sourceObject.crc32cBase64 ||
    targetObject?.md5Hash !== sourceObject.md5Base64 ||
    canonicalJson(targetObject.metadata) !== canonicalJson(expectedMetadata)
  ) {
    fail("SEVENTH_TARGET_OBJECT_INVALID", "A quarantine target object failed immutable metadata checks.");
  }
  const hashed = await gcsClient.hashObject(targetObject);
  if (
    hashed.sizeBytes !== sourceObject.sizeBytes ||
    hashed.sha256 !== sourceObject.sha256 ||
    hashed.md5Base64 !== sourceObject.md5Base64 ||
    hashed.crc32cBase64 !== sourceObject.crc32cBase64
  ) {
    fail("SEVENTH_TARGET_OBJECT_INVALID", "A quarantine target object failed byte reconciliation.");
  }
  return {
    objectId: seventhSourceObjectId(sourceObject),
    sourceFingerprintSha256: seventhSourceFingerprint(sourceObject),
    targetObjectKeyDigestSha256: sha256(expectedName),
    generation: targetObject.generation,
    sizeBytes,
    sha256: hashed.sha256,
    crc32cBase64: hashed.crc32cBase64,
    md5Base64: hashed.md5Base64,
  };
};

export const performSeventhCreateOnlyCopy = async ({
  seventhSource,
  sourceClient,
  gcsClient,
  onProgress,
}) => {
  const outcomes = [];
  let createdCount = 0;
  let noopCount = 0;
  for (const [index, sourceObject] of seventhSource.objects.entries()) {
    const objectKey = seventhTargetObjectKey(sourceObject);
    let target = await gcsClient.getObject(SEVEN_BUCKET_CONTRACT.seventh.targetBucket, objectKey);
    let outcome = "NOOP_PRESENT_EXACT";
    if (!target) {
      const temporary = await downloadVerifiedSeventhSource(sourceClient, sourceObject);
      try {
        const uploaded = await gcsClient.uploadCreateOnly({ sourceObject, temporary });
        target = uploaded.collision
          ? await gcsClient.getObject(SEVEN_BUCKET_CONTRACT.seventh.targetBucket, objectKey)
          : uploaded.object;
        if (!target) {
          fail("SEVENTH_TARGET_CREATE_OUTCOME_UNKNOWN", "A quarantine create-only result could not be proven.");
        }
        outcome = uploaded.collision ? "NOOP_PRESENT_EXACT" : "CREATED";
      } finally {
        closeSync(temporary.fileDescriptor);
      }
    }
    const verified = await verifySeventhTargetObject(gcsClient, sourceObject, target);
    createdCount += outcome === "CREATED" ? 1 : 0;
    noopCount += outcome === "NOOP_PRESENT_EXACT" ? 1 : 0;
    outcomes.push({ ...verified, outcome });
    onProgress?.({ completed: index + 1, total: seventhSource.objectCount, objectId: verified.objectId, outcome });
  }
  const liveNamespace = await gcsClient.listObjects();
  const expectedNames = new Set(seventhSource.objects.map(seventhTargetObjectKey));
  const seen = new Set();
  for (const object of liveNamespace) {
    if (!expectedNames.has(object.name) || seen.has(object.name)) {
      fail("SEVENTH_TARGET_NAMESPACE_OCCUPIED", "The final quarantine namespace contains an unknown object.");
    }
    seen.add(object.name);
  }
  if (seen.size !== expectedNames.size || outcomes.length !== seventhSource.objectCount) {
    fail("SEVENTH_TARGET_RECONCILIATION_FAILED", "The quarantine namespace did not fully reconcile.");
  }
  outcomes.sort((left, right) => left.objectId.localeCompare(right.objectId));
  return {
    bucketCount: 1,
    objectCount: outcomes.length,
    totalBytes: outcomes.reduce((sum, object) => sum + object.sizeBytes, 0),
    createdCount,
    noopCount,
    deleteCount: 0,
    overwriteCount: 0,
    sourceMutationCount: 0,
    runtimeRoutingCount: 0,
    objectSetDigestSha256: sha256(canonicalJson(outcomes)),
    objects: outcomes,
  };
};
