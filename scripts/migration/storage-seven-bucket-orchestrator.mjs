import { verify as verifySignature } from "node:crypto";

import { STORAGE_CUTOVER_CONTRACT } from "./storage-cutover-contract.mjs";
import { sourceObjectId, sourceObjectMetadataRecord } from "./storage-live-inventory.mjs";
import {
  SEVEN_BUCKET_APPROVAL_SCHEMA,
  SEVEN_BUCKET_ACTIVATION,
  SEVEN_BUCKET_CONTRACT,
  SEVEN_BUCKET_PLAN_SCHEMA,
  SEVEN_BUCKET_RESULT_SCHEMA,
  assertPolicyUnchangedAfterCopy,
  buildCombinedSourceSummary,
  seventhSourceFingerprint,
  seventhSourceObjectId,
  seventhTargetObjectKey,
  sevenBucketContractFileDigestSha256,
  sevenBucketActivationFileDigestSha256,
  validateCombinedChangeManifest,
  validateKnownSixSource,
  validateSevenBucketActivation,
  validateSevenBucketContract,
  validateZeroGrantPolicyEvidence,
} from "./storage-seven-bucket-contract.mjs";
import {
  performSeventhCreateOnlyCopy,
} from "./storage-seventh-quarantine-executor.mjs";
import {
  calculateSelfBoundDigest,
  canonicalJson,
  fail,
  requireExactKeys,
  requireIsoTimestamp,
  requireSafeText,
  requireSha256,
  sha256,
} from "./storage-live-common.mjs";

const APPROVAL_KEYS = [
  "schemaVersion",
  "decision",
  "environment",
  "project",
  "reviewerLane",
  "reviewerIdentity",
  "authorIdentity",
  "approvedAt",
  "expiresAt",
  "reviewedCommitSha",
  "activationFileDigestSha256",
  "activationDigestSha256",
  "contractState",
  "executionActivated",
  "changeManifestFileDigestSha256",
  "changeManifestDigestSha256",
  "planFileDigestSha256",
  "planDigestSha256",
  "combinedSourceDigestSha256",
  "knownSixPlanDigestSha256",
  "knownSixPreflightDigestSha256",
  "seventhPreflightDigestSha256",
  "zeroGrantPolicyEvidenceDigestSha256",
  "signatureAlgorithm",
  "reviewerPublicKeySha256",
  "signatureBase64",
  "approvalDigestSha256",
];

const normalizeLiveMetadata = (bucketId, entry, maximumObjectBytes) => {
  if (entry?.recordType === "sourceObject") {
    return {
      recordType: "sourceObject",
      bucketId,
      objectKey: entry.objectKey,
      sizeBytes: entry.sizeBytes,
      mimeType: entry.mimeType,
      sourceUpdatedAt: entry.sourceUpdatedAt,
      cacheControl: entry.cacheControl,
    };
  }
  if (maximumObjectBytes <= STORAGE_CUTOVER_CONTRACT.sourceSnapshot.totalBytes) {
    return sourceObjectMetadataRecord(bucketId, entry);
  }
  const rawSize = entry?.metadata?.size;
  const sizeBytes = typeof rawSize === "string" && /^\d+$/.test(rawSize)
    ? Number(rawSize)
    : rawSize;
  const objectKey = entry?.objectKey;
  const mimeType = entry?.metadata?.mimetype ?? entry?.metadata?.mimeType;
  const sourceUpdatedAt = entry?.updated_at ?? entry?.updatedAt;
  const rawCache = entry?.metadata?.cacheControl ?? entry?.metadata?.cache_control ?? null;
  const cacheControl = rawCache === null || rawCache === undefined ? null : String(rawCache);
  if (
    typeof objectKey !== "string" ||
    objectKey.length === 0 ||
    Buffer.byteLength(objectKey, "utf8") > 1_024 ||
    /[\0\r\n]/.test(objectKey) ||
    objectKey.startsWith("/") ||
    objectKey.endsWith("/") ||
    objectKey.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > maximumObjectBytes ||
    typeof mimeType !== "string" ||
    mimeType.length === 0 ||
    mimeType.length > 512 ||
    /[\0\r\n]/.test(mimeType) ||
    (cacheControl !== null && (cacheControl.length > 1_024 || /[\0\r\n]/.test(cacheControl)))
  ) {
    fail("SEVEN_BUCKET_LIVE_METADATA_INVALID", "A live source metadata record is invalid.");
  }
  requireIsoTimestamp(sourceUpdatedAt, "SEVEN_BUCKET_LIVE_METADATA_INVALID", "live source update time");
  return {
    recordType: "sourceObject",
    bucketId,
    objectKey,
    sizeBytes,
    mimeType,
    sourceUpdatedAt,
    cacheControl,
  };
};

