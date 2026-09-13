import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeError } from "../src/errors.js";
import {
  createCloudKmsEnvelope,
  createCloudTasksSyncQueue,
  createFinancialRepository,
  createFinancialLinkRuntime,
} from "../src/financial/gcp-runtime.js";
import { PLAID_BACKGROUND_PRODUCTS } from "../src/financial/plaid-client.js";

const KMS_KEY =
  "projects/hushh-tech-uat/locations/us-central1/keyRings/hushh-tech-cutover-uat/cryptoKeys/plaid-access-token";
const TASK_QUEUE =
  "projects/hushh-tech-uat/locations/us-central1/queues/financial-sync";
const WORKER_AUDIENCE =
  "https://hushh-tech-worker-175298245599.us-central1.run.app";
const TASK_RUNNER =
  "hushh-tech-task-runner-uat@hushh-tech-uat.iam.gserviceaccount.com";

function runtimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
  return true;
}

function response({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

function decodeBase64(value) {
  return globalThis.atob(value);
}

function encodeBase64(value) {
  return globalThis.btoa(value);
}

function configuredRuntime({ database = null } = {}) {
  return createFinancialLinkRuntime({
    config: {
      serviceOwner: "financial-api",
      stage: "uat",
      firebaseProjectId: "hushh-tech-uat",
      financial: {
        enabled: true,
        plaidClientId: "sandbox-client-id",
        plaidSecret: "sandbox-private-secret",
        plaidEnvironment: "sandbox",
        plaidPrimaryProducts: "transfer",
        plaidAdditionalConsentedProducts: null,
        plaidRequiredIfSupportedProducts: null,
        kmsKey: KMS_KEY,
        taskQueue: TASK_QUEUE,
        workerAudience: WORKER_AUDIENCE,
        taskRunnerServiceAccount: TASK_RUNNER,
        allowedRedirectOrigin: "https://uat.hushhtech.com",
      },
    },
    database: database ?? {
      firebaseUid: "firebase-user-001",
      async transaction(work) {
        return work({ query: async () => ({ rows: [] }) });
      },
      async serializableTransaction(work) {
        return work({ query: async () => ({ rows: [] }) });
      },
    },
    actor: { kind: "firebase", uid: "firebase-user-001", email: "user@example.test" },
    firebaseAuth: {
      async getUser() {
        return { email: "user@example.test" };
      },
    },
    getAccessToken: async () => "google-service-access-token",
    fetchImpl: async () => response(),
  });
}

test("Cloud KMS envelopes bind Plaid plaintext to the exact caller-owned context", async () => {
  const calls = [];
  const plaintext = "access-sandbox-never-persisted";
  const envelope = createCloudKmsEnvelope({
    kmsKey: KMS_KEY,
    getAccessToken: async () => "google-service-access-token",
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      calls.push({ url, payload, authorization: options.headers.authorization });
      if (url.endsWith(":encrypt")) {
        assert.equal(decodeBase64(payload.plaintext), plaintext);
        return response({ body: { ciphertext: "kms-ciphertext" } });
      }
      assert.equal(url.endsWith(":decrypt"), true);
      return response({ body: { plaintext: encodeBase64(plaintext) } });
    },
  });
  const context = {
    purpose: "plaid_access_token",
    userId: "b5f0b2f0-9c84-4cac-ae0a-55eb41f680f2",
    plaidItemId: "item-sandbox-1",
  };

  const sealed = await envelope.seal({ plaintext, context });
  assert.match(sealed, /^hushh-kms-v1\./);
  assert.equal(sealed.includes(plaintext), false);
  assert.equal(calls[0].url, `https://cloudkms.googleapis.com/v1/${KMS_KEY}:encrypt`);
  assert.equal(calls[0].authorization, "Bearer google-service-access-token");
  assert.equal(await envelope.open({ envelope: sealed, context }), plaintext);
  await assert.rejects(
    envelope.open({
      envelope: sealed,
      context: { ...context, plaidItemId: "item-forged" },
    }),
    (error) => runtimeCode(error, "TOKEN_ENVELOPE_UNAVAILABLE", 503),
  );
});

test("financial runtime is UAT-only and acknowledges malformed worker work before database or Plaid", async () => {
  const runtime = configuredRuntime();
  assert.equal(runtime.configured, true);
  assert.equal(runtime.financialLinkAdapter.configured, true);

  await assert.rejects(
    runtime.queuedProductSync({
      actor: { kind: "firebase", uid: "firebase-user-001" },
      request: { body: { jobId: "00000000-0000-4000-8000-000000000001" } },
    }),
    (error) => runtimeCode(error, "ACCESS_DENIED", 403),
  );

  assert.throws(
    () =>
      createFinancialLinkRuntime({
        config: {
          serviceOwner: "financial-api",
          stage: "prod",
          firebaseProjectId: "hushh-tech-prod",
          financial: { enabled: true },
        },
        database: {
          firebaseUid: "firebase-user-001",
          transaction: async () => {},
          serializableTransaction: async () => {},
        },
      }),
    (error) => runtimeCode(error, "FINANCIAL_LINK_ADAPTER_UNAVAILABLE", 503),
  );
});

test("financial transaction persistence retains Plaid location data from the source sync", async () => {
  const queries = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql: String(sql), parameters });
      return { rows: [] };
    },
  };
  const database = {
    firebaseUid: "firebase-user-001",
    async transaction(work) {
      return work(client);
    },
    async serializableTransaction(work) {
      return work(client);
    },
  };
  const repository = createFinancialRepository({ database });
  const location = { city: "San Francisco", region: "CA" };

  await repository.upsertTransactions({
    transactions: [
      {
        account_id: "account-sandbox-1",
        transaction_id: "transaction-sandbox-1",
        amount: 12.34,
        iso_currency_code: "USD",
        date: "2026-09-12",
        name: "Source parity purchase",
        category: ["Food and Drink"],
        pending: false,
        payment_channel: "in store",
        transaction_type: "place",
        location,
      },
    ],
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /transaction_type, location/);
  assert.match(queries[0].sql, /location = EXCLUDED\.location/);
  assert.deepEqual(queries[0].parameters.at(-1), JSON.stringify(location));
});

