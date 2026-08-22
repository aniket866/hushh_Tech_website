import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SECONDARY_SCHEMA,
  SOURCE_SCHEMA,
  STORAGE_CUTOVER_CONTRACT,
  MAXIMUM_CONTINUITY_HISTORY_ENTRIES,
  TARGET_ABSENT,
  TARGET_PRESENT,
  TARGET_SCHEMA,
  StorageCutoverError,
  buildCheckpointPlan,
  buildDeltaPlan,
  buildSeedCopyPlan,
  calculateIamPolicyDigest,
  calculateSourceArtifactDigest,
  calculateSourceInventoryDigest,
  calculateSignedUrlIssuerEvidenceDigest,
  calculateTargetInventoryDigest,
  reconcileInventories,
  safeContractSummary,
  validateSecondaryReferenceGates,
  validateCheckpoint,
  validateSourceInventory,
  validateStorageContract,
  validateTargetInventory,
} from '../scripts/migration/storage-cutover-contract.mjs';
import { runStorageCutoverPlanner } from '../scripts/migration/storage-cutover-plan.mjs';

type JsonRecord = Record<string, unknown>;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);

const makeSourceInventory = (): JsonRecord[] => {
  const records: JsonRecord[] = [
    {
      recordType: 'sourceInventory',
      schemaVersion: SOURCE_SCHEMA,
      snapshotKind: 'FROZEN_BASELINE',
      sourceProjectRef: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef,
      frozenAt: STORAGE_CUTOVER_CONTRACT.frozenAt,
      snapshotSequence: 0,
      exportRunId: 'storage-baseline-export-20260820',
      bucketCount: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.bucketCount,
      objectCount: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.objectCount,
      totalBytes: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.totalBytes,
      tombstoneCount: 0,
      deltaEvidenceDigestSha256: null,
      previousCheckpointDigestSha256: null,
      previousSourceInventoryDigestSha256: null,
      previousSourceArtifactDigestSha256: null,
      previousDeltaEvidenceDigestSha256: null,
    },
  ];

  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    records.push({
      recordType: 'sourceBucket',
      bucketId: bucket.sourceBucket,
      public: bucket.sourcePublic,
      objectCount: bucket.objectCount,
      totalBytes: bucket.totalBytes,
    });
  }

  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    for (let index = 0; index < bucket.objectCount; index += 1) {
      const objectKey = `synthetic/${bucket.sourceBucket}/object-${String(index + 1).padStart(3, '0')}.bin`;
      const sizeBytes = index === 0 ? bucket.totalBytes - (bucket.objectCount - 1) : 1;
      records.push({
        recordType: 'sourceObject',
        bucketId: bucket.sourceBucket,
        objectKey,
        sizeBytes,
        mimeType: 'application/octet-stream',
        sourceUpdatedAt: '2026-08-20T20:14:47.801539Z',
        cacheControl: bucket.sourcePublic ? 'public, max-age=3600' : null,
        sha256: digest(`${bucket.sourceBucket}\0${objectKey}\0${sizeBytes}`),
      });
    }
  }
  records[0].inventoryDigestSha256 = calculateSourceInventoryDigest(records);
  records[0].sourceArtifactDigestSha256 = calculateSourceArtifactDigest(records);
  return records;
};

const makeTargetInventory = (sourceRecords: JsonRecord[], generationOffset = 1_000): JsonRecord[] => {
  const source = validateSourceInventory(sourceRecords);
  const records: JsonRecord[] = [
    {
      recordType: 'targetInventory',
      schemaVersion: TARGET_SCHEMA,
      environment: 'uat',
      project: STORAGE_CUTOVER_CONTRACT.targetPolicy.project,
      region: STORAGE_CUTOVER_CONTRACT.targetPolicy.region,
      bucketCount: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.bucketCount,
      objectCount: source.objectCount,
      totalBytes: source.totalBytes,
      signedUrlIssuerCount: STORAGE_CUTOVER_CONTRACT.buckets.reduce(
        (sum: number, bucket: { signedUrlIssuers: string[] }) => sum + bucket.signedUrlIssuers.length,
        0,
      ),
      signedUrlIssuerEvidenceDigestSha256: '0'.repeat(64),
      sourceInventoryDigestSha256: source.digestSha256,
    },
  ];
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const bucketIamBindings = clone(bucket.allowedIamBindings);
    const inheritedIamBindings: JsonRecord[] = [];
    const effectiveIamBindings = clone(bucket.allowedIamBindings);
    records.push({
      recordType: 'targetBucket',
      bucketName: bucket.targetBucket,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      publicIamMembers: [],
      location: STORAGE_CUTOVER_CONTRACT.targetPolicy.bucketLocation,
      versioningEnabled: true,
      iamEvidenceScope: STORAGE_CUTOVER_CONTRACT.targetPolicy.iamEvidenceScope,
      bucketIamBindings,
      inheritedIamBindings,
      effectiveIamBindings,
      iamPolicyDigestSha256: calculateIamPolicyDigest({
        iamEvidenceScope: STORAGE_CUTOVER_CONTRACT.targetPolicy.iamEvidenceScope,
        bucketIamBindings,
        inheritedIamBindings,
        effectiveIamBindings,
      }),
    });
  }
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    for (const issuerMember of bucket.signedUrlIssuers) {
      records.push({
        recordType: 'signedUrlIssuerEvidence',
        targetBucket: bucket.targetBucket,
        issuerMember,
        issuerProject: 'hushh-tech-uat',
        serviceAccountEnabled: true,
        signBlobPermissionVerified: true,
        allowedMethods: ['GET', 'HEAD'],
        maximumTtlSeconds: 300,
        generationPinned: true,
        bucketAndObjectAllowlistEnforced: true,
        responseCacheControl: 'private, no-store',
        browserCredentialExposure: false,
        evidenceDigestSha256: digest(`signed-url-evidence\0${bucket.targetBucket}\0${issuerMember}`),
      });
    }
  }
  source.objects.forEach((object, index) => {
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === object.bucketId,
    );
    records.push({
      recordType: 'targetObject',
      sourceBucketId: object.bucketId,
      sourceObjectKey: object.objectKey,
      targetBucket: bucket?.targetBucket,
      targetObjectKey: object.objectKey,
      generation: String(generationOffset + index),
      sizeBytes: object.sizeBytes,
      mimeType: object.mimeType,
      sourceUpdatedAtMetadata: object.sourceUpdatedAt,
      sourceCacheControlMetadata: object.cacheControl,
      servingCacheControl: bucket?.targetServingCacheControl,
      sha256: object.sha256,
      accessMode: bucket?.targetAccessMode,
      publicAcl: false,
    });
  });
  records[0].signedUrlIssuerEvidenceDigestSha256 = calculateSignedUrlIssuerEvidenceDigest(records);
  records[0].inventoryDigestSha256 = calculateTargetInventoryDigest(records);
  return records;
};

