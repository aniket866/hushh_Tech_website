import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SOURCE_SCHEMA,
  STORAGE_CUTOVER_CONTRACT,
  TARGET_SCHEMA,
  buildCheckpointPlan,
  calculateIamPolicyDigest,
  calculateSignedUrlIssuerEvidenceDigest,
  calculateSourceArtifactDigest,
  calculateSourceInventoryDigest,
  calculateTargetInventoryDigest,
  validateSourceInventory,
} from '../scripts/migration/storage-cutover-contract.mjs';
import {
  MAXIMUM_PRIVATE_INPUT_BYTES,
  calculateSelfBoundDigest,
  canonicalJson,
  contractFileDigestSha256,
  createCrc32c,
  exactFileDigestSha256,
  readPrivateBytes,
  safeErrorResult,
  sha256,
  writePrivateArtifact,
} from '../scripts/migration/storage-live-common.mjs';
import {
  COPY_POLICY_CANDIDATE,
  assertSafeSourceObjectKey,
  buildMigrationTargetObjectKey,
  copyPolicyCandidateFileDigestSha256,
  validateCopyPolicyCandidate,
} from '../scripts/migration/storage-live-policy.mjs';
import {
  SupabaseReadOnlyStorageClient,
  TARGET_COPY_PREFLIGHT_SCHEMA,
  buildExpectedTargetMetadata,
  collectLiveSourceInventory,
  collectLiveTargetPreflight,
  encodeSourceObjectPath,
  hashBoundedObjectResponse,
  runLiveInventoryCli,
  sourceObjectId,
  verifyExistingTargetObject,
} from '../scripts/migration/storage-live-inventory.mjs';
import {
  COPY_APPROVAL_SCHEMA,
  COPY_RESULT_EVIDENCE_SCHEMA,
  GoogleCloudCreateOnlyStorageClient,
  authorizeCopyProviderClients,
  assertPreflightSafeForExecution,
  buildCopyResultEvidence,
  buildCreateOnlyCopyPlan,
  buildTombstoneRetentionAction,
  collectPostRunSourceConfirmation,
  downloadVerifiedSourceToTemp,
  executeActivatedKnownSixCreateOnly,
  reconcileFinalTargets,
  reconcileFinalMigrationNamespace,
  reconcileRetainedHistoricalTargets,
  runStorageCopyExecutor,
  validateCopyApproval,
} from '../scripts/migration/storage-copy-executor.mjs';
import {
  SEVEN_BUCKET_ACTIVATION,
  SEVEN_BUCKET_CONTRACT,
  sevenBucketActivationFileDigestSha256,
} from '../scripts/migration/storage-seven-bucket-contract.mjs';
import {
  ISOLATED_CUTOVER_CONTRACT,
  isolatedCutoverContractFileDigestSha256,
  isolationTagValueNamespacedName,
} from '../scripts/migration/storage-isolated-cutover-contract.mjs';

type JsonRecord = Record<string, unknown>;

const temporaryDirectories: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'hushh-storage-live-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const md5 = (value: string | Buffer) => createHash('md5').update(value).digest('base64');
const crc32c = (value: string | Buffer) => createCrc32c().update(value).digestBase64();

const safeBucketConfiguration = (bucketName: string) => ({
  name: bucketName,
  location: 'US-CENTRAL1',
  storageClass: ISOLATED_CUTOVER_CONTRACT.storageClass,
  iamConfiguration: {
    uniformBucketLevelAccess: { enabled: true },
    publicAccessPrevention: 'enforced',
  },
  versioning: { enabled: true },
  retentionPolicy: {
    retentionPeriod: String(ISOLATED_CUTOVER_CONTRACT.retentionPeriodSeconds),
  },
  softDeletePolicy: {
    retentionDurationSeconds: String(ISOLATED_CUTOVER_CONTRACT.softDeleteRetentionSeconds),
  },
});

const safeIsolationEvidence = (bucketName: string, inheritedBindings: JsonRecord[] = []) => {
  const normalizedInherited = inheritedBindings.map((binding) => ({
    scope: binding.scope ?? null,
    role: binding.role,
    conditionDigestSha256: binding.conditionDigestSha256 ?? null,
    members: [...((binding.members as string[]) || [])].sort(),
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    isolationSafe: true,
    inheritedAccessNeutralized: true,
    tagValueNamespacedName: isolationTagValueNamespacedName(bucketName),
    tagBindingDigestSha256: digest(`tag-${bucketName}`),
    denyPolicyDigestSha256: digest('isolated-deny-policy'),
    denyRuleDigestSha256: digest(`deny-rule-${bucketName}`),
    exceptionPrincipalDigestSha256: digest(`exceptions-${bucketName}`),
    inheritedStorageIamBindingCount: inheritedBindings.length,
    inheritedStorageIamDigestSha256: sha256(canonicalJson(normalizedInherited)),
  };
};

const counterResponse = (
  totalBytes: number,
  onCancel: () => void = () => {},
  chunkBytes = 1_048_576,
) => {
  let remaining = totalBytes;
  return new Response(new ReadableStream({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const size = Math.min(remaining, chunkBytes);
      remaining -= size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      onCancel();
    },
  }, { highWaterMark: 0 }), { status: 200 });
};

const makeSourceRecords = (): JsonRecord[] => {
  const records: JsonRecord[] = [{
    recordType: 'sourceInventory',
    schemaVersion: SOURCE_SCHEMA,
    snapshotKind: 'FROZEN_BASELINE',
    sourceProjectRef: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef,
    frozenAt: STORAGE_CUTOVER_CONTRACT.frozenAt,
    snapshotSequence: 0,
    exportRunId: 'storage-live-copy-test-baseline',
    bucketCount: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.bucketCount,
    objectCount: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.objectCount,
    totalBytes: STORAGE_CUTOVER_CONTRACT.sourceSnapshot.totalBytes,
    tombstoneCount: 0,
    deltaEvidenceDigestSha256: null,
    previousCheckpointDigestSha256: null,
    previousSourceInventoryDigestSha256: null,
    previousSourceArtifactDigestSha256: null,
    previousDeltaEvidenceDigestSha256: null,
    inventoryDigestSha256: '0'.repeat(64),
    sourceArtifactDigestSha256: '0'.repeat(64),
  }];
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
      const objectKey = `object-${String(index + 1).padStart(3, '0')}.bin`;
      const sizeBytes = index === 0 ? bucket.totalBytes - (bucket.objectCount - 1) : 1;
      records.push({
        recordType: 'sourceObject',
        bucketId: bucket.sourceBucket,
        objectKey,
        sizeBytes,
        mimeType: 'application/octet-stream',
        sourceUpdatedAt: STORAGE_CUTOVER_CONTRACT.frozenAt,
        cacheControl: bucket.sourcePublic ? '3600' : null,
        sha256: digest(`${bucket.sourceBucket}\0${objectKey}\0${sizeBytes}`),
      });
    }
  }
  records[0].inventoryDigestSha256 = calculateSourceInventoryDigest(records);
  records[0].sourceArtifactDigestSha256 = calculateSourceArtifactDigest(records);
  return records;
};

const makeCheckpointTargetRecords = (sourceRecords: JsonRecord[]): JsonRecord[] => {
  const source = validateSourceInventory(sourceRecords);
  const records: JsonRecord[] = [{
    recordType: 'targetInventory',
    schemaVersion: TARGET_SCHEMA,
    environment: 'uat',
    project: 'hushh-tech-uat',
    region: 'us-central1',
    bucketCount: 6,
    objectCount: source.objectCount,
    totalBytes: source.totalBytes,
    signedUrlIssuerCount: STORAGE_CUTOVER_CONTRACT.buckets.reduce(
      (sum, bucket) => sum + bucket.signedUrlIssuers.length,
      0,
    ),
    signedUrlIssuerEvidenceDigestSha256: '0'.repeat(64),
    sourceInventoryDigestSha256: source.digestSha256,
  }];
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const bucketIamBindings = structuredClone(bucket.allowedIamBindings);
    const inheritedIamBindings: JsonRecord[] = [];
    const effectiveIamBindings = structuredClone(bucket.allowedIamBindings);
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
        evidenceDigestSha256: digest(`issuer\0${bucket.targetBucket}\0${issuerMember}`),
      });
    }
  }
  source.objects.forEach((object, index) => {
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === object.bucketId,
    )!;
    records.push({
      recordType: 'targetObject',
      sourceBucketId: object.bucketId,
      sourceObjectKey: object.objectKey,
      targetBucket: bucket.targetBucket,
      targetObjectKey: object.objectKey,
      generation: String(1_000 + index),
      sizeBytes: object.sizeBytes,
      mimeType: object.mimeType,
      sourceUpdatedAtMetadata: object.sourceUpdatedAt,
      sourceCacheControlMetadata: object.cacheControl,
      servingCacheControl: bucket.targetServingCacheControl,
      sha256: object.sha256,
      accessMode: bucket.targetAccessMode,
      publicAcl: false,
    });
  });
  records[0].signedUrlIssuerEvidenceDigestSha256 =
    calculateSignedUrlIssuerEvidenceDigest(records);
  records[0].inventoryDigestSha256 = calculateTargetInventoryDigest(records);
  return records;
};

