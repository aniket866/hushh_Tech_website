import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GcpDeleteAccountStorageAdapter,
  __testing,
  buildGcpDeleteAccountStorageBindingDigest,
  createGcpDeleteAccountStorageAdapterFromEnv,
  createMetadataServerTokenProvider,
} from "../api/shared/gcp-delete-account-storage.js";

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const emptyResponse = (status: number) => new Response(null, { status });

const createMigrationObject = ({
  sourceBucket = "hushh-ai-media",
  sourceObjectKey = "user-123/media.png",
  sourceBytes = "immutable-source-bytes",
  sizeBytes = Buffer.byteLength(sourceBytes),
  contentType = "image/png",
  sourceUpdatedAt = "2026-08-22T00:00:00.000Z",
  sourceCacheControl = null as string | null,
  generation = "101",
} = {}) => {
  const sourceSha256 = sha256(sourceBytes);
  const objectId = sha256(`${sourceBucket}\0${sourceObjectKey}`);
  const sourceFingerprintSha256 = sha256(__testing.canonicalJson({
    bucketId: sourceBucket,
    objectKey: sourceObjectKey,
    sizeBytes,
    mimeType: contentType,
    sourceUpdatedAt,
    cacheControl: sourceCacheControl,
    sha256: sourceSha256,
  }));
  const targetBucket = __testing.UAT_BUCKETS[sourceBucket].targetBucket;
  const targetObjectName =
    `${__testing.MIGRATION_NAMESPACE}/${sourceBucket}/${objectId}/${sourceFingerprintSha256}`;
  return {
    bucket: targetBucket,
    name: targetObjectName,
    generation,
    size: String(sizeBytes),
    contentType,
    cacheControl: "private, no-store",
    crc32c: "AAAAAA==",
    md5Hash: "AAAAAAAAAAAAAAAAAAAAAA==",
    metadata: {
      "hushh-migration-schema": "supabase-cutover-v1",
      "hushh-source-bucket": sourceBucket,
      "hushh-source-object-id": objectId,
      "hushh-source-fingerprint": sourceFingerprintSha256,
      "hushh-source-object-key-b64": Buffer.from(sourceObjectKey).toString("base64"),
      "hushh-source-sha256": sourceSha256,
      "hushh-source-updated-at": sourceUpdatedAt,
      "hushh-source-cache-control-b64": sourceCacheControl === null
        ? "-"
        : Buffer.from(sourceCacheControl).toString("base64"),
      "hushh-access-mode": __testing.UAT_BUCKETS[sourceBucket].targetAccessMode,
    },
  };
};

const createAdapter = (fetchImpl: typeof fetch, now = () => "2026-08-22T01:02:03.000Z") => {
  const manifestDigestSha256 = "a".repeat(64);
  const activationDigestSha256 = "b".repeat(64);
  const bindingDigestSha256 = buildGcpDeleteAccountStorageBindingDigest({
    project: "hushh-tech-uat",
    environment: "uat",
    manifestDigestSha256,
    activationDigestSha256,
  });
  return new GcpDeleteAccountStorageAdapter({
    project: "hushh-tech-uat",
    environment: "uat",
    manifestDigestSha256,
    activationDigestSha256,
    bindingDigestSha256,
    fetchImpl,
    tokenProvider: async () => "metadata-access-token-for-uat",
    now,
  });
};