const sortedMetadata = (records) => [...records].sort((left, right) =>
  `${left.bucketId}\0${left.objectKey}`.localeCompare(`${right.bucketId}\0${right.objectKey}`));

export const verifyAllSevenLiveSource = async ({ knownSource, seventhSource, sourceClient }) => {
  validateKnownSixSource(knownSource);
  const liveBuckets = await sourceClient.listBuckets();
  if (!Array.isArray(liveBuckets) || liveBuckets.length !== 7) {
    fail("SEVEN_BUCKET_LIVE_SET_DRIFT", "The live source must contain exactly seven buckets.");
  }
  const knownById = new Map(STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => [bucket.sourceBucket, bucket]));
  const seenKnown = new Set();
  let sawSeventh = false;
  for (const bucket of liveBuckets) {
    const bucketId = bucket?.id ?? bucket?.name;
    if (typeof bucketId !== "string") {
      fail("SEVEN_BUCKET_LIVE_SET_DRIFT", "The live source returned an invalid bucket identity.");
    }
    const known = knownById.get(bucketId);
    if (known) {
      if (seenKnown.has(bucketId) || bucket.public !== known.sourcePublic) {
        fail("SEVEN_BUCKET_LIVE_SET_DRIFT", "A known live source bucket changed.");
      }
      seenKnown.add(bucketId);
      continue;
    }
    if (
      sawSeventh ||
      sha256(bucketId) !== SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256 ||
      bucket.public !== SEVEN_BUCKET_CONTRACT.seventh.sourcePublic
    ) {
      fail("UNKNOWN_EIGHTH_BUCKET", "The live source includes an unapproved eighth bucket.");
    }
    sawSeventh = true;
  }
  if (seenKnown.size !== 6 || !sawSeventh) {
    fail("SEVEN_BUCKET_LIVE_SET_DRIFT", "The canonical seven-bucket source set is incomplete.");
  }

  const approvedObjects = [...knownSource.objects, ...seventhSource.objects];
  const firstMetadata = [];
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const entries = await sourceClient.listObjects(bucket.sourceBucket);
    firstMetadata.push(...entries.map((entry) =>
      normalizeLiveMetadata(bucket.sourceBucket, entry, STORAGE_CUTOVER_CONTRACT.sourceSnapshot.totalBytes)));
  }
  const seventhEntries = await sourceClient.listObjects(seventhSource.rawBucketId);
  firstMetadata.push(...seventhEntries.map((entry) =>
    normalizeLiveMetadata(seventhSource.rawBucketId, entry, SEVEN_BUCKET_CONTRACT.seventh.maximumObjectBytes)));
  const expectedMetadata = sortedMetadata(approvedObjects.map((object) => ({
    recordType: "sourceObject",
    bucketId: object.bucketId,
    objectKey: object.objectKey,
    sizeBytes: object.sizeBytes,
    mimeType: object.mimeType,
    sourceUpdatedAt: object.sourceUpdatedAt,
    cacheControl: object.cacheControl,
  })));
  const orderedFirst = sortedMetadata(firstMetadata);
  if (canonicalJson(orderedFirst) !== canonicalJson(expectedMetadata)) {
    fail("SOURCE_MUTATED_AFTER_APPROVAL", "The seven-bucket source metadata changed after approval.");
  }
  const hashes = [];
  for (const object of approvedObjects) {
    const hashed = await sourceClient.hashObject(object.bucketId, object.objectKey, object.sizeBytes);
    if (
      hashed.sizeBytes !== object.sizeBytes ||
      hashed.sha256 !== object.sha256 ||
      (object.md5Base64 !== undefined && hashed.md5Base64 !== object.md5Base64) ||
      (object.crc32cBase64 !== undefined && hashed.crc32cBase64 !== object.crc32cBase64)
    ) {
      fail("SOURCE_MUTATED_AFTER_APPROVAL", "A seven-bucket source object changed after approval.");
    }
    const seventh = object.bucketId === seventhSource.rawBucketId;
    hashes.push({
      objectId: seventh ? seventhSourceObjectId(object) : sourceObjectId(object),
      sourceFingerprintSha256: seventh
        ? seventhSourceFingerprint(object)
        : object.fingerprint,
      sizeBytes: object.sizeBytes,
      sha256: hashed.sha256,
      md5Base64: hashed.md5Base64,
      crc32cBase64: hashed.crc32cBase64,
    });
  }
  const secondMetadata = [];
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const entries = await sourceClient.listObjects(bucket.sourceBucket);
    secondMetadata.push(...entries.map((entry) =>
      normalizeLiveMetadata(bucket.sourceBucket, entry, STORAGE_CUTOVER_CONTRACT.sourceSnapshot.totalBytes)));
  }
  const seventhSecond = await sourceClient.listObjects(seventhSource.rawBucketId);
  secondMetadata.push(...seventhSecond.map((entry) =>
    normalizeLiveMetadata(seventhSource.rawBucketId, entry, SEVEN_BUCKET_CONTRACT.seventh.maximumObjectBytes)));
  const orderedSecond = sortedMetadata(secondMetadata);
  const firstDigest = sha256(canonicalJson(orderedFirst));
  const secondDigest = sha256(canonicalJson(orderedSecond));
  if (firstDigest !== secondDigest || canonicalJson(orderedSecond) !== canonicalJson(expectedMetadata)) {
    fail("SOURCE_MUTATED_DURING_TWO_PASS", "The seven-bucket source changed during two-pass verification.");
  }
  hashes.sort((left, right) => left.objectId.localeCompare(right.objectId));
  const totalBytes = hashes.reduce((sum, object) => sum + object.sizeBytes, 0);
  if (hashes.length !== 140 || totalBytes !== 1_574_621_367) {
    fail("SEVEN_BUCKET_LIVE_TOTAL_MISMATCH", "The live seven-bucket totals changed.");
  }
  return {
    bucketCount: 7,
    objectCount: hashes.length,
    totalBytes,
    firstMetadataDigestSha256: firstDigest,
    secondMetadataDigestSha256: secondDigest,
    contentSetDigestSha256: sha256(canonicalJson(hashes)),
    objects: hashes,
  };
};

