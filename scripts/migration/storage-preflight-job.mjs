#!/usr/bin/env node

import {
  collectLiveTargetPreflight,
} from "./storage-live-inventory.mjs";
import {
  STORAGE_CUTOVER_CONTRACT,
  parseJsonLines,
} from "./storage-cutover-contract.mjs";
import {
  ISOLATED_CUTOVER_CONTRACT,
  validateIsolatedBucketAccessEvidence,
} from "./storage-isolated-cutover-contract.mjs";
import {
  calculateSelfBoundDigest,
  canonicalJson,
  fail,
  requireExactKeys,
  requireSha256,
  sha256,
} from "./storage-live-common.mjs";

const PROJECT = "hushh-tech-uat";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const MAXIMUM_INPUT_BYTES = 1_048_576;
const MAXIMUM_RESPONSE_BYTES = 8_388_608;
const REQUEST_TIMEOUT_MS = 30_000;
const ALLOWED_HTTPS_HOSTS = new Set([
  "storage.googleapis.com",
  "iam.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "secretmanager.googleapis.com",
]);

const parseBoundedJson = async (response, code) => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAXIMUM_RESPONSE_BYTES) {
    await response.body?.cancel();
    fail(code, "A provider response exceeded its byte bound.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAXIMUM_RESPONSE_BYTES) {
    fail(code, "A provider response exceeded its byte bound.");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "A provider response was not valid JSON.");
  }
};

const normalizedBindings = (bindings = [], scope = null) => bindings.map((binding) => ({
  role: binding.role,
  members: [...(binding.members || [])].sort(),
  conditionDigestSha256: binding.condition
    ? sha256(canonicalJson(binding.condition))
    : null,
  ...(scope ? { scope } : {}),
})).sort((left, right) =>
  `${left.scope || ""}\0${left.role}\0${left.conditionDigestSha256 || ""}`.localeCompare(
    `${right.scope || ""}\0${right.role}\0${right.conditionDigestSha256 || ""}`,
  ));

export class InCloudStoragePreflightClient {
  constructor({ fetchImpl = fetch, inheritedBindings }) {
    if (!Array.isArray(inheritedBindings)) {
      fail("PREFLIGHT_JOB_INPUT_INVALID", "Inherited storage IAM evidence is missing.");
    }
    this.fetchImpl = fetchImpl;
    this.inheritedBindings = inheritedBindings;
    this.accessToken = null;
    this.denyPolicy = null;
    this.migrationWriterRoleDefinition = null;
  }

  async readSecureInput(secretVersion, expectedFileDigestSha256) {
    if (
      typeof secretVersion !== "string" ||
      !/^projects\/hushh-tech-uat\/secrets\/hushh-tech-storage-preflight-input-[a-f0-9]{12}\/versions\/[1-9]\d*$/.test(
        secretVersion,
      )
    ) {
      fail("PREFLIGHT_JOB_SECRET_LOCATOR_INVALID", "The secure input must use an exact numbered UAT secret version.");
    }
    requireSha256(
      expectedFileDigestSha256,
      "PREFLIGHT_JOB_SECRET_DIGEST_INVALID",
      "secure input file digest",
    );
    const payload = await this.getJson(
      `https://secretmanager.googleapis.com/v1/${secretVersion}:access`,
      "PREFLIGHT_JOB_SECRET_ACCESS_FAILED",
    );
    const encoded = payload?.payload?.data;
    if (
      typeof encoded !== "string" ||
      encoded.length === 0 ||
      encoded.length > MAXIMUM_INPUT_BYTES ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    ) {
      fail("PREFLIGHT_JOB_SECRET_INVALID", "The secure input payload is not bounded base64.");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.length > MAXIMUM_INPUT_BYTES ||
      bytes.toString("base64") !== encoded ||
      sha256(bytes) !== expectedFileDigestSha256
    ) {
      fail("PREFLIGHT_JOB_SECRET_INVALID", "The secure input payload failed its exact file digest.");
    }
    let bundle;
    try {
      bundle = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("PREFLIGHT_JOB_SECRET_INVALID", "The secure input payload is not valid JSON.");
    }
    requireExactKeys(
      bundle,
      [
        "schemaVersion",
        "sourceInventoryJsonLines",
        "inheritedBindings",
        "bundleDigestSha256",
      ],
      "PREFLIGHT_JOB_SECRET_INVALID",
      "secure input bundle",
    );
    if (
      bundle.schemaVersion !== "hushh-tech-storage-preflight-secure-input-v1" ||
      typeof bundle.sourceInventoryJsonLines !== "string" ||
      Buffer.byteLength(bundle.sourceInventoryJsonLines, "utf8") > MAXIMUM_INPUT_BYTES ||
      !Array.isArray(bundle.inheritedBindings) ||
      bundle.bundleDigestSha256 !== calculateSelfBoundDigest(bundle, "bundleDigestSha256")
    ) {
      fail("PREFLIGHT_JOB_SECRET_INVALID", "The secure input bundle changed.");
    }
    return bundle;
  }

