import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { STORAGE_CUTOVER_CONTRACT } from "../scripts/migration/storage-cutover-contract.mjs";
import { sourceObjectId } from "../scripts/migration/storage-live-inventory.mjs";
import { buildMigrationTargetObjectKey } from "../scripts/migration/storage-live-policy.mjs";
import {
  COMBINED_CHANGE_MANIFEST_SCHEMA,
  SEVEN_BUCKET_APPROVAL_SCHEMA,
  SEVEN_BUCKET_ACTIVATION,
  SEVEN_BUCKET_CONTRACT,
  ZERO_GRANT_POLICY_EVIDENCE_SCHEMA,
  seventhSourceFingerprint,
  seventhSourceObjectId,
} from "../scripts/migration/storage-seven-bucket-contract.mjs";
import {
  buildCombinedSevenBucketPlan,
  executeCombinedSixPlusOne,
} from "../scripts/migration/storage-seven-bucket-orchestrator.mjs";
import {
  __testing,
  executeSevenBucketWithDetachedApproval,
  validateDetachedSevenBucketExecution,
} from "../scripts/migration/storage-seven-bucket-execution-entrypoint.mjs";
import {
  calculateSelfBoundDigest,
  canonicalJson,
  sha256,
} from "../scripts/migration/storage-live-common.mjs";

const createPolicyEvidence = () => {
  const evidence = {
    schemaVersion: ZERO_GRANT_POLICY_EVIDENCE_SCHEMA,
    capturedAt: "2026-08-22T01:00:00.000Z",
    project: "hushh-tech-uat",
    operatorPrincipal:
      "serviceAccount:claude-code-gcp-operator@hussh-developer-platform.iam.gserviceaccount.com",
    migrationServiceAccount:
      "hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com",
    projectPolicyFileDigestSha256: "a".repeat(64),
    projectPolicyCanonicalDigestSha256: "b".repeat(64),
    migrationServiceAccountPolicyFileDigestSha256: "c".repeat(64),
    migrationServiceAccountPolicyCanonicalDigestSha256: "d".repeat(64),
    operatorStorageAdminBindingCount: 0,
    migrationTokenCreatorBindingCount: 0,
    evidenceDigestSha256: null as string | null,
  };
  evidence.evidenceDigestSha256 = calculateSelfBoundDigest(evidence, "evidenceDigestSha256");
  return evidence as typeof evidence & { evidenceDigestSha256: string };
};

const createKnownSource = () => ({
  bucketCount: 6,
  objectCount: 124,
  totalBytes: 111_078_397,
  digestSha256: "1".repeat(64),
  sourceArtifactDigestSha256: "2".repeat(64),
  buckets: STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({ bucketId: bucket.sourceBucket })),
  objects: Array.from({ length: 124 }, (_, index) => ({
    bucketId: STORAGE_CUTOVER_CONTRACT.buckets[index % 6].sourceBucket,
    objectKey: `fixture/${index}`,
    sizeBytes: index === 0 ? 111_078_274 : 1,
    mimeType: "application/octet-stream",
    sourceUpdatedAt: "2026-08-22T00:00:00.000Z",
    cacheControl: null,
    sha256: sha256(`known-${index}`),
    fingerprint: sha256(`known-fingerprint-${index}`),
  })),
});

const createSeventhSource = () => {
  const objects = Array.from({ length: 16 }, (_, index) => ({
    bucketId: "private-fixture-only",
    objectKey: `private/${index}`,
    sizeBytes: index < 10 ? 91_471_436 : 91_471_435,
    mimeType: "application/octet-stream",
    sourceUpdatedAt: "2026-08-22T00:00:00.000Z",
    cacheControl: "private",
    sha256: sha256(`seventh-${index}`),
    md5Base64: Buffer.alloc(16, index).toString("base64"),
    crc32cBase64: Buffer.alloc(4, index).toString("base64"),
  }));
  const safeObjects = objects.map((object) => ({
    objectId: seventhSourceObjectId(object),
    sourceFingerprintSha256: seventhSourceFingerprint(object),
    sizeBytes: object.sizeBytes,
    sha256: object.sha256,
    md5Base64: object.md5Base64,
    crc32cBase64: object.crc32cBase64,
  }));
  return {
    rawBucketId: "private-fixture-only",
    bucketIdSha256: SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256,
    public: true,
    objectCount: 16,
    totalBytes: 1_463_542_970,
    metadataDigestSha256: "3".repeat(64),
    contentSetDigestSha256: sha256(canonicalJson(safeObjects)),
    sourceArtifactDigestSha256: "4".repeat(64),
    sourceFileDigestSha256: "5".repeat(64),
    objects,
    safeObjects,
  };
};