const refreshSourceDigest = (records: JsonRecord[]) => {
  const header = records.find((record) => record.recordType === 'sourceInventory');
  if (header) {
    header.inventoryDigestSha256 = calculateSourceInventoryDigest(records);
    header.sourceArtifactDigestSha256 = calculateSourceArtifactDigest(records);
    for (const tombstone of records.filter((record) => record.recordType === 'sourceTombstone')) {
      tombstone.sourceArtifactDigestSha256 = header.sourceArtifactDigestSha256;
    }
  }
};

const refreshTargetDigest = (records: JsonRecord[]) => {
  const header = records.find((record) => record.recordType === 'targetInventory');
  if (header) {
    header.signedUrlIssuerEvidenceDigestSha256 = calculateSignedUrlIssuerEvidenceDigest(records);
    header.inventoryDigestSha256 = calculateTargetInventoryDigest(records);
  }
};

const makeEmptyTargetInventory = (sourceRecords: JsonRecord[]) => {
  const records = makeTargetInventory(sourceRecords).filter(
    (record) => record.recordType !== 'targetObject',
  );
  const header = records.find((record) => record.recordType === 'targetInventory');
  if (!header) throw new Error('Missing synthetic target header.');
  header.objectCount = 0;
  header.totalBytes = 0;
  refreshTargetDigest(records);
  return records;
};

const applyDeltaHeader = (
  records: JsonRecord[],
  checkpoint: ReturnType<typeof buildCheckpointPlan>,
  {
    frozenAt = '2026-08-21T01:00:00Z',
    evidenceLabel = 'source-delta-evidence',
    runId = `storage-delta-export-${checkpoint.snapshotSequence + 1}`,
  } = {},
) => {
  const header = records.find((record) => record.recordType === 'sourceInventory');
  if (!header) throw new Error('Missing synthetic source header.');
  Object.assign(header, {
    snapshotKind: 'RECORDED_DELTA',
    frozenAt,
    snapshotSequence: checkpoint.snapshotSequence + 1,
    exportRunId: runId,
    previousCheckpointDigestSha256: checkpoint.checkpointDigestSha256,
    previousSourceInventoryDigestSha256: checkpoint.sourceInventoryDigestSha256,
    previousSourceArtifactDigestSha256: checkpoint.sourceArtifactDigestSha256,
    previousDeltaEvidenceDigestSha256: checkpoint.deltaEvidenceDigestSha256,
    deltaEvidenceDigestSha256: digest(evidenceLabel),
  });
  refreshSourceDigest(records);
};

const makeNoChangeDelta = (
  baseline: JsonRecord[],
  checkpoint: ReturnType<typeof buildCheckpointPlan>,
) => {
  const changed = clone(baseline);
  applyDeltaHeader(changed, checkpoint);
  return changed;
};

const makeAddedObjectDelta = (
  baseline: JsonRecord[],
  checkpoint: ReturnType<typeof buildCheckpointPlan>,
) => {
  const changed = clone(baseline);
  const header = changed.find((record) => record.recordType === 'sourceInventory');
  const bucket = changed.find(
    (record) => record.recordType === 'sourceBucket' && record.bucketId === 'assets',
  );
  if (header) {
    header.objectCount = Number(header.objectCount) + 1;
    header.totalBytes = Number(header.totalBytes) + 42;
  }
  if (bucket) {
    bucket.objectCount = Number(bucket.objectCount) + 1;
    bucket.totalBytes = Number(bucket.totalBytes) + 42;
  }
  changed.push({
    recordType: 'sourceObject',
    bucketId: 'assets',
    objectKey: 'synthetic/assets/new-delta-object.bin',
    sizeBytes: 42,
    mimeType: 'application/octet-stream',
    sourceUpdatedAt: '2026-08-21T01:00:00Z',
    cacheControl: 'public, max-age=3600',
    sha256: digest('new-delta-object'),
  });
  applyDeltaHeader(changed, checkpoint, { evidenceLabel: 'new-object-delta-evidence' });
  return changed;
};

const makeDeletedObjectDelta = (
  baseline: JsonRecord[],
  checkpoint: ReturnType<typeof buildCheckpointPlan>,
) => {
  const changed = clone(baseline);
  const objectIndex = changed.findIndex((record) => record.recordType === 'sourceObject');
  const [removed] = changed.splice(objectIndex, 1);
  const validatedBaseline = validateSourceInventory(baseline);
  const removedObject = validatedBaseline.objects.find(
    (object) => object.bucketId === removed.bucketId && object.objectKey === removed.objectKey,
  );
  const checkpointEntry = checkpoint.entries.find((entry) => entry.objectId === removedObject?.objectId);
  const header = changed.find((record) => record.recordType === 'sourceInventory');
  const bucket = changed.find(
    (record) => record.recordType === 'sourceBucket' && record.bucketId === removed.bucketId,
  );
  if (!header || !bucket || !removedObject || !checkpointEntry) {
    throw new Error('Could not build synthetic storage tombstone.');
  }
  header.objectCount = Number(header.objectCount) - 1;
  header.totalBytes = Number(header.totalBytes) - Number(removed.sizeBytes);
  header.tombstoneCount = 1;
  bucket.objectCount = Number(bucket.objectCount) - 1;
  bucket.totalBytes = Number(bucket.totalBytes) - Number(removed.sizeBytes);
  const evidenceDigest = digest('delete-object-delta-evidence');
  changed.push({
    recordType: 'sourceTombstone',
    objectId: removedObject.objectId,
    priorSourceFingerprintSha256: checkpointEntry.sourceFingerprintSha256,
    deletedAt: '2026-08-21T01:00:00Z',
    deletionReason: 'Source object deleted before final cutover.',
    previousSourceInventoryDigestSha256: checkpoint.sourceInventoryDigestSha256,
    deltaEvidenceDigestSha256: evidenceDigest,
    sourceArtifactDigestSha256: '0'.repeat(64),
  });
  applyDeltaHeader(changed, checkpoint, { evidenceLabel: 'delete-object-delta-evidence' });
  return { changed, removed, removedObject };
};

const makeSecondaryGate = () => ({
  schemaVersion: SECONDARY_SCHEMA,
  environment: 'uat',
  references: STORAGE_CUTOVER_CONTRACT.secondaryReferenceGates.map(
    (reference: { referenceKey: string }, index: number) => ({
      referenceKey: reference.referenceKey,
      ownershipProven: true,
      runtimeNonUseProven: true,
      referenceScanClean: true,
      disposition:
        index % 2 === 0
          ? 'MIGRATED_AND_REFERENCE_REMOVED'
          : 'NON_USE_PROVEN_AND_REFERENCE_REMOVED',
      evidenceDigestSha256: digest(`secondary-${reference.referenceKey}`),
    }),
  ),
});

