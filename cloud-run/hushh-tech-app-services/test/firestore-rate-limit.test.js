import assert from "node:assert/strict";
import test from "node:test";

import {
  createFirestoreSharedRateLimiter,
  FIRESTORE_RATE_LIMIT_CONTRACT,
  verifyFirestoreIndexContract,
} from "../src/firestore-rate-limit.js";
import {
  consumeSharedRateLimit,
  verifySharedRateLimiter,
} from "../src/shared-rate-limit.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

function config(overrides = {}) {
  return {
    projectId: "hushh-tech-uat",
    serviceOwner: "investor-api",
    ...overrides,
  };
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function createFakeFirestore({ fail = null } = {}) {
  const documents = new Map();
  let queue = Promise.resolve();
  let transactionCount = 0;

  function reference(collection, id) {
    return Object.freeze({ path: `${collection}/${id}` });
  }

  function runTransaction(work) {
    const execute = queue.then(async () => {
      transactionCount += 1;
      if (fail) throw fail;
      const writes = [];
      const transaction = {
        async get(ref) {
          const data = documents.get(ref.path);
          return {
            exists: data !== undefined,
            data: () => clone(data),
          };
        },
        create(ref, value) {
          if (documents.has(ref.path)) throw new Error("already exists");
          writes.push({ kind: "create", path: ref.path, value: clone(value) });
        },
        set(ref, value) {
          writes.push({ kind: "set", path: ref.path, value: clone(value) });
        },
        update(ref, value) {
          if (!documents.has(ref.path)) throw new Error("not found");
          writes.push({ kind: "update", path: ref.path, value: clone(value) });
        },
      };
      const result = await work(transaction);
      for (const write of writes) {
        if (write.kind === "update") {
          documents.set(write.path, {
            ...documents.get(write.path),
            ...write.value,
          });
        } else {
          documents.set(write.path, write.value);
        }
      }
      return result;
    });
    queue = execute.catch(() => {});
    return execute;
  }

  return {
    documents,
    get transactionCount() {
      return transactionCount;
    },
    collection(name) {
      return { doc: (id) => reference(name, id) };
    },
    runTransaction,
  };
}

function onlyBucketRecord(store) {
  const records = [...store.documents.values()].filter(
    (record) => record.bucket_key_sha256,
  );
  assert.equal(records.length, 1);
  return records[0];
}

function explicitField(name, overrides = {}) {
  const databaseId = FIRESTORE_RATE_LIMIT_CONTRACT.serviceDatabases["investor-api"];
  return {
    name:
      `projects/hushh-tech-uat/databases/${databaseId}` +
      `/collectionGroups/${FIRESTORE_RATE_LIMIT_CONTRACT.collection}/fields/${name}`,
    indexConfig: {
      ancestorField:
        `projects/hushh-tech-uat/databases/${databaseId}` +
        "/collectionGroups/__default__/fields/*",
    },
    ...(name === FIRESTORE_RATE_LIMIT_CONTRACT.ttlField
      ? { ttlConfig: { state: "ACTIVE" } }
      : {}),
    ...overrides,
  };
}

function exactFieldResponse() {
  return {
    fields: FIRESTORE_RATE_LIMIT_CONTRACT.unindexedFields.map((name) =>
      explicitField(name),
    ),
  };
}

test("Firestore limiter atomically enforces a fixed cross-instance budget", async () => {
  const firestore = createFakeFirestore();
  const firstInstance = createFirestoreSharedRateLimiter({
    config: config(),
    firestore,
    now: () => 120_500,
  });
  const secondInstance = createFirestoreSharedRateLimiter({
    config: config(),
    firestore,
    now: () => 120_500,
  });

  const [first, second] = await Promise.all([
    firstInstance.consume({ key: KEY_A, limit: 1, windowMs: 60_000 }),
    secondInstance.consume({ key: KEY_A, limit: 1, windowMs: 60_000 }),
  ]);

  assert.deepEqual(
    [first.allowed, second.allowed].sort(),
    [false, true],
  );
  assert.equal(onlyBucketRecord(firestore).count, 2);
  const saturatedInstance = first.allowed ? secondInstance : firstInstance;
  const deniedAgain = await saturatedInstance.consume({
    key: KEY_A,
    limit: 1,
    windowMs: 60_000,
  });
  assert.equal(deniedAgain.allowed, false);
  assert.equal(onlyBucketRecord(firestore).count, 2);
  assert.equal(firestore.transactionCount, 2);
});

test("keys, owners, windows, and limits cannot share a bucket", async () => {
  const firestore = createFakeFirestore();
  let timestamp = 1_000;
  const investor = createFirestoreSharedRateLimiter({
    config: config(),
    firestore,
    now: () => timestamp,
  });
  const identity = createFirestoreSharedRateLimiter({
    config: config({ serviceOwner: "identity-api" }),
    firestore,
    now: () => timestamp,
  });

  for (const input of [
    { limiter: investor, key: KEY_A, limit: 2 },
    { limiter: investor, key: KEY_B, limit: 2 },
    { limiter: identity, key: KEY_A, limit: 2 },
    { limiter: investor, key: KEY_A, limit: 3 },
  ]) {
    const result = await input.limiter.consume({
      key: input.key,
      limit: input.limit,
      windowMs: 60_000,
    });
    assert.equal(result.allowed, true);
  }
  timestamp = 61_000;
  assert.equal(
    (
      await investor.consume({ key: KEY_A, limit: 2, windowMs: 60_000 })
    ).allowed,
    true,
  );
  const bucketRecords = [...firestore.documents.values()].filter(
    (record) => record.bucket_key_sha256,
  );
  assert.equal(bucketRecords.length, 5);
});

test("stored records contain hashes and bounded metadata only", async () => {
  const firestore = createFakeFirestore();
  const limiter = createFirestoreSharedRateLimiter({
    config: config(),
    firestore,
    now: () => 120_500,
  });
  await limiter.consume({ key: KEY_A, limit: 5, windowMs: 60_000 });
  const record = onlyBucketRecord(firestore);

  assert.deepEqual(Object.keys(record).sort(), [
    "bucket_key_sha256",
    "count",
    "created_at",
    "expires_at",
    "limit",
    "reset_at_ms",
    "schema_version",
    "service_owner",
    "updated_at",
    "window_ms",
    "window_start_ms",
  ]);
  assert.equal(record.bucket_key_sha256, KEY_A);
  assert.equal(record.window_start_ms, 120_000);
  assert.equal(record.reset_at_ms, 180_000);
  assert.equal(record.expires_at.getTime(), 480_000);
  assert.equal(JSON.stringify(record).includes("firebase"), false);
  assert.equal(JSON.stringify(record).includes("Bearer"), false);
});

test("readiness proves transactional read and write and is briefly cached", async () => {
  const firestore = createFakeFirestore();
  let timestamp = 10_000;
  const indexChecks = [];
  const limiter = createFirestoreSharedRateLimiter({
    config: config(),
    firestore,
    now: () => timestamp,
    verifyIndexContract: async (input) => {
      indexChecks.push(input);
      return true;
    },
  });
  assert.equal(await verifySharedRateLimiter(limiter), true);
  assert.equal(firestore.transactionCount, 1);
  assert.equal(await verifySharedRateLimiter(limiter), true);
  assert.equal(firestore.transactionCount, 1);
  timestamp += FIRESTORE_RATE_LIMIT_CONTRACT.readinessCacheMs;
  assert.equal(await verifySharedRateLimiter(limiter), true);
  assert.equal(firestore.transactionCount, 2);
  assert.equal(indexChecks.length, 2);
  assert.deepEqual(
    indexChecks.map(({ projectId, databaseId }) => ({ projectId, databaseId })),
    [
      {
        projectId: "hushh-tech-uat",
        databaseId: "hushh-tech-rate-investor",
      },
      {
        projectId: "hushh-tech-uat",
        databaseId: "hushh-tech-rate-investor",
      },
    ],
  );

  const readiness = [...firestore.documents.values()].find(
    (record) => !record.bucket_key_sha256,
  );
  assert.equal(readiness.schema_version, 1);
  assert.equal(readiness.service_owner, "investor-api");
});

test("readiness verifies the exact explicit field exemptions and active TTL", async () => {
  const requests = [];
  const getAccessToken = async () => "metadata-token";
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => exactFieldResponse() };
  };

  assert.equal(
    await verifyFirestoreIndexContract({
      projectId: "hushh-tech-uat",
      databaseId: "hushh-tech-rate-investor",
      fetchImpl,
      getAccessToken,
    }),
    true,
  );
  assert.deepEqual(requests, [
    {
      url:
        "https://firestore.googleapis.com/v1/projects/hushh-tech-uat" +
        "/databases/hushh-tech-rate-investor/collectionGroups/" +
        `${FIRESTORE_RATE_LIMIT_CONTRACT.collection}/fields` +
        "?filter=indexConfig.usesAncestorConfig%3Afalse%20OR%20ttlConfig%3A*",
      options: {
        method: "GET",
        headers: { Authorization: "Bearer metadata-token" },
        redirect: "error",
        signal: requests[0].options.signal,
      },
    },
  ]);
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
});

