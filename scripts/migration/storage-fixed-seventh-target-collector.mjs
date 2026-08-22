import {
  SEVEN_BUCKET_CONTRACT,
} from "./storage-seven-bucket-contract.mjs";
import { validateKnownSixTargetPreflight } from "./storage-copy-executor.mjs";
import {
  calculateSelfBoundDigest,
  canonicalJson,
  fail,
  isPlainObject,
  requireIsoTimestamp,
  requireSha256,
  sha256,
} from "./storage-live-common.mjs";

const PROJECT = "hushh-tech-uat";
const PROJECT_NUMBER = "175298245599";
const REGION = "us-central1";
const BUCKET = "hushh-tech-supabase-quarantine-uat";
const NAMESPACE =
  "_hushh_migrations/supabase-cutover-v1-quarantine/2fe7c2abb18b9540ad46b15b3fe9656b6180baa11a778838c85ca207c8feac96";
const RUNTIME_REGIONS = Object.freeze(["asia-south1", "us-central1"]);
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const TAG_HOST = `${REGION}-cloudresourcemanager.googleapis.com`;
const MIGRATION_WRITER_ROLE =
  "projects/hushh-tech-uat/roles/hushhTechStorageCutoverWriter";
const MIGRATION_WRITER =
  "serviceAccount:hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com";
const AUDIT_READER =
  "serviceAccount:hushh-tech-audit-uat@hushh-tech-uat.iam.gserviceaccount.com";
const MAXIMUM_RESPONSE_BYTES = 8_388_608;
const MAXIMUM_COLLECTION_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = "1000";

const EXPECTED_WRITER_PERMISSIONS = Object.freeze([
  "storage.objects.create",
  "storage.objects.get",
  "storage.objects.list",
]);

const EXPECTED_BUCKET_IAM = Object.freeze([
  { role: MIGRATION_WRITER_ROLE, members: [MIGRATION_WRITER], conditionDigestSha256: null },
  { role: "roles/storage.objectViewer", members: [AUDIT_READER], conditionDigestSha256: null },
]);

const EXPECTED_TAG = Object.freeze({
  parent: `//storage.googleapis.com/projects/_/buckets/${BUCKET}`,
  tagValue: "tagValues/281481903057166",
  tagValueNamespacedName:
    "369781862791/storage-isolation/migration-quarantine",
});

const EXPECTED_DENY_RULE = Object.freeze({
  expression:
    "resource.matchTag('369781862791/storage-isolation', 'migration-quarantine')",
  title: "Only migration and audit identities may access tagged quarantine objects",
  deniedPermissions: [
    "storage.googleapis.com/objects.create",
    "storage.googleapis.com/objects.delete",
    "storage.googleapis.com/objects.get",
    "storage.googleapis.com/objects.list",
    "storage.googleapis.com/objects.restore",
    "storage.googleapis.com/objects.update",
  ],
  deniedPrincipals: ["principalSet://goog/public:all"],
  exceptionPrincipals: [
    "principal://iam.googleapis.com/projects/-/serviceAccounts/hushh-tech-audit-uat@hushh-tech-uat.iam.gserviceaccount.com",
    "principal://iam.googleapis.com/projects/-/serviceAccounts/hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com",
  ],
});
const EXPECTED_DENY_POLICY_NAME =
  "policies/cloudresourcemanager.googleapis.com%2Fprojects%2F175298245599/denypolicies/hushh-tech-storage-quarantine";

const boundedJson = async (response, code) => {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)) {
    await response.body?.cancel();
    fail(code, "A fixed GCP response exceeded its byte bound.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAXIMUM_RESPONSE_BYTES) {
    fail(code, "A fixed GCP response exceeded its byte bound.");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "A fixed GCP response was not valid JSON.");
  }
};

const fixedUrl = (base, parameters = {}) => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
};