const expectCode = (operation: () => unknown, code: string) => {
  try {
    operation();
    throw new Error('Expected operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(StorageCutoverError);
    expect((error as StorageCutoverError).code).toBe(code);
  }
};

const setAtPath = (root: unknown, path: string, value: unknown) => {
  const parts = path.split('.');
  const final = parts.pop();
  let cursor = root as Record<string, unknown>;
  for (const part of parts) cursor = cursor[part] as Record<string, unknown>;
  if (final) cursor[final] = value;
};

describe('Supabase storage cutover contract', () => {
  it('locks the exact six-bucket, 124-object, 111078397-byte baseline', () => {
    const result = validateStorageContract();
    expect(result).toMatchObject({
      valid: true,
      bucketCount: 6,
      objectCount: 124,
      totalBytes: 111_078_397,
      secondaryReferenceCount: 6,
      executionAllowed: false,
    });
    expect(
      STORAGE_CUTOVER_CONTRACT.buckets.map((bucket: { targetBucket: string }) => bucket.targetBucket),
    ).toEqual([
      'hushh-tech-cutover-v1-assets-legal-uat',
      'hushh-tech-cutover-v1-community-content-uat',
      'hushh-tech-cutover-v1-profile-images-uat',
      'hushh-tech-cutover-v1-ai-media-uat',
      'hushh-tech-cutover-v1-reports-uat',
      'hushh-tech-cutover-v1-wa-evidence-uat',
    ]);
  });

  it('keeps signed URLs generation-pinned and at five minutes', () => {
    expect(STORAGE_CUTOVER_CONTRACT.signedUrlPolicy).toMatchObject({
      maximumTtlSeconds: 300,
      generationPinned: true,
      browserCredentialExposureAllowed: false,
    });
    expect(STORAGE_CUTOVER_CONTRACT.signedUrlPolicy.allowedMethods).toEqual(['GET', 'HEAD']);
  });

  it('locks the Cloud KMS archive plan for 90 days without enabling execution', () => {
    expect(STORAGE_CUTOVER_CONTRACT.archivePlan).toMatchObject({
      planningOnly: true,
      retentionDays: 90,
      retentionSeconds: 7_776_000,
      retentionLockRequired: true,
      cloudKmsCmekRequired: true,
      restoreDrillRequiredBeforeRetentionLock: true,
      deleteAtExpiryRequiresSeparateApproval: true,
    });
    expect(safeContractSummary().archiveExecutionAllowed).toBe(false);
  });

  it.each([
    ['signedUrlPolicy.issuer', 'browser'],
    ['signedUrlPolicy.allowedMethods', ['GET', 'POST']],
    ['signedUrlPolicy.maximumTtlSeconds', 301],
    ['signedUrlPolicy.generationPinned', false],
    ['signedUrlPolicy.bucketAndObjectAllowlistRequired', false],
    ['signedUrlPolicy.issuerEvidenceRequired', false],
    ['signedUrlPolicy.responseCacheControl', 'public, max-age=86400'],
    ['signedUrlPolicy.browserCredentialExposureAllowed', true],
  ])('fails closed when %s drifts', (path, value) => {
    const unsafe = clone(STORAGE_CUTOVER_CONTRACT);
    setAtPath(unsafe, path as string, value);
    expectCode(() => validateStorageContract(unsafe), 'SIGNED_URL_POLICY_UNSAFE');
  });

  it.each([
    ['archivePlan.planningOnly', false],
    ['archivePlan.productionOnlyAfterCutover', false],
    ['archivePlan.sourceFreezeSoakHours', 0],
    ['archivePlan.retentionDays', 89],
    ['archivePlan.retentionSeconds', 1],
    ['archivePlan.retentionLockRequired', false],
    ['archivePlan.objectVersioningRequired', false],
    ['archivePlan.cloudKmsCmekRequired', false],
    ['archivePlan.kmsKeyRotationDays', 365],
    ['archivePlan.restoreDrillRequiredBeforeRetentionLock', false],
    ['archivePlan.deleteAtExpiryRequiresSeparateApproval', false],
  ])('fails closed when %s drifts', (path, value) => {
    const unsafe = clone(STORAGE_CUTOVER_CONTRACT);
    setAtPath(unsafe, path as string, value);
    expectCode(() => validateStorageContract(unsafe), 'ARCHIVE_POLICY_UNSAFE');
  });

  it.each([
    ['target project', (contract: JsonRecord) => setAtPath(contract, 'targetPolicy.project', 'attacker-project'), 'CONTRACT_PROJECT_UNSAFE'],
    ['target region', (contract: JsonRecord) => setAtPath(contract, 'targetPolicy.region', 'europe-west1'), 'CONTRACT_REGION_UNSAFE'],
    ['bucket access mode', (contract: JsonRecord) => setAtPath(contract, 'buckets.0.targetAccessMode', 'PUBLIC'), 'CONTRACT_BUCKET_MAPPING_MISMATCH'],
    [
      'bucket IAM allowlist',
      (contract: JsonRecord) => {
        const buckets = contract.buckets as JsonRecord[];
        const bindings = buckets[0].allowedIamBindings as JsonRecord[];
        (bindings[0].members as string[]).push(
          'serviceAccount:attacker@evil-project.iam.gserviceaccount.com',
        );
      },
      'CONTRACT_BUCKET_MAPPING_MISMATCH',
    ],
    [
      'signed URL issuer',
      (contract: JsonRecord) => {
        const buckets = contract.buckets as JsonRecord[];
        buckets[0].signedUrlIssuers = [
          'serviceAccount:attacker@evil-project.iam.gserviceaccount.com',
        ];
      },
      'CONTRACT_BUCKET_MAPPING_MISMATCH',
    ],
    [
      'per-bucket totals',
      (contract: JsonRecord) => {
        const buckets = contract.buckets as JsonRecord[];
        buckets[0].objectCount = Number(buckets[0].objectCount) - 1;
        buckets[1].objectCount = Number(buckets[1].objectCount) + 1;
        buckets[0].totalBytes = Number(buckets[0].totalBytes) - 1;
        buckets[1].totalBytes = Number(buckets[1].totalBytes) + 1;
      },
      'CONTRACT_BUCKET_MAPPING_MISMATCH',
    ],
  ])('rejects independent frozen %s drift', (_label, mutate, code) => {
    const unsafe = clone(STORAGE_CUTOVER_CONTRACT) as JsonRecord;
    mutate(unsafe);
    expectCode(() => validateStorageContract(unsafe), code);
  });
});

describe('source inventory validation', () => {
  it('accepts a deterministic complete frozen inventory', () => {
    const inventory = validateSourceInventory(makeSourceInventory());
    expect(inventory.objectCount).toBe(124);
    expect(inventory.totalBytes).toBe(111_078_397);
    expect(inventory.digestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('has an order-independent canonical inventory digest', () => {
    const source = makeSourceInventory();
    const forward = validateSourceInventory(source).digestSha256;
    const header = source[0];
    const reversed = [header, ...source.slice(1).reverse()];
    expect(validateSourceInventory(reversed).digestSha256).toBe(forward);
  });

  it('fails closed on a changed source bucket public state', () => {
    const source = makeSourceInventory();
    const bucket = source.find(
      (record) => record.recordType === 'sourceBucket' && record.bucketId === 'assets',
    );
    if (bucket) bucket.public = false;
    expectCode(() => validateSourceInventory(source), 'SOURCE_PUBLIC_ACL_DRIFT');
  });

  it('fails closed on unknown buckets', () => {
    const source = makeSourceInventory();
    const bucket = source.find(
      (record) => record.recordType === 'sourceBucket' && record.bucketId === 'wa-evidence',
    );
    if (bucket) bucket.bucketId = 'unknown-bucket';
    expectCode(() => validateSourceInventory(source), 'UNKNOWN_SOURCE_BUCKET');
  });

  it('fails closed on a missing object hash', () => {
    const source = makeSourceInventory();
    const object = source.find((record) => record.recordType === 'sourceObject');
    if (object) delete object.sha256;
    expectCode(() => validateSourceInventory(source), 'MISSING_SOURCE_HASH');
  });

  it('fails closed on a missing source object', () => {
    const source = makeSourceInventory();
    const index = source.findIndex((record) => record.recordType === 'sourceObject');
    source.splice(index, 1);
    expectCode(() => validateSourceInventory(source), 'SOURCE_OBJECT_COUNT_MISMATCH');
  });

  it('fails closed on a duplicate source object key', () => {
    const source = makeSourceInventory();
    const objectIndexes = source
      .map((record, index) => (record.recordType === 'sourceObject' ? index : -1))
      .filter((index) => index >= 0);
    source[objectIndexes[1]].bucketId = source[objectIndexes[0]].bucketId;
    source[objectIndexes[1]].objectKey = source[objectIndexes[0]].objectKey;
    expectCode(() => validateSourceInventory(source), 'DUPLICATE_SOURCE_OBJECT');
  });

  it('fails closed on an unknown source record type', () => {
    const source = makeSourceInventory();
    source.push({ recordType: 'sourceUrl', value: 'blocked' });
    expectCode(() => validateSourceInventory(source), 'UNKNOWN_SOURCE_RECORD');
  });
});

describe('target inventory and parity', () => {
  it('accepts exact generation-bearing UAT metadata', () => {
    const source = makeSourceInventory();
    const target = validateTargetInventory(makeTargetInventory(source), { requireComplete: true });
    expect(target.objectCount).toBe(124);
    expect(target.totalBytes).toBe(111_078_397);
    expect(target.objects.every((object) => /^[1-9]\d*$/.test(object.generation))).toBe(true);
  });

  it('fails when uniform access or public access prevention drifts', () => {
    const source = makeSourceInventory();
    const target = makeTargetInventory(source);
    const bucket = target.find((record) => record.recordType === 'targetBucket');
    if (bucket) bucket.uniformBucketLevelAccess = false;
    expectCode(() => validateTargetInventory(target), 'TARGET_PUBLIC_ACCESS_DRIFT');
  });

  it('requires the exact region, object versioning, and per-bucket IAM allowlist', () => {
    const source = makeSourceInventory();
    const wrongRegion = makeTargetInventory(source);
    const regionBucket = wrongRegion.find((record) => record.recordType === 'targetBucket');
    if (regionBucket) regionBucket.location = 'US';
    expectCode(() => validateTargetInventory(wrongRegion), 'TARGET_LOCATION_DRIFT');

    const noVersioning = makeTargetInventory(source);
    const versioningBucket = noVersioning.find((record) => record.recordType === 'targetBucket');
    if (versioningBucket) versioningBucket.versioningEnabled = false;
    expectCode(() => validateTargetInventory(noVersioning), 'TARGET_VERSIONING_DISABLED');

    const broadIam = makeTargetInventory(source);
    const iamBucket = broadIam.find((record) => record.recordType === 'targetBucket');
    if (iamBucket) {
      const broadBinding = { role: 'roles/editor', members: ['projectEditor:hushh-tech-uat'] };
      iamBucket.inheritedIamBindings = [broadBinding];
      iamBucket.effectiveIamBindings = [
        ...(iamBucket.effectiveIamBindings as JsonRecord[]),
        broadBinding,
      ];
      iamBucket.iamPolicyDigestSha256 = calculateIamPolicyDigest({
        iamEvidenceScope: iamBucket.iamEvidenceScope,
        bucketIamBindings: iamBucket.bucketIamBindings,
        inheritedIamBindings: iamBucket.inheritedIamBindings,
        effectiveIamBindings: iamBucket.effectiveIamBindings,
      } as Parameters<typeof calculateIamPolicyDigest>[0]);
    }
    expectCode(() => validateTargetInventory(broadIam), 'TARGET_IAM_ROLE_FORBIDDEN');
  });

  it('requires exact IAM evidence schemas and rejects conditions or inherited access', () => {
    const source = makeSourceInventory();
    const conditional = makeTargetInventory(source);
    const conditionalBucket = conditional.find((record) => record.recordType === 'targetBucket');
    const conditionalBindings = conditionalBucket?.bucketIamBindings as JsonRecord[];
    conditionalBindings[0].condition = {
      title: 'unexpected-condition',
      expression: 'request.time < timestamp("2026-08-22T00:00:00Z")',
    };
    expectCode(() => validateTargetInventory(conditional), 'INVALID_TARGET_IAM');

    const inherited = makeTargetInventory(source);
    const inheritedBucket = inherited.find((record) => record.recordType === 'targetBucket');
    if (inheritedBucket) {
      const inheritedBinding = {
        role: 'roles/storage.objectCreator',
        members: [
          'serviceAccount:hushh-tech-content-api-uat@hushh-tech-uat.iam.gserviceaccount.com',
        ],
      };
      inheritedBucket.inheritedIamBindings = [inheritedBinding];
      inheritedBucket.effectiveIamBindings = [
        ...(inheritedBucket.effectiveIamBindings as JsonRecord[]),
        inheritedBinding,
      ];
      inheritedBucket.iamPolicyDigestSha256 = calculateIamPolicyDigest({
        iamEvidenceScope: inheritedBucket.iamEvidenceScope,
        bucketIamBindings: inheritedBucket.bucketIamBindings,
        inheritedIamBindings: inheritedBucket.inheritedIamBindings,
        effectiveIamBindings: inheritedBucket.effectiveIamBindings,
      } as Parameters<typeof calculateIamPolicyDigest>[0]);
    }
    refreshTargetDigest(inherited);
    expectCode(() => validateTargetInventory(inherited), 'TARGET_INHERITED_IAM_FORBIDDEN');
  });

  it('rejects ambiguous evidence fields and raw public target cache metadata', () => {
    const source = makeSourceInventory();
    const extraBucketField = makeTargetInventory(source);
    const bucket = extraBucketField.find((record) => record.recordType === 'targetBucket');
    if (bucket) bucket.iamEvidenceNote = 'self asserted';
    expectCode(
      () => validateTargetInventory(extraBucketField),
      'INVALID_TARGET_BUCKET_SCHEMA',
    );

    const rawPublicCache = makeTargetInventory(source);
    const object = rawPublicCache.find((record) => record.recordType === 'targetObject');
    if (object) object.cacheControl = 'public, max-age=31536000';
    expectCode(
      () => validateTargetInventory(rawPublicCache),
      'TARGET_RAW_CACHE_METADATA_UNSAFE',
    );

  });

  it('rejects every signed URL issuer before runtime activation', () => {
    const source = makeSourceInventory();
    const target = makeTargetInventory(source);
    target.push({
      recordType: 'signedUrlIssuerEvidence',
      targetBucket: STORAGE_CUTOVER_CONTRACT.buckets[0].targetBucket,
      issuerMember: 'serviceAccount:unapproved@hushh-tech-uat.iam.gserviceaccount.com',
      issuerProject: 'hushh-tech-uat',
      serviceAccountEnabled: true,
      signBlobPermissionVerified: true,
      allowedMethods: ['GET', 'HEAD'],
      maximumTtlSeconds: 300,
      generationPinned: true,
      bucketAndObjectAllowlistEnforced: true,
      responseCacheControl: 'private, no-store',
      browserCredentialExposure: false,
      evidenceDigestSha256: digest('unapproved-pre-copy-signer'),
    });
    expectCode(() => validateTargetInventory(target), 'SIGNED_URL_ISSUER_COUNT_MISMATCH');
  });

  it('fails when any target object gains a public ACL', () => {
    const source = makeSourceInventory();
    const target = makeTargetInventory(source);
    const object = target.find((record) => record.recordType === 'targetObject');
    if (object) object.publicAcl = true;
    expectCode(() => validateTargetInventory(target), 'TARGET_PUBLIC_ACL_DRIFT');
  });

  it('fails when target generation metadata is missing', () => {
    const source = makeSourceInventory();
    const target = makeTargetInventory(source);
    const object = target.find((record) => record.recordType === 'targetObject');
    if (object) delete object.generation;
    expectCode(() => validateTargetInventory(target), 'MISSING_TARGET_GENERATION');
  });

  it('fails closed on an unknown target record type', () => {
    const source = makeSourceInventory();
    const target = makeTargetInventory(source);
    target.push({ recordType: 'copyInstruction', execute: true });
    expectCode(() => validateTargetInventory(target), 'UNKNOWN_TARGET_RECORD');
  });

  it('reconciles exact keys, bytes, MIME, timestamps, cache metadata, hashes, and access', () => {
    const source = makeSourceInventory();
    const result = reconcileInventories(source, makeTargetInventory(source));
    expect(result).toMatchObject({
      reconciled: true,
      bucketCount: 6,
      objectCount: 124,
      totalBytes: 111_078_397,
    });
    expect(result.exactFields).toContain('key');
    expect(result.exactFields).toContain('sha256');
  });

  it.each([
    ['mimeType', 'text/plain', 'TARGET_OBJECT_PARITY_MISMATCH'],
    ['sourceUpdatedAtMetadata', '2026-08-21T00:00:00Z', 'TARGET_OBJECT_PARITY_MISMATCH'],
    ['sourceCacheControlMetadata', 'private, no-store', 'TARGET_OBJECT_PARITY_MISMATCH'],
    ['servingCacheControl', 'public, max-age=86400', 'TARGET_SERVING_CACHE_UNSAFE'],
    ['sha256', digest('altered-target'), 'TARGET_OBJECT_PARITY_MISMATCH'],
    ['accessMode', 'PUBLIC', 'TARGET_ACCESS_MODE_DRIFT'],
  ])('fails exact parity when %s differs', (field, value, errorCode) => {
    const source = makeSourceInventory();
    const target = makeTargetInventory(source);
    const object = target.find((record) => record.recordType === 'targetObject');
    if (object) object[field] = value;
    refreshTargetDigest(target);
    expectCode(() => reconcileInventories(source, target), errorCode);
  });

  it('fails if the complete target is missing an object', () => {
    const source = makeSourceInventory();
    const target = makeTargetInventory(source);
    const objectIndex = target.findIndex((record) => record.recordType === 'targetObject');
    target.splice(objectIndex, 1);
    expectCode(() => reconcileInventories(source, target), 'TARGET_OBJECT_COUNT_MISMATCH');
  });
});

describe('dry-run copy, delta, and checkpoint plans', () => {
  it('builds a seed plan without object keys or runtime execution', () => {
    const source = makeSourceInventory();
    const firstObject = source.find((record) => record.recordType === 'sourceObject');
    const plan = buildSeedCopyPlan(source);
    const serialized = JSON.stringify(plan);
    expect(plan).toMatchObject({
      planType: 'DRY_RUN_SEED_COPY_PLAN',
      executionAllowed: false,
      environment: 'uat',
      actionCount: 124,
      expectedBytes: 111_078_397,
      privateInventoryLookupRequired: true,
    });
    expect(serialized).not.toContain(String(firstObject?.objectKey));
    expect(serialized).not.toContain('objectKey');
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it('creates a key-free checkpoint and a deterministic no-op delta', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const source = makeNoChangeDelta(baseline, checkpoint);
    const plan = buildDeltaPlan(source, target, checkpoint);
    const firstObject = baseline.find((record) => record.recordType === 'sourceObject');
    expect(checkpoint.entries).toHaveLength(124);
    expect(checkpoint.sourceExportRunIdHistory).toEqual([
      'storage-baseline-export-20260820',
    ]);
    expect(checkpoint.deltaEvidenceDigestHistory).toEqual([]);
    expect(checkpoint.targetSignerEvidenceDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.entries.every((entry) => entry.targetState === TARGET_PRESENT)).toBe(true);
    expect(JSON.stringify(checkpoint)).not.toContain(String(firstObject?.objectKey));
    expect(plan).toMatchObject({
      planType: 'DRY_RUN_DELTA_COPY_PLAN',
      executionAllowed: false,
      actionCount: 124,
      copyCount: 0,
      deleteCount: 0,
      noopCount: 124,
    });
  });

  it('binds the exact target evidence digest through the checkpoint', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const delta = makeNoChangeDelta(baseline, checkpoint);
    const swappedEvidence = clone(target);
    const object = swappedEvidence.find(
      (record) => record.recordType === 'targetObject',
    );
    if (object) object.generation = String(Number(object.generation) + 1);
    refreshTargetDigest(swappedEvidence);
    expect(swappedEvidence[0].inventoryDigestSha256).not.toBe(
      checkpoint.targetInventoryDigestSha256,
    );
    expectCode(
      () => buildDeltaPlan(delta, swappedEvidence, checkpoint),
      'TARGET_GENERATION_CHANGED',
    );
  });

  it('rejects non-adjacent export-run and delta-evidence replay with bounded history', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint0 = buildCheckpointPlan(baseline, target);

    const delta1 = clone(baseline);
    applyDeltaHeader(delta1, checkpoint0, {
      frozenAt: '2026-08-21T01:00:00Z',
      evidenceLabel: 'history-evidence-one',
      runId: 'storage-history-run-one',
    });
    const checkpoint1 = buildCheckpointPlan(delta1, target, checkpoint0);

    const delta2 = clone(delta1);
    applyDeltaHeader(delta2, checkpoint1, {
      frozenAt: '2026-08-21T02:00:00Z',
      evidenceLabel: 'history-evidence-two',
      runId: 'storage-history-run-two',
    });
    const checkpoint2 = buildCheckpointPlan(delta2, target, checkpoint1);

    const reusedRun = clone(delta2);
    applyDeltaHeader(reusedRun, checkpoint2, {
      frozenAt: '2026-08-21T03:00:00Z',
      evidenceLabel: 'history-evidence-three',
      runId: 'storage-baseline-export-20260820',
    });
    expectCode(() => buildDeltaPlan(reusedRun, target, checkpoint2), 'SOURCE_EXPORT_RUN_REPLAY');

    const reusedEvidence = clone(delta2);
    applyDeltaHeader(reusedEvidence, checkpoint2, {
      frozenAt: '2026-08-21T03:00:00Z',
      evidenceLabel: 'history-evidence-one',
      runId: 'storage-history-run-three',
    });
    expectCode(
      () => buildDeltaPlan(reusedEvidence, target, checkpoint2),
      'SOURCE_DELTA_EVIDENCE_REPLAY',
    );

    const oversizedHistory = clone(checkpoint2);
    oversizedHistory.sourceExportRunIdHistory = Array.from(
      { length: MAXIMUM_CONTINUITY_HISTORY_ENTRIES + 1 },
      (_, index) => `history-run-${index}`,
    );
    expectCode(
      () => validateCheckpoint(oversizedHistory),
      'CHECKPOINT_HISTORY_LIMIT_EXCEEDED',
    );
  });

  it('plans a changed source hash with an exact target-generation precondition', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const changed = clone(baseline);
    const header = changed.find((record) => record.recordType === 'sourceInventory');
    const object = changed.find((record) => record.recordType === 'sourceObject');
    const bucket = changed.find(
      (record) =>
        record.recordType === 'sourceBucket' && record.bucketId === object?.bucketId,
    );
    if (header) {
      header.totalBytes = Number(header.totalBytes) + 5;
    }
    if (bucket) bucket.totalBytes = Number(bucket.totalBytes) + 5;
    if (object) {
      object.sha256 = digest('recorded-source-delta');
      object.sizeBytes = Number(object.sizeBytes) + 5;
    }
    applyDeltaHeader(changed, checkpoint);
    const plan = buildDeltaPlan(changed, target, checkpoint);
    const action = plan.actions.find(
      (entry: { action: string }) => entry.action === 'COPY_NEW_GENERATION_IF_MATCH',
    );
    expect(plan.copyCount).toBe(1);
    expect(action).toMatchObject({
      action: 'COPY_NEW_GENERATION_IF_MATCH',
      ifGenerationMatch: expect.stringMatching(/^[1-9]\d*$/),
    });
  });

  it('plans a new recorded-delta object only when it is absent', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const changed = makeAddedObjectDelta(baseline, checkpoint);
    const plan = buildDeltaPlan(changed, target, checkpoint);
    expect(plan.copyCount).toBe(1);
    expect(plan.actions.filter((action: { action: string }) => action.action === 'COPY_IF_ABSENT')).toHaveLength(1);
  });

  it('reconciles an applied recorded delta against its prior checkpoint', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const changed = makeAddedObjectDelta(baseline, checkpoint);
    const deltaPlan = buildDeltaPlan(changed, target, checkpoint);
    const changedObject = changed.find(
      (record) =>
        record.recordType === 'sourceObject' &&
        record.objectKey === 'synthetic/assets/new-delta-object.bin',
    );
    const appliedTarget = clone(target);
    const header = appliedTarget.find((record) => record.recordType === 'targetInventory');
    if (header) {
      header.objectCount = Number(header.objectCount) + 1;
      header.totalBytes = Number(header.totalBytes) + 42;
      header.sourceInventoryDigestSha256 = deltaPlan.sourceInventoryDigestSha256;
    }
    appliedTarget.push({
      recordType: 'targetObject',
      sourceBucketId: 'assets',
      sourceObjectKey: changedObject?.objectKey,
      targetBucket: 'hushh-tech-cutover-v1-assets-legal-uat',
      targetObjectKey: changedObject?.objectKey,
      generation: '999999999',
      sizeBytes: changedObject?.sizeBytes,
      mimeType: changedObject?.mimeType,
      sourceUpdatedAtMetadata: changedObject?.sourceUpdatedAt,
      sourceCacheControlMetadata: changedObject?.cacheControl,
      servingCacheControl: 'private, no-store',
      sha256: changedObject?.sha256,
      accessMode: 'PRIVATE_SERVICE_OR_SIGNED_URL',
      publicAcl: false,
    });
    refreshTargetDigest(appliedTarget);
    expect(reconcileInventories(changed, appliedTarget, checkpoint)).toMatchObject({
      reconciled: true,
      objectCount: 125,
      totalBytes: 111_078_439,
    });
  });

  it('fails closed if a target generation changes after checkpoint', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const source = makeNoChangeDelta(baseline, checkpoint);
    const drifted = clone(target);
    const object = drifted.find((record) => record.recordType === 'targetObject');
    if (object) object.generation = String(Number(object.generation) + 10_000);
    refreshTargetDigest(drifted);
    expectCode(() => buildDeltaPlan(source, drifted, checkpoint), 'TARGET_GENERATION_CHANGED');
  });

  it('checkpoints the complete source set even when every target object is absent', () => {
    const baseline = makeSourceInventory();
    const checkpoint = buildCheckpointPlan(baseline, makeEmptyTargetInventory(baseline));
    expect(checkpoint.entries).toHaveLength(124);
    expect(checkpoint.targetObjectCount).toBe(0);
    expect(checkpoint.entries.every((entry) => entry.targetState === TARGET_ABSENT)).toBe(true);
  });

  it('rejects an unrecorded deletion from a partial checkpoint', () => {
    const baseline = makeSourceInventory();
    const target = makeEmptyTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const changed = clone(baseline);
    const objectIndex = changed.findIndex((record) => record.recordType === 'sourceObject');
    const [removed] = changed.splice(objectIndex, 1);
    const header = changed.find((record) => record.recordType === 'sourceInventory');
    const bucket = changed.find(
      (record) => record.recordType === 'sourceBucket' && record.bucketId === removed.bucketId,
    );
    if (header && bucket) {
      header.objectCount = Number(header.objectCount) - 1;
      header.totalBytes = Number(header.totalBytes) - Number(removed.sizeBytes);
      bucket.objectCount = Number(bucket.objectCount) - 1;
      bucket.totalBytes = Number(bucket.totalBytes) - Number(removed.sizeBytes);
    }
    applyDeltaHeader(changed, checkpoint, { evidenceLabel: 'missing-tombstone-evidence' });
    expectCode(() => buildDeltaPlan(changed, target, checkpoint), 'SOURCE_OBJECT_REMOVED');

    const fullCheckpoint = buildCheckpointPlan(baseline, makeTargetInventory(baseline));
    const changedForFullCheckpoint = clone(changed);
    applyDeltaHeader(changedForFullCheckpoint, fullCheckpoint, {
      evidenceLabel: 'missing-tombstone-full-evidence',
      runId: 'storage-delta-export-full-missing-tombstone',
    });
    const completeChangedTarget = makeTargetInventory(baseline);
    const removedTargetIndex = completeChangedTarget.findIndex(
      (record) =>
        record.recordType === 'targetObject' &&
        record.sourceBucketId === removed.bucketId &&
        record.sourceObjectKey === removed.objectKey,
    );
    completeChangedTarget.splice(removedTargetIndex, 1);
    const changedTargetHeader = completeChangedTarget.find(
      (record) => record.recordType === 'targetInventory',
    );
    const changedForFullHeader = changedForFullCheckpoint.find(
      (record) => record.recordType === 'sourceInventory',
    );
    if (changedTargetHeader && changedForFullHeader) {
      changedTargetHeader.objectCount = changedForFullHeader.objectCount;
      changedTargetHeader.totalBytes = changedForFullHeader.totalBytes;
      changedTargetHeader.sourceInventoryDigestSha256 = changedForFullHeader.inventoryDigestSha256;
    }
    refreshTargetDigest(completeChangedTarget);
    expectCode(
      () => buildCheckpointPlan(changedForFullCheckpoint, completeChangedTarget, fullCheckpoint),
      'SOURCE_OBJECT_REMOVED',
    );
    expectCode(
      () => reconcileInventories(changedForFullCheckpoint, completeChangedTarget, fullCheckpoint),
      'SOURCE_OBJECT_REMOVED',
    );
  });

  it('uses an exact tombstone and generation precondition for a recorded deletion', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const { changed } = makeDeletedObjectDelta(baseline, checkpoint);
    const plan = buildDeltaPlan(changed, target, checkpoint);
    expect(plan).toMatchObject({ deleteCount: 1, copyCount: 0, noopCount: 123 });
    expect(plan.actions.find((action) => action.action === 'DELETE_IF_GENERATION_MATCH')).toMatchObject({
      objectId: expect.stringMatching(/^[a-f0-9]{64}$/),
      ifGenerationMatch: expect.stringMatching(/^[1-9]\d*$/),
      deltaEvidenceDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceArtifactDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(plan)).not.toContain('Source object deleted before final cutover.');
  });

  it('rejects forged tombstone fingerprints, evidence, and artifact bindings', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const { changed } = makeDeletedObjectDelta(baseline, checkpoint);
    const fingerprintForgery = clone(changed);
    const fingerprintTombstone = fingerprintForgery.find(
      (record) => record.recordType === 'sourceTombstone',
    );
    if (fingerprintTombstone) fingerprintTombstone.priorSourceFingerprintSha256 = digest('forged');
    expectCode(
      () => buildDeltaPlan(fingerprintForgery, target, checkpoint),
      'SOURCE_TOMBSTONE_FINGERPRINT_MISMATCH',
    );

    const evidenceForgery = clone(changed);
    const evidenceTombstone = evidenceForgery.find((record) => record.recordType === 'sourceTombstone');
    if (evidenceTombstone) evidenceTombstone.deltaEvidenceDigestSha256 = digest('wrong-evidence');
    expectCode(
      () => buildDeltaPlan(evidenceForgery, target, checkpoint),
      'SOURCE_TOMBSTONE_EVIDENCE_MISMATCH',
    );

    const artifactForgery = clone(changed);
    const artifactTombstone = artifactForgery.find((record) => record.recordType === 'sourceTombstone');
    if (artifactTombstone) artifactTombstone.sourceArtifactDigestSha256 = digest('wrong-artifact');
    expectCode(
      () => buildDeltaPlan(artifactForgery, target, checkpoint),
      'SOURCE_TOMBSTONE_ARTIFACT_MISMATCH',
    );
  });

  it('reconciles a deletion only after the tombstoned target generation is gone', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const { changed, removed } = makeDeletedObjectDelta(baseline, checkpoint);
    const appliedTarget = clone(target);
    const targetIndex = appliedTarget.findIndex(
      (record) =>
        record.recordType === 'targetObject' &&
        record.sourceBucketId === removed.bucketId &&
        record.sourceObjectKey === removed.objectKey,
    );
    appliedTarget.splice(targetIndex, 1);
    const targetHeader = appliedTarget.find((record) => record.recordType === 'targetInventory');
    const sourceHeader = changed.find((record) => record.recordType === 'sourceInventory');
    if (targetHeader && sourceHeader) {
      targetHeader.objectCount = sourceHeader.objectCount;
      targetHeader.totalBytes = sourceHeader.totalBytes;
      targetHeader.sourceInventoryDigestSha256 = sourceHeader.inventoryDigestSha256;
    }
    refreshTargetDigest(appliedTarget);
    expect(reconcileInventories(changed, appliedTarget, checkpoint)).toMatchObject({
      reconciled: true,
      objectCount: 123,
      tombstoneCount: 1,
    });
    const nextCheckpoint = buildCheckpointPlan(changed, appliedTarget, checkpoint);
    expect(nextCheckpoint.entries).toHaveLength(123);
    expect(nextCheckpoint.tombstones).toHaveLength(1);
  });

  it('rejects stale chronology, checkpoint swaps, evidence replay, and export replay', () => {
    const baseline = makeSourceInventory();
    const target = makeTargetInventory(baseline);
    const checkpoint = buildCheckpointPlan(baseline, target);
    const delta = makeNoChangeDelta(baseline, checkpoint);

    const stale = clone(delta);
    const staleHeader = stale.find((record) => record.recordType === 'sourceInventory');
    if (staleHeader) staleHeader.frozenAt = checkpoint.sourceFrozenAt;
    refreshSourceDigest(stale);
    expectCode(() => buildDeltaPlan(stale, target, checkpoint), 'SOURCE_DELTA_TIME_INVALID');

    const swapped = clone(delta);
    const swappedHeader = swapped.find((record) => record.recordType === 'sourceInventory');
    if (swappedHeader) swappedHeader.previousCheckpointDigestSha256 = digest('different-checkpoint');
    refreshSourceDigest(swapped);
    expectCode(() => buildDeltaPlan(swapped, target, checkpoint), 'SOURCE_DELTA_CHECKPOINT_MISMATCH');

    const evidenceReplay = clone(delta);
    const evidenceHeader = evidenceReplay.find((record) => record.recordType === 'sourceInventory');
    if (evidenceHeader) {
      evidenceHeader.previousDeltaEvidenceDigestSha256 = digest('forged-previous-evidence');
    }
    refreshSourceDigest(evidenceReplay);
    expectCode(
      () => buildDeltaPlan(evidenceReplay, target, checkpoint),
      'SOURCE_DELTA_PREVIOUS_EVIDENCE_MISMATCH',
    );

    const runReplay = clone(delta);
    const runHeader = runReplay.find((record) => record.recordType === 'sourceInventory');
    if (runHeader) runHeader.exportRunId = checkpoint.sourceExportRunId;
    refreshSourceDigest(runReplay);
    expectCode(() => buildDeltaPlan(runReplay, target, checkpoint), 'SOURCE_EXPORT_RUN_REPLAY');
  });
});