const validateKnownSixPlan = (plan, knownSource) => {
  if (
    !plan ||
    plan.environment !== "uat" ||
    plan.project !== "hushh-tech-uat" ||
    plan.liveObjectCount !== 124 ||
    plan.expectedBytes !== 111_078_397 ||
    plan.actionCount !== 124 ||
    plan.tombstoneCount !== 0 ||
    plan.deleteCount !== 0 ||
    plan.overwriteCount !== 0 ||
    !Array.isArray(plan.actions) ||
    plan.actions.length !== 124 ||
    plan.sourceInventoryDigestSha256 !== knownSource.digestSha256 ||
    plan.sourceArtifactDigestSha256 !== knownSource.sourceArtifactDigestSha256
  ) {
    fail("KNOWN_SIX_PLAN_MISMATCH", "The reviewed known-six create-only plan changed.");
  }
  requireSha256(plan.planDigestSha256, "KNOWN_SIX_PLAN_MISMATCH", "known-six plan digest");
  if (plan.actions.some((action) => !["CREATE_IF_ABSENT", "NOOP_PRESENT_EXACT"].includes(action.action))) {
    fail("KNOWN_SIX_PLAN_UNSAFE", "The known-six plan contains a destructive or tombstone action.");
  }
  return plan;
};

export const buildCombinedSevenBucketPlan = ({
  activation = SEVEN_BUCKET_ACTIVATION,
  changeManifest,
  changeManifestFileDigestSha256,
  knownSource,
  knownSourceFileDigestSha256,
  seventhSource,
  knownSixPlan,
  knownSixPlanFileDigestSha256,
  knownSixPreflightFileDigestSha256,
  knownSixPreflightDigestSha256,
  seventhPreflightFileDigestSha256,
  seventhPreflightDigestSha256,
  seventhPreflightSafe,
  seventhNamespaceObjectCount,
  zeroGrantPolicyEvidence,
  reviewedCommitSha,
}) => {
  validateSevenBucketContract();
  validateSevenBucketActivation(activation);
  validateCombinedChangeManifest(changeManifest);
  validateKnownSixSource(knownSource);
  validateKnownSixPlan(knownSixPlan, knownSource);
  const sourceSummary = buildCombinedSourceSummary({
    knownSource,
    knownSourceFileDigestSha256,
    seventhSource,
  });
  validateZeroGrantPolicyEvidence(zeroGrantPolicyEvidence);
  for (const [value, code, label] of [
    [knownSixPlanFileDigestSha256, "COMBINED_PLAN_BINDING_INVALID", "known-six plan file digest"],
    [knownSixPreflightFileDigestSha256, "COMBINED_PLAN_BINDING_INVALID", "known-six preflight file digest"],
    [knownSixPreflightDigestSha256, "COMBINED_PLAN_BINDING_INVALID", "known-six preflight digest"],
    [seventhPreflightFileDigestSha256, "COMBINED_PLAN_BINDING_INVALID", "seventh preflight file digest"],
    [seventhPreflightDigestSha256, "COMBINED_PLAN_BINDING_INVALID", "seventh preflight digest"],
    [changeManifestFileDigestSha256, "COMBINED_PLAN_BINDING_INVALID", "change manifest file digest"],
  ]) requireSha256(value, code, label);
  if (!/^[a-f0-9]{40}$/.test(reviewedCommitSha || "")) {
    fail("COMBINED_PLAN_BINDING_INVALID", "The reviewed commit SHA is invalid.");
  }
  if (changeManifest.reviewedCommitSha !== reviewedCommitSha) {
    fail(
      "COMBINED_CHANGE_MANIFEST_COMMIT_MISMATCH",
      "The concrete changed-path manifest does not bind the reviewed commit.",
    );
  }
  if (seventhPreflightSafe !== true || seventhNamespaceObjectCount !== 0) {
    fail("SEVENTH_PREFLIGHT_UNSAFE", "The quarantine namespace is not empty and safe.");
  }
  const seventhActions = seventhSource.objects.map((object) => ({
    action: "CREATE_IF_ABSENT",
    sourceClass: "PRIVATE_SEVENTH_QUARANTINE",
    objectId: seventhSourceObjectId(object),
    sourceFingerprintSha256: seventhSourceFingerprint(object),
    targetBucket: SEVEN_BUCKET_CONTRACT.seventh.targetBucket,
    targetObjectKeyDigestSha256: sha256(seventhTargetObjectKey(object)),
    targetPrecondition: "ifGenerationMatch=0",
    expectedBytes: object.sizeBytes,
    expectedSha256: object.sha256,
    expectedMd5Base64: object.md5Base64,
    expectedCrc32cBase64: object.crc32cBase64,
  }));
  const plan = {
    schemaVersion: SEVEN_BUCKET_PLAN_SCHEMA,
    planState: "AWAITING_INDEPENDENT_LANE_7_REVIEW_EXECUTION_DISABLED",
    environment: "uat",
    project: "hushh-tech-uat",
    region: "us-central1",
    productionProject: "hushh-tech-prod",
    contractFileDigestSha256: sevenBucketContractFileDigestSha256(),
    activationFileDigestSha256: sevenBucketActivationFileDigestSha256(),
    activationDigestSha256: activation.activationDigestSha256,
    contractState: activation.contractState,
    executionActivated: activation.executionPolicy.executionActivated,
    reviewedCommitSha,
    changeManifestFileDigestSha256,
    changeManifestDigestSha256: changeManifest.manifestDigestSha256,
    combinedSourceDigestSha256: sourceSummary.combinedSourceDigestSha256,
    knownSixSourceFileDigestSha256: knownSourceFileDigestSha256,
    seventhSourceFileDigestSha256: seventhSource.sourceFileDigestSha256,
    knownSixPlanFileDigestSha256,
    knownSixPlanDigestSha256: knownSixPlan.planDigestSha256,
    knownSixPreflightFileDigestSha256,
    knownSixPreflightDigestSha256,
    seventhPreflightFileDigestSha256,
    seventhPreflightDigestSha256,
    zeroGrantPolicyEvidenceDigestSha256: zeroGrantPolicyEvidence.evidenceDigestSha256,
    projectPolicyCanonicalDigestSha256:
      zeroGrantPolicyEvidence.projectPolicyCanonicalDigestSha256,
    migrationServiceAccountPolicyCanonicalDigestSha256:
      zeroGrantPolicyEvidence.migrationServiceAccountPolicyCanonicalDigestSha256,
    bucketCount: 7,
    objectCount: 140,
    totalBytes: 1_574_621_367,
    knownSixActionCount: 124,
    seventhActionCount: 16,
    createOrNoopCount: 140,
    deleteCount: 0,
    overwriteCount: 0,
    sourceMutationAllowed: false,
    targetOverwriteAllowed: false,
    targetDeleteAllowed: false,
    productionMutationAllowed: false,
    runtimeRoutingAllowed: false,
    ifGenerationMatch: 0,
    knownSixActions: knownSixPlan.actions,
    seventhActions,
    planDigestSha256: null,
  };
  plan.planDigestSha256 = calculateSelfBoundDigest(plan, "planDigestSha256");
  return plan;
};

