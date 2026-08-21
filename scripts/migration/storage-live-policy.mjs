import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STORAGE_CUTOVER_CONTRACT,
  safeContractSummary,
} from "./storage-cutover-contract.mjs";
import {
  REPOSITORY_ROOT,
  canonicalJson,
  contractFileDigestSha256,
  fail,
  requireExactKeys,
  sha256,
} from "./storage-live-common.mjs";

export const COPY_POLICY_CANDIDATE_PATH = resolve(
  REPOSITORY_ROOT,
  "migration/storage/supabase-storage-copy-policy.candidate.v1.json",
);
export const COPY_POLICY_CANDIDATE = Object.freeze(
  JSON.parse(readFileSync(COPY_POLICY_CANDIDATE_PATH, "utf8")),
);

const FROZEN_CANDIDATE_KEYS = [
  "schemaVersion",
  "candidateState",
  "baseContractCanonicalDigestSha256",
  "baseContractFileDigestSha256",
  "environment",
  "project",
  "region",
  "productionProject",
  "readOnlyCollectorsAllowedWithExplicitFlag",
  "executionActivated",
  "copyExecutionAllowed",
  "productionExecutionAllowed",
  "sourceMutationAllowed",
  "targetOverwriteAllowed",
  "targetDeleteAllowed",
  "activationRequires",
  "copyPolicy",
];

const FROZEN_COPY_POLICY = {
  schemaVersion: "gcs-create-only-copy-v1",
  migrationNamespace: "_hushh_migrations/supabase-cutover-v1",
  targetObjectKeyAlgorithm:
    "migrationNamespace + '/' + sourceBucket + '/' + sha256(bucketId + NUL + objectKey) + '/' + sourceFingerprintSha256",
  sourceFingerprintAlgorithm:
    "sha256(canonicalJson({bucketId,objectKey,sizeBytes,mimeType,sourceUpdatedAt,cacheControl,sha256}))",
  immutableVersionedKeys: true,
  deltaReplayPolicy:
    "NEW_FINGERPRINT_CREATE_ONLY_UNCHANGED_NOOP_TOMBSTONE_RETAIN_NO_DELETE",
  targetMetadataScope:
    "IMMUTABLE_SOURCE_VERSION_ONLY_SNAPSHOT_BINDINGS_IN_RESULT_EVIDENCE",
  databasePointerManifestRequired: true,
  tombstoneDisposition: "RETAIN_IMMUTABLE_TARGET_NO_DELETE",
  dryRunDefault: true,
  explicitExecuteFlagRequired: true,
  exactArtifactDigestsRequired: true,
  reviewedGitHubApprovalRequired: true,
  createOnly: true,
  ifGenerationMatch: 0,
  overwriteAllowed: false,
  deleteAllowed: false,
  maximumApprovalLifetimeSeconds: 7_200,
  writerServiceAccount:
    "hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com",
  approvalRepository: "hushh-labs/hushh_Tech_website",
  approvalReviewerAllowlist: ["ankitkumarsingh1702", "Jhumma-hushh"],
  approvalReviewMarkerPrefix: "HUSHH_STORAGE_UAT_COPY_APPROVAL:",
};