const exactPage = (payload, field, code) => {
  if (
    !isPlainObject(payload) ||
    (payload.nextPageToken !== undefined && payload.nextPageToken !== "") ||
    (payload.unreachable !== undefined &&
      (!Array.isArray(payload.unreachable) || payload.unreachable.length !== 0)) ||
    !Array.isArray(payload[field])
  ) {
    fail(code, "A fixed GCP inventory was paginated, partial, or malformed.");
  }
  return payload[field];
};

const normalizeBindings = (bindings) => {
  if (!Array.isArray(bindings)) fail("QUARANTINE_IAM_DRIFT", "Quarantine bucket IAM is malformed.");
  return bindings.map((binding) => {
    if (
      !isPlainObject(binding) ||
      typeof binding.role !== "string" ||
      !Array.isArray(binding.members) ||
      binding.members.some((member) => typeof member !== "string")
    ) {
      fail("QUARANTINE_IAM_DRIFT", "Quarantine bucket IAM is malformed.");
    }
    return {
      role: binding.role,
      members: [...binding.members].sort(),
      conditionDigestSha256: binding.condition
        ? sha256(canonicalJson(binding.condition))
        : null,
    };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
};

const normalizedConfiguration = (configuration) => ({
  name: configuration?.name ?? null,
  id: configuration?.id ?? null,
  projectNumber: configuration?.projectNumber === undefined
    ? null
    : String(configuration.projectNumber),
  location: configuration?.location ?? null,
  locationType: configuration?.locationType ?? null,
  storageClass: configuration?.storageClass ?? null,
  labels: configuration?.labels ?? {},
  uniformBucketLevelAccess:
    configuration?.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
  publicAccessPrevention:
    configuration?.iamConfiguration?.publicAccessPrevention ?? null,
  versioningEnabled: configuration?.versioning?.enabled === true,
  retentionPeriodSeconds:
    Number(configuration?.retentionPolicy?.retentionPeriod) || null,
  retentionPolicyLocked: configuration?.retentionPolicy?.isLocked === true,
  softDeleteRetentionSeconds:
    Number(configuration?.softDeletePolicy?.retentionDurationSeconds) || null,
});

const assertConfiguration = (configuration) => {
  const normalized = normalizedConfiguration(configuration);
  if (
    normalized.name !== BUCKET ||
    !new Set([BUCKET, null]).has(normalized.id) ||
    normalized.projectNumber !== PROJECT_NUMBER ||
    normalized.location !== "US-CENTRAL1" ||
    normalized.locationType !== "region" ||
    normalized.storageClass !== "STANDARD" ||
    normalized.uniformBucketLevelAccess !== true ||
    normalized.publicAccessPrevention !== "enforced" ||
    normalized.versioningEnabled !== true ||
    normalized.retentionPeriodSeconds !== 604_800 ||
    normalized.retentionPolicyLocked !== false ||
    normalized.softDeleteRetentionSeconds !== 604_800
  ) {
    fail("QUARANTINE_BUCKET_CONFIGURATION_DRIFT", "The quarantine bucket configuration changed.");
  }
  return normalized;
};

const assertIam = (policy, roleDefinition) => {
  const bindings = normalizeBindings(policy?.bindings);
  const writerPermissions = [...(roleDefinition?.includedPermissions || [])].sort();
  if (
    roleDefinition?.name !== MIGRATION_WRITER_ROLE ||
    canonicalJson(writerPermissions) !== canonicalJson(EXPECTED_WRITER_PERMISSIONS) ||
    bindings.some((binding) =>
      binding.members.includes(MIGRATION_WRITER) &&
      binding.role !== MIGRATION_WRITER_ROLE)
  ) {
    fail(
      "QUARANTINE_WRITER_ROLE_DRIFT",
      "The quarantine writer is not the exact create/get/list custom role.",
    );
  }
  const expected = [...EXPECTED_BUCKET_IAM]
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (canonicalJson(bindings) !== canonicalJson(expected)) {
    fail("QUARANTINE_IAM_DRIFT", "Quarantine bucket IAM changed from the frozen allowlist.");
  }
  return { bindings, writerPermissions };
};

const assertTag = (payload) => {
  const bindings = exactPage(payload, "tagBindings", "QUARANTINE_TAG_BINDING_DRIFT");
  const normalized = bindings.map((binding) => ({
    parent: binding?.parent ?? null,
    tagValue: binding?.tagValue ?? null,
    tagValueNamespacedName: binding?.tagValueNamespacedName ?? null,
  }));
  if (canonicalJson(normalized) !== canonicalJson([EXPECTED_TAG])) {
    fail("QUARANTINE_TAG_BINDING_DRIFT", "The quarantine isolation tag changed.");
  }
  return normalized;
};

const assertDenyPolicy = (policy) => {
  const rules = policy?.rules;
  if (
    policy?.kind !== "DenyPolicy" ||
    policy?.name !== EXPECTED_DENY_POLICY_NAME ||
    policy?.displayName !== "Hushh Tech UAT storage quarantine isolation" ||
    !Array.isArray(rules) ||
    rules.length !== 1
  ) {
    fail("QUARANTINE_DENY_POLICY_DRIFT", "The quarantine deny policy changed.");
  }
  const raw = rules[0]?.denyRule;
  const normalized = {
    expression: raw?.denialCondition?.expression ?? null,
    title: raw?.denialCondition?.title ?? null,
    deniedPermissions: [...(raw?.deniedPermissions || [])].sort(),
    deniedPrincipals: [...(raw?.deniedPrincipals || [])].sort(),
    exceptionPrincipals: [...(raw?.exceptionPrincipals || [])].sort(),
  };
  if (canonicalJson(normalized) !== canonicalJson(EXPECTED_DENY_RULE)) {
    fail("QUARANTINE_DENY_POLICY_DRIFT", "The quarantine deny rule changed.");
  }
  return normalized;
};

const scanStrings = (value, resourceName, path = [], matches = [], depth = 0) => {
  if (depth > 64) fail("QUARANTINE_RUNTIME_INVENTORY_INVALID", "Cloud Run inventory nesting exceeded its bound.");
  if (typeof value === "string") {
    if (value.includes(BUCKET) || value.includes(NAMESPACE)) {
      matches.push({
        resourceNameSha256: sha256(resourceName),
        referencePathSha256: sha256(canonicalJson(path)),
        referenceValueSha256: sha256(value),
      });
    }
    return matches;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanStrings(entry, resourceName, [...path, index], matches, depth + 1));
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      scanStrings(entry, resourceName, [...path, key], matches, depth + 1);
    }
  }
  return matches;
};

