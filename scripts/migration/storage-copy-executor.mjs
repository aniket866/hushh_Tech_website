#!/usr/bin/env node

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
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STORAGE_CUTOVER_CONTRACT,
  parseJsonLines,
  validateCheckpoint,
  validateSourceInventory,
} from "./storage-cutover-contract.mjs";
import {
  MAXIMUM_APPROVAL_BYTES,
  MAXIMUM_PRIVATE_INPUT_BYTES,
  abandonPrivateArtifact,
  calculateSelfBoundDigest,
  canonicalJson,
  contractFileDigestSha256,
  createCrc32c,
  commitPrivateArtifact,
  currentCleanGitHead,
  fail,
  readPrivateArtifact,
  readStreamWithDeadline,
  reservePrivateArtifact,
  requireExactKeys,
  requireIsoTimestamp,
  requireSafeText,
  requireSha256,
  runCommand,
  runCommandJson,
  safeErrorResult,
  sha256,
  writePrivateArtifact,
} from "./storage-live-common.mjs";
import {
  COPY_POLICY_CANDIDATE,
  buildMigrationTargetObjectKey,
  copyPolicyCandidateFileDigestSha256,
  validateCopyPolicyCandidate,
} from "./storage-live-policy.mjs";
import {
  SupabaseReadOnlyStorageClient,
  TARGET_COPY_PREFLIGHT_SCHEMA,
  GoogleCloudReadOnlyStorageClient,
  buildExpectedTargetMetadata,
  collectLiveTargetPreflight,
  encodeSourceObjectPath,
  sourceObjectId,
  sourceObjectMetadataRecord,
  verifyExistingTargetObject,
  verifyRetainedHistoricalTargetObject,
} from "./storage-live-inventory.mjs";
import {
  sevenBucketActivationFileDigestSha256,
  validateSevenBucketActivation,
} from "./storage-seven-bucket-contract.mjs";

export const COPY_PLAN_SCHEMA = "gcs-storage-create-only-plan-v1";
export const COPY_APPROVAL_SCHEMA = "gcs-storage-copy-approval-v1";
export const COPY_RESULT_EVIDENCE_SCHEMA = "gcs-storage-create-only-result-evidence-v1";
const MAXIMUM_OBJECT_BYTES = STORAGE_CUTOVER_CONTRACT.sourceSnapshot.totalBytes;
const HTTP_TIMEOUT_MS = 120_000;
const MAXIMUM_APPROVAL_CLOCK_SKEW_MS = 60_000;
const DESCRIPTOR_HASH_BUFFER_BYTES = 1_048_576;

const parseSourceFile = (path, expectedFileDigestSha256, checkpointBinding = null) => {
  requireSha256(expectedFileDigestSha256, "SOURCE_FILE_DIGEST_INVALID", "source file digest");
  const artifact = readPrivateArtifact(path, { maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES });
  if (artifact.fileDigestSha256 !== expectedFileDigestSha256) {
    fail("SOURCE_FILE_DIGEST_MISMATCH", "The source inventory file digest changed.");
  }
  const records = parseJsonLines(
    artifact.bytes.toString("utf8"),
    "source inventory",
  );
  const inventory = validateSourceInventory(records, {
    previousCheckpoint: checkpointBinding?.checkpoint ?? null,
  });
  inventory.previousCheckpointFileDigestSha256 =
    checkpointBinding?.fileDigestSha256 ?? null;
  return {
    records,
    inventory,
    fileDigestSha256: artifact.fileDigestSha256,
  };
};

const parseJsonArtifact = (artifact, code, label) => {
  try {
    return JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    fail(code, `${label} is not valid JSON.`);
  }
};

const validatePreflight = (artifact, source) => {
  requireExactKeys(
    artifact,
    [
      "schemaVersion",
      "collectedAt",
      "environment",
      "project",
      "region",
      "contractFileDigestSha256",
      "copyPolicyCandidateFileDigestSha256",
      "sourceInventoryDigestSha256",
      "sourceArtifactDigestSha256",
      "previousCheckpointFileDigestSha256",
      "previousCheckpointDigestSha256",
      "migrationNamespace",
      "bucketCount",
      "expectedObjectCount",
      "expectedTotalBytes",
      "existingMigrationObjectCount",
      "unmanagedObjectCount",
      "unmanagedTotalBytes",
      "retainedHistoricalObjectCount",
      "retainedHistoricalTotalBytes",
      "buckets",
      "objects",
      "retainedHistoricalObjects",
      "blockers",
      "safeForCopy",
      "preflightDigestSha256",
    ],
    "TARGET_PREFLIGHT_SCHEMA_MISMATCH",
    "target preflight",
  );
  if (
    artifact.schemaVersion !== TARGET_COPY_PREFLIGHT_SCHEMA ||
    artifact.environment !== "uat" ||
    artifact.project !== "hushh-tech-uat" ||
    artifact.region !== "us-central1"
  ) {
    fail("TARGET_PREFLIGHT_SCOPE_MISMATCH", "The target preflight is outside the exact UAT scope.");
  }
  requireIsoTimestamp(artifact.collectedAt, "TARGET_PREFLIGHT_TIME_INVALID", "target preflight time");
  if (
    artifact.contractFileDigestSha256 !== contractFileDigestSha256() ||
    artifact.copyPolicyCandidateFileDigestSha256 !== copyPolicyCandidateFileDigestSha256()
  ) {
    fail("TARGET_PREFLIGHT_POLICY_DRIFT", "The target preflight policy digest changed.");
  }
  if (
    artifact.sourceInventoryDigestSha256 !== source.digestSha256 ||
    artifact.sourceArtifactDigestSha256 !== source.sourceArtifactDigestSha256 ||
    artifact.previousCheckpointDigestSha256 !==
      (source.previousCheckpoint?.checkpointDigestSha256 ?? null) ||
    artifact.previousCheckpointFileDigestSha256 !==
      (source.previousCheckpointFileDigestSha256 ?? null)
  ) {
    fail("TARGET_PREFLIGHT_SOURCE_MISMATCH", "The target preflight does not bind the source inventory.");
  }
  if (
    artifact.migrationNamespace !== COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace ||
    artifact.bucketCount !== 6 ||
    artifact.expectedObjectCount !== source.objectCount ||
    artifact.expectedTotalBytes !== source.totalBytes ||
    !Array.isArray(artifact.buckets) ||
    artifact.buckets.length !== 6 ||
    !Array.isArray(artifact.objects) ||
    artifact.objects.length !== source.objectCount ||
    !Array.isArray(artifact.retainedHistoricalObjects) ||
    !Number.isSafeInteger(artifact.retainedHistoricalObjectCount) ||
    artifact.retainedHistoricalObjectCount < 0 ||
    !Number.isSafeInteger(artifact.retainedHistoricalTotalBytes) ||
    artifact.retainedHistoricalTotalBytes < 0 ||
    artifact.retainedHistoricalObjects.length !== artifact.retainedHistoricalObjectCount ||
    !Array.isArray(artifact.blockers) ||
    typeof artifact.safeForCopy !== "boolean"
  ) {
    fail("TARGET_PREFLIGHT_TOTAL_MISMATCH", "The target preflight totals or shape changed.");
  }
  const expectedTargetBuckets = new Map(
    STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => [bucket.targetBucket, bucket]),
  );
  const expectedLiveObjectsByTargetBucket = new Map(
    STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => [
      bucket.targetBucket,
      source.objects.filter((object) => object.bucketId === bucket.sourceBucket).length,
    ]),
  );
  const seenTargetBuckets = new Set();
  let summedUnmanagedObjects = 0;
  let summedUnmanagedBytes = 0;
  let summedExpectedObjects = 0;
  let summedExistingObjects = 0;
  let summedRetainedHistoricalObjects = 0;
  let summedRetainedHistoricalBytes = 0;
  for (const bucketEvidence of artifact.buckets) {
    requireExactKeys(
      bucketEvidence,
      [
        "bucketName",
        "bucketConfigurationSafe",
        "iamMatchesFrozenAllowlist",
        "location",
        "uniformBucketLevelAccess",
        "publicAccessPrevention",
        "versioningEnabled",
        "bucketIamEvidenceDigestSha256",
        "inheritedIamEvidenceDigestSha256",
        "bucketIamBindingCount",
        "inheritedStorageIamBindingCount",
        "publicIamMemberCount",
        "expectedMigrationObjectCount",
        "existingMigrationObjectCount",
        "unknownMigrationObjectCount",
        "retainedHistoricalObjectCount",
        "retainedHistoricalTotalBytes",
        "retainedHistoricalObjectSetDigestSha256",
        "unmanagedObjectCount",
        "unmanagedTotalBytes",
        "unmanagedInventoryDigestSha256",
      ],
      "TARGET_PREFLIGHT_BUCKET_SCHEMA_MISMATCH",
      "target bucket preflight",
    );
    const expectedBucket = expectedTargetBuckets.get(bucketEvidence.bucketName);
    if (!expectedBucket || seenTargetBuckets.has(bucketEvidence.bucketName)) {
      fail("TARGET_PREFLIGHT_BUCKET_SET_MISMATCH", "The target preflight bucket set changed.");
    }
    seenTargetBuckets.add(bucketEvidence.bucketName);
    for (const field of [
      "bucketIamBindingCount",
      "inheritedStorageIamBindingCount",
      "publicIamMemberCount",
      "expectedMigrationObjectCount",
      "existingMigrationObjectCount",
      "unknownMigrationObjectCount",
      "retainedHistoricalObjectCount",
      "retainedHistoricalTotalBytes",
      "unmanagedObjectCount",
      "unmanagedTotalBytes",
    ]) {
      if (!Number.isSafeInteger(bucketEvidence[field]) || bucketEvidence[field] < 0) {
        fail("TARGET_PREFLIGHT_BUCKET_TOTAL_INVALID", "A target bucket preflight total is invalid.");
      }
    }
    requireSha256(bucketEvidence.bucketIamEvidenceDigestSha256, "TARGET_PREFLIGHT_IAM_DIGEST_INVALID", "bucket IAM evidence digest");
    requireSha256(bucketEvidence.inheritedIamEvidenceDigestSha256, "TARGET_PREFLIGHT_IAM_DIGEST_INVALID", "inherited IAM evidence digest");
    requireSha256(bucketEvidence.unmanagedInventoryDigestSha256, "TARGET_PREFLIGHT_UNMANAGED_DIGEST_INVALID", "unmanaged inventory digest");
    requireSha256(bucketEvidence.retainedHistoricalObjectSetDigestSha256, "TARGET_PREFLIGHT_HISTORY_DIGEST_INVALID", "retained historical object-set digest");
    const recomputedConfigurationSafe =
      bucketEvidence.location === STORAGE_CUTOVER_CONTRACT.targetPolicy.bucketLocation &&
      bucketEvidence.uniformBucketLevelAccess === true &&
      bucketEvidence.publicAccessPrevention === "enforced" &&
      bucketEvidence.versioningEnabled === true &&
      bucketEvidence.publicIamMemberCount === 0;
    if (bucketEvidence.bucketConfigurationSafe !== recomputedConfigurationSafe) {
      fail("TARGET_PREFLIGHT_BUCKET_SAFETY_MISMATCH", "A target bucket safety result is inconsistent.");
    }
    if (
      typeof bucketEvidence.iamMatchesFrozenAllowlist !== "boolean" ||
      bucketEvidence.expectedMigrationObjectCount !==
        expectedLiveObjectsByTargetBucket.get(bucketEvidence.bucketName) ||
      bucketEvidence.existingMigrationObjectCount > bucketEvidence.expectedMigrationObjectCount ||
      bucketEvidence.unknownMigrationObjectCount !== 0
    ) {
      fail("TARGET_PREFLIGHT_BUCKET_SAFETY_MISMATCH", "A target bucket copy boundary changed.");
    }
    summedExpectedObjects += bucketEvidence.expectedMigrationObjectCount;
    summedExistingObjects += bucketEvidence.existingMigrationObjectCount;
    summedRetainedHistoricalObjects += bucketEvidence.retainedHistoricalObjectCount;
    summedRetainedHistoricalBytes += bucketEvidence.retainedHistoricalTotalBytes;
    summedUnmanagedObjects += bucketEvidence.unmanagedObjectCount;
    summedUnmanagedBytes += bucketEvidence.unmanagedTotalBytes;
  }
  if (
    seenTargetBuckets.size !== 6 ||
    summedExpectedObjects !== source.objectCount ||
    summedExistingObjects !== artifact.existingMigrationObjectCount ||
    summedRetainedHistoricalObjects !== artifact.retainedHistoricalObjectCount ||
    summedRetainedHistoricalBytes !== artifact.retainedHistoricalTotalBytes ||
    summedUnmanagedObjects !== artifact.unmanagedObjectCount ||
    summedUnmanagedBytes !== artifact.unmanagedTotalBytes
  ) {
    fail("TARGET_PREFLIGHT_AGGREGATE_MISMATCH", "Target preflight aggregates do not reconcile.");
  }
  const sourceByObjectId = new Map(source.objects.map((object) => [sourceObjectId(object), object]));
  const allowedHistoricalObjectIds = new Set([
    ...sourceByObjectId.keys(),
    ...source.tombstones.map((tombstone) => tombstone.objectId),
  ]);
  const historicalIds = new Set();
  const historicalByBucket = new Map(
    STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => [bucket.targetBucket, []]),
  );
  for (const evidence of artifact.retainedHistoricalObjects) {
    requireExactKeys(
      evidence,
      [
        "objectId",
        "sourceBucket",
        "sourceFingerprintSha256",
        "targetBucket",
        "targetObjectKeyDigestSha256",
        "generation",
        "sizeBytes",
        "sha256",
        "crc32cBase64",
        "md5Hash",
        "targetMetadataDigestSha256",
      ],
      "TARGET_PREFLIGHT_HISTORY_SCHEMA_MISMATCH",
      "retained historical target",
    );
    const identity = `${evidence.objectId}\0${evidence.sourceFingerprintSha256}`;
    const current = sourceByObjectId.get(evidence.objectId);
    const bucketContract = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (bucket) => bucket.sourceBucket === evidence.sourceBucket,
    );
    if (
      !allowedHistoricalObjectIds.has(evidence.objectId) ||
      historicalIds.has(identity) ||
      current?.fingerprint === evidence.sourceFingerprintSha256 ||
      !bucketContract ||
      evidence.targetBucket !== bucketContract.targetBucket ||
      (current && current.bucketId !== evidence.sourceBucket) ||
      !/^[a-f0-9]{64}$/.test(evidence.sourceFingerprintSha256 || "") ||
      !/^[a-f0-9]{64}$/.test(evidence.targetObjectKeyDigestSha256 || "") ||
      !/^[1-9]\d*$/.test(evidence.generation || "") ||
      !Number.isSafeInteger(evidence.sizeBytes) ||
      evidence.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(evidence.sha256 || "") ||
      !/^[A-Za-z0-9+/]{6}==$/.test(evidence.crc32cBase64 || "") ||
      !/^[A-Za-z0-9+/]{22}==$/.test(evidence.md5Hash || "") ||
      !/^[a-f0-9]{64}$/.test(evidence.targetMetadataDigestSha256 || "")
    ) {
      fail("TARGET_PREFLIGHT_HISTORY_INVALID", "Retained historical target evidence is invalid.");
    }
    historicalIds.add(identity);
    historicalByBucket.get(evidence.targetBucket).push(evidence);
  }
  for (const bucketEvidence of artifact.buckets) {
    const objects = historicalByBucket.get(bucketEvidence.bucketName).sort((left, right) =>
      `${left.objectId}\0${left.sourceFingerprintSha256}`.localeCompare(
        `${right.objectId}\0${right.sourceFingerprintSha256}`,
      ));
    if (
      objects.length !== bucketEvidence.retainedHistoricalObjectCount ||
      objects.reduce((sum, object) => sum + object.sizeBytes, 0) !==
        bucketEvidence.retainedHistoricalTotalBytes ||
      sha256(canonicalJson(objects)) !== bucketEvidence.retainedHistoricalObjectSetDigestSha256
    ) {
      fail("TARGET_PREFLIGHT_HISTORY_INVALID", "Retained target history does not reconcile by bucket.");
    }
  }
  const digest = calculateSelfBoundDigest(artifact, "preflightDigestSha256");
  if (artifact.preflightDigestSha256 !== digest) {
    fail("TARGET_PREFLIGHT_DIGEST_MISMATCH", "The target preflight digest changed.");
  }
  const sourceById = new Map(source.objects.map((object) => [sourceObjectId(object), object]));
  const seen = new Set();
  for (const evidence of artifact.objects) {
    requireExactKeys(
      evidence,
      [
        "objectId",
        "targetBucket",
        "targetObjectKeyDigestSha256",
        "expectedBytes",
        "expectedSha256",
        "state",
        "generation",
        "verifiedSha256",
        "verifiedCrc32c",
        "verifiedMd5Hash",
        "targetMetadataDigestSha256",
      ],
      "TARGET_PREFLIGHT_OBJECT_SCHEMA_MISMATCH",
      "target object preflight",
    );
    const sourceObject = sourceById.get(evidence.objectId);
    if (!sourceObject || seen.has(evidence.objectId)) {
      fail("TARGET_PREFLIGHT_OBJECT_SET_MISMATCH", "The target preflight object set changed.");
    }
    seen.add(evidence.objectId);
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === sourceObject.bucketId,
    );
    const targetKey = buildMigrationTargetObjectKey(
      sourceObject.bucketId,
      sourceObject.objectKey,
      sourceObject.fingerprint,
    );
    if (
      evidence.targetBucket !== bucket.targetBucket ||
      evidence.targetObjectKeyDigestSha256 !== sha256(targetKey) ||
      evidence.expectedBytes !== sourceObject.sizeBytes ||
      evidence.expectedSha256 !== sourceObject.sha256 ||
      evidence.targetMetadataDigestSha256 !==
        sha256(canonicalJson(buildExpectedTargetMetadata(sourceObject, source)))
    ) {
      fail("TARGET_PREFLIGHT_OBJECT_MISMATCH", "A target preflight object changed.");
    }
    if (evidence.state === "ABSENT") {
      if (
        evidence.generation !== null ||
        evidence.verifiedSha256 !== null ||
        evidence.verifiedCrc32c !== null ||
        evidence.verifiedMd5Hash !== null
      ) {
        fail("TARGET_PREFLIGHT_ABSENT_INVALID", "An absent target object carries target data.");
      }
    } else if (evidence.state === "PRESENT_EXACT") {
      if (
        typeof evidence.generation !== "string" ||
        !/^[1-9]\d*$/.test(evidence.generation) ||
        evidence.verifiedSha256 !== sourceObject.sha256 ||
        !/^[A-Za-z0-9+/]{6}==$/.test(evidence.verifiedCrc32c || "") ||
        !/^[A-Za-z0-9+/]{22}==$/.test(evidence.verifiedMd5Hash || "")
      ) {
        fail("TARGET_PREFLIGHT_PRESENT_INVALID", "An existing target object lacks exact evidence.");
      }
    } else {
      fail("TARGET_PREFLIGHT_STATE_INVALID", "A target preflight object has an invalid state.");
    }
  }
  const presentObjectCount = artifact.objects.filter(
    (evidence) => evidence.state === "PRESENT_EXACT",
  ).length;
  if (presentObjectCount !== artifact.existingMigrationObjectCount) {
    fail("TARGET_PREFLIGHT_AGGREGATE_MISMATCH", "Existing target object evidence does not reconcile.");
  }
  const expectedBlockers = [];
  if (artifact.buckets.some((bucket) => !bucket.bucketConfigurationSafe)) {
    expectedBlockers.push("TARGET_BUCKET_CONFIGURATION_UNSAFE");
  }
  if (artifact.buckets.some((bucket) => !bucket.iamMatchesFrozenAllowlist)) {
    expectedBlockers.push("TARGET_IAM_NOT_FROZEN_ALLOWLIST");
  }
  if (!COPY_POLICY_CANDIDATE.executionActivated) expectedBlockers.push("COPY_POLICY_NOT_ACTIVATED");
  if (!COPY_POLICY_CANDIDATE.copyExecutionAllowed) expectedBlockers.push("COPY_EXECUTION_NOT_ALLOWED");
  if (
    canonicalJson(artifact.blockers) !== canonicalJson(expectedBlockers) ||
    artifact.safeForCopy !== (expectedBlockers.length === 0)
  ) {
    fail("TARGET_PREFLIGHT_BLOCKER_MISMATCH", "Target preflight blockers are inconsistent.");
  }
  return { ...artifact, objectById: new Map(artifact.objects.map((entry) => [entry.objectId, entry])) };
};