export const validateCopyPolicyCandidate = (candidate = COPY_POLICY_CANDIDATE) => {
  requireExactKeys(
    candidate,
    FROZEN_CANDIDATE_KEYS,
    "COPY_POLICY_CANDIDATE_SCHEMA_MISMATCH",
    "copy policy candidate",
  );
  const contract = safeContractSummary();
  const exact = (actual, expected, code, label) => {
    if (actual !== expected) fail(code, `${label} does not match the frozen candidate.`);
  };
  exact(candidate.schemaVersion, "storage-copy-policy-candidate-v1", "COPY_POLICY_CANDIDATE_UNSAFE", "schema");
  exact(candidate.candidateState, "CODE_AND_INDEPENDENT_REVIEW_REQUIRED", "COPY_POLICY_CANDIDATE_UNSAFE", "state");
  exact(candidate.baseContractCanonicalDigestSha256, contract.contractDigestSha256, "COPY_POLICY_BASE_CONTRACT_DRIFT", "base canonical digest");
  exact(candidate.baseContractFileDigestSha256, contractFileDigestSha256(), "COPY_POLICY_BASE_CONTRACT_DRIFT", "base file digest");
  exact(candidate.environment, "uat", "COPY_POLICY_ENVIRONMENT_UNSAFE", "environment");
  exact(candidate.project, "hushh-tech-uat", "COPY_POLICY_PROJECT_UNSAFE", "project");
  exact(candidate.region, "us-central1", "COPY_POLICY_REGION_UNSAFE", "region");
  exact(candidate.productionProject, "hushh-tech-prod", "COPY_POLICY_PROJECT_UNSAFE", "production project");
  exact(candidate.readOnlyCollectorsAllowedWithExplicitFlag, true, "COPY_POLICY_READ_UNSAFE", "read-only collector gate");
  for (const field of [
    "executionActivated",
    "copyExecutionAllowed",
    "productionExecutionAllowed",
    "sourceMutationAllowed",
    "targetOverwriteAllowed",
    "targetDeleteAllowed",
  ]) {
    exact(candidate[field], false, "COPY_POLICY_EXECUTION_NOT_BLOCKED", field);
  }
  if (
    canonicalJson(candidate.activationRequires) !==
    canonicalJson([
      "INDEPENDENT_SECURITY_REVIEW",
      "PARENT_EXPLICIT_ADVANCE",
      "REVIEWED_POLICY_ACTIVATION_COMMIT",
    ])
  ) {
    fail("COPY_POLICY_ACTIVATION_GATES_MISMATCH", "Candidate activation gates changed.");
  }
  if (canonicalJson(candidate.copyPolicy) !== canonicalJson(FROZEN_COPY_POLICY)) {
    fail("COPY_POLICY_CANDIDATE_UNSAFE", "Candidate create-only policy changed.");
  }
  if (
    STORAGE_CUTOVER_CONTRACT.contractState !== "PLANNING_ONLY_NO_LIVE_IO" ||
    STORAGE_CUTOVER_CONTRACT.executionPolicy.objectCopiesAllowed !== false
  ) {
    fail("BASE_CONTRACT_EXECUTION_ENABLED", "The existing storage contract must remain planning-only.");
  }
  return {
    valid: true,
    executionAllowed: false,
    candidateDigestSha256: sha256(canonicalJson(candidate)),
    migrationNamespace: candidate.copyPolicy.migrationNamespace,
  };
};

export const buildMigrationTargetObjectKey = (
  bucketId,
  objectKey,
  sourceFingerprintSha256,
) => {
  validateCopyPolicyCandidate();
  if (
    !STORAGE_CUTOVER_CONTRACT.buckets.some((bucket) => bucket.sourceBucket === bucketId)
  ) {
    fail("UNKNOWN_SOURCE_BUCKET", "Target mapping uses an unknown source bucket.");
  }
  assertSafeSourceObjectKey(objectKey);
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprintSha256 || "")) {
    fail("INVALID_SOURCE_FINGERPRINT", "Target mapping requires the exact source version fingerprint.");
  }
  const objectId = sha256(`${bucketId}\0${objectKey}`);
  return `${COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace}/${bucketId}/${objectId}/${sourceFingerprintSha256}`;
};

export const assertSafeSourceObjectKey = (objectKey) => {
  if (
    typeof objectKey !== "string" ||
    objectKey.length === 0 ||
    objectKey.includes("\0") ||
    /[\r\n]/.test(objectKey)
  ) {
    fail("INVALID_SOURCE_OBJECT_KEY", "Target mapping rejected an unsafe source object key.");
  }
  const encoded = Buffer.from(objectKey, "utf8");
  if (encoded.length > 1_024) {
    fail("SOURCE_OBJECT_KEY_TOO_LARGE", "A source object key exceeds the 1024-byte UTF-8 bound.");
  }
  if (encoded.toString("utf8") !== objectKey) {
    fail("SOURCE_OBJECT_KEY_INVALID_UTF8", "A source object key is not exact round-trip UTF-8.");
  }
  if (objectKey.split("/").some((segment) => segment === "." || segment === "..")) {
    fail("SOURCE_OBJECT_KEY_DOT_SEGMENT", "A source object key contains a blocked dot segment.");
  }
  return objectKey;
};

export const copyPolicyCandidateFileDigestSha256 = () =>
  sha256(readFileSync(COPY_POLICY_CANDIDATE_PATH));