const parseMultipartUpload = (init: RequestInit, targetBucket: string, generation = "700") => {
  const contentType = new Headers(init.headers).get("content-type") || "";
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error("test received a non-multipart tombstone upload");
  const bytes = Buffer.from(init.body as Uint8Array);
  const text = bytes.toString("utf8");
  const metadataStart = text.indexOf("\r\n\r\n") + 4;
  const metadataEnd = text.indexOf(`\r\n--${boundary}`, metadataStart);
  const secondHeaderEnd = text.indexOf("\r\n\r\n", metadataEnd + 2) + 4;
  const bodyEnd = text.lastIndexOf(`\r\n--${boundary}--`);
  if (
    metadataStart < 4 ||
    metadataEnd < metadataStart ||
    secondHeaderEnd < 4 ||
    bodyEnd < secondHeaderEnd
  ) {
    throw new Error("test received a malformed multipart tombstone upload");
  }
  const objectMetadata = JSON.parse(text.slice(metadataStart, metadataEnd));
  const bodyBytes = bytes.subarray(secondHeaderEnd, bodyEnd);
  return {
    bodyBytes,
    createdObject: {
      ...objectMetadata,
      bucket: targetBucket,
      generation,
      size: String(bodyBytes.length),
      md5Hash: createHash("md5").update(bodyBytes).digest("base64"),
    },
  };
};

