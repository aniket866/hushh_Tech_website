import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STORAGE_CUTOVER_CONTRACT,
  parseJsonLines,
  validateSourceInventory,
} from "./storage-cutover-contract.mjs";
import {
  MAXIMUM_PRIVATE_INPUT_BYTES,
  calculateSelfBoundDigest,
  canonicalJson,
  fail,
  readPrivateArtifact,
  requireExactKeys,
  requireIsoTimestamp,
  requireSafeText,
  requireSha256,
  sha256,
} from "./storage-live-common.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const SEVEN_BUCKET_CONTRACT_PATH = resolve(
  moduleDirectory,
  "..",
  "..",
  "migration",
  "storage",
  "supabase-storage-seven-bucket-uat.v1.json",
);

export const SEVEN_BUCKET_ACTIVATION_PATH = resolve(
  moduleDirectory,
  "..",
  "..",
  "migration",
  "storage",
  "supabase-storage-seven-bucket-uat.activation.v1.json",
);

export const SEVEN_BUCKET_CONTRACT = Object.freeze(
  JSON.parse(readFileSync(SEVEN_BUCKET_CONTRACT_PATH, "utf8")),
);

export const SEVEN_BUCKET_ACTIVATION = Object.freeze(
  JSON.parse(readFileSync(SEVEN_BUCKET_ACTIVATION_PATH, "utf8")),
);

export const SEVEN_BUCKET_PLAN_SCHEMA =
  "hushh-tech-storage-seven-bucket-create-only-plan-v1";
export const SEVEN_BUCKET_APPROVAL_SCHEMA =
  "hushh-tech-storage-seven-bucket-approval-v1";
export const ZERO_GRANT_POLICY_EVIDENCE_SCHEMA =
  "hushh-tech-storage-zero-temporary-grant-policy-evidence-v1";
export const SEVEN_BUCKET_RESULT_SCHEMA =
  "hushh-tech-storage-seven-bucket-result-evidence-v1";
export const SEVEN_BUCKET_ACTIVATION_SCHEMA =
  "hushh-tech-storage-seven-bucket-activation-v1";
export const COMBINED_CHANGE_MANIFEST_SCHEMA =
  "hushh-tech-storage-combined-change-manifest-v1";

const ACTIVATION_KEYS = [
  "schemaVersion",
  "contractState",
  "environment",
  "project",
  "contractFileDigestSha256",
  "executionPolicy",
  "activationDigestSha256",
];

const ACTIVATION_EXECUTION_POLICY_KEYS = [
  "createOnly",
  "ifGenerationMatch",
  "sourceMutationAllowed",
  "targetOverwriteAllowed",
  "targetDeleteAllowed",
  "productionMutationAllowed",
  "runtimeRoutingAllowed",
  "executionActivated",
];

const CHANGE_MANIFEST_KEYS = [
  "schemaVersion",
  "environment",
  "project",
  "baseCommitSha",
  "reviewedCommitSha",
  "changedPathCount",
  "changedPaths",
  "manifestDigestSha256",
];

const CHANGE_MANIFEST_ENTRY_KEYS = ["path", "sha256"];

const CONTRACT_KEYS = [
  "schemaVersion",
  "contractState",
  "environment",
  "project",
  "region",
  "productionProject",
  "sourceProjectRef",
  "bucketCount",
  "objectCount",
  "totalBytes",
  "knownSix",
  "seventh",
  "executionPolicy",
  "approvalPolicy",
];

const KNOWN_SIX_KEYS = [
  "contractFileDigestSha256",
  "bucketCount",
  "objectCount",
  "totalBytes",
];

const SEVENTH_KEYS = [
  "sourceBucketIdSha256",
  "sourcePublic",
  "objectCount",
  "totalBytes",
  "maximumObjectBytes",
  "targetBucket",
  "targetPrefix",
  "targetAccessMode",
  "targetCacheControl",
];

