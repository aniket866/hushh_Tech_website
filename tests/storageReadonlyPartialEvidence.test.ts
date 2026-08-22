import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { STORAGE_CUTOVER_CONTRACT } from '../scripts/migration/storage-cutover-contract.mjs';
import {
  calculateSelfBoundDigest,
  canonicalJson,
  sha256,
} from '../scripts/migration/storage-live-common.mjs';
import { COPY_POLICY_CANDIDATE } from '../scripts/migration/storage-live-policy.mjs';
import {
  PARTIAL_EVIDENCE_SCHEMA,
  PARTIAL_NORMALIZATION_ALGORITHMS,
  RAW_PARTIAL_CAPTURE_SCHEMA,
  buildRawPartialRequest,
  buildReadonlyPartialEvidence,
  finalizeRawPartialCapture,
  runReadonlyPartialEvidenceCli,
  validateRawPartialCapture,
  validateReadonlyPartialEvidence,
} from '../scripts/migration/storage-readonly-partial-evidence.mjs';

// Fixture builders intentionally model untrusted JSON before validation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

const temporaryDirectories: string[] = [];
afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const fixtureWindow = {
  startedAt: '2026-08-21T20:00:00.000Z',
  endedAt: '2026-08-21T20:01:00.000Z',
};
const captureId = 'storage-partial-12345678-1234-1234-1234-123456789abc';
const assetsTargetBucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
  (bucket) => bucket.sourceBucket === 'assets',
)!.targetBucket;

const responseBytes = (value: unknown) => Buffer.from(JSON.stringify(value));

const httpRequest = (
  requests: JsonRecord[],
  {
    provider,
    endpointClass,
    scope,
    pageIndex = null,
    requestTarget,
    httpStatus,
    body,
  }: JsonRecord,
) => {
  requests.push(buildRawPartialRequest({
    captureId,
    ordinal: requests.length,
    transport: 'HTTP_JSON',
    provider,
    endpointClass,
    scope,
    pageIndex,
    method: 'GET',
    requestTarget,
    startedAt: fixtureWindow.startedAt,
    endedAt: fixtureWindow.endedAt,
    httpStatus,
    processExitStatus: null,
    responseBytes: responseBytes(body),
  }));
};

const localRequest = (
  requests: JsonRecord[],
  {
    endpointClass,
    scope,
    args,
    body,
    processExitStatus = 0,
  }: JsonRecord,
) => {
  requests.push(buildRawPartialRequest({
    captureId,
    ordinal: requests.length,
    transport: 'LOCAL_GCLOUD_READ',
    provider: 'gcp',
    endpointClass,
    scope,
    method: 'LOCAL_READ',
    requestTarget: canonicalJson({ executable: 'gcloud', args }),
    startedAt: fixtureWindow.startedAt,
    endedAt: fixtureWindow.endedAt,
    httpStatus: null,
    processExitStatus,
    responseBytes: responseBytes(body),
  }));
};