describe("GCP delete-account storage adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is default-off and requires an exact activation binding", () => {
    expect(() => createGcpDeleteAccountStorageAdapterFromEnv({})).toThrowError(
      expect.objectContaining({ code: "GCP_DELETE_ACCOUNT_STORAGE_DISABLED" })
    );

    expect(() => new GcpDeleteAccountStorageAdapter({
      project: "hushh-tech-uat",
      environment: "uat",
      manifestDigestSha256: "a".repeat(64),
      activationDigestSha256: "b".repeat(64),
      bindingDigestSha256: "c".repeat(64),
    })).toThrowError(expect.objectContaining({ code: "GCP_STORAGE_NOT_RECONCILED" }));
  });

  it("lists only exact immutable GCS migration objects under the requested source prefix", async () => {
    const included = createMigrationObject();
    const excluded = createMigrationObject({ sourceObjectKey: "other-user/media.png" });
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://storage.googleapis.com");
      expect(init?.method).toBe("GET");
      expect(url.searchParams.get("prefix")).toBe(
        `${__testing.MIGRATION_NAMESPACE}/hushh-ai-media/`
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer metadata-access-token-for-uat"
      );
      return jsonResponse({ items: [excluded, included] });
    }) as typeof fetch;

    const objects = await createAdapter(fetchMock).listSourcePrefix(
      "hushh-ai-media",
      "user-123"
    );

    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({
      sourceObjectKey: "user-123/media.png",
      targetBucket: "hushh-tech-ai-media-uat",
      generation: "101",
    });
  });

  it("rejects added provenance fields and fingerprint drift", async () => {
    const extraField = createMigrationObject();
    extraField.metadata["unexpected-field"] = "unsafe";
    const fingerprintDrift = createMigrationObject({ sourceObjectKey: "user-123/other.png" });
    fingerprintDrift.size = String(Number(fingerprintDrift.size) + 1);
    const responses = [extraField, fingerprintDrift];
    const fetchMock = vi.fn(async () => jsonResponse({ items: [responses.shift()] })) as typeof fetch;
    const adapter = createAdapter(fetchMock);

    await expect(adapter.listSourcePrefix("hushh-ai-media", "user-123")).rejects.toMatchObject({
      code: "GCP_STORAGE_METADATA_INVALID",
    });
    await expect(adapter.listSourcePrefix("hushh-ai-media", "user-123")).rejects.toMatchObject({
      code: "GCP_STORAGE_METADATA_INVALID",
    });
  });

  it("rejects duplicate target versions and cyclic pagination tokens", async () => {
    const object = createMigrationObject();
    const duplicateFetch = vi.fn(async () => jsonResponse({ items: [object, object] })) as typeof fetch;
    await expect(createAdapter(duplicateFetch).listSourcePrefix("hushh-ai-media", ""))
      .rejects.toMatchObject({ code: "GCP_STORAGE_LIST_INVALID" });

    const cyclicFetch = vi.fn(
      async () => jsonResponse({ items: [], nextPageToken: "repeat" })
    ) as typeof fetch;
    await expect(createAdapter(cyclicFetch).listSourcePrefix("hushh-ai-media", ""))
      .rejects.toMatchObject({ code: "GCP_STORAGE_PAGE_TOKEN_INVALID" });
    expect(cyclicFetch).toHaveBeenCalledTimes(2);
  });

  it("creates a private create-only tombstone before deleting every immutable version", async () => {
    const sourceObjectKey = "user-123/media.png";
    const versions = [
      createMigrationObject({ sourceObjectKey, sourceBytes: "version-one", generation: "101" }),
      createMigrationObject({ sourceObjectKey, sourceBytes: "version-two", generation: "202" }),
    ];
    const calls: Array<{ method: string; url: URL; body?: Buffer }> = [];
    let tombstoneGeneration = 700;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      if (method === "GET") return jsonResponse({ items: versions });
      if (method === "POST") {
        const parsed = parseMultipartUpload(
          init || {},
          "hushh-tech-ai-media-uat",
          String(tombstoneGeneration++)
        );
        calls.push({ method, url, body: parsed.bodyBytes });
        expect(url.searchParams.get("uploadType")).toBe("multipart");
        expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
        expect(parsed.createdObject.cacheControl).toBe("private, no-store");
        expect(parsed.bodyBytes.toString("utf8")).not.toContain(sourceObjectKey);
        return jsonResponse(parsed.createdObject);
      }
      calls.push({ method, url });
      return emptyResponse(204);
    }) as typeof fetch;

    const deleted = await createAdapter(fetchMock).deleteSourcePaths(
      "hushh-ai-media",
      [sourceObjectKey]
    );

    expect(deleted).toBe(2);
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE", "POST", "DELETE"]);
    expect(calls.filter((call) => call.method === "POST").map((call) => call.url.pathname))
      .toHaveLength(2);
    expect(calls.filter((call) => call.method === "DELETE").map((call) =>
      call.url.searchParams.get("ifGenerationMatch")))
      .toEqual(["101", "202"]);
  });

  it("never deletes when create-only tombstone creation fails", async () => {
    const object = createMigrationObject();
    const methods: string[] = [];
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const method = init?.method || "GET";
      methods.push(method);
      if (method === "GET") return jsonResponse({ items: [object] });
      return emptyResponse(500);
    }) as typeof fetch;

    await expect(createAdapter(fetchMock).deleteSourcePaths(
      "hushh-ai-media",
      ["user-123/media.png"]
    )).rejects.toMatchObject({ code: "GCP_STORAGE_TOMBSTONE_FAILED" });
    expect(methods).toEqual(["GET", "POST"]);
  });

  it("is idempotent when a requested source path has no live immutable version", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] })) as typeof fetch;
    await expect(createAdapter(fetchMock).deleteSourcePaths(
      "hushh-ai-media",
      ["user-123/already-absent.png"]
    )).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails on a generation race after recording the tombstone", async () => {
    const object = createMigrationObject();
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      methods.push(method);
      if (method === "GET") return jsonResponse({ items: [object] });
      if (method === "POST") {
        return jsonResponse(parseMultipartUpload(init || {}, object.bucket).createdObject);
      }
      expect(url.searchParams.get("ifGenerationMatch")).toBe("101");
      return emptyResponse(412);
    }) as typeof fetch;

    await expect(createAdapter(fetchMock).deleteSourcePaths(
      "hushh-ai-media",
      ["user-123/media.png"]
    )).rejects.toMatchObject({ code: "GCP_STORAGE_GENERATION_CHANGED" });
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });

  it("accepts only a byte- and metadata-bound tombstone replay", async () => {
    const object = createMigrationObject();
    let replay: ReturnType<typeof parseMultipartUpload> | null = null;
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      methods.push(method);
      if (method === "GET" && url.pathname.endsWith("/o")) {
        return jsonResponse({ items: [object] });
      }
      if (method === "POST") {
        replay = parseMultipartUpload(init || {}, object.bucket, "707");
        return emptyResponse(412);
      }
      if (method === "GET" && url.pathname.startsWith("/storage/v1/")) {
        return jsonResponse(replay!.createdObject);
      }
      if (method === "GET" && url.pathname.startsWith("/download/storage/v1/")) {
        expect(url.searchParams.get("generation")).toBe("707");
        return new Response(replay!.bodyBytes, { status: 200 });
      }
      return emptyResponse(204);
    }) as typeof fetch;

    await expect(createAdapter(fetchMock).deleteSourcePaths(
      "hushh-ai-media",
      ["user-123/media.png"]
    )).resolves.toBe(1);
    expect(methods).toEqual(["GET", "POST", "GET", "GET", "DELETE"]);
  });

  it("rejects a forged tombstone replay and performs no delete", async () => {
    const object = createMigrationObject();
    let replay: ReturnType<typeof parseMultipartUpload> | null = null;
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      methods.push(method);
      if (method === "GET" && url.pathname.endsWith("/o")) {
        return jsonResponse({ items: [object] });
      }
      if (method === "POST") {
        replay = parseMultipartUpload(init || {}, object.bucket, "808");
        return emptyResponse(412);
      }
      if (method === "GET" && url.pathname.startsWith("/storage/v1/")) {
        return jsonResponse(replay!.createdObject);
      }
      if (method === "GET" && url.pathname.startsWith("/download/storage/v1/")) {
        const forged = Buffer.from(replay!.bodyBytes);
        forged[forged.length - 2] = forged[forged.length - 2] === 48 ? 49 : 48;
        return new Response(forged, { status: 200 });
      }
      return emptyResponse(204);
    }) as typeof fetch;

    await expect(createAdapter(fetchMock).deleteSourcePaths(
      "hushh-ai-media",
      ["user-123/media.png"]
    )).rejects.toMatchObject({ code: "GCP_STORAGE_TOMBSTONE_COLLISION" });
    expect(methods).toEqual(["GET", "POST", "GET", "GET"]);
  });

  it("blocks unknown buckets, unsafe paths, and non-GCS endpoints before network access", async () => {
    const fetchMock = vi.fn() as typeof fetch;
    const adapter = createAdapter(fetchMock);

    await expect(adapter.listSourcePrefix("unknown", "user-123")).rejects.toMatchObject({
      code: "GCP_STORAGE_BUCKET_BLOCKED",
    });
    await expect(adapter.listSourcePrefix("hushh-ai-media", "../user-123")).rejects.toMatchObject({
      code: "GCP_STORAGE_SOURCE_PATH_INVALID",
    });
    await expect(adapter.request("https://example.invalid/storage/v1/b/x/o"))
      .rejects.toMatchObject({ code: "GCP_STORAGE_ENDPOINT_BLOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the Cloud Run metadata identity and caches its bounded access token", async () => {
    let now = 1_000;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
      );
      expect(new Headers(init?.headers).get("metadata-flavor")).toBe("Google");
      return jsonResponse({ access_token: "metadata-token-with-safe-length", expires_in: 300 });
    }) as typeof fetch;
    const provider = createMetadataServerTokenProvider({ fetchImpl: fetchMock, now: () => now });

    await expect(provider()).resolves.toBe("metadata-token-with-safe-length");
    now += 1_000;
    await expect(provider()).resolves.toBe("metadata-token-with-safe-length");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the active delete-account runtime free of Supabase Storage and function fallbacks", () => {
    const runtimeFiles = ["api/delete-account-service.js", "api/delete-account.js"];
    const forbidden = [
      "/storage" + "/v1",
      ".storage" + ".from",
      "/functions" + "/v1/delete-user-account",
    ];

    for (const file of runtimeFiles) {
      const source = readFileSync(file, "utf8");
      for (const marker of forbidden) expect(source).not.toContain(marker);
    }
  });
});