test("anonymous Plaid diagnostics use the scoped no-UID transaction only", async () => {
  const queries = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql: String(sql), parameters });
      return { rows: [] };
    },
  };
  let ownedTransactions = 0;
  let diagnosticsTransactions = 0;
  const repository = createFinancialRepository({
    database: {
      firebaseUid: null,
      async transaction() {
        ownedTransactions += 1;
        throw new Error("anonymous diagnostics must not acquire an owned transaction");
      },
      async serializableTransaction() {
        ownedTransactions += 1;
        throw new Error("anonymous diagnostics must not acquire an owned transaction");
      },
      async diagnosticsTransaction(work) {
        diagnosticsTransactions += 1;
        return work(client);
      },
    },
  });

  await repository.insertPlaidDiagnostic({
    userId: null,
    sessionId: null,
    eventType: "link_opened",
    plaidStep: "mount",
    pageState: {},
    plaidMetadata: {},
    errorDetails: {},
    browserContext: {},
  });

  assert.equal(ownedTransactions, 0);
  assert.equal(diagnosticsTransactions, 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO public\.plaid_link_diagnostics/);
  assert.equal(queries[0].parameters[0], null);
});

test("unresolved authenticated diagnostics fall back to the scoped no-UID transaction", async () => {
  const client = { query: async () => ({ rows: [] }) };
  let ownedTransactions = 0;
  let diagnosticsTransactions = 0;
  const repository = createFinancialRepository({
    database: {
      firebaseUid: "firebase-user-001",
      async transaction() {
        ownedTransactions += 1;
        throw new Error("unresolved diagnostics must not retain the Firebase UID");
      },
      async serializableTransaction() {
        ownedTransactions += 1;
        throw new Error("unresolved diagnostics must not retain the Firebase UID");
      },
      async diagnosticsTransaction(work) {
        diagnosticsTransactions += 1;
        return work(client);
      },
    },
  });

  await repository.insertPlaidDiagnostic({
    userId: null,
    eventType: "link_event",
  });

  assert.equal(ownedTransactions, 0);
  assert.equal(diagnosticsTransactions, 1);
});