export const buildCreateOnlyCopyPlan = (source, preflight) => {
  validateCopyPolicyCandidate();
  const validatedPreflight = validatePreflight(preflight, source);
  const liveActions = source.objects.map((sourceObject) => {
    const objectId = sourceObjectId(sourceObject);
    const evidence = validatedPreflight.objectById.get(objectId);
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === sourceObject.bucketId,
    );
    const targetObjectKey = buildMigrationTargetObjectKey(
      sourceObject.bucketId,
      sourceObject.objectKey,
      sourceObject.fingerprint,
    );
    if (evidence.state === "PRESENT_EXACT") {
      return {
        action: "NOOP_PRESENT_EXACT",
        objectId,
        targetBucket: bucket.targetBucket,
        targetObjectKeyDigestSha256: sha256(targetObjectKey),
        targetGeneration: evidence.generation,
        targetCrc32c: evidence.verifiedCrc32c,
        targetMd5Hash: evidence.verifiedMd5Hash,
        expectedBytes: sourceObject.sizeBytes,
        expectedSha256: sourceObject.sha256,
        sourceFingerprintSha256: sourceObject.fingerprint,
      };
    }
    return {
      action: "CREATE_IF_ABSENT",
      objectId,
      targetBucket: bucket.targetBucket,
      targetObjectKeyDigestSha256: sha256(targetObjectKey),
      targetPrecondition: "ifGenerationMatch=0",
      expectedBytes: sourceObject.sizeBytes,
      expectedSha256: sourceObject.sha256,
      sourceFingerprintSha256: sourceObject.fingerprint,
    };
  });
  const tombstoneActions = source.tombstones.map(buildTombstoneRetentionAction);
  const actions = [...liveActions, ...tombstoneActions].sort((left, right) =>
    `${left.objectId}\0${left.action}`.localeCompare(`${right.objectId}\0${right.action}`));
  if (actions.some((action) => /DELETE|OVERWRITE|NEW_GENERATION/.test(action.action))) {
    fail("UNSAFE_COPY_ACTION", "The create-only plan contains a destructive action.");
  }
  const plan = {
    schemaVersion: COPY_PLAN_SCHEMA,
    planState: "DRY_RUN_REVIEW_REQUIRED_EXECUTION_BLOCKED",
    environment: "uat",
    project: "hushh-tech-uat",
    region: "us-central1",
    contractFileDigestSha256: contractFileDigestSha256(),
    copyPolicyCandidateFileDigestSha256: copyPolicyCandidateFileDigestSha256(),
    sourceInventoryDigestSha256: source.digestSha256,
    sourceArtifactDigestSha256: source.sourceArtifactDigestSha256,
    previousCheckpointFileDigestSha256: validatedPreflight.previousCheckpointFileDigestSha256,
    previousCheckpointDigestSha256: source.previousCheckpoint?.checkpointDigestSha256 ?? null,
    targetPreflightDigestSha256: validatedPreflight.preflightDigestSha256,
    migrationNamespace: COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace,
    actionCount: actions.length,
    liveObjectCount: source.objectCount,
    tombstoneCount: source.tombstones.length,
    createCount: liveActions.filter((action) => action.action === "CREATE_IF_ABSENT").length,
    noopCount: liveActions.filter((action) => action.action === "NOOP_PRESENT_EXACT").length,
    retainedTombstoneCount: tombstoneActions.length,
    deleteCount: 0,
    overwriteCount: 0,
    expectedBytes: source.totalBytes,
    unmanagedObjectCount: validatedPreflight.unmanagedObjectCount,
    unmanagedTotalBytes: validatedPreflight.unmanagedTotalBytes,
    retainedHistoricalObjectCount: validatedPreflight.retainedHistoricalObjectCount,
    retainedHistoricalTotalBytes: validatedPreflight.retainedHistoricalTotalBytes,
    sourceMutationAllowed: false,
    targetOverwriteAllowed: false,
    targetDeleteAllowed: false,
    executionAllowed: false,
    blockers: [...validatedPreflight.blockers],
    actions,
    planDigestSha256: null,
  };
  plan.planDigestSha256 = calculateSelfBoundDigest(plan, "planDigestSha256");
  return plan;
};

export const buildTombstoneRetentionAction = (tombstone) => {
  requireExactKeys(
    tombstone,
    [
      "recordType",
      "objectId",
      "priorSourceFingerprintSha256",
      "deletedAt",
      "deletionReason",
      "previousSourceInventoryDigestSha256",
      "deltaEvidenceDigestSha256",
      "sourceArtifactDigestSha256",
    ],
    "SOURCE_TOMBSTONE_SCHEMA_MISMATCH",
    "source tombstone",
  );
  if (tombstone.recordType !== "sourceTombstone") {
    fail("SOURCE_TOMBSTONE_SCHEMA_MISMATCH", "A tombstone retention action needs a typed source tombstone.");
  }
  for (const field of [
    "objectId",
    "priorSourceFingerprintSha256",
    "previousSourceInventoryDigestSha256",
    "deltaEvidenceDigestSha256",
    "sourceArtifactDigestSha256",
  ]) {
    requireSha256(tombstone[field], "SOURCE_TOMBSTONE_INVALID", field);
  }
  requireIsoTimestamp(tombstone.deletedAt, "SOURCE_TOMBSTONE_INVALID", "tombstone deletion time");
  requireSafeText(tombstone.deletionReason, "SOURCE_TOMBSTONE_INVALID", "tombstone deletion reason", 1_024);
  return {
    action: "RETAIN_TOMBSTONED_VERSIONS",
    objectId: tombstone.objectId,
    priorSourceFingerprintSha256: tombstone.priorSourceFingerprintSha256,
    deletedAt: tombstone.deletedAt,
    deletionReasonDigestSha256: sha256(tombstone.deletionReason),
    previousSourceInventoryDigestSha256: tombstone.previousSourceInventoryDigestSha256,
    deltaEvidenceDigestSha256: tombstone.deltaEvidenceDigestSha256,
    sourceArtifactDigestSha256: tombstone.sourceArtifactDigestSha256,
    targetMutationAllowed: false,
    databasePointerDisposition: "REMOVE_POINTER_AFTER_SEPARATE_DB_TRANSACTION",
  };
};