const makePreflight = (
  records: JsonRecord[],
  { presentCount = 0, unmanagedObjectCount = 563, unmanagedTotalBytes = 9_999 } = {},
) => {
  const source = validateSourceInventory(records);
  const presentIds = new Set(source.objects.slice(0, presentCount).map(sourceObjectId));
  const objects = source.objects.map((object) => {
    const objectId = sourceObjectId(object);
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === object.bucketId,
    )!;
    const targetKey = buildMigrationTargetObjectKey(
      object.bucketId,
      object.objectKey,
      object.fingerprint,
    );
    const present = presentIds.has(objectId);
    return {
      objectId,
      targetBucket: bucket.targetBucket,
      targetObjectKeyDigestSha256: sha256(targetKey),
      expectedBytes: object.sizeBytes,
      expectedSha256: object.sha256,
      state: present ? 'PRESENT_EXACT' : 'ABSENT',
      generation: present ? String(10_000 + source.objects.indexOf(object)) : null,
      verifiedSha256: present ? object.sha256 : null,
      verifiedCrc32c: present ? crc32c(object.sha256) : null,
      verifiedMd5Hash: present ? md5(object.sha256) : null,
      targetMetadataDigestSha256: sha256(
        JSON.stringify(buildExpectedTargetMetadata(object, source), Object.keys(buildExpectedTargetMetadata(object, source)).sort()),
      ),
    };
  });
  // Production code uses canonical JSON. Rebind the metadata digest with the same helper through
  // a temporary first plan attempt is intentionally avoided; sorted flat metadata is equivalent.
  const buckets = STORAGE_CUTOVER_CONTRACT.buckets.map((bucket, index) => ({
    bucketName: bucket.targetBucket,
    bucketConfigurationSafe: true,
    iamMatchesFrozenAllowlist: true,
    location: 'US-CENTRAL1',
    storageClass: 'STANDARD',
    uniformBucketLevelAccess: true,
    publicAccessPrevention: 'enforced',
    versioningEnabled: true,
    retentionPeriodSeconds: 604800,
    retentionPolicyLocked: false,
    softDeleteRetentionSeconds: 604800,
    isolationSafe: true,
    inheritedAccessNeutralized: true,
    isolationTagValueNamespacedName: isolationTagValueNamespacedName(bucket.targetBucket),
    isolationTagBindingDigestSha256: digest(`tag-${bucket.targetBucket}`),
    isolationDenyPolicyDigestSha256: digest('isolated-deny-policy'),
    isolationDenyRuleDigestSha256: digest(`deny-rule-${bucket.targetBucket}`),
    isolationExceptionPrincipalDigestSha256: digest(`exceptions-${bucket.targetBucket}`),
    isolationInheritedIamDigestSha256: sha256(canonicalJson([])),
    bucketIamEvidenceDigestSha256: digest(`bucket-iam-${bucket.targetBucket}`),
    inheritedIamEvidenceDigestSha256: sha256(canonicalJson([])),
    bucketIamBindingCount: bucket.allowedIamBindings.length,
    inheritedStorageIamBindingCount: 0,
    publicIamMemberCount: 0,
    expectedMigrationObjectCount: bucket.objectCount,
    existingMigrationObjectCount: source.objects.filter(
      (object) => object.bucketId === bucket.sourceBucket && presentIds.has(sourceObjectId(object)),
    ).length,
    unknownMigrationObjectCount: 0,
    retainedHistoricalObjectCount: 0,
    retainedHistoricalTotalBytes: 0,
    retainedHistoricalObjectSetDigestSha256: sha256('[]'),
    unmanagedObjectCount: index === 1 ? unmanagedObjectCount : 0,
    unmanagedTotalBytes: index === 1 ? unmanagedTotalBytes : 0,
    unmanagedInventoryDigestSha256: digest(`unmanaged-${bucket.targetBucket}`),
  }));
  const artifact: JsonRecord = {
    schemaVersion: TARGET_COPY_PREFLIGHT_SCHEMA,
    collectedAt: '2026-08-21T12:00:00Z',
    environment: 'uat',
    project: 'hushh-tech-uat',
    region: 'us-central1',
    contractFileDigestSha256: contractFileDigestSha256(),
    isolatedCutoverContractFileDigestSha256: isolatedCutoverContractFileDigestSha256(),
    copyPolicyCandidateFileDigestSha256: copyPolicyCandidateFileDigestSha256(),
    sourceInventoryDigestSha256: source.digestSha256,
    sourceArtifactDigestSha256: source.sourceArtifactDigestSha256,
    previousCheckpointFileDigestSha256: null,
    previousCheckpointDigestSha256: null,
    migrationNamespace: COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace,
    bucketCount: 6,
    expectedObjectCount: source.objectCount,
    expectedTotalBytes: source.totalBytes,
    existingMigrationObjectCount: presentCount,
    unmanagedObjectCount,
    unmanagedTotalBytes,
    retainedHistoricalObjectCount: 0,
    retainedHistoricalTotalBytes: 0,
    buckets,
    objects: objects.sort((left, right) => left.objectId.localeCompare(right.objectId)),
    retainedHistoricalObjects: [],
    blockers: ['COPY_POLICY_NOT_ACTIVATED', 'COPY_EXECUTION_NOT_ALLOWED'],
    safeForCopy: false,
    preflightDigestSha256: null,
  };
  artifact.preflightDigestSha256 = calculateSelfBoundDigest(artifact, 'preflightDigestSha256');
  return artifact;
};

const sourceJsonLines = (records: JsonRecord[]) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

const makeApprovalFixture = () => {
  const records = makeSourceRecords();
  const source = validateSourceInventory(records);
  const preflight = makePreflight(records, { presentCount: 2 });
  const plan = buildCreateOnlyCopyPlan(source, preflight);
  const reviewedCommitSha = 'a'.repeat(40);
  const sourceFileDigestSha256 = digest('source-file');
  const preflightFileDigestSha256 = digest('preflight-file');
  const planFileDigestSha256 = digest('plan-file');
  const approvalFileDigestSha256 = digest('approval-file');
  const approval: JsonRecord = {
    schemaVersion: COPY_APPROVAL_SCHEMA,
    environment: 'uat',
    project: 'hushh-tech-uat',
    region: 'us-central1',
    repository: COPY_POLICY_CANDIDATE.copyPolicy.approvalRepository,
    pullRequestNumber: 1954,
    reviewId: 9001,
    reviewerLogin: 'Jhumma-hushh',
    reviewedCommitSha,
    decision: 'APPROVED_FOR_CREATE_ONLY_UAT_COPY',
    approvedAt: '2026-08-21T12:00:00Z',
    expiresAt: '2026-08-21T13:30:00Z',
    contractFileDigestSha256: contractFileDigestSha256(),
    isolatedCutoverContractFileDigestSha256:
      isolatedCutoverContractFileDigestSha256(),
    copyPolicyCandidateFileDigestSha256: copyPolicyCandidateFileDigestSha256(),
    sourceInventoryFileDigestSha256: sourceFileDigestSha256,
    sourceInventoryDigestSha256: plan.sourceInventoryDigestSha256,
    sourceArtifactDigestSha256: plan.sourceArtifactDigestSha256,
    previousCheckpointFileDigestSha256: plan.previousCheckpointFileDigestSha256,
    previousCheckpointDigestSha256: plan.previousCheckpointDigestSha256,
    targetPreflightFileDigestSha256: preflightFileDigestSha256,
    targetPreflightDigestSha256: plan.targetPreflightDigestSha256,
    planFileDigestSha256,
    planDigestSha256: plan.planDigestSha256,
    objectCount: plan.actionCount,
    totalBytes: plan.expectedBytes,
    migrationNamespace: plan.migrationNamespace,
    approvalDigestSha256: null,
  };
  approval.approvalDigestSha256 = calculateSelfBoundDigest(approval, 'approvalDigestSha256');
  const review = () => ({
    id: approval.reviewId,
    state: 'APPROVED',
    commit_id: approval.reviewedCommitSha,
    user: { login: approval.reviewerLogin },
    submitted_at: approval.approvedAt,
    body: `${COPY_POLICY_CANDIDATE.copyPolicy.approvalReviewMarkerPrefix}${plan.planDigestSha256}:${planFileDigestSha256}`,
  });
  const githubReviewClient = {
    getReview: () => review(),
    getCommit: () => ({
      author: { login: 'source-author' },
      committer: { login: 'source-committer' },
    }),
    getPullRequest: () => ({
      state: 'open',
      draft: false,
      head: { sha: reviewedCommitSha },
      user: { login: 'pull-request-author' },
      commits: 1,
    }),
    getPullRequestCommits: () => [{
      sha: reviewedCommitSha,
      author: { login: 'source-author' },
      committer: { login: 'source-committer' },
    }],
    getReviews: () => [review()],
  };
  return {
    approval,
    approvalFileDigestSha256,
    githubReviewClient,
    plan,
    planFileDigestSha256,
    preflightFileDigestSha256,
    reviewedHead: reviewedCommitSha,
    sourceFileDigestSha256,
  };
};