const EXECUTION_POLICY_KEYS = [
  "createOnly",
  "ifGenerationMatch",
  "sourceMutationAllowed",
  "targetOverwriteAllowed",
  "targetDeleteAllowed",
  "productionMutationAllowed",
  "runtimeRoutingAllowed",
  "unknownEighthBucketAllowed",
  "twoPassMetadataRequired",
  "contentHashPassRequired",
  "postCopyFullReconciliationRequired",
  "postCopyZeroSourceDeltaRequired",
  "executionActivated",
];

const APPROVAL_POLICY_KEYS = [
  "schemaVersion",
  "reviewerLane",
  "independentReviewerRequired",
  "maximumLifetimeSeconds",
  "exactPlanDigestRequired",
  "exactSourceDigestsRequired",
  "exactPreflightDigestsRequired",
  "zeroTemporaryGrantPolicyHashesRequired",
  "detachedSignatureRequired",
];

const SEVENTH_ARTIFACT_KEYS = [
  "schemaVersion",
  "capturedAt",
  "sourceProjectRef",
  "bucketId",
  "bucketIdSha256",
  "public",
  "objectCount",
  "totalBytes",
  "firstMetadataDigestSha256",
  "secondMetadataDigestSha256",
  "objects",
  "artifactDigestSha256",
];

const SEVENTH_OBJECT_KEYS = [
  "recordType",
  "bucketId",
  "objectKey",
  "sizeBytes",
  "mimeType",
  "sourceUpdatedAt",
  "cacheControl",
  "sha256",
  "md5Base64",
  "crc32cBase64",
];

const ZERO_GRANT_POLICY_KEYS = [
  "schemaVersion",
  "capturedAt",
  "project",
  "operatorPrincipal",
  "migrationServiceAccount",
  "projectPolicyFileDigestSha256",
  "projectPolicyCanonicalDigestSha256",
  "migrationServiceAccountPolicyFileDigestSha256",
  "migrationServiceAccountPolicyCanonicalDigestSha256",
  "operatorStorageAdminBindingCount",
  "migrationTokenCreatorBindingCount",
  "evidenceDigestSha256",
];

const FROZEN_CONTRACT = {
  schemaVersion: "hushh-tech-storage-seven-bucket-contract-v1",
  contractState: "REVIEW_REQUIRED_EXECUTION_DISABLED",
  environment: "uat",
  project: "hushh-tech-uat",
  region: "us-central1",
  productionProject: "hushh-tech-prod",
  sourceProjectRef: "ibsisfnjxeowvdtvgzff",
  bucketCount: 7,
  objectCount: 140,
  totalBytes: 1_574_621_367,
  knownSix: {
    contractFileDigestSha256:
      "2dc544e786df5c640b631a24e5bd43b7e3d5e06c60715f23ab5a872d69fa39ac",
    bucketCount: 6,
    objectCount: 124,
    totalBytes: 111_078_397,
  },
  seventh: {
    sourceBucketIdSha256:
      "2fe7c2abb18b9540ad46b15b3fe9656b6180baa11a778838c85ca207c8feac96",
    sourcePublic: true,
    objectCount: 16,
    totalBytes: 1_463_542_970,
    maximumObjectBytes: 1_073_741_824,
    targetBucket: "hushh-tech-supabase-quarantine-uat",
    targetPrefix:
      "_hushh_migrations/supabase-cutover-v1-quarantine/2fe7c2abb18b9540ad46b15b3fe9656b6180baa11a778838c85ca207c8feac96",
    targetAccessMode: "RESTRICTED_QUARANTINE_NO_RUNTIME_ROUTE",
    targetCacheControl: "private, no-store",
  },
  executionPolicy: {
    createOnly: true,
    ifGenerationMatch: 0,
    sourceMutationAllowed: false,
    targetOverwriteAllowed: false,
    targetDeleteAllowed: false,
    productionMutationAllowed: false,
    runtimeRoutingAllowed: false,
    unknownEighthBucketAllowed: false,
    twoPassMetadataRequired: true,
    contentHashPassRequired: true,
    postCopyFullReconciliationRequired: true,
    postCopyZeroSourceDeltaRequired: true,
    executionActivated: false,
  },
  approvalPolicy: {
    schemaVersion: SEVEN_BUCKET_APPROVAL_SCHEMA,
    reviewerLane: "LANE_7",
    independentReviewerRequired: true,
    maximumLifetimeSeconds: 7_200,
    exactPlanDigestRequired: true,
    exactSourceDigestsRequired: true,
    exactPreflightDigestsRequired: true,
    zeroTemporaryGrantPolicyHashesRequired: true,
    detachedSignatureRequired: true,
  },
};