const approvalPayload = (approval) => {
  const copy = { ...approval, signatureBase64: null, approvalDigestSha256: null };
  return Buffer.from(canonicalJson(copy));
};

export const validateCombinedSevenBucketApproval = ({
  approval,
  approvalFileDigestSha256,
  plan,
  planFileDigestSha256,
  zeroGrantPolicyEvidence,
  reviewerPublicKeyPem,
  now = Date.now(),
}) => {
  requireExactKeys(approval, APPROVAL_KEYS, "COMBINED_APPROVAL_SCHEMA", "combined seven-bucket approval");
  validateZeroGrantPolicyEvidence(zeroGrantPolicyEvidence);
  if (
    approval.schemaVersion !== SEVEN_BUCKET_APPROVAL_SCHEMA ||
    approval.decision !== "APPROVED_FOR_CREATE_ONLY_UAT_SEVEN_BUCKET_COPY" ||
    approval.environment !== "uat" ||
    approval.project !== "hushh-tech-uat" ||
    approval.reviewerLane !== "LANE_7" ||
    approval.contractState !== "UAT_CREATE_ONLY_ACTIVATED" ||
    approval.executionActivated !== true ||
    approval.signatureAlgorithm !== "ED25519"
  ) {
    fail("COMBINED_APPROVAL_SCOPE_MISMATCH", "The combined approval is stale or outside Lane 7 UAT scope.");
  }
  requireSafeText(approval.reviewerIdentity, "COMBINED_APPROVAL_REVIEWER", "reviewer identity", 256);
  requireSafeText(approval.authorIdentity, "COMBINED_APPROVAL_REVIEWER", "author identity", 256);
  if (approval.reviewerIdentity === approval.authorIdentity) {
    fail("COMBINED_APPROVAL_NOT_INDEPENDENT", "The combined migration reviewer must be independent.");
  }
  requireIsoTimestamp(approval.approvedAt, "COMBINED_APPROVAL_TIME", "approval time");
  requireIsoTimestamp(approval.expiresAt, "COMBINED_APPROVAL_TIME", "approval expiry");
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (
    expiresAt <= approvedAt ||
    expiresAt - approvedAt > SEVEN_BUCKET_CONTRACT.approvalPolicy.maximumLifetimeSeconds * 1_000 ||
    now < approvedAt - 60_000 ||
    now >= expiresAt
  ) {
    fail("COMBINED_APPROVAL_EXPIRED", "The combined seven-bucket approval is not currently valid.");
  }
  for (const field of [
    "activationFileDigestSha256",
    "activationDigestSha256",
    "changeManifestFileDigestSha256",
    "changeManifestDigestSha256",
    "planFileDigestSha256",
    "planDigestSha256",
    "combinedSourceDigestSha256",
    "knownSixPlanDigestSha256",
    "knownSixPreflightDigestSha256",
    "seventhPreflightDigestSha256",
    "zeroGrantPolicyEvidenceDigestSha256",
    "reviewerPublicKeySha256",
    "approvalDigestSha256",
  ]) requireSha256(approval[field], "COMBINED_APPROVAL_DIGEST", field);
  requireSha256(approvalFileDigestSha256, "COMBINED_APPROVAL_DIGEST", "approval file digest");
  requireSha256(planFileDigestSha256, "COMBINED_APPROVAL_DIGEST", "plan file digest");
  const bindings = [
    [approval.reviewedCommitSha, plan.reviewedCommitSha],
    [approval.activationFileDigestSha256, plan.activationFileDigestSha256],
    [approval.activationDigestSha256, plan.activationDigestSha256],
    [approval.contractState, plan.contractState],
    [approval.executionActivated, plan.executionActivated],
    [approval.changeManifestFileDigestSha256, plan.changeManifestFileDigestSha256],
    [approval.changeManifestDigestSha256, plan.changeManifestDigestSha256],
    [approval.planFileDigestSha256, planFileDigestSha256],
    [approval.planDigestSha256, plan.planDigestSha256],
    [approval.combinedSourceDigestSha256, plan.combinedSourceDigestSha256],
    [approval.knownSixPlanDigestSha256, plan.knownSixPlanDigestSha256],
    [approval.knownSixPreflightDigestSha256, plan.knownSixPreflightDigestSha256],
    [approval.seventhPreflightDigestSha256, plan.seventhPreflightDigestSha256],
    [approval.zeroGrantPolicyEvidenceDigestSha256, zeroGrantPolicyEvidence.evidenceDigestSha256],
  ];
  if (bindings.some(([actual, expected]) => actual !== expected)) {
    fail("COMBINED_APPROVAL_ARTIFACT_MISMATCH", "The combined approval does not bind every exact artifact.");
  }
  if (approval.approvalDigestSha256 !== calculateSelfBoundDigest(approval, "approvalDigestSha256")) {
    fail("COMBINED_APPROVAL_DIGEST_MISMATCH", "The combined approval digest changed.");
  }
  if (
    typeof reviewerPublicKeyPem !== "string" ||
    sha256(reviewerPublicKeyPem) !== approval.reviewerPublicKeySha256 ||
    typeof approval.signatureBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(approval.signatureBase64) ||
    !verifySignature(null, approvalPayload(approval), reviewerPublicKeyPem, Buffer.from(approval.signatureBase64, "base64"))
  ) {
    fail("COMBINED_APPROVAL_SIGNATURE_INVALID", "The detached Lane 7 approval signature is invalid.");
  }
  return { valid: true, approvalDigestSha256: approval.approvalDigestSha256 };
};

