import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const contractPath = join(
  moduleDirectory,
  "..",
  "..",
  "migration",
  "storage",
  "supabase-storage-cutover.v1.json",
);

export const SOURCE_SCHEMA = "supabase-storage-source-jsonl-v1";
export const TARGET_SCHEMA = "gcs-storage-target-jsonl-v1";
export const CHECKPOINT_SCHEMA = "storage-cutover-checkpoint-v1";
export const SECONDARY_SCHEMA = "secondary-reference-gates-v1";
export const TARGET_PRESENT = "TARGET_PRESENT";
export const TARGET_ABSENT = "TARGET_ABSENT";
export const IAM_EVIDENCE_SCOPE = "EFFECTIVE_PROJECT_AND_BUCKET";
export const MAXIMUM_CONTINUITY_HISTORY_ENTRIES = 256;

const FROZEN_TARGET_PROJECT = "hushh-tech-uat";
const FROZEN_TARGET_REGION = "us-central1";
const FROZEN_BUCKET_LOCATION = "US-CENTRAL1";
export const FROZEN_MIGRATION_WRITER_ROLE =
  "projects/hushh-tech-uat/roles/hushhTechStorageCutoverWriter";
export const FROZEN_MIGRATION_WRITER_PRINCIPAL =
  "serviceAccount:hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com";
export const FROZEN_AUDIT_PRINCIPAL =
  "serviceAccount:hushh-tech-audit-uat@hushh-tech-uat.iam.gserviceaccount.com";
const FROZEN_PRECOPY_IAM_BINDINGS = Object.freeze([
  {
    role: FROZEN_MIGRATION_WRITER_ROLE,
    members: [FROZEN_MIGRATION_WRITER_PRINCIPAL],
  },
  {
    role: "roles/storage.objectViewer",
    members: [FROZEN_AUDIT_PRINCIPAL],
  },
]);

// These expectations are deliberately independent of the checked-in JSON contract. The
// validator must reject a contract edit that widens an allowlist or silently changes a target.
const FROZEN_BUCKET_EXPECTATIONS = [
  {
    sourceBucket: "assets",
    sourcePublic: true,
    objectCount: 5,
    totalBytes: 19_971_280,
    targetBucket: "hushh-tech-cutover-v1-assets-legal-uat",
    targetAccessMode: "PRIVATE_SERVICE_OR_SIGNED_URL",
    targetServingCacheControl: "private, no-store",
    publicDelivery: "CONTROLLED_MEDIA_ROUTE_ONLY",
    signedUrlIssuers: [],
    allowedIamBindings: FROZEN_PRECOPY_IAM_BINDINGS,
  },
  {
    sourceBucket: "community-uploads",
    sourcePublic: true,
    objectCount: 115,
    totalBytes: 81_259_134,
    targetBucket: "hushh-tech-cutover-v1-community-content-uat",
    targetAccessMode: "PRIVATE_OR_CONTROLLED_PUBLIC_MEDIA",
    targetServingCacheControl: "private, no-store",
    publicDelivery: "MEDIA_HOST_AFTER_CONTENT_REVIEW",
    signedUrlIssuers: [],
    allowedIamBindings: FROZEN_PRECOPY_IAM_BINDINGS,
  },
  {
    sourceBucket: "hushh-agent-profile-images",
    sourcePublic: true,
    objectCount: 1,
    totalBytes: 716_241,
    targetBucket: "hushh-tech-cutover-v1-profile-images-uat",
    targetAccessMode: "PRIVATE_OR_CONTROLLED_PUBLIC_RENDITION",
    targetServingCacheControl: "private, no-store",
    publicDelivery: "RENDITION_ONLY_AFTER_OWNER_AND_CONTENT_REVIEW",
    signedUrlIssuers: [],
    allowedIamBindings: FROZEN_PRECOPY_IAM_BINDINGS,
  },
  {
    sourceBucket: "hushh-ai-media",
    sourcePublic: true,
    objectCount: 0,
    totalBytes: 0,
    targetBucket: "hushh-tech-cutover-v1-ai-media-uat",
    targetAccessMode: "PRIVATE_OWNER_SIGNED_URL",
    targetServingCacheControl: "private, no-store",
    publicDelivery: "NONE",
    signedUrlIssuers: [],
    allowedIamBindings: FROZEN_PRECOPY_IAM_BINDINGS,
  },
  {
    sourceBucket: "hushh-gamma-pdf",
    sourcePublic: true,
    objectCount: 3,
    totalBytes: 9_131_742,
    targetBucket: "hushh-tech-cutover-v1-reports-uat",
    targetAccessMode: "PRIVATE_SIGNED_URL",
    targetServingCacheControl: "private, no-store",
    publicDelivery: "NONE",
    signedUrlIssuers: [],
    allowedIamBindings: FROZEN_PRECOPY_IAM_BINDINGS,
  },
  {
    sourceBucket: "wa-evidence",
    sourcePublic: false,
    objectCount: 0,
    totalBytes: 0,
    targetBucket: "hushh-tech-cutover-v1-wa-evidence-uat",
    targetAccessMode: "SERVICE_IDENTITY_ONLY",
    targetServingCacheControl: "private, no-store",
    publicDelivery: "NONE",
    signedUrlIssuers: [],
    allowedIamBindings: FROZEN_PRECOPY_IAM_BINDINGS,
  },
];

const RECORD_KEYS = Object.freeze({
  sourceInventory: [
    "recordType",
    "schemaVersion",
    "snapshotKind",
    "sourceProjectRef",
    "frozenAt",
    "snapshotSequence",
    "exportRunId",
    "bucketCount",
    "objectCount",
    "totalBytes",
    "tombstoneCount",
    "deltaEvidenceDigestSha256",
    "previousCheckpointDigestSha256",
    "previousSourceInventoryDigestSha256",
    "previousSourceArtifactDigestSha256",
    "previousDeltaEvidenceDigestSha256",
    "inventoryDigestSha256",
    "sourceArtifactDigestSha256",
  ],
  sourceBucket: ["recordType", "bucketId", "public", "objectCount", "totalBytes"],
  sourceObject: [
    "recordType",
    "bucketId",
    "objectKey",
    "sizeBytes",
    "mimeType",
    "sourceUpdatedAt",
    "cacheControl",
    "sha256",
  ],
  sourceTombstone: [
    "recordType",
    "objectId",
    "priorSourceFingerprintSha256",
    "deletedAt",
    "deletionReason",
    "previousSourceInventoryDigestSha256",
    "deltaEvidenceDigestSha256",
    "sourceArtifactDigestSha256",
  ],
  targetInventory: [
    "recordType",
    "schemaVersion",
    "environment",
    "project",
    "region",
    "bucketCount",
    "objectCount",
    "totalBytes",
    "signedUrlIssuerCount",
    "signedUrlIssuerEvidenceDigestSha256",
    "sourceInventoryDigestSha256",
    "inventoryDigestSha256",
  ],
  targetBucket: [
    "recordType",
    "bucketName",
    "uniformBucketLevelAccess",
    "publicAccessPrevention",
    "publicIamMembers",
    "location",
    "versioningEnabled",
    "iamEvidenceScope",
    "bucketIamBindings",
    "inheritedIamBindings",
    "effectiveIamBindings",
    "iamPolicyDigestSha256",
  ],
  signedUrlIssuerEvidence: [
    "recordType",
    "targetBucket",
    "issuerMember",
    "issuerProject",
    "serviceAccountEnabled",
    "signBlobPermissionVerified",
    "allowedMethods",
    "maximumTtlSeconds",
    "generationPinned",
    "bucketAndObjectAllowlistEnforced",
    "responseCacheControl",
    "browserCredentialExposure",
    "evidenceDigestSha256",
  ],
  targetObject: [
    "recordType",
    "sourceBucketId",
    "sourceObjectKey",
    "targetBucket",
    "targetObjectKey",
    "generation",
    "sizeBytes",
    "mimeType",
    "sourceUpdatedAtMetadata",
    "sourceCacheControlMetadata",
    "servingCacheControl",
    "sha256",
    "accessMode",
    "publicAcl",
  ],
});

export class StorageCutoverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StorageCutoverError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new StorageCutoverError(code, message);
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const isIsoTimestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const canonicalDigest = (records) =>
  sha256(records.map((record) => canonicalJson(record)).sort().join("\n"));

