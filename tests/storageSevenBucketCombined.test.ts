import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { STORAGE_CUTOVER_CONTRACT } from "../scripts/migration/storage-cutover-contract.mjs";
import {
  COMBINED_CHANGE_MANIFEST_SCHEMA,
  SEVEN_BUCKET_APPROVAL_SCHEMA,
  SEVEN_BUCKET_ACTIVATION,
  SEVEN_BUCKET_CONTRACT,
  ZERO_GRANT_POLICY_EVIDENCE_SCHEMA,
  buildCombinedSourceSummary,
  buildSeventhTargetMetadata,
  seventhSourceFingerprint,
  seventhSourceObjectId,
  seventhTargetObjectKey,
  validateSeventhSourceArtifact,
  validateCombinedChangeManifest,
  validateSevenBucketActivation,
  validateSevenBucketContract,
} from "../scripts/migration/storage-seven-bucket-contract.mjs";
import {
  buildCombinedPostCopyEvidence,
  buildCombinedSevenBucketPlan,
  executeCombinedSixPlusOne,
  validateCombinedSevenBucketApproval,
  verifyAllSevenLiveSource,
} from "../scripts/migration/storage-seven-bucket-orchestrator.mjs";
import {
  SeventhQuarantineCreateOnlyClient,
  performSeventhCreateOnlyCopy,
} from "../scripts/migration/storage-seventh-quarantine-executor.mjs";
import {
  calculateSelfBoundDigest,
  canonicalJson,
  createCrc32c,
  readPrivateArtifact,
  sha256,
} from "../scripts/migration/storage-live-common.mjs";

const digestBytes = (bytes: Buffer) => {
  const crc32c = createCrc32c().update(bytes).digestBase64();
  return {
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    md5Base64: createHash("md5").update(bytes).digest("base64"),
    crc32cBase64: crc32c,
  };
};

const createZeroGrantEvidence = (suffix = "a") => {
  const evidence = {
    schemaVersion: ZERO_GRANT_POLICY_EVIDENCE_SCHEMA,
    capturedAt: "2026-08-22T01:00:00.000Z",
    project: "hushh-tech-uat",
    operatorPrincipal:
      "serviceAccount:claude-code-gcp-operator@hussh-developer-platform.iam.gserviceaccount.com",
    migrationServiceAccount:
      "hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com",
    projectPolicyFileDigestSha256: suffix.repeat(64),
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

const createKnownPlan = (knownSource = createKnownSource()) => {
  const plan = {
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
      action: index % 2 === 0 ? "CREATE_IF_ABSENT" : "NOOP_PRESENT_EXACT",
      objectId: sha256(`known-object-${index}`),
      targetBucket: STORAGE_CUTOVER_CONTRACT.buckets[index % 6].targetBucket,
      expectedBytes: object.sizeBytes,
    })),
    planDigestSha256: "6".repeat(64),
  };
  return plan;
};

const createChangeManifest = (reviewedCommitSha = "d".repeat(40)) => {
  const manifest = {
    schemaVersion: COMBINED_CHANGE_MANIFEST_SCHEMA,
    environment: "uat",
    project: "hushh-tech-uat",
    baseCommitSha: "1".repeat(40),
    reviewedCommitSha,
    changedPathCount: 2,
    changedPaths: [
      { path: "migration/storage/activation.json", sha256: "2".repeat(64) },
      { path: "scripts/migration/orchestrator.mjs", sha256: "3".repeat(64) },
    ],
    manifestDigestSha256: null as string | null,
  };
  manifest.manifestDigestSha256 = calculateSelfBoundDigest(
    manifest,
    "manifestDigestSha256",
  );
  return manifest as typeof manifest & { manifestDigestSha256: string };
};

const createCombinedPlan = () => {
  const knownSource = createKnownSource();
  const seventhSource = createSeventhSource();
  const reviewedCommitSha = "d".repeat(40);
  const changeManifest = createChangeManifest(reviewedCommitSha);
  return {
    knownSource,
    seventhSource,
    policy: createZeroGrantEvidence(),
    changeManifest,
    plan: buildCombinedSevenBucketPlan({
      activation: SEVEN_BUCKET_ACTIVATION,
      changeManifest,
      changeManifestFileDigestSha256: "e".repeat(64),
      knownSource,
      knownSourceFileDigestSha256: "7".repeat(64),
      seventhSource,
      knownSixPlan: createKnownPlan(knownSource),
      knownSixPlanFileDigestSha256: "8".repeat(64),
      knownSixPreflightFileDigestSha256: "9".repeat(64),
      knownSixPreflightDigestSha256: "a".repeat(64),
      seventhPreflightFileDigestSha256: "b".repeat(64),
      seventhPreflightDigestSha256: "c".repeat(64),
      seventhPreflightSafe: true,
      seventhNamespaceObjectCount: 0,
      zeroGrantPolicyEvidence: createZeroGrantEvidence(),
      reviewedCommitSha,
    }),
  };
};