const FROZEN_ACTIVATION = {
  schemaVersion: SEVEN_BUCKET_ACTIVATION_SCHEMA,
  contractState: "UAT_CREATE_ONLY_ACTIVATED",
  environment: "uat",
  project: "hushh-tech-uat",
  contractFileDigestSha256:
    "89492bb9db5d29ff5b3c1c54e204fbb72039281f7be51db78d33eda0565ab188",
  executionPolicy: {
    createOnly: true,
    ifGenerationMatch: 0,
    sourceMutationAllowed: false,
    targetOverwriteAllowed: false,
    targetDeleteAllowed: false,
    productionMutationAllowed: false,
    runtimeRoutingAllowed: false,
    executionActivated: true,
  },
  activationDigestSha256:
    "ade67e814beeb2279e391e63a5b86bde4143a6bfb89cb4df2eb48f442e208919",
};

export const validateSevenBucketContract = (contract = SEVEN_BUCKET_CONTRACT) => {
  requireExactKeys(contract, CONTRACT_KEYS, "SEVEN_BUCKET_CONTRACT_SCHEMA", "seven-bucket contract");
  requireExactKeys(contract.knownSix, KNOWN_SIX_KEYS, "SEVEN_BUCKET_CONTRACT_SCHEMA", "known-six contract");
  requireExactKeys(contract.seventh, SEVENTH_KEYS, "SEVEN_BUCKET_CONTRACT_SCHEMA", "seventh-bucket contract");
  requireExactKeys(
    contract.executionPolicy,
    EXECUTION_POLICY_KEYS,
    "SEVEN_BUCKET_CONTRACT_SCHEMA",
    "seven-bucket execution policy",
  );
  requireExactKeys(
    contract.approvalPolicy,
    APPROVAL_POLICY_KEYS,
    "SEVEN_BUCKET_CONTRACT_SCHEMA",
    "seven-bucket approval policy",
  );
  if (canonicalJson(contract) !== canonicalJson(FROZEN_CONTRACT)) {
    fail("SEVEN_BUCKET_CONTRACT_DRIFT", "The canonical seven-bucket contract changed.");
  }
  return contract;
};

export const sevenBucketContractFileDigestSha256 = () =>
  sha256(readFileSync(SEVEN_BUCKET_CONTRACT_PATH));

export const sevenBucketActivationFileDigestSha256 = () =>
  sha256(readFileSync(SEVEN_BUCKET_ACTIVATION_PATH));

export const validateSevenBucketActivation = (activation = SEVEN_BUCKET_ACTIVATION) => {
  requireExactKeys(
    activation,
    ACTIVATION_KEYS,
    "SEVEN_BUCKET_ACTIVATION_SCHEMA",
    "seven-bucket activation",
  );
  requireExactKeys(
    activation.executionPolicy,
    ACTIVATION_EXECUTION_POLICY_KEYS,
    "SEVEN_BUCKET_ACTIVATION_SCHEMA",
    "seven-bucket activation policy",
  );
  if (
    canonicalJson(activation) !== canonicalJson(FROZEN_ACTIVATION) ||
    activation.contractFileDigestSha256 !== sevenBucketContractFileDigestSha256() ||
    activation.activationDigestSha256 !==
      calculateSelfBoundDigest(activation, "activationDigestSha256")
  ) {
    fail(
      "SEVEN_BUCKET_ACTIVATION_STATE_MISMATCH",
      "The UAT create-only activation artifact is not the exact reviewed state.",
    );
  }
  return activation;
};