export const buildCombinedPostCopyEvidence = ({
  plan,
  approval,
  sourceBefore,
  sourceAfter,
  knownSixResult,
  seventhResult,
  policyBefore,
  policyAfter,
}) => {
  assertPolicyUnchangedAfterCopy(policyBefore, policyAfter);
  if (
    sourceBefore.bucketCount !== 7 ||
    sourceBefore.objectCount !== 140 ||
    sourceBefore.totalBytes !== 1_574_621_367 ||
    sourceAfter.bucketCount !== 7 ||
    sourceAfter.objectCount !== 140 ||
    sourceAfter.totalBytes !== 1_574_621_367 ||
    sourceBefore.firstMetadataDigestSha256 !== sourceAfter.firstMetadataDigestSha256 ||
    sourceBefore.contentSetDigestSha256 !== sourceAfter.contentSetDigestSha256
  ) {
    fail("COMBINED_POSTCOPY_SOURCE_DELTA", "The source changed during the combined copy window.");
  }
  if (
    knownSixResult?.targetFinal?.objectCount !== 124 ||
    knownSixResult?.targetFinal?.totalBytes !== 111_078_397 ||
    knownSixResult?.sourcePostRun?.objectCount !== 124 ||
    knownSixResult?.sourcePostRun?.totalBytes !== 111_078_397 ||
    knownSixResult.deletedCount !== 0 ||
    knownSixResult.overwrittenCount !== 0 ||
    seventhResult.objectCount !== 16 ||
    seventhResult.totalBytes !== 1_463_542_970 ||
    seventhResult.deleteCount !== 0 ||
    seventhResult.overwriteCount !== 0 ||
    seventhResult.sourceMutationCount !== 0 ||
    seventhResult.runtimeRoutingCount !== 0
  ) {
    fail("COMBINED_POSTCOPY_RECONCILIATION", "The 6+1 target results did not reconcile.");
  }
  const createdCount = knownSixResult.createdCount + seventhResult.createdCount;
  const noopCount = knownSixResult.noopCount + seventhResult.noopCount;
  if (createdCount + noopCount !== 140) {
    fail("COMBINED_POSTCOPY_RECONCILIATION", "The 140-object create/no-op disposition did not reconcile.");
  }
  const evidence = {
    schemaVersion: SEVEN_BUCKET_RESULT_SCHEMA,
    completedAt: new Date().toISOString(),
    environment: "uat",
    project: "hushh-tech-uat",
    planDigestSha256: plan.planDigestSha256,
    approvalDigestSha256: approval.approvalDigestSha256,
    bucketCount: 7,
    objectCount: 140,
    totalBytes: 1_574_621_367,
    createdCount,
    noopCount,
    deleteCount: 0,
    overwriteCount: 0,
    sourceMutationCount: 0,
    sourceDeltaCount: 0,
    runtimeRoutingCount: 0,
    productionMutationCount: 0,
    sourceBeforeContentSetDigestSha256: sourceBefore.contentSetDigestSha256,
    sourceAfterContentSetDigestSha256: sourceAfter.contentSetDigestSha256,
    knownSixTargetObjectSetDigestSha256: knownSixResult.targetFinal.objectSetDigestSha256,
    seventhTargetObjectSetDigestSha256: seventhResult.objectSetDigestSha256,
    projectPolicyBeforeDigestSha256: policyBefore.projectPolicyCanonicalDigestSha256,
    projectPolicyAfterDigestSha256: policyAfter.projectPolicyCanonicalDigestSha256,
    migrationPolicyBeforeDigestSha256: policyBefore.migrationServiceAccountPolicyCanonicalDigestSha256,
    migrationPolicyAfterDigestSha256: policyAfter.migrationServiceAccountPolicyCanonicalDigestSha256,
    resultEvidenceDigestSha256: null,
  };
  evidence.resultEvidenceDigestSha256 = calculateSelfBoundDigest(
    evidence,
    "resultEvidenceDigestSha256",
  );
  return evidence;
};