export const assertPreflightSafeForExecution = (preflight) => {
  if (
    preflight.safeForCopy !== true ||
    !Array.isArray(preflight.blockers) ||
    preflight.blockers.length !== 0
  ) {
    fail("TARGET_PREFLIGHT_NOT_SAFE", "Copy execution requires a blocker-free safe target preflight.");
  }
};

const buildNamespaceSetEvidence = (entries) => {
  const sortedEntries = [...entries].sort((left, right) =>
    `${left.targetBucket}\0${left.targetObjectKeyDigestSha256}\0${left.generation}`.localeCompare(
      `${right.targetBucket}\0${right.targetObjectKeyDigestSha256}\0${right.generation}`,
    ));
  let totalBytes = 0;
  for (const entry of sortedEntries) {
    totalBytes += entry.sizeBytes;
    if (!Number.isSafeInteger(totalBytes)) {
      fail("TARGET_FRESH_PREFLIGHT_MISMATCH", "Target namespace totals exceed the safe integer bound.");
    }
  }
  const buckets = STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => {
    const bucketEntries = sortedEntries.filter((entry) => entry.targetBucket === bucket.targetBucket);
    const bucketBytes = bucketEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (!Number.isSafeInteger(bucketBytes)) {
      fail("TARGET_FRESH_PREFLIGHT_MISMATCH", "Target namespace bucket totals exceed the safe integer bound.");
    }
    return {
      targetBucket: bucket.targetBucket,
      objectCount: bucketEntries.length,
      totalBytes: bucketBytes,
      objectSetDigestSha256: sha256(canonicalJson(bucketEntries)),
    };
  });
  return {
    objectCount: sortedEntries.length,
    totalBytes,
    entries: sortedEntries,
    buckets,
    bucketSetDigestSha256: sha256(canonicalJson(buckets)),
    objectSetDigestSha256: sha256(canonicalJson(sortedEntries)),
  };
};

const buildPreflightNamespaceEvidence = (preflight, source) => {
  const sourceById = new Map(source.objects.map((object) => [sourceObjectId(object), object]));
  const currentEntries = preflight.objects
    .filter((object) => object.state === "PRESENT_EXACT")
    .map((object) => {
      const sourceObject = sourceById.get(object.objectId);
      if (!sourceObject) {
        fail("TARGET_FRESH_PREFLIGHT_MISMATCH", "A target namespace entry has no approved source object.");
      }
      return {
        objectId: object.objectId,
        sourceBucket: sourceObject.bucketId,
        sourceFingerprintSha256: sourceObject.fingerprint,
        targetBucket: object.targetBucket,
        targetObjectKeyDigestSha256: object.targetObjectKeyDigestSha256,
        generation: object.generation,
        sizeBytes: object.expectedBytes,
        sha256: object.verifiedSha256,
        crc32cBase64: object.verifiedCrc32c,
        md5Hash: object.verifiedMd5Hash,
        targetMetadataDigestSha256: object.targetMetadataDigestSha256,
      };
    });
  const retainedEntries = preflight.retainedHistoricalObjects.map((object) => ({ ...object }));
  return {
    retainedHistory: buildNamespaceSetEvidence(retainedEntries),
    fullMigrationNamespace: buildNamespaceSetEvidence([
      ...currentEntries,
      ...retainedEntries,
    ]),
  };
};

export const assertFreshPreflightCompatible = (approvedPreflight, freshPreflight, source) => {
  const approved = validatePreflight(approvedPreflight, source);
  const fresh = validatePreflight(freshPreflight, source);
  const approvedNamespace = buildPreflightNamespaceEvidence(approved, source);
  const freshNamespace = buildPreflightNamespaceEvidence(fresh, source);
  if (
    canonicalJson(approvedNamespace.retainedHistory) !==
      canonicalJson(freshNamespace.retainedHistory)
  ) {
    fail(
      "TARGET_FRESH_RETAINED_HISTORY_MISMATCH",
      "Retained target history changed after approval.",
    );
  }
  if (
    canonicalJson(approvedNamespace.fullMigrationNamespace) !==
      canonicalJson(freshNamespace.fullMigrationNamespace)
  ) {
    fail(
      "TARGET_FRESH_NAMESPACE_MISMATCH",
      "The full migration namespace changed after approval.",
    );
  }
  for (const [objectId, approvedObject] of approved.objectById) {
    const freshObject = fresh.objectById.get(objectId);
    if (!freshObject) {
      fail("TARGET_FRESH_PREFLIGHT_MISMATCH", "A target object disappeared from the fresh preflight.");
    }
    if (
      approvedObject.state === "PRESENT_EXACT" &&
      (freshObject.state !== "PRESENT_EXACT" ||
        freshObject.generation !== approvedObject.generation)
    ) {
      fail("TARGET_FRESH_PREFLIGHT_MISMATCH", "An approved target generation changed before copy.");
    }
    if (
      approvedObject.state === "ABSENT" &&
      freshObject.state !== "ABSENT"
    ) {
      fail("TARGET_FRESH_PREFLIGHT_MISMATCH", "An approved absent target appeared before copy.");
    }
  }
  assertPreflightSafeForExecution(approved);
  assertPreflightSafeForExecution(fresh);
  return fresh;
};

export const authorizeCopyProviderClients = ({
  approvedPreflight,
  freshPreflight,
  source,
  sourceClientFactory,
  writeClientFactory,
}) => {
  const compatiblePreflight = assertFreshPreflightCompatible(
    approvedPreflight,
    freshPreflight,
    source,
  );
  return {
    compatiblePreflight,
    sourceClient: sourceClientFactory(),
    gcsClient: writeClientFactory(),
  };
};

const validatePlan = (plan, source, preflight) => {
  const rebuilt = buildCreateOnlyCopyPlan(source, preflight);
  if (canonicalJson(plan) !== canonicalJson(rebuilt)) {
    fail("COPY_PLAN_MISMATCH", "The copy plan does not match its exact source and preflight artifacts.");
  }
  return rebuilt;
};

export const validateCopyApproval = ({
  approval,
  approvalFileDigestSha256,
  sourceFileDigestSha256,
  preflightFileDigestSha256,
  planFileDigestSha256,
  plan,
  now = new Date(),
  githubReviewClient,
  reviewedHead,
}) => {
  requireExactKeys(
    approval,
    [
      "schemaVersion",
      "environment",
      "project",
      "region",
      "repository",
      "pullRequestNumber",
      "reviewId",
      "reviewerLogin",
      "reviewedCommitSha",
      "decision",
      "approvedAt",
      "expiresAt",
      "contractFileDigestSha256",
      "copyPolicyCandidateFileDigestSha256",
      "sourceInventoryFileDigestSha256",
      "sourceInventoryDigestSha256",
      "sourceArtifactDigestSha256",
      "previousCheckpointFileDigestSha256",
      "previousCheckpointDigestSha256",
      "targetPreflightFileDigestSha256",
      "targetPreflightDigestSha256",
      "planFileDigestSha256",
      "planDigestSha256",
      "objectCount",
      "totalBytes",
      "migrationNamespace",
      "approvalDigestSha256",
    ],
    "COPY_APPROVAL_SCHEMA_MISMATCH",
    "copy approval",
  );
  if (
    approval.schemaVersion !== COPY_APPROVAL_SCHEMA ||
    approval.environment !== "uat" ||
    approval.project !== "hushh-tech-uat" ||
    approval.region !== "us-central1" ||
    approval.repository !== COPY_POLICY_CANDIDATE.copyPolicy.approvalRepository ||
    approval.decision !== "APPROVED_FOR_CREATE_ONLY_UAT_COPY"
  ) {
    fail("COPY_APPROVAL_SCOPE_MISMATCH", "The copy approval is outside the exact UAT scope.");
  }
  if (!Number.isSafeInteger(approval.pullRequestNumber) || approval.pullRequestNumber < 1 ||
      !Number.isSafeInteger(approval.reviewId) || approval.reviewId < 1) {
    fail("COPY_APPROVAL_REVIEW_INVALID", "The copy approval review identifiers are invalid.");
  }
  requireSafeText(approval.reviewerLogin, "COPY_APPROVAL_REVIEW_INVALID", "reviewer login", 64);
  if (!COPY_POLICY_CANDIDATE.copyPolicy.approvalReviewerAllowlist.includes(approval.reviewerLogin)) {
    fail("COPY_APPROVAL_REVIEWER_BLOCKED", "The copy approval reviewer is not allowlisted.");
  }
  if (!/^[a-f0-9]{40}$/.test(approval.reviewedCommitSha) || approval.reviewedCommitSha !== reviewedHead) {
    fail("COPY_APPROVAL_COMMIT_MISMATCH", "The approval does not bind the exact reviewed commit.");
  }
  requireIsoTimestamp(approval.approvedAt, "COPY_APPROVAL_TIME_INVALID", "approval time");
  requireIsoTimestamp(approval.expiresAt, "COPY_APPROVAL_TIME_INVALID", "approval expiry");
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (
    approvedAt > now.getTime() + MAXIMUM_APPROVAL_CLOCK_SKEW_MS ||
    expiresAt <= now.getTime() ||
    expiresAt <= approvedAt ||
    expiresAt - approvedAt >
      COPY_POLICY_CANDIDATE.copyPolicy.maximumApprovalLifetimeSeconds * 1000
  ) {
    fail("COPY_APPROVAL_EXPIRED", "The copy approval is expired or exceeds its lifetime bound.");
  }
  for (const field of [
    "contractFileDigestSha256",
    "copyPolicyCandidateFileDigestSha256",
    "sourceInventoryFileDigestSha256",
    "sourceInventoryDigestSha256",
    "sourceArtifactDigestSha256",
    "targetPreflightFileDigestSha256",
    "targetPreflightDigestSha256",
    "planFileDigestSha256",
    "planDigestSha256",
    "approvalDigestSha256",
  ]) {
    requireSha256(approval[field], "COPY_APPROVAL_DIGEST_INVALID", field);
  }
  for (const field of [
    "previousCheckpointFileDigestSha256",
    "previousCheckpointDigestSha256",
  ]) {
    if (approval[field] !== null) {
      requireSha256(approval[field], "COPY_APPROVAL_DIGEST_INVALID", field);
    }
  }
  requireSha256(approvalFileDigestSha256, "COPY_APPROVAL_FILE_DIGEST_INVALID", "approval file digest");
  const exactBindings = [
    [approval.contractFileDigestSha256, contractFileDigestSha256()],
    [approval.copyPolicyCandidateFileDigestSha256, copyPolicyCandidateFileDigestSha256()],
    [approval.sourceInventoryFileDigestSha256, sourceFileDigestSha256],
    [approval.sourceInventoryDigestSha256, plan.sourceInventoryDigestSha256],
    [approval.sourceArtifactDigestSha256, plan.sourceArtifactDigestSha256],
    [approval.previousCheckpointFileDigestSha256, plan.previousCheckpointFileDigestSha256],
    [approval.previousCheckpointDigestSha256, plan.previousCheckpointDigestSha256],
    [approval.targetPreflightFileDigestSha256, preflightFileDigestSha256],
    [approval.targetPreflightDigestSha256, plan.targetPreflightDigestSha256],
    [approval.planFileDigestSha256, planFileDigestSha256],
    [approval.planDigestSha256, plan.planDigestSha256],
    [approval.objectCount, plan.actionCount],
    [approval.totalBytes, plan.expectedBytes],
    [approval.migrationNamespace, plan.migrationNamespace],
  ];
  if (exactBindings.some(([actual, expected]) => actual !== expected)) {
    fail("COPY_APPROVAL_ARTIFACT_MISMATCH", "The copy approval does not bind every exact artifact.");
  }
  const expectedApprovalDigest = calculateSelfBoundDigest(approval, "approvalDigestSha256");
  if (approval.approvalDigestSha256 !== expectedApprovalDigest) {
    fail("COPY_APPROVAL_DIGEST_MISMATCH", "The copy approval digest changed.");
  }
  const review = githubReviewClient.getReview(
    approval.repository,
    approval.pullRequestNumber,
    approval.reviewId,
  );
  if (
    review.state !== "APPROVED" ||
    review.commit_id !== approval.reviewedCommitSha ||
    review.user?.login !== approval.reviewerLogin ||
    review.submitted_at !== approval.approvedAt ||
    review.body?.trim() !==
      `${COPY_POLICY_CANDIDATE.copyPolicy.approvalReviewMarkerPrefix}${plan.planDigestSha256}:${planFileDigestSha256}`
  ) {
    fail("COPY_APPROVAL_GITHUB_REVIEW_MISMATCH", "GitHub does not show the exact approval review.");
  }
  const commit = githubReviewClient.getCommit(approval.repository, approval.reviewedCommitSha);
  if (
    typeof commit.author?.login !== "string" ||
    typeof commit.committer?.login !== "string" ||
    commit.author?.login === approval.reviewerLogin ||
    commit.committer?.login === approval.reviewerLogin
  ) {
    fail("COPY_APPROVAL_NOT_INDEPENDENT", "Independent authorship of the reviewed SHA could not be proven.");
  }
  const pullRequest = githubReviewClient.getPullRequest(
    approval.repository,
    approval.pullRequestNumber,
  );
  if (
    pullRequest.state !== "open" ||
    pullRequest.draft === true ||
    pullRequest.head?.sha !== approval.reviewedCommitSha ||
    !Number.isSafeInteger(pullRequest.commits) ||
    pullRequest.commits < 1
  ) {
    fail("COPY_APPROVAL_PR_HEAD_MISMATCH", "The pull request no longer points at the approved commit.");
  }
  if (
    typeof pullRequest.user?.login !== "string" ||
    pullRequest.user.login === approval.reviewerLogin
  ) {
    fail("COPY_APPROVAL_NOT_INDEPENDENT", "The pull request author is not independently resolved.");
  }
  const pullRequestCommits = githubReviewClient.getPullRequestCommits(
    approval.repository,
    approval.pullRequestNumber,
  );
  if (
    !Array.isArray(pullRequestCommits) ||
    pullRequestCommits.length !== pullRequest.commits ||
    !pullRequestCommits.some((candidate) => candidate.sha === approval.reviewedCommitSha)
  ) {
    fail("COPY_APPROVAL_NOT_INDEPENDENT", "The full pull request commit set could not be proven.");
  }
  const seenCommitShas = new Set();
  for (const candidate of pullRequestCommits) {
    if (
      !/^[a-f0-9]{40}$/.test(candidate?.sha || "") ||
      seenCommitShas.has(candidate.sha) ||
      typeof candidate.author?.login !== "string" ||
      typeof candidate.committer?.login !== "string" ||
      candidate.author.login === approval.reviewerLogin ||
      candidate.committer.login === approval.reviewerLogin
    ) {
      fail("COPY_APPROVAL_NOT_INDEPENDENT", "Every pull request commit needs resolved independent authorship.");
    }
    seenCommitShas.add(candidate.sha);
  }
  const allReviews = githubReviewClient.getReviews(
    approval.repository,
    approval.pullRequestNumber,
  );
  if (!Array.isArray(allReviews)) {
    fail("COPY_APPROVAL_GITHUB_REVIEW_MISMATCH", "GitHub review history is invalid.");
  }
  const laterRevocation = allReviews.some((candidate) =>
    candidate.id !== approval.reviewId &&
    COPY_POLICY_CANDIDATE.copyPolicy.approvalReviewerAllowlist.includes(candidate.user?.login) &&
    Number.isFinite(Date.parse(candidate.submitted_at)) &&
    Date.parse(candidate.submitted_at) > approvedAt &&
    ["CHANGES_REQUESTED", "DISMISSED"].includes(candidate.state),
  );
  if (laterRevocation) {
    fail("COPY_APPROVAL_REVOKED", "A later allowlisted GitHub review revoked the copy approval.");
  }
  return { valid: true, approvalDigestSha256: approval.approvalDigestSha256 };
};

