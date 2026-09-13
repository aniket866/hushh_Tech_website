import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeError } from "../src/errors.js";
import { PlaidApiError } from "../src/financial/plaid-client.js";
import {
  assertFunctionRequestContract,
  FINANCIAL_LINK_FUNCTION_CONTRACTS,
} from "../src/contracts.js";
import {
  createFinancialLinkApiHandlers,
  createFinancialLinkWorkerHandlers,
  FINANCIAL_LINK_PRIVATE_JSON_HEADERS,
} from "../src/handlers/financial-link.js";

const FIREBASE_UID = "firebase-user-001";
const ACTOR = Object.freeze({
  kind: "firebase",
  uid: FIREBASE_UID,
  email: "person@example.test",
});
const JOB_ID = "c0ffee00-0000-4000-8000-000000000000";

function runtimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  return true;
}

function request(body, headers = {}) {
  return Object.freeze({ body, headers: Object.freeze(headers) });
}

function syncSummary() {
  return {
    status: "partial",
    item_id: "item-sandbox-001",
    institution: { id: "ins_1", name: "Test Bank" },
    available_products: {
      accounts: true,
      balance: true,
      auth: true,
      identity: false,
      investments: true,
    },
    products_available: 4,
    fetch_errors: {
      identity: {
        error: "Identity access not granted",
        error_code: "ACCESS_NOT_GRANTED",
      },
    },
    can_proceed: true,
    background_products: [
      "identity_match",
      "transactions",
      "assets",
      "investment_transactions",
      "statements",
      "income",
    ],
    background_sync_started: true,
  };
}

function productSyncResponse() {
  return {
    success: true,
    item_id: "item-sandbox-001",
    result: {
      product: "investments",
      status: "complete",
      available: true,
      recordsCount: 0,
      error: null,
      errorCode: null,
    },
  };
}

function financialAdapter(overrides = {}) {
  const calls = [];
  const adapter = {
    configured: true,
    calls,
    async createLinkToken(input) {
      calls.push(["createLinkToken", input]);
      return {
        link_token: "link-sandbox-short-lived",
        expiration: "2026-09-12T13:00:00.000Z",
      };
    },
    async exchangePublicToken(input) {
      calls.push(["exchangePublicToken", input]);
      return {
        item_id: "item-sandbox-001",
        institution: { id: "ins_1", name: "Test Bank" },
        accounts: [{
          account_id: "account-1",
          name: "Checking",
          official_name: "Test Checking",
          mask: "1234",
          type: "depository",
          subtype: "checking",
        }],
      };
    },
    async startPlaidDataSync(input) {
      calls.push(["startPlaidDataSync", input]);
      return syncSummary();
    },
    async syncPlaidData(input) {
      calls.push(["syncPlaidData", input]);
      return syncSummary();
    },
    async syncProductForUser(input) {
      calls.push(["syncProductForUser", input]);
      return productSyncResponse();
    },
    async createAssetReport(input) {
      calls.push(["createAssetReport", input]);
      return {
        status: "pending",
        asset_report_token: "asset-report-token",
        asset_report_id: "asset-report-id",
      };
    },
    async getAssetReport(input) {
      calls.push(["getAssetReport", input]);
      return { status: "complete", data: { items: [] } };
    },
    async logDiagnostics(input) {
      calls.push(["logDiagnostics", input]);
      return { accepted: true };
    },
    ...overrides,
  };
  return adapter;
}