describe('storage live inventory and create-only copy safety', () => {
  it('keeps the checked-in contract and candidate execution gates closed', () => {
    expect(STORAGE_CUTOVER_CONTRACT.contractState).toBe('PLANNING_ONLY_NO_LIVE_IO');
    expect(STORAGE_CUTOVER_CONTRACT.executionPolicy.objectCopiesAllowed).toBe(false);
    expect(validateCopyPolicyCandidate()).toMatchObject({ valid: true, executionAllowed: false });
    expect(COPY_POLICY_CANDIDATE.executionActivated).toBe(false);
    expect(COPY_POLICY_CANDIDATE.copyExecutionAllowed).toBe(false);
  });

  it('uses the standard CRC32C representation for server-side upload validation', () => {
    expect(crc32c('123456789')).toBe('4waSgw==');
  });

  it('redacts unknown errors instead of exposing provider, credential, or path text', () => {
    const result = safeErrorResult(
      new Error('Bearer secret-token https://provider.invalid /private/sensitive/path'),
      'STORAGE_COPY_EXECUTOR_FAILED',
    );
    expect(result).toEqual({
      ok: false,
      code: 'STORAGE_COPY_EXECUTOR_FAILED',
      message: 'Storage migration command failed without exposing provider or local details.',
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|provider\.invalid|sensitive\/path/);
  });

  it('blocks arbitrary buckets and keys inside the Google write primitive before credentials or fetch', async () => {
    let touched = false;
    const client = new GoogleCloudCreateOnlyStorageClient({
      tokenProvider: () => { touched = true; return 'token-'.padEnd(40, 'x'); },
      fetchImpl: async () => { touched = true; throw new Error('must not fetch'); },
    });
    await expect(client.uploadCreateOnly({
      bucketName: 'hushh-tech-prod-arbitrary',
      objectKey: 'outside-migration-namespace',
    } as never)).rejects.toMatchObject({ code: 'GCP_WRITE_TARGET_BLOCKED' });
    await expect(client.getObject(
      'hushh-tech-cutover-v1-assets-legal-uat',
      '_hushh_migrations/supabase-cutover-v1/community-uploads/' + 'a'.repeat(64) + '/' + 'f'.repeat(64),
    )).rejects.toMatchObject({ code: 'GCP_WRITE_TARGET_BLOCKED' });
    await expect(client.listMigrationObjects('hushh-tech-prod-arbitrary'))
      .rejects.toMatchObject({ code: 'GCP_WRITE_TARGET_BLOCKED' });
    expect(touched).toBe(false);
  });

  it('hard-blocks --execute before artifacts, credentials, GitHub, or provider clients are touched', async () => {
    let touched = false;
    const dependencies = new Proxy({}, {
      get() {
        touched = true;
        throw new Error('dependency must not be touched');
      },
    });
    await expect(runStorageCopyExecutor(['--execute'], dependencies)).rejects.toMatchObject({
      code: 'COPY_EXECUTION_BLOCKED_PENDING_REVIEW',
    });
    expect(touched).toBe(false);
  });

  it('defaults both collector modes to a no-network dry run', async () => {
    let touched = false;
    const dependencies = new Proxy({}, { get: () => { touched = true; return null; } });
    await expect(runLiveInventoryCli(['--mode', 'source'], dependencies)).resolves.toMatchObject({
      dryRun: true,
      readOnlyLiveExecuted: false,
      executionAllowed: false,
    });
    await expect(runLiveInventoryCli(['--mode', 'target'], dependencies)).resolves.toMatchObject({
      dryRun: true,
      readOnlyLiveExecuted: false,
      executionAllowed: false,
    });
    expect(touched).toBe(false);
  });

  it('maps hostile-looking keys into the fixed hashed namespace without path escape', () => {
    const prefix = `${COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace}/assets/`;
    for (const key of ['normal/file.bin', '%2e%2e', '?', '#', 'nested/.hidden']) {
      const mapped = buildMigrationTargetObjectKey('assets', key, 'f'.repeat(64));
      expect(mapped.startsWith(prefix)).toBe(true);
      expect(mapped.slice(prefix.length)).toMatch(/^[a-f0-9]{64}\/[a-f0-9]{64}$/);
      expect(mapped).not.toContain(key);
    }
    expect(encodeSourceObjectPath('%2e%2e')).toBe('%252e%252e');
    expect(encodeSourceObjectPath('?')).toBe('%3F');
    expect(encodeSourceObjectPath('#')).toBe('%23');
    for (const key of ['.', '..', '../x']) {
      expect(() => assertSafeSourceObjectKey(key)).toThrowError();
    }
  });

  it('rejects oversized and non-round-trip UTF-8 keys before hashing', () => {
    expect(() => assertSafeSourceObjectKey('a'.repeat(1_025))).toThrowError();
    expect(() => assertSafeSourceObjectKey('\ud800')).toThrowError();
    expect(() => assertSafeSourceObjectKey('valid-😀')).not.toThrow();
  });

  it('keeps source reads on the fixed project host and rejects mutation methods', async () => {
    const urls: URL[] = [];
    const client = new SupabaseReadOnlyStorageClient({
      serviceRoleKey: 'x'.repeat(40),
      sleepImpl: async () => {},
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(new URL(String(input)));
        expect(init?.method).toBe('GET');
        return new Response(Buffer.alloc(0), { status: 200, headers: { 'content-length': '0' } });
      },
    });
    for (const key of ['%2e%2e', '?', '#']) await client.hashObject('assets', key, 0);
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url.hostname).toBe(`${STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef}.supabase.co`);
      expect(url.pathname.startsWith('/storage/v1/object/authenticated/assets/')).toBe(true);
    }
    await expect(client.request('/object/authenticated/assets/file', { method: 'DELETE' })).rejects.toMatchObject({
      code: 'SOURCE_MUTATION_BLOCKED',
    });
  });

  it('cancels a source object stream as soon as it exceeds the approved byte count', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new SupabaseReadOnlyStorageClient({
      serviceRoleKey: 'x'.repeat(40),
      sleepImpl: async () => {},
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    await expect(client.hashObject('assets', 'safe.bin', 1)).rejects.toMatchObject({
      code: 'SOURCE_OBJECT_DOWNLOAD_INVALID',
    });
    expect(cancelled).toBe(true);
  });

  it('streams an exact 130270442-byte seventh object under only its frozen 1 GiB cap', async () => {
    const exactBytes = 130_270_442;
    const result = await hashBoundedObjectResponse(
      counterResponse(exactBytes),
      exactBytes,
      Math.min(exactBytes, SEVEN_BUCKET_CONTRACT.seventh.maximumObjectBytes),
      'SEVENTH_SOURCE_OBJECT_DOWNLOAD_INVALID',
    );
    expect(result).toMatchObject({ sizeBytes: exactBytes });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('cancels a seventh stream at exact approved bytes plus one', async () => {
    const exactBytes = 130_270_442;
    let cancelled = false;
    await expect(hashBoundedObjectResponse(
      counterResponse(exactBytes + 1, () => { cancelled = true; }),
      exactBytes,
      Math.min(exactBytes, SEVEN_BUCKET_CONTRACT.seventh.maximumObjectBytes),
      'SEVENTH_SOURCE_OBJECT_DOWNLOAD_INVALID',
    )).rejects.toMatchObject({ code: 'SEVENTH_SOURCE_OBJECT_DOWNLOAD_INVALID' });
    expect(cancelled).toBe(true);
  });

  it('keeps the original six-bucket reader capped at 111078397 bytes', async () => {
    let cancelled = false;
    const client = new SupabaseReadOnlyStorageClient({
      serviceRoleKey: 'x'.repeat(40),
      sleepImpl: async () => {},
      fetchImpl: async () => counterResponse(
        STORAGE_CUTOVER_CONTRACT.sourceSnapshot.totalBytes + 1,
        () => { cancelled = true; },
      ),
    });
    await expect(client.hashObject(
      STORAGE_CUTOVER_CONTRACT.buckets[0].sourceBucket,
      'oversized-six-object.bin',
      130_270_442,
    )).rejects.toMatchObject({ code: 'SOURCE_OBJECT_DOWNLOAD_INVALID' });
    expect(cancelled).toBe(true);
  });

  it('rejects a wrong bucket before it can select the seventh higher cap', async () => {
    let providerTouched = false;
    const client = new SupabaseReadOnlyStorageClient({
      serviceRoleKey: 'x'.repeat(40),
      sleepImpl: async () => {},
      fetchImpl: async () => {
        providerTouched = true;
        return counterResponse(0);
      },
    });
    await expect(client.hashSeventhObject(
      'not-the-private-seventh-bucket',
      'object.bin',
      130_270_442,
    )).rejects.toMatchObject({ code: 'SEVENTH_SOURCE_BUCKET_IDENTITY_MISMATCH' });
    expect(providerTouched).toBe(false);
  });

  it('collects the exact 6/124/111078397 source evidence with two stable metadata passes', async () => {
    const expected = validateSourceInventory(makeSourceRecords());
    let listCalls = 0;
    const sourceClient = {
      listBuckets: async () => STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({
        id: bucket.sourceBucket,
        public: bucket.sourcePublic,
      })),
      listObjects: async (bucketId: string) => {
        listCalls += 1;
        return expected.objects.filter((object) => object.bucketId === bucketId).map((object) => ({
          id: digest(`id-${bucketId}-${object.objectKey}`),
          name: object.objectKey,
          objectKey: object.objectKey,
          updated_at: object.sourceUpdatedAt,
          metadata: {
            size: object.sizeBytes,
            mimetype: object.mimeType,
            cacheControl: object.cacheControl,
          },
        }));
      },
      hashObject: async (bucketId: string, objectKey: string) => ({
        sizeBytes: expected.objects.find(
          (object) => object.bucketId === bucketId && object.objectKey === objectKey,
        )!.sizeBytes,
        sha256: expected.objects.find(
          (object) => object.bucketId === bucketId && object.objectKey === objectKey,
        )!.sha256,
      }),
    };
    const collected = await collectLiveSourceInventory({
      sourceClient,
      collectedAt: '2026-08-21T12:00:00Z',
      exportRunId: 'test-live-export',
    });
    expect(collected.evidence).toMatchObject({
      bucketCount: 6,
      objectCount: 124,
      totalBytes: 111_078_397,
      sourceMutationAllowed: false,
    });
    expect(listCalls).toBe(12);
    expect(validateSourceInventory(collected.records).objectCount).toBe(124);
    expect(collected.jsonLines).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('collects a checkpoint-bound live delta with an immutable update and typed no-delete tombstone', async () => {
    const baselineRecords = makeSourceRecords();
    const baseline = validateSourceInventory(baselineRecords);
    const checkpoint = buildCheckpointPlan(
      baselineRecords,
      makeCheckpointTargetRecords(baselineRecords),
    );
    const changedBaseline = baseline.objects[0];
    const deletedBaseline = baseline.objects[1];
    const liveObjects = baseline.objects
      .filter((object) => object.objectId !== deletedBaseline.objectId)
      .map((object) => object.objectId === changedBaseline.objectId
        ? {
            ...object,
            sourceUpdatedAt: '2026-08-21T14:00:00Z',
            sha256: digest('live-delta-changed-bytes'),
          }
        : object);
    let listCalls = 0;
    const sourceClient = {
      listBuckets: async () => STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({
        id: bucket.sourceBucket,
        public: bucket.sourcePublic,
      })),
      listObjects: async (bucketId: string) => {
        listCalls += 1;
        return liveObjects.filter((object) => object.bucketId === bucketId).map((object) => ({
          id: digest(`delta-id-${bucketId}-${object.objectKey}`),
          name: object.objectKey,
          objectKey: object.objectKey,
          updated_at: object.sourceUpdatedAt,
          metadata: {
            size: object.sizeBytes,
            mimetype: object.mimeType,
            cacheControl: object.cacheControl,
          },
        }));
      },
      hashObject: async (bucketId: string, objectKey: string) => {
        const object = liveObjects.find((candidate) =>
          candidate.bucketId === bucketId && candidate.objectKey === objectKey)!;
        return { sizeBytes: object.sizeBytes, sha256: object.sha256 };
      },
    };
    const checkpointFileDigestSha256 = digest('live-delta-checkpoint-file');
    const collected = await collectLiveSourceInventory({
      sourceClient,
      collectedAt: '2026-08-21T14:15:00Z',
      exportRunId: 'test-live-delta-export',
      previousCheckpoint: checkpoint,
      previousCheckpointFileDigestSha256: checkpointFileDigestSha256,
    });
    const delta = validateSourceInventory(collected.records, { previousCheckpoint: checkpoint });
    expect(collected.evidence).toMatchObject({
      snapshotKind: 'RECORDED_DELTA',
      snapshotSequence: 1,
      previousCheckpointFileDigestSha256: checkpointFileDigestSha256,
      previousCheckpointDigestSha256: checkpoint.checkpointDigestSha256,
      objectCount: 123,
      tombstoneCount: 1,
      dispositionCount: 124,
      sourceMutationAllowed: false,
    });
    expect(listCalls).toBe(12);
    expect(delta.objects.find((object) => object.objectId === changedBaseline.objectId)?.fingerprint)
      .not.toBe(changedBaseline.fingerprint);
    expect(delta.tombstones).toEqual([
      expect.objectContaining({
        objectId: deletedBaseline.objectId,
        priorSourceFingerprintSha256: deletedBaseline.fingerprint,
      }),
    ]);
    expect(collected.jsonLines).not.toMatch(/DELETE_IF|OVERWRITE/);
  });

  it('builds a partial-replay plan with only exact no-ops and ifGenerationMatch=0 creates', () => {
    const source = validateSourceInventory(makeSourceRecords());
    const plan = buildCreateOnlyCopyPlan(source, makePreflight(makeSourceRecords(), { presentCount: 7 }));
    expect(plan).toMatchObject({
      actionCount: 124,
      createCount: 117,
      noopCount: 7,
      deleteCount: 0,
      overwriteCount: 0,
      executionAllowed: false,
      unmanagedObjectCount: 563,
    });
    expect(plan.actions.filter((action: JsonRecord) => action.action === 'CREATE_IF_ABSENT'))
      .toHaveLength(117);
    expect(plan.actions.filter((action: JsonRecord) => action.action === 'CREATE_IF_ABSENT')
      .every((action: JsonRecord) => action.targetPrecondition === 'ifGenerationMatch=0')).toBe(true);
    expect(plan.actions.some((action: JsonRecord) => /DELETE|OVERWRITE/.test(action.action))).toBe(false);
    expect(() => assertPreflightSafeForExecution(makePreflight(makeSourceRecords())))
      .toThrowError();
  });

  it('rejects a tampered source inventory before planning', () => {
    const records = makeSourceRecords();
    const object = records.find((record) => record.recordType === 'sourceObject')!;
    object.sha256 = 'f'.repeat(64);
    expect(() => validateSourceInventory(records)).toThrowError();
  });

  it('rejects semantically tampered target evidence even after its outer digest is rebound', () => {
    const records = makeSourceRecords();
    const preflight = makePreflight(records);
    const objects = preflight.objects as JsonRecord[];
    objects[0].expectedBytes = Number(objects[0].expectedBytes) + 1;
    preflight.preflightDigestSha256 = calculateSelfBoundDigest(
      preflight,
      'preflightDigestSha256',
    );
    expect(() => buildCreateOnlyCopyPlan(validateSourceInventory(records), preflight))
      .toThrowError(expect.objectContaining({ code: 'TARGET_PREFLIGHT_OBJECT_MISMATCH' }));
  });

  it('requires a current independent GitHub approval bound to every exact artifact', () => {
    const fixture = makeApprovalFixture();
    expect(validateCopyApproval({
      ...fixture,
      now: new Date('2026-08-21T12:30:00Z'),
    })).toMatchObject({ valid: true });
  });

  it('rejects future-dated approvals beyond the explicit clock-skew bound', () => {
    const fixture = makeApprovalFixture();
    fixture.approval.approvedAt = '2026-08-21T12:31:01Z';
    fixture.approval.expiresAt = '2026-08-21T13:31:01Z';
    fixture.approval.approvalDigestSha256 = calculateSelfBoundDigest(
      fixture.approval,
      'approvalDigestSha256',
    );
    expect(() => validateCopyApproval({
      ...fixture,
      now: new Date('2026-08-21T12:30:00Z'),
    })).toThrowError(expect.objectContaining({ code: 'COPY_APPROVAL_EXPIRED' }));
  });

  it('rejects an approval after the pull request head changes', () => {
    const fixture = makeApprovalFixture();
    fixture.githubReviewClient.getPullRequest = () => ({
      state: 'open',
      draft: false,
      head: { sha: 'b'.repeat(40) },
    });
    expect(() => validateCopyApproval({
      ...fixture,
      now: new Date('2026-08-21T12:30:00Z'),
    })).toThrowError(expect.objectContaining({ code: 'COPY_APPROVAL_PR_HEAD_MISMATCH' }));
  });

  it('rejects an approval revoked by a later allowlisted review', () => {
    const fixture = makeApprovalFixture();
    const exactReview = fixture.githubReviewClient.getReview();
    fixture.githubReviewClient.getReviews = () => [
      exactReview,
      {
        id: 9002,
        state: 'CHANGES_REQUESTED',
        user: { login: 'ankitkumarsingh1702' },
        submitted_at: '2026-08-21T12:15:00Z',
      },
    ];
    expect(() => validateCopyApproval({
      ...fixture,
      now: new Date('2026-08-21T12:30:00Z'),
    })).toThrowError(expect.objectContaining({ code: 'COPY_APPROVAL_REVOKED' }));
  });

  it('rejects a reviewer who authored the pull request', () => {
    const fixture = makeApprovalFixture();
    fixture.githubReviewClient.getPullRequest = () => ({
      state: 'open',
      draft: false,
      head: { sha: fixture.reviewedHead },
      user: { login: fixture.approval.reviewerLogin },
      commits: 1,
    });
    expect(() => validateCopyApproval({
      ...fixture,
      now: new Date('2026-08-21T12:30:00Z'),
    })).toThrowError(expect.objectContaining({ code: 'COPY_APPROVAL_NOT_INDEPENDENT' }));
  });

  it('fails closed when any paginated pull request commit has unresolved authorship', () => {
    const fixture = makeApprovalFixture();
    fixture.githubReviewClient.getPullRequest = () => ({
      state: 'open',
      draft: false,
      head: { sha: fixture.reviewedHead },
      user: { login: 'pull-request-author' },
      commits: 2,
    });
    fixture.githubReviewClient.getPullRequestCommits = () => [
      {
        sha: fixture.reviewedHead,
        author: { login: 'source-author' },
        committer: { login: 'source-committer' },
      },
      {
        sha: 'b'.repeat(40),
        author: null,
        committer: { login: 'second-committer' },
      },
    ];
    expect(() => validateCopyApproval({
      ...fixture,
      now: new Date('2026-08-21T12:30:00Z'),
    })).toThrowError(expect.objectContaining({ code: 'COPY_APPROVAL_NOT_INDEPENDENT' }));
  });

  it('rejects malformed approval artifact digests before GitHub lookup', () => {
    const fixture = makeApprovalFixture();
    fixture.approval.planFileDigestSha256 = 'not-a-digest';
    fixture.approval.approvalDigestSha256 = calculateSelfBoundDigest(
      fixture.approval,
      'approvalDigestSha256',
    );
    expect(() => validateCopyApproval({
      ...fixture,
      now: new Date('2026-08-21T12:30:00Z'),
    })).toThrowError(expect.objectContaining({ code: 'COPY_APPROVAL_DIGEST_INVALID' }));
  });

  it('proves 563 unrelated objects remain outside the migration namespace', async () => {
    const records = makeSourceRecords();
    const source = validateSourceInventory(records);
    const first = source.objects[0];
    const firstBucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (bucket) => bucket.sourceBucket === first.bucketId,
    )!;
    const existing = {
      name: buildMigrationTargetObjectKey(
        first.bucketId,
        first.objectKey,
        first.fingerprint,
      ),
      bucket: firstBucket.targetBucket,
      generation: '9001',
      size: String(first.sizeBytes),
      crc32c: crc32c(first.sha256),
      md5Hash: md5(first.sha256),
      contentType: first.mimeType,
      cacheControl: firstBucket.targetServingCacheControl,
      metadata: buildExpectedTargetMetadata(first, source),
    };
    const unrelated = Array.from({ length: 563 }, (_, index) => ({
      name: `existing-community/${index}`,
      bucket: 'hushh-tech-cutover-v1-community-content-uat',
      generation: String(index + 1),
      size: '1',
    }));
    const gcsClient = {
      getBucket: async (bucketName: string) => safeBucketConfiguration(bucketName),
      getBucketIam: async () => ({ bindings: [] }),
      inspectIam: () => ({ bucketBindings: [], inheritedBindings: [] }),
      inspectIsolation: (bucketName: string, inheritedBindings: JsonRecord[]) =>
        safeIsolationEvidence(bucketName, inheritedBindings),
      listObjects: async (bucketName: string) => [
        ...(bucketName === firstBucket.targetBucket ? [existing] : []),
        ...(bucketName === 'hushh-tech-cutover-v1-community-content-uat' ? unrelated : []),
      ],
      hashObject: async () => ({
        sizeBytes: first.sizeBytes,
        sha256: first.sha256,
        crc32cBase64: crc32c(first.sha256),
        md5Base64: md5(first.sha256),
      }),
    };
    // Use the frozen allowlist in each fake policy so only the intentionally closed candidate
    // gates remain as blockers.
    let policyIndex = 0;
    gcsClient.inspectIam = () => {
      const index = policyIndex;
      const bucket = STORAGE_CUTOVER_CONTRACT.buckets[index];
      policyIndex = index + 1;
      return { bucketBindings: bucket.allowedIamBindings, inheritedBindings: [] };
    };
    const artifact = await collectLiveTargetPreflight({
      gcsClient,
      sourceRecords: records,
      collectedAt: '2026-08-21T12:00:00Z',
    });
    expect(artifact.unmanagedObjectCount).toBe(563);
    expect(artifact.existingMigrationObjectCount).toBe(1);
    expect(artifact.objects.find((entry: JsonRecord) => entry.objectId === sourceObjectId(first)))
      .toMatchObject({ state: 'PRESENT_EXACT', generation: '9001' });
    expect(artifact.blockers).toEqual(['COPY_POLICY_NOT_ACTIVATED', 'COPY_EXECUTION_NOT_ALLOWED']);
    expect(artifact.safeForCopy).toBe(false);
  });

  it('fails closed when any unknown object occupies the migration namespace', async () => {
    const records = makeSourceRecords();
    const gcsClient = {
      getBucket: async (bucketName: string) => safeBucketConfiguration(bucketName),
      getBucketIam: async () => ({ bindings: [] }),
      inspectIam: () => ({ bucketBindings: [], inheritedBindings: [] }),
      inspectIsolation: (bucketName: string, inheritedBindings: JsonRecord[]) =>
        safeIsolationEvidence(bucketName, inheritedBindings),
      listObjects: async (bucketName: string) => bucketName === 'hushh-tech-cutover-v1-assets-legal-uat'
        ? [{
            name: `${COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace}/assets/${'f'.repeat(64)}`,
            bucket: bucketName,
            generation: '1',
            size: '1',
          }]
        : [],
      hashObject: async () => { throw new Error('must not hash collision'); },
    };
    await expect(collectLiveTargetPreflight({ gcsClient, sourceRecords: records })).rejects.toMatchObject({
      code: 'TARGET_MIGRATION_NAMESPACE_OCCUPIED',
    });
  });

  it('rejects group and external principals added at the bucket policy layer', async () => {
    const records = makeSourceRecords();
    let policyIndex = 0;
    const gcsClient = {
      getBucket: async (bucketName: string) => safeBucketConfiguration(bucketName),
      getBucketIam: async () => ({ bindings: [] }),
      inspectIam: () => {
        const bucket = STORAGE_CUTOVER_CONTRACT.buckets[policyIndex];
        policyIndex += 1;
        return {
          bucketBindings: policyIndex === 1
            ? [
                ...bucket.allowedIamBindings,
                {
                  role: 'roles/storage.objectViewer',
                  members: [
                    'group:external-storage@example.com',
                    'principalSet://iam.googleapis.com/locations/global/workforcePools/external/*',
                  ],
                  conditionDigestSha256: null,
                },
              ]
            : bucket.allowedIamBindings,
          inheritedBindings: [],
        };
      },
      inspectIsolation: (bucketName: string, inheritedBindings: JsonRecord[]) =>
        safeIsolationEvidence(bucketName, inheritedBindings),
      listObjects: async () => [],
      hashObject: async () => { throw new Error('must not hash absent targets'); },
    };
    const preflight = await collectLiveTargetPreflight({
      gcsClient,
      sourceRecords: records,
      collectedAt: '2026-08-21T12:00:00Z',
    });
    expect(preflight.buckets.some((bucket: JsonRecord) =>
      bucket.iamMatchesFrozenAllowlist === false)).toBe(true);
    expect(preflight.blockers).toContain('TARGET_IAM_NOT_FROZEN_ALLOWLIST');
  });

  it('creates an immutable version for same-key changed bytes and no-ops the unchanged version', async () => {
    const baselineRecords = makeSourceRecords();
    const baseline = validateSourceInventory(baselineRecords);
    const baselineObject = baseline.objects[0];
    const changedRecords = structuredClone(baselineRecords);
    const changedObjectRecord = changedRecords.find((record) =>
      record.recordType === 'sourceObject' &&
      record.bucketId === baselineObject.bucketId &&
      record.objectKey === baselineObject.objectKey)!;
    changedObjectRecord.sha256 = digest('same-key-new-bytes');
    changedObjectRecord.sourceUpdatedAt = '2026-08-21T12:00:00Z';
    changedRecords[0].inventoryDigestSha256 = calculateSourceInventoryDigest(changedRecords);
    changedRecords[0].sourceArtifactDigestSha256 = calculateSourceArtifactDigest(changedRecords);
    const changed = validateSourceInventory(changedRecords);
    const changedObject = changed.objectById.get(sourceObjectId(baselineObject))!;
    const baselineKey = buildMigrationTargetObjectKey(
      baselineObject.bucketId,
      baselineObject.objectKey,
      baselineObject.fingerprint,
    );
    const changedKey = buildMigrationTargetObjectKey(
      changedObject.bucketId,
      changedObject.objectKey,
      changedObject.fingerprint,
    );
    expect(changedObject.objectKey).toBe(baselineObject.objectKey);
    expect(changedObject.fingerprint).not.toBe(baselineObject.fingerprint);
    expect(changedKey).not.toBe(baselineKey);

    const targetObject = (sourceInventory: typeof baseline, object: typeof baselineObject, generation: string) => {
      const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
        (entry) => entry.sourceBucket === object.bucketId,
      )!;
      const name = buildMigrationTargetObjectKey(
        object.bucketId,
        object.objectKey,
        object.fingerprint,
      );
      return {
        name,
        bucket: bucket.targetBucket,
        generation,
        size: String(object.sizeBytes),
        crc32c: crc32c(object.sha256),
        md5Hash: md5(object.sha256),
        contentType: object.mimeType,
        cacheControl: bucket.targetServingCacheControl,
        metadata: buildExpectedTargetMetadata(object, sourceInventory),
      };
    };
    const makeGcsClient = (objects: JsonRecord[]) => {
      let policyIndex = 0;
      return {
        getBucket: async (bucketName: string) => safeBucketConfiguration(bucketName),
        getBucketIam: async () => ({ bindings: [] }),
        inspectIam: () => {
          const bucket = STORAGE_CUTOVER_CONTRACT.buckets[policyIndex];
          policyIndex += 1;
          return { bucketBindings: bucket.allowedIamBindings, inheritedBindings: [] };
        },
        inspectIsolation: (bucketName: string, inheritedBindings: JsonRecord[]) =>
          safeIsolationEvidence(bucketName, inheritedBindings),
        listObjects: async (bucketName: string) => objects.filter(
          (object) => object.bucket === bucketName,
        ),
        hashObject: async (_bucketName: string, target: JsonRecord) => {
          const targetMetadata = target.metadata as JsonRecord;
          return {
            sizeBytes: Number(target.size),
            sha256: targetMetadata['hushh-source-sha256'],
            crc32cBase64: target.crc32c,
            md5Base64: target.md5Hash,
          };
        },
      };
    };
    const baselineTarget = targetObject(baseline, baselineObject, '101');
    const deltaPreflight = await collectLiveTargetPreflight({
      gcsClient: makeGcsClient([baselineTarget]),
      sourceRecords: changedRecords,
      collectedAt: '2026-08-21T12:30:00Z',
    });
    expect(deltaPreflight.retainedHistoricalObjectCount).toBe(1);
    expect(deltaPreflight.objects.find((object: JsonRecord) =>
      object.objectId === changedObject.objectId)).toMatchObject({ state: 'ABSENT' });
    const deltaPlan = buildCreateOnlyCopyPlan(changed, deltaPreflight);
    const changedAction = deltaPlan.actions.find((action: JsonRecord) =>
      action.objectId === changedObject.objectId)!;
    expect(changedAction).toMatchObject({
      action: 'CREATE_IF_ABSENT',
      targetPrecondition: 'ifGenerationMatch=0',
      sourceFingerprintSha256: changedObject.fingerprint,
    });
    expect(changedAction.targetObjectKeyDigestSha256).not.toBe(sha256(baselineKey));
    expect(deltaPlan).toMatchObject({ deleteCount: 0, overwriteCount: 0 });

    const changedTarget = targetObject(changed, changedObject, '102');
    const replayPreflight = await collectLiveTargetPreflight({
      gcsClient: makeGcsClient([baselineTarget, changedTarget]),
      sourceRecords: changedRecords,
      collectedAt: '2026-08-21T12:45:00Z',
    });
    const replayPlan = buildCreateOnlyCopyPlan(changed, replayPreflight);
    expect(replayPlan.actions.find((action: JsonRecord) =>
      action.objectId === changedObject.objectId)).toMatchObject({
      action: 'NOOP_PRESENT_EXACT',
      targetGeneration: '102',
      sourceFingerprintSha256: changedObject.fingerprint,
    });
    expect(replayPreflight.retainedHistoricalObjectCount).toBe(1);
  });

  it('turns a typed source deletion into pointer removal plus retained bytes, never a target delete', () => {
    const action = buildTombstoneRetentionAction({
      recordType: 'sourceTombstone',
      objectId: digest('deleted-object-id'),
      priorSourceFingerprintSha256: digest('prior-source-fingerprint'),
      deletedAt: '2026-08-21T13:00:00Z',
      deletionReason: 'Source object deleted before final cutover.',
      previousSourceInventoryDigestSha256: digest('previous-source-inventory'),
      deltaEvidenceDigestSha256: digest('delta-evidence'),
      sourceArtifactDigestSha256: digest('source-artifact'),
    });
    expect(action).toMatchObject({
      action: 'RETAIN_TOMBSTONED_VERSIONS',
      targetMutationAllowed: false,
      databasePointerDisposition: 'REMOVE_POINTER_AFTER_SEPARATE_DB_TRANSACTION',
    });
    expect(JSON.stringify(action)).not.toMatch(/DELETE_IF|deleteObject|ifGenerationMatch/);
    expect(() => buildTombstoneRetentionAction({
      recordType: 'sourceTombstone',
      objectId: digest('deleted-object-id'),
    })).toThrowError(expect.objectContaining({ code: 'SOURCE_TOMBSTONE_SCHEMA_MISMATCH' }));
  });

  it('replays a real checkpoint-bound delta as create-new, no-op, and no-delete tombstone actions', async () => {
    const baselineRecords = makeSourceRecords();
    const baseline = validateSourceInventory(baselineRecords);
    const checkpoint = buildCheckpointPlan(
      baselineRecords,
      makeCheckpointTargetRecords(baselineRecords),
    );
    const changedObject = baseline.objects[0];
    const deletedObject = baseline.objects[1];
    const deltaRecords = structuredClone(baselineRecords);
    const changedRecord = deltaRecords.find((record) =>
      record.recordType === 'sourceObject' &&
      record.bucketId === changedObject.bucketId &&
      record.objectKey === changedObject.objectKey)!;
    changedRecord.sha256 = digest('checkpoint-bound-changed-bytes');
    changedRecord.sourceUpdatedAt = '2026-08-21T14:00:00Z';
    const deletedIndex = deltaRecords.findIndex((record) =>
      record.recordType === 'sourceObject' &&
      record.bucketId === deletedObject.bucketId &&
      record.objectKey === deletedObject.objectKey);
    deltaRecords.splice(deletedIndex, 1);
    const header = deltaRecords[0];
    const deletedBucket = deltaRecords.find((record) =>
      record.recordType === 'sourceBucket' && record.bucketId === deletedObject.bucketId)!;
    Object.assign(header, {
      snapshotKind: 'RECORDED_DELTA',
      frozenAt: '2026-08-21T14:00:00Z',
      snapshotSequence: 1,
      exportRunId: 'storage-live-copy-delta-test',
      objectCount: Number(header.objectCount) - 1,
      totalBytes: Number(header.totalBytes) - deletedObject.sizeBytes,
      tombstoneCount: 1,
      deltaEvidenceDigestSha256: digest('checkpoint-bound-delta-evidence'),
      previousCheckpointDigestSha256: checkpoint.checkpointDigestSha256,
      previousSourceInventoryDigestSha256: checkpoint.sourceInventoryDigestSha256,
      previousSourceArtifactDigestSha256: checkpoint.sourceArtifactDigestSha256,
      previousDeltaEvidenceDigestSha256: checkpoint.deltaEvidenceDigestSha256,
    });
    deletedBucket.objectCount = Number(deletedBucket.objectCount) - 1;
    deletedBucket.totalBytes = Number(deletedBucket.totalBytes) - deletedObject.sizeBytes;
    const checkpointEntry = checkpoint.entries.find((entry) =>
      entry.objectId === deletedObject.objectId)!;
    const tombstone: JsonRecord = {
      recordType: 'sourceTombstone',
      objectId: deletedObject.objectId,
      priorSourceFingerprintSha256: checkpointEntry.sourceFingerprintSha256,
      deletedAt: '2026-08-21T14:00:00Z',
      deletionReason: 'Source object deleted before final cutover.',
      previousSourceInventoryDigestSha256: checkpoint.sourceInventoryDigestSha256,
      deltaEvidenceDigestSha256: header.deltaEvidenceDigestSha256,
      sourceArtifactDigestSha256: '0'.repeat(64),
    };
    deltaRecords.push(tombstone);
    header.inventoryDigestSha256 = calculateSourceInventoryDigest(deltaRecords);
    header.sourceArtifactDigestSha256 = calculateSourceArtifactDigest(deltaRecords);
    tombstone.sourceArtifactDigestSha256 = header.sourceArtifactDigestSha256;
    const delta = validateSourceInventory(deltaRecords, { previousCheckpoint: checkpoint });
    const checkpointFileDigestSha256 = digest('checkpoint-file-bytes');
    delta.previousCheckpointFileDigestSha256 = checkpointFileDigestSha256;

    const baselineTargets = baseline.objects.map((object, index) => {
      const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
        (entry) => entry.sourceBucket === object.bucketId,
      )!;
      return {
        name: buildMigrationTargetObjectKey(
          object.bucketId,
          object.objectKey,
          object.fingerprint,
        ),
        bucket: bucket.targetBucket,
        generation: String(10_000 + index),
        size: String(object.sizeBytes),
        crc32c: crc32c(object.sha256),
        md5Hash: md5(object.sha256),
        contentType: object.mimeType,
        cacheControl: bucket.targetServingCacheControl,
        metadata: buildExpectedTargetMetadata(object, baseline),
      };
    });
    let policyIndex = 0;
    const gcsClient = {
      getBucket: async (bucketName: string) => safeBucketConfiguration(bucketName),
      getBucketIam: async () => ({ bindings: [] }),
      inspectIam: () => {
        const bucket = STORAGE_CUTOVER_CONTRACT.buckets[policyIndex];
        policyIndex += 1;
        return { bucketBindings: bucket.allowedIamBindings, inheritedBindings: [] };
      },
      inspectIsolation: (bucketName: string, inheritedBindings: JsonRecord[]) =>
        safeIsolationEvidence(bucketName, inheritedBindings),
      listObjects: async (bucketName: string) => baselineTargets.filter(
        (object) => object.bucket === bucketName,
      ),
      hashObject: async (_bucketName: string, target: JsonRecord) => {
        const metadata = target.metadata as JsonRecord;
        return {
          sizeBytes: Number(target.size),
          sha256: metadata['hushh-source-sha256'],
          crc32cBase64: target.crc32c,
          md5Base64: target.md5Hash,
        };
      },
    };
    const preflight = await collectLiveTargetPreflight({
      gcsClient,
      sourceRecords: deltaRecords,
      previousCheckpoint: checkpoint,
      previousCheckpointFileDigestSha256: checkpointFileDigestSha256,
      collectedAt: '2026-08-21T14:15:00Z',
    });
    const plan = buildCreateOnlyCopyPlan(delta, preflight);
    expect(plan).toMatchObject({
      actionCount: 124,
      liveObjectCount: 123,
      tombstoneCount: 1,
      createCount: 1,
      noopCount: 122,
      retainedTombstoneCount: 1,
      deleteCount: 0,
      overwriteCount: 0,
      retainedHistoricalObjectCount: 2,
      previousCheckpointFileDigestSha256: checkpointFileDigestSha256,
      previousCheckpointDigestSha256: checkpoint.checkpointDigestSha256,
    });
    expect(plan.actions.find((action: JsonRecord) =>
      action.objectId === changedObject.objectId)).toMatchObject({
      action: 'CREATE_IF_ABSENT',
      targetPrecondition: 'ifGenerationMatch=0',
    });
    expect(plan.actions.find((action: JsonRecord) =>
      action.objectId === deletedObject.objectId)).toMatchObject({
      action: 'RETAIN_TOMBSTONED_VERSIONS',
      targetMutationAllowed: false,
      databasePointerDisposition: 'REMOVE_POINTER_AFTER_SEPARATE_DB_TRANSACTION',
    });
    expect(plan.actions.some((action: JsonRecord) => /DELETE_IF|OVERWRITE/.test(String(action.action))))
      .toBe(false);

    const rebindRetainedHistory = (artifact: JsonRecord) => {
      const history = (artifact.retainedHistoricalObjects as JsonRecord[]).sort((left, right) =>
        `${left.objectId}\0${left.sourceFingerprintSha256}`.localeCompare(
          `${right.objectId}\0${right.sourceFingerprintSha256}`,
        ));
      artifact.retainedHistoricalObjectCount = history.length;
      artifact.retainedHistoricalTotalBytes = history.reduce(
        (sum, object) => sum + Number(object.sizeBytes),
        0,
      );
      for (const bucket of artifact.buckets as JsonRecord[]) {
        const entries = history.filter((object) => object.targetBucket === bucket.bucketName);
        bucket.retainedHistoricalObjectCount = entries.length;
        bucket.retainedHistoricalTotalBytes = entries.reduce(
          (sum, object) => sum + Number(object.sizeBytes),
          0,
        );
        bucket.retainedHistoricalObjectSetDigestSha256 = sha256(canonicalJson(entries));
      }
      artifact.preflightDigestSha256 = calculateSelfBoundDigest(
        artifact,
        'preflightDigestSha256',
      );
      return artifact;
    };
    const expectHistoryGateBeforeProviders = (
      fresh: JsonRecord,
      expectedCode: string,
    ) => {
      let sourceClientTouched = false;
      let writeClientTouched = false;
      expect(() => authorizeCopyProviderClients({
        approvedPreflight: preflight,
        freshPreflight: fresh,
        source: delta,
        sourceClientFactory: () => {
          sourceClientTouched = true;
          return {};
        },
        writeClientFactory: () => {
          writeClientTouched = true;
          return {};
        },
      })).toThrowError(expect.objectContaining({ code: expectedCode }));
      expect(sourceClientTouched).toBe(false);
      expect(writeClientTouched).toBe(false);
    };

    const historyAdded = structuredClone(preflight);
    const added = structuredClone(historyAdded.retainedHistoricalObjects[0]);
    added.sourceFingerprintSha256 = digest('adversarial-added-history-fingerprint');
    added.targetObjectKeyDigestSha256 = digest('adversarial-added-history-key');
    added.generation = '777771';
    added.sha256 = digest('adversarial-added-history-sha');
    added.crc32cBase64 = crc32c('adversarial-added-history-crc');
    added.md5Hash = md5('adversarial-added-history-md5');
    added.targetMetadataDigestSha256 = digest('adversarial-added-history-metadata');
    historyAdded.retainedHistoricalObjects.push(added);
    expectHistoryGateBeforeProviders(
      rebindRetainedHistory(historyAdded),
      'TARGET_FRESH_RETAINED_HISTORY_MISMATCH',
    );

    const historyRemoved = structuredClone(preflight);
    historyRemoved.retainedHistoricalObjects.splice(0, 1);
    expectHistoryGateBeforeProviders(
      rebindRetainedHistory(historyRemoved),
      'TARGET_FRESH_RETAINED_HISTORY_MISMATCH',
    );

    const historyChanged = structuredClone(preflight);
    const changedHistory = historyChanged.retainedHistoricalObjects[0];
    changedHistory.generation = '777772';
    changedHistory.sha256 = digest('adversarial-changed-history-sha');
    changedHistory.crc32cBase64 = crc32c('adversarial-changed-history-crc');
    changedHistory.md5Hash = md5('adversarial-changed-history-md5');
    changedHistory.targetMetadataDigestSha256 = digest('adversarial-changed-history-metadata');
    expectHistoryGateBeforeProviders(
      rebindRetainedHistory(historyChanged),
      'TARGET_FRESH_RETAINED_HISTORY_MISMATCH',
    );

    const namespaceAdded = structuredClone(preflight);
    const newlyPresent = namespaceAdded.objects.find((object: JsonRecord) =>
      object.objectId === changedObject.objectId)!;
    newlyPresent.state = 'PRESENT_EXACT';
    newlyPresent.generation = '777773';
    newlyPresent.verifiedSha256 = newlyPresent.expectedSha256;
    newlyPresent.verifiedCrc32c = crc32c(String(newlyPresent.expectedSha256));
    newlyPresent.verifiedMd5Hash = md5(String(newlyPresent.expectedSha256));
    namespaceAdded.existingMigrationObjectCount =
      Number(namespaceAdded.existingMigrationObjectCount) + 1;
    const namespaceBucket = namespaceAdded.buckets.find((bucket: JsonRecord) =>
      bucket.bucketName === newlyPresent.targetBucket)!;
    namespaceBucket.existingMigrationObjectCount =
      Number(namespaceBucket.existingMigrationObjectCount) + 1;
    namespaceAdded.preflightDigestSha256 = calculateSelfBoundDigest(
      namespaceAdded,
      'preflightDigestSha256',
    );
    expectHistoryGateBeforeProviders(
      namespaceAdded,
      'TARGET_FRESH_NAMESPACE_MISMATCH',
    );

    const currentChangedObject = delta.objects.find((object) =>
      object.objectId === changedObject.objectId)!;
    const changedBucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === currentChangedObject.bucketId,
    )!;
    const changedTarget = {
      name: buildMigrationTargetObjectKey(
        currentChangedObject.bucketId,
        currentChangedObject.objectKey,
        currentChangedObject.fingerprint,
      ),
      bucket: changedBucket.targetBucket,
      generation: '99001',
      size: String(currentChangedObject.sizeBytes),
      crc32c: crc32c(currentChangedObject.sha256),
      md5Hash: md5(currentChangedObject.sha256),
      contentType: currentChangedObject.mimeType,
      cacheControl: changedBucket.targetServingCacheControl,
      metadata: buildExpectedTargetMetadata(currentChangedObject, delta),
    };
    const finalTargetVersions = [...baselineTargets, changedTarget];
    const finalGcsClient = {
      getObject: async (bucketName: string, targetKey: string) =>
        finalTargetVersions.find((object) =>
          object.bucket === bucketName && object.name === targetKey) ?? null,
      hashObject: gcsClient.hashObject,
      listMigrationObjects: async (bucketName: string) => finalTargetVersions.filter(
        (object) => object.bucket === bucketName,
      ),
    };
    const outcomes = new Map(delta.objects.map((object) => [
      object.objectId,
      object.objectId === changedObject.objectId ? 'CREATED' : 'NOOP_PRESENT_EXACT',
    ]));
    const targetFinal = await reconcileFinalTargets(finalGcsClient, delta, outcomes);
    const retainedHistoricalFinal = await reconcileRetainedHistoricalTargets(
      finalGcsClient,
      preflight,
    );
    const finalMigrationNamespace = await reconcileFinalMigrationNamespace({
      gcsClient: finalGcsClient,
      source: delta,
      targetFinal,
      retainedHistoricalFinal,
    });
    const pollutedNamespaceClient = {
      ...finalGcsClient,
      listMigrationObjects: async (bucketName: string) => [
        ...await finalGcsClient.listMigrationObjects(bucketName),
        ...(bucketName === 'hushh-tech-cutover-v1-assets-legal-uat' ? [{
          name: `${COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace}/assets/${'a'.repeat(64)}/${'b'.repeat(64)}`,
          bucket: bucketName,
          generation: '88888',
          size: '1',
        }] : []),
      ],
    };
    await expect(reconcileFinalMigrationNamespace({
      gcsClient: pollutedNamespaceClient,
      source: delta,
      targetFinal,
      retainedHistoricalFinal,
    })).rejects.toMatchObject({ code: 'TARGET_NAMESPACE_FINAL_RECONCILIATION_FAILED' });
    const sourceClient = {
      listBuckets: async () => STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({
        id: bucket.sourceBucket,
        public: bucket.sourcePublic,
      })),
      listObjects: async (bucketId: string) => delta.objects
        .filter((object) => object.bucketId === bucketId)
        .map((object) => ({
          id: object.objectId,
          name: object.objectKey,
          objectKey: object.objectKey,
          updated_at: object.sourceUpdatedAt,
          metadata: {
            size: object.sizeBytes,
            mimetype: object.mimeType,
            cacheControl: object.cacheControl,
          },
        })),
      hashObject: async (bucketId: string, objectKey: string) => {
        const object = delta.objects.find((candidate) =>
          candidate.bucketId === bucketId && candidate.objectKey === objectKey)!;
        return {
          sizeBytes: object.sizeBytes,
          sha256: object.sha256,
          crc32cBase64: crc32c(object.sha256),
          md5Base64: md5(object.sha256),
        };
      },
    };
    const sourcePostRun = await collectPostRunSourceConfirmation(sourceClient, delta);
    const result = {
      createdCount: 1,
      noopCount: 122,
      deletedCount: 0,
      overwrittenCount: 0,
      sourcePostRun,
      targetFinal,
      retainedHistoricalFinal,
      finalMigrationNamespace,
    };
    const evidence = buildCopyResultEvidence({
      source: delta,
      sourceFileDigestSha256: digest('delta-source-file'),
      preflight,
      preflightFileDigestSha256: digest('delta-preflight-file'),
      plan,
      planFileDigestSha256: digest('delta-plan-file'),
      approval: {
        approvalDigestSha256: digest('delta-approval'),
        pullRequestNumber: 1954,
        reviewId: 9901,
      },
      approvalFileDigestSha256: digest('delta-approval-file'),
      result,
      reviewedHead: 'b'.repeat(40),
    });
    expect(evidence).toMatchObject({
      objectCount: 123,
      tombstoneCount: 1,
      dispositionCount: 124,
      immutableTargetVersionCount: 125,
      createdCount: 1,
      noopCount: 122,
      deleteCount: 0,
      overwriteCount: 0,
    });
    expect(evidence.retainedHistoricalFinal).toMatchObject({ objectCount: 2 });
    expect(evidence.databasePointerManifest).toMatchObject({
      livePointerCount: 123,
      tombstonePointerRemovalCount: 1,
    });
    expect(evidence.databasePointerManifest.tombstones).toEqual([
      expect.objectContaining({
        objectId: deletedObject.objectId,
        disposition: 'REMOVE_POINTER_RETAIN_IMMUTABLE_TARGET_NO_DELETE',
      }),
    ]);

    const tamperedHistory = structuredClone(retainedHistoricalFinal);
    tamperedHistory.objects[0].generation = '999999';
    tamperedHistory.objectSetDigestSha256 = sha256(canonicalJson(tamperedHistory.objects));
    expect(() => buildCopyResultEvidence({
      source: delta,
      sourceFileDigestSha256: digest('delta-source-file'),
      preflight,
      preflightFileDigestSha256: digest('delta-preflight-file'),
      plan,
      planFileDigestSha256: digest('delta-plan-file'),
      approval: {
        approvalDigestSha256: digest('delta-approval'),
        pullRequestNumber: 1954,
        reviewId: 9901,
      },
      approvalFileDigestSha256: digest('delta-approval-file'),
      result: { ...result, retainedHistoricalFinal: tamperedHistory },
      reviewedHead: 'b'.repeat(40),
    })).toThrowError(expect.objectContaining({ code: 'COPY_RESULT_EVIDENCE_INVALID' }));
  });

  it('rejects a mismatched preexisting target instead of overwriting it', async () => {
    const source = validateSourceInventory(makeSourceRecords());
    const object = source.objects[0];
    const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
      (entry) => entry.sourceBucket === object.bucketId,
    )!;
    await expect(verifyExistingTargetObject(
      { hashObject: async () => ({
        sizeBytes: object.sizeBytes,
        sha256: object.sha256,
        crc32cBase64: crc32c(object.sha256),
        md5Base64: md5(object.sha256),
      }) },
      object,
      source,
      {
        name: buildMigrationTargetObjectKey(
          object.bucketId,
          object.objectKey,
          object.fingerprint,
        ),
        bucket: bucket.targetBucket,
        generation: '1',
        size: String(object.sizeBytes),
        crc32c: crc32c(object.sha256),
        md5Hash: md5(object.sha256),
        contentType: object.mimeType,
        cacheControl: bucket.targetServingCacheControl,
        metadata: { ...buildExpectedTargetMetadata(object, source), 'hushh-source-sha256': '0'.repeat(64) },
      },
    )).rejects.toMatchObject({ code: 'TARGET_PREEXISTING_COLLISION' });
  });

  it('hands upload an unlinked read-only descriptor and cleans failed downloads', async () => {
    const before = new Set(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith('hushh-storage-copy-')),
    );
    const sourceObject = {
      bucketId: 'assets',
      objectKey: 'sealed-source.bin',
      sizeBytes: 3,
      sha256: digest('abc'),
    };
    const sealed = await downloadVerifiedSourceToTemp({
      request: async () => new Response(Buffer.from('abc'), {
        status: 200,
        headers: { 'content-length': '3' },
      }),
    }, sourceObject);
    expect(sealed).not.toHaveProperty('filePath');
    expect(sealed).not.toHaveProperty('directory');
    expect(sealed).toMatchObject({
      sizeBytes: 3,
      sha256: digest('abc'),
      crc32cBase64: crc32c('abc'),
      md5Base64: md5('abc'),
    });
    expect(() => writeSync(
      sealed.fileDescriptor,
      Buffer.from('XYZ'),
      0,
      3,
      0,
    )).toThrow();
    closeSync(sealed.fileDescriptor);

    await expect(downloadVerifiedSourceToTemp({
      request: async () => new Response(Buffer.from('abc'), {
        status: 200,
        headers: { 'content-length': '3' },
      }),
    }, { ...sourceObject, sha256: 'f'.repeat(64) })).rejects.toMatchObject({
      code: 'SOURCE_OBJECT_CHANGED',
    });
    const after = new Set(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith('hushh-storage-copy-')),
    );
    expect(after).toEqual(before);
  });

  it('rejects same-size descriptor mutation after resumable initiation before PUT', async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, 'mutable-source.bin');
    writeFileSync(filePath, 'abc', { mode: 0o600 });
    const writerDescriptor = openSync(filePath, 'r+');
    const readDescriptor = openSync(filePath, 'r');
    let putCalled = false;
    const client = new GoogleCloudCreateOnlyStorageClient({
      tokenProvider: () => 'token-'.padEnd(40, 'x'),
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          writeSync(writerDescriptor, Buffer.from('XYZ'), 0, 3, 0);
          return new Response(null, {
            status: 200,
            headers: {
              location: 'https://storage.googleapis.com/upload/storage/v1/b/hushh-tech-cutover-v1-assets-legal-uat/o?upload_id=safe',
            },
          });
        }
        if (init?.method === 'PUT') putCalled = true;
        throw new Error('PUT must not occur after mutation');
      },
    });
    try {
      await expect(client.uploadCreateOnly({
        bucketName: 'hushh-tech-cutover-v1-assets-legal-uat',
        objectKey: '_hushh_migrations/supabase-cutover-v1/assets/' + 'a'.repeat(64) + '/' + 'f'.repeat(64),
        fileDescriptor: readDescriptor,
        sizeBytes: 3,
        expectedSha256: digest('abc'),
        crc32cBase64: crc32c('abc'),
        md5Base64: md5('abc'),
        contentType: 'application/octet-stream',
        cacheControl: 'private, no-store',
        metadata: { marker: 'test' },
      })).rejects.toMatchObject({ code: 'SOURCE_TEMP_CHANGED' });
    } finally {
      closeSync(readDescriptor);
      closeSync(writerDescriptor);
    }
    expect(putCalled).toBe(false);
  });

  it('uses only POST-init and PUT bytes with ifGenerationMatch=0 for a create', async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, 'source.bin');
    writeFileSync(filePath, Buffer.from('abc'), { mode: 0o600 });
    const requests: Array<{ url: URL; method: string }> = [];
    let uploadedBytes = Buffer.alloc(0);
    let uploadHashHeader: string | null = null;
    const client = new GoogleCloudCreateOnlyStorageClient({
      tokenProvider: () => 'token-'.padEnd(40, 'x'),
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method || 'GET';
        requests.push({ url, method });
        if (method === 'POST') {
          return new Response(null, {
            status: 200,
            headers: {
              location: 'https://storage.googleapis.com/upload/storage/v1/b/hushh-tech-cutover-v1-assets-legal-uat/o?upload_id=safe',
            },
          });
        }
        if (method === 'PUT') {
          uploadHashHeader = new Headers(init?.headers).get('x-goog-hash');
          const chunks: Buffer[] = [];
          for await (const chunk of init?.body as AsyncIterable<Uint8Array>) {
            chunks.push(Buffer.from(chunk));
          }
          uploadedBytes = Buffer.concat(chunks);
          return new Response(JSON.stringify({
            name: '_hushh_migrations/test',
            bucket: 'hushh-tech-cutover-v1-assets-legal-uat',
            generation: '7',
            size: '3',
            crc32c: crc32c('abc'),
            md5Hash: md5('abc'),
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error('unexpected method');
      },
    });
    const originalPath = join(directory, 'verified-original.bin');
    const descriptor = openSync(filePath, 'r');
    renameSync(filePath, originalPath);
    writeFileSync(filePath, 'evil', { mode: 0o600 });
    await expect(client.uploadCreateOnly({
      bucketName: 'hushh-tech-cutover-v1-assets-legal-uat',
      objectKey: '_hushh_migrations/supabase-cutover-v1/assets/' + 'a'.repeat(64) + '/' + 'f'.repeat(64),
      fileDescriptor: descriptor,
      sizeBytes: 3,
      expectedSha256: digest('abc'),
      crc32cBase64: crc32c('abc'),
      md5Base64: md5('abc'),
      contentType: 'application/octet-stream',
      cacheControl: 'private, no-store',
      metadata: { marker: 'test' },
    })).resolves.toMatchObject({ collision: false });
    closeSync(descriptor);
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT']);
    expect(requests[0].url.searchParams.get('ifGenerationMatch')).toBe('0');
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
    expect(uploadedBytes.toString('utf8')).toBe('abc');
    expect(uploadHashHeader).toBe(`crc32c=${crc32c('abc')},md5=${md5('abc')}`);
  });

  it('rejects a resumable session location for any other bucket', async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, 'source.bin');
    writeFileSync(filePath, 'abc', { mode: 0o600 });
    const descriptor = openSync(filePath, 'r');
    let putCalled = false;
    const client = new GoogleCloudCreateOnlyStorageClient({
      tokenProvider: () => 'token-'.padEnd(40, 'x'),
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') putCalled = true;
        return new Response(null, {
          status: 200,
          headers: {
            location: 'https://storage.googleapis.com/upload/storage/v1/b/other-bucket/o?upload_id=unsafe',
          },
        });
      },
    });
    await expect(client.uploadCreateOnly({
      bucketName: 'hushh-tech-cutover-v1-assets-legal-uat',
      objectKey: '_hushh_migrations/supabase-cutover-v1/assets/' + 'a'.repeat(64) + '/' + 'f'.repeat(64),
      fileDescriptor: descriptor,
      sizeBytes: 3,
      expectedSha256: digest('abc'),
      crc32cBase64: crc32c('abc'),
      md5Base64: md5('abc'),
      contentType: 'application/octet-stream',
      cacheControl: 'private, no-store',
      metadata: { marker: 'test' },
    })).rejects.toMatchObject({ code: 'GCP_WRITE_ENDPOINT_BLOCKED' });
    closeSync(descriptor);
    expect(putCalled).toBe(false);
  });

  it('cancels an oversized target JSON response before buffering it', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([123]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new GoogleCloudCreateOnlyStorageClient({
      tokenProvider: () => 'token-'.padEnd(40, 'x'),
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { 'content-length': String(MAXIMUM_PRIVATE_INPUT_BYTES + 1) },
      }),
    });
    await expect(client.getObject(
      'hushh-tech-cutover-v1-assets-legal-uat',
      '_hushh_migrations/supabase-cutover-v1/assets/' + 'a'.repeat(64) + '/' + 'f'.repeat(64),
    ))
      .rejects.toMatchObject({ code: 'TARGET_OBJECT_READ_INVALID' });
    expect(cancelled).toBe(true);
  });

  it('rejects oversized, symlinked, and existing private artifact paths', () => {
    const directory = temporaryDirectory();
    const large = join(directory, 'large.json');
    writeFileSync(large, Buffer.alloc(MAXIMUM_PRIVATE_INPUT_BYTES + 1));
    expect(() => readPrivateBytes(large)).toThrowError();

    const real = join(directory, 'real.json');
    writeFileSync(real, '{}', { mode: 0o600 });
    const link = join(directory, 'link.json');
    symlinkSync(real, link);
    expect(() => readPrivateBytes(link)).toThrowError();

    const output = join(directory, 'output.json');
    writePrivateArtifact(output, Buffer.from('{}'));
    expect((lstatSync(output).mode & 0o777)).toBe(0o600);
    expect(() => writePrivateArtifact(output, Buffer.from('{}'))).toThrowError();
  });

  it('runs the exact activated known-six adapter through 124 create-or-no-op operations', async () => {
    const records = makeSourceRecords();
    const source = validateSourceInventory(records);
    const preflight = makePreflight(records, { presentCount: 124 });
    const plan = buildCreateOnlyCopyPlan(source, preflight);
    const sourceFileDigestSha256 = digest('combined-known-six-source-file');
    const preflightFileDigestSha256 = digest('combined-known-six-preflight-file');
    const planFileDigestSha256 = digest('combined-known-six-plan-file');
    const combinedPlan: JsonRecord = {
      contractState: SEVEN_BUCKET_ACTIVATION.contractState,
      executionActivated: true,
      activationFileDigestSha256: sevenBucketActivationFileDigestSha256(),
      activationDigestSha256: SEVEN_BUCKET_ACTIVATION.activationDigestSha256,
      knownSixSourceFileDigestSha256: sourceFileDigestSha256,
      knownSixPreflightFileDigestSha256: preflightFileDigestSha256,
      knownSixPreflightDigestSha256: plan.targetPreflightDigestSha256,
      knownSixPlanFileDigestSha256: planFileDigestSha256,
      knownSixPlanDigestSha256: plan.planDigestSha256,
      knownSixActionCount: 124,
      knownSixActions: plan.actions,
      planDigestSha256: null,
    };
    combinedPlan.planDigestSha256 = calculateSelfBoundDigest(
      combinedPlan,
      'planDigestSha256',
    );
    const approvalDigestSha256 = digest('combined-lane-7-approval');
    const combinedApproval = {
      approvalDigestSha256,
      contractState: SEVEN_BUCKET_ACTIVATION.contractState,
      executionActivated: true,
      activationFileDigestSha256: sevenBucketActivationFileDigestSha256(),
      activationDigestSha256: SEVEN_BUCKET_ACTIVATION.activationDigestSha256,
      planDigestSha256: combinedPlan.planDigestSha256,
    };
    const sourceClient = {
      listBuckets: async () => STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({
        id: bucket.sourceBucket,
        public: bucket.sourcePublic,
      })),
      listObjects: async (bucketId: string) => source.objects
        .filter((object) => object.bucketId === bucketId)
        .map((object) => ({
          id: sourceObjectId(object),
          name: object.objectKey,
          objectKey: object.objectKey,
          updated_at: object.sourceUpdatedAt,
          metadata: {
            size: object.sizeBytes,
            mimetype: object.mimeType,
            cacheControl: object.cacheControl,
          },
        })),
      hashObject: async (bucketId: string, objectKey: string) => {
        const object = source.objects.find(
          (candidate) => candidate.bucketId === bucketId && candidate.objectKey === objectKey,
        )!;
        return {
          sizeBytes: object.sizeBytes,
          sha256: object.sha256,
          crc32cBase64: crc32c(object.sha256),
          md5Base64: md5(object.sha256),
        };
      },
    };
    const sourceByTargetKey = new Map(source.objects.map((object, index) => [
      buildMigrationTargetObjectKey(
        object.bucketId,
        object.objectKey,
        object.fingerprint,
      ),
      {
        object,
        generation: String(index + 1),
        crc32cBase64: crc32c(object.sha256),
        md5Base64: md5(object.sha256),
      },
    ]));
    let operationCount = 0;
    const gcsClient = {
      getObject: async (bucketName: string, targetKey: string) => {
        operationCount += 1;
        const match = sourceByTargetKey.get(targetKey)!;
        const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
          (entry) => entry.sourceBucket === match.object.bucketId,
        )!;
        expect(bucketName).toBe(bucket.targetBucket);
        return {
          name: targetKey,
          bucket: bucketName,
          generation: match.generation,
          size: String(match.object.sizeBytes),
          crc32c: match.crc32cBase64,
          md5Hash: match.md5Base64,
          contentType: match.object.mimeType,
          cacheControl: bucket.targetServingCacheControl,
          metadata: buildExpectedTargetMetadata(match.object, source),
        };
      },
      hashObject: async (_bucketName: string, targetObject: JsonRecord) => {
        const match = sourceByTargetKey.get(String(targetObject.name))!;
        return {
          sizeBytes: match.object.sizeBytes,
          sha256: match.object.sha256,
          crc32cBase64: match.crc32cBase64,
          md5Base64: match.md5Base64,
        };
      },
      listMigrationObjects: async (bucketName: string) => [...sourceByTargetKey.entries()]
        .filter(([, match]) => STORAGE_CUTOVER_CONTRACT.buckets.some((bucket) =>
          bucket.sourceBucket === match.object.bucketId && bucket.targetBucket === bucketName))
        .map(([name, match]) => ({
          name,
          bucket: bucketName,
          generation: match.generation,
          size: String(match.object.sizeBytes),
        })),
    };
    const progress: JsonRecord[] = [];
    const result = await executeActivatedKnownSixCreateOnly({
      activation: SEVEN_BUCKET_ACTIVATION,
      approvalValidation: { valid: true, approvalDigestSha256 },
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
      onProgress: (entry: JsonRecord) => progress.push(entry),
    });
    expect(result).toMatchObject({
      createdCount: 0,
      noopCount: 124,
      deletedCount: 0,
      overwrittenCount: 0,
      sourcePostRun: { objectCount: 124, totalBytes: 111_078_397 },
      targetFinal: { objectCount: 124, totalBytes: 111_078_397 },
    });
    expect(operationCount).toBe(248);
    expect(progress).toHaveLength(124);
    expect(progress.every((entry) => entry.result === 'NOOP_PRESENT_EXACT')).toBe(true);
  });

  it('builds durable 124/124 post-copy source and target generation evidence', async () => {
    const records = makeSourceRecords();
    const source = validateSourceInventory(records);
    const sourceClient = {
      listBuckets: async () => STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({
        id: bucket.sourceBucket,
        public: bucket.sourcePublic,
      })),
      listObjects: async (bucketId: string) => source.objects
        .filter((object) => object.bucketId === bucketId)
        .map((object) => ({
          id: sourceObjectId(object),
          name: object.objectKey,
          objectKey: object.objectKey,
          updated_at: object.sourceUpdatedAt,
          metadata: {
            size: object.sizeBytes,
            mimetype: object.mimeType,
            cacheControl: object.cacheControl,
          },
        })),
      hashObject: async (bucketId: string, objectKey: string) => {
        const object = source.objects.find(
          (candidate) => candidate.bucketId === bucketId && candidate.objectKey === objectKey,
        )!;
        return {
          sizeBytes: object.sizeBytes,
          sha256: object.sha256,
          crc32cBase64: crc32c(object.sha256),
          md5Base64: md5(object.sha256),
        };
      },
    };
    const sourcePostRun = await collectPostRunSourceConfirmation(sourceClient, source);
    const sourceByTargetKey = new Map(source.objects.map((object, index) => [
      buildMigrationTargetObjectKey(
        object.bucketId,
        object.objectKey,
        object.fingerprint,
      ),
      {
        object,
        generation: String(index + 1),
        crc32cBase64: crc32c(object.sha256),
        md5Base64: md5(object.sha256),
      },
    ]));
    const gcsClient = {
      getObject: async (bucketName: string, targetKey: string) => {
        const match = sourceByTargetKey.get(targetKey)!;
        const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
          (entry) => entry.sourceBucket === match.object.bucketId,
        )!;
        expect(bucketName).toBe(bucket.targetBucket);
        return {
          name: targetKey,
          bucket: bucketName,
          generation: match.generation,
          size: String(match.object.sizeBytes),
          crc32c: match.crc32cBase64,
          md5Hash: match.md5Base64,
          contentType: match.object.mimeType,
          cacheControl: bucket.targetServingCacheControl,
          metadata: buildExpectedTargetMetadata(match.object, source),
        };
      },
      hashObject: async (_bucketName: string, targetObject: JsonRecord) => {
        const match = sourceByTargetKey.get(String(targetObject.name))!;
        return {
          sizeBytes: match.object.sizeBytes,
          sha256: match.object.sha256,
          crc32cBase64: match.crc32cBase64,
          md5Base64: match.md5Base64,
        };
      },
      listMigrationObjects: async (bucketName: string) => [...sourceByTargetKey.entries()]
        .filter(([, match]) => {
          const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
            (entry) => entry.sourceBucket === match.object.bucketId,
          )!;
          return bucket.targetBucket === bucketName;
        })
        .map(([targetKey, match]) => {
          return {
            name: targetKey,
            bucket: bucketName,
            generation: match.generation,
            size: String(match.object.sizeBytes),
          };
        }),
    };
    const outcomes = new Map(source.objects.map((object) => [
      sourceObjectId(object),
      'NOOP_PRESENT_EXACT',
    ]));
    const targetFinal = await reconcileFinalTargets(gcsClient, source, outcomes);
    const preflight = makePreflight(records, { presentCount: 124 });
    const retainedHistoricalFinal = await reconcileRetainedHistoricalTargets(gcsClient, preflight);
    const finalMigrationNamespace = await reconcileFinalMigrationNamespace({
      gcsClient,
      source,
      targetFinal,
      retainedHistoricalFinal,
    });
    const plan = buildCreateOnlyCopyPlan(source, preflight);
    const result = {
      createdCount: 0,
      noopCount: 124,
      deletedCount: 0,
      overwrittenCount: 0,
      sourcePostRun,
      targetFinal,
      retainedHistoricalFinal,
      finalMigrationNamespace,
    };
    const evidence = buildCopyResultEvidence({
      source,
      sourceFileDigestSha256: digest('source-file'),
      preflight,
      preflightFileDigestSha256: digest('preflight-file'),
      plan,
      planFileDigestSha256: digest('plan-file'),
      approval: {
        approvalDigestSha256: digest('approval'),
        pullRequestNumber: 1954,
        reviewId: 9001,
      },
      approvalFileDigestSha256: digest('approval-file'),
      result,
      reviewedHead: 'a'.repeat(40),
    });
    expect(evidence).toMatchObject({
      schemaVersion: COPY_RESULT_EVIDENCE_SCHEMA,
      objectCount: 124,
      totalBytes: 111_078_397,
      createdCount: 0,
      noopCount: 124,
      deleteCount: 0,
      overwriteCount: 0,
    });
    expect(evidence.sourcePostRun.objects).toHaveLength(124);
    expect(evidence.targetFinal.objects).toHaveLength(124);
    expect(evidence.databasePointerManifest).toMatchObject({
      schemaVersion: 'hushh-tech-storage-db-pointer-manifest-v1',
      livePointerCount: 124,
      tombstonePointerRemovalCount: 0,
    });
    expect(evidence.databasePointerManifest.pointers).toHaveLength(124);
    expect(evidence.databasePointerManifest.pointerManifestDigestSha256)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.targetFinal.objects.every((object: JsonRecord) =>
      /^[1-9]\d*$/.test(String(object.generation)))).toBe(true);
    expect(evidence.resultEvidenceDigestSha256).toMatch(/^[a-f0-9]{64}$/);

    const tamperedTarget = {
      ...targetFinal,
      objects: targetFinal.objects.map((object, index) => index === 0
        ? { ...object, generation: '0' }
        : object),
    };
    expect(() => buildCopyResultEvidence({
      source,
      sourceFileDigestSha256: digest('source-file'),
      preflight,
      preflightFileDigestSha256: digest('preflight-file'),
      plan,
      planFileDigestSha256: digest('plan-file'),
      approval: {
        approvalDigestSha256: digest('approval'),
        pullRequestNumber: 1954,
        reviewId: 9001,
      },
      approvalFileDigestSha256: digest('approval-file'),
      result: { ...result, targetFinal: tamperedTarget },
      reviewedHead: 'a'.repeat(40),
    })).toThrowError(expect.objectContaining({ code: 'COPY_RESULT_EVIDENCE_INVALID' }));
  });

  it('builds a digest-bound dry run without changing the 563 unrelated objects', async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, 'source.jsonl');
    const preflightPath = join(directory, 'target-preflight.json');
    const planPath = join(directory, 'plan.json');
    const records = makeSourceRecords();
    const preflight = makePreflight(records, { presentCount: 2 });
    writeFileSync(sourcePath, sourceJsonLines(records), { mode: 0o600 });
    writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`, { mode: 0o600 });
    const result = await runStorageCopyExecutor([
      '--source-inventory', sourcePath,
      '--source-file-digest-sha256', exactFileDigestSha256(sourcePath),
      '--target-preflight', preflightPath,
      '--target-preflight-file-digest-sha256', exactFileDigestSha256(preflightPath),
      '--plan-output', planPath,
    ]);
    expect(result).toMatchObject({
      dryRun: true,
      executionAllowed: false,
      actionCount: 124,
      createCount: 122,
      noopCount: 2,
      deleteCount: 0,
      overwriteCount: 0,
      unmanagedObjectCount: 563,
    });
    expect(readFileSync(planPath, 'utf8')).not.toContain('object-001.bin');
    expect((lstatSync(planPath).mode & 0o777)).toBe(0o600);

    const validated = await runStorageCopyExecutor([
      '--source-inventory', sourcePath,
      '--source-file-digest-sha256', exactFileDigestSha256(sourcePath),
      '--target-preflight', preflightPath,
      '--target-preflight-file-digest-sha256', exactFileDigestSha256(preflightPath),
      '--plan', planPath,
      '--plan-file-digest-sha256', exactFileDigestSha256(planPath),
    ]);
    expect(validated).toMatchObject({
      dryRun: true,
      executionAllowed: false,
      reviewedPlanValidated: true,
      deleteCount: 0,
      overwriteCount: 0,
    });
  });

  it('contains no target delete request path in the executor source', () => {
    const source = readFileSync(
      new URL('../scripts/migration/storage-copy-executor.mjs', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/method:\s*["']DELETE["']/);
    expect(source).not.toContain('deleteObject(');
  });
});