const validateSeventhSource = (source) => {
  for (const field of [
    "sourceFileDigestSha256",
    "sourceArtifactDigestSha256",
    "contentSetDigestSha256",
  ]) requireSha256(source?.[field], "SEVENTH_SOURCE_BINDING_INVALID", field);
  if (
    source?.bucketIdSha256 !== SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256 ||
    source?.objectCount !== SEVEN_BUCKET_CONTRACT.seventh.objectCount ||
    source?.totalBytes !== SEVEN_BUCKET_CONTRACT.seventh.totalBytes ||
    !Array.isArray(source?.safeObjects) ||
    source.safeObjects.length !== source.objectCount ||
    sha256(canonicalJson(source.safeObjects)) !== source.contentSetDigestSha256
  ) {
    fail("SEVENTH_SOURCE_BINDING_INVALID", "The seventh source binding changed.");
  }
  return source;
};

export class FixedSeventhTargetReadClient {
  #fetchImpl;
  #accessToken = null;
  #accessTokenPromise = null;
  #allowedUrls = new Set();

  constructor({ fetchImpl = fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      fail("FIXED_GCP_FETCH_INVALID", "The fixed read client requires fetch.");
    }
    this.#fetchImpl = fetchImpl;
    for (const url of this.#baseUrls()) this.#allowedUrls.add(url.href);
  }

  #baseUrls() {
    const urls = [
      fixedUrl(`https://storage.googleapis.com/storage/v1/b/${BUCKET}`, { projection: "full" }),
      fixedUrl(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/iam`),
      fixedUrl(`https://iam.googleapis.com/v1/projects/${PROJECT}/roles/hushhTechStorageCutoverWriter`),
      fixedUrl(`https://${TAG_HOST}/v3/tagBindings`, {
        parent: `//storage.googleapis.com/projects/_/buckets/${BUCKET}`,
        pageSize: "300",
      }),
      fixedUrl(
        `https://iam.googleapis.com/v2/policies/${encodeURIComponent(`cloudresourcemanager.googleapis.com/projects/${PROJECT_NUMBER}`)}/denypolicies/hushh-tech-storage-quarantine`,
      ),
      fixedUrl(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`, {
        prefix: NAMESPACE, projection: "full", maxResults: PAGE_SIZE, versions: "true",
      }),
      fixedUrl(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`, {
        prefix: NAMESPACE, projection: "full", maxResults: PAGE_SIZE, softDeleted: "true",
      }),
      fixedUrl(`https://run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${PROJECT}/services`, {
        limit: PAGE_SIZE,
      }),
      fixedUrl(`https://run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs`, {
        limit: PAGE_SIZE,
      }),
    ];
    for (const region of RUNTIME_REGIONS) {
      urls.push(fixedUrl(`https://run.googleapis.com/v2/projects/${PROJECT}/locations/${region}/services`, {
        pageSize: PAGE_SIZE,
      }));
      urls.push(fixedUrl(`https://run.googleapis.com/v2/projects/${PROJECT}/locations/${region}/jobs`, {
        pageSize: PAGE_SIZE,
      }));
    }
    return urls;
  }

  async #token() {
    if (this.#accessToken) return this.#accessToken;
    if (this.#accessTokenPromise) return this.#accessTokenPromise;
    this.#accessTokenPromise = this.#loadToken();
    try {
      return await this.#accessTokenPromise;
    } finally {
      this.#accessTokenPromise = null;
    }
  }

  async #loadToken() {
    let response;
    try {
      response = await this.#fetchImpl(METADATA_TOKEN_URL, {
        method: "GET",
        headers: { "metadata-flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail("FIXED_GCP_CREDENTIAL_UNAVAILABLE", "The metadata credential is unavailable.");
    }
    if (
      !response?.ok || response.redirected !== false || response.url !== METADATA_TOKEN_URL
    ) {
      fail("FIXED_GCP_CREDENTIAL_UNAVAILABLE", "The metadata credential changed endpoints or failed.");
    }
    const payload = await boundedJson(response, "FIXED_GCP_CREDENTIAL_UNAVAILABLE");
    if (typeof payload?.access_token !== "string" || payload.access_token.length < 20) {
      fail("FIXED_GCP_CREDENTIAL_UNAVAILABLE", "The metadata credential is invalid.");
    }
    this.#accessToken = payload.access_token;
    return this.#accessToken;
  }

  async #getJson(url, code) {
    if (!(url instanceof URL) || !this.#allowedUrls.has(url.href)) {
      fail("FIXED_GCP_ENDPOINT_BLOCKED", "A non-frozen GCP endpoint was blocked.");
    }
    const token = await this.#token();
    let response;
    try {
      response = await this.#fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail(code, "A fixed read-only GCP request failed.");
    }
    if (
      !response?.ok ||
      response.redirected !== false ||
      response.url !== url.href
    ) {
      fail(code, "A fixed read-only GCP request failed or changed endpoints.");
    }
    return boundedJson(response, code);
  }

  readBucketConfiguration() {
    return this.#getJson(this.#baseUrls()[0], "QUARANTINE_BUCKET_CONFIGURATION_READ_FAILED");
  }

  readBucketIam() {
    return this.#getJson(this.#baseUrls()[1], "QUARANTINE_IAM_READ_FAILED");
  }

  readWriterRole() {
    return this.#getJson(this.#baseUrls()[2], "QUARANTINE_WRITER_ROLE_READ_FAILED");
  }

  readTagBindings() {
    return this.#getJson(this.#baseUrls()[3], "QUARANTINE_TAG_BINDING_READ_FAILED");
  }

  readDenyPolicy() {
    return this.#getJson(this.#baseUrls()[4], "QUARANTINE_DENY_POLICY_READ_FAILED");
  }

  async readNamespaceEvidence() {
    const urls = this.#baseUrls();
    const pages = await Promise.all([
      this.#getJson(urls[5], "QUARANTINE_NAMESPACE_READ_FAILED"),
      this.#getJson(urls[6], "QUARANTINE_NAMESPACE_READ_FAILED"),
    ]);
    const seen = new Set();
    const evidence = [];
    for (const [index, payload] of pages.entries()) {
      if (
        !isPlainObject(payload) ||
        payload.kind !== "storage#objects" ||
        (payload.nextPageToken !== undefined && payload.nextPageToken !== "") ||
        (payload.prefixes !== undefined &&
          (!Array.isArray(payload.prefixes) || payload.prefixes.length !== 0)) ||
        (payload.items !== undefined && !Array.isArray(payload.items))
      ) {
        fail("QUARANTINE_NAMESPACE_PARTIAL", "The exact namespace inventory was partial or malformed.");
      }
      for (const object of payload.items || []) {
        const sizeBytes = Number(object?.size);
        const identity = `${object?.name}\0${object?.generation}`;
        if (
          typeof object?.name !== "string" ||
          !(object.name === NAMESPACE || object.name.startsWith(`${NAMESPACE}/`)) ||
          (object.bucket !== undefined && object.bucket !== BUCKET) ||
          !/^[1-9]\d*$/.test(object?.generation || "") ||
          !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 ||
          seen.has(identity)
        ) {
          fail("QUARANTINE_NAMESPACE_INVALID", "The exact namespace contained invalid or duplicate evidence.");
        }
        seen.add(identity);
        evidence.push({
          nameSha256: sha256(object.name),
          generation: object.generation,
          sizeBytes,
          state: index === 0 ? "ACTIVE_OR_NONCURRENT" : "SOFT_DELETED",
        });
      }
    }
    if (evidence.length !== 0) {
      fail("QUARANTINE_NAMESPACE_NOT_EMPTY", "The exact quarantine namespace contains an object version.");
    }
    return {
      objectCount: 0,
      totalBytes: 0,
      digestSha256: sha256(canonicalJson(evidence)),
    };
  }

  async readRuntimeEvidence() {
    const scans = [];
    const references = [];
    const identities = new Set();
    const discovered = new Set();
    const runtimeUrls = this.#baseUrls();
    const [globalServices, globalJobs] = await Promise.all([
      this.#getJson(runtimeUrls[7], "QUARANTINE_RUNTIME_DISCOVERY_FAILED"),
      this.#getJson(runtimeUrls[8], "QUARANTINE_RUNTIME_DISCOVERY_FAILED"),
    ]);
    const discover = (payload, kind) => {
      if (
        !isPlainObject(payload) ||
        !Array.isArray(payload.items) ||
        (payload.unreachable !== undefined &&
          (!Array.isArray(payload.unreachable) || payload.unreachable.length !== 0)) ||
        (payload.metadata?.continue !== undefined && payload.metadata.continue !== "")
      ) {
        fail("QUARANTINE_RUNTIME_DISCOVERY_PARTIAL", "Global Cloud Run discovery was partial or paginated.");
      }
      for (const resource of payload.items) {
        const id = resource?.metadata?.name;
        const namespace = resource?.metadata?.namespace;
        const region = resource?.metadata?.labels?.["cloud.googleapis.com/location"];
        if (
          typeof id !== "string" ||
          !/^[a-z][a-z0-9-]{0,62}$/.test(id) ||
          namespace !== PROJECT ||
          !RUNTIME_REGIONS.includes(region)
        ) {
          fail("QUARANTINE_RUNTIME_REGION_DRIFT", "Cloud Run discovery found an unknown region or identity.");
        }
        const identity = `${kind}\0${region}\0${id}`;
        if (discovered.has(identity)) {
          fail("QUARANTINE_RUNTIME_INVENTORY_INVALID", "Global Cloud Run discovery contained a duplicate.");
        }
        discovered.add(identity);
        scans.push({ kind: `${kind}-discovery`, nameSha256: sha256(identity), digestSha256: sha256(canonicalJson(resource)) });
        references.push(...scanStrings(resource, identity));
      }
    };
    discover(globalServices, "service");
    discover(globalJobs, "job");
    const regionallyListed = new Set();
    for (const region of RUNTIME_REGIONS) {
      const serviceUrl = fixedUrl(
        `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${region}/services`,
        { pageSize: PAGE_SIZE },
      );
      const jobUrl = fixedUrl(
        `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${region}/jobs`,
        { pageSize: PAGE_SIZE },
      );
      const [servicePayload, jobPayload] = await Promise.all([
        this.#getJson(serviceUrl, "QUARANTINE_RUNTIME_INVENTORY_FAILED"),
        this.#getJson(jobUrl, "QUARANTINE_RUNTIME_INVENTORY_FAILED"),
      ]);
      const services = exactPage(servicePayload, "services", "QUARANTINE_RUNTIME_INVENTORY_INVALID");
      const jobs = exactPage(jobPayload, "jobs", "QUARANTINE_RUNTIME_INVENTORY_INVALID");
      for (const service of services) {
        const name = service?.name;
        const pattern = new RegExp(`^projects/${PROJECT}/locations/${region}/services/[a-z][a-z0-9-]{0,62}$`);
        if (typeof name !== "string" || !pattern.test(name) || identities.has(name)) {
          fail("QUARANTINE_RUNTIME_INVENTORY_INVALID", "A Cloud Run service identity was invalid or duplicated.");
        }
        identities.add(name);
        regionallyListed.add(`service\0${region}\0${name.slice(name.lastIndexOf("/") + 1)}`);
        scans.push({ kind: "service", nameSha256: sha256(name), digestSha256: sha256(canonicalJson(service)) });
        references.push(...scanStrings(service, name));
        const revisionUrl = fixedUrl(`https://run.googleapis.com/v2/${name}/revisions`, {
          pageSize: PAGE_SIZE,
        });
        this.#allowedUrls.add(revisionUrl.href);
        const revisionPayload = await this.#getJson(
          revisionUrl,
          "QUARANTINE_RUNTIME_INVENTORY_FAILED",
        );
        const revisions = exactPage(
          revisionPayload,
          "revisions",
          "QUARANTINE_RUNTIME_INVENTORY_INVALID",
        );
        for (const revision of revisions) {
          const revisionName = revision?.name;
          if (
            typeof revisionName !== "string" ||
            !revisionName.startsWith(`${name}/revisions/`) ||
            identities.has(revisionName)
          ) {
            fail("QUARANTINE_RUNTIME_INVENTORY_INVALID", "A Cloud Run revision identity was invalid or duplicated.");
          }
          identities.add(revisionName);
          scans.push({ kind: "revision", nameSha256: sha256(revisionName), digestSha256: sha256(canonicalJson(revision)) });
          references.push(...scanStrings(revision, revisionName));
        }
      }
      for (const job of jobs) {
        const name = job?.name;
        const pattern = new RegExp(`^projects/${PROJECT}/locations/${region}/jobs/[a-z][a-z0-9-]{0,62}$`);
        if (typeof name !== "string" || !pattern.test(name) || identities.has(name)) {
          fail("QUARANTINE_RUNTIME_INVENTORY_INVALID", "A Cloud Run job identity was invalid or duplicated.");
        }
        identities.add(name);
        regionallyListed.add(`job\0${region}\0${name.slice(name.lastIndexOf("/") + 1)}`);
        scans.push({ kind: "job", nameSha256: sha256(name), digestSha256: sha256(canonicalJson(job)) });
        references.push(...scanStrings(job, name));
      }
    }
    if (canonicalJson([...discovered].sort()) !== canonicalJson([...regionallyListed].sort())) {
      fail("QUARANTINE_RUNTIME_DISCOVERY_MISMATCH", "Global and regional Cloud Run inventories did not reconcile.");
    }
    scans.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    references.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    if (references.length !== 0) {
      fail("QUARANTINE_RUNTIME_REFERENCE_ACTIVE", "A Cloud Run service, revision, or job references quarantine storage.");
    }
    return {
      referenceCount: 0,
      digestSha256: sha256(canonicalJson({ regions: RUNTIME_REGIONS, scans, references })),
    };
  }
}