export class GitHubCliReviewClient {
  getReview(repository, pullRequestNumber, reviewId) {
    return runCommandJson("gh", [
      "api",
      `repos/${repository}/pulls/${pullRequestNumber}/reviews/${reviewId}`,
    ]);
  }

  getCommit(repository, commitSha) {
    return runCommandJson("gh", ["api", `repos/${repository}/commits/${commitSha}`]);
  }

  getPullRequest(repository, pullRequestNumber) {
    return runCommandJson("gh", ["api", `repos/${repository}/pulls/${pullRequestNumber}`]);
  }

  getPullRequestCommits(repository, pullRequestNumber) {
    const pages = runCommandJson("gh", [
      "api",
      `repos/${repository}/pulls/${pullRequestNumber}/commits?per_page=100`,
      "--paginate",
      "--slurp",
    ]);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      fail("COPY_APPROVAL_NOT_INDEPENDENT", "GitHub commit pagination was invalid.");
    }
    return pages.flat();
  }

  getReviews(repository, pullRequestNumber) {
    const pages = runCommandJson("gh", [
      "api",
      `repos/${repository}/pulls/${pullRequestNumber}/reviews?per_page=100`,
      "--paginate",
      "--slurp",
    ]);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      fail("COPY_APPROVAL_GITHUB_REVIEW_MISMATCH", "GitHub review pagination was invalid.");
    }
    return pages.flat();
  }
}

const boundedJsonResponse = async (response, code) => {
  const rawDeclaredLength = response.headers.get("content-length");
  const declaredLength = rawDeclaredLength === null ? null : Number(rawDeclaredLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > MAXIMUM_PRIVATE_INPUT_BYTES) {
    await response.body?.cancel();
    fail(code, "A Google Cloud response was too large.");
  }
  if (!response.body) fail(code, "A Google Cloud response did not include a body.");
  const reader = response.body.getReader();
  const deadlineAt = Date.now() + HTTP_TIMEOUT_MS;
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await readStreamWithDeadline(
        reader,
        deadlineAt,
        code,
        "A Google Cloud response exceeded its read deadline.",
      );
      if (done) break;
      const bytes = Buffer.from(value);
      totalBytes += bytes.length;
      if (totalBytes > MAXIMUM_PRIVATE_INPUT_BYTES) {
        await reader.cancel();
        fail(code, "A Google Cloud response was too large.");
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
    fail(code, "A Google Cloud response was not valid JSON.");
  }
};

export class GoogleCloudCreateOnlyStorageClient {
  constructor({ fetchImpl = fetch, tokenProvider } = {}) {
    this.fetchImpl = fetchImpl;
    this.tokenProvider = tokenProvider || (() => runCommand("gcloud", [
      "auth",
      "print-access-token",
      `--impersonate-service-account=${COPY_POLICY_CANDIDATE.copyPolicy.writerServiceAccount}`,
    ]).trim());
  }

  token() {
    const token = this.tokenProvider();
    if (typeof token !== "string" || token.length < 20) {
      fail("GCP_WRITE_CREDENTIAL_MISSING", "The exact migration service identity is unavailable.");
    }
    return token;
  }

  assertMigrationBucket(bucketName) {
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.targetBucket === bucketName,
    );
    if (!bucket) {
      fail("GCP_WRITE_TARGET_BLOCKED", "The Google Cloud client only permits exact UAT migration buckets.");
    }
    return bucket;
  }

  assertMigrationTarget(bucketName, objectKey) {
    const bucket = this.assertMigrationBucket(bucketName);
    const expectedPrefix =
      `${COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace}/${bucket.sourceBucket}/`;
    if (
      !bucket ||
      typeof objectKey !== "string" ||
      !objectKey.startsWith(expectedPrefix) ||
      !/^[a-f0-9]{64}\/[a-f0-9]{64}$/.test(objectKey.slice(expectedPrefix.length)) ||
      objectKey.length !== expectedPrefix.length + 129
    ) {
      fail("GCP_WRITE_TARGET_BLOCKED", "The Google Cloud client only permits exact UAT migration targets.");
    }
    return bucket;
  }

  assertStorageUrl(url, { resumable = false, expectedBucket = null } = {}) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "storage.googleapis.com" ||
      parsed.port !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      (resumable && !parsed.pathname.startsWith("/upload/storage/v1/b/")) ||
      (resumable && expectedBucket !== null &&
        parsed.pathname !== `/upload/storage/v1/b/${encodeURIComponent(expectedBucket)}/o`)
    ) {
      fail("GCP_WRITE_ENDPOINT_BLOCKED", "A Google Cloud write endpoint was not allowlisted.");
    }
    return parsed;
  }

  async getObject(bucketName, objectKey) {
    this.assertMigrationTarget(bucketName, objectKey);
    const url = this.assertStorageUrl(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectKey)}?projection=full`,
    );
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token()}` },
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) fail("TARGET_OBJECT_READ_FAILED", "A target object metadata read failed.");
    return boundedJsonResponse(response, "TARGET_OBJECT_READ_INVALID");
  }

  async listMigrationObjects(bucketName) {
    const bucket = this.assertMigrationBucket(bucketName);
    const prefix = `${COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace}/${bucket.sourceBucket}/`;
    const objects = [];
    let pageToken = null;
    const seenPageTokens = new Set();
    do {
      if (
        pageToken !== null &&
        (typeof pageToken !== "string" ||
          pageToken.length === 0 ||
          pageToken.length > 4_096 ||
          /[\0\r\n]/.test(pageToken) ||
          seenPageTokens.has(pageToken))
      ) {
        fail("TARGET_NAMESPACE_LIST_INVALID", "Target namespace pagination returned an unsafe token.");
      }
      if (pageToken !== null) seenPageTokens.add(pageToken);
      const url = this.assertStorageUrl(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o`,
      );
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("projection", "full");
      url.searchParams.set("maxResults", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token()}` },
        redirect: "error",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) {
        fail("TARGET_NAMESPACE_LIST_FAILED", "A target migration namespace listing failed.");
      }
      const payload = await boundedJsonResponse(response, "TARGET_NAMESPACE_LIST_INVALID");
      if (payload.items !== undefined && !Array.isArray(payload.items)) {
        fail("TARGET_NAMESPACE_LIST_INVALID", "A target migration namespace listing was invalid.");
      }
      for (const object of payload.items || []) {
        this.assertMigrationTarget(bucketName, object?.name);
        objects.push(object);
        if (objects.length > 10_000) {
          fail("TARGET_NAMESPACE_LIST_INVALID", "The target migration namespace exceeded its object bound.");
        }
      }
      pageToken = payload.nextPageToken ?? null;
    } while (pageToken !== null);
    return objects;
  }

  async hashObject(bucketName, object) {
    this.assertMigrationTarget(bucketName, object?.name);
    if (object.bucket !== undefined && object.bucket !== bucketName) {
      fail("GCP_WRITE_TARGET_BLOCKED", "The Google Cloud target object bucket changed.");
    }
    const url = this.assertStorageUrl(
      `https://storage.googleapis.com/download/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(object.name)}?alt=media&generation=${encodeURIComponent(object.generation)}`,
    );
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token()}` },
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) fail("TARGET_OBJECT_READ_FAILED", "A target object body read failed.");
    const digest = createHash("sha256");
    const md5 = createHash("md5");
    const crc32c = createCrc32c();
    let sizeBytes = 0;
    const reader = response.body.getReader();
    const deadlineAt = Date.now() + HTTP_TIMEOUT_MS;
    try {
      for (;;) {
        const { done, value } = await readStreamWithDeadline(
          reader,
          deadlineAt,
          "TARGET_OBJECT_READ_INVALID",
          "A target object body exceeded its read deadline.",
        );
        if (done) break;
        const bytes = Buffer.from(value);
        sizeBytes += bytes.length;
        if (sizeBytes > Number(object.size) || sizeBytes > MAXIMUM_OBJECT_BYTES) {
          await reader.cancel();
          fail("TARGET_OBJECT_READ_INVALID", "A target object body exceeded its byte bound.");
        }
        digest.update(bytes);
        md5.update(bytes);
        crc32c.update(bytes);
      }
    } finally {
      try { reader.releaseLock(); } catch { void 0; }
    }
    if (sizeBytes !== Number(object.size)) fail("TARGET_OBJECT_READ_INVALID", "A target object body changed size.");
    return {
      sizeBytes,
      sha256: digest.digest("hex"),
      md5Base64: md5.digest("base64"),
      crc32cBase64: crc32c.digestBase64(),
    };
  }

  async uploadCreateOnly({
    bucketName,
    objectKey,
    fileDescriptor,
    sizeBytes,
    expectedSha256,
    crc32cBase64,
    md5Base64,
    contentType,
    cacheControl,
    metadata,
  }) {
    this.assertMigrationTarget(bucketName, objectKey);
    requireSha256(expectedSha256, "SOURCE_TEMP_DIGEST_INVALID", "verified source SHA-256");
    if (!/^[A-Za-z0-9+/]{6}==$/.test(crc32cBase64 || "")) {
      fail("SOURCE_TEMP_DIGEST_INVALID", "Verified source CRC32C must be four base64 bytes.");
    }
    if (!/^[A-Za-z0-9+/]{22}==$/.test(md5Base64 || "")) {
      fail("SOURCE_TEMP_DIGEST_INVALID", "Verified source MD5 must be sixteen base64 bytes.");
    }
    const beforeInitiation = hashOpenDescriptor(fileDescriptor, sizeBytes);
    if (
      beforeInitiation.sha256 !== expectedSha256 ||
      beforeInitiation.crc32cBase64 !== crc32cBase64 ||
      beforeInitiation.md5Base64 !== md5Base64
    ) {
      fail("SOURCE_TEMP_CHANGED", "The unlinked source descriptor changed before upload initiation.");
    }
    const initiateUrl = new URL(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o`,
    );
    initiateUrl.searchParams.set("uploadType", "resumable");
    initiateUrl.searchParams.set("name", objectKey);
    initiateUrl.searchParams.set("ifGenerationMatch", "0");
    this.assertStorageUrl(initiateUrl, { resumable: true, expectedBucket: bucketName });
    const token = this.token();
    const initiate = await this.fetchImpl(initiateUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        "x-upload-content-length": String(sizeBytes),
        "x-upload-content-type": contentType,
      },
      body: JSON.stringify({
        name: objectKey,
        contentType,
        cacheControl,
        metadata,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (initiate.status === 412) return { collision: true };
    if (!initiate.ok) fail("TARGET_UPLOAD_INIT_FAILED", "Create-only upload initialization failed.");
    const location = initiate.headers.get("location");
    if (!location) fail("TARGET_UPLOAD_LOCATION_MISSING", "Create-only upload returned no session location.");
    const sessionUrl = this.assertStorageUrl(location, {
      resumable: true,
      expectedBucket: bucketName,
    });
    const beforeFinalRequest = hashOpenDescriptor(fileDescriptor, sizeBytes);
    if (
      beforeFinalRequest.sha256 !== expectedSha256 ||
      beforeFinalRequest.crc32cBase64 !== crc32cBase64 ||
      beforeFinalRequest.md5Base64 !== md5Base64
    ) {
      fail("SOURCE_TEMP_CHANGED", "The unlinked source descriptor changed before the final upload request.");
    }
    const upload = await this.fetchImpl(sessionUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": String(sizeBytes),
        "content-type": contentType,
        "content-range": sizeBytes === 0 ? "bytes */0" : `bytes 0-${sizeBytes - 1}/${sizeBytes}`,
        "x-goog-hash": `crc32c=${crc32cBase64},md5=${md5Base64}`,
      },
      body: createReadStream("", {
        fd: fileDescriptor,
        autoClose: false,
        start: 0,
        ...(sizeBytes > 0 ? { end: sizeBytes - 1 } : {}),
      }),
      duplex: "half",
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (upload.status === 412) return { collision: true };
    if (!upload.ok) fail("TARGET_UPLOAD_FAILED", "Create-only upload failed.");
    const object = await boundedJsonResponse(upload, "TARGET_UPLOAD_RESPONSE_INVALID");
    if (object.crc32c !== crc32cBase64 || object.md5Hash !== md5Base64) {
      fail("TARGET_UPLOAD_CHECKSUM_MISMATCH", "Google Cloud did not confirm the exact upload checksum.");
    }
    return { collision: false, object };
  }
}