test("financial-link service contracts preserve the compatibility boundary without enabling routes", () => {
  const slugs = [
    "asset-report-create",
    "create-link-token",
    "exchange-public-token",
    "plaid-data-sync",
    "plaid-data-sync-product",
    "plaid-data-sync-start",
    "plaid-diagnostics-log",
  ];
  assert.deepEqual(Object.keys(FINANCIAL_LINK_FUNCTION_CONTRACTS).sort(), slugs);
  for (const slug of slugs) {
    const contract = FINANCIAL_LINK_FUNCTION_CONTRACTS[slug];
    assert.deepEqual(contract.methods, ["POST"]);
    assert.equal(contract.maxRequestBytes, 262_144);
    assert.equal(contract.cacheControl, "private, no-store");
  }
  assertFunctionRequestContract(
    FINANCIAL_LINK_FUNCTION_CONTRACTS["create-link-token"],
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      rawBody: Buffer.from('{"userId":"firebase-user-001"}'),
      route: { suffix: [], search: "" },
    },
  );
  assert.throws(
    () => assertFunctionRequestContract(
      FINANCIAL_LINK_FUNCTION_CONTRACTS["exchange-public-token"],
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        rawBody: Buffer.from("not-json"),
        route: { suffix: [], search: "" },
      },
    ),
    (error) => runtimeCode(error, "UNSUPPORTED_MEDIA_TYPE", 415),
  );
  // The source diagnostic endpoint replies with a lossy 200 for an empty or
  // malformed body, so its strict route contract must allow an empty POST.
  assertFunctionRequestContract(
    FINANCIAL_LINK_FUNCTION_CONTRACTS["plaid-diagnostics-log"],
    {
      method: "POST",
      headers: {},
      rawBody: Buffer.alloc(0),
      route: { suffix: [], search: "" },
    },
  );
});

test("financial-link handlers preserve Link, exchange, and fast-sync public contracts", async () => {
  const financial = financialAdapter();
  const handlers = createFinancialLinkApiHandlers({ financialLinkAdapter: financial });

  const link = await handlers["create-link-token"]({
    actor: ACTOR,
    request: request({
      userId: FIREBASE_UID,
      userEmail: "person@example.test",
      redirectUri: "https://uat.hushhtech.com/onboarding/financial-link",
    }),
  });
  assert.equal(link.status, 200);
  assert.equal(link.headers, FINANCIAL_LINK_PRIVATE_JSON_HEADERS);
  assert.deepEqual(link.body, {
    link_token: "link-sandbox-short-lived",
    expiration: "2026-09-12T13:00:00.000Z",
  });
  assert.equal(financial.calls[0][1].actor, ACTOR);

  const exchange = await handlers["exchange-public-token"]({
    actor: ACTOR,
    request: request({
      public_token: "public-sandbox-token",
      user_id: FIREBASE_UID,
      institution_name: "Test Bank",
      institution_id: "ins_1",
      accounts: [{ id: "account-1", name: "Checking" }],
    }),
  });
  assert.equal(exchange.status, 200);
  assert.deepEqual(exchange.body, {
    item_id: "item-sandbox-001",
    institution: { id: "ins_1", name: "Test Bank" },
    accounts: [{
      account_id: "account-1",
      name: "Checking",
      official_name: "Test Checking",
      mask: "1234",
      type: "depository",
      subtype: "checking",
    }],
  });
  assert.equal(financial.calls[1][1].publicToken, "public-sandbox-token");
  assert.equal(financial.calls[1][1].userId, FIREBASE_UID);
  assert.equal(financial.calls[1][1].institutionName, "Test Bank");

  const sync = await handlers["plaid-data-sync-start"]({
    actor: ACTOR,
    request: request({
      userId: FIREBASE_UID,
      itemId: "item-sandbox-001",
    }),
  });
  assert.equal(sync.status, 200);
  assert.deepEqual(sync.body, syncSummary());
  assert.equal(financial.calls[2][1].itemId, "item-sandbox-001");
});

test("legacy plaid-data-sync preserves its historic request aliases and safe summary wire shape", async () => {
  const financial = financialAdapter();
  const handlers = createFinancialLinkApiHandlers({ financialLinkAdapter: financial });

  const sync = await handlers["plaid-data-sync"]({
    actor: ACTOR,
    request: request({
      user_id: FIREBASE_UID,
      plaid_item_id: "item-sandbox-001",
    }),
  });

  assert.equal(sync.status, 200);
  assert.equal(sync.headers, FINANCIAL_LINK_PRIVATE_JSON_HEADERS);
  assert.deepEqual(sync.body, syncSummary());
  assert.equal(financial.calls.length, 1);
  assert.equal(financial.calls[0][0], "syncPlaidData");
  assert.equal(financial.calls[0][1].actor, ACTOR);
  assert.equal(financial.calls[0][1].userId, FIREBASE_UID);
  assert.equal(financial.calls[0][1].itemId, "item-sandbox-001");
});