const createFixture = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const reviewerPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const reviewerIdentity = "independent-lane-7-reviewer";
  const trustAnchor = {
    schemaVersion: "hushh-tech-storage-lane-7-reviewer-trust-anchor-v1",
    provisioned: true,
    reviewerIdentity,
    reviewerPublicKeySha256: sha256(reviewerPublicKeyPem),
  };
  const knownSource = createKnownSource();
  const seventhSource = createSeventhSource();
  const policy = createPolicyEvidence();
  const knownSixPlan = {
    environment: "uat",
    project: "hushh-tech-uat",
    liveObjectCount: 124,
    expectedBytes: 111_078_397,
    actionCount: 124,
    tombstoneCount: 0,
    deleteCount: 0,
    overwriteCount: 0,
    sourceInventoryDigestSha256: knownSource.digestSha256,
    sourceArtifactDigestSha256: knownSource.sourceArtifactDigestSha256,
    actions: knownSource.objects.map((object, index) => ({
      action: "CREATE_IF_ABSENT",
      objectId: sourceObjectId(object),
      sourceFingerprintSha256: object.fingerprint,
      targetBucket: STORAGE_CUTOVER_CONTRACT.buckets[index % 6].targetBucket,
      targetObjectKeyDigestSha256: sha256(buildMigrationTargetObjectKey(
        object.bucketId,
        object.objectKey,
        object.fingerprint,
      )),
      expectedBytes: object.sizeBytes,
      expectedSha256: object.sha256,
    })),
    planDigestSha256: "6".repeat(64),
  };
  const manifest = {
    schemaVersion: COMBINED_CHANGE_MANIFEST_SCHEMA,
    environment: "uat",
    project: "hushh-tech-uat",
    baseCommitSha: "1".repeat(40),
    reviewedCommitSha: "2".repeat(40),
    changedPathCount: 2,
    changedPaths: [
      { path: "migration/storage/activation.json", sha256: "7".repeat(64) },
      { path: "scripts/migration/entrypoint.mjs", sha256: "8".repeat(64) },
    ],
    manifestDigestSha256: null as string | null,
  };
  manifest.manifestDigestSha256 = calculateSelfBoundDigest(manifest, "manifestDigestSha256");
  const rawChangeManifest = Buffer.from(JSON.stringify(manifest));
  const knownSixPreflight = {
    schemaVersion: "gcs-storage-copy-preflight-v1",
    collectedAt: "2026-08-22T01:29:00.000Z",
    project: "hushh-tech-uat",
    region: "us-central1",
    bucketCount: 6,
    buckets: STORAGE_CUTOVER_CONTRACT.buckets.map(() => ({
      bucketConfigurationSafe: true,
      iamMatchesFrozenAllowlist: true,
      isolationSafe: true,
      inheritedAccessNeutralized: true,
    })),
    migrationWriterRoleExact: true,
    unmanagedObjectCount: 0,
    retainedHistoricalObjectCount: 0,
    preflightDigestSha256: null as string | null,
  };
  knownSixPreflight.preflightDigestSha256 = calculateSelfBoundDigest(
    knownSixPreflight,
    "preflightDigestSha256",
  );
  const seventhPreflight = {
    schemaVersion: "gcs-storage-quarantine-preflight-v2",
    capturedAt: "2026-08-22T01:29:00.000Z",
    project: "hushh-tech-uat",
    bucket: "hushh-tech-supabase-quarantine-uat",
    namespace: "_hushh_migrations/test",
    sourceFileDigestSha256: seventhSource.sourceFileDigestSha256,
    sourceArtifactDigestSha256: seventhSource.sourceArtifactDigestSha256,
    sourceContentSetDigestSha256: seventhSource.contentSetDigestSha256,
    sourceObjectCount: 16,
    sourceTotalBytes: 1_463_542_970,
    configurationDigestSha256: "7".repeat(64),
    iamDigestSha256: "8".repeat(64),
    tagBindingsDigestSha256: "9".repeat(64),
    denyPolicyDigestSha256: "a".repeat(64),
    runtimeReferenceDigestSha256: "b".repeat(64),
    namespaceObjectSetDigestSha256: "c".repeat(64),
    runtimeRoutingReferenceCount: 0,
    namespaceObjectCount: 0,
    namespaceTotalBytes: 0,
    configurationSafe: true,
    bucketIamExact: true,
    tagIsolationBound: true,
    denyPolicyActive: true,
    createOnly: true,
    ifGenerationMatch: 0,
    overwriteAllowed: false,
    deleteAllowed: false,
    safeForCopy: true,
    preflightDigestSha256: null as string | null,
  };
  seventhPreflight.preflightDigestSha256 = calculateSelfBoundDigest(
    seventhPreflight,
    "preflightDigestSha256",
  );
  const freshAllSevenTargetPreflight = {
    schemaVersion: "hushh-tech-storage-all-seven-target-preflight-v2",
    capturedAt: "2026-08-22T01:29:00.000Z",
    project: "hushh-tech-uat",
    region: "us-central1",
    knownSixPreflight,
    seventhPreflight,
    preflightDigestSha256: null as string | null,
  };
  freshAllSevenTargetPreflight.preflightDigestSha256 = calculateSelfBoundDigest(
    freshAllSevenTargetPreflight,
    "preflightDigestSha256",
  );
  const rawFreshAllSevenTargetPreflight = Buffer.from(JSON.stringify(freshAllSevenTargetPreflight));
  const planInputs = {
    knownSource,
    knownSourceFileDigestSha256: "9".repeat(64),
    seventhSource,
    knownSixPlan,
    knownSixPreflight,
    knownSixPlanFileDigestSha256: "a".repeat(64),
    knownSixPreflightFileDigestSha256: "b".repeat(64),
    knownSixPreflightDigestSha256: knownSixPreflight.preflightDigestSha256,
    seventhPreflightFileDigestSha256: "d".repeat(64),
    seventhPreflightDigestSha256: seventhPreflight.preflightDigestSha256,
    allSevenTargetPreflightFileDigestSha256: sha256(rawFreshAllSevenTargetPreflight),
    seventhPreflightSafe: true,
    seventhNamespaceObjectCount: 0,
    zeroGrantPolicyEvidence: policy,
  };
  const plan = buildCombinedSevenBucketPlan({
    activation: SEVEN_BUCKET_ACTIVATION,
    changeManifest: manifest,
    changeManifestFileDigestSha256: sha256(rawChangeManifest),
    ...planInputs,
    reviewedCommitSha: manifest.reviewedCommitSha,
  });
  const rawCombinedPlan = Buffer.from(JSON.stringify(plan));
  const approval = {
    schemaVersion: SEVEN_BUCKET_APPROVAL_SCHEMA,
    decision: "APPROVED_FOR_CREATE_ONLY_UAT_SEVEN_BUCKET_COPY",
    environment: "uat",
    project: "hushh-tech-uat",
    reviewerLane: "LANE_7",
    reviewerIdentity,
    authorIdentity: "lane-4-author",
    approvedAt: "2026-08-22T01:00:00.000Z",
    expiresAt: "2026-08-22T03:00:00.000Z",
    reviewedCommitSha: plan.reviewedCommitSha,
    activationFileDigestSha256: plan.activationFileDigestSha256,
    activationDigestSha256: plan.activationDigestSha256,
    isolatedCutoverContractFileDigestSha256: plan.isolatedCutoverContractFileDigestSha256,
    contractState: plan.contractState,
    executionActivated: plan.executionActivated,
    changeManifestFileDigestSha256: plan.changeManifestFileDigestSha256,
    changeManifestDigestSha256: plan.changeManifestDigestSha256,
    planFileDigestSha256: sha256(rawCombinedPlan),
    planDigestSha256: plan.planDigestSha256,
    combinedSourceDigestSha256: plan.combinedSourceDigestSha256,
    knownSixPlanDigestSha256: plan.knownSixPlanDigestSha256,
    knownSixPreflightDigestSha256: plan.knownSixPreflightDigestSha256,
    seventhPreflightDigestSha256: plan.seventhPreflightDigestSha256,
    zeroGrantPolicyEvidenceDigestSha256: policy.evidenceDigestSha256,
    signatureAlgorithm: "ED25519",
    reviewerPublicKeySha256: trustAnchor.reviewerPublicKeySha256,
    signatureBase64: null as string | null,
    approvalDigestSha256: null as string | null,
  };
  const signedPayload = Buffer.from(canonicalJson({
    ...approval,
    signatureBase64: null,
    approvalDigestSha256: null,
  }));
  approval.signatureBase64 = sign(null, signedPayload, privateKey).toString("base64");
  approval.approvalDigestSha256 = calculateSelfBoundDigest(approval, "approvalDigestSha256");
  const createReadOnlyDependencies = vi.fn();
  const createWriteClients = vi.fn();
  const request = {
    rawDetachedApproval: Buffer.from(JSON.stringify(approval)),
    rawChangeManifest,
    rawCombinedPlan,
    rawFreshAllSevenTargetPreflight,
    reviewerPublicKeyPem,
    planInputs,
    createReadOnlyDependencies,
    createWriteClients,
  };
  return {
    approval,
    freshAllSevenTargetPreflight,
    plan,
    policy,
    request,
    trustAnchor,
  };
};