const resolveClock = (now) => {
  if (now === undefined) return Date.now;
  if (typeof now === "function") return now;
  if (Number.isSafeInteger(now) && now >= 0) return () => now;
  fail("QUARANTINE_COLLECTION_CLOCK_INVALID", "The collection clock is invalid.");
};

export const collectFixedSeventhTargetPreflight = async ({
  client = new FixedSeventhTargetReadClient(),
  seventhSource,
  now,
} = {}) => {
  if (!(client instanceof FixedSeventhTargetReadClient)) {
    fail("FIXED_SEVENTH_CLIENT_REQUIRED", "The concrete fixed seventh-target read client is required.");
  }
  const source = validateSeventhSource(seventhSource);
  const clock = resolveClock(now);
  const startedMs = clock();
  if (!Number.isSafeInteger(startedMs) || startedMs < 0) {
    fail("QUARANTINE_COLLECTION_CLOCK_INVALID", "The collection start time is invalid.");
  }
  const [configuration, policy, role, tagPayload, denyPolicy, namespace, runtime] =
    await Promise.all([
      client.readBucketConfiguration(),
      client.readBucketIam(),
      client.readWriterRole(),
      client.readTagBindings(),
      client.readDenyPolicy(),
      client.readNamespaceEvidence(),
      client.readRuntimeEvidence(),
    ]);
  const completedMs = clock();
  const durationMs = completedMs - startedMs;
  if (
    !Number.isSafeInteger(completedMs) ||
    completedMs < 0 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > MAXIMUM_COLLECTION_MS
  ) {
    fail("QUARANTINE_COLLECTION_DURATION_INVALID", "The seventh-target collection exceeded five minutes.");
  }
  assertConfiguration(configuration);
  const iam = assertIam(policy, role);
  const tags = assertTag(tagPayload);
  const deny = assertDenyPolicy(denyPolicy);
  const collectionStartedAt = new Date(startedMs).toISOString();
  const collectionCompletedAt = new Date(completedMs).toISOString();
  const artifact = {
    schemaVersion: "gcs-storage-quarantine-preflight-v2",
    capturedAt: collectionCompletedAt,
    collectionStartedAt,
    collectionCompletedAt,
    collectionDurationMs: durationMs,
    project: PROJECT,
    bucket: BUCKET,
    namespace: NAMESPACE,
    sourceFileDigestSha256: source.sourceFileDigestSha256,
    sourceArtifactDigestSha256: source.sourceArtifactDigestSha256,
    sourceContentSetDigestSha256: source.contentSetDigestSha256,
    sourceObjectCount: source.objectCount,
    sourceTotalBytes: source.totalBytes,
    configurationDigestSha256: sha256(canonicalJson(configuration)),
    iamDigestSha256: sha256(canonicalJson(iam)),
    tagBindingsDigestSha256: sha256(canonicalJson(tags)),
    denyPolicyDigestSha256: sha256(canonicalJson(deny)),
    runtimeReferenceDigestSha256: runtime.digestSha256,
    namespaceObjectSetDigestSha256: namespace.digestSha256,
    runtimeRoutingReferenceCount: runtime.referenceCount,
    namespaceObjectCount: namespace.objectCount,
    namespaceTotalBytes: namespace.totalBytes,
    configurationSafe: true,
    bucketIamExact: true,
    tagIsolationBound: true,
    denyPolicyActive: true,
    createOnly: true,
    ifGenerationMatch: 0,
    overwriteAllowed: false,
    deleteAllowed: false,
    safeForCopy: true,
    preflightDigestSha256: null,
  };
  artifact.preflightDigestSha256 = calculateSelfBoundDigest(artifact, "preflightDigestSha256");
  return artifact;
};