describe("combined canonical seven-bucket migration", () => {
  it("freezes exact 6+1 totals and keeps every destructive/runtime flag false", () => {
    const contract = validateSevenBucketContract();
    expect(contract).toMatchObject({
      bucketCount: 7,
      objectCount: 140,
      totalBytes: 1_574_621_367,
      knownSix: { bucketCount: 6, objectCount: 124, totalBytes: 111_078_397 },
      seventh: { objectCount: 16, totalBytes: 1_463_542_970 },
      executionPolicy: {
        sourceMutationAllowed: false,
        targetOverwriteAllowed: false,
        targetDeleteAllowed: false,
        productionMutationAllowed: false,
        runtimeRoutingAllowed: false,
        executionActivated: false,
      },
    });
    expect(validateSevenBucketActivation()).toMatchObject({
      contractState: "UAT_CREATE_ONLY_ACTIVATED",
      executionPolicy: {
        createOnly: true,
        sourceMutationAllowed: false,
        targetOverwriteAllowed: false,
        targetDeleteAllowed: false,
        productionMutationAllowed: false,
        runtimeRoutingAllowed: false,
        executionActivated: true,
      },
    });
  });

  it("builds one 140-object create/no-op plan with exact seventh quarantine targets", () => {
    const { plan } = createCombinedPlan();
    expect(plan).toMatchObject({
      bucketCount: 7,
      objectCount: 140,
      totalBytes: 1_574_621_367,
      knownSixActionCount: 124,
      seventhActionCount: 16,
      deleteCount: 0,
      overwriteCount: 0,
      runtimeRoutingAllowed: false,
      ifGenerationMatch: 0,
    });
    expect(plan.seventhActions).toHaveLength(16);
    expect(plan.seventhActions.every((action) =>
      action.action === "CREATE_IF_ABSENT" &&
      action.targetPrecondition === "ifGenerationMatch=0" &&
      action.targetBucket === "hushh-tech-supabase-quarantine-uat"
    )).toBe(true);
  });

  it("builds the combined source summary from the real JSONL validator shape", () => {
    const source = createKnownSource();
    const actualShape = {
      ...source,
      bucketCount: undefined,
      buckets: undefined,
      bucketRecords: source.buckets,
    };
    const summary = buildCombinedSourceSummary({
      knownSource: actualShape,
      knownSourceFileDigestSha256: "7".repeat(64),
      seventhSource: createSeventhSource(),
    });
    expect(summary).toMatchObject({
      bucketCount: 7,
      objectCount: 140,
      totalBytes: 1_574_621_367,
      knownSix: { bucketCount: 6, objectCount: 124, totalBytes: 111_078_397 },
    });
  });

  it("rejects the old pre-copy schema plus manifest, head, path, and evidence drift", () => {
    const reviewedCommitSha = "d".repeat(40);
    const manifest = createChangeManifest(reviewedCommitSha);
    expect(() => validateCombinedChangeManifest({
      ...manifest,
      schemaVersion: "hushh-tech-storage-precopy-iam-change-manifest-v1",
      liveEvidence: { evidenceDigestSha256: "e".repeat(64) },
    })).toThrowError(expect.objectContaining({ code: "COMBINED_CHANGE_MANIFEST_SCHEMA" }));
    expect(() => validateCombinedChangeManifest({
      ...manifest,
      reviewedCommitSha: "e".repeat(40),
    })).toThrowError(expect.objectContaining({
      code: "COMBINED_CHANGE_MANIFEST_DIGEST_MISMATCH",
    }));
    expect(() => validateCombinedChangeManifest({
      ...manifest,
      changedPaths: manifest.changedPaths.map((entry, index) =>
        index === 0 ? { ...entry, sha256: "f".repeat(64) } : entry),
    })).toThrowError(expect.objectContaining({
      code: "COMBINED_CHANGE_MANIFEST_DIGEST_MISMATCH",
    }));

    const knownSource = createKnownSource();
    const planInputs = {
      activation: SEVEN_BUCKET_ACTIVATION,
      changeManifest: manifest,
      changeManifestFileDigestSha256: "e".repeat(64),
      knownSource,
      knownSourceFileDigestSha256: "7".repeat(64),
      seventhSource: createSeventhSource(),
      knownSixPlan: createKnownPlan(knownSource),
      knownSixPlanFileDigestSha256: "8".repeat(64),
      knownSixPreflightFileDigestSha256: "9".repeat(64),
      knownSixPreflightDigestSha256: "a".repeat(64),
      seventhPreflightFileDigestSha256: "b".repeat(64),
      seventhPreflightDigestSha256: "c".repeat(64),
      seventhPreflightSafe: true,
      seventhNamespaceObjectCount: 0,
      zeroGrantPolicyEvidence: createZeroGrantEvidence(),
      reviewedCommitSha: "e".repeat(40),
    };
    expect(() => buildCombinedSevenBucketPlan(planInputs)).toThrowError(
      expect.objectContaining({ code: "COMBINED_CHANGE_MANIFEST_COMMIT_MISMATCH" }),
    );
  });

  it("rejects hardlinked private artifacts", () => {
    const directory = mkdtempSync("/private/tmp/seven-bucket-hardlink-");
    const original = join(directory, "source.json");
    const linked = join(directory, "source-linked.json");
    writeFileSync(original, "{}", { mode: 0o600 });
    linkSync(original, linked);
    try {
      expect(() => readPrivateArtifact(original)).toThrowError(
        expect.objectContaining({ code: "PRIVATE_ARTIFACT_HARDLINK_BLOCKED" })
      );
    } finally {
      unlinkSync(linked);
      unlinkSync(original);
    }
  });

  it("rehashes the sealed descriptor and stops an fd mutation before the final upload", async () => {
    const bytes = Buffer.from("sealed-private-seventh-bytes");
    const digests = digestBytes(bytes);
    const object = {
      bucketId: "private-fixture-only",
      objectKey: "private/one",
      mimeType: "application/octet-stream",
      sourceUpdatedAt: "2026-08-22T00:00:00.000Z",
      cacheControl: null,
      ...digests,
    };
    const directory = mkdtempSync(join(tmpdir(), "seven-bucket-fd-"));
    const path = join(directory, "sealed");
    writeFileSync(path, bytes, { mode: 0o600 });
    const descriptor = openSync(path, "r+");
    unlinkSync(path);
    const fetchMock = vi.fn(async () => {
      writeSync(descriptor, Buffer.from("X"), 0, 1, 0);
      return new Response(null, {
        status: 200,
        headers: {
          location:
            "https://storage.googleapis.com/upload/storage/v1/b/hushh-tech-supabase-quarantine-uat/o?upload_id=safe",
        },
      });
    });
    const client = new SeventhQuarantineCreateOnlyClient({
      fetchImpl: fetchMock as typeof fetch,
      tokenProvider: () => "migration-writer-access-token",
    });
    try {
      await expect(client.uploadCreateOnly({
        sourceObject: object,
        temporary: { fileDescriptor: descriptor, ...digests },
      })).rejects.toMatchObject({ code: "SEVENTH_SOURCE_DESCRIPTOR_CHANGED" });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      closeSync(descriptor);
    }
  });

  it("rejects an eighth source bucket before any object content call", async () => {
    const sourceClient = {
      listBuckets: vi.fn(async () => Array.from({ length: 8 }, (_, index) => ({
        id: `unknown-${index}`,
        public: true,
      }))),
      listObjects: vi.fn(),
      hashObject: vi.fn(),
    };
    await expect(verifyAllSevenLiveSource({
      knownSource: createKnownSource(),
      seventhSource: createSeventhSource(),
      sourceClient,
    })).rejects.toMatchObject({ code: "SEVEN_BUCKET_LIVE_SET_DRIFT" });
    expect(sourceClient.listObjects).not.toHaveBeenCalled();
    expect(sourceClient.hashObject).not.toHaveBeenCalled();
  });

  it("requires exact independent Lane 7 approval bindings and detached signature", () => {
    const { plan, policy } = createCombinedPlan();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const approval = {
      schemaVersion: SEVEN_BUCKET_APPROVAL_SCHEMA,
      decision: "APPROVED_FOR_CREATE_ONLY_UAT_SEVEN_BUCKET_COPY",
      environment: "uat",
      project: "hushh-tech-uat",
      reviewerLane: "LANE_7",
      reviewerIdentity: "independent-lane-7-reviewer",
      authorIdentity: "lane-4-author",
      approvedAt: "2026-08-22T01:00:00.000Z",
      expiresAt: "2026-08-22T03:00:00.000Z",
      reviewedCommitSha: plan.reviewedCommitSha,
      activationFileDigestSha256: plan.activationFileDigestSha256,
      activationDigestSha256: plan.activationDigestSha256,
      isolatedCutoverContractFileDigestSha256:
        plan.isolatedCutoverContractFileDigestSha256,
      contractState: plan.contractState,
      executionActivated: plan.executionActivated,
      changeManifestFileDigestSha256: plan.changeManifestFileDigestSha256,
      changeManifestDigestSha256: plan.changeManifestDigestSha256,
      planFileDigestSha256: "f".repeat(64),
      planDigestSha256: plan.planDigestSha256,
      combinedSourceDigestSha256: plan.combinedSourceDigestSha256,
      knownSixPlanDigestSha256: plan.knownSixPlanDigestSha256,
      knownSixPreflightDigestSha256: plan.knownSixPreflightDigestSha256,
      seventhPreflightDigestSha256: plan.seventhPreflightDigestSha256,
      zeroGrantPolicyEvidenceDigestSha256: policy.evidenceDigestSha256,
      signatureAlgorithm: "ED25519",
      reviewerPublicKeySha256: sha256(publicPem),
      signatureBase64: null as string | null,
      approvalDigestSha256: null as string | null,
    };
    const payload = Buffer.from(canonicalJson({
      ...approval,
      signatureBase64: null,
      approvalDigestSha256: null,
    }));
    approval.signatureBase64 = sign(null, payload, privateKey).toString("base64");
    approval.approvalDigestSha256 = calculateSelfBoundDigest(approval, "approvalDigestSha256");
    expect(validateCombinedSevenBucketApproval({
      approval,
      approvalFileDigestSha256: "0".repeat(64),
      plan,
      planFileDigestSha256: "f".repeat(64),
      zeroGrantPolicyEvidence: policy,
      reviewerPublicKeyPem: publicPem,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toEqual({ valid: true, approvalDigestSha256: approval.approvalDigestSha256 });

    const mismatched = { ...approval, reviewerLane: "LANE_8" };
    expect(() => validateCombinedSevenBucketApproval({
      approval: mismatched,
      approvalFileDigestSha256: "0".repeat(64),
      plan,
      planFileDigestSha256: "f".repeat(64),
      zeroGrantPolicyEvidence: policy,
      reviewerPublicKeyPem: publicPem,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "COMBINED_APPROVAL_SCOPE_MISMATCH" }));

    const evidenceDriftPlan = {
      ...plan,
      knownSixPreflightDigestSha256: "1".repeat(64),
      planDigestSha256: null as string | null,
    };
    evidenceDriftPlan.planDigestSha256 = calculateSelfBoundDigest(
      evidenceDriftPlan,
      "planDigestSha256",
    );
    expect(() => validateCombinedSevenBucketApproval({
      approval,
      approvalFileDigestSha256: "0".repeat(64),
      plan: evidenceDriftPlan,
      planFileDigestSha256: "f".repeat(64),
      zeroGrantPolicyEvidence: policy,
      reviewerPublicKeyPem: publicPem,
      now: Date.parse("2026-08-22T01:30:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "COMBINED_APPROVAL_ARTIFACT_MISMATCH" }));
  });

  it("touches zero dependency factories for either false activation field", async () => {
    const { plan, knownSource, seventhSource } = createCombinedPlan();
    const falseStates = [
      { ...SEVEN_BUCKET_ACTIVATION, contractState: "REVIEW_REQUIRED_EXECUTION_DISABLED" },
      {
        ...SEVEN_BUCKET_ACTIVATION,
        executionPolicy: {
          ...SEVEN_BUCKET_ACTIVATION.executionPolicy,
          executionActivated: false,
        },
      },
    ];
    for (const activation of falseStates) {
      const createDependencies = vi.fn();
      await expect(executeCombinedSixPlusOne({
        activation,
        approvalValidation: { valid: true },
        plan,
        approval: {},
        knownSource,
        seventhSource,
        createDependencies,
      })).rejects.toMatchObject({ code: "SEVEN_BUCKET_ACTIVATION_STATE_MISMATCH" });
      expect(createDependencies).not.toHaveBeenCalled();
    }
  });

  it("constructs dependencies only for the exact true UAT activation state", async () => {
    const { plan, knownSource, seventhSource } = createCombinedPlan();
    const constructionSentinel = new Error("dependency-construction-reached");
    const createDependencies = vi.fn(async () => {
      throw constructionSentinel;
    });
    await expect(executeCombinedSixPlusOne({
      activation: SEVEN_BUCKET_ACTIVATION,
      approvalValidation: { valid: true },
      plan,
      approval: {},
      knownSource,
      seventhSource,
      createDependencies,
    })).rejects.toBe(constructionSentinel);
    expect(createDependencies).toHaveBeenCalledOnce();
  });

  it("touches zero dependencies when the isolated target contract digest changes", async () => {
    const { plan, knownSource, seventhSource } = createCombinedPlan();
    const createDependencies = vi.fn();
    await expect(executeCombinedSixPlusOne({
      activation: SEVEN_BUCKET_ACTIVATION,
      approvalValidation: { valid: true },
      plan: {
        ...plan,
        isolatedCutoverContractFileDigestSha256: "0".repeat(64),
      },
      approval: {},
      knownSource,
      seventhSource,
      createDependencies,
    })).rejects.toMatchObject({ code: "COMBINED_UAT_ACTIVATION_REQUIRED" });
    expect(createDependencies).not.toHaveBeenCalled();
  });

  it("rejects a forged known-six callback instead of invoking caller-supplied copy logic", async () => {
    const { plan, knownSource, seventhSource } = createCombinedPlan();
    const forgedKnownSix = vi.fn();
    const createDependencies = vi.fn(async () => ({
      sourceClient: {},
      knownSixGcsClient: {},
      seventhGcsClient: {},
      policySnapshotProvider: vi.fn(),
      knownSixSourceFileDigestSha256: plan.knownSixSourceFileDigestSha256,
      knownSixPreflight: {},
      knownSixPreflightFileDigestSha256: plan.knownSixPreflightFileDigestSha256,
      knownSixPlan: {},
      knownSixPlanFileDigestSha256: plan.knownSixPlanFileDigestSha256,
      executeReviewedKnownSix: forgedKnownSix,
    }));
    await expect(executeCombinedSixPlusOne({
      activation: SEVEN_BUCKET_ACTIVATION,
      approvalValidation: { valid: true },
      plan,
      approval: {},
      knownSource,
      seventhSource,
      createDependencies,
    })).rejects.toMatchObject({ code: "COMBINED_DEPENDENCY_SCHEMA" });
    expect(createDependencies).toHaveBeenCalledOnce();
    expect(forgedKnownSix).not.toHaveBeenCalled();
  });

  it("retries a partial seventh copy as exact no-op plus create without overwrite", async () => {
    const payloads = [Buffer.from("already-present"), Buffer.from("new-object")];
    const objects = payloads.map((bytes, index) => ({
      bucketId: "private-fixture-only",
      objectKey: `private/retry-${index}`,
      mimeType: "application/octet-stream",
      sourceUpdatedAt: "2026-08-22T00:00:00.000Z",
      cacheControl: null,
      ...digestBytes(bytes),
    }));
    const targetFor = (object: typeof objects[number], generation: string) => ({
      bucket: SEVEN_BUCKET_CONTRACT.seventh.targetBucket,
      name: seventhTargetObjectKey(object),
      generation,
      size: String(object.sizeBytes),
      contentType: object.mimeType,
      cacheControl: SEVEN_BUCKET_CONTRACT.seventh.targetCacheControl,
      crc32c: object.crc32cBase64,
      md5Hash: object.md5Base64,
      metadata: buildSeventhTargetMetadata(object),
    });
    const targets = new Map([[seventhTargetObjectKey(objects[0]), targetFor(objects[0], "10")]]);
    const gcsClient = {
      getObject: vi.fn(async (_bucket: string, name: string) => targets.get(name) || null),
      uploadCreateOnly: vi.fn(async ({ sourceObject }: { sourceObject: typeof objects[number] }) => {
        const target = targetFor(sourceObject, "11");
        targets.set(target.name, target);
        return { collision: false, object: target };
      }),
      hashObject: vi.fn(async (target: { name: string }) => {
        const index = target.name === seventhTargetObjectKey(objects[0]) ? 0 : 1;
        return digestBytes(payloads[index]);
      }),
      listObjects: vi.fn(async () => [...targets.values()]),
    };
    const sourceClient = {
      request: vi.fn(async (path: string) => {
        const index = path.includes("retry-0") ? 0 : 1;
        return new Response(payloads[index], { status: 200 });
      }),
    };
    const result = await performSeventhCreateOnlyCopy({
      seventhSource: { objectCount: 2, objects },
      sourceClient,
      gcsClient,
    });
    expect(result).toMatchObject({
      objectCount: 2,
      createdCount: 1,
      noopCount: 1,
      deleteCount: 0,
      overwriteCount: 0,
    });
    expect(gcsClient.uploadCreateOnly).toHaveBeenCalledOnce();
  });

  it("fails combined evidence on mutation after approval", () => {
    const { plan, policy } = createCombinedPlan();
    const sourceBefore = {
      bucketCount: 7,
      objectCount: 140,
      totalBytes: 1_574_621_367,
      firstMetadataDigestSha256: "1".repeat(64),
      contentSetDigestSha256: "2".repeat(64),
    };
    expect(() => buildCombinedPostCopyEvidence({
      plan,
      approval: { approvalDigestSha256: "3".repeat(64) },
      sourceBefore,
      sourceAfter: { ...sourceBefore, contentSetDigestSha256: "4".repeat(64) },
      knownSixResult: {},
      seventhResult: {},
      policyBefore: policy,
      policyAfter: policy,
    })).toThrowError(expect.objectContaining({ code: "COMBINED_POSTCOPY_SOURCE_DELTA" }));
  });

  it("validates the real private seventh artifact without exposing its raw identity", async () => {
    const latest = "/private/tmp/hushh-storage-lane4.latest";
    if (!existsSync(latest)) return;
    let directory;
    try {
      directory = readlinkSync(latest);
    } catch {
      directory = readFileSync(latest, "utf8").trim();
    }
    const path = join(directory, "private-unknown-source-quarantine.json");
    if (!existsSync(path)) return;
    const bytes = readFileSync(path);
    const validated = validateSeventhSourceArtifact(JSON.parse(bytes.toString("utf8")), {
      fileDigestSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(validated).toMatchObject({
      bucketIdSha256: SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256,
      objectCount: 16,
      totalBytes: 1_463_542_970,
    });
    expect(validated.metadataDigestSha256).toBe(
      "312038de08a37dc4c521600f77722e98787f694e36076ae8e8513e719d365021"
    );
    const knownSource = createKnownSource();
    const knownHashObject = vi.fn(async (bucketId: string, objectKey: string) => {
      const object = knownSource.objects.find((candidate) =>
        candidate.bucketId === bucketId && candidate.objectKey === objectKey)!;
      return {
        sizeBytes: object.sizeBytes,
        sha256: object.sha256,
        md5Base64: Buffer.alloc(16).toString("base64"),
        crc32cBase64: Buffer.alloc(4).toString("base64"),
      };
    });
    const seventhHashObject = vi.fn(async (bucketId: string, objectKey: string) => {
      const object = validated.objects.find((candidate) =>
        candidate.bucketId === bucketId && candidate.objectKey === objectKey)!;
      return {
        sizeBytes: object.sizeBytes,
        sha256: object.sha256,
        md5Base64: object.md5Base64,
        crc32cBase64: object.crc32cBase64,
      };
    });
    const verified = await verifyAllSevenLiveSource({
      knownSource,
      seventhSource: validated,
      sourceClient: {
        listBuckets: vi.fn(async () => [
          ...STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({
            id: bucket.sourceBucket,
            public: bucket.sourcePublic,
          })),
          { id: validated.rawBucketId, public: validated.public },
        ]),
        listObjects: vi.fn(async (bucketId: string) => [
          ...knownSource.objects,
          ...validated.objects,
        ].filter((object) => object.bucketId === bucketId).map((object) => ({
          recordType: "sourceObject",
          bucketId: object.bucketId,
          objectKey: object.objectKey,
          sizeBytes: object.sizeBytes,
          mimeType: object.mimeType,
          sourceUpdatedAt: object.sourceUpdatedAt,
          cacheControl: object.cacheControl,
        }))),
        hashObject: knownHashObject,
        hashSeventhObject: seventhHashObject,
      },
    });
    expect(verified).toMatchObject({
      bucketCount: 7,
      objectCount: 140,
      totalBytes: 1_574_621_367,
    });
    expect(knownHashObject).toHaveBeenCalledTimes(124);
    expect(seventhHashObject).toHaveBeenCalledTimes(16);
    expect(knownHashObject.mock.calls.every(([bucketId]) =>
      bucketId !== validated.rawBucketId)).toBe(true);
    expect(seventhHashObject.mock.calls.every(([bucketId]) =>
      bucketId === validated.rawBucketId)).toBe(true);
  });
});
