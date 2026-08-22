import { describe, expect, it, vi } from "vitest";

import {
  FixedSeventhTargetReadClient,
  collectFixedSeventhTargetPreflight,
} from "../scripts/migration/storage-fixed-seventh-target-collector.mjs";
import {
  SEVEN_BUCKET_CONTRACT,
} from "../scripts/migration/storage-seven-bucket-contract.mjs";
import {
  calculateSelfBoundDigest,
  canonicalJson,
  sha256,
} from "../scripts/migration/storage-live-common.mjs";

const bucket = "hushh-tech-supabase-quarantine-uat";
const writer =
  "serviceAccount:hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com";
const audit =
  "serviceAccount:hushh-tech-audit-uat@hushh-tech-uat.iam.gserviceaccount.com";

const response = (url: string, value: unknown, finalUrl = url) => {
  const result = new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperties(result, {
    url: { value: finalUrl },
    redirected: { value: false },
  });
  return result;
};

const source = () => {
  const safeObjects = Array.from({ length: 16 }, (_, index) => ({
    objectId: sha256(`object-${index}`),
    sourceFingerprintSha256: sha256(`fingerprint-${index}`),
    sizeBytes: index === 0 ? 1_463_542_955 : 1,
    sha256: sha256(`content-${index}`),
    md5Base64: Buffer.alloc(16, index).toString("base64"),
    crc32cBase64: Buffer.alloc(4, index).toString("base64"),
  }));
  return {
    bucketIdSha256: SEVEN_BUCKET_CONTRACT.seventh.sourceBucketIdSha256,
    objectCount: 16,
    totalBytes: 1_463_542_970,
    sourceFileDigestSha256: "a".repeat(64),
    sourceArtifactDigestSha256: "b".repeat(64),
    contentSetDigestSha256: sha256(canonicalJson(safeObjects)),
    safeObjects,
  };
};

const fixedFetch = ({
  objectAdmin = false,
  namespaceItem = null as null | Record<string, unknown>,
  runtimeReference = false,
  unknownRuntimeRegion = false,
} = {}) => vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  expect(init?.method).toBe("GET");
  if (url.startsWith("http://metadata.google.internal/")) {
    return response(url, { access_token: "fixed-read-only-token-value" });
  }
  const parsed = new URL(url);
  if (parsed.pathname === `/storage/v1/b/${bucket}`) {
    return response(url, {
      id: bucket,
      name: bucket,
      projectNumber: "175298245599",
      location: "US-CENTRAL1",
      locationType: "region",
      storageClass: "STANDARD",
      labels: { environment: "uat", purpose: "supabase-quarantine", system: "hushh-tech" },
      iamConfiguration: {
        uniformBucketLevelAccess: { enabled: true },
        publicAccessPrevention: "enforced",
      },
      versioning: { enabled: true },
      retentionPolicy: { retentionPeriod: "604800" },
      softDeletePolicy: { retentionDurationSeconds: "604800" },
    });
  }
  if (parsed.pathname === `/storage/v1/b/${bucket}/iam`) {
    return response(url, { bindings: [
      {
        role: objectAdmin
          ? "roles/storage.objectAdmin"
          : "projects/hushh-tech-uat/roles/hushhTechStorageCutoverWriter",
        members: [writer],
      },
      { role: "roles/storage.objectViewer", members: [audit] },
    ] });
  }
  if (parsed.pathname.endsWith("/roles/hushhTechStorageCutoverWriter")) {
    return response(url, {
      name: "projects/hushh-tech-uat/roles/hushhTechStorageCutoverWriter",
      includedPermissions: ["storage.objects.list", "storage.objects.create", "storage.objects.get"],
    });
  }
  if (parsed.pathname === "/v3/tagBindings") {
    return response(url, { tagBindings: [{
      parent: `//storage.googleapis.com/projects/_/buckets/${bucket}`,
      tagValue: "tagValues/281481903057166",
      tagValueNamespacedName: "369781862791/storage-isolation/migration-quarantine",
    }] });
  }
  if (parsed.pathname.includes("/denypolicies/")) {
    return response(url, {
      kind: "DenyPolicy",
      name: "policies/cloudresourcemanager.googleapis.com%2Fprojects%2F175298245599/denypolicies/hushh-tech-storage-quarantine",
      displayName: "Hushh Tech UAT storage quarantine isolation",
      rules: [{ denyRule: {
        denialCondition: {
          expression: "resource.matchTag('369781862791/storage-isolation', 'migration-quarantine')",
          title: "Only migration and audit identities may access tagged quarantine objects",
        },
        deniedPermissions: [
          "storage.googleapis.com/objects.create",
          "storage.googleapis.com/objects.delete",
          "storage.googleapis.com/objects.get",
          "storage.googleapis.com/objects.list",
          "storage.googleapis.com/objects.restore",
          "storage.googleapis.com/objects.update",
        ],
        deniedPrincipals: ["principalSet://goog/public:all"],
        exceptionPrincipals: [
          "principal://iam.googleapis.com/projects/-/serviceAccounts/hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com",
          "principal://iam.googleapis.com/projects/-/serviceAccounts/hushh-tech-audit-uat@hushh-tech-uat.iam.gserviceaccount.com",
        ],
      } }],
    });
  }
  if (parsed.pathname === `/storage/v1/b/${bucket}/o`) {
    const isSoftDeleted = parsed.searchParams.get("softDeleted") === "true";
    return response(url, {
      kind: "storage#objects",
      ...(namespaceItem && isSoftDeleted ? { items: [namespaceItem] } : {}),
    });
  }
  if (parsed.pathname.startsWith("/apis/serving.knative.dev/v1/")) {
    return response(url, {
      items: runtimeReference || unknownRuntimeRegion ? [{
        metadata: {
          name: "reader",
          namespace: "hushh-tech-uat",
          labels: {
            "cloud.googleapis.com/location": unknownRuntimeRegion
              ? "europe-west1"
              : "us-central1",
          },
        },
      }] : [],
      metadata: {},
    });
  }
  if (parsed.pathname.startsWith("/apis/run.googleapis.com/v1/")) {
    return response(url, { items: [], metadata: {} });
  }
  if (parsed.pathname.endsWith("/services")) {
    const region = parsed.pathname.includes("asia-south1") ? "asia-south1" : "us-central1";
    return response(url, { services: runtimeReference && region === "us-central1" ? [{
      name: "projects/hushh-tech-uat/locations/us-central1/services/reader",
      template: { containers: [{ env: [{ name: "BUCKET", value: bucket }] }] },
    }] : [] });
  }
  if (parsed.pathname.endsWith("/jobs")) return response(url, { jobs: [] });
  if (parsed.pathname.endsWith("/revisions")) return response(url, { revisions: [] });
  throw new Error(`Unexpected fixed endpoint: ${url}`);
});