export const validateCombinedChangeManifest = (manifest) => {
  requireExactKeys(
    manifest,
    CHANGE_MANIFEST_KEYS,
    "COMBINED_CHANGE_MANIFEST_SCHEMA",
    "combined change manifest",
  );
  if (
    manifest.schemaVersion !== COMBINED_CHANGE_MANIFEST_SCHEMA ||
    manifest.environment !== "uat" ||
    manifest.project !== "hushh-tech-uat" ||
    !/^[a-f0-9]{40}$/.test(manifest.baseCommitSha || "") ||
    !/^[a-f0-9]{40}$/.test(manifest.reviewedCommitSha || "") ||
    !Number.isSafeInteger(manifest.changedPathCount) ||
    manifest.changedPathCount < 1 ||
    !Array.isArray(manifest.changedPaths) ||
    manifest.changedPaths.length !== manifest.changedPathCount
  ) {
    fail("COMBINED_CHANGE_MANIFEST_INVALID", "The combined change manifest scope is invalid.");
  }
  const paths = [];
  for (const entry of manifest.changedPaths) {
    requireExactKeys(
      entry,
      CHANGE_MANIFEST_ENTRY_KEYS,
      "COMBINED_CHANGE_MANIFEST_SCHEMA",
      "combined change manifest entry",
    );
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > 4_096 ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      /[\0\r\n]/.test(entry.path) ||
      entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      fail("COMBINED_CHANGE_MANIFEST_PATH", "A combined change manifest path is unsafe.");
    }
    requireSha256(entry.sha256, "COMBINED_CHANGE_MANIFEST_DIGEST", "changed-path digest");
    paths.push(entry.path);
  }
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  if (
    new Set(paths).size !== paths.length ||
    canonicalJson(paths) !== canonicalJson(sorted) ||
    manifest.manifestDigestSha256 !==
      calculateSelfBoundDigest(manifest, "manifestDigestSha256")
  ) {
    fail(
      "COMBINED_CHANGE_MANIFEST_DIGEST_MISMATCH",
      "The combined changed-path manifest is not sorted, unique, and self-bound.",
    );
  }
  return manifest;
};

export const readCombinedChangeManifest = (path, expectedFileDigestSha256) => {
  requireSha256(
    expectedFileDigestSha256,
    "COMBINED_CHANGE_MANIFEST_FILE_DIGEST",
    "combined change manifest file digest",
  );
  const artifact = readPrivateArtifact(path, { maximumBytes: 1_048_576 });
  if (artifact.fileDigestSha256 !== expectedFileDigestSha256) {
    fail(
      "COMBINED_CHANGE_MANIFEST_FILE_MISMATCH",
      "The concrete combined change manifest file changed.",
    );
  }
  const manifest = validateCombinedChangeManifest(
    JSON.parse(artifact.bytes.toString("utf8")),
  );
  return { manifest, fileDigestSha256: artifact.fileDigestSha256 };
};

const assertSafeSourceObjectKey = (value) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1_024 ||
    /[\0\r\n]/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("SEVENTH_SOURCE_OBJECT_KEY_INVALID", "A private seventh-bucket object key is invalid.");
  }
  return value;
};

const seventhMetadataRecord = (object) => ({
  recordType: object.recordType,
  bucketId: object.bucketId,
  objectKey: object.objectKey,
  sizeBytes: object.sizeBytes,
  mimeType: object.mimeType,
  sourceUpdatedAt: object.sourceUpdatedAt,
  cacheControl: object.cacheControl,
});

const sortedByRawIdentity = (objects) => [...objects].sort((left, right) =>
  `${left.bucketId}\0${left.objectKey}`.localeCompare(`${right.bucketId}\0${right.objectKey}`));