test("financial product merge is one atomic product-local SQL conflict update", async () => {
  const queries = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql: String(sql), parameters });
      return { rows: [] };
    },
  };
  const database = {
    firebaseUid: "firebase-user-001",
    async transaction(work) {
      return work(client);
    },
    async serializableTransaction(work) {
      return work(client);
    },
  };
  const repository = createFinancialRepository({ database });

  await repository.mergeFinancialDataProduct({
    userId: "b5f0b2f0-9c84-4cac-ae0a-55eb41f680f2",
    plaidItemId: "item-sandbox-1",
    institutionName: "Test Bank",
    institutionId: "ins_1",
    product: "investments",
    available: true,
    error: null,
    errorCode: null,
    productStatus: "complete",
    patch: { investments: { holdings: [] } },
    updatedAt: "2026-09-12T12:00:00.000Z",
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.match(queries[0].sql, /COALESCE\(existing\.available_products/);
  assert.match(queries[0].sql, /COALESCE\(existing\.fetch_errors/);
  assert.match(queries[0].sql, /ELSE existing\.identity_data END/);
  assert.doesNotMatch(queries[0].sql, /plaid_access_token/);
  assert.deepEqual(JSON.parse(queries[0].parameters[9]), {
    investments: { holdings: [] },
  });
});

test("background product jobs preserve Supabase order when Assets remains pending", async () => {
  const jobIds = [
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000004",
    "10000000-0000-4000-8000-000000000005",
    "10000000-0000-4000-8000-000000000006",
  ];
  const jobs = new Map();
  const outbox = new Map();
  const published = [];
  const userId = "b5f0b2f0-9c84-4cac-ae0a-55eb41f680f2";
  const firebaseUid = "firebase-user-001";
  const plaidItemId = "item-sandbox-1";
  let nextJobId = 0;
  const row = (job) => ({
    id: job.id,
    user_id: job.userId,
    firebase_uid: job.firebaseUid,
    plaid_item_id: job.plaidItemId,
    product: job.product,
    source: job.source,
    state: job.state,
    fencing_token: job.fenceToken,
    lease_expires_at: null,
  });
  const client = {
    async query(sql, parameters = []) {
      const statement = String(sql);
      if (statement.includes("INSERT INTO hushh_financial.sync_jobs")) {
        const [ownerId, ownerUid, itemId, product, source] = parameters;
        const existing = [...jobs.values()].find((job) => (
          job.userId === ownerId &&
          job.plaidItemId === itemId &&
          job.product === product &&
          job.source === source &&
          ["PENDING", "LEASED"].includes(job.state)
        ));
        if (existing) return { rows: [] };
        const job = {
          id: jobIds[nextJobId++],
          userId: ownerId,
          firebaseUid: ownerUid,
          plaidItemId: itemId,
          product,
          source,
          state: "PENDING",
          fenceToken: 0,
        };
        jobs.set(job.id, job);
        return { rows: [row(job)] };
      }
      if (statement.includes("INSERT INTO hushh_financial.sync_outbox")) {
        const [jobId, taskName] = parameters;
        outbox.set(jobId, { taskName, state: "PENDING" });
        return { rows: [] };
      }
      if (statement.includes("SELECT outbox.job_id")) {
        const entry = outbox.get(parameters[0]);
        const job = jobs.get(parameters[0]);
        return entry?.state === "PENDING" && job
          ? { rows: [{ job_id: job.id, task_name: entry.taskName, firebase_uid: job.firebaseUid }] }
          : { rows: [] };
      }
      if (statement.includes("SET state = 'PUBLISHED'")) {
        const entry = outbox.get(parameters[0]);
        if (entry) entry.state = "PUBLISHED";
        return { rows: [] };
      }
      if (statement.includes("SET state = 'COMPLETED'")) {
        const job = jobs.get(parameters[0]);
        if (!job || job.state !== "LEASED" || job.fenceToken !== parameters[1]) {
          return { rows: [] };
        }
        job.state = "COMPLETED";
        return { rows: [{ id: job.id }] };
      }
      if (statement.includes("array_position($5::text[], product) >")) {
        const [ownerId, ownerUid, itemId, source, products, completedProduct] = parameters;
        const completedIndex = products.indexOf(completedProduct);
        const next = [...jobs.values()]
          .filter((job) => (
            job.userId === ownerId &&
            job.firebaseUid === ownerUid &&
            job.plaidItemId === itemId &&
            job.source === source &&
            job.state === "PENDING" &&
            products.indexOf(job.product) > completedIndex
          ))
          .sort((left, right) => products.indexOf(left.product) - products.indexOf(right.product))[0];
        return { rows: next ? [row(next)] : [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
  };
  const database = {
    firebaseUid,
    async transaction(work) {
      return work(client);
    },
    async serializableTransaction(work) {
      return work(client);
    },
  };
  const queue = createCloudTasksSyncQueue({
    config: {
      serviceOwner: "financial-api",
      stage: "uat",
      financial: {
        enabled: true,
        plaidClientId: "sandbox-client-id",
        plaidSecret: "sandbox-private-secret",
        plaidEnvironment: "sandbox",
        plaidPrimaryProducts: "transfer",
        kmsKey: KMS_KEY,
        taskQueue: TASK_QUEUE,
        workerAudience: WORKER_AUDIENCE,
        taskRunnerServiceAccount: TASK_RUNNER,
        allowedRedirectOrigin: "https://uat.hushhtech.com",
      },
    },
    database,
    getAccessToken: async () => "google-service-access-token",
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      published.push(JSON.parse(decodeBase64(payload.task.httpRequest.body)).jobId);
      return response();
    },
  });

  const created = await queue.enqueueProducts({
    firebaseUid,
    userId,
    plaidItemId,
    products: PLAID_BACKGROUND_PRODUCTS,
    source: "plaid-data-sync-start",
  });
  await queue.publishProducts({ jobs: created });
  assert.deepEqual(published, [created[0].jobId]);

  for (const createdJob of created) {
    const stored = jobs.get(createdJob.jobId);
    stored.state = "LEASED";
    stored.fenceToken = 1;
    await queue.completeQueuedProductSyncJob({
      job: { ...createdJob, fenceToken: 1 },
      result: createdJob.product === "assets"
        ? { product: "assets", status: "pending", available: false }
        : { product: createdJob.product, status: "complete", available: true },
    });
  }

  assert.deepEqual(published, created.map((job) => job.jobId));
  assert.deepEqual(
    published.map((jobId) => jobs.get(jobId).product),
    PLAID_BACKGROUND_PRODUCTS,
  );
  assert.deepEqual(
    [...jobs.values()].map((job) => job.state),
    PLAID_BACKGROUND_PRODUCTS.map(() => "COMPLETED"),
  );
});