describe("fixed seventh-target collector", () => {
  it("collects only fixed read endpoints and returns bounded self-bound evidence", async () => {
    const fetchImpl = fixedFetch();
    const times = [1_777_000_000_000, 1_777_000_000_125];
    const artifact = await collectFixedSeventhTargetPreflight({
      client: new FixedSeventhTargetReadClient({ fetchImpl }),
      seventhSource: source(),
      now: () => times.shift()!,
    });

    expect(artifact.collectionDurationMs).toBe(125);
    expect(artifact.capturedAt).toBe(artifact.collectionCompletedAt);
    expect(artifact.namespaceObjectCount).toBe(0);
    expect(artifact.runtimeRoutingReferenceCount).toBe(0);
    expect(artifact.bucketIamExact).toBe(true);
    expect(artifact.preflightDigestSha256).toBe(
      calculateSelfBoundDigest(artifact, "preflightDigestSha256"),
    );
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).startsWith("http://metadata"))).toHaveLength(1);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("versions=true"))).toBe(true);
    expect(urls.some((url) => url.includes("softDeleted=true"))).toBe(true);
    expect(urls.filter((url) => url.includes("run.googleapis.com/")).length).toBe(6);
  });

  it("rejects the current objectAdmin writer as create-only IAM drift", async () => {
    await expect(collectFixedSeventhTargetPreflight({
      client: new FixedSeventhTargetReadClient({ fetchImpl: fixedFetch({ objectAdmin: true }) }),
      seventhSource: source(),
      now: 1_777_000_000_000,
    })).rejects.toMatchObject({ code: "QUARANTINE_WRITER_ROLE_DRIFT" });
  });

  it("rejects any soft-deleted generation in the exact namespace", async () => {
    const namespace = SEVEN_BUCKET_CONTRACT.seventh.targetPrefix;
    await expect(collectFixedSeventhTargetPreflight({
      client: new FixedSeventhTargetReadClient({ fetchImpl: fixedFetch({
        namespaceItem: {
          bucket,
          name: `${namespace}/blocked`,
          generation: "17",
          size: "1",
          softDeleteTime: "2026-08-22T00:00:00Z",
        },
      }) }),
      seventhSource: source(),
      now: 1_777_000_000_000,
    })).rejects.toMatchObject({ code: "QUARANTINE_NAMESPACE_NOT_EMPTY" });
  });

  it("rejects Cloud Run service references before producing evidence", async () => {
    await expect(collectFixedSeventhTargetPreflight({
      client: new FixedSeventhTargetReadClient({ fetchImpl: fixedFetch({ runtimeReference: true }) }),
      seventhSource: source(),
      now: 1_777_000_000_000,
    })).rejects.toMatchObject({ code: "QUARANTINE_RUNTIME_REFERENCE_ACTIVE" });
  });

  it("fails closed when global Cloud Run discovery finds an unscanned region", async () => {
    await expect(collectFixedSeventhTargetPreflight({
      client: new FixedSeventhTargetReadClient({
        fetchImpl: fixedFetch({ unknownRuntimeRegion: true }),
      }),
      seventhSource: source(),
      now: 1_777_000_000_000,
    })).rejects.toMatchObject({ code: "QUARANTINE_RUNTIME_REGION_DRIFT" });
  });

  it("rejects a collection that exceeds the five-minute wall-clock bound", async () => {
    const times = [1_777_000_000_000, 1_777_000_300_001];
    await expect(collectFixedSeventhTargetPreflight({
      client: new FixedSeventhTargetReadClient({ fetchImpl: fixedFetch() }),
      seventhSource: source(),
      now: () => times.shift()!,
    })).rejects.toMatchObject({ code: "QUARANTINE_COLLECTION_DURATION_INVALID" });
  });
});