export const seventhSourceObjectId = (object) =>
  sha256(`${SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256}\0${object.objectKey}`);

export const seventhSourceFingerprint = (object) => sha256(canonicalJson({
  sourceBucketIdSha256: SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256,
  objectKey: object.objectKey,
  sizeBytes: object.sizeBytes,
  mimeType: object.mimeType,
  sourceUpdatedAt: object.sourceUpdatedAt,
  cacheControl: object.cacheControl,
  sha256: object.sha256,
}));

export const seventhTargetObjectKey = (object) => [
  SEVEN_BUCKET_CONTRACT.seventh.targetPrefix,
  seventhSourceObjectId(object),
  seventhSourceFingerprint(object),
].join("/");

export const buildSeventhTargetMetadata = (object) => ({
  "hushh-migration-schema": "supabase-cutover-v1-quarantine",
  "hushh-source-bucket-id-sha256": SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256,
  "hushh-source-object-id": seventhSourceObjectId(object),
  "hushh-source-fingerprint": seventhSourceFingerprint(object),
  "hushh-source-object-key-b64": Buffer.from(object.objectKey, "utf8").toString("base64"),
  "hushh-source-sha256": object.sha256,
  "hushh-source-updated-at": object.sourceUpdatedAt,
  "hushh-source-cache-control-b64": object.cacheControl === null
    ? "-"
    : Buffer.from(object.cacheControl, "utf8").toString("base64"),
  "hushh-access-mode": SEVEN_BUCKET_CONTRACT.seventh.targetAccessMode,
});

export const validateKnownSixSource = (source) => {
  validateSevenBucketContract();
  const buckets = Array.isArray(source?.buckets)
    ? source.buckets
    : source?.bucketRecords;
  const bucketCount = source?.bucketCount ?? buckets?.length;
  if (
    !source ||
    bucketCount !== 6 ||
    source.objectCount !== 124 ||
    source.totalBytes !== 111_078_397 ||
    !Array.isArray(source.objects) ||
    source.objects.length !== 124 ||
    !Array.isArray(buckets) ||
    buckets.length !== 6
  ) {
    fail("KNOWN_SIX_SOURCE_TOTAL_MISMATCH", "The known-six source totals changed.");
  }
  const expectedBuckets = STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => bucket.sourceBucket).sort();
  const actualBuckets = buckets.map((bucket) => bucket.bucketId).sort();
  if (canonicalJson(actualBuckets) !== canonicalJson(expectedBuckets)) {
    fail("KNOWN_SIX_BUCKET_SET_MISMATCH", "The known-six bucket set changed.");
  }
  return source;
};

export const readKnownSixSourceArtifact = (path, expectedFileDigestSha256) => {
  requireSha256(expectedFileDigestSha256, "KNOWN_SIX_FILE_DIGEST_INVALID", "known-six file digest");
  const artifact = readPrivateArtifact(path, { maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES });
  if (artifact.fileDigestSha256 !== expectedFileDigestSha256) {
    fail("KNOWN_SIX_FILE_DIGEST_MISMATCH", "The known-six source file digest changed.");
  }
  const source = validateKnownSixSource(validateSourceInventory(
    parseJsonLines(artifact.bytes.toString("utf8"), "known-six source inventory"),
  ));
  return { source, fileDigestSha256: artifact.fileDigestSha256 };
};