const hashOpenDescriptor = (fileDescriptor, expectedBytes) => {
  if (!Number.isSafeInteger(fileDescriptor) || fileDescriptor < 0) {
    fail("SOURCE_TEMP_DESCRIPTOR_MISSING", "Upload requires the exact verified open file descriptor.");
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAXIMUM_OBJECT_BYTES) {
    fail("SOURCE_TEMP_CHANGED", "The verified source descriptor byte bound is invalid.");
  }
  const status = fstatSync(fileDescriptor);
  if (!status.isFile() || status.size !== expectedBytes) {
    fail("SOURCE_TEMP_CHANGED", "The verified source descriptor changed size or type.");
  }
  const sha256Digest = createHash("sha256");
  const md5 = createHash("md5");
  const crc32c = createCrc32c();
  const buffer = Buffer.allocUnsafe(Math.min(DESCRIPTOR_HASH_BUFFER_BYTES, Math.max(expectedBytes, 1)));
  let offset = 0;
  while (offset < expectedBytes) {
    const count = readSync(
      fileDescriptor,
      buffer,
      0,
      Math.min(buffer.length, expectedBytes - offset),
      offset,
    );
    if (count <= 0) fail("SOURCE_TEMP_CHANGED", "The verified source descriptor ended early.");
    const bytes = buffer.subarray(0, count);
    sha256Digest.update(bytes);
    md5.update(bytes);
    crc32c.update(bytes);
    offset += count;
  }
  const probe = Buffer.allocUnsafe(1);
  if (readSync(fileDescriptor, probe, 0, 1, offset) !== 0) {
    fail("SOURCE_TEMP_CHANGED", "The verified source descriptor grew while it was hashed.");
  }
  return {
    sizeBytes: offset,
    sha256: sha256Digest.digest("hex"),
    md5Base64: md5.digest("base64"),
    crc32cBase64: crc32c.digestBase64(),
  };
};

export const downloadVerifiedSourceToTemp = async (sourceClient, sourceObject) => {
  const directory = mkdtempSync(join(tmpdir(), "hushh-storage-copy-"));
  const filePath = join(directory, sourceObjectId(sourceObject));
  let writerDescriptor;
  let readDescriptor;
  try {
    writerDescriptor = openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    const response = await sourceClient.request(
      `/object/authenticated/${encodeURIComponent(sourceObject.bucketId)}/${encodeSourceObjectPath(sourceObject.objectKey)}`,
    );
    if (!response.ok || !response.body) fail("SOURCE_OBJECT_DOWNLOAD_FAILED", "A source object read failed.");
    const digest = createHash("sha256");
    let sizeBytes = 0;
    const reader = response.body.getReader();
    const deadlineAt = Date.now() + HTTP_TIMEOUT_MS;
    try {
      for (;;) {
        const { done, value } = await readStreamWithDeadline(
          reader,
          deadlineAt,
          "SOURCE_OBJECT_DOWNLOAD_FAILED",
          "A source object exceeded its read deadline.",
        );
        if (done) break;
        const bytes = Buffer.from(value);
        sizeBytes += bytes.length;
        if (sizeBytes > sourceObject.sizeBytes || sizeBytes > MAXIMUM_OBJECT_BYTES) {
          await reader.cancel();
          fail("SOURCE_OBJECT_SIZE_CHANGED", "A source object exceeded its approved byte count.");
        }
        digest.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          offset += writeSync(writerDescriptor, bytes, offset, bytes.length - offset);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { void 0; }
    }
    fsyncSync(writerDescriptor);
    if (sizeBytes !== sourceObject.sizeBytes || digest.digest("hex") !== sourceObject.sha256) {
      fail("SOURCE_OBJECT_CHANGED", "A source object no longer matches its approved inventory.");
    }
    readDescriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const writerStatus = fstatSync(writerDescriptor);
    const readerStatus = fstatSync(readDescriptor);
    if (
      !readerStatus.isFile() ||
      writerStatus.dev !== readerStatus.dev ||
      writerStatus.ino !== readerStatus.ino ||
      writerStatus.size !== readerStatus.size
    ) {
      fail("SOURCE_TEMP_CHANGED", "The source temp path changed before it was sealed.");
    }
    unlinkSync(filePath);
    rmdirSync(directory);
    closeSync(writerDescriptor);
    writerDescriptor = undefined;
    const verified = hashOpenDescriptor(readDescriptor, sourceObject.sizeBytes);
    if (verified.sha256 !== sourceObject.sha256) {
      fail("SOURCE_TEMP_CHANGED", "The unlinked source descriptor does not match its approved SHA-256.");
    }
    return {
      fileDescriptor: readDescriptor,
      sizeBytes: verified.sizeBytes,
      sha256: verified.sha256,
      crc32cBase64: verified.crc32cBase64,
      md5Base64: verified.md5Base64,
    };
  } catch (error) {
    if (readDescriptor !== undefined) closeSync(readDescriptor);
    if (writerDescriptor !== undefined) closeSync(writerDescriptor);
    try { unlinkSync(filePath); } catch { void 0; }
    try { rmdirSync(directory); } catch { void 0; }
    throw error;
  }
};

const cleanupTemp = ({ fileDescriptor }) => closeSync(fileDescriptor);

const assertCurrentSourceMetadata = async (sourceClient, source) => {
  const liveBuckets = await sourceClient.listBuckets();
  const liveBucketSet = liveBuckets.map((bucket) => ({
    bucketId: bucket.id ?? bucket.name,
    public: bucket.public,
  })).sort((left, right) => String(left.bucketId).localeCompare(String(right.bucketId)));
  const expectedBucketSet = STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({
    bucketId: bucket.sourceBucket,
    public: bucket.sourcePublic,
  })).sort((left, right) => left.bucketId.localeCompare(right.bucketId));
  if (canonicalJson(liveBucketSet) !== canonicalJson(expectedBucketSet)) {
    fail("SOURCE_CHANGED_BEFORE_COPY", "The source bucket set changed after the approved inventory.");
  }
  const liveRecords = [];
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const entries = await sourceClient.listObjects(bucket.sourceBucket);
    liveRecords.push(...entries.map((entry) => sourceObjectMetadataRecord(bucket.sourceBucket, entry)));
  }
  const expected = source.objects.map((object) => ({
    recordType: object.recordType,
    bucketId: object.bucketId,
    objectKey: object.objectKey,
    sizeBytes: object.sizeBytes,
    mimeType: object.mimeType,
    sourceUpdatedAt: object.sourceUpdatedAt,
    cacheControl: object.cacheControl,
  }));
  const sortedLive = liveRecords.sort((a, b) => `${a.bucketId}\0${a.objectKey}`.localeCompare(`${b.bucketId}\0${b.objectKey}`));
  const sortedExpected = expected.sort((a, b) => `${a.bucketId}\0${a.objectKey}`.localeCompare(`${b.bucketId}\0${b.objectKey}`));
  if (canonicalJson(sortedLive) !== canonicalJson(sortedExpected)) {
    fail("SOURCE_CHANGED_BEFORE_COPY", "The source metadata changed after the approved inventory.");
  }
  return {
    bucketCount: liveBucketSet.length,
    objectCount: sortedLive.length,
    totalBytes: sortedLive.reduce((sum, record) => sum + record.sizeBytes, 0),
    bucketSetDigestSha256: sha256(canonicalJson(liveBucketSet)),
    metadataSetDigestSha256: sha256(canonicalJson(sortedLive)),
  };
};

export const collectPostRunSourceConfirmation = async (sourceClient, source) => {
  const metadata = await assertCurrentSourceMetadata(sourceClient, source);
  const objectHashes = [];
  for (const sourceObject of [...source.objects].sort((left, right) =>
    sourceObjectId(left).localeCompare(sourceObjectId(right)))) {
    const hashed = await sourceClient.hashObject(
      sourceObject.bucketId,
      sourceObject.objectKey,
      sourceObject.sizeBytes,
    );
    if (hashed.sizeBytes !== sourceObject.sizeBytes || hashed.sha256 !== sourceObject.sha256) {
      fail("SOURCE_CHANGED_AFTER_COPY", "A source object changed during post-copy confirmation.");
    }
    objectHashes.push({
      objectId: sourceObjectId(sourceObject),
      sizeBytes: hashed.sizeBytes,
      sha256: hashed.sha256,
      crc32cBase64: hashed.crc32cBase64,
      md5Base64: hashed.md5Base64,
    });
  }
  if (
    metadata.bucketCount !== 6 ||
    metadata.objectCount !== source.objectCount ||
    metadata.totalBytes !== source.totalBytes ||
    objectHashes.length !== source.objectCount
  ) {
    fail("SOURCE_CHANGED_AFTER_COPY", "The post-copy source confirmation totals changed.");
  }
  return {
    confirmedAt: new Date().toISOString(),
    bucketCount: metadata.bucketCount,
    objectCount: metadata.objectCount,
    totalBytes: metadata.totalBytes,
    bucketSetDigestSha256: metadata.bucketSetDigestSha256,
    metadataSetDigestSha256: metadata.metadataSetDigestSha256,
    objectHashSetDigestSha256: sha256(canonicalJson(objectHashes)),
    objects: objectHashes,
  };
};

export const reconcileFinalTargets = async (gcsClient, source, outcomes) => {
  const objects = [];
  for (const sourceObject of [...source.objects].sort((left, right) =>
    sourceObjectId(left).localeCompare(sourceObjectId(right)))) {
    const objectId = sourceObjectId(sourceObject);
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === sourceObject.bucketId,
    );
    const targetKey = buildMigrationTargetObjectKey(
      sourceObject.bucketId,
      sourceObject.objectKey,
      sourceObject.fingerprint,
    );
    const live = await gcsClient.getObject(bucket.targetBucket, targetKey);
    if (!live) fail("TARGET_FINAL_RECONCILIATION_FAILED", "A final target object is missing.");
    const verified = await verifyExistingTargetObject(gcsClient, sourceObject, source, live);
    const outcome = outcomes.get(objectId);
    if (!new Set(["CREATED", "NOOP_PRESENT_EXACT"]).has(outcome)) {
      fail("TARGET_FINAL_RECONCILIATION_FAILED", "A final target object has no durable outcome.");
    }
    objects.push({
      objectId,
      sourceFingerprintSha256: sourceObject.fingerprint,
      outcome,
      targetBucket: bucket.targetBucket,
      targetObjectKeyDigestSha256: sha256(targetKey),
      generation: verified.generation,
      sizeBytes: sourceObject.sizeBytes,
      sha256: verified.verifiedSha256,
      crc32cBase64: verified.verifiedCrc32c,
      md5Hash: verified.verifiedMd5Hash,
      targetMetadataDigestSha256: verified.targetMetadataDigestSha256,
    });
  }
  if (objects.length !== source.objectCount) {
    fail("TARGET_FINAL_RECONCILIATION_FAILED", "Final target object totals did not reconcile.");
  }
  return {
    reconciledAt: new Date().toISOString(),
    bucketCount: 6,
    objectCount: objects.length,
    totalBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0),
    objectSetDigestSha256: sha256(canonicalJson(objects)),
    objects,
  };
};