  async token() {
    if (this.accessToken) return this.accessToken;
    let response;
    try {
      response = await this.fetchImpl(METADATA_TOKEN_URL, {
        method: "GET",
        headers: { "metadata-flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail("LIVE_CREDENTIAL_UNAVAILABLE", "The read-only in-cloud credential is unavailable.");
    }
    if (!response.ok) fail("LIVE_CREDENTIAL_UNAVAILABLE", "The read-only in-cloud credential is unavailable.");
    const payload = await parseBoundedJson(response, "LIVE_CREDENTIAL_UNAVAILABLE");
    if (typeof payload.access_token !== "string" || payload.access_token.length < 20) {
      fail("LIVE_CREDENTIAL_UNAVAILABLE", "The read-only in-cloud credential is unavailable.");
    }
    this.accessToken = payload.access_token;
    return this.accessToken;
  }

  async getJson(url, code) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !ALLOWED_HTTPS_HOSTS.has(parsed.hostname)
    ) {
      fail("PREFLIGHT_JOB_ENDPOINT_BLOCKED", "A non-read-only provider endpoint was blocked.");
    }
    const response = await this.fetchImpl(parsed, {
      method: "GET",
      headers: { authorization: `Bearer ${await this.token()}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) fail(code, `A read-only provider request failed with status ${response.status}.`);
    return parseBoundedJson(response, code);
  }

  getBucket(bucketName) {
    return this.getJson(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}?projection=full`,
      "TARGET_BUCKET_READ_FAILED",
    );
  }

  getBucketIam(bucketName) {
    return this.getJson(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/iam`,
      "TARGET_IAM_READ_FAILED",
    );
  }

  async listObjects(bucketName) {
    const objects = [];
    let pageToken = null;
    const seenTokens = new Set();
    do {
      const url = new URL(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o`,
      );
      url.searchParams.set("maxResults", "1000");
      url.searchParams.set("projection", "full");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const payload = await this.getJson(url, "TARGET_OBJECT_LIST_FAILED");
      if (payload.items !== undefined && !Array.isArray(payload.items)) {
        fail("TARGET_OBJECT_LIST_INVALID", "The target object list is invalid.");
      }
      objects.push(...(payload.items || []));
      if (objects.length !== 0) {
        fail("PREFLIGHT_JOB_TARGET_NOT_EMPTY", "A known-six isolated target bucket is not empty.");
      }
      pageToken = payload.nextPageToken ?? null;
      if (
        pageToken !== null &&
        (typeof pageToken !== "string" ||
          pageToken.length === 0 ||
          pageToken.length > 4096 ||
          seenTokens.has(pageToken))
      ) {
        fail("TARGET_OBJECT_PAGE_TOKEN_INVALID", "The target object page token is invalid.");
      }
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return objects;
  }

  hashObject() {
    fail("PREFLIGHT_JOB_OBJECT_DOWNLOAD_BLOCKED", "The preflight-only job cannot download object bytes.");
  }

  async initialize() {
    this.migrationWriterRoleDefinition = await this.getJson(
      "https://iam.googleapis.com/v1/projects/hushh-tech-uat/roles/hushhTechStorageCutoverWriter",
      "TARGET_MIGRATION_WRITER_ROLE_UNRESOLVED",
    );
  }

  roleDefinition(role) {
    if (role !== ISOLATED_CUTOVER_CONTRACT.migrationWriterRole) {
      fail("PREFLIGHT_JOB_ROLE_BLOCKED", "Only the frozen migration writer role may be inspected.");
    }
    if (!this.migrationWriterRoleDefinition) {
      fail("TARGET_MIGRATION_WRITER_ROLE_UNRESOLVED", "The migration writer role was not initialized.");
    }
    return this.migrationWriterRoleDefinition;
  }

  inspectIam(bucketPolicy) {
    return {
      bucketBindings: normalizedBindings(bucketPolicy.bindings || []),
      inheritedBindings: this.inheritedBindings,
    };
  }

  async inspectIsolation(bucketName, inheritedBindings) {
    const parent = `//storage.googleapis.com/projects/_/buckets/${bucketName}`;
    const tagUrl = new URL("https://cloudresourcemanager.googleapis.com/v3/tagBindings");
    tagUrl.searchParams.set("parent", parent);
    tagUrl.searchParams.set("pageSize", "100");
    const tagPayload = await this.getJson(tagUrl, "TARGET_TAG_BINDING_READ_FAILED");
    if (tagPayload.nextPageToken) {
      fail("TARGET_TAG_BINDING_READ_FAILED", "The isolated tag binding set exceeded one bounded page.");
    }
    if (!this.denyPolicy) {
      const attachment = encodeURIComponent(
        `cloudresourcemanager.googleapis.com/projects/${ISOLATED_CUTOVER_CONTRACT.projectNumber}`,
      );
      this.denyPolicy = await this.getJson(
        `https://iam.googleapis.com/v2/policies/${attachment}/denypolicies/${ISOLATED_CUTOVER_CONTRACT.denyPolicyId}`,
        "TARGET_DENY_POLICY_READ_FAILED",
      );
    }
    return validateIsolatedBucketAccessEvidence({
      bucketName,
      tagBindings: tagPayload.tagBindings || [],
      denyPolicy: this.denyPolicy,
      inheritedBindings,
    });
  }
}

export const runStoragePreflightJob = async ({ env = process.env, fetchImpl = fetch } = {}) => {
  if (env.EXECUTE !== "true") {
    return { executed: false, output: null };
  }
  if (env.GOOGLE_CLOUD_PROJECT !== undefined && env.GOOGLE_CLOUD_PROJECT !== PROJECT) {
    fail("PREFLIGHT_JOB_PROJECT_BLOCKED", "The preflight job is restricted to hushh-tech-uat.");
  }
  if (
    Object.hasOwn(env, "SOURCE_INVENTORY_GZIP_BASE64") ||
    Object.hasOwn(env, "INHERITED_STORAGE_BINDINGS_GZIP_BASE64")
  ) {
    fail("PREFLIGHT_JOB_PRIVATE_ENV_BLOCKED", "Private preflight input cannot be supplied through environment variables.");
  }
  const client = new InCloudStoragePreflightClient({ fetchImpl, inheritedBindings: [] });
  const secureInput = await client.readSecureInput(
    env.SECURE_INPUT_SECRET_VERSION,
    env.SECURE_INPUT_FILE_DIGEST_SHA256,
  );
  const sourceRecords = parseJsonLines(
    secureInput.sourceInventoryJsonLines,
    "known-six source inventory",
  );
  client.inheritedBindings = secureInput.inheritedBindings;
  await client.initialize();
  const artifact = await collectLiveTargetPreflight({
    gcsClient: client,
    sourceRecords,
  });
  if (
    artifact.bucketCount !== STORAGE_CUTOVER_CONTRACT.buckets.length ||
    artifact.existingMigrationObjectCount !== 0 ||
    artifact.unmanagedObjectCount !== 0 ||
    artifact.unmanagedTotalBytes !== 0 ||
    artifact.retainedHistoricalObjectCount !== 0 ||
    artifact.retainedHistoricalTotalBytes !== 0 ||
    artifact.buckets.some((bucket) =>
      bucket.existingMigrationObjectCount !== 0 ||
      bucket.unmanagedObjectCount !== 0 ||
      bucket.unmanagedTotalBytes !== 0)
  ) {
    fail("PREFLIGHT_JOB_TARGET_NOT_EMPTY", "The known-six isolated target set is not exactly empty.");
  }
  return { executed: true, output: canonicalJson(artifact) };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runStoragePreflightJob()
    .then((result) => {
      if (result.executed) process.stdout.write(`${result.output}\n`);
    })
    .catch((error) => {
      const code = typeof error?.code === "string" ? error.code : "PREFLIGHT_JOB_FAILED";
      process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    });
}