export const validateSeventhSourceArtifact = (artifact, { fileDigestSha256 = null } = {}) => {
  validateSevenBucketContract();
  requireExactKeys(
    artifact,
    SEVENTH_ARTIFACT_KEYS,
    "SEVENTH_SOURCE_SCHEMA_MISMATCH",
    "private seventh-bucket source",
  );
  if (
    artifact.schemaVersion !== "supabase-storage-quarantine-source-v1" ||
    artifact.sourceProjectRef !== SEVEN_BUCKET_CONTRACT.sourceProjectRef ||
    artifact.public !== SEVEN_BUCKET_CONTRACT.seventh.sourcePublic ||
    artifact.objectCount !== SEVEN_BUCKET_CONTRACT.seventh.objectCount ||
    artifact.totalBytes !== SEVEN_BUCKET_CONTRACT.seventh.totalBytes ||
    !Array.isArray(artifact.objects) ||
    artifact.objects.length !== SEVEN_BUCKET_CONTRACT.seventh.objectCount
  ) {
    fail("SEVENTH_SOURCE_TOTAL_MISMATCH", "The private seventh-bucket source totals changed.");
  }
  requireIsoTimestamp(artifact.capturedAt, "SEVENTH_SOURCE_TIME_INVALID", "seventh source capture time");
  requireSafeText(artifact.bucketId, "SEVENTH_SOURCE_ID_INVALID", "private seventh bucket id", 256);
  requireSha256(artifact.bucketIdSha256, "SEVENTH_SOURCE_ID_INVALID", "private seventh bucket id digest");
  if (
    artifact.bucketIdSha256 !== SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256 ||
    sha256(artifact.bucketId) !== artifact.bucketIdSha256
  ) {
    fail("SEVENTH_SOURCE_ID_MISMATCH", "The private seventh-bucket identity does not match its canonical digest.");
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const object of artifact.objects) {
    requireExactKeys(
      object,
      SEVENTH_OBJECT_KEYS,
      "SEVENTH_SOURCE_OBJECT_SCHEMA",
      "private seventh-bucket object",
    );
    if (object.recordType !== "sourceObject" || object.bucketId !== artifact.bucketId) {
      fail("SEVENTH_SOURCE_OBJECT_IDENTITY", "A private seventh-bucket object left its source bucket.");
    }
    assertSafeSourceObjectKey(object.objectKey);
    if (seen.has(object.objectKey)) {
      fail("SEVENTH_SOURCE_DUPLICATE_OBJECT", "The private seventh-bucket source contains a duplicate object.");
    }
    seen.add(object.objectKey);
    if (
      !Number.isSafeInteger(object.sizeBytes) ||
      object.sizeBytes < 0 ||
      object.sizeBytes > SEVEN_BUCKET_CONTRACT.seventh.maximumObjectBytes
    ) {
      fail("SEVENTH_SOURCE_OBJECT_SIZE", "A private seventh-bucket object has an invalid byte count.");
    }
    if (
      typeof object.mimeType !== "string" ||
      object.mimeType.length === 0 ||
      object.mimeType.length > 512 ||
      /[\0\r\n]/.test(object.mimeType) ||
      (object.cacheControl !== null &&
        (typeof object.cacheControl !== "string" ||
          object.cacheControl.length > 1_024 ||
          /[\0\r\n]/.test(object.cacheControl)))
    ) {
      fail("SEVENTH_SOURCE_OBJECT_METADATA", "A private seventh-bucket object has unsafe metadata.");
    }
    requireIsoTimestamp(
      object.sourceUpdatedAt,
      "SEVENTH_SOURCE_OBJECT_TIMESTAMP",
      "private seventh source update time",
    );
    requireSha256(object.sha256, "SEVENTH_SOURCE_OBJECT_DIGEST", "private seventh source SHA-256");
    if (
      !/^[A-Za-z0-9+/]{22}==$/.test(object.md5Base64 || "") ||
      !/^[A-Za-z0-9+/]{6}==$/.test(object.crc32cBase64 || "")
    ) {
      fail("SEVENTH_SOURCE_OBJECT_DIGEST", "A private seventh-bucket checksum is invalid.");
    }
    totalBytes += object.sizeBytes;
    if (!Number.isSafeInteger(totalBytes)) {
      fail("SEVENTH_SOURCE_TOTAL_MISMATCH", "The private seventh-bucket byte total is unsafe.");
    }
  }
  if (totalBytes !== artifact.totalBytes) {
    fail("SEVENTH_SOURCE_TOTAL_MISMATCH", "The private seventh-bucket object bytes did not reconcile.");
  }
  const metadataRecords = sortedByRawIdentity(artifact.objects.map(seventhMetadataRecord));
  const metadataDigestSha256 = sha256(canonicalJson(metadataRecords));
  requireSha256(
    artifact.firstMetadataDigestSha256,
    "SEVENTH_SOURCE_METADATA_DIGEST",
    "first seventh metadata digest",
  );
  requireSha256(
    artifact.secondMetadataDigestSha256,
    "SEVENTH_SOURCE_METADATA_DIGEST",
    "second seventh metadata digest",
  );
  if (
    artifact.firstMetadataDigestSha256 !== metadataDigestSha256 ||
    artifact.secondMetadataDigestSha256 !== metadataDigestSha256
  ) {
    fail("SEVENTH_SOURCE_TWO_PASS_MISMATCH", "The private seventh-bucket two-pass metadata proof changed.");
  }
  requireSha256(artifact.artifactDigestSha256, "SEVENTH_SOURCE_ARTIFACT_DIGEST", "seventh source artifact digest");
  if (fileDigestSha256 !== null) {
    requireSha256(fileDigestSha256, "SEVENTH_SOURCE_FILE_DIGEST", "seventh source file digest");
  }
  const objects = sortedByRawIdentity(artifact.objects);
  const safeObjects = objects.map((object) => ({
    objectId: seventhSourceObjectId(object),
    sourceFingerprintSha256: seventhSourceFingerprint(object),
    sizeBytes: object.sizeBytes,
    sha256: object.sha256,
    md5Base64: object.md5Base64,
    crc32cBase64: object.crc32cBase64,
  }));
  return {
    rawBucketId: artifact.bucketId,
    bucketIdSha256: artifact.bucketIdSha256,
    public: artifact.public,
    objectCount: artifact.objectCount,
    totalBytes: artifact.totalBytes,
    metadataDigestSha256,
    contentSetDigestSha256: sha256(canonicalJson(safeObjects)),
    sourceArtifactDigestSha256: artifact.artifactDigestSha256,
    sourceFileDigestSha256: fileDigestSha256,
    objects,
    safeObjects,
  };
};