export const buildFixedAllSevenTargetPreflight = ({
  knownSource,
  knownSixPreflight,
  seventhPreflight,
}) => {
  const validatedKnownSix = validateKnownSixTargetPreflight(
    knownSixPreflight,
    knownSource,
  );
  if (
    validatedKnownSix.migrationWriterRoleExact !== true ||
    validatedKnownSix.existingMigrationObjectCount !== 0 ||
    validatedKnownSix.unmanagedObjectCount !== 0 ||
    validatedKnownSix.unmanagedTotalBytes !== 0 ||
    validatedKnownSix.retainedHistoricalObjectCount !== 0 ||
    validatedKnownSix.retainedHistoricalTotalBytes !== 0 ||
    canonicalJson(validatedKnownSix.blockers) !== canonicalJson([
      "COPY_POLICY_NOT_ACTIVATED",
      "COPY_EXECUTION_NOT_ALLOWED",
    ]) ||
    validatedKnownSix.safeForCopy !== false ||
    validatedKnownSix.buckets.some((bucketEvidence) =>
      bucketEvidence.bucketConfigurationSafe !== true ||
      bucketEvidence.iamMatchesFrozenAllowlist !== true ||
      bucketEvidence.isolationSafe !== true ||
      bucketEvidence.inheritedAccessNeutralized !== true ||
      bucketEvidence.existingMigrationObjectCount !== 0 ||
      bucketEvidence.unknownMigrationObjectCount !== 0 ||
      bucketEvidence.unmanagedObjectCount !== 0 ||
      bucketEvidence.retainedHistoricalObjectCount !== 0)
  ) {
    fail("KNOWN_SIX_FRESH_PREFLIGHT_INVALID", "The separately collected known-six preflight is invalid.");
  }
  requireIsoTimestamp(knownSixPreflight.collectedAt, "KNOWN_SIX_FRESH_PREFLIGHT_INVALID", "known-six collection time");
  if (
    seventhPreflight?.schemaVersion !== "gcs-storage-quarantine-preflight-v2" ||
    seventhPreflight?.preflightDigestSha256 !==
      calculateSelfBoundDigest(seventhPreflight, "preflightDigestSha256") ||
    seventhPreflight?.safeForCopy !== true
  ) {
    fail("SEVENTH_FRESH_PREFLIGHT_INVALID", "The fixed seventh preflight is invalid.");
  }
  const capturedAt = new Date(Math.max(
    Date.parse(knownSixPreflight.collectedAt),
    Date.parse(seventhPreflight.collectionCompletedAt),
  )).toISOString();
  const artifact = {
    schemaVersion: "hushh-tech-storage-all-seven-target-preflight-v2",
    capturedAt,
    project: PROJECT,
    region: REGION,
    knownSixPreflight,
    seventhPreflight,
    preflightDigestSha256: null,
  };
  artifact.preflightDigestSha256 = calculateSelfBoundDigest(artifact, "preflightDigestSha256");
  const raw = Buffer.from(canonicalJson(artifact), "utf8");
  return {
    artifact,
    raw,
    fileDigestSha256: sha256(raw),
  };
};