test("product sync remains the existing synchronous public slug and preserves a truthful empty result", async () => {
  const financial = financialAdapter();
  const handlers = createFinancialLinkApiHandlers({ financialLinkAdapter: financial });

  const output = await handlers["plaid-data-sync-product"]({
    actor: ACTOR,
    request: request({
      userId: FIREBASE_UID,
      item_id: "item-sandbox-001",
      product: "investments",
    }),
  });

  assert.equal(output.status, 200);
  assert.deepEqual(output.body, productSyncResponse());
  assert.equal(financial.calls[0][0], "syncProductForUser");
  assert.equal(financial.calls[0][1].product, "investments");
  assert.equal(financial.calls[0][1].itemId, "item-sandbox-001");
  assert.equal(output.body.result.available, true);
  assert.equal(output.body.result.recordsCount, 0);
});

test("asset-report-create preserves its existing create and caller-owned polling contracts", async () => {
  const financial = financialAdapter();
  const handlers = createFinancialLinkApiHandlers({ financialLinkAdapter: financial });

  const complete = await handlers["asset-report-create"]({
    actor: ACTOR,
    request: request({
      userId: FIREBASE_UID,
      assetReportToken: "asset-report-token",
      action: "get",
    }),
  });
  assert.deepEqual(complete.body, { status: "complete", data: { items: [] } });
  assert.equal(financial.calls[0][0], "getAssetReport");
  assert.equal(financial.calls[0][1].assetReportToken, "asset-report-token");

  const created = await handlers["asset-report-create"]({
    actor: ACTOR,
    request: request({ access_token: "access-token-from-legacy-caller" }),
  });
  assert.deepEqual(created.body, {
    status: "pending",
    asset_report_token: "asset-report-token",
    asset_report_id: "asset-report-id",
  });
  assert.equal(financial.calls[1][0], "createAssetReport");
  assert.equal(financial.calls[1][1].accessToken, "access-token-from-legacy-caller");
  assert.equal("userId" in financial.calls[1][1], false);
});

test("Plaid failures retain the source route-specific envelopes and statuses", async () => {
  const providerFailure = new PlaidApiError({
    message: "Plaid rejected this Link request",
    statusCode: 429,
    details: { error_code: "RATE_LIMIT_EXCEEDED" },
  });
  const financial = financialAdapter({
    async createLinkToken(input) {
      this.calls.push(["createLinkToken", input]);
      throw providerFailure;
    },
    async exchangePublicToken(input) {
      this.calls.push(["exchangePublicToken", input]);
      throw providerFailure;
    },
    async getAssetReport(input) {
      this.calls.push(["getAssetReport", input]);
      throw providerFailure;
    },
    async syncProductForUser(input) {
      this.calls.push(["syncProductForUser", input]);
      throw providerFailure;
    },
  });
  const handlers = createFinancialLinkApiHandlers({ financialLinkAdapter: financial });

  const link = await handlers["create-link-token"]({
    actor: ACTOR,
    request: request({ userId: FIREBASE_UID }),
  });
  assert.equal(link.status, 429);
  assert.deepEqual(link.body, {
    error: "Plaid rejected this Link request",
  });

  const exchange = await handlers["exchange-public-token"]({
    actor: ACTOR,
    request: request({ publicToken: "public-sandbox-token", userId: FIREBASE_UID }),
  });
  assert.equal(exchange.status, 429);
  assert.deepEqual(exchange.body, {
    error: "Plaid rejected this Link request",
    details: { error_code: "RATE_LIMIT_EXCEEDED" },
  });

  const asset = await handlers["asset-report-create"]({
    actor: ACTOR,
    request: request({
      userId: FIREBASE_UID,
      assetReportToken: "asset-report-token",
      action: "get",
    }),
  });
  assert.equal(asset.status, 429);
  assert.deepEqual(asset.body, {
    error: "Plaid rejected this Link request",
    error_code: "RATE_LIMIT_EXCEEDED",
  });

  const sync = await handlers["plaid-data-sync-product"]({
    actor: ACTOR,
    request: request({
      userId: FIREBASE_UID,
      itemId: "item-sandbox-001",
      product: "assets",
    }),
  });
  assert.equal(sync.status, 500);
  assert.deepEqual(sync.body, { error: "Plaid rejected this Link request" });
});