test("index readiness rejects missing, indexed, reverting, paged, and weak TTL evidence", async () => {
  const cases = [
    { fields: exactFieldResponse().fields.slice(1) },
    { ...exactFieldResponse(), nextPageToken: "more" },
    {
      fields: exactFieldResponse().fields.map((field, index) =>
        index === 0
          ? {
              ...field,
              indexConfig: { ...field.indexConfig, indexes: [{}] },
            }
          : field,
      ),
    },
    {
      fields: exactFieldResponse().fields.map((field, index) =>
        index === 0
          ? {
              ...field,
              indexConfig: {
                ...field.indexConfig,
                usesAncestorConfig: true,
              },
            }
          : field,
      ),
    },
    {
      fields: exactFieldResponse().fields.map((field, index) =>
        index === 0
          ? {
              ...field,
              indexConfig: {
                ...field.indexConfig,
                ancestorField: "projects/other/databases/other/fields/*",
              },
            }
          : field,
      ),
    },
    {
      fields: exactFieldResponse().fields.map((field, index) =>
        index === 0
          ? {
              ...field,
              indexConfig: { ...field.indexConfig, reverting: true },
            }
          : field,
      ),
    },
    {
      fields: exactFieldResponse().fields.map((field) =>
        field.name.endsWith("/expires_at")
          ? { ...field, ttlConfig: { state: "CREATING" } }
          : field,
      ),
    },
    {
      fields: exactFieldResponse().fields.map((field) =>
        field.name.endsWith("/count")
          ? { ...field, ttlConfig: { state: "ACTIVE" } }
          : field,
      ),
    },
  ];

  for (const body of cases) {
    await assert.rejects(
      verifyFirestoreIndexContract({
        projectId: "hushh-tech-uat",
        databaseId: "hushh-tech-rate-investor",
        fetchImpl: async () => ({ ok: true, json: async () => body }),
        getAccessToken: async () => "metadata-token",
      }),
      /contract drifted/,
    );
  }

  await assert.rejects(
    verifyFirestoreIndexContract({
      projectId: "hushh-tech-uat",
      databaseId: "hushh-tech-rate-investor",
      fetchImpl: async () => ({ ok: false }),
      getAccessToken: async () => "metadata-token",
    }),
    /contract is unavailable/,
  );
});