export const executeCombinedSixPlusOne = async ({
  activation,
  approvalValidation,
  plan,
  approval,
  knownSource,
  seventhSource,
  createDependencies,
}) => {
  validateSevenBucketActivation(activation);
  if (
    activation.contractState !== "UAT_CREATE_ONLY_ACTIVATED" ||
    activation.executionPolicy.executionActivated !== true ||
    plan?.contractState !== activation.contractState ||
    plan?.executionActivated !== true ||
    plan?.activationDigestSha256 !== activation.activationDigestSha256 ||
    plan?.activationFileDigestSha256 !== sevenBucketActivationFileDigestSha256()
  ) {
    fail(
      "COMBINED_UAT_ACTIVATION_REQUIRED",
      "The combined copy requires the exact UAT create-only activation state.",
    );
  }
  if (approvalValidation?.valid !== true) {
    fail("COMBINED_APPROVAL_REQUIRED", "The combined copy requires a validated independent approval.");
  }
  if (typeof createDependencies !== "function") {
    fail(
      "COMBINED_DEPENDENCY_FACTORY_REQUIRED",
      "The combined copy requires a post-activation dependency factory.",
    );
  }
  const {
    sourceClient,
    executeReviewedKnownSix,
    gcsClient,
    policySnapshotProvider,
  } = await createDependencies();
  const policyBefore = validateZeroGrantPolicyEvidence(await policySnapshotProvider("before"));
  if (
    policyBefore.projectPolicyCanonicalDigestSha256 !==
      plan.projectPolicyCanonicalDigestSha256 ||
    policyBefore.migrationServiceAccountPolicyCanonicalDigestSha256 !==
      plan.migrationServiceAccountPolicyCanonicalDigestSha256
  ) {
    fail("COMBINED_POLICY_APPROVAL_MISMATCH", "The fresh zero-grant policy evidence changed after approval.");
  }
  const sourceBefore = await verifyAllSevenLiveSource({ knownSource, seventhSource, sourceClient });
  const knownSixResult = await executeReviewedKnownSix();
  const seventhResult = await performSeventhCreateOnlyCopy({ seventhSource, sourceClient, gcsClient });
  const sourceAfter = await verifyAllSevenLiveSource({ knownSource, seventhSource, sourceClient });
  const policyAfter = validateZeroGrantPolicyEvidence(await policySnapshotProvider("after"));
  return buildCombinedPostCopyEvidence({
    plan,
    approval,
    sourceBefore,
    sourceAfter,
    knownSixResult,
    seventhResult,
    policyBefore,
    policyAfter,
  });
};