export const reconcileRetainedHistoricalTargets = async (gcsClient, preflight) => {
  const objects = [];
  for (const expected of [...preflight.retainedHistoricalObjects].sort((left, right) =>
    `${left.objectId}\0${left.sourceFingerprintSha256}`.localeCompare(
      `${right.objectId}\0${right.sourceFingerprintSha256}`,
    ))) {
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === expected.sourceBucket,
    );
    if (!bucket || expected.targetBucket !== bucket.targetBucket) {
      fail("TARGET_HISTORY_FINAL_RECONCILIATION_FAILED", "A retained target version left its approved bucket.");
    }
    const targetKey = [
      COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace,
      expected.sourceBucket,
      expected.objectId,
      expected.sourceFingerprintSha256,
    ].join("/");
    if (sha256(targetKey) !== expected.targetObjectKeyDigestSha256) {
      fail("TARGET_HISTORY_FINAL_RECONCILIATION_FAILED", "A retained target version key digest changed.");
    }
    const live = await gcsClient.getObject(bucket.targetBucket, targetKey);
    if (!live) {
      fail("TARGET_HISTORY_FINAL_RECONCILIATION_FAILED", "A retained target version disappeared.");
    }
    const verified = await verifyRetainedHistoricalTargetObject(
      gcsClient,
      bucket,
      live,
      new Set([expected.objectId]),
    );
    if (canonicalJson(verified) !== canonicalJson(expected)) {
      fail("TARGET_HISTORY_FINAL_RECONCILIATION_FAILED", "A retained target version changed after preflight.");
    }
    objects.push(verified);
  }
  const totalBytes = objects.reduce((sum, object) => {
    const next = sum + object.sizeBytes;
    if (!Number.isSafeInteger(next)) {
      fail("TARGET_HISTORY_FINAL_RECONCILIATION_FAILED", "Retained target version totals exceed the safe integer bound.");
    }
    return next;
  }, 0);
  if (
    objects.length !== preflight.retainedHistoricalObjectCount ||
    totalBytes !== preflight.retainedHistoricalTotalBytes
  ) {
    fail("TARGET_HISTORY_FINAL_RECONCILIATION_FAILED", "Retained target versions did not reconcile.");
  }
  return {
    reconciledAt: new Date().toISOString(),
    objectCount: objects.length,
    totalBytes,
    objectSetDigestSha256: sha256(canonicalJson(objects)),
    objects,
  };
};

export const reconcileFinalMigrationNamespace = async ({
  gcsClient,
  source,
  targetFinal,
  retainedHistoricalFinal,
}) => {
  const currentById = new Map(targetFinal.objects.map((object) => [object.objectId, object]));
  const expectedByBucket = new Map(
    STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => [bucket.targetBucket, new Map()]),
  );
  for (const sourceObject of source.objects) {
    const current = currentById.get(sourceObjectId(sourceObject));
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === sourceObject.bucketId,
    );
    if (!current || !bucket) {
      fail("TARGET_NAMESPACE_FINAL_RECONCILIATION_FAILED", "A current target version is missing from namespace reconciliation.");
    }
    const targetKey = buildMigrationTargetObjectKey(
      sourceObject.bucketId,
      sourceObject.objectKey,
      sourceObject.fingerprint,
    );
    expectedByBucket.get(bucket.targetBucket).set(targetKey, {
      generation: current.generation,
      sizeBytes: current.sizeBytes,
    });
  }
  for (const historical of retainedHistoricalFinal.objects) {
    const targetKey = [
      COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace,
      historical.sourceBucket,
      historical.objectId,
      historical.sourceFingerprintSha256,
    ].join("/");
    const expected = expectedByBucket.get(historical.targetBucket);
    if (!expected || expected.has(targetKey)) {
      fail("TARGET_NAMESPACE_FINAL_RECONCILIATION_FAILED", "A retained target version collides in namespace reconciliation.");
    }
    expected.set(targetKey, {
      generation: historical.generation,
      sizeBytes: historical.sizeBytes,
    });
  }
  const buckets = [];
  let objectCount = 0;
  let totalBytes = 0;
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const expected = expectedByBucket.get(bucket.targetBucket);
    const live = await gcsClient.listMigrationObjects(bucket.targetBucket);
    const seen = new Set();
    const objects = [];
    for (const object of live) {
      const approved = expected.get(object?.name);
      const sizeBytes = Number(object?.size);
      if (
        !approved ||
        seen.has(object.name) ||
        object.bucket !== bucket.targetBucket ||
        object.generation !== approved.generation ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes !== approved.sizeBytes
      ) {
        fail("TARGET_NAMESPACE_FINAL_RECONCILIATION_FAILED", "The final target namespace contains an unknown or changed version.");
      }
      seen.add(object.name);
      objects.push({
        targetObjectKeyDigestSha256: sha256(object.name),
        generation: object.generation,
        sizeBytes,
      });
    }
    if (seen.size !== expected.size || [...expected.keys()].some((name) => !seen.has(name))) {
      fail("TARGET_NAMESPACE_FINAL_RECONCILIATION_FAILED", "The final target namespace version set is incomplete.");
    }
    objects.sort((left, right) =>
      left.targetObjectKeyDigestSha256.localeCompare(right.targetObjectKeyDigestSha256));
    const bucketBytes = objects.reduce((sum, object) => sum + object.sizeBytes, 0);
    objectCount += objects.length;
    totalBytes += bucketBytes;
    if (!Number.isSafeInteger(objectCount) || !Number.isSafeInteger(totalBytes)) {
      fail("TARGET_NAMESPACE_FINAL_RECONCILIATION_FAILED", "The final target namespace totals exceed the safe integer bound.");
    }
    buckets.push({
      targetBucket: bucket.targetBucket,
      objectCount: objects.length,
      totalBytes: bucketBytes,
      objectSetDigestSha256: sha256(canonicalJson(objects)),
    });
  }
  const expectedVersionCount = targetFinal.objectCount + retainedHistoricalFinal.objectCount;
  const expectedVersionBytes = targetFinal.totalBytes + retainedHistoricalFinal.totalBytes;
  if (objectCount !== expectedVersionCount || totalBytes !== expectedVersionBytes) {
    fail("TARGET_NAMESPACE_FINAL_RECONCILIATION_FAILED", "The final target namespace totals did not reconcile.");
  }
  return {
    reconciledAt: new Date().toISOString(),
    bucketCount: buckets.length,
    objectCount,
    totalBytes,
    bucketSetDigestSha256: sha256(canonicalJson(buckets)),
    buckets,
  };
};

const performActivatedCreateOnlyCopy = async ({
  source,
  plan,
  preflight,
  sourceClient,
  gcsClient,
  onProgress,
}) => {
  await assertCurrentSourceMetadata(sourceClient, source);
  const sourceById = new Map(source.objects.map((object) => [sourceObjectId(object), object]));
  const outcomes = new Map();
  let createdCount = 0;
  let noopCount = 0;
  for (const [index, action] of plan.actions.entries()) {
    if (action.action === "RETAIN_TOMBSTONED_VERSIONS") {
      onProgress?.({
        completed: index + 1,
        total: plan.actionCount,
        objectId: action.objectId,
        result: "RETAINED_TOMBSTONED_VERSIONS_NO_DELETE",
      });
      continue;
    }
    const sourceObject = sourceById.get(action.objectId);
    const targetKey = buildMigrationTargetObjectKey(
      sourceObject.bucketId,
      sourceObject.objectKey,
      sourceObject.fingerprint,
    );
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find((entry) => entry.sourceBucket === sourceObject.bucketId);
    const existing = await gcsClient.getObject(bucket.targetBucket, targetKey);
    if (existing) {
      await verifyExistingTargetObject(gcsClient, sourceObject, source, existing);
      noopCount += 1;
      outcomes.set(action.objectId, "NOOP_PRESENT_EXACT");
      onProgress?.({ completed: index + 1, total: plan.actionCount, objectId: action.objectId, result: "NOOP_PRESENT_EXACT" });
      continue;
    }
    if (action.action !== "CREATE_IF_ABSENT") {
      fail("TARGET_OBJECT_DISAPPEARED", "An approved existing target object disappeared.");
    }
    const temporary = await downloadVerifiedSourceToTemp(sourceClient, sourceObject);
    try {
      const result = await gcsClient.uploadCreateOnly({
        bucketName: bucket.targetBucket,
        objectKey: targetKey,
        fileDescriptor: temporary.fileDescriptor,
        sizeBytes: sourceObject.sizeBytes,
        expectedSha256: temporary.sha256,
        crc32cBase64: temporary.crc32cBase64,
        md5Base64: temporary.md5Base64,
        contentType: sourceObject.mimeType,
        cacheControl: bucket.targetServingCacheControl,
        metadata: buildExpectedTargetMetadata(sourceObject, source),
      });
      const live = result.collision
        ? await gcsClient.getObject(bucket.targetBucket, targetKey)
        : result.object;
      if (!live) fail("TARGET_CREATE_OUTCOME_UNKNOWN", "A create-only upload outcome could not be proven.");
      await verifyExistingTargetObject(gcsClient, sourceObject, source, live);
      createdCount += result.collision ? 0 : 1;
      noopCount += result.collision ? 1 : 0;
      const outcome = result.collision ? "NOOP_PRESENT_EXACT" : "CREATED";
      outcomes.set(action.objectId, outcome);
      onProgress?.({ completed: index + 1, total: plan.actionCount, objectId: action.objectId, result: outcome });
    } finally {
      cleanupTemp(temporary);
    }
  }
  if (createdCount + noopCount !== source.objectCount || outcomes.size !== source.objectCount) {
    fail("COPY_RESULT_TOTAL_MISMATCH", "Copy outcomes did not reconcile to the exact source set.");
  }
  const sourcePostRun = await collectPostRunSourceConfirmation(sourceClient, source);
  const targetFinal = await reconcileFinalTargets(gcsClient, source, outcomes);
  const retainedHistoricalFinal = await reconcileRetainedHistoricalTargets(gcsClient, preflight);
  const finalMigrationNamespace = await reconcileFinalMigrationNamespace({
    gcsClient,
    source,
    targetFinal,
    retainedHistoricalFinal,
  });
  if (
    sourcePostRun.objectCount !== source.objectCount ||
    sourcePostRun.totalBytes !== source.totalBytes ||
    targetFinal.objectCount !== source.objectCount ||
    targetFinal.totalBytes !== source.totalBytes ||
    sourcePostRun.objectCount + source.tombstones.length !== plan.actionCount
  ) {
    fail("COPY_RESULT_TOTAL_MISMATCH", "Post-copy evidence did not prove the exact approved disposition set.");
  }
  return {
    createdCount,
    noopCount,
    deletedCount: 0,
    overwrittenCount: 0,
    sourcePostRun,
    targetFinal,
    retainedHistoricalFinal,
    finalMigrationNamespace,
  };
};