test("invalid configuration, requests, corrupt state, and store failures fail closed", async () => {
  const firestore = createFakeFirestore();
  assert.throws(
    () =>
      createFirestoreSharedRateLimiter({
        config: config({ projectId: "untrusted-project" }),
        firestore,
      }),
    /authority is not configured/,
  );
  const limiter = createFirestoreSharedRateLimiter({
    config: config(),
    firestore,
    now: () => 1_000,
  });
  for (const input of [
    { key: "raw-user-id", limit: 1, windowMs: 60_000 },
    { key: KEY_A, limit: 0, windowMs: 60_000 },
    { key: KEY_A, limit: 1, windowMs: 999 },
  ]) {
    await assert.rejects(limiter.consume(input), /request is invalid/);
  }

  await limiter.consume({ key: KEY_A, limit: 2, windowMs: 60_000 });
  const path = [...firestore.documents.keys()].find((candidate) =>
    candidate.startsWith(`${FIRESTORE_RATE_LIMIT_CONTRACT.collection}/`),
  );
  firestore.documents.get(path).count = "corrupt";
  await assert.rejects(
    consumeSharedRateLimit(limiter, {
      key: KEY_A,
      limit: 2,
      windowMs: 60_000,
    }),
    (error) => error.code === "SHARED_RATE_LIMIT_UNAVAILABLE",
  );

  const unavailable = createFirestoreSharedRateLimiter({
    config: config(),
    firestore: createFakeFirestore({ fail: new Error("backend detail") }),
  });
  await assert.rejects(
    verifySharedRateLimiter(unavailable),
    (error) =>
      error.code === "SHARED_RATE_LIMIT_UNAVAILABLE" &&
      error.message === "Service unavailable.",
  );
});