export const readSeventhSourceArtifact = (path, expectedFileDigestSha256) => {
  requireSha256(expectedFileDigestSha256, "SEVENTH_SOURCE_FILE_DIGEST", "seventh source file digest");
  const artifact = readPrivateArtifact(path, { maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES });
  if (artifact.fileDigestSha256 !== expectedFileDigestSha256) {
    fail("SEVENTH_SOURCE_FILE_DIGEST_MISMATCH", "The private seventh source file digest changed.");
  }
  let parsed;
  try {
    parsed = JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    fail("SEVENTH_SOURCE_JSON_INVALID", "The private seventh source artifact is not valid JSON.");
  }
  return validateSeventhSourceArtifact(parsed, { fileDigestSha256: artifact.fileDigestSha256 });
};

export const buildCombinedSourceSummary = ({
  knownSource,
  knownSourceFileDigestSha256,
  seventhSource,
}) => {
  validateKnownSixSource(knownSource);
  requireSha256(
    knownSourceFileDigestSha256,
    "KNOWN_SIX_FILE_DIGEST_INVALID",
    "known-six source file digest",
  );
  if (!seventhSource || seventhSource.objectCount !== 16 || seventhSource.totalBytes !== 1_463_542_970) {
    fail("SEVEN_BUCKET_SOURCE_TOTAL_MISMATCH", "The seventh-bucket source summary is invalid.");
  }
  const summary = {
    schemaVersion: "hushh-tech-storage-seven-bucket-source-summary-v1",
    bucketCount: knownSource.bucketCount + 1,
    objectCount: knownSource.objectCount + seventhSource.objectCount,
    totalBytes: knownSource.totalBytes + seventhSource.totalBytes,
    knownSix: {
      sourceInventoryFileDigestSha256: knownSourceFileDigestSha256,
      sourceInventoryDigestSha256: knownSource.digestSha256,
      sourceArtifactDigestSha256: knownSource.sourceArtifactDigestSha256,
      bucketCount: knownSource.bucketCount,
      objectCount: knownSource.objectCount,
      totalBytes: knownSource.totalBytes,
    },
    seventh: {
      sourceBucketIdSha256: seventhSource.bucketIdSha256,
      sourceFileDigestSha256: seventhSource.sourceFileDigestSha256,
      sourceArtifactDigestSha256: seventhSource.sourceArtifactDigestSha256,
      metadataDigestSha256: seventhSource.metadataDigestSha256,
      contentSetDigestSha256: seventhSource.contentSetDigestSha256,
      bucketCount: 1,
      objectCount: seventhSource.objectCount,
      totalBytes: seventhSource.totalBytes,
    },
    combinedSourceDigestSha256: null,
  };
  if (
    summary.bucketCount !== SEVEN_BUCKET_CONTRACT.bucketCount ||
    summary.objectCount !== SEVEN_BUCKET_CONTRACT.objectCount ||
    summary.totalBytes !== SEVEN_BUCKET_CONTRACT.totalBytes
  ) {
    fail("SEVEN_BUCKET_SOURCE_TOTAL_MISMATCH", "The combined source totals changed.");
  }
  summary.combinedSourceDigestSha256 = calculateSelfBoundDigest(
    summary,
    "combinedSourceDigestSha256",
  );
  return summary;
};