export const executeActivatedKnownSixCreateOnly = async ({
  activation,
  approvalValidation,
  combinedApproval,
  combinedPlan,
  source,
  sourceFileDigestSha256,
  preflight,
  preflightFileDigestSha256,
  plan,
  planFileDigestSha256,
  sourceClient,
  gcsClient,
  onProgress,
}) => {
  validateSevenBucketActivation(activation);
  for (const [value, label] of [
    [sourceFileDigestSha256, "known-six source file digest"],
    [preflightFileDigestSha256, "known-six preflight file digest"],
    [planFileDigestSha256, "known-six plan file digest"],
  ]) requireSha256(value, "KNOWN_SIX_COMBINED_BINDING_INVALID", label);
  if (
    approvalValidation?.valid !== true ||
    approvalValidation.approvalDigestSha256 !== combinedApproval?.approvalDigestSha256 ||
    activation.contractState !== "UAT_CREATE_ONLY_ACTIVATED" ||
    activation.executionPolicy.executionActivated !== true ||
    combinedPlan?.contractState !== activation.contractState ||
    combinedPlan?.executionActivated !== true ||
    combinedPlan?.activationFileDigestSha256 !== sevenBucketActivationFileDigestSha256() ||
    combinedPlan?.activationDigestSha256 !== activation.activationDigestSha256 ||
    combinedApproval?.contractState !== activation.contractState ||
    combinedApproval?.executionActivated !== true ||
    combinedApproval?.activationFileDigestSha256 !== combinedPlan.activationFileDigestSha256 ||
    combinedApproval?.activationDigestSha256 !== combinedPlan.activationDigestSha256 ||
    combinedApproval?.planDigestSha256 !== combinedPlan.planDigestSha256 ||
    combinedPlan.planDigestSha256 !==
      calculateSelfBoundDigest(combinedPlan, "planDigestSha256")
  ) {
    fail(
      "KNOWN_SIX_COMBINED_ACTIVATION_INVALID",
      "The reviewed six-bucket executor requires the exact validated combined activation and approval.",
    );
  }
  const reboundPlan = validatePlan(plan, source, preflight);
  const validatedPreflight = validatePreflight(preflight, source);
  const supersededActivationBlockers = [
    "COPY_POLICY_NOT_ACTIVATED",
    "COPY_EXECUTION_NOT_ALLOWED",
  ];
  if (
    (source?.bucketCount ?? source?.bucketRecords?.length) !== 6 ||
    source?.objectCount !== 124 ||
    source?.totalBytes !== 111_078_397 ||
    source?.tombstones?.length !== 0 ||
    reboundPlan.actionCount !== 124 ||
    reboundPlan.liveObjectCount !== 124 ||
    reboundPlan.tombstoneCount !== 0 ||
    reboundPlan.deleteCount !== 0 ||
    reboundPlan.overwriteCount !== 0 ||
    reboundPlan.actions.some((action) =>
      !["CREATE_IF_ABSENT", "NOOP_PRESENT_EXACT"].includes(action.action)) ||
    canonicalJson(validatedPreflight.blockers) !== canonicalJson(supersededActivationBlockers) ||
    validatedPreflight.safeForCopy !== false
  ) {
    fail(
      "KNOWN_SIX_COMBINED_INPUT_UNSAFE",
      "The reviewed six-bucket source, preflight, or create-only plan changed.",
    );
  }
  const exactBindings = [
    [combinedPlan.knownSixSourceFileDigestSha256, sourceFileDigestSha256],
    [combinedPlan.knownSixPreflightFileDigestSha256, preflightFileDigestSha256],
    [combinedPlan.knownSixPreflightDigestSha256, reboundPlan.targetPreflightDigestSha256],
    [combinedPlan.knownSixPlanFileDigestSha256, planFileDigestSha256],
    [combinedPlan.knownSixPlanDigestSha256, reboundPlan.planDigestSha256],
    [combinedPlan.knownSixActionCount, reboundPlan.actionCount],
    [combinedPlan.knownSixActionCount, source.objectCount],
    [combinedPlan.knownSixActions, reboundPlan.actions],
  ];
  if (exactBindings.some(([actual, expected]) =>
    canonicalJson(actual) !== canonicalJson(expected))) {
    fail(
      "KNOWN_SIX_COMBINED_ARTIFACT_MISMATCH",
      "The reviewed six-bucket artifacts do not match the combined plan.",
    );
  }
  const result = await performActivatedCreateOnlyCopy({
    source,
    plan: reboundPlan,
    preflight: validatedPreflight,
    sourceClient,
    gcsClient,
    onProgress,
  });
  if (
    result.createdCount + result.noopCount !== 124 ||
    result.deletedCount !== 0 ||
    result.overwrittenCount !== 0 ||
    result.sourcePostRun?.objectCount !== 124 ||
    result.sourcePostRun?.totalBytes !== 111_078_397 ||
    result.targetFinal?.objectCount !== 124 ||
    result.targetFinal?.totalBytes !== 111_078_397
  ) {
    fail(
      "KNOWN_SIX_COMBINED_OUTPUT_MISMATCH",
      "The reviewed six-bucket create/no-op output did not reconcile to the combined plan.",
    );
  }
  return result;
};

export const buildCopyResultEvidence = ({
  source,
  sourceFileDigestSha256,
  preflight,
  preflightFileDigestSha256,
  plan,
  planFileDigestSha256,
  approval,
  approvalFileDigestSha256,
  result,
  reviewedHead,
}) => {
  if (
    result.createdCount + result.noopCount !== source.objectCount ||
    result.deletedCount !== 0 ||
    result.overwrittenCount !== 0 ||
    result.sourcePostRun?.bucketCount !== 6 ||
    result.sourcePostRun?.objectCount !== source.objectCount ||
    result.sourcePostRun?.totalBytes !== source.totalBytes ||
    !Array.isArray(result.sourcePostRun?.objects) ||
    result.sourcePostRun.objects.length !== source.objectCount ||
    result.targetFinal?.bucketCount !== 6 ||
    result.targetFinal?.objectCount !== source.objectCount ||
    result.targetFinal?.totalBytes !== source.totalBytes ||
    !Array.isArray(result.targetFinal?.objects) ||
    result.targetFinal.objects.length !== source.objectCount ||
    result.retainedHistoricalFinal?.objectCount !== preflight.retainedHistoricalObjectCount ||
    result.retainedHistoricalFinal?.totalBytes !== preflight.retainedHistoricalTotalBytes ||
    !Array.isArray(result.retainedHistoricalFinal?.objects) ||
    result.retainedHistoricalFinal.objects.length !== preflight.retainedHistoricalObjectCount ||
    result.finalMigrationNamespace?.bucketCount !== 6 ||
    result.finalMigrationNamespace?.objectCount !==
      result.targetFinal.objectCount + result.retainedHistoricalFinal.objectCount ||
    result.finalMigrationNamespace?.totalBytes !==
      result.targetFinal.totalBytes + result.retainedHistoricalFinal.totalBytes ||
    !Array.isArray(result.finalMigrationNamespace?.buckets) ||
    result.finalMigrationNamespace.buckets.length !== 6
  ) {
    fail("COPY_RESULT_EVIDENCE_INVALID", "Post-copy evidence does not match the frozen source totals.");
  }
  for (const field of [
    "bucketSetDigestSha256",
    "metadataSetDigestSha256",
    "objectHashSetDigestSha256",
  ]) {
    requireSha256(result.sourcePostRun[field], "COPY_RESULT_EVIDENCE_INVALID", field);
  }
  requireIsoTimestamp(
    result.sourcePostRun.confirmedAt,
    "COPY_RESULT_EVIDENCE_INVALID",
    "source confirmation time",
  );
  requireIsoTimestamp(
    result.targetFinal.reconciledAt,
    "COPY_RESULT_EVIDENCE_INVALID",
    "target reconciliation time",
  );
  requireIsoTimestamp(
    result.retainedHistoricalFinal.reconciledAt,
    "COPY_RESULT_EVIDENCE_INVALID",
    "retained target reconciliation time",
  );
  requireSha256(
    result.retainedHistoricalFinal.objectSetDigestSha256,
    "COPY_RESULT_EVIDENCE_INVALID",
    "retained target object-set digest",
  );
  if (
    result.retainedHistoricalFinal.objectSetDigestSha256 !==
      sha256(canonicalJson(result.retainedHistoricalFinal.objects)) ||
    canonicalJson(result.retainedHistoricalFinal.objects) !==
      canonicalJson(preflight.retainedHistoricalObjects)
  ) {
    fail("COPY_RESULT_EVIDENCE_INVALID", "Final retained target versions changed after preflight.");
  }
  requireIsoTimestamp(
    result.finalMigrationNamespace.reconciledAt,
    "COPY_RESULT_EVIDENCE_INVALID",
    "final migration namespace reconciliation time",
  );
  requireSha256(
    result.finalMigrationNamespace.bucketSetDigestSha256,
    "COPY_RESULT_EVIDENCE_INVALID",
    "final migration namespace bucket-set digest",
  );
  const expectedTargetBuckets = new Set(
    STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => bucket.targetBucket),
  );
  const seenNamespaceBuckets = new Set();
  let namespaceObjectCount = 0;
  let namespaceTotalBytes = 0;
  for (const bucket of result.finalMigrationNamespace.buckets) {
    requireExactKeys(
      bucket,
      ["targetBucket", "objectCount", "totalBytes", "objectSetDigestSha256"],
      "COPY_RESULT_EVIDENCE_INVALID",
      "final migration namespace bucket",
    );
    if (
      !expectedTargetBuckets.has(bucket.targetBucket) ||
      seenNamespaceBuckets.has(bucket.targetBucket) ||
      !Number.isSafeInteger(bucket.objectCount) ||
      bucket.objectCount < 0 ||
      !Number.isSafeInteger(bucket.totalBytes) ||
      bucket.totalBytes < 0
    ) {
      fail("COPY_RESULT_EVIDENCE_INVALID", "A final migration namespace bucket is invalid.");
    }
    requireSha256(
      bucket.objectSetDigestSha256,
      "COPY_RESULT_EVIDENCE_INVALID",
      "final migration namespace object-set digest",
    );
    seenNamespaceBuckets.add(bucket.targetBucket);
    namespaceObjectCount += bucket.objectCount;
    namespaceTotalBytes += bucket.totalBytes;
  }
  if (
    seenNamespaceBuckets.size !== 6 ||
    !Number.isSafeInteger(namespaceObjectCount) ||
    !Number.isSafeInteger(namespaceTotalBytes) ||
    namespaceObjectCount !== result.finalMigrationNamespace.objectCount ||
    namespaceTotalBytes !== result.finalMigrationNamespace.totalBytes ||
    result.finalMigrationNamespace.bucketSetDigestSha256 !==
      sha256(canonicalJson(result.finalMigrationNamespace.buckets))
  ) {
    fail("COPY_RESULT_EVIDENCE_INVALID", "The final migration namespace evidence does not reconcile.");
  }
  const sourceById = new Map(source.objects.map((object) => [sourceObjectId(object), object]));
  const sourceEvidenceIds = new Set();
  const sourceEvidenceById = new Map();
  for (const object of result.sourcePostRun.objects) {
    const expected = sourceById.get(object.objectId);
    if (
      !expected ||
      sourceEvidenceIds.has(object.objectId) ||
      object.sizeBytes !== expected.sizeBytes ||
      object.sha256 !== expected.sha256 ||
      !/^[A-Za-z0-9+/]{6}==$/.test(object.crc32cBase64 || "") ||
      !/^[A-Za-z0-9+/]{22}==$/.test(object.md5Base64 || "")
    ) {
      fail("COPY_RESULT_EVIDENCE_INVALID", "A post-copy source object digest changed.");
    }
    sourceEvidenceIds.add(object.objectId);
    sourceEvidenceById.set(object.objectId, object);
  }
  if (
    result.sourcePostRun.objectHashSetDigestSha256 !==
    sha256(canonicalJson(result.sourcePostRun.objects))
  ) {
    fail("COPY_RESULT_EVIDENCE_INVALID", "The post-copy source hash-set digest changed.");
  }
  const targetEvidenceIds = new Set();
  let createdCount = 0;
  let noopCount = 0;
  for (const object of result.targetFinal.objects) {
    const expected = sourceById.get(object.objectId);
    const sourceEvidence = sourceEvidenceById.get(object.objectId);
    const bucket = expected && STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === expected.bucketId,
    );
    const targetKey = expected && buildMigrationTargetObjectKey(
      expected.bucketId,
      expected.objectKey,
      expected.fingerprint,
    );
    if (
      !expected ||
      !bucket ||
      targetEvidenceIds.has(object.objectId) ||
      !["CREATED", "NOOP_PRESENT_EXACT"].includes(object.outcome) ||
      object.sourceFingerprintSha256 !== expected.fingerprint ||
      object.targetBucket !== bucket.targetBucket ||
      object.targetObjectKeyDigestSha256 !== sha256(targetKey) ||
      !/^[1-9]\d*$/.test(object.generation || "") ||
      object.sizeBytes !== expected.sizeBytes ||
      object.sha256 !== expected.sha256 ||
      object.crc32cBase64 !== sourceEvidence?.crc32cBase64 ||
      object.md5Hash !== sourceEvidence?.md5Base64 ||
      object.targetMetadataDigestSha256 !==
        sha256(canonicalJson(buildExpectedTargetMetadata(expected, source)))
    ) {
      fail("COPY_RESULT_EVIDENCE_INVALID", "A final target generation or digest changed.");
    }
    targetEvidenceIds.add(object.objectId);
    createdCount += object.outcome === "CREATED" ? 1 : 0;
    noopCount += object.outcome === "NOOP_PRESENT_EXACT" ? 1 : 0;
  }
  if (
    createdCount !== result.createdCount ||
    noopCount !== result.noopCount ||
    result.targetFinal.objectSetDigestSha256 !== sha256(canonicalJson(result.targetFinal.objects))
  ) {
    fail("COPY_RESULT_EVIDENCE_INVALID", "Final target outcomes or object-set digest changed.");
  }
  const pointerManifest = {
    schemaVersion: "hushh-tech-storage-db-pointer-manifest-v1",
    livePointerCount: result.targetFinal.objects.length,
    tombstonePointerRemovalCount: plan.tombstoneCount,
    pointers: result.targetFinal.objects.map((object) => ({
      objectId: object.objectId,
      sourceFingerprintSha256: object.sourceFingerprintSha256,
      targetBucket: object.targetBucket,
      targetObjectKeyDigestSha256: object.targetObjectKeyDigestSha256,
      generation: object.generation,
    })),
    tombstones: plan.actions
      .filter((action) => action.action === "RETAIN_TOMBSTONED_VERSIONS")
      .map((action) => ({
        objectId: action.objectId,
        priorSourceFingerprintSha256: action.priorSourceFingerprintSha256,
        deletedAt: action.deletedAt,
        deletionReasonDigestSha256: action.deletionReasonDigestSha256,
        disposition: "REMOVE_POINTER_RETAIN_IMMUTABLE_TARGET_NO_DELETE",
      })),
    pointerManifestDigestSha256: null,
  };
  pointerManifest.pointerManifestDigestSha256 = calculateSelfBoundDigest(
    pointerManifest,
    "pointerManifestDigestSha256",
  );
  const evidence = {
    schemaVersion: COPY_RESULT_EVIDENCE_SCHEMA,
    completedAt: new Date().toISOString(),
    environment: "uat",
    project: "hushh-tech-uat",
    region: "us-central1",
    contractFileDigestSha256: contractFileDigestSha256(),
    copyPolicyCandidateFileDigestSha256: copyPolicyCandidateFileDigestSha256(),
    sourceInventoryFileDigestSha256: sourceFileDigestSha256,
    sourceInventoryDigestSha256: source.digestSha256,
    sourceArtifactDigestSha256: source.sourceArtifactDigestSha256,
    previousCheckpointFileDigestSha256: plan.previousCheckpointFileDigestSha256,
    previousCheckpointDigestSha256: plan.previousCheckpointDigestSha256,
    targetPreflightFileDigestSha256: preflightFileDigestSha256,
    targetPreflightDigestSha256: preflight.preflightDigestSha256,
    planFileDigestSha256,
    planDigestSha256: plan.planDigestSha256,
    approvalFileDigestSha256,
    approvalDigestSha256: approval.approvalDigestSha256,
    reviewedCommitSha: reviewedHead,
    pullRequestNumber: approval.pullRequestNumber,
    reviewId: approval.reviewId,
    migrationNamespace: plan.migrationNamespace,
    actionCount: plan.actionCount,
    objectCount: plan.liveObjectCount,
    tombstoneCount: plan.tombstoneCount,
    dispositionCount: plan.actionCount,
    immutableTargetVersionCount:
      result.targetFinal.objectCount + result.retainedHistoricalFinal.objectCount,
    totalBytes: plan.expectedBytes,
    createdCount: result.createdCount,
    noopCount: result.noopCount,
    deleteCount: 0,
    overwriteCount: 0,
    sourceMutationAllowed: false,
    targetOverwriteAllowed: false,
    targetDeleteAllowed: false,
    sourcePostRun: result.sourcePostRun,
    targetFinal: result.targetFinal,
    retainedHistoricalFinal: result.retainedHistoricalFinal,
    finalMigrationNamespace: result.finalMigrationNamespace,
    databasePointerManifest: pointerManifest,
    resultEvidenceDigestSha256: null,
  };
  evidence.resultEvidenceDigestSha256 = calculateSelfBoundDigest(
    evidence,
    "resultEvidenceDigestSha256",
  );
  return evidence;
};