describe('secondary Supabase reference gates', () => {
  it('requires all six references to have ownership, non-use, scan, and evidence proof', () => {
    expect(validateSecondaryReferenceGates(makeSecondaryGate())).toMatchObject({
      ready: true,
      environment: 'uat',
      referenceCount: 6,
    });
  });

  it('fails a non-terminal secondary reference', () => {
    const gates = makeSecondaryGate();
    gates.references[0].disposition = 'REVIEW_REQUIRED';
    expectCode(() => validateSecondaryReferenceGates(gates), 'SECONDARY_REFERENCE_NOT_READY');
  });

  it('fails a missing secondary reference', () => {
    const gates = makeSecondaryGate();
    gates.references.pop();
    expectCode(
      () => validateSecondaryReferenceGates(gates),
      'SECONDARY_REFERENCE_COUNT_MISMATCH',
    );
  });
});

describe('planner safety boundary', () => {
  it('reads a private local JSONL input and returns only aggregate evidence', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'hushh-storage-plan-'));
    const sourcePath = join(directory, 'source.jsonl');
    const source = makeSourceInventory();
    try {
      writeFileSync(sourcePath, `${source.map((record) => JSON.stringify(record)).join('\n')}\n`);
      const result = runStorageCutoverPlanner([
        '--mode',
        'validate-source',
        '--source',
        sourcePath,
      ]);
      expect(result).toMatchObject({
        valid: true,
        bucketCount: 6,
        objectCount: 124,
        totalBytes: 111_078_397,
      });
      expect(JSON.stringify(result)).not.toContain(String(source.at(-1)?.objectKey));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects production and execution-like arguments', () => {
    expectCode(
      () => runStorageCutoverPlanner(['--environment', 'production']),
      'PRODUCTION_EXECUTION_BLOCKED',
    );
    expectCode(() => runStorageCutoverPlanner(['--execute', 'true']), 'UNSUPPORTED_ARGUMENT');
  });

  it('rejects missing and irrelevant mode arguments instead of ignoring them', () => {
    expectCode(
      () => runStorageCutoverPlanner(['--mode', 'contract', '--source', '/tmp/ignored.jsonl']),
      'UNEXPECTED_ARGUMENT_FOR_MODE',
    );
    expectCode(
      () => runStorageCutoverPlanner(['--mode', 'reconcile', '--source', '/tmp/source.jsonl']),
      'MISSING_MODE_ARGUMENT',
    );
  });

  it('rejects directories and oversized private inputs before parsing', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'hushh-storage-input-'));
    const oversizedPath = join(directory, 'oversized.jsonl');
    try {
      expectCode(
        () =>
          runStorageCutoverPlanner([
            '--mode',
            'validate-source',
            '--source',
            directory,
          ]),
        'PRIVATE_INPUT_NOT_REGULAR',
      );
      writeFileSync(oversizedPath, ' '.repeat(8_388_609));
      expectCode(
        () =>
          runStorageCutoverPlanner([
            '--mode',
            'validate-source',
            '--source',
            oversizedPath,
          ]),
        'PRIVATE_INPUT_TOO_LARGE',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects symbolic-link inputs before resolving or opening their target', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'hushh-storage-symlink-'));
    const realPath = join(directory, 'real.jsonl');
    const linkPath = join(directory, 'link.jsonl');
    try {
      writeFileSync(realPath, '{}\n');
      symlinkSync(realPath, linkPath);
      expectCode(
        () =>
          runStorageCutoverPlanner([
            '--mode',
            'validate-source',
            '--source',
            linkPath,
          ]),
        'PRIVATE_INPUT_SYMLINK_BLOCKED',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an input reached through a symbolic-link parent directory', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'hushh-storage-parent-symlink-'));
    const realDirectory = join(directory, 'real');
    const linkDirectory = join(directory, 'linked');
    const inputPath = join(realDirectory, 'source.jsonl');
    try {
      mkdirSync(realDirectory);
      writeFileSync(inputPath, '{}\n');
      symlinkSync(realDirectory, linkDirectory);
      expectCode(
        () =>
          runStorageCutoverPlanner([
            '--mode',
            'validate-source',
            '--source',
            join(linkDirectory, 'source.jsonl'),
          ]),
        'PRIVATE_INPUT_SYMLINK_BLOCKED',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects remote inventory paths before any I/O', () => {
    expectCode(
      () =>
        runStorageCutoverPlanner([
          '--mode',
          'validate-source',
          '--source',
          'gs://private-inventory/source.jsonl',
        ]),
      'LIVE_OR_REMOTE_INPUT_BLOCKED',
    );
  });

  it('contains no network, cloud SDK, copy, or delete implementation', () => {
    const plannerSource = readFileSync(
      new URL('../scripts/migration/storage-cutover-plan.mjs', import.meta.url),
      'utf8',
    );
    const contractSource = readFileSync(
      new URL('../scripts/migration/storage-cutover-contract.mjs', import.meta.url),
      'utf8',
    );
    const implementation = `${plannerSource}\n${contractSource}`;
    expect(implementation).not.toMatch(/from ["']node:(?:https?|net|tls|child_process)["']/);
    expect(implementation).not.toMatch(/@google-cloud\/storage|@supabase\/supabase-js/);
    expect(implementation).not.toMatch(/\bfetch\s*\(/);
    expect(implementation).not.toMatch(/\bexec(?:File|Sync)?\s*\(/);
  });
});