export const validateZeroGrantPolicyEvidence = (evidence) => {
  requireExactKeys(
    evidence,
    ZERO_GRANT_POLICY_KEYS,
    "ZERO_GRANT_POLICY_SCHEMA",
    "zero-temporary-grant policy evidence",
  );
  if (
    evidence.schemaVersion !== ZERO_GRANT_POLICY_EVIDENCE_SCHEMA ||
    evidence.project !== "hushh-tech-uat" ||
    evidence.operatorPrincipal !==
      "serviceAccount:claude-code-gcp-operator@hussh-developer-platform.iam.gserviceaccount.com" ||
    evidence.migrationServiceAccount !==
      "hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com" ||
    evidence.operatorStorageAdminBindingCount !== 0 ||
    evidence.migrationTokenCreatorBindingCount !== 0
  ) {
    fail("TEMPORARY_GRANT_PRESENT", "Temporary storage or token-creator access is still present.");
  }
  requireIsoTimestamp(evidence.capturedAt, "ZERO_GRANT_POLICY_TIME", "policy evidence capture time");
  for (const field of [
    "projectPolicyFileDigestSha256",
    "projectPolicyCanonicalDigestSha256",
    "migrationServiceAccountPolicyFileDigestSha256",
    "migrationServiceAccountPolicyCanonicalDigestSha256",
    "evidenceDigestSha256",
  ]) {
    requireSha256(evidence[field], "ZERO_GRANT_POLICY_DIGEST", field);
  }
  if (
    evidence.evidenceDigestSha256 !==
    calculateSelfBoundDigest(evidence, "evidenceDigestSha256")
  ) {
    fail("ZERO_GRANT_POLICY_DIGEST_MISMATCH", "Zero-temporary-grant policy evidence changed.");
  }
  return evidence;
};

export const assertPolicyUnchangedAfterCopy = (before, after) => {
  validateZeroGrantPolicyEvidence(before);
  validateZeroGrantPolicyEvidence(after);
  for (const field of [
    "projectPolicyFileDigestSha256",
    "projectPolicyCanonicalDigestSha256",
    "migrationServiceAccountPolicyFileDigestSha256",
    "migrationServiceAccountPolicyCanonicalDigestSha256",
  ]) {
    if (before[field] !== after[field]) {
      fail("POLICY_CHANGED_DURING_COPY", "A bound IAM policy changed during the copy window.");
    }
  }
  return true;
};