const refreshTargetProof = (
  fixture: ReturnType<typeof createFixture>,
  capturedAt: string,
) => {
  const live = structuredClone(fixture.freshAllSevenTargetPreflight);
  live.capturedAt = capturedAt;
  live.knownSixPreflight.collectedAt = capturedAt;
  live.knownSixPreflight.preflightDigestSha256 = calculateSelfBoundDigest(
    live.knownSixPreflight,
    "preflightDigestSha256",
  );
  live.seventhPreflight.capturedAt = capturedAt;
  live.seventhPreflight.preflightDigestSha256 = calculateSelfBoundDigest(
    live.seventhPreflight,
    "preflightDigestSha256",
  );
  live.preflightDigestSha256 = calculateSelfBoundDigest(live, "preflightDigestSha256");
  return live;
};

describe("seven-bucket detached approval execution entrypoint", () => {
  it("independently validates the anchored signature, expiry, manifest, and recomputed plan", () => {
    const fixture = createFixture();
    const prepared = validateDetachedSevenBucketExecution({
      request: fixture.request,
      trustAnchor: fixture.trustAnchor,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    });
    expect(prepared.approvalValidation).toEqual({
      valid: true,
      approvalDigestSha256: fixture.approval.approvalDigestSha256,
    });
    expect(prepared.plan).toEqual(fixture.plan);
    expect(fixture.request.createReadOnlyDependencies).not.toHaveBeenCalled();
    expect(fixture.request.createWriteClients).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied approvalValidation before the production trust boundary", async () => {
    const fixture = createFixture();
    await expect(executeSevenBucketWithDetachedApproval({
      ...fixture.request,
      approvalValidation: { valid: true },
    } as never)).rejects.toMatchObject({ code: "CALLER_APPROVAL_VALIDATION_FORBIDDEN" });
    expect(fixture.request.createReadOnlyDependencies).not.toHaveBeenCalled();
    expect(fixture.request.createWriteClients).not.toHaveBeenCalled();
  });

  it("fails closed while the checked-in production reviewer anchor is unprovisioned", async () => {
    const fixture = createFixture();
    await expect(executeSevenBucketWithDetachedApproval(fixture.request)).rejects.toMatchObject({
      code: "SEVEN_BUCKET_TRUST_ANCHOR_UNPROVISIONED",
    });
    expect(fixture.request.createReadOnlyDependencies).not.toHaveBeenCalled();
    expect(fixture.request.createWriteClients).not.toHaveBeenCalled();
  });

  it("rejects the legacy direct executor forged-valid-bit path before dependencies", async () => {
    const fixture = createFixture();
    await expect(executeCombinedSixPlusOne({
      activation: SEVEN_BUCKET_ACTIVATION,
      approvalValidation: { valid: true },
      plan: fixture.plan,
      approval: fixture.approval,
      knownSource: fixture.request.planInputs.knownSource,
      seventhSource: fixture.request.planInputs.seventhSource,
      createDependencies: fixture.request.createWriteClients,
    })).rejects.toMatchObject({ code: "COMBINED_DIRECT_EXECUTION_FORBIDDEN" });
    expect(fixture.request.createReadOnlyDependencies).not.toHaveBeenCalled();
    expect(fixture.request.createWriteClients).not.toHaveBeenCalled();
  });

  it("rejects expiry, identity drift, key drift, and plan drift without delegating", () => {
    const expired = createFixture();
    expect(() => validateDetachedSevenBucketExecution({
      request: expired.request,
      trustAnchor: expired.trustAnchor,
      now: Date.parse("2026-08-22T03:00:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "COMBINED_APPROVAL_EXPIRED" }));

    const wrongIdentity = createFixture();
    expect(() => validateDetachedSevenBucketExecution({
      request: wrongIdentity.request,
      trustAnchor: { ...wrongIdentity.trustAnchor, reviewerIdentity: "different-reviewer" },
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toThrowError(expect.objectContaining({
      code: "SEVEN_BUCKET_TRUSTED_REVIEWER_IDENTITY_MISMATCH",
    }));

    const wrongKey = createFixture();
    expect(() => validateDetachedSevenBucketExecution({
      request: wrongKey.request,
      trustAnchor: { ...wrongKey.trustAnchor, reviewerPublicKeySha256: "f".repeat(64) },
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toThrowError(expect.objectContaining({
      code: "SEVEN_BUCKET_TRUSTED_REVIEWER_KEY_MISMATCH",
    }));

    const planDrift = createFixture();
    const parsedPlan = JSON.parse(planDrift.request.rawCombinedPlan.toString());
    parsedPlan.totalBytes += 1;
    expect(() => validateDetachedSevenBucketExecution({
      request: {
        ...planDrift.request,
        rawCombinedPlan: Buffer.from(JSON.stringify(parsedPlan)),
      },
      trustAnchor: planDrift.trustAnchor,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "COMBINED_PLAN_RECOMPUTE_MISMATCH" }));

    expect(expired.request.createWriteClients).not.toHaveBeenCalled();
    expect(wrongIdentity.request.createWriteClients).not.toHaveBeenCalled();
    expect(wrongKey.request.createWriteClients).not.toHaveBeenCalled();
    expect(planDrift.request.createWriteClients).not.toHaveBeenCalled();
  });

  it("rejects a same-count seventh-source substitution before either factory", () => {
    const fixture = createFixture();
    const seventhSource = fixture.request.planInputs.seventhSource;
    const substitutedObjects = seventhSource.objects.map((object, index) =>
      index === 0
        ? { ...object, objectKey: "private/substituted-same-count-object" }
        : object
    );
    expect(() => validateDetachedSevenBucketExecution({
      request: {
        ...fixture.request,
        planInputs: {
          ...fixture.request.planInputs,
          seventhSource: { ...seventhSource, objects: substitutedObjects },
        },
      },
      trustAnchor: fixture.trustAnchor,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "COMBINED_PLAN_RECOMPUTE_MISMATCH" }));
    expect(fixture.request.createReadOnlyDependencies).not.toHaveBeenCalled();
    expect(fixture.request.createWriteClients).not.toHaveBeenCalled();
  });

  it("runs the read-only path but constructs zero write clients for stale, mutated, or malformed live proof", async () => {
    const now = Date.parse("2026-08-22T01:30:00.000Z");
    for (const variant of ["stale", "mutated", "malformed"] as const) {
      const fixture = createFixture();
      const live = refreshTargetProof(
        fixture,
        variant === "stale" ? "2026-08-22T01:24:59.999Z" : "2026-08-22T01:30:00.000Z",
      );
      if (variant === "mutated") {
        live.seventhPreflight.iamDigestSha256 = "f".repeat(64);
        live.seventhPreflight.preflightDigestSha256 = calculateSelfBoundDigest(
          live.seventhPreflight,
          "preflightDigestSha256",
        );
        live.preflightDigestSha256 = calculateSelfBoundDigest(live, "preflightDigestSha256");
      }
      const collectFreshAllSevenTargetPreflight = vi.fn(async () =>
        variant === "malformed" ? "{" : Buffer.from(JSON.stringify(live)));
      const createReadOnlyDependencies = vi.fn(async () => ({
        sourceClient: {},
        policySnapshotProvider: vi.fn(async () => fixture.policy),
        collectFreshAllSevenTargetPreflight,
      }));
      const createWriteClients = vi.fn();
      const verifyLiveSource = vi.fn(async () => ({ verified: true }));
      const request = {
        ...fixture.request,
        createReadOnlyDependencies,
        createWriteClients,
      };
      await expect(__testing.executeSevenBucketWithTrustAnchor({
        request,
        trustAnchor: fixture.trustAnchor,
        now,
        verifyLiveSource,
      })).rejects.toMatchObject({
        code: variant === "stale"
          ? "ALL_SEVEN_TARGET_PREFLIGHT_STALE"
          : variant === "mutated"
            ? "ALL_SEVEN_TARGET_MUTATED_AFTER_APPROVAL"
            : "LIVE_ALL_SEVEN_TARGET_PREFLIGHT_JSON_INVALID",
      });
      expect(createReadOnlyDependencies).toHaveBeenCalledOnce();
      expect(verifyLiveSource).toHaveBeenCalledOnce();
      expect(collectFreshAllSevenTargetPreflight).toHaveBeenCalledOnce();
      expect(collectFreshAllSevenTargetPreflight.mock.calls[0][0]).not.toHaveProperty(
        "approvedTargetPreflight",
      );
      expect(createWriteClients).not.toHaveBeenCalled();
    }
  });

  it("accepts a newly captured equivalent live proof before reaching the delayed write factory", async () => {
    const fixture = createFixture();
    const live = refreshTargetProof(fixture, "2026-08-22T01:30:00.000Z");
    expect(sha256(Buffer.from(JSON.stringify(live)))).not.toBe(
      fixture.plan.allSevenTargetPreflightFileDigestSha256,
    );
    const collectFreshAllSevenTargetPreflight = vi.fn(async () =>
      Buffer.from(JSON.stringify(live)));
    const createReadOnlyDependencies = vi.fn(async () => ({
      sourceClient: {},
      policySnapshotProvider: vi.fn(async () => fixture.policy),
      collectFreshAllSevenTargetPreflight,
    }));
    const writeFactoryReached = new Error("write-factory-reached");
    const createWriteClients = vi.fn(async () => {
      throw writeFactoryReached;
    });
    await expect(__testing.executeSevenBucketWithTrustAnchor({
      request: {
        ...fixture.request,
        createReadOnlyDependencies,
        createWriteClients,
      },
      trustAnchor: fixture.trustAnchor,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
      verifyLiveSource: vi.fn(async () => ({ verified: true })),
    })).rejects.toBe(writeFactoryReached);
    expect(createReadOnlyDependencies).toHaveBeenCalledOnce();
    expect(collectFreshAllSevenTargetPreflight).toHaveBeenCalledOnce();
    expect(createWriteClients).toHaveBeenCalledOnce();
  });

  it("rejects duplicate and prototype-like raw JSON keys before validation or delegation", () => {
    const duplicate = createFixture();
    const duplicateApproval = duplicate.request.rawDetachedApproval
      .toString()
      .replace(
        '"project":"hushh-tech-uat"',
        '"project":"hushh-tech-uat","project":"hushh-tech-prod"',
      );
    expect(() => validateDetachedSevenBucketExecution({
      request: { ...duplicate.request, rawDetachedApproval: duplicateApproval },
      trustAnchor: duplicate.trustAnchor,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "COMBINED_APPROVAL_JSON_INVALID" }));

    const escapedDuplicate = createFixture();
    const escapedDuplicateApproval = escapedDuplicate.request.rawDetachedApproval
      .toString()
      .replace(
        '"project":"hushh-tech-uat"',
        '"project":"hushh-tech-uat","projec\\u0074":"hushh-tech-prod"',
      );
    expect(() => validateDetachedSevenBucketExecution({
      request: { ...escapedDuplicate.request, rawDetachedApproval: escapedDuplicateApproval },
      trustAnchor: escapedDuplicate.trustAnchor,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "COMBINED_APPROVAL_JSON_INVALID" }));

    const prototypeLike = createFixture();
    const prototypeManifest = prototypeLike.request.rawChangeManifest
      .toString()
      .replace("{", '{"__proto__":{},');
    expect(() => validateDetachedSevenBucketExecution({
      request: { ...prototypeLike.request, rawChangeManifest: prototypeManifest },
      trustAnchor: prototypeLike.trustAnchor,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toThrowError(expect.objectContaining({
      code: "COMBINED_CHANGE_MANIFEST_JSON_INVALID",
    }));

    expect(duplicate.request.createWriteClients).not.toHaveBeenCalled();
    expect(escapedDuplicate.request.createWriteClients).not.toHaveBeenCalled();
    expect(prototypeLike.request.createWriteClients).not.toHaveBeenCalled();
  });
});