const parseArguments = (argv) => {
  const booleanFlags = new Set(["--execute"]);
  const valueFlags = new Set([
    "--environment",
    "--project",
    "--source-inventory",
    "--source-file-digest-sha256",
    "--target-preflight",
    "--target-preflight-file-digest-sha256",
    "--plan",
    "--plan-file-digest-sha256",
    "--plan-output",
    "--approval",
    "--approval-file-digest-sha256",
    "--result-output",
    "--previous-checkpoint",
    "--previous-checkpoint-file-digest-sha256",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (booleanFlags.has(argument)) {
      if (values.has(argument)) fail("DUPLICATE_ARGUMENT", "An executor flag was duplicated.");
      values.set(argument, true);
      continue;
    }
    if (!valueFlags.has(argument)) fail("UNSUPPORTED_ARGUMENT", "Only documented executor arguments are accepted.");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("MISSING_ARGUMENT_VALUE", "An executor argument is missing its value.");
    if (values.has(argument)) fail("DUPLICATE_ARGUMENT", "An executor argument was duplicated.");
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

const loadOptionalCheckpointBinding = (values) => {
  const checkpointPath = values.get("--previous-checkpoint");
  const expectedFileDigestSha256 = values.get("--previous-checkpoint-file-digest-sha256");
  if ((checkpointPath === undefined) !== (expectedFileDigestSha256 === undefined)) {
    fail("COPY_CHECKPOINT_BINDING_INVALID", "Both checkpoint path and exact file digest are required together.");
  }
  if (checkpointPath === undefined) return null;
  requireSha256(expectedFileDigestSha256, "COPY_CHECKPOINT_FILE_DIGEST_INVALID", "checkpoint file digest");
  const artifact = readPrivateArtifact(checkpointPath, {
    maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES,
  });
  if (artifact.fileDigestSha256 !== expectedFileDigestSha256) {
    fail("COPY_CHECKPOINT_FILE_DIGEST_MISMATCH", "The checkpoint file digest changed.");
  }
  let rawCheckpoint;
  try {
    rawCheckpoint = JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    fail("COPY_CHECKPOINT_JSON_INVALID", "The checkpoint is not valid JSON.");
  }
  return {
    checkpoint: validateCheckpoint(rawCheckpoint),
    fileDigestSha256: artifact.fileDigestSha256,
  };
};

const assertExecutionStillBlocked = () => {
  validateCopyPolicyCandidate();
  if (
    STORAGE_CUTOVER_CONTRACT.contractState === "PLANNING_ONLY_NO_LIVE_IO" ||
    STORAGE_CUTOVER_CONTRACT.executionPolicy.objectCopiesAllowed !== true ||
    COPY_POLICY_CANDIDATE.executionActivated !== true ||
    COPY_POLICY_CANDIDATE.copyExecutionAllowed !== true
  ) {
    fail(
      "COPY_EXECUTION_BLOCKED_PENDING_REVIEW",
      "Copy execution remains blocked pending independent review and explicit parent activation.",
    );
  }
};

export const runStorageCopyExecutor = async (argv, dependencies = {}) => {
  const values = parseArguments(argv);
  const environment = values.get("--environment") || "uat";
  const project = values.get("--project") || "hushh-tech-uat";
  if (environment !== "uat" || project !== "hushh-tech-uat") {
    fail("COPY_SCOPE_BLOCKED", "The copy executor is restricted to the exact UAT scope.");
  }
  validateCopyPolicyCandidate();
  if (values.has("--execute")) {
    // This branch intentionally stops before reading credentials, calling GitHub, or making
    // provider requests. Activation requires a separately reviewed policy change.
    assertExecutionStillBlocked();
  }
  const checkpointBinding = loadOptionalCheckpointBinding(values);
  const sourcePath = requiredValue(values, "--source-inventory");
  const sourceFileDigest = requiredValue(values, "--source-file-digest-sha256");
  const source = parseSourceFile(sourcePath, sourceFileDigest, checkpointBinding);
  const preflightPath = requiredValue(values, "--target-preflight");
  const expectedPreflightFileDigest = requiredValue(values, "--target-preflight-file-digest-sha256");
  requireSha256(expectedPreflightFileDigest, "TARGET_PREFLIGHT_FILE_DIGEST_INVALID", "target preflight file digest");
  const preflightArtifact = readPrivateArtifact(preflightPath, {
    maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES,
  });
  if (preflightArtifact.fileDigestSha256 !== expectedPreflightFileDigest) {
    fail("TARGET_PREFLIGHT_FILE_DIGEST_MISMATCH", "The target preflight file digest changed.");
  }
  const preflightFileDigest = preflightArtifact.fileDigestSha256;
  const preflight = parseJsonArtifact(
    preflightArtifact,
    "TARGET_PREFLIGHT_JSON_INVALID",
    "The target preflight",
  );
  const generatedPlan = buildCreateOnlyCopyPlan(source.inventory, preflight);
  if (values.has("--plan-output")) {
    writePrivateArtifact(
      values.get("--plan-output"),
      Buffer.from(`${JSON.stringify(generatedPlan, null, 2)}\n`),
    );
  }
  if (!values.has("--plan")) {
    return {
      ok: true,
      dryRun: true,
      executionAllowed: false,
      planDigestSha256: generatedPlan.planDigestSha256,
      actionCount: generatedPlan.actionCount,
      createCount: generatedPlan.createCount,
      noopCount: generatedPlan.noopCount,
      deleteCount: 0,
      overwriteCount: 0,
      expectedBytes: generatedPlan.expectedBytes,
      unmanagedObjectCount: generatedPlan.unmanagedObjectCount,
      unmanagedTotalBytes: generatedPlan.unmanagedTotalBytes,
      blockers: generatedPlan.blockers,
    };
  }
  const planPath = requiredValue(values, "--plan");
  const expectedPlanFileDigest = requiredValue(values, "--plan-file-digest-sha256");
  requireSha256(expectedPlanFileDigest, "COPY_PLAN_FILE_DIGEST_INVALID", "copy plan file digest");
  const planArtifact = readPrivateArtifact(planPath, {
    maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES,
  });
  if (planArtifact.fileDigestSha256 !== expectedPlanFileDigest) fail("COPY_PLAN_FILE_DIGEST_MISMATCH", "The copy plan file digest changed.");
  const planFileDigest = planArtifact.fileDigestSha256;
  const plan = validatePlan(
    parseJsonArtifact(planArtifact, "COPY_PLAN_JSON_INVALID", "The copy plan"),
    source.inventory,
    preflight,
  );
  if (!values.has("--execute")) {
    return {
      ok: true,
      dryRun: true,
      executionAllowed: false,
      reviewedPlanValidated: true,
      planDigestSha256: plan.planDigestSha256,
      actionCount: plan.actionCount,
      createCount: plan.createCount,
      noopCount: plan.noopCount,
      deleteCount: 0,
      overwriteCount: 0,
      expectedBytes: plan.expectedBytes,
      unmanagedObjectCount: plan.unmanagedObjectCount,
      unmanagedTotalBytes: plan.unmanagedTotalBytes,
      blockers: plan.blockers,
    };
  }
  // The execution branch is unreachable under the checked-in planning-only policy. This code is
  // retained for review and only becomes reachable after a separate activation commit.
  assertExecutionStillBlocked();
  assertPreflightSafeForExecution(preflight);
  const approvalPath = requiredValue(values, "--approval");
  const expectedApprovalFileDigest = requiredValue(values, "--approval-file-digest-sha256");
  requireSha256(expectedApprovalFileDigest, "COPY_APPROVAL_FILE_DIGEST_INVALID", "copy approval file digest");
  const approvalArtifact = readPrivateArtifact(approvalPath, {
    maximumBytes: MAXIMUM_APPROVAL_BYTES,
  });
  if (approvalArtifact.fileDigestSha256 !== expectedApprovalFileDigest) fail("COPY_APPROVAL_FILE_DIGEST_MISMATCH", "The approval file digest changed.");
  const approvalFileDigest = approvalArtifact.fileDigestSha256;
  const approval = parseJsonArtifact(
    approvalArtifact,
    "COPY_APPROVAL_JSON_INVALID",
    "The copy approval",
  );
  const reviewedHead = dependencies.reviewedHead || currentCleanGitHead();
  validateCopyApproval({
    approval,
    approvalFileDigestSha256: approvalFileDigest,
    sourceFileDigestSha256: source.fileDigestSha256,
    preflightFileDigestSha256: preflightFileDigest,
    planFileDigestSha256: planFileDigest,
    plan,
    githubReviewClient: dependencies.githubReviewClient || new GitHubCliReviewClient(),
    reviewedHead,
  });
  const resultOutput = requiredValue(values, "--result-output");
  const resultReservation = reservePrivateArtifact(resultOutput);
  try {
    const freshPreflight = await collectLiveTargetPreflight({
      gcsClient: dependencies.preflightGcsClient ||
        new GoogleCloudReadOnlyStorageClient({ project: "hushh-tech-uat" }),
      sourceRecords: source.records,
      previousCheckpoint: source.inventory.previousCheckpoint,
      previousCheckpointFileDigestSha256:
        source.inventory.previousCheckpointFileDigestSha256,
    });
    const providerClients = authorizeCopyProviderClients({
      approvedPreflight: preflight,
      freshPreflight,
      source: source.inventory,
      sourceClientFactory: () => dependencies.sourceClient || new SupabaseReadOnlyStorageClient({
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      }),
      writeClientFactory: () => dependencies.gcsClient || new GoogleCloudCreateOnlyStorageClient(),
    });
    const result = await performActivatedCreateOnlyCopy({
      source: source.inventory,
      plan,
      preflight: providerClients.compatiblePreflight,
      sourceClient: providerClients.sourceClient,
      gcsClient: providerClients.gcsClient,
      onProgress: dependencies.onProgress,
    });
    const evidence = buildCopyResultEvidence({
      source: source.inventory,
      sourceFileDigestSha256: source.fileDigestSha256,
      preflight,
      preflightFileDigestSha256: preflightFileDigest,
      plan,
      planFileDigestSha256: planFileDigest,
      approval,
      approvalFileDigestSha256: approvalFileDigest,
      result,
      reviewedHead,
    });
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    commitPrivateArtifact(resultReservation, evidenceBytes);
    return {
      ok: true,
      dryRun: false,
      executionAllowed: true,
      createdCount: result.createdCount,
      noopCount: result.noopCount,
      deletedCount: 0,
      overwrittenCount: 0,
      sourcePostRunObjectCount: result.sourcePostRun.objectCount,
      targetFinalObjectCount: result.targetFinal.objectCount,
      retainedHistoricalFinalObjectCount: result.retainedHistoricalFinal.objectCount,
      finalMigrationNamespaceObjectCount: result.finalMigrationNamespace.objectCount,
      dispositionCount: result.sourcePostRun.objectCount + source.inventory.tombstones.length,
      resultEvidenceDigestSha256: evidence.resultEvidenceDigestSha256,
      resultEvidenceFileDigestSha256: sha256(evidenceBytes),
    };
  } catch (error) {
    abandonPrivateArtifact(resultReservation);
    throw error;
  }
};

const invokedAsScript = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
if (invokedAsScript) {
  runStorageCopyExecutor(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(safeErrorResult(error, "STORAGE_COPY_EXECUTOR_FAILED"))}\n`);
      process.exitCode = 1;
    });
}