test("diagnostics stay lossy and never trust a caller-supplied user id", async () => {
  const financial = financialAdapter({
    async logDiagnostics(input) {
      this.calls.push(["logDiagnostics", input]);
      throw new Error("diagnostic store unavailable");
    },
  });
  const handlers = createFinancialLinkApiHandlers({ financialLinkAdapter: financial });

  const failedAppend = await handlers["plaid-diagnostics-log"]({
    actor: ACTOR,
    request: request({
      user_id: "another-user-must-not-be-used",
      session_id: "c0ffee00-0000-4000-8000-000000000000",
      event_type: "financial_link_mount",
      plaid_step: "idle",
      page_state: { route: "/onboarding/financial-link" },
    }),
  });
  assert.equal(failedAppend.status, 200);
  assert.deepEqual(failedAppend.body, { accepted: false, reason: "unexpected" });
  assert.equal(financial.calls[0][1].actor, ACTOR);
  assert.equal("userId" in financial.calls[0][1], false);

  const invalid = await handlers["plaid-diagnostics-log"]({
    actor: ACTOR,
    request: request(null),
  });
  assert.deepEqual(invalid.body, { accepted: false, reason: "invalid_payload" });
});

test("lossy diagnostics preserve the source's anonymous fallback without opening financial access", async () => {
  const financial = financialAdapter();
  const handlers = createFinancialLinkApiHandlers({ financialLinkAdapter: financial });

  const result = await handlers["plaid-diagnostics-log"]({
    actor: { kind: "firebase", uid: "" },
    request: request({ event_type: "financial_link_mount" }),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { accepted: true });
  assert.equal(financial.calls.at(-1)[0], "logDiagnostics");
  assert.equal(financial.calls.at(-1)[1].actor, null);
});

test("worker product sync accepts only a durable job id and receives no browser fields", async () => {
  const calls = [];
  const handlers = createFinancialLinkWorkerHandlers({
    async queuedProductSync(context) {
      calls.push(context);
    },
  });
  const workerActor = Object.freeze({
    kind: "google-service",
    email: "hushh-tech-task-runner-uat@hushh-tech-uat.iam.gserviceaccount.com",
    subject: "task-subject",
  });
  const database = Object.freeze({ transaction: async () => {} });

  const acknowledgement = await handlers["plaid-data-sync-product"]({
    actor: workerActor,
    database,
    request: request({ jobId: JOB_ID }),
  });
  assert.deepEqual(acknowledgement.body, { success: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].request.body, { jobId: JOB_ID });
  assert.equal(calls[0].actor, workerActor);
  assert.equal(calls[0].database, database);

  await assert.rejects(
    handlers["plaid-data-sync-product"]({
      actor: workerActor,
      database,
      request: request({ jobId: JOB_ID, itemId: "browser-controlled-item" }),
    }),
    (error) => runtimeCode(error, "INVALID_REQUEST", 400),
  );
  assert.equal(calls.length, 1);

  await assert.rejects(
    handlers["plaid-data-sync-product"]({
      actor: ACTOR,
      database,
      request: request({ jobId: JOB_ID }),
    }),
    (error) => runtimeCode(error, "ACCESS_DENIED", 403),
  );
});

test("malformed adapter responses fail closed instead of leaking unexpected fields", async () => {
  const financial = financialAdapter({
    async exchangePublicToken(input) {
      this.calls.push(["exchangePublicToken", input]);
      return {
        item_id: "item-sandbox-001",
        institution: { id: "ins_1", name: "Test Bank" },
        accounts: [],
        access_token: "must-never-be-serialized",
      };
    },
  });
  const handlers = createFinancialLinkApiHandlers({ financialLinkAdapter: financial });

  await assert.rejects(
    handlers["exchange-public-token"]({
      actor: ACTOR,
      request: request({ publicToken: "public-sandbox-token", userId: FIREBASE_UID }),
    }),
    (error) => runtimeCode(error, "HANDLER_CONTRACT_INVALID", 503),
  );
});