const makeRawCapture = () => {
  const requests: JsonRecord[] = [];
  const unknownBucket = 'private-live-large-bucket';
  httpRequest(requests, {
    provider: 'supabase',
    endpointClass: 'SOURCE_BUCKET_LIST',
    scope: 'PRIMARY_SOURCE_BUCKET_SET',
    requestTarget:
      `https://${STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef}.supabase.co/storage/v1/bucket`,
    httpStatus: 200,
    body: [
      ...STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({
        id: bucket.sourceBucket,
        public: bucket.sourcePublic,
      })),
      { id: unknownBucket, public: false },
    ],
  });

  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const base =
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket.targetBucket)}`;
    httpRequest(requests, {
      provider: 'gcp',
      endpointClass: 'GCS_BUCKET_CONFIGURATION',
      scope: bucket.targetBucket,
      requestTarget: `${base}?projection=full`,
      httpStatus: 200,
      body: {
        name: bucket.targetBucket,
        location: STORAGE_CUTOVER_CONTRACT.targetPolicy.bucketLocation,
        iamConfiguration: {
          uniformBucketLevelAccess: { enabled: true },
          publicAccessPrevention: 'enforced',
        },
        versioning: { enabled: true },
      },
    });
    const iamDenied = bucket.targetBucket === assetsTargetBucket;
    httpRequest(requests, {
      provider: 'gcp',
      endpointClass: 'GCS_BUCKET_IAM',
      scope: bucket.targetBucket,
      requestTarget: `${base}/iam`,
      httpStatus: iamDenied ? 403 : 200,
      body: iamDenied
        ? { error: { code: 403, message: 'permission denied' } }
        : { bindings: structuredClone(bucket.allowedIamBindings) },
    });
    const objects = bucket.targetBucket === 'hushh-tech-community-content-uat'
      ? [{ name: 'private-unmanaged-object', generation: '17', size: '25' }]
      : [];
    httpRequest(requests, {
      provider: 'gcp',
      endpointClass: 'GCS_OBJECT_LIST',
      scope: bucket.targetBucket,
      pageIndex: 0,
      requestTarget: `${base}/o?maxResults=1000&projection=full`,
      httpStatus: 200,
      body: objects.length === 0 ? {} : { items: objects },
    });
  }

  localRequest(requests, {
    endpointClass: 'GCP_PROJECT_IAM',
    scope: 'projects/hushh-tech-uat',
    args: ['projects', 'get-iam-policy', 'hushh-tech-uat', '--format=json'],
    body: {
      bindings: [{
        role: 'roles/editor',
        members: ['group:gcp-admins@hushh.ai'],
      }],
    },
  });
  localRequest(requests, {
    endpointClass: 'GCP_ANCESTORS',
    scope: 'projects/hushh-tech-uat',
    args: ['projects', 'get-ancestors', 'hushh-tech-uat', '--format=json'],
    body: [],
  });

  return finalizeRawPartialCapture({
    schemaVersion: RAW_PARTIAL_CAPTURE_SCHEMA,
    captureId,
    windowStartedAt: fixtureWindow.startedAt,
    windowEndedAt: fixtureWindow.endedAt,
    collectorRevision: 'a'.repeat(40),
    environment: 'uat',
    project: 'hushh-tech-uat',
    region: 'us-central1',
    contractFileDigestSha256:
      // The production builder validates this against the checked-in contract.
      // Build once through a valid fixture below, then retain the exact value.
      null,
    copyPolicyCandidateFileDigestSha256: null,
    requests,
    rawCaptureDigestSha256: null,
  } as JsonRecord);
};

const bindCheckedInDigests = async (raw: JsonRecord) => {
  const common = await import('../scripts/migration/storage-live-common.mjs');
  const policy = await import('../scripts/migration/storage-live-policy.mjs');
  raw.contractFileDigestSha256 = common.contractFileDigestSha256();
  raw.copyPolicyCandidateFileDigestSha256 = policy.copyPolicyCandidateFileDigestSha256();
  return finalizeRawPartialCapture(raw);
};

const rawBytes = (raw: JsonRecord) =>
  Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);

const makeBoundFixture = async () => {
  const raw = await bindCheckedInDigests(makeRawCapture());
  const rawFileDigestSha256 = sha256(rawBytes(raw));
  const evidence = buildReadonlyPartialEvidence({
    rawCapture: raw,
    rawCaptureFileDigestSha256: rawFileDigestSha256,
  });
  return { raw, rawFileDigestSha256, evidence };
};

const rebuildRequest = (request: JsonRecord, overrides: JsonRecord = {}) => {
  const merged = { ...request, ...overrides };
  const bytes = overrides.rawResponseBase64 !== undefined
    ? Buffer.from(overrides.rawResponseBase64, 'base64')
    : Buffer.from(request.rawResponseBase64, 'base64');
  return buildRawPartialRequest({
    captureId: merged.captureId,
    ordinal: merged.ordinal,
    transport: merged.transport,
    provider: merged.provider,
    endpointClass: merged.endpointClass,
    scope: merged.scope,
    pageIndex: merged.pageIndex,
    method: merged.method,
    requestTarget: merged.requestTarget,
    startedAt: merged.startedAt,
    endedAt: merged.endedAt,
    httpStatus: merged.httpStatus,
    processExitStatus: merged.processExitStatus,
    responseBytes: bytes,
  });
};

const rebuildResponse = (request: JsonRecord, body: unknown) =>
  rebuildRequest(request, {
    rawResponseBase64: responseBytes(body).toString('base64'),
  });

const expectValidationCode = (operation: () => unknown, code: string) => {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
};

describe('read-only partial storage evidence', () => {
  it('recomputes exact evidence from raw provider responses and stays non-executable', async () => {
    const fixture = await makeBoundFixture();
    expect(validateRawPartialCapture(fixture.raw)).toBe(fixture.raw);
    expect(validateReadonlyPartialEvidence({
      rawCapture: fixture.raw,
      rawCaptureFileDigestSha256: fixture.rawFileDigestSha256,
      evidence: fixture.evidence,
    })).toMatchObject({ valid: true, safeForCopy: false });
    expect(fixture.evidence.schemaVersion).toBe(PARTIAL_EVIDENCE_SCHEMA);
    expect(fixture.evidence.safeForCopy).toBe(false);
    expect(fixture.evidence.providerMutationAllowed).toBe(false);
    expect(COPY_POLICY_CANDIDATE.executionActivated).toBe(false);
    expect(COPY_POLICY_CANDIDATE.copyExecutionAllowed).toBe(false);
  });

  it('binds the exact normalization algorithms', async () => {
    const {
      raw,
      rawFileDigestSha256: rawCaptureFileDigestSha256,
      evidence,
    } = await makeBoundFixture();
    expect(evidence.normalizationAlgorithms).toEqual(PARTIAL_NORMALIZATION_ALGORITHMS);
    const changed = structuredClone(evidence);
    changed.normalizationAlgorithms.targetBucketIam = 'trust provider summary';
    changed.evidenceDigestSha256 = calculateSelfBoundDigest(changed, 'evidenceDigestSha256');
    expect(() => validateReadonlyPartialEvidence({
      rawCapture: raw,
      rawCaptureFileDigestSha256,
      evidence: changed,
    })).toThrowError();
  });

  it('records the assets IAM 403 as a request receipt and blocker', async () => {
    const { evidence } = await makeBoundFixture();
    const target = evidence.targets.find(
      (entry: JsonRecord) => entry.bucketName === assetsTargetBucket,
    );
    expect(target).toMatchObject({ iamHttpStatus: 403, iamRead: false });
    expect(evidence.requests).toContainEqual(expect.objectContaining({
      endpointClass: 'GCS_BUCKET_IAM',
      httpStatus: 403,
    }));
    expect(evidence.blockers).toContain('TARGET_BUCKET_IAM_READ_INCOMPLETE');
  });

  it('binds one capture ID and exact request window to every receipt', async () => {
    const { raw, evidence } = await makeBoundFixture();
    expect(new Set(evidence.requests.map((request: JsonRecord) => request.captureId))).toEqual(
      new Set([captureId]),
    );
    const changed = structuredClone(raw);
    changed.requests[1].captureId = 'storage-partial-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    changed.rawCaptureDigestSha256 = calculateSelfBoundDigest(
      changed,
      'rawCaptureDigestSha256',
    );
    expect(() => validateRawPartialCapture(changed)).toThrowError();
  });

  it('rejects a request timestamp outside the same capture window', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    changed.requests[0] = rebuildRequest(changed.requests[0], {
      startedAt: '2026-08-21T19:59:59.999Z',
    });
    changed.rawCaptureDigestSha256 = calculateSelfBoundDigest(
      changed,
      'rawCaptureDigestSha256',
    );
    expect(() => validateRawPartialCapture(changed)).toThrowError();
  });

  it('rejects a raw response mutation without a matching receipt digest', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    changed.requests[0].rawResponseBase64 = Buffer.from('[]').toString('base64');
    changed.rawCaptureDigestSha256 = calculateSelfBoundDigest(
      changed,
      'rawCaptureDigestSha256',
    );
    expect(() => validateRawPartialCapture(changed)).toThrowError();
  });

  it('rejects stale evidence after a fully re-digested provider response change', async () => {
    const {
      raw,
      rawFileDigestSha256: rawCaptureFileDigestSha256,
      evidence,
    } = await makeBoundFixture();
    const changed = structuredClone(raw);
    const sourceBody = JSON.parse(
      Buffer.from(changed.requests[0].rawResponseBase64, 'base64').toString('utf8'),
    );
    sourceBody[0].public = !sourceBody[0].public;
    changed.requests[0] = rebuildRequest(changed.requests[0], {
      rawResponseBase64: responseBytes(sourceBody).toString('base64'),
    });
    const rebound = finalizeRawPartialCapture(changed);
    expect(() => validateReadonlyPartialEvidence({
      rawCapture: rebound,
      rawCaptureFileDigestSha256,
      evidence,
    })).toThrowError();
  });

  it('rejects mutation methods even when every receipt digest is recomputed', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    changed.requests[0] = rebuildRequest(changed.requests[0], { method: 'DELETE' });
    const rebound = finalizeRawPartialCapture(changed);
    expect(() => validateRawPartialCapture(rebound)).toThrowError();
  });

  it('rejects a target endpoint escape to production after full re-digest', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    changed.requests[1] = rebuildRequest(changed.requests[1], {
      requestTarget:
        'https://storage.googleapis.com/storage/v1/b/hushh-tech-assets-legal-prod?projection=full',
    });
    const rebound = finalizeRawPartialCapture(changed);
    expect(() => validateRawPartialCapture(rebound)).toThrowError();
  });

  it.each([
    ['embedded username and password', (url: URL) => {
      url.username = 'reader';
      url.password = 'credential';
    }],
    ['fragment', (url: URL) => {
      url.hash = 'ignored-fragment';
    }],
    ['non-default port', (url: URL) => {
      url.port = '444';
    }],
  ])('rejects a source URL with %s after full re-digest', async (_label, mutate) => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    const url = new URL(changed.requests[0].requestTarget);
    mutate(url);
    changed.requests[0] = rebuildRequest(changed.requests[0], {
      requestTarget: url.toString(),
    });
    const rebound = finalizeRawPartialCapture(changed);
    expectValidationCode(
      () => validateRawPartialCapture(rebound),
      'PARTIAL_REQUEST_TARGET_INVALID',
    );
  });

  it('rejects a filtered object listing after full re-digest', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    const objectListIndex = changed.requests.findIndex(
      (request: JsonRecord) => request.endpointClass === 'GCS_OBJECT_LIST',
    );
    changed.requests[objectListIndex] = rebuildRequest(
      changed.requests[objectListIndex],
      {
        requestTarget:
          `${changed.requests[objectListIndex].requestTarget}&prefix=_hushh_migrations`,
      },
    );
    const rebound = finalizeRawPartialCapture(changed);
    expect(() => validateRawPartialCapture(rebound)).toThrowError();
  });

  it('rejects a local secret read disguised as IAM evidence', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    const projectIamIndex = changed.requests.findIndex(
      (request: JsonRecord) => request.endpointClass === 'GCP_PROJECT_IAM',
    );
    changed.requests[projectIamIndex] = rebuildRequest(
      changed.requests[projectIamIndex],
      {
        requestTarget: canonicalJson({
          executable: 'gcloud',
          args: ['secrets', 'versions', 'access', 'latest', '--secret=example'],
        }),
      },
    );
    const rebound = finalizeRawPartialCapture(changed);
    expect(() => validateRawPartialCapture(rebound)).toThrowError();
  });

  it('requires one role description for every observed custom role', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    const projectIamIndex = changed.requests.findIndex(
      (request: JsonRecord) => request.endpointClass === 'GCP_PROJECT_IAM',
    );
    const customRole = 'projects/hushh-tech-uat/roles/storageObserver';
    changed.requests[projectIamIndex] = rebuildResponse(
      changed.requests[projectIamIndex],
      {
        bindings: [{
          role: customRole,
          members: ['group:gcp-admins@hushh.ai'],
        }],
      },
    );
    const rebound = finalizeRawPartialCapture(changed);
    expectValidationCode(
      () => validateRawPartialCapture(rebound),
      'RAW_PARTIAL_IAM_ROLE_RECEIPT_SET_INVALID',
    );
  });

  it('rejects an unreferenced role-description read', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    localRequest(changed.requests, {
      endpointClass: 'GCP_ROLE_DESCRIPTION',
      scope: 'projects/hushh-tech-uat/roles/unreferencedRole',
      args: [
        'iam',
        'roles',
        'describe',
        'unreferencedRole',
        '--project=hushh-tech-uat',
        '--format=json',
      ],
      body: { includedPermissions: [] },
    });
    const rebound = finalizeRawPartialCapture(changed);
    expectValidationCode(
      () => validateRawPartialCapture(rebound),
      'RAW_PARTIAL_IAM_ROLE_RECEIPT_SET_INVALID',
    );
  });

  it('rejects duplicate role receipts before last-wins can hide storage.objects.get', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    const projectIamIndex = changed.requests.findIndex(
      (request: JsonRecord) => request.endpointClass === 'GCP_PROJECT_IAM',
    );
    const customRole = 'projects/hushh-tech-uat/roles/storageObserver';
    changed.requests[projectIamIndex] = rebuildResponse(
      changed.requests[projectIamIndex],
      {
        bindings: [{
          role: customRole,
          members: ['group:gcp-admins@hushh.ai'],
        }],
      },
    );
    const args = [
      'iam',
      'roles',
      'describe',
      'storageObserver',
      '--project=hushh-tech-uat',
      '--format=json',
    ];
    localRequest(changed.requests, {
      endpointClass: 'GCP_ROLE_DESCRIPTION',
      scope: customRole,
      args,
      body: { includedPermissions: ['storage.objects.get'] },
    });
    localRequest(changed.requests, {
      endpointClass: 'GCP_ROLE_DESCRIPTION',
      scope: customRole,
      args,
      body: { includedPermissions: ['logging.logEntries.list'] },
    });
    const rebound = finalizeRawPartialCapture(changed);
    expectValidationCode(
      () => validateRawPartialCapture(rebound),
      'RAW_PARTIAL_IAM_ROLE_RECEIPT_SET_INVALID',
    );
  });

  it('rejects a folder IAM read not named by the ancestor response', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    localRequest(changed.requests, {
      endpointClass: 'GCP_FOLDER_IAM',
      scope: 'folders/123456789',
      args: [
        'resource-manager',
        'folders',
        'get-iam-policy',
        '123456789',
        '--format=json',
      ],
      body: { bindings: [] },
    });
    const rebound = finalizeRawPartialCapture(changed);
    expectValidationCode(
      () => validateRawPartialCapture(rebound),
      'RAW_PARTIAL_IAM_ANCESTOR_RECEIPT_SET_INVALID',
    );
  });

  it('rejects an organization IAM read not named by the ancestor response', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    localRequest(changed.requests, {
      endpointClass: 'GCP_ORGANIZATION_IAM',
      scope: 'organizations/987654321',
      args: [
        'organizations',
        'get-iam-policy',
        '987654321',
        '--format=json',
      ],
      body: { bindings: [] },
    });
    const rebound = finalizeRawPartialCapture(changed);
    expectValidationCode(
      () => validateRawPartialCapture(rebound),
      'RAW_PARTIAL_IAM_ANCESTOR_RECEIPT_SET_INVALID',
    );
  });

  it('rejects a missing IAM read for a named organization ancestor', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    const ancestorIndex = changed.requests.findIndex(
      (request: JsonRecord) => request.endpointClass === 'GCP_ANCESTORS',
    );
    changed.requests[ancestorIndex] = rebuildResponse(
      changed.requests[ancestorIndex],
      [{ type: 'organization', id: '987654321' }],
    );
    const rebound = finalizeRawPartialCapture(changed);
    expectValidationCode(
      () => validateRawPartialCapture(rebound),
      'RAW_PARTIAL_IAM_ANCESTOR_RECEIPT_SET_INVALID',
    );
  });

  it('accepts exactly one IAM read for each named ancestor', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    const ancestorIndex = changed.requests.findIndex(
      (request: JsonRecord) => request.endpointClass === 'GCP_ANCESTORS',
    );
    changed.requests[ancestorIndex] = rebuildResponse(
      changed.requests[ancestorIndex],
      [{ type: 'folder', id: '123456789' }],
    );
    localRequest(changed.requests, {
      endpointClass: 'GCP_FOLDER_IAM',
      scope: 'folders/123456789',
      args: [
        'resource-manager',
        'folders',
        'get-iam-policy',
        '123456789',
        '--format=json',
      ],
      body: { bindings: [] },
    });
    const rebound = finalizeRawPartialCapture(changed);
    expect(validateRawPartialCapture(rebound)).toBe(rebound);
  });

  it('surfaces storage permission from one exact custom-role receipt', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    const projectIamIndex = changed.requests.findIndex(
      (request: JsonRecord) => request.endpointClass === 'GCP_PROJECT_IAM',
    );
    const customRole = 'projects/hushh-tech-uat/roles/storageObserver';
    changed.requests[projectIamIndex] = rebuildResponse(
      changed.requests[projectIamIndex],
      {
        bindings: [{
          role: customRole,
          members: ['group:gcp-admins@hushh.ai'],
        }],
      },
    );
    localRequest(changed.requests, {
      endpointClass: 'GCP_ROLE_DESCRIPTION',
      scope: customRole,
      args: [
        'iam',
        'roles',
        'describe',
        'storageObserver',
        '--project=hushh-tech-uat',
        '--format=json',
      ],
      body: { includedPermissions: ['storage.objects.get'] },
    });
    const rebound = finalizeRawPartialCapture(changed);
    const rawCaptureFileDigestSha256 = sha256(rawBytes(rebound));
    const evidence = buildReadonlyPartialEvidence({
      rawCapture: rebound,
      rawCaptureFileDigestSha256,
    });
    expect(evidence.targets.every(
      (target: JsonRecord) => target.inheritedStorageIamBindingCount === 1,
    )).toBe(true);
    expect(evidence.blockers).toContain('TARGET_IAM_NOT_FROZEN_ALLOWLIST');
  });

  it('requires an exact singleton and page request set', async () => {
    const { raw } = await makeBoundFixture();
    const changed = structuredClone(raw);
    changed.requests.splice(2, 1);
    changed.requests = changed.requests.map((request: JsonRecord, index: number) =>
      rebuildRequest({ ...request, ordinal: index }));
    const rebound = finalizeRawPartialCapture(changed);
    expect(() => validateRawPartialCapture(rebound)).toThrowError();
  });

  it('hashes unknown source bucket IDs and target object names out of sanitized evidence', async () => {
    const { evidence } = await makeBoundFixture();
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('private-live-large-bucket');
    expect(serialized).not.toContain('private-unmanaged-object');
    expect(evidence.source.unknownBucketCount).toBe(1);
    expect(evidence.source.unknownBucketIdDigests).toEqual([
      sha256('private-live-large-bucket'),
    ]);
  });

  it('hashes IAM members while retaining exact frozen-allowlist comparison', async () => {
    const { evidence } = await makeBoundFixture();
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('group:gcp-admins@hushh.ai');
    expect(serialized).not.toContain('serviceAccount:hushh-tech-');
    expect(evidence.targets.filter((target: JsonRecord) => target.iamRead)).toHaveLength(5);
    expect(evidence.targets.filter(
      (target: JsonRecord) => target.bucketMatchesFrozenAllowlist,
    )).toHaveLength(5);
    expect(evidence.targets.every(
      (target: JsonRecord) => target.effectiveMatchesFrozenAllowlist !== true,
    )).toBe(true);
    expect(evidence.blockers).toContain('TARGET_IAM_NOT_FROZEN_ALLOWLIST');
  });

  it('records raw-response digests, method, endpoint class, status, and time per request', async () => {
    const { raw, evidence } = await makeBoundFixture();
    expect(evidence.requestCount).toBe(raw.requests.length);
    for (const request of evidence.requests) {
      expect(request.rawResponseDigestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(request.requestTargetSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(request.startedAt).toBe(fixtureWindow.startedAt);
      expect(request.endedAt).toBe(fixtureWindow.endedAt);
      expect(['GET', 'LOCAL_READ']).toContain(request.method);
      expect(typeof request.endpointClass).toBe('string');
      if (request.method === 'GET') expect(request.httpStatus).toBeTypeOf('number');
    }
  });

  it('does not allow a partial capture to prove signing or source-bound parity', async () => {
    const { evidence } = await makeBoundFixture();
    expect(evidence.blockers).toEqual(expect.arrayContaining([
      'TARGET_SIGNING_EVIDENCE_NOT_CAPTURED',
      'SOURCE_BOUND_CANONICAL_PREFLIGHT_NOT_RUN',
      'COPY_POLICY_NOT_ACTIVATED',
      'COPY_EXECUTION_NOT_ALLOWED',
    ]));
    expect(evidence.safeForCopy).toBe(false);
  });

  it('defaults the live partial collector to no-network dry run', async () => {
    let touched = false;
    const dependencies = new Proxy({}, {
      get() {
        touched = true;
        throw new Error('must not touch dependencies');
      },
    });
    await expect(runReadonlyPartialEvidenceCli([], dependencies)).resolves.toEqual({
      ok: true,
      mode: 'capture',
      dryRun: true,
      readOnlyLiveExecuted: false,
      executionAllowed: false,
    });
    expect(touched).toBe(false);
  });

  it('validates exact private artifacts and rejects a mismatched file digest', async () => {
    const { raw, rawFileDigestSha256, evidence } = await makeBoundFixture();
    const directory = mkdtempSync(
      join(realpathSync(tmpdir()), 'hushh-storage-partial-test-'),
    );
    temporaryDirectories.push(directory);
    const rawPath = join(directory, 'raw.json');
    const evidencePath = join(directory, 'evidence.json');
    const rawPayload = rawBytes(raw);
    const evidencePayload = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    writeFileSync(rawPath, rawPayload, { mode: 0o600 });
    writeFileSync(evidencePath, evidencePayload, { mode: 0o600 });
    await expect(runReadonlyPartialEvidenceCli([
      '--mode', 'validate',
      '--raw-capture', rawPath,
      '--raw-capture-file-digest-sha256', rawFileDigestSha256,
      '--evidence', evidencePath,
      '--evidence-file-digest-sha256', sha256(evidencePayload),
    ])).resolves.toMatchObject({ ok: true, valid: true, safeForCopy: false });
    await expect(runReadonlyPartialEvidenceCli([
      '--mode', 'validate',
      '--raw-capture', rawPath,
      '--raw-capture-file-digest-sha256', 'f'.repeat(64),
      '--evidence', evidencePath,
      '--evidence-file-digest-sha256', sha256(readFileSync(evidencePath)),
    ])).rejects.toMatchObject({ code: 'PARTIAL_EVIDENCE_FILE_DIGEST_MISMATCH' });
  });
});