test("deadline aborts are preserved while the store operation stays conservative", async () => {
  let release;
  let writes = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const firestore = {
    collection: (name) => ({ doc: (id) => ({ path: `${name}/${id}` }) }),
    runTransaction: async (work) => {
      await pending;
      return work({
        get: async () => ({ exists: false, data: () => undefined }),
        create: () => {
          writes += 1;
        },
      });
    },
  };
  const limiter = createFirestoreSharedRateLimiter({
    config: config(),
    firestore,
    now: () => 1_000,
  });
  const controller = new AbortController();
  const reason = new Error("deadline");
  const operation = consumeSharedRateLimit(limiter, {
    key: KEY_A,
    limit: 1,
    windowMs: 60_000,
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(operation, (error) => error === reason);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("readiness times out while its idempotent TTL marker may finish conservatively", async () => {
  const documents = new Map();
  let releaseCommit;
  let markQueued;
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  const queued = new Promise((resolve) => {
    markQueued = resolve;
  });
  const firestore = {
    collection: (name) => ({ doc: (id) => ({ path: `${name}/${id}` }) }),
    runTransaction: async (work) => {
      const writes = [];
      const result = await work({
        get: async () => ({ exists: false, data: () => undefined }),
        set: (reference, value) => {
          writes.push({ reference, value: clone(value) });
        },
      });
      markQueued();
      await commitGate;
      for (const write of writes) {
        documents.set(write.reference.path, write.value);
      }
      return result;
    },
  };
  const controller = new AbortController();
  const limiter = createFirestoreSharedRateLimiter({
    config: config(),
    firestore,
    now: () => 1_000,
    verifyIndexContract: async () => true,
    createReadinessSignal: () => controller.signal,
  });
  const operation = verifySharedRateLimiter(limiter);

  await queued;
  controller.abort(new Error("readiness deadline"));
  await assert.rejects(
    operation,
    (error) => error.code === "SHARED_RATE_LIMIT_UNAVAILABLE",
  );
  releaseCommit();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(documents.size, 1);
  const marker = [...documents.values()][0];
  assert.deepEqual(Object.keys(marker).sort(), [
    "expires_at",
    "schema_version",
    "service_owner",
    "verified_at",
  ]);
  assert.equal(marker.service_owner, "investor-api");
});

test("an already queued Firestore commit may conservatively consume only a hashed token", async () => {
  const documents = new Map();
  let releaseCommit;
  let markQueued;
  let commits = 0;
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  const queued = new Promise((resolve) => {
    markQueued = resolve;
  });
  const firestore = {
    collection: (name) => ({ doc: (id) => ({ path: `${name}/${id}` }) }),
    runTransaction: async (work) => {
      const writes = [];
      const result = await work({
        get: async () => ({ exists: false, data: () => undefined }),
        create: (reference, value) => {
          writes.push({ reference, value: clone(value) });
        },
      });
      markQueued();
      await commitGate;
      for (const write of writes) {
        documents.set(write.reference.path, write.value);
      }
      commits += 1;
      return result;
    },
  };
  const limiter = createFirestoreSharedRateLimiter({
    config: config(),
    firestore,
    now: () => 1_000,
  });
  const controller = new AbortController();
  const reason = new Error("deadline");
  const operation = consumeSharedRateLimit(limiter, {
    key: KEY_A,
    limit: 1,
    windowMs: 60_000,
    signal: controller.signal,
  });

  await queued;
  controller.abort(reason);
  await assert.rejects(operation, (error) => error === reason);
  releaseCommit();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(commits, 1);
  assert.equal(documents.size, 1);
  const record = [...documents.values()][0];
  assert.equal(record.bucket_key_sha256, KEY_A);
  assert.equal(JSON.stringify(record).includes("Bearer"), false);
  assert.equal(JSON.stringify(record).includes("firebase"), false);
});

test("the Firestore storage contract is exact", () => {
  assert.deepEqual(FIRESTORE_RATE_LIMIT_CONTRACT, {
    projectIds: ["hushh-tech-uat", "hushh-tech-prod"],
    serviceDatabases: {
      "investor-api": "hushh-tech-rate-investor",
      "identity-api": "hushh-tech-rate-identity",
      "financial-api": "hushh-tech-rate-financial",
      "content-api": "hushh-tech-rate-content",
      "engagement-api-worker": "hushh-tech-rate-engagement",
      "signed-webhook-service": "hushh-tech-runtime",
      worker: "hushh-tech-rate-worker",
    },
    collection: "hushh_tech_shared_rate_limits_v1",
    schemaVersion: 1,
    ttlField: "expires_at",
    readinessCacheMs: 60_000,
    metadataTimeoutMs: 5_000,
    saturatedCacheMax: 5_000,
    unindexedFields: [
      "bucket_key_sha256",
      "count",
      "created_at",
      "expires_at",
      "limit",
      "reset_at_ms",
      "schema_version",
      "service_owner",
      "updated_at",
      "verified_at",
      "window_ms",
      "window_start_ms",
    ],
  });
});