const requireString = (value, code, field) => {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${field} must be a non-empty string.`);
  }
  return value;
};

const requireExact = (actual, expected, code, field) => {
  if (actual !== expected) {
    fail(code, `${field} does not match the frozen contract.`);
  }
};

const requireSha = (value, code, field) => {
  if (!isSha256(value)) fail(code, `${field} must be a lowercase SHA-256 digest.`);
  return value;
};

const requireNullableSha = (value, code, field) => {
  if (value !== null) requireSha(value, code, field);
  return value;
};

const requireSafeText = (value, code, field, maximumLength = 256) => {
  requireString(value, code, field);
  const containsControl = [...value].some((character) => {
    const point = character.codePointAt(0);
    return point <= 31 || point === 127;
  });
  if (value.trim() !== value || value.length > maximumLength || containsControl) {
    fail(code, `${field} contains unsafe text.`);
  }
  return value;
};

const requireExactArray = (actual, expected, code, field) => {
  if (!Array.isArray(actual) || canonicalJson(actual) !== canonicalJson(expected)) {
    fail(code, `${field} does not match the frozen contract.`);
  }
};

const requireExactKeys = (record, expectedKeys, code, field) => {
  if (!isPlainObject(record)) fail(code, `${field} must be an object.`);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    const missing = expected.filter((key) => !actual.includes(key));
    const unexpected = actual.filter((key) => !expected.includes(key));
    fail(
      code,
      `${field} does not match the exact record schema (missing: ${missing.join(",") || "none"}; unexpected: ${unexpected.join(",") || "none"}).`,
    );
  }
};

const objectIdentity = (bucketId, objectKey) => sha256(`${bucketId}\0${objectKey}`);

const sourceFingerprint = (record) =>
  sha256(
    canonicalJson({
      bucketId: record.bucketId,
      objectKey: record.objectKey,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType,
      sourceUpdatedAt: record.sourceUpdatedAt,
      cacheControl: record.cacheControl,
      sha256: record.sha256,
    }),
  );

const targetFingerprint = (record) =>
  sha256(
    canonicalJson({
      sourceBucketId: record.sourceBucketId,
      sourceObjectKey: record.sourceObjectKey,
      targetBucket: record.targetBucket,
      targetObjectKey: record.targetObjectKey,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType,
      sourceUpdatedAtMetadata: record.sourceUpdatedAtMetadata,
      sourceCacheControlMetadata: record.sourceCacheControlMetadata,
      servingCacheControl: record.servingCacheControl,
      sha256: record.sha256,
      accessMode: record.accessMode,
      publicAcl: record.publicAcl,
    }),
  );

const sourceArtifactRecord = (record) => {
  if (record.recordType === "sourceInventory") {
    const artifactHeader = { ...record };
    delete artifactHeader.inventoryDigestSha256;
    delete artifactHeader.sourceArtifactDigestSha256;
    return artifactHeader;
  }
  if (record.recordType === "sourceTombstone") {
    const artifactTombstone = { ...record };
    delete artifactTombstone.sourceArtifactDigestSha256;
    return artifactTombstone;
  }
  return record;
};

export const calculateSourceArtifactDigest = (records) =>
  canonicalDigest(records.map((record) => sourceArtifactRecord(record)));

export const normalizeIamBindings = (bindings) => {
  if (!Array.isArray(bindings)) fail("INVALID_TARGET_IAM", "Target IAM bindings must be an array.");
  const normalized = bindings.map((binding) => {
    if (!isPlainObject(binding)) fail("INVALID_TARGET_IAM", "Target IAM binding must be an object.");
    requireExactKeys(binding, ["role", "members"], "INVALID_TARGET_IAM", "IAM binding");
    const role = requireSafeText(binding.role, "INVALID_TARGET_IAM", "IAM role", 128);
    if (!Array.isArray(binding.members) || binding.members.length === 0) {
      fail("INVALID_TARGET_IAM", `${role} must have at least one member.`);
    }
    const members = binding.members.map((member) =>
      requireSafeText(member, "INVALID_TARGET_IAM", `${role} member`, 256),
    );
    if (new Set(members).size !== members.length) {
      fail("DUPLICATE_TARGET_IAM_MEMBER", `${role} contains a duplicate member.`);
    }
    return { role, members: [...members].sort() };
  });
  normalized.sort((left, right) => left.role.localeCompare(right.role));
  const roles = normalized.map((binding) => binding.role);
  if (new Set(roles).size !== roles.length) {
    fail("DUPLICATE_TARGET_IAM_ROLE", "Target IAM contains a duplicate role binding.");
  }
  return normalized;
};

export const calculateIamPolicyDigest = ({
  iamEvidenceScope,
  bucketIamBindings,
  inheritedIamBindings,
  effectiveIamBindings,
}) =>
  sha256(
    canonicalJson({
      iamEvidenceScope,
      bucketIamBindings: normalizeIamBindings(bucketIamBindings),
      inheritedIamBindings: normalizeIamBindings(inheritedIamBindings),
      effectiveIamBindings: normalizeIamBindings(effectiveIamBindings),
    }),
  );

const parseContract = () => JSON.parse(readFileSync(contractPath, "utf8"));

const deepFreeze = (value) => {
  if (Array.isArray(value) || isPlainObject(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const STORAGE_CUTOVER_CONTRACT = deepFreeze(parseContract());

const expectedBuckets = () =>
  new Map(
    FROZEN_BUCKET_EXPECTATIONS.map((bucket) => [bucket.sourceBucket, bucket]),
  );

const expectedTargetBuckets = () =>
  new Map(
    FROZEN_BUCKET_EXPECTATIONS.map((bucket) => [bucket.targetBucket, bucket]),
  );

const allowedRecordTypes = (records, allowed, code, label) => {
  for (const record of records) {
    if (!isPlainObject(record) || !allowed.has(record.recordType)) {
      fail(code, `${label} contains an unsupported record type.`);
    }
  }
};

export function calculateSourceInventoryDigest(records) {
  const canonicalRecords = records
    .filter((record) => record.recordType === "sourceBucket" || record.recordType === "sourceObject")
    .map((record) =>
      record.recordType === "sourceBucket"
        ? {
            recordType: record.recordType,
            bucketId: record.bucketId,
            public: record.public,
            objectCount: record.objectCount,
            totalBytes: record.totalBytes,
          }
        : {
            recordType: record.recordType,
            bucketId: record.bucketId,
            objectKey: record.objectKey,
            sizeBytes: record.sizeBytes,
            mimeType: record.mimeType,
            sourceUpdatedAt: record.sourceUpdatedAt,
            cacheControl: record.cacheControl,
            sha256: record.sha256,
          },
    );
  return canonicalDigest(canonicalRecords);
}

export function calculateTargetInventoryDigest(records) {
  const canonicalRecords = records
    .filter((record) =>
      ["targetBucket", "targetObject", "signedUrlIssuerEvidence"].includes(record.recordType),
    )
    .map((record) =>
      record.recordType === "targetBucket"
        ? {
            recordType: record.recordType,
            bucketName: record.bucketName,
            uniformBucketLevelAccess: record.uniformBucketLevelAccess,
            publicAccessPrevention: record.publicAccessPrevention,
            publicIamMembers: record.publicIamMembers,
            location: record.location,
            versioningEnabled: record.versioningEnabled,
            iamEvidenceScope: record.iamEvidenceScope,
            bucketIamBindings: normalizeIamBindings(record.bucketIamBindings),
            inheritedIamBindings: normalizeIamBindings(record.inheritedIamBindings),
            effectiveIamBindings: normalizeIamBindings(record.effectiveIamBindings),
            iamPolicyDigestSha256: record.iamPolicyDigestSha256,
          }
        : record.recordType === "signedUrlIssuerEvidence"
          ? {
              recordType: record.recordType,
              targetBucket: record.targetBucket,
              issuerMember: record.issuerMember,
              issuerProject: record.issuerProject,
              serviceAccountEnabled: record.serviceAccountEnabled,
              signBlobPermissionVerified: record.signBlobPermissionVerified,
              allowedMethods: record.allowedMethods,
              maximumTtlSeconds: record.maximumTtlSeconds,
              generationPinned: record.generationPinned,
              bucketAndObjectAllowlistEnforced: record.bucketAndObjectAllowlistEnforced,
              responseCacheControl: record.responseCacheControl,
              browserCredentialExposure: record.browserCredentialExposure,
              evidenceDigestSha256: record.evidenceDigestSha256,
            }
        : {
            recordType: record.recordType,
            sourceBucketId: record.sourceBucketId,
            sourceObjectKey: record.sourceObjectKey,
            targetBucket: record.targetBucket,
            targetObjectKey: record.targetObjectKey,
            generation: record.generation,
            sizeBytes: record.sizeBytes,
            mimeType: record.mimeType,
            sourceUpdatedAtMetadata: record.sourceUpdatedAtMetadata,
            sourceCacheControlMetadata: record.sourceCacheControlMetadata,
            servingCacheControl: record.servingCacheControl,
            sha256: record.sha256,
            accessMode: record.accessMode,
            publicAcl: record.publicAcl,
          },
    );
  return canonicalDigest(canonicalRecords);
}

export function calculateSignedUrlIssuerEvidenceDigest(records) {
  return canonicalDigest(
    records
      .filter((record) => record.recordType === "signedUrlIssuerEvidence")
      .map((record) => ({
        recordType: record.recordType,
        targetBucket: record.targetBucket,
        issuerMember: record.issuerMember,
        issuerProject: record.issuerProject,
        serviceAccountEnabled: record.serviceAccountEnabled,
        signBlobPermissionVerified: record.signBlobPermissionVerified,
        allowedMethods: record.allowedMethods,
        maximumTtlSeconds: record.maximumTtlSeconds,
        generationPinned: record.generationPinned,
        bucketAndObjectAllowlistEnforced: record.bucketAndObjectAllowlistEnforced,
        responseCacheControl: record.responseCacheControl,
        browserCredentialExposure: record.browserCredentialExposure,
        evidenceDigestSha256: record.evidenceDigestSha256,
      })),
  );
}

export function validateStorageContract(contract = STORAGE_CUTOVER_CONTRACT) {
  requireExactKeys(
    contract,
    [
      "schemaVersion",
      "contractId",
      "contractState",
      "trackingIssue",
      "frozenAt",
      "executionPolicy",
      "sourceSnapshot",
      "continuityPolicy",
      "targetPolicy",
      "parityContract",
      "signedUrlPolicy",
      "archivePlan",
      "buckets",
      "secondaryReferenceGates",
      "terminalSecondaryDispositions",
    ],
    "CONTRACT_SCHEMA_MISMATCH",
    "storage cutover contract",
  );
  requireExactKeys(
    contract.executionPolicy,
    [
      "allowedEnvironment",
      "allowedProject",
      "region",
      "liveSourceReadsAllowed",
      "liveTargetReadsAllowed",
      "objectCopiesAllowed",
      "objectDeletesAllowed",
      "productionExecutionAllowed",
      "productionProject",
    ],
    "CONTRACT_SCHEMA_MISMATCH",
    "execution policy",
  );
  requireExactKeys(
    contract.sourceSnapshot,
    [
      "provider",
      "projectRef",
      "inventorySchema",
      "bucketCount",
      "objectCount",
      "totalBytes",
      "privateInventoryMustRemainUntracked",
      "maximumPrivateInputBytes",
    ],
    "CONTRACT_SCHEMA_MISMATCH",
    "source snapshot contract",
  );
  requireExactKeys(
    contract.continuityPolicy,
    [
      "maximumHistoryEntries",
      "globalExportRunIdReuseAllowed",
      "globalDeltaEvidenceDigestReuseAllowed",
    ],
    "CONTRACT_SCHEMA_MISMATCH",
    "continuity policy",
  );
  requireExactKeys(
    contract.targetPolicy,
    [
      "provider",
      "project",
      "region",
      "inventorySchema",
      "uniformBucketLevelAccessRequired",
      "publicAccessPreventionRequired",
      "publicIamMembersAllowed",
      "objectPublicAclAllowed",
      "targetGenerationRequired",
      "bucketLocation",
      "objectVersioningRequired",
      "fullIamEvidenceRequired",
      "signedUrlIssuerEvidenceRequired",
      "iamEvidenceScope",
      "conditionalIamBindingsAllowed",
      "inheritedIamBindingsAllowed",
      "forbiddenIamMemberPrefixes",
    ],
    "CONTRACT_SCHEMA_MISMATCH",
    "target policy",
  );
  requireExactKeys(
    contract.signedUrlPolicy,
    [
      "issuer",
      "allowedMethods",
      "maximumTtlSeconds",
      "generationPinned",
      "bucketAndObjectAllowlistRequired",
      "issuerEvidenceRequired",
      "responseCacheControl",
      "browserCredentialExposureAllowed",
    ],
    "CONTRACT_SCHEMA_MISMATCH",
    "signed URL policy",
  );
  requireExactKeys(
    contract.archivePlan,
    [
      "planningOnly",
      "productionOnlyAfterCutover",
      "sourceFreezeSoakHours",
      "retentionDays",
      "retentionSeconds",
      "retentionLockRequired",
      "objectVersioningRequired",
      "cloudKmsCmekRequired",
      "kmsKeyRotationDays",
      "restoreDrillRequiredBeforeRetentionLock",
      "deleteAtExpiryRequiresSeparateApproval",
    ],
    "CONTRACT_SCHEMA_MISMATCH",
    "archive plan",
  );
  requireExact(contract.schemaVersion, "1.0.0", "CONTRACT_SCHEMA_MISMATCH", "schemaVersion");
  requireExact(
    contract.contractId,
    "hushh-tech-supabase-storage-cutover-v1",
    "CONTRACT_SCHEMA_MISMATCH",
    "contractId",
  );
  requireExact(contract.trackingIssue, 1950, "CONTRACT_SCHEMA_MISMATCH", "tracking issue");
  requireExact(
    contract.frozenAt,
    "2026-08-20T20:14:47.801539Z",
    "SOURCE_FREEZE_MISMATCH",
    "frozenAt",
  );
  requireExact(
    contract.contractState,
    "PLANNING_ONLY_NO_LIVE_IO",
    "CONTRACT_STATE_UNSAFE",
    "contractState",
  );
  requireExact(
    contract.executionPolicy.allowedEnvironment,
    "uat",
    "CONTRACT_ENVIRONMENT_UNSAFE",
    "allowedEnvironment",
  );
  requireExact(
    contract.executionPolicy.allowedProject,
    "hushh-tech-uat",
    "CONTRACT_PROJECT_UNSAFE",
    "allowed project",
  );
  requireExact(
    contract.executionPolicy.region,
    "us-central1",
    "CONTRACT_REGION_UNSAFE",
    "allowed region",
  );
  requireExact(
    contract.executionPolicy.productionProject,
    "hushh-tech-prod",
    "CONTRACT_PROJECT_UNSAFE",
    "production project",
  );
  for (const field of [
    "liveSourceReadsAllowed",
    "liveTargetReadsAllowed",
    "objectCopiesAllowed",
    "objectDeletesAllowed",
    "productionExecutionAllowed",
  ]) {
    requireExact(contract.executionPolicy[field], false, "CONTRACT_LIVE_IO_ENABLED", field);
  }

  requireExact(
    contract.sourceSnapshot.projectRef,
    "ibsisfnjxeowvdtvgzff",
    "CONTRACT_SOURCE_PROJECT_MISMATCH",
    "source project",
  );
  requireExact(contract.sourceSnapshot.provider, "supabase", "CONTRACT_SCHEMA_MISMATCH", "source provider");
  requireExact(
    contract.sourceSnapshot.inventorySchema,
    SOURCE_SCHEMA,
    "CONTRACT_SCHEMA_MISMATCH",
    "source inventory schema",
  );
  requireExact(
    contract.sourceSnapshot.privateInventoryMustRemainUntracked,
    true,
    "CONTRACT_INPUT_BOUND_UNSAFE",
    "private inventory tracking policy",
  );
  requireExact(
    contract.sourceSnapshot.maximumPrivateInputBytes,
    8_388_608,
    "CONTRACT_INPUT_BOUND_UNSAFE",
    "maximum private input size",
  );
  requireExact(
    contract.continuityPolicy.maximumHistoryEntries,
    MAXIMUM_CONTINUITY_HISTORY_ENTRIES,
    "CONTRACT_CONTINUITY_UNSAFE",
    "continuity history bound",
  );
  requireExact(
    contract.continuityPolicy.globalExportRunIdReuseAllowed,
    false,
    "CONTRACT_CONTINUITY_UNSAFE",
    "global export run replay policy",
  );
  requireExact(
    contract.continuityPolicy.globalDeltaEvidenceDigestReuseAllowed,
    false,
    "CONTRACT_CONTINUITY_UNSAFE",
    "global delta evidence replay policy",
  );

  const buckets = contract.buckets;
  requireExact(
    buckets.length,
    contract.sourceSnapshot.bucketCount,
    "CONTRACT_BUCKET_COUNT_MISMATCH",
    "bucket count",
  );
  const sourceNames = new Set(buckets.map((bucket) => bucket.sourceBucket));
  const targetNames = new Set(buckets.map((bucket) => bucket.targetBucket));
  requireExact(sourceNames.size, buckets.length, "CONTRACT_DUPLICATE_BUCKET", "source bucket set");
  requireExact(targetNames.size, buckets.length, "CONTRACT_DUPLICATE_BUCKET", "target bucket set");
  requireExactArray(
    buckets.map((bucket) => bucket.sourceBucket),
    [
      "assets",
      "community-uploads",
      "hushh-agent-profile-images",
      "hushh-ai-media",
      "hushh-gamma-pdf",
      "wa-evidence",
    ],
    "CONTRACT_BUCKET_MAPPING_MISMATCH",
    "source buckets",
  );
  requireExactArray(
    buckets.map((bucket) => bucket.targetBucket),
    [
      "hushh-tech-cutover-v1-assets-legal-uat",
      "hushh-tech-cutover-v1-community-content-uat",
      "hushh-tech-cutover-v1-profile-images-uat",
      "hushh-tech-cutover-v1-ai-media-uat",
      "hushh-tech-cutover-v1-reports-uat",
      "hushh-tech-cutover-v1-wa-evidence-uat",
    ],
    "CONTRACT_BUCKET_MAPPING_MISMATCH",
    "target buckets",
  );
  requireExact(
    canonicalJson(buckets),
    canonicalJson(FROZEN_BUCKET_EXPECTATIONS),
    "CONTRACT_BUCKET_MAPPING_MISMATCH",
    "exact bucket contracts",
  );

  const objectCount = buckets.reduce((sum, bucket) => sum + bucket.objectCount, 0);
  const totalBytes = buckets.reduce((sum, bucket) => sum + bucket.totalBytes, 0);
  requireExact(
    objectCount,
    contract.sourceSnapshot.objectCount,
    "CONTRACT_OBJECT_COUNT_MISMATCH",
    "object count",
  );
  requireExact(
    totalBytes,
    contract.sourceSnapshot.totalBytes,
    "CONTRACT_BYTE_COUNT_MISMATCH",
    "byte count",
  );

  requireExact(
    contract.targetPolicy.uniformBucketLevelAccessRequired,
    true,
    "CONTRACT_PUBLIC_ACCESS_UNSAFE",
    "uniform bucket-level access",
  );
  requireExact(
    contract.targetPolicy.provider,
    "gcp-cloud-storage",
    "CONTRACT_SCHEMA_MISMATCH",
    "target provider",
  );
  requireExact(
    contract.targetPolicy.inventorySchema,
    TARGET_SCHEMA,
    "CONTRACT_SCHEMA_MISMATCH",
    "target inventory schema",
  );
  requireExact(
    contract.targetPolicy.targetGenerationRequired,
    true,
    "CONTRACT_TARGET_POLICY_UNSAFE",
    "target generation policy",
  );
  requireExact(
    contract.targetPolicy.publicAccessPreventionRequired,
    true,
    "CONTRACT_PUBLIC_ACCESS_UNSAFE",
    "public access prevention",
  );
  requireExact(
    contract.targetPolicy.objectPublicAclAllowed,
    false,
    "CONTRACT_PUBLIC_ACCESS_UNSAFE",
    "object public ACL policy",
  );
  requireExact(
    contract.targetPolicy.bucketLocation,
    FROZEN_BUCKET_LOCATION,
    "CONTRACT_TARGET_LOCATION_UNSAFE",
    "target bucket location",
  );
  requireExact(
    contract.targetPolicy.project,
    FROZEN_TARGET_PROJECT,
    "CONTRACT_PROJECT_UNSAFE",
    "target policy project",
  );
  requireExact(
    contract.targetPolicy.region,
    FROZEN_TARGET_REGION,
    "CONTRACT_REGION_UNSAFE",
    "target policy region",
  );
  for (const [field, expected] of [
    ["objectVersioningRequired", true],
    ["fullIamEvidenceRequired", true],
    ["signedUrlIssuerEvidenceRequired", true],
  ]) {
    requireExact(contract.targetPolicy[field], expected, "CONTRACT_TARGET_POLICY_UNSAFE", field);
  }
  requireExactArray(
    contract.targetPolicy.publicIamMembersAllowed,
    [],
    "CONTRACT_PUBLIC_ACCESS_UNSAFE",
    "public IAM member allowlist",
  );
  requireExact(
    contract.targetPolicy.iamEvidenceScope,
    IAM_EVIDENCE_SCOPE,
    "CONTRACT_TARGET_IAM_UNSAFE",
    "IAM evidence scope",
  );
  requireExact(
    contract.targetPolicy.conditionalIamBindingsAllowed,
    false,
    "CONTRACT_TARGET_IAM_UNSAFE",
    "conditional IAM binding policy",
  );
  requireExactArray(
    contract.targetPolicy.inheritedIamBindingsAllowed,
    [],
    "CONTRACT_TARGET_IAM_UNSAFE",
    "inherited IAM binding allowlist",
  );
  requireExactArray(
    contract.targetPolicy.forbiddenIamMemberPrefixes,
    [
      "allUsers",
      "allAuthenticatedUsers",
      "projectOwner:",
      "projectEditor:",
      "projectViewer:",
      "domain:",
      "group:",
      "user:",
    ],
    "CONTRACT_TARGET_IAM_UNSAFE",
    "forbidden IAM member prefixes",
  );

  requireExact(
    contract.signedUrlPolicy.issuer,
    "server_service_identity_only",
    "SIGNED_URL_POLICY_UNSAFE",
    "signed URL issuer",
  );
  requireExactArray(
    contract.signedUrlPolicy.allowedMethods,
    ["GET", "HEAD"],
    "SIGNED_URL_POLICY_UNSAFE",
    "signed URL methods",
  );
  requireExact(
    contract.signedUrlPolicy.maximumTtlSeconds,
    300,
    "SIGNED_URL_POLICY_UNSAFE",
    "signed URL maximum TTL",
  );
  requireExact(
    contract.signedUrlPolicy.generationPinned,
    true,
    "SIGNED_URL_POLICY_UNSAFE",
    "signed URL generation pin",
  );
  for (const [field, expected] of [
    ["bucketAndObjectAllowlistRequired", true],
    ["issuerEvidenceRequired", true],
    ["responseCacheControl", "private, no-store"],
    ["browserCredentialExposureAllowed", false],
  ]) {
    requireExact(contract.signedUrlPolicy[field], expected, "SIGNED_URL_POLICY_UNSAFE", field);
  }

  for (const [field, expected] of [
    ["planningOnly", true],
    ["productionOnlyAfterCutover", true],
    ["sourceFreezeSoakHours", 72],
    ["retentionDays", 90],
    ["objectVersioningRequired", true],
    ["kmsKeyRotationDays", 90],
    ["restoreDrillRequiredBeforeRetentionLock", true],
    ["deleteAtExpiryRequiresSeparateApproval", true],
  ]) {
    requireExact(contract.archivePlan[field], expected, "ARCHIVE_POLICY_UNSAFE", field);
  }
  requireExact(
    contract.archivePlan.retentionSeconds,
    7_776_000,
    "ARCHIVE_POLICY_UNSAFE",
    "archive retention",
  );
  requireExact(
    contract.archivePlan.retentionLockRequired,
    true,
    "ARCHIVE_POLICY_UNSAFE",
    "archive retention lock",
  );
  requireExact(
    contract.archivePlan.cloudKmsCmekRequired,
    true,
    "ARCHIVE_POLICY_UNSAFE",
    "archive Cloud KMS encryption",
  );

  for (const bucket of buckets) {
    requireExact(
      bucket.targetServingCacheControl,
      "private, no-store",
      "CONTRACT_TARGET_CACHE_UNSAFE",
      `${bucket.sourceBucket} serving cache policy`,
    );
    if (!Array.isArray(bucket.signedUrlIssuers)) {
      fail("CONTRACT_SIGNED_URL_ISSUER_UNSAFE", `${bucket.sourceBucket} signed URL issuers are missing.`);
    }
    const normalizedBindings = normalizeIamBindings(bucket.allowedIamBindings);
    for (const binding of normalizedBindings) {
      if (
        binding.role !== FROZEN_MIGRATION_WRITER_ROLE &&
        !binding.role.startsWith("roles/storage.")
      ) {
        fail("CONTRACT_TARGET_IAM_UNSAFE", `${bucket.sourceBucket} has a non-storage IAM role.`);
      }
      for (const member of binding.members) {
        if (
          !member.startsWith("serviceAccount:") ||
          !member.endsWith(`@${FROZEN_TARGET_PROJECT}.iam.gserviceaccount.com`)
        ) {
          fail("CONTRACT_TARGET_IAM_UNSAFE", `${bucket.sourceBucket} has a non-service IAM member.`);
        }
      }
    }
    for (const issuer of bucket.signedUrlIssuers) {
      if (!issuer.startsWith("serviceAccount:") || !normalizedBindings.some((binding) => binding.members.includes(issuer))) {
        fail("CONTRACT_SIGNED_URL_ISSUER_UNSAFE", `${bucket.sourceBucket} has an unbound signed URL issuer.`);
      }
    }
  }

  const secondaryKeys = new Set(
    contract.secondaryReferenceGates.map((entry) => entry.referenceKey),
  );
  requireExact(
    secondaryKeys.size,
    6,
    "SECONDARY_REFERENCE_CONTRACT_MISMATCH",
    "secondary reference count",
  );
  requireExact(
    contract.secondaryReferenceGates.length,
    6,
    "SECONDARY_REFERENCE_CONTRACT_MISMATCH",
    "secondary reference entries",
  );

  return {
    valid: true,
    contractId: contract.contractId,
    contractDigestSha256: sha256(canonicalJson(contract)),
    bucketCount: buckets.length,
    objectCount,
    totalBytes,
    secondaryReferenceCount: secondaryKeys.size,
    executionAllowed: false,
  };
}

export function parseJsonLines(text, label = "inventory") {
  if (typeof text !== "string") fail("INVALID_JSONL", `${label} must be text.`);
  const records = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      fail("INVALID_JSONL", `${label} line ${index + 1} is not valid JSON.`);
    }
  }
  if (records.length === 0) fail("EMPTY_INVENTORY", `${label} is empty.`);
  return records;
}

const requireOneRecord = (records, recordType, code) => {
  const matches = records.filter((record) => record.recordType === recordType);
  if (matches.length !== 1) fail(code, `Expected exactly one ${recordType} record.`);
  return matches[0];
};

const validateSourceObject = (record, bucketContract) => {
  requireSha(record.sha256, "MISSING_SOURCE_HASH", "source object hash");
  requireExactKeys(record, RECORD_KEYS.sourceObject, "INVALID_SOURCE_OBJECT_SCHEMA", "source object");
  const bucketId = requireString(record.bucketId, "INVALID_SOURCE_OBJECT", "bucketId");
  const objectKey = requireString(record.objectKey, "INVALID_SOURCE_OBJECT", "objectKey");
  if (objectKey.includes("\0") || /[\r\n]/.test(objectKey)) {
    fail("INVALID_SOURCE_OBJECT_KEY", "An object key contains a forbidden control character.");
  }
  const id = objectIdentity(bucketId, objectKey);
  if (!bucketContract) fail("UNKNOWN_SOURCE_BUCKET", `Object ${id} uses an unknown source bucket.`);
  if (!isSafeInteger(record.sizeBytes)) {
    fail("INVALID_SOURCE_OBJECT_SIZE", `Object ${id} has an invalid byte count.`);
  }
  requireString(record.mimeType, "MISSING_SOURCE_MIME", `Object ${id} MIME type`);
  if (!isIsoTimestamp(record.sourceUpdatedAt)) {
    fail("INVALID_SOURCE_TIMESTAMP", `Object ${id} has an invalid source timestamp.`);
  }
  if (record.cacheControl !== null && typeof record.cacheControl !== "string") {
    fail("INVALID_SOURCE_CACHE_METADATA", `Object ${id} has invalid cache metadata.`);
  }
  requireSha(record.sha256, "MISSING_SOURCE_HASH", `Object ${id} hash`);
  return { ...record, objectId: id, fingerprint: sourceFingerprint(record) };
};

const validateSourceTombstone = (record, header, previousCheckpoint) => {
  requireExactKeys(
    record,
    RECORD_KEYS.sourceTombstone,
    "INVALID_SOURCE_TOMBSTONE_SCHEMA",
    "source tombstone",
  );
  const objectId = requireSha(record.objectId, "INVALID_SOURCE_TOMBSTONE", "tombstone object ID");
  const previousEntry = previousCheckpoint.entryById.get(objectId);
  if (!previousEntry) {
    fail("UNKNOWN_SOURCE_TOMBSTONE", `Tombstone ${objectId} is not in the prior source set.`);
  }
  requireExact(
    record.priorSourceFingerprintSha256,
    previousEntry.sourceFingerprintSha256,
    "SOURCE_TOMBSTONE_FINGERPRINT_MISMATCH",
    `Tombstone ${objectId} prior fingerprint`,
  );
  if (!isIsoTimestamp(record.deletedAt)) {
    fail("INVALID_SOURCE_TOMBSTONE", `Tombstone ${objectId} has an invalid deletion time.`);
  }
  if (
    Date.parse(record.deletedAt) <= Date.parse(previousCheckpoint.sourceFrozenAt) ||
    Date.parse(record.deletedAt) > Date.parse(header.frozenAt)
  ) {
    fail("SOURCE_TOMBSTONE_TIME_INVALID", `Tombstone ${objectId} is outside the delta window.`);
  }
  requireSafeText(record.deletionReason, "INVALID_SOURCE_TOMBSTONE", `Tombstone ${objectId} reason`);
  requireExact(
    record.previousSourceInventoryDigestSha256,
    previousCheckpoint.sourceInventoryDigestSha256,
    "SOURCE_TOMBSTONE_CONTINUITY_MISMATCH",
    `Tombstone ${objectId} prior inventory digest`,
  );
  requireExact(
    record.deltaEvidenceDigestSha256,
    header.deltaEvidenceDigestSha256,
    "SOURCE_TOMBSTONE_EVIDENCE_MISMATCH",
    `Tombstone ${objectId} evidence digest`,
  );
  requireExact(
    record.sourceArtifactDigestSha256,
    header.sourceArtifactDigestSha256,
    "SOURCE_TOMBSTONE_ARTIFACT_MISMATCH",
    `Tombstone ${objectId} artifact digest`,
  );
  return { ...record };
};

export function validateSourceInventory(
  records,
  { previousCheckpoint: rawPreviousCheckpoint = null } = {},
) {
  validateStorageContract();
  if (!Array.isArray(records)) fail("INVALID_SOURCE_INVENTORY", "Source inventory must be records.");
  allowedRecordTypes(
    records,
    new Set(["sourceInventory", "sourceBucket", "sourceObject", "sourceTombstone"]),
    "UNKNOWN_SOURCE_RECORD",
    "Source inventory",
  );
  const contract = STORAGE_CUTOVER_CONTRACT;
  const header = requireOneRecord(records, "sourceInventory", "SOURCE_HEADER_MISMATCH");
  requireExactKeys(
    header,
    RECORD_KEYS.sourceInventory,
    "SOURCE_HEADER_SCHEMA_MISMATCH",
    "source inventory header",
  );
  requireExact(header.schemaVersion, SOURCE_SCHEMA, "SOURCE_SCHEMA_MISMATCH", "source schema");
  requireExact(
    header.sourceProjectRef,
    contract.sourceSnapshot.projectRef,
    "SOURCE_PROJECT_MISMATCH",
    "source project",
  );
  const snapshotKind = header.snapshotKind;
  if (!isSafeInteger(header.snapshotSequence)) {
    fail("SOURCE_SEQUENCE_INVALID", "Source snapshot sequence must be a non-negative safe integer.");
  }
  requireSafeText(header.exportRunId, "SOURCE_EXPORT_RUN_INVALID", "source export run ID", 128);
  requireSha(
    header.sourceArtifactDigestSha256,
    "SOURCE_ARTIFACT_DIGEST_MISSING",
    "source artifact digest",
  );
  if (!isSafeInteger(header.tombstoneCount)) {
    fail("SOURCE_TOMBSTONE_COUNT_INVALID", "Source tombstone count must be a non-negative integer.");
  }
  let previousCheckpoint = null;
  if (snapshotKind === "FROZEN_BASELINE") {
    requireExact(header.frozenAt, contract.frozenAt, "SOURCE_FREEZE_MISMATCH", "source freeze time");
    requireExact(header.snapshotSequence, 0, "SOURCE_SEQUENCE_INVALID", "baseline snapshot sequence");
    requireExact(header.tombstoneCount, 0, "SOURCE_TOMBSTONE_COUNT_INVALID", "baseline tombstone count");
    requireExact(header.deltaEvidenceDigestSha256, null, "SOURCE_DELTA_EVIDENCE_UNSAFE", "baseline delta evidence");
    for (const field of [
      "previousCheckpointDigestSha256",
      "previousSourceInventoryDigestSha256",
      "previousSourceArtifactDigestSha256",
      "previousDeltaEvidenceDigestSha256",
    ]) {
      requireExact(header[field], null, "SOURCE_BASELINE_CONTINUITY_UNSAFE", field);
    }
    if (rawPreviousCheckpoint !== null) {
      fail("SOURCE_BASELINE_CHECKPOINT_UNSAFE", "A frozen baseline must not use a prior checkpoint.");
    }
  } else if (snapshotKind === "RECORDED_DELTA") {
    previousCheckpoint = validateCheckpoint(rawPreviousCheckpoint);
    if (!isIsoTimestamp(header.frozenAt) || Date.parse(header.frozenAt) <= Date.parse(previousCheckpoint.sourceFrozenAt)) {
      fail("SOURCE_DELTA_TIME_INVALID", "Recorded delta time must be strictly after the prior checkpoint.");
    }
    requireExact(
      header.snapshotSequence,
      previousCheckpoint.snapshotSequence + 1,
      "SOURCE_SEQUENCE_INVALID",
      "delta snapshot sequence",
    );
    requireExact(
      header.previousCheckpointDigestSha256,
      previousCheckpoint.checkpointDigestSha256,
      "SOURCE_DELTA_CHECKPOINT_MISMATCH",
      "previous checkpoint digest",
    );
    requireSha(
      header.previousSourceInventoryDigestSha256,
      "SOURCE_DELTA_EVIDENCE_MISSING",
      "previous source inventory digest",
    );
    requireSha(
      header.deltaEvidenceDigestSha256,
      "SOURCE_DELTA_EVIDENCE_MISSING",
      "delta evidence digest",
    );
    if (previousCheckpoint.sourceExportRunIdHistory.includes(header.exportRunId)) {
      fail("SOURCE_EXPORT_RUN_REPLAY", "Recorded delta reused an export run ID from checkpoint history.");
    }
    if (previousCheckpoint.deltaEvidenceDigestHistory.includes(header.deltaEvidenceDigestSha256)) {
      fail(
        "SOURCE_DELTA_EVIDENCE_REPLAY",
        "Recorded delta reused a delta evidence digest from checkpoint history.",
      );
    }
    requireExact(
      header.previousSourceInventoryDigestSha256,
      previousCheckpoint.sourceInventoryDigestSha256,
      "SOURCE_DELTA_PREVIOUS_DIGEST_MISMATCH",
      "previous source inventory digest",
    );
    requireExact(
      header.previousSourceArtifactDigestSha256,
      previousCheckpoint.sourceArtifactDigestSha256,
      "SOURCE_DELTA_PREVIOUS_ARTIFACT_MISMATCH",
      "previous source artifact digest",
    );
    requireExact(
      header.previousDeltaEvidenceDigestSha256,
      previousCheckpoint.deltaEvidenceDigestSha256,
      "SOURCE_DELTA_PREVIOUS_EVIDENCE_MISMATCH",
      "previous delta evidence digest",
    );
    if (header.sourceArtifactDigestSha256 === previousCheckpoint.sourceArtifactDigestSha256) {
      fail("SOURCE_ARTIFACT_REPLAY", "Recorded delta reused the prior source artifact digest.");
    }
  } else {
    fail("SOURCE_SNAPSHOT_KIND_BLOCKED", "Source inventory is not an allowed snapshot kind.");
  }
  requireExact(
    header.bucketCount,
    contract.sourceSnapshot.bucketCount,
    "SOURCE_BUCKET_COUNT_MISMATCH",
    "source bucket count",
  );
  if (!isSafeInteger(header.objectCount) || !isSafeInteger(header.totalBytes)) {
    fail("INVALID_SOURCE_HEADER_TOTAL", "Source header totals must be non-negative integers.");
  }
  if (snapshotKind === "FROZEN_BASELINE") {
    requireExact(
      header.objectCount,
      contract.sourceSnapshot.objectCount,
      "SOURCE_OBJECT_COUNT_MISMATCH",
      "source object count",
    );
    requireExact(
      header.totalBytes,
      contract.sourceSnapshot.totalBytes,
      "SOURCE_BYTE_COUNT_MISMATCH",
      "source byte count",
    );
  }

  const bucketContracts = expectedBuckets();
  const bucketRecords = records.filter((record) => record.recordType === "sourceBucket");
  requireExact(
    bucketRecords.length,
    contract.sourceSnapshot.bucketCount,
    "SOURCE_BUCKET_COUNT_MISMATCH",
    "source bucket records",
  );
  const seenBuckets = new Set();
  for (const bucket of bucketRecords) {
    requireExactKeys(bucket, RECORD_KEYS.sourceBucket, "INVALID_SOURCE_BUCKET_SCHEMA", "source bucket");
    const bucketId = requireString(bucket.bucketId, "INVALID_SOURCE_BUCKET", "bucketId");
    if (seenBuckets.has(bucketId)) fail("DUPLICATE_SOURCE_BUCKET", "A source bucket is duplicated.");
    seenBuckets.add(bucketId);
    const expected = bucketContracts.get(bucketId);
    if (!expected) fail("UNKNOWN_SOURCE_BUCKET", "The inventory contains an unknown source bucket.");
    requireExact(bucket.public, expected.sourcePublic, "SOURCE_PUBLIC_ACL_DRIFT", `${bucketId} public state`);
    if (!isSafeInteger(bucket.objectCount) || !isSafeInteger(bucket.totalBytes)) {
      fail("INVALID_SOURCE_BUCKET_TOTAL", `${bucketId} has invalid inventory totals.`);
    }
    if (snapshotKind === "FROZEN_BASELINE") {
      requireExact(
        bucket.objectCount,
        expected.objectCount,
        "SOURCE_BUCKET_OBJECT_COUNT_MISMATCH",
        `${bucketId} object count`,
      );
      requireExact(
        bucket.totalBytes,
        expected.totalBytes,
        "SOURCE_BUCKET_BYTE_COUNT_MISMATCH",
        `${bucketId} byte count`,
      );
    }
  }
  for (const bucketId of bucketContracts.keys()) {
    if (!seenBuckets.has(bucketId)) fail("MISSING_SOURCE_BUCKET", "A required source bucket is missing.");
  }

  const rawObjects = records.filter((record) => record.recordType === "sourceObject");
  requireExact(rawObjects.length, header.objectCount, "SOURCE_OBJECT_COUNT_MISMATCH", "source object records");
  const objects = [];
  const seenObjectIds = new Set();
  const aggregate = new Map(
    [...bucketContracts.keys()].map((bucketId) => [bucketId, { count: 0, bytes: 0 }]),
  );
  for (const rawObject of rawObjects) {
    const object = validateSourceObject(rawObject, bucketContracts.get(rawObject.bucketId));
    if (seenObjectIds.has(object.objectId)) {
      fail("DUPLICATE_SOURCE_OBJECT", `Object ${object.objectId} is duplicated.`);
    }
    seenObjectIds.add(object.objectId);
    const totals = aggregate.get(object.bucketId);
    totals.count += 1;
    totals.bytes += object.sizeBytes;
    objects.push(object);
  }

  const rawTombstones = records.filter((record) => record.recordType === "sourceTombstone");
  requireExact(
    rawTombstones.length,
    header.tombstoneCount,
    "SOURCE_TOMBSTONE_COUNT_MISMATCH",
    "source tombstone records",
  );
  const tombstones = [];
  const tombstoneById = new Map();
  if (snapshotKind === "FROZEN_BASELINE" && rawTombstones.length > 0) {
    fail("SOURCE_BASELINE_TOMBSTONE_UNSAFE", "Frozen baseline cannot contain tombstones.");
  }
  if (previousCheckpoint) {
    for (const priorTombstone of previousCheckpoint.tombstones) {
      if (seenObjectIds.has(priorTombstone.objectId)) {
        fail("SOURCE_OBJECT_RESURRECTED", `Object ${priorTombstone.objectId} was previously tombstoned.`);
      }
    }
    for (const rawTombstone of rawTombstones) {
      const tombstone = validateSourceTombstone(rawTombstone, header, previousCheckpoint);
      if (tombstoneById.has(tombstone.objectId)) {
        fail("DUPLICATE_SOURCE_TOMBSTONE", `Tombstone ${tombstone.objectId} is duplicated.`);
      }
      if (seenObjectIds.has(tombstone.objectId)) {
        fail("TOMBSTONED_SOURCE_OBJECT_PRESENT", `Object ${tombstone.objectId} is both live and tombstoned.`);
      }
      tombstoneById.set(tombstone.objectId, tombstone);
      tombstones.push(tombstone);
    }
    for (const previousEntry of previousCheckpoint.entries) {
      if (!seenObjectIds.has(previousEntry.objectId) && !tombstoneById.has(previousEntry.objectId)) {
        fail("SOURCE_OBJECT_REMOVED", `Object ${previousEntry.objectId} disappeared without a tombstone.`);
      }
    }
  }
  const bucketRecordById = new Map(bucketRecords.map((record) => [record.bucketId, record]));
  for (const [bucketId, expected] of bucketContracts) {
    const actual = aggregate.get(bucketId);
    requireExact(
      actual.count,
      bucketRecordById.get(bucketId).objectCount,
      "SOURCE_BUCKET_OBJECT_COUNT_MISMATCH",
      `${bucketId} object count`,
    );
    requireExact(
      actual.bytes,
      bucketRecordById.get(bucketId).totalBytes,
      "SOURCE_BUCKET_BYTE_COUNT_MISMATCH",
      `${bucketId} byte count`,
    );
    if (snapshotKind === "FROZEN_BASELINE") {
      requireExact(actual.count, expected.objectCount, "SOURCE_BUCKET_OBJECT_COUNT_MISMATCH", `${bucketId} baseline object count`);
      requireExact(actual.bytes, expected.totalBytes, "SOURCE_BUCKET_BYTE_COUNT_MISMATCH", `${bucketId} baseline byte count`);
    }
  }
  requireExact(
    objects.reduce((sum, object) => sum + object.sizeBytes, 0),
    header.totalBytes,
    "SOURCE_BYTE_COUNT_MISMATCH",
    "source byte count",
  );

  const digestSha256 = calculateSourceInventoryDigest(records);
  requireSha(header.inventoryDigestSha256, "SOURCE_INVENTORY_DIGEST_MISSING", "source inventory digest");
  requireExact(
    header.inventoryDigestSha256,
    digestSha256,
    "SOURCE_INVENTORY_DIGEST_MISMATCH",
    "source inventory digest",
  );

  const sourceArtifactDigestSha256 = calculateSourceArtifactDigest(records);
  requireExact(
    header.sourceArtifactDigestSha256,
    sourceArtifactDigestSha256,
    "SOURCE_ARTIFACT_DIGEST_MISMATCH",
    "source artifact digest",
  );

  return {
    header,
    bucketRecords,
    objects: objects.sort((left, right) => left.objectId.localeCompare(right.objectId)),
    objectById: new Map(objects.map((object) => [object.objectId, object])),
    digestSha256,
    objectCount: objects.length,
    totalBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0),
    snapshotKind,
    snapshotSequence: header.snapshotSequence,
    sourceArtifactDigestSha256,
    exportRunId: header.exportRunId,
    deltaEvidenceDigestSha256: header.deltaEvidenceDigestSha256,
    tombstones: tombstones.sort((left, right) => left.objectId.localeCompare(right.objectId)),
    tombstoneById,
    previousCheckpoint,
  };
}

const validateTargetBucket = (record, expected) => {
  requireExactKeys(record, RECORD_KEYS.targetBucket, "INVALID_TARGET_BUCKET_SCHEMA", "target bucket");
  const bucketName = requireString(record.bucketName, "INVALID_TARGET_BUCKET", "bucketName");
  if (!expected) fail("UNKNOWN_TARGET_BUCKET", "The target inventory contains an unknown bucket.");
  requireExact(
    record.uniformBucketLevelAccess,
    true,
    "TARGET_PUBLIC_ACCESS_DRIFT",
    `${bucketName} uniform bucket-level access`,
  );
  requireExact(
    record.publicAccessPrevention,
    "enforced",
    "TARGET_PUBLIC_ACCESS_DRIFT",
    `${bucketName} public access prevention`,
  );
  if (!Array.isArray(record.publicIamMembers) || record.publicIamMembers.length !== 0) {
    fail("TARGET_PUBLIC_ACCESS_DRIFT", `${bucketName} has a public IAM member.`);
  }
  requireExact(
    record.location,
    STORAGE_CUTOVER_CONTRACT.targetPolicy.bucketLocation,
    "TARGET_LOCATION_DRIFT",
    `${bucketName} location`,
  );
  requireExact(
    record.versioningEnabled,
    true,
    "TARGET_VERSIONING_DISABLED",
    `${bucketName} object versioning`,
  );
  requireExact(
    record.iamEvidenceScope,
    IAM_EVIDENCE_SCOPE,
    "TARGET_IAM_SCOPE_MISMATCH",
    `${bucketName} IAM evidence scope`,
  );
  const bucketBindings = normalizeIamBindings(record.bucketIamBindings);
  const inheritedBindings = normalizeIamBindings(record.inheritedIamBindings);
  const effectiveBindings = normalizeIamBindings(record.effectiveIamBindings);
  for (const binding of [...bucketBindings, ...inheritedBindings, ...effectiveBindings]) {
    if (
      ["roles/owner", "roles/editor", "roles/viewer"].includes(binding.role) ||
      binding.role.includes("legacy") ||
      (binding.role !== FROZEN_MIGRATION_WRITER_ROLE &&
        !binding.role.startsWith("roles/storage."))
    ) {
      fail("TARGET_IAM_ROLE_FORBIDDEN", `${bucketName} has a forbidden IAM role.`);
    }
    for (const member of binding.members) {
      if (
        STORAGE_CUTOVER_CONTRACT.targetPolicy.forbiddenIamMemberPrefixes.some((prefix) =>
          member.startsWith(prefix),
        )
      ) {
        fail("TARGET_IAM_MEMBER_FORBIDDEN", `${bucketName} has a forbidden IAM member.`);
      }
      if (
        !member.startsWith("serviceAccount:") ||
        !member.endsWith(`@${FROZEN_TARGET_PROJECT}.iam.gserviceaccount.com`)
      ) {
        fail("TARGET_IAM_MEMBER_FORBIDDEN", `${bucketName} IAM is restricted to service identities.`);
      }
    }
  }
  requireExact(
    canonicalJson(bucketBindings),
    canonicalJson(normalizeIamBindings(expected.allowedIamBindings)),
    "TARGET_IAM_ALLOWLIST_MISMATCH",
    `${bucketName} bucket IAM allowlist`,
  );
  requireExact(
    canonicalJson(inheritedBindings),
    canonicalJson([]),
    "TARGET_INHERITED_IAM_FORBIDDEN",
    `${bucketName} inherited IAM bindings`,
  );
  requireExact(
    canonicalJson(effectiveBindings),
    canonicalJson(bucketBindings),
    "TARGET_EFFECTIVE_IAM_MISMATCH",
    `${bucketName} effective IAM bindings`,
  );
  requireSha(record.iamPolicyDigestSha256, "TARGET_IAM_DIGEST_MISSING", `${bucketName} IAM digest`);
  requireExact(
    record.iamPolicyDigestSha256,
    calculateIamPolicyDigest({
      iamEvidenceScope: record.iamEvidenceScope,
      bucketIamBindings: record.bucketIamBindings,
      inheritedIamBindings: record.inheritedIamBindings,
      effectiveIamBindings: record.effectiveIamBindings,
    }),
    "TARGET_IAM_DIGEST_MISMATCH",
    `${bucketName} IAM digest`,
  );
};

const validateSignedUrlIssuerEvidence = (record, targetContracts) => {
  requireExactKeys(
    record,
    RECORD_KEYS.signedUrlIssuerEvidence,
    "INVALID_SIGNED_URL_ISSUER_EVIDENCE_SCHEMA",
    "signed URL issuer evidence",
  );
  const targetBucket = requireString(
    record.targetBucket,
    "INVALID_SIGNED_URL_ISSUER_EVIDENCE",
    "signed URL target bucket",
  );
  const expected = targetContracts.get(targetBucket);
  if (!expected) fail("UNKNOWN_TARGET_BUCKET", "Signed URL evidence uses an unknown target bucket.");
  const issuerMember = requireSafeText(
    record.issuerMember,
    "INVALID_SIGNED_URL_ISSUER_EVIDENCE",
    `${targetBucket} signed URL issuer`,
  );
  if (!expected.signedUrlIssuers.includes(issuerMember)) {
    fail("SIGNED_URL_ISSUER_NOT_ALLOWED", `${targetBucket} uses an unapproved signed URL issuer.`);
  }
  requireExact(
    record.issuerProject,
    STORAGE_CUTOVER_CONTRACT.targetPolicy.project,
    "SIGNED_URL_EVIDENCE_UNSAFE",
    `${targetBucket} signed URL issuer project`,
  );
  requireExact(
    record.serviceAccountEnabled,
    true,
    "SIGNED_URL_EVIDENCE_UNSAFE",
    `${targetBucket} signed URL issuer enabled state`,
  );
  requireExact(
    record.signBlobPermissionVerified,
    true,
    "SIGNED_URL_EVIDENCE_UNSAFE",
    `${targetBucket} signBlob permission`,
  );
  requireExactArray(
    record.allowedMethods,
    STORAGE_CUTOVER_CONTRACT.signedUrlPolicy.allowedMethods,
    "SIGNED_URL_EVIDENCE_UNSAFE",
    `${targetBucket} signed URL methods`,
  );
  for (const [field, expectedValue] of [
    ["maximumTtlSeconds", STORAGE_CUTOVER_CONTRACT.signedUrlPolicy.maximumTtlSeconds],
    ["generationPinned", true],
    ["bucketAndObjectAllowlistEnforced", true],
    ["responseCacheControl", STORAGE_CUTOVER_CONTRACT.signedUrlPolicy.responseCacheControl],
    ["browserCredentialExposure", false],
  ]) {
    requireExact(record[field], expectedValue, "SIGNED_URL_EVIDENCE_UNSAFE", `${targetBucket} ${field}`);
  }
  requireSha(
    record.evidenceDigestSha256,
    "SIGNED_URL_EVIDENCE_MISSING",
    `${targetBucket} signed URL evidence digest`,
  );
  return { ...record };
};

const validateTargetObject = (record, bucketContracts, targetContracts) => {
  if (typeof record.generation !== "string" || !/^[1-9]\d*$/.test(record.generation)) {
    fail("MISSING_TARGET_GENERATION", "Target object has no valid target generation.");
  }
  if (
    Object.prototype.hasOwnProperty.call(record, "cacheControl") &&
    record.cacheControl !== "private, no-store"
  ) {
    fail("TARGET_RAW_CACHE_METADATA_UNSAFE", "Target object contains an unsafe raw cache policy.");
  }
  requireExactKeys(record, RECORD_KEYS.targetObject, "INVALID_TARGET_OBJECT_SCHEMA", "target object");
  const sourceBucketId = requireString(
    record.sourceBucketId,
    "INVALID_TARGET_OBJECT",
    "sourceBucketId",
  );
  const sourceObjectKey = requireString(
    record.sourceObjectKey,
    "INVALID_TARGET_OBJECT",
    "sourceObjectKey",
  );
  const id = objectIdentity(sourceBucketId, sourceObjectKey);
  const bucketContract = bucketContracts.get(sourceBucketId);
  if (!bucketContract) fail("UNKNOWN_SOURCE_BUCKET", `Object ${id} uses an unknown source bucket.`);
  requireExact(
    record.targetBucket,
    bucketContract.targetBucket,
    "TARGET_BUCKET_MAPPING_DRIFT",
    `Object ${id} target bucket`,
  );
  if (!targetContracts.has(record.targetBucket)) {
    fail("UNKNOWN_TARGET_BUCKET", `Object ${id} uses an unknown target bucket.`);
  }
  requireString(record.targetObjectKey, "INVALID_TARGET_OBJECT", `Object ${id} target key`);
  requireExact(
    record.targetObjectKey,
    sourceObjectKey,
    "TARGET_OBJECT_KEY_DRIFT",
    `Object ${id} target key`,
  );
  if (typeof record.generation !== "string" || !/^[1-9]\d*$/.test(record.generation)) {
    fail("MISSING_TARGET_GENERATION", `Object ${id} has no valid target generation.`);
  }
  if (!isSafeInteger(record.sizeBytes)) {
    fail("INVALID_TARGET_OBJECT_SIZE", `Object ${id} has an invalid byte count.`);
  }
  requireString(record.mimeType, "MISSING_TARGET_MIME", `Object ${id} MIME type`);
  if (!isIsoTimestamp(record.sourceUpdatedAtMetadata)) {
    fail("INVALID_TARGET_SOURCE_TIMESTAMP", `Object ${id} has invalid source timestamp metadata.`);
  }
  if (record.sourceCacheControlMetadata !== null && typeof record.sourceCacheControlMetadata !== "string") {
    fail("INVALID_TARGET_CACHE_METADATA", `Object ${id} has invalid source cache provenance.`);
  }
  requireExact(
    record.servingCacheControl,
    bucketContract.targetServingCacheControl,
    "TARGET_SERVING_CACHE_UNSAFE",
    `Object ${id} serving cache policy`,
  );
  requireSha(record.sha256, "MISSING_TARGET_HASH", `Object ${id} hash`);
  requireExact(
    record.accessMode,
    bucketContract.targetAccessMode,
    "TARGET_ACCESS_MODE_DRIFT",
    `Object ${id} access mode`,
  );
  requireExact(record.publicAcl, false, "TARGET_PUBLIC_ACL_DRIFT", `Object ${id} public ACL`);
  return { ...record, objectId: id, fingerprint: targetFingerprint(record) };
};

export function validateTargetInventory(
  records,
  {
    requireComplete = false,
    expectedObjectCount = STORAGE_CUTOVER_CONTRACT.sourceSnapshot.objectCount,
    expectedTotalBytes = STORAGE_CUTOVER_CONTRACT.sourceSnapshot.totalBytes,
  } = {},
) {
  validateStorageContract();
  if (!Array.isArray(records)) fail("INVALID_TARGET_INVENTORY", "Target inventory must be records.");
  allowedRecordTypes(
    records,
    new Set(["targetInventory", "targetBucket", "targetObject", "signedUrlIssuerEvidence"]),
    "UNKNOWN_TARGET_RECORD",
    "Target inventory",
  );
  const contract = STORAGE_CUTOVER_CONTRACT;
  const header = requireOneRecord(records, "targetInventory", "TARGET_HEADER_MISMATCH");
  requireExactKeys(
    header,
    RECORD_KEYS.targetInventory,
    "TARGET_HEADER_SCHEMA_MISMATCH",
    "target inventory header",
  );
  requireExact(header.schemaVersion, TARGET_SCHEMA, "TARGET_SCHEMA_MISMATCH", "target schema");
  requireExact(header.environment, "uat", "PRODUCTION_EXECUTION_BLOCKED", "target environment");
  requireExact(header.project, contract.targetPolicy.project, "TARGET_PROJECT_MISMATCH", "target project");
  requireExact(header.region, contract.targetPolicy.region, "TARGET_REGION_MISMATCH", "target region");
  requireExact(
    header.bucketCount,
    contract.sourceSnapshot.bucketCount,
    "TARGET_BUCKET_COUNT_MISMATCH",
    "target bucket count",
  );
  if (!isSafeInteger(header.objectCount) || !isSafeInteger(header.totalBytes)) {
    fail("INVALID_TARGET_HEADER_TOTAL", "Target header totals must be non-negative integers.");
  }
  const expectedSignedUrlIssuerCount = contract.buckets.reduce(
    (sum, bucket) => sum + bucket.signedUrlIssuers.length,
    0,
  );
  requireExact(
    header.signedUrlIssuerCount,
    expectedSignedUrlIssuerCount,
    "SIGNED_URL_ISSUER_COUNT_MISMATCH",
    "signed URL issuer evidence count",
  );
  requireSha(
    header.sourceInventoryDigestSha256,
    "TARGET_SOURCE_DIGEST_MISSING",
    "target source inventory digest",
  );

  const bucketContracts = expectedBuckets();
  const targetContracts = expectedTargetBuckets();
  const bucketRecords = records.filter((record) => record.recordType === "targetBucket");
  requireExact(
    bucketRecords.length,
    contract.sourceSnapshot.bucketCount,
    "TARGET_BUCKET_COUNT_MISMATCH",
    "target bucket records",
  );
  const seenBuckets = new Set();
  for (const record of bucketRecords) {
    if (seenBuckets.has(record.bucketName)) fail("DUPLICATE_TARGET_BUCKET", "A target bucket is duplicated.");
    seenBuckets.add(record.bucketName);
    validateTargetBucket(record, targetContracts.get(record.bucketName));
  }
  for (const bucketName of targetContracts.keys()) {
    if (!seenBuckets.has(bucketName)) fail("MISSING_TARGET_BUCKET", "A required target bucket is missing.");
  }

  const rawIssuerEvidence = records.filter(
    (record) => record.recordType === "signedUrlIssuerEvidence",
  );
  requireExact(
    rawIssuerEvidence.length,
    expectedSignedUrlIssuerCount,
    "SIGNED_URL_ISSUER_COUNT_MISMATCH",
    "signed URL issuer evidence records",
  );
  const signedUrlIssuerEvidence = [];
  const seenIssuers = new Set();
  for (const record of rawIssuerEvidence) {
    const evidence = validateSignedUrlIssuerEvidence(record, targetContracts);
    const evidenceId = `${evidence.targetBucket}\0${evidence.issuerMember}`;
    if (seenIssuers.has(evidenceId)) {
      fail("DUPLICATE_SIGNED_URL_ISSUER", "Signed URL issuer evidence is duplicated.");
    }
    seenIssuers.add(evidenceId);
    signedUrlIssuerEvidence.push(evidence);
  }
  for (const bucket of contract.buckets) {
    for (const issuer of bucket.signedUrlIssuers) {
      if (!seenIssuers.has(`${bucket.targetBucket}\0${issuer}`)) {
        fail("MISSING_SIGNED_URL_ISSUER", `${bucket.targetBucket} is missing signed URL issuer evidence.`);
      }
    }
  }
  const signedUrlIssuerEvidenceDigestSha256 = calculateSignedUrlIssuerEvidenceDigest(records);
  requireSha(
    header.signedUrlIssuerEvidenceDigestSha256,
    "SIGNED_URL_EVIDENCE_DIGEST_MISSING",
    "signed URL issuer evidence digest",
  );
  requireExact(
    header.signedUrlIssuerEvidenceDigestSha256,
    signedUrlIssuerEvidenceDigestSha256,
    "SIGNED_URL_EVIDENCE_DIGEST_MISMATCH",
    "signed URL issuer evidence digest",
  );

  const rawObjects = records.filter((record) => record.recordType === "targetObject");
  if (requireComplete) {
    requireExact(
      rawObjects.length,
      expectedObjectCount,
      "TARGET_OBJECT_COUNT_MISMATCH",
      "target object records",
    );
  }
  const objects = [];
  const seenObjectIds = new Set();
  const seenTargetKeys = new Set();
  for (const rawObject of rawObjects) {
    const object = validateTargetObject(rawObject, bucketContracts, targetContracts);
    if (seenObjectIds.has(object.objectId)) {
      fail("DUPLICATE_TARGET_OBJECT", `Object ${object.objectId} is duplicated.`);
    }
    seenObjectIds.add(object.objectId);
    const targetKeyId = sha256(`${object.targetBucket}\0${object.targetObjectKey}`);
    if (seenTargetKeys.has(targetKeyId)) {
      fail("DUPLICATE_TARGET_KEY", `Target key ${targetKeyId} is duplicated.`);
    }
    seenTargetKeys.add(targetKeyId);
    objects.push(object);
  }

  const totalBytes = objects.reduce((sum, object) => sum + object.sizeBytes, 0);
  requireExact(header.objectCount, objects.length, "TARGET_OBJECT_COUNT_MISMATCH", "target object count");
  requireExact(header.totalBytes, totalBytes, "TARGET_BYTE_COUNT_MISMATCH", "target byte count");
  if (requireComplete) {
    requireExact(
      totalBytes,
      expectedTotalBytes,
      "TARGET_BYTE_COUNT_MISMATCH",
      "complete target byte count",
    );
  }

  const digestSha256 = calculateTargetInventoryDigest(records);
  requireSha(header.inventoryDigestSha256, "TARGET_INVENTORY_DIGEST_MISSING", "target inventory digest");
  requireExact(
    header.inventoryDigestSha256,
    digestSha256,
    "TARGET_INVENTORY_DIGEST_MISMATCH",
    "target inventory digest",
  );

  return {
    header,
    bucketRecords,
    signedUrlIssuerEvidence,
    signedUrlIssuerEvidenceDigestSha256,
    objects: objects.sort((left, right) => left.objectId.localeCompare(right.objectId)),
    objectById: new Map(objects.map((object) => [object.objectId, object])),
    digestSha256,
    objectCount: objects.length,
    totalBytes,
  };
}

const parityIssue = (source, target) => {
  const checks = [
    ["targetBucket", expectedBuckets().get(source.bucketId).targetBucket, target.targetBucket],
    ["targetObjectKey", source.objectKey, target.targetObjectKey],
    ["sizeBytes", source.sizeBytes, target.sizeBytes],
    ["mimeType", source.mimeType, target.mimeType],
    ["sourceUpdatedAtMetadata", source.sourceUpdatedAt, target.sourceUpdatedAtMetadata],
    ["sourceCacheControlMetadata", source.cacheControl, target.sourceCacheControlMetadata],
    [
      "servingCacheControl",
      expectedBuckets().get(source.bucketId).targetServingCacheControl,
      target.servingCacheControl,
    ],
    ["sha256", source.sha256, target.sha256],
    ["accessMode", expectedBuckets().get(source.bucketId).targetAccessMode, target.accessMode],
    ["publicAcl", false, target.publicAcl],
  ];
  const mismatch = checks.find(([, expected, actual]) => expected !== actual);
  return mismatch?.[0] || null;
};

const calculateContinuityChainDigest = (sourceExportRunIdHistory, deltaEvidenceDigestHistory) =>
  sha256(
    canonicalJson({
      sourceExportRunIdHistory,
      deltaEvidenceDigestHistory,
    }),
  );

export function buildSeedCopyPlan(sourceInventory) {
  const source = validateSourceInventory(sourceInventory);
  const actions = source.objects.map((object) => {
    const bucket = expectedBuckets().get(object.bucketId);
    return {
      action: "COPY_IF_ABSENT",
      objectId: object.objectId,
      sourceBucket: object.bucketId,
      targetBucket: bucket.targetBucket,
      expectedBytes: object.sizeBytes,
      expectedSha256: object.sha256,
      expectedAccessMode: bucket.targetAccessMode,
      expectedServingCacheControl: bucket.targetServingCacheControl,
      targetPrecondition: "doesNotExist",
    };
  });
  return {
    planType: "DRY_RUN_SEED_COPY_PLAN",
    executionAllowed: false,
    environment: "uat",
    sourceInventoryDigestSha256: source.digestSha256,
    sourceArtifactDigestSha256: source.sourceArtifactDigestSha256,
    actionCount: actions.length,
    expectedBytes: source.totalBytes,
    privateInventoryLookupRequired: true,
    actions,
  };
}

export function reconcileInventories(sourceInventory, targetInventory, rawCheckpoint = null) {
  const sourceHeader = sourceInventory.find((record) => record.recordType === "sourceInventory");
  const source = validateSourceInventory(sourceInventory, {
    previousCheckpoint: sourceHeader?.snapshotKind === "RECORDED_DELTA" ? rawCheckpoint : null,
  });
  const target = validateTargetInventory(targetInventory, {
    requireComplete: true,
    expectedObjectCount: source.objectCount,
    expectedTotalBytes: source.totalBytes,
  });
  requireExact(
    target.header.sourceInventoryDigestSha256,
    source.digestSha256,
    "TARGET_SOURCE_DIGEST_MISMATCH",
    "target source inventory digest",
  );
  for (const sourceObject of source.objects) {
    const targetObject = target.objectById.get(sourceObject.objectId);
    if (!targetObject) fail("MISSING_TARGET_OBJECT", `Object ${sourceObject.objectId} is missing.`);
    const mismatch = parityIssue(sourceObject, targetObject);
    if (mismatch) {
      fail("TARGET_OBJECT_PARITY_MISMATCH", `Object ${sourceObject.objectId} differs in ${mismatch}.`);
    }
  }
  for (const targetObject of target.objects) {
    if (!source.objectById.has(targetObject.objectId)) {
      fail("ORPHAN_TARGET_OBJECT", `Target object ${targetObject.objectId} has no source object.`);
    }
  }
  return {
    reconciled: true,
    environment: "uat",
    sourceInventoryDigestSha256: source.digestSha256,
    targetInventoryDigestSha256: target.digestSha256,
    targetSignerEvidenceDigestSha256: target.signedUrlIssuerEvidenceDigestSha256,
    objectCount: source.objectCount,
    totalBytes: source.totalBytes,
    tombstoneCount: source.tombstones.length,
    bucketCount: STORAGE_CUTOVER_CONTRACT.buckets.length,
    exactFields: STORAGE_CUTOVER_CONTRACT.parityContract.exactComparisons,
  };
}

const checkpointPayload = (checkpoint) => ({
  schemaVersion: checkpoint.schemaVersion,
  environment: checkpoint.environment,
  targetProject: checkpoint.targetProject,
  snapshotKind: checkpoint.snapshotKind,
  snapshotSequence: checkpoint.snapshotSequence,
  sourceFrozenAt: checkpoint.sourceFrozenAt,
  sourceExportRunId: checkpoint.sourceExportRunId,
  sourceArtifactDigestSha256: checkpoint.sourceArtifactDigestSha256,
  deltaEvidenceDigestSha256: checkpoint.deltaEvidenceDigestSha256,
  sourceExportRunIdHistory: checkpoint.sourceExportRunIdHistory,
  deltaEvidenceDigestHistory: checkpoint.deltaEvidenceDigestHistory,
  sourceContinuityChainDigestSha256: checkpoint.sourceContinuityChainDigestSha256,
  sourceInventoryDigestSha256: checkpoint.sourceInventoryDigestSha256,
  sourceObjectCount: checkpoint.sourceObjectCount,
  sourceTotalBytes: checkpoint.sourceTotalBytes,
  targetInventoryDigestSha256: checkpoint.targetInventoryDigestSha256,
  targetSignerEvidenceDigestSha256: checkpoint.targetSignerEvidenceDigestSha256,
  targetObjectCount: checkpoint.targetObjectCount,
  entries: checkpoint.entries,
  tombstones: checkpoint.tombstones,
  executionAllowed: checkpoint.executionAllowed,
});

export function buildCheckpointPlan(sourceInventory, targetInventory, rawPreviousCheckpoint = null) {
  const sourceHeader = sourceInventory.find((record) => record.recordType === "sourceInventory");
  const source = validateSourceInventory(sourceInventory, {
    previousCheckpoint: sourceHeader?.snapshotKind === "RECORDED_DELTA" ? rawPreviousCheckpoint : null,
  });
  const target = validateTargetInventory(targetInventory);
  requireExact(
    target.header.sourceInventoryDigestSha256,
    source.digestSha256,
    "TARGET_SOURCE_DIGEST_MISMATCH",
    "target source inventory digest",
  );
  for (const targetObject of target.objects) {
    if (!source.objectById.has(targetObject.objectId)) {
      fail("ORPHAN_TARGET_OBJECT", `Target object ${targetObject.objectId} has no source object.`);
    }
  }
  const entries = source.objects.map((sourceObject) => {
    const targetObject = target.objectById.get(sourceObject.objectId);
    if (targetObject) {
      const mismatch = parityIssue(sourceObject, targetObject);
      if (mismatch) {
        fail("CHECKPOINT_PARITY_MISMATCH", `Object ${sourceObject.objectId} differs in ${mismatch}.`);
      }
    }
    return {
      objectId: sourceObject.objectId,
      sourceFingerprintSha256: sourceObject.fingerprint,
      targetState: targetObject ? TARGET_PRESENT : TARGET_ABSENT,
      targetFingerprintSha256: targetObject?.fingerprint || null,
      targetGeneration: targetObject?.generation || null,
    };
  });
  const tombstones = [
    ...(source.previousCheckpoint?.tombstones || []),
    ...source.tombstones.map((tombstone) => ({
      objectId: tombstone.objectId,
      priorSourceFingerprintSha256: tombstone.priorSourceFingerprintSha256,
      deletedAt: tombstone.deletedAt,
      deletionReasonDigestSha256: sha256(tombstone.deletionReason),
      previousSourceInventoryDigestSha256: tombstone.previousSourceInventoryDigestSha256,
      deltaEvidenceDigestSha256: tombstone.deltaEvidenceDigestSha256,
      sourceArtifactDigestSha256: tombstone.sourceArtifactDigestSha256,
    })),
  ].sort((left, right) => left.objectId.localeCompare(right.objectId));
  if (new Set(tombstones.map((entry) => entry.objectId)).size !== tombstones.length) {
    fail("DUPLICATE_CHECKPOINT_TOMBSTONE", "Checkpoint tombstone history contains a duplicate object.");
  }
  const sourceExportRunIdHistory = [
    ...(source.previousCheckpoint?.sourceExportRunIdHistory || []),
    source.exportRunId,
  ];
  const deltaEvidenceDigestHistory = [
    ...(source.previousCheckpoint?.deltaEvidenceDigestHistory || []),
    ...(source.deltaEvidenceDigestSha256 === null ? [] : [source.deltaEvidenceDigestSha256]),
  ];
  if (
    sourceExportRunIdHistory.length > MAXIMUM_CONTINUITY_HISTORY_ENTRIES ||
    deltaEvidenceDigestHistory.length > MAXIMUM_CONTINUITY_HISTORY_ENTRIES
  ) {
    fail("CHECKPOINT_HISTORY_LIMIT_EXCEEDED", "Checkpoint continuity history exceeds its bound.");
  }
  const checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA,
    environment: "uat",
    targetProject: STORAGE_CUTOVER_CONTRACT.targetPolicy.project,
    snapshotKind: source.snapshotKind,
    snapshotSequence: source.snapshotSequence,
    sourceFrozenAt: source.header.frozenAt,
    sourceExportRunId: source.exportRunId,
    sourceArtifactDigestSha256: source.sourceArtifactDigestSha256,
    deltaEvidenceDigestSha256: source.deltaEvidenceDigestSha256,
    sourceExportRunIdHistory,
    deltaEvidenceDigestHistory,
    sourceContinuityChainDigestSha256: calculateContinuityChainDigest(
      sourceExportRunIdHistory,
      deltaEvidenceDigestHistory,
    ),
    sourceInventoryDigestSha256: source.digestSha256,
    sourceObjectCount: source.objectCount,
    sourceTotalBytes: source.totalBytes,
    targetInventoryDigestSha256: target.digestSha256,
    targetSignerEvidenceDigestSha256: target.signedUrlIssuerEvidenceDigestSha256,
    targetObjectCount: target.objectCount,
    entries: entries.sort((left, right) => left.objectId.localeCompare(right.objectId)),
    tombstones,
    executionAllowed: false,
  };
  return {
    ...checkpoint,
    checkpointDigestSha256: sha256(canonicalJson(checkpointPayload(checkpoint))),
  };
}

export function validateCheckpoint(checkpoint) {
  if (!isPlainObject(checkpoint)) fail("INVALID_CHECKPOINT", "Checkpoint must be an object.");
  requireExactKeys(
    checkpoint,
    [
      "schemaVersion",
      "environment",
      "targetProject",
      "snapshotKind",
      "snapshotSequence",
      "sourceFrozenAt",
      "sourceExportRunId",
      "sourceArtifactDigestSha256",
      "deltaEvidenceDigestSha256",
      "sourceExportRunIdHistory",
      "deltaEvidenceDigestHistory",
      "sourceContinuityChainDigestSha256",
      "sourceInventoryDigestSha256",
      "sourceObjectCount",
      "sourceTotalBytes",
      "targetInventoryDigestSha256",
      "targetSignerEvidenceDigestSha256",
      "targetObjectCount",
      "entries",
      "tombstones",
      "executionAllowed",
      "checkpointDigestSha256",
    ],
    "CHECKPOINT_SCHEMA_MISMATCH",
    "checkpoint",
  );
  requireExact(checkpoint.schemaVersion, CHECKPOINT_SCHEMA, "CHECKPOINT_SCHEMA_MISMATCH", "checkpoint schema");
  requireExact(checkpoint.environment, "uat", "PRODUCTION_EXECUTION_BLOCKED", "checkpoint environment");
  requireExact(
    checkpoint.targetProject,
    STORAGE_CUTOVER_CONTRACT.targetPolicy.project,
    "CHECKPOINT_PROJECT_MISMATCH",
    "checkpoint project",
  );
  requireExact(
    checkpoint.executionAllowed,
    false,
    "CHECKPOINT_EXECUTION_UNSAFE",
    "checkpoint execution policy",
  );
  if (!["FROZEN_BASELINE", "RECORDED_DELTA"].includes(checkpoint.snapshotKind)) {
    fail("INVALID_CHECKPOINT", "Checkpoint snapshot kind is invalid.");
  }
  if (!isSafeInteger(checkpoint.snapshotSequence)) {
    fail("INVALID_CHECKPOINT", "Checkpoint snapshot sequence is invalid.");
  }
  if (
    (checkpoint.snapshotKind === "FROZEN_BASELINE" && checkpoint.snapshotSequence !== 0) ||
    (checkpoint.snapshotKind === "RECORDED_DELTA" && checkpoint.snapshotSequence < 1)
  ) {
    fail("INVALID_CHECKPOINT", "Checkpoint snapshot kind and sequence disagree.");
  }
  if (!isIsoTimestamp(checkpoint.sourceFrozenAt)) {
    fail("INVALID_CHECKPOINT", "Checkpoint source time is invalid.");
  }
  requireSafeText(checkpoint.sourceExportRunId, "INVALID_CHECKPOINT", "checkpoint export run ID", 128);
  requireSha(
    checkpoint.sourceArtifactDigestSha256,
    "INVALID_CHECKPOINT",
    "checkpoint source artifact digest",
  );
  requireNullableSha(
    checkpoint.deltaEvidenceDigestSha256,
    "INVALID_CHECKPOINT",
    "checkpoint delta evidence digest",
  );
  if (
    (checkpoint.snapshotKind === "FROZEN_BASELINE" && checkpoint.deltaEvidenceDigestSha256 !== null) ||
    (checkpoint.snapshotKind === "RECORDED_DELTA" && checkpoint.deltaEvidenceDigestSha256 === null)
  ) {
    fail("INVALID_CHECKPOINT", "Checkpoint delta evidence does not match its snapshot kind.");
  }
  if (
    !Array.isArray(checkpoint.sourceExportRunIdHistory) ||
    !Array.isArray(checkpoint.deltaEvidenceDigestHistory)
  ) {
    fail("INVALID_CHECKPOINT_HISTORY", "Checkpoint continuity history is missing.");
  }
  if (
    checkpoint.sourceExportRunIdHistory.length > MAXIMUM_CONTINUITY_HISTORY_ENTRIES ||
    checkpoint.deltaEvidenceDigestHistory.length > MAXIMUM_CONTINUITY_HISTORY_ENTRIES
  ) {
    fail("CHECKPOINT_HISTORY_LIMIT_EXCEEDED", "Checkpoint continuity history exceeds its bound.");
  }
  requireExact(
    checkpoint.sourceExportRunIdHistory.length,
    checkpoint.snapshotSequence + 1,
    "INVALID_CHECKPOINT_HISTORY",
    "checkpoint export run history length",
  );
  requireExact(
    checkpoint.deltaEvidenceDigestHistory.length,
    checkpoint.snapshotSequence,
    "INVALID_CHECKPOINT_HISTORY",
    "checkpoint delta evidence history length",
  );
  const normalizedRunHistory = checkpoint.sourceExportRunIdHistory.map((runId) =>
    requireSafeText(runId, "INVALID_CHECKPOINT_HISTORY", "checkpoint export run history entry", 128),
  );
  const normalizedEvidenceHistory = checkpoint.deltaEvidenceDigestHistory.map((digest) =>
    requireSha(digest, "INVALID_CHECKPOINT_HISTORY", "checkpoint delta evidence history entry"),
  );
  if (new Set(normalizedRunHistory).size !== normalizedRunHistory.length) {
    fail("SOURCE_EXPORT_RUN_REPLAY", "Checkpoint export run history contains a replay.");
  }
  if (new Set(normalizedEvidenceHistory).size !== normalizedEvidenceHistory.length) {
    fail("SOURCE_DELTA_EVIDENCE_REPLAY", "Checkpoint delta evidence history contains a replay.");
  }
  requireExact(
    normalizedRunHistory.at(-1),
    checkpoint.sourceExportRunId,
    "INVALID_CHECKPOINT_HISTORY",
    "checkpoint latest export run",
  );
  requireExact(
    normalizedEvidenceHistory.at(-1) ?? null,
    checkpoint.deltaEvidenceDigestSha256,
    "INVALID_CHECKPOINT_HISTORY",
    "checkpoint latest delta evidence",
  );
  requireSha(
    checkpoint.sourceContinuityChainDigestSha256,
    "INVALID_CHECKPOINT_HISTORY",
    "checkpoint continuity chain digest",
  );
  requireExact(
    checkpoint.sourceContinuityChainDigestSha256,
    calculateContinuityChainDigest(normalizedRunHistory, normalizedEvidenceHistory),
    "CHECKPOINT_CONTINUITY_DIGEST_MISMATCH",
    "checkpoint continuity chain digest",
  );
  requireSha(
    checkpoint.sourceInventoryDigestSha256,
    "INVALID_CHECKPOINT",
    "checkpoint source digest",
  );
  requireSha(
    checkpoint.targetInventoryDigestSha256,
    "INVALID_CHECKPOINT",
    "checkpoint target digest",
  );
  requireSha(
    checkpoint.targetSignerEvidenceDigestSha256,
    "INVALID_CHECKPOINT",
    "checkpoint target signer evidence digest",
  );
  if (
    !isSafeInteger(checkpoint.sourceObjectCount) ||
    !isSafeInteger(checkpoint.sourceTotalBytes) ||
    !isSafeInteger(checkpoint.targetObjectCount)
  ) {
    fail("INVALID_CHECKPOINT", "Checkpoint source or target totals are invalid.");
  }
  if (!Array.isArray(checkpoint.entries)) fail("INVALID_CHECKPOINT", "Checkpoint entries are missing.");
  requireExact(
    checkpoint.entries.length,
    checkpoint.sourceObjectCount,
    "CHECKPOINT_SOURCE_SET_INCOMPLETE",
    "checkpoint source object set",
  );
  const seen = new Set();
  for (const entry of checkpoint.entries) {
    requireExactKeys(
      entry,
      [
        "objectId",
        "sourceFingerprintSha256",
        "targetState",
        "targetFingerprintSha256",
        "targetGeneration",
      ],
      "INVALID_CHECKPOINT_ENTRY_SCHEMA",
      "checkpoint entry",
    );
    requireSha(entry.objectId, "INVALID_CHECKPOINT", "checkpoint object ID");
    requireSha(entry.sourceFingerprintSha256, "INVALID_CHECKPOINT", "checkpoint source fingerprint");
    if (![TARGET_PRESENT, TARGET_ABSENT].includes(entry.targetState)) {
      fail("INVALID_CHECKPOINT", `Checkpoint object ${entry.objectId} has an invalid target state.`);
    }
    if (entry.targetState === TARGET_PRESENT) {
      requireSha(entry.targetFingerprintSha256, "INVALID_CHECKPOINT", "checkpoint target fingerprint");
      if (typeof entry.targetGeneration !== "string" || !/^[1-9]\d*$/.test(entry.targetGeneration)) {
        fail("INVALID_CHECKPOINT", `Checkpoint object ${entry.objectId} has an invalid generation.`);
      }
    } else if (entry.targetFingerprintSha256 !== null || entry.targetGeneration !== null) {
      fail("INVALID_CHECKPOINT", `Checkpoint object ${entry.objectId} has target data while absent.`);
    }
    if (seen.has(entry.objectId)) fail("DUPLICATE_CHECKPOINT_OBJECT", "A checkpoint object is duplicated.");
    seen.add(entry.objectId);
  }
  requireExact(
    checkpoint.entries.filter((entry) => entry.targetState === TARGET_PRESENT).length,
    checkpoint.targetObjectCount,
    "CHECKPOINT_TARGET_SET_MISMATCH",
    "checkpoint target object set",
  );
  if (!Array.isArray(checkpoint.tombstones)) {
    fail("INVALID_CHECKPOINT", "Checkpoint tombstone history is missing.");
  }
  const tombstoneIds = new Set();
  for (const tombstone of checkpoint.tombstones) {
    requireExactKeys(
      tombstone,
      [
        "objectId",
        "priorSourceFingerprintSha256",
        "deletedAt",
        "deletionReasonDigestSha256",
        "previousSourceInventoryDigestSha256",
        "deltaEvidenceDigestSha256",
        "sourceArtifactDigestSha256",
      ],
      "INVALID_CHECKPOINT_TOMBSTONE_SCHEMA",
      "checkpoint tombstone",
    );
    requireSha(tombstone.objectId, "INVALID_CHECKPOINT", "checkpoint tombstone object ID");
    requireSha(
      tombstone.priorSourceFingerprintSha256,
      "INVALID_CHECKPOINT",
      "checkpoint tombstone prior fingerprint",
    );
    if (
      !isIsoTimestamp(tombstone.deletedAt) ||
      Date.parse(tombstone.deletedAt) > Date.parse(checkpoint.sourceFrozenAt)
    ) {
      fail("INVALID_CHECKPOINT", "Checkpoint tombstone time is invalid.");
    }
    requireSha(
      tombstone.deletionReasonDigestSha256,
      "INVALID_CHECKPOINT",
      "checkpoint tombstone reason digest",
    );
    requireSha(
      tombstone.previousSourceInventoryDigestSha256,
      "INVALID_CHECKPOINT",
      "checkpoint tombstone prior inventory digest",
    );
    requireSha(
      tombstone.deltaEvidenceDigestSha256,
      "INVALID_CHECKPOINT",
      "checkpoint tombstone evidence digest",
    );
    requireSha(
      tombstone.sourceArtifactDigestSha256,
      "INVALID_CHECKPOINT",
      "checkpoint tombstone artifact digest",
    );
    if (seen.has(tombstone.objectId)) {
      fail("CHECKPOINT_TOMBSTONED_OBJECT_PRESENT", `Checkpoint object ${tombstone.objectId} is live and tombstoned.`);
    }
    if (tombstoneIds.has(tombstone.objectId)) {
      fail("DUPLICATE_CHECKPOINT_TOMBSTONE", "Checkpoint tombstone is duplicated.");
    }
    tombstoneIds.add(tombstone.objectId);
  }
  const expectedDigest = sha256(canonicalJson(checkpointPayload(checkpoint)));
  requireExact(
    checkpoint.checkpointDigestSha256,
    expectedDigest,
    "CHECKPOINT_DIGEST_MISMATCH",
    "checkpoint digest",
  );
  return {
    ...checkpoint,
    entryById: new Map(checkpoint.entries.map((entry) => [entry.objectId, entry])),
    tombstoneById: new Map(checkpoint.tombstones.map((entry) => [entry.objectId, entry])),
  };
}

export function buildDeltaPlan(sourceInventory, targetInventory, rawCheckpoint) {
  const checkpoint = validateCheckpoint(rawCheckpoint);
  const source = validateSourceInventory(sourceInventory, {
    previousCheckpoint: rawCheckpoint,
  });
  const target = validateTargetInventory(targetInventory);
  requireExact(
    target.header.sourceInventoryDigestSha256,
    checkpoint.sourceInventoryDigestSha256,
    "TARGET_SOURCE_DIGEST_MISMATCH",
    "target source inventory digest",
  );
  for (const checkpointEntry of checkpoint.entries) {
    const targetObject = target.objectById.get(checkpointEntry.objectId);
    if (checkpointEntry.targetState === TARGET_PRESENT) {
      if (!targetObject) {
        fail("TARGET_OBJECT_MISSING_AFTER_CHECKPOINT", `Object ${checkpointEntry.objectId} is missing after checkpoint.`);
      }
      if (targetObject.generation !== checkpointEntry.targetGeneration) {
        fail("TARGET_GENERATION_CHANGED", `Object ${checkpointEntry.objectId} changed generation after checkpoint.`);
      }
      if (targetObject.fingerprint !== checkpointEntry.targetFingerprintSha256) {
        fail("TARGET_OBJECT_CHANGED", `Object ${checkpointEntry.objectId} changed after checkpoint.`);
      }
    } else if (targetObject) {
      fail("UNTRACKED_TARGET_OBJECT", `Object ${checkpointEntry.objectId} appeared after an absent checkpoint.`);
    }
  }
  requireExact(
    target.digestSha256,
    checkpoint.targetInventoryDigestSha256,
    "TARGET_EVIDENCE_CHANGED_AFTER_CHECKPOINT",
    "target inventory checkpoint digest",
  );
  requireExact(
    target.signedUrlIssuerEvidenceDigestSha256,
    checkpoint.targetSignerEvidenceDigestSha256,
    "TARGET_SIGNER_EVIDENCE_CHANGED_AFTER_CHECKPOINT",
    "target signer evidence checkpoint digest",
  );

  const actions = [];
  for (const tombstone of source.tombstones) {
    const checkpointEntry = checkpoint.entryById.get(tombstone.objectId);
    if (checkpointEntry.targetState === TARGET_PRESENT) {
      actions.push({
        action: "DELETE_IF_GENERATION_MATCH",
        objectId: tombstone.objectId,
        ifGenerationMatch: checkpointEntry.targetGeneration,
        deletedAt: tombstone.deletedAt,
        deletionReasonDigestSha256: sha256(tombstone.deletionReason),
        deltaEvidenceDigestSha256: tombstone.deltaEvidenceDigestSha256,
        sourceArtifactDigestSha256: tombstone.sourceArtifactDigestSha256,
      });
    } else {
      actions.push({
        action: "DELETE_NOOP",
        objectId: tombstone.objectId,
        deltaEvidenceDigestSha256: tombstone.deltaEvidenceDigestSha256,
        sourceArtifactDigestSha256: tombstone.sourceArtifactDigestSha256,
      });
    }
  }
  for (const sourceObject of source.objects) {
    const bucket = expectedBuckets().get(sourceObject.bucketId);
    const targetObject = target.objectById.get(sourceObject.objectId);
    const checkpointEntry = checkpoint.entryById.get(sourceObject.objectId);
    if (!targetObject) {
      if (checkpointEntry?.targetState === TARGET_PRESENT) {
        fail("TARGET_OBJECT_MISSING_AFTER_CHECKPOINT", `Object ${sourceObject.objectId} is missing after checkpoint.`);
      }
      actions.push({
        action: "COPY_IF_ABSENT",
        objectId: sourceObject.objectId,
        sourceBucket: sourceObject.bucketId,
        targetBucket: bucket.targetBucket,
        expectedBytes: sourceObject.sizeBytes,
        expectedSha256: sourceObject.sha256,
        expectedAccessMode: bucket.targetAccessMode,
        expectedServingCacheControl: bucket.targetServingCacheControl,
        targetPrecondition: "doesNotExist",
      });
      continue;
    }
    if (!checkpointEntry || checkpointEntry.targetState !== TARGET_PRESENT) {
      fail("UNTRACKED_TARGET_OBJECT", `Object ${sourceObject.objectId} exists without a checkpoint entry.`);
    }
    if (sourceObject.fingerprint === checkpointEntry.sourceFingerprintSha256) {
      const mismatch = parityIssue(sourceObject, targetObject);
      if (mismatch) {
        fail("TARGET_OBJECT_PARITY_MISMATCH", `Object ${sourceObject.objectId} differs in ${mismatch}.`);
      }
      actions.push({
        action: "NOOP",
        objectId: sourceObject.objectId,
        targetGeneration: targetObject.generation,
      });
      continue;
    }
    actions.push({
      action: "COPY_NEW_GENERATION_IF_MATCH",
      objectId: sourceObject.objectId,
      sourceBucket: sourceObject.bucketId,
      targetBucket: bucket.targetBucket,
      expectedBytes: sourceObject.sizeBytes,
      expectedSha256: sourceObject.sha256,
      expectedAccessMode: bucket.targetAccessMode,
      expectedServingCacheControl: bucket.targetServingCacheControl,
      ifGenerationMatch: targetObject.generation,
    });
  }
  for (const targetObject of target.objects) {
    if (!source.objectById.has(targetObject.objectId) && !source.tombstoneById.has(targetObject.objectId)) {
      fail("ORPHAN_TARGET_OBJECT", `Target object ${targetObject.objectId} has no source object.`);
    }
  }

  return {
    planType: "DRY_RUN_DELTA_COPY_PLAN",
    executionAllowed: false,
    environment: "uat",
    checkpointDigestSha256: checkpoint.checkpointDigestSha256,
    sourceInventoryDigestSha256: source.digestSha256,
    sourceArtifactDigestSha256: source.sourceArtifactDigestSha256,
    deltaEvidenceDigestSha256: source.deltaEvidenceDigestSha256,
    targetInventoryDigestSha256: target.digestSha256,
    targetSignerEvidenceDigestSha256: target.signedUrlIssuerEvidenceDigestSha256,
    actionCount: actions.length,
    copyCount: actions.filter((action) => action.action.startsWith("COPY_")).length,
    deleteCount: actions.filter((action) => action.action === "DELETE_IF_GENERATION_MATCH").length,
    noopCount: actions.filter((action) => ["NOOP", "DELETE_NOOP"].includes(action.action)).length,
    privateInventoryLookupRequired: true,
    actions,
  };
}

export function validateSecondaryReferenceGates(input) {
  if (!isPlainObject(input)) fail("INVALID_SECONDARY_GATES", "Secondary gate input must be an object.");
  requireExactKeys(
    input,
    ["schemaVersion", "environment", "references"],
    "INVALID_SECONDARY_GATES_SCHEMA",
    "secondary gate",
  );
  requireExact(input.schemaVersion, SECONDARY_SCHEMA, "SECONDARY_SCHEMA_MISMATCH", "secondary schema");
  requireExact(input.environment, "uat", "PRODUCTION_EXECUTION_BLOCKED", "secondary environment");
  if (!Array.isArray(input.references)) fail("INVALID_SECONDARY_GATES", "Secondary references are missing.");
  const expected = new Set(
    STORAGE_CUTOVER_CONTRACT.secondaryReferenceGates.map((entry) => entry.referenceKey),
  );
  requireExact(
    input.references.length,
    expected.size,
    "SECONDARY_REFERENCE_COUNT_MISMATCH",
    "secondary reference count",
  );
  const seen = new Set();
  for (const reference of input.references) {
    requireExactKeys(
      reference,
      [
        "referenceKey",
        "ownershipProven",
        "runtimeNonUseProven",
        "referenceScanClean",
        "disposition",
        "evidenceDigestSha256",
      ],
      "INVALID_SECONDARY_GATE_SCHEMA",
      "secondary reference",
    );
    const key = requireString(reference.referenceKey, "INVALID_SECONDARY_GATE", "referenceKey");
    if (!expected.has(key)) fail("UNKNOWN_SECONDARY_REFERENCE", "An unknown secondary reference is present.");
    if (seen.has(key)) fail("DUPLICATE_SECONDARY_REFERENCE", "A secondary reference is duplicated.");
    seen.add(key);
    requireExact(reference.ownershipProven, true, "SECONDARY_REFERENCE_NOT_READY", `${key} ownership proof`);
    requireExact(reference.runtimeNonUseProven, true, "SECONDARY_REFERENCE_NOT_READY", `${key} runtime non-use proof`);
    requireExact(reference.referenceScanClean, true, "SECONDARY_REFERENCE_NOT_READY", `${key} reference scan`);
    if (!STORAGE_CUTOVER_CONTRACT.terminalSecondaryDispositions.includes(reference.disposition)) {
      fail("SECONDARY_REFERENCE_NOT_READY", `${key} does not have a terminal disposition.`);
    }
    requireSha(reference.evidenceDigestSha256, "SECONDARY_EVIDENCE_MISSING", `${key} evidence digest`);
  }
  for (const key of expected) {
    if (!seen.has(key)) fail("MISSING_SECONDARY_REFERENCE", "A required secondary reference is missing.");
  }
  return {
    ready: true,
    environment: "uat",
    referenceCount: seen.size,
    terminalDispositions: Object.fromEntries(
      STORAGE_CUTOVER_CONTRACT.terminalSecondaryDispositions.map((disposition) => [
        disposition,
        input.references.filter((entry) => entry.disposition === disposition).length,
      ]),
    ),
  };
}

export function safeContractSummary() {
  const validation = validateStorageContract();
  return {
    ...validation,
    state: STORAGE_CUTOVER_CONTRACT.contractState,
    environment: STORAGE_CUTOVER_CONTRACT.executionPolicy.allowedEnvironment,
    project: STORAGE_CUTOVER_CONTRACT.executionPolicy.allowedProject,
    signedUrlMaximumTtlSeconds: STORAGE_CUTOVER_CONTRACT.signedUrlPolicy.maximumTtlSeconds,
    archiveRetentionDays: STORAGE_CUTOVER_CONTRACT.archivePlan.retentionDays,
    archiveExecutionAllowed: false,
  };
}
