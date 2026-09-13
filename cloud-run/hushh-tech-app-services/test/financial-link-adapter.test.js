import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeError } from "../src/errors.js";
import {
  createFinancialLinkAdapter,
  FINANCIAL_LINK_KMS_ENVELOPE_PROTECTION,
} from "../src/financial/financial-link-adapter.js";
import {
  PLAID_BACKGROUND_PRODUCTS,
  PlaidApiError,
  readPlaidConfiguration,
} from "../src/financial/plaid-client.js";
import { syncPlaidDataProduct } from "../src/financial/plaid-data-sync.js";

const FIREBASE_UID = "firebase-user-001";
const LEGACY_UUID = "b5f0b2f0-9c84-4cac-ae0a-55eb41f680f2";
const ITEM_ID = "item-sandbox-001";
const ACCESS_TOKEN = "access-sandbox-not-returned";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function runtimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
  return true;
}

function createRepository({
  lockAcquired = true,
  identityProfile = null,
  resolveFinancialPrincipalError = null,
} = {}) {
  const calls = [];
  const state = {
    item: null,
    financialData: {
      user_id: LEGACY_UUID,
      available_products: {},
      fetch_errors: null,
    },
    statuses: new Map(),
    accounts: [],
    diagnostics: [],
    queue: [],
    lockAcquired,
    identityProfile,
  };
  const key = (userId, plaidItemId, product) => `${userId}:${plaidItemId}:${product}`;
  return {
    configured: true,
    calls,
    state,
    async resolveFinancialPrincipal(input) {
      calls.push(["resolveFinancialPrincipal", input]);
      assert.equal(input.firebaseUid, FIREBASE_UID);
      if (resolveFinancialPrincipalError) throw resolveFinancialPrincipalError;
      return { legacyUserUuid: LEGACY_UUID };
    },
    async upsertPlaidItem(input) {
      calls.push(["upsertPlaidItem", input]);
      state.item = { ...input };
    },
    async setFinancialLinkStatus(input) {
      calls.push(["setFinancialLinkStatus", input]);
      state.financialLinkStatus = input.status;
    },
    async upsertPlaidAccounts(input) {
      calls.push(["upsertPlaidAccounts", input]);
      state.accounts.push(...input.accounts);
    },
    async getActivePlaidItem({ userId, plaidItemId }) {
      calls.push(["getActivePlaidItem", { userId, plaidItemId }]);
      if (!state.item || state.item.userId !== userId) return null;
      if (plaidItemId && state.item.plaidItemId !== plaidItemId) return null;
      return state.item;
    },
    async verifyQueuedProductSyncJob(input) {
      calls.push(["verifyQueuedProductSyncJob", input]);
      return input.job?.jobId === "job-1";
    },
    async ensureProductStatuses({ userId, plaidItemId, products }) {
      calls.push(["ensureProductStatuses", { userId, plaidItemId, products }]);
      for (const product of products) {
        const statusKey = key(userId, plaidItemId, product);
        if (!state.statuses.has(statusKey)) {
          state.statuses.set(statusKey, { product, status: "pending", available: false });
        }
      }
    },
    async upsertProductStatus(input) {
      calls.push(["upsertProductStatus", input]);
      state.statuses.set(key(input.userId, input.plaidItemId, input.product), {
        product: input.product,
        status: input.status,
        available: input.available,
      });
    },
    async getFinancialData({ userId }) {
      calls.push(["getFinancialData", { userId }]);
      assert.equal(userId, LEGACY_UUID);
      return state.financialData;
    },
    async mergeFinancialDataProduct(input) {
      calls.push(["mergeFinancialDataProduct", input]);
      const patch = input.patch && typeof input.patch === "object" ? input.patch : {};
      const availableProducts = {
        ...(state.financialData.available_products || {}),
        [input.product]: Boolean(input.available),
      };
      const fetchErrors = { ...(state.financialData.fetch_errors || {}) };
      if (input.error) {
        fetchErrors[input.product] = {
          error: input.error,
          error_code: input.errorCode || null,
        };
      } else {
        delete fetchErrors[input.product];
      }
      const availableCount = Object.values(availableProducts).filter(Boolean).length;
      state.financialData = {
        ...state.financialData,
        ...patch,
        user_id: input.userId,
        plaid_item_id: input.plaidItemId,
        institution_id: input.institutionId,
        institution_name: input.institutionName,
        available_products: availableProducts,
        fetch_errors: Object.keys(fetchErrors).length > 0 ? fetchErrors : null,
        status: availableCount >= 5 ? "complete" : availableCount > 0 ? "partial" : "failed",
        plaid_sync_status: availableCount >= 5 ? "complete" : availableCount > 0 ? "partial" : "failed",
        data_sync_summary: {
          products_available: availableCount,
          last_product_synced: input.product,
          last_product_status: input.productStatus,
        },
      };
    },
    async touchPlaidItemSync(input) {
      calls.push(["touchPlaidItemSync", input]);
    },
    async tryAcquireSyncLock(input) {
      calls.push(["tryAcquireSyncLock", input]);
      return state.lockAcquired;
    },
    async listProductStatuses({ userId, plaidItemId }) {
      calls.push(["listProductStatuses", { userId, plaidItemId }]);
      return [...state.statuses.entries()]
        .filter(([statusKey]) => statusKey.startsWith(`${userId}:${plaidItemId}:`))
        .map(([, value]) => value);
    },
    async upsertAccounts(input) {
      calls.push(["upsertAccounts", input]);
      state.accounts.push(...input.accounts);
    },
    async getIdentityMatchUser() {
      calls.push(["getIdentityMatchUser"]);
      return state.identityProfile;
    },
    async getSyncCursor() {
      calls.push(["getSyncCursor"]);
      return null;
    },
    async upsertTransactions(input) {
      calls.push(["upsertTransactions", input]);
    },
    async deleteTransactions(input) {
      calls.push(["deleteTransactions", input]);
    },
    async upsertSyncCursor(input) {
      calls.push(["upsertSyncCursor", input]);
    },
    async upsertStatementMetadata(input) {
      calls.push(["upsertStatementMetadata", input]);
    },
    async insertPlaidDiagnostic(input) {
      calls.push(["insertPlaidDiagnostic", input]);
      state.diagnostics.push(input);
    },
  };
}

function createTokenEnvelope() {
  const sealed = new Map();
  const calls = [];
  return {
    configured: true,
    protection: FINANCIAL_LINK_KMS_ENVELOPE_PROTECTION,
    calls,
    async seal({ plaintext, context }) {
      const envelope = `kms-envelope:${sealed.size + 1}`;
      calls.push(["seal", { plaintext, context }]);
      sealed.set(envelope, plaintext);
      return envelope;
    },
    async open({ envelope, context }) {
      calls.push(["open", { envelope, context }]);
      return sealed.get(envelope) || null;
    },
  };
}

function createSyncQueue() {
  const enqueueCalls = [];
  const publishCalls = [];
  return {
    configured: true,
    enqueueCalls,
    publishCalls,
    async enqueueProducts(input) {
      enqueueCalls.push(input);
      return input.products.map((product, index) => ({
        jobId: `job-${index + 1}`,
        product,
      }));
    },
    async publishProducts(input) {
      publishCalls.push(input);
    },
  };
}

function createPlaid({ overrides = {} } = {}) {
  const configuration = readPlaidConfiguration({
    PLAID_CLIENT_ID: "test-client-id",
    PLAID_SECRET: "test-private-secret",
    PLAID_ENV: "sandbox",
    PLAID_DATA_WEBHOOK_URL: "https://uat.hushhtech.com/api/plaid-webhook",
  });
  const calls = [];
  const responses = {
    "/link/token/create": {
      link_token: "link-sandbox-verified-token",
      expiration: "2026-09-12T13:00:00.000Z",
    },
    "/item/public_token/exchange": {
      access_token: ACCESS_TOKEN,
      item_id: ITEM_ID,
    },
    "/accounts/get": {
      accounts: [{
        account_id: "account-1",
        name: "Checking",
        official_name: "Test Checking",
        mask: "1234",
        type: "depository",
        subtype: "checking",
        balances: { current: 101.25, available: 99.25, iso_currency_code: "USD" },
      }],
    },
    "/accounts/balance/get": { accounts: [{ account_id: "account-1" }] },
    "/auth/get": { accounts: [{ account_id: "account-1" }], numbers: { ach: [] } },
    "/identity/get": { accounts: [{ account_id: "account-1" }], identity: {} },
    "/investments/holdings/get": { accounts: [], holdings: [] },
    "/liabilities/get": { liabilities: { credit: [] } },
    "/signal/prepare": { request_id: "request-signal" },
    "/identity/match": { match: {} },
    "/transactions/sync": { added: [], modified: [], removed: [], has_more: false, next_cursor: "cursor-1" },
    "/asset_report/create": { asset_report_token: "asset-report-1", asset_report_id: "asset-id-1" },
    "/asset_report/get": { report: { items: [] } },
    "/investments/transactions/get": { investment_transactions: [] },
    "/statements/list": { accounts: [] },
    ...overrides,
  };
  return {
    configured: true,
    configuration,
    calls,
    async post(path, body) {
      calls.push({ path, body });
      const response = responses[path];
      if (response instanceof Error) throw response;
      if (typeof response === "function") return response(body);
      if (response === undefined) throw new Error(`No response configured for ${path}`);
      return { data: response, requestId: response.request_id || null };
    },
  };
}

function createAdapter(options = {}) {
  const repository = options.repository || createRepository(options.repositoryOptions);
  const tokenEnvelope = options.tokenEnvelope || createTokenEnvelope();
  const syncQueue = options.syncQueue || createSyncQueue();
  const plaid = options.plaid || createPlaid(options.plaidOptions);
  return {
    repository,
    tokenEnvelope,
    syncQueue,
    plaid,
    adapter: createFinancialLinkAdapter({
      repository,
      tokenEnvelope,
      syncQueue,
      plaid,
      allowedRedirectOrigins: ["https://uat.hushhtech.com"],
      now: () => NOW,
    }),
  };
}

const actor = Object.freeze({ uid: FIREBASE_UID, email: "person@example.test" });

test("create link token preserves Link product/OAuth semantics and uses the UUID principal", async () => {
  const { adapter, plaid, repository } = createAdapter();
  const result = await adapter.createLinkToken({
    actor,
    userId: FIREBASE_UID,
    userEmail: "person@example.test",
    redirectUri: "https://uat.hushhtech.com/onboarding/financial-link",
    receivedRedirectUri: "https://uat.hushhtech.com/onboarding/financial-link?oauth_state_id=a",
  });

  assert.deepEqual(result, {
    link_token: "link-sandbox-verified-token",
    expiration: "2026-09-12T13:00:00.000Z",
  });
  assert.equal(repository.calls[0][0], "resolveFinancialPrincipal");
  const request = plaid.calls[0];
  assert.equal(request.path, "/link/token/create");
  assert.equal(request.body.user.client_user_id, LEGACY_UUID);
  assert.equal(request.body.redirect_uri, "https://uat.hushhtech.com/onboarding/financial-link?oauth_state_id=a");
  assert.equal("products" in request.body, false);
  assert.equal("required_if_supported_products" in request.body, false);
  assert.deepEqual(request.body.additional_consented_products, ["identity", "transactions", "signal"]);
  assert.equal(request.body.webhook, "https://uat.hushhtech.com/api/plaid-webhook");
  assert.equal(JSON.stringify(result).includes("test-private-secret"), false);
});

test("create link token rejects a body identity that differs from Firebase", async () => {
  const { adapter } = createAdapter();
  await assert.rejects(
    adapter.createLinkToken({
      actor,
      userId: "different-firebase-user",
      userEmail: "person@example.test",
    }),
    (error) => runtimeCode(error, "ACCESS_DENIED", 403),
  );
});

test("exchange seals the Plaid access token and stores only the UUID principal", async () => {
  const { adapter, repository, tokenEnvelope } = createAdapter();
  const result = await adapter.exchangePublicToken({
    actor,
    userId: FIREBASE_UID,
    publicToken: "public-sandbox-token",
    institutionName: "Test Bank",
    institutionId: "ins_1",
    accounts: [{ id: "selected-account", name: "Selected checking" }],
  });

  assert.deepEqual(result, {
    item_id: ITEM_ID,
    institution: { name: "Test Bank", id: "ins_1" },
    accounts: [{
      account_id: "account-1",
      name: "Checking",
      official_name: "Test Checking",
      mask: "1234",
      type: "depository",
      subtype: "checking",
    }],
  });
  const itemCall = repository.calls.find(([name]) => name === "upsertPlaidItem")[1];
  assert.equal(itemCall.userId, LEGACY_UUID);
  assert.equal(itemCall.accessTokenEnvelope.startsWith("kms-envelope:"), true);
  assert.equal(JSON.stringify(itemCall).includes(ACCESS_TOKEN), false);
  assert.equal(tokenEnvelope.calls[0][1].context.userId, LEGACY_UUID);
  assert.equal(repository.calls.some(([name]) => name === "upsertPlaidTransferAccounts"), false);
});

test("sync preserves truthful empty investments, actual identity error, immediate ordering, and queued background set", async () => {
  const identityFailure = new PlaidApiError({
    message: "Identity access not granted",
    statusCode: 400,
    details: { error_code: "ACCESS_NOT_GRANTED", error_message: "Identity access not granted" },
  });
  const harness = createAdapter({ plaidOptions: { overrides: { "/identity/get": identityFailure } } });
  await harness.adapter.exchangePublicToken({
    actor,
    userId: FIREBASE_UID,
    publicToken: "public-sandbox-token",
    institutionName: "Test Bank",
    institutionId: "ins_1",
  });
  const callsBeforeSync = harness.plaid.calls.length;
  const result = await harness.adapter.startPlaidDataSync({
    actor,
    userId: FIREBASE_UID,
    itemId: ITEM_ID,
  });

  assert.equal(result.available_products.investments, true);
  assert.equal(result.products_available, 6);
  assert.equal(result.available_products.identity, false);
  assert.equal(result.fetch_errors.identity.error_code, "ACCESS_NOT_GRANTED");
  assert.equal(result.can_proceed, true);
  assert.deepEqual(result.background_products, PLAID_BACKGROUND_PRODUCTS);
  assert.equal(result.background_sync_started, true);
  assert.deepEqual(
    harness.plaid.calls.slice(callsBeforeSync).map((call) => call.path),
    [
      "/accounts/get",
      "/accounts/balance/get",
      "/auth/get",
      "/identity/get",
      "/investments/holdings/get",
      "/liabilities/get",
      "/signal/prepare",
    ],
  );
  assert.deepEqual(harness.syncQueue.enqueueCalls[0].products, PLAID_BACKGROUND_PRODUCTS);
  assert.equal(harness.syncQueue.enqueueCalls[0].userId, LEGACY_UUID);
  assert.deepEqual(
    harness.syncQueue.publishCalls[0].jobs.map(({ product }) => product),
    PLAID_BACKGROUND_PRODUCTS,
  );
  assert.equal(harness.repository.state.financialData.available_products.investments, true);
  assert.equal(harness.repository.state.financialData.available_products.identity, false);
});

test("product-local financial merge preserves financial data fetched by an earlier product", async () => {
  const repository = createRepository();
  const plaid = createPlaid();
  const item = {
    plaidItemId: ITEM_ID,
    institutionId: "ins_1",
    institutionName: "Test Bank",
  };

  await syncPlaidDataProduct({
    repository,
    plaid,
    userId: LEGACY_UUID,
    item,
    accessToken: ACCESS_TOKEN,
    product: "investments",
    now: () => NOW,
  });
  const investmentPayload = repository.state.financialData.investments;
  assert.deepEqual(investmentPayload, { accounts: [], holdings: [] });

  await syncPlaidDataProduct({
    repository,
    plaid,
    userId: LEGACY_UUID,
    item,
    accessToken: ACCESS_TOKEN,
    product: "identity",
    now: () => NOW,
  });

  assert.deepEqual(repository.state.financialData.investments, investmentPayload);
  assert.deepEqual(repository.state.financialData.identity_data, {
    accounts: [{ account_id: "account-1" }],
    identity: {},
  });
  assert.equal(
    repository.calls.some(([method]) => method === "upsertFinancialData"),
    false,
  );
});

test("concurrent product completions atomically retain Assets, Investments, Identity errors, and product state", async () => {
  const identityFailure = new PlaidApiError({
    message: "Identity access not granted",
    statusCode: 400,
    details: {
      error_code: "ACCESS_NOT_GRANTED",
      error_message: "Identity access not granted",
    },
  });
  const repository = createRepository();
  const merge = repository.mergeFinancialDataProduct.bind(repository);
  let firstThreeMerges = 0;
  let releaseFirstThree;
  const firstThreeReady = new Promise((resolve) => {
    releaseFirstThree = resolve;
  });
  repository.mergeFinancialDataProduct = async (input) => {
    if (firstThreeMerges < 3) {
      firstThreeMerges += 1;
      if (firstThreeMerges === 3) releaseFirstThree();
      await firstThreeReady;
    }
    return merge(input);
  };
  const plaid = createPlaid({
    overrides: { "/identity/get": identityFailure },
  });
  const item = {
    plaidItemId: ITEM_ID,
    institutionId: "ins_1",
    institutionName: "Test Bank",
  };

  await Promise.all([
    syncPlaidDataProduct({
      repository,
      plaid,
      userId: LEGACY_UUID,
      item,
      accessToken: ACCESS_TOKEN,
      product: "assets",
      now: () => NOW,
    }),
    syncPlaidDataProduct({
      repository,
      plaid,
      userId: LEGACY_UUID,
      item,
      accessToken: ACCESS_TOKEN,
      product: "investments",
      now: () => NOW,
    }),
    syncPlaidDataProduct({
      repository,
      plaid,
      userId: LEGACY_UUID,
      item,
      accessToken: ACCESS_TOKEN,
      product: "identity",
      now: () => NOW,
    }),
  ]);

  assert.deepEqual(repository.state.financialData.investments, {
    accounts: [],
    holdings: [],
  });
  assert.deepEqual(repository.state.financialData.asset_report, { report: { items: [] } });
  assert.equal(repository.state.financialData.asset_report_token, "asset-report-1");
  assert.equal(repository.state.financialData.asset_report_status, "complete");
  assert.equal(repository.state.financialData.available_products.assets, true);
  assert.equal(repository.state.financialData.available_products.investments, true);
  assert.equal(repository.state.financialData.available_products.identity, false);
  assert.deepEqual(repository.state.financialData.fetch_errors.identity, {
    error: "Identity access not granted",
    error_code: "ACCESS_NOT_GRANTED",
  });
});

test("active sync lock returns existing status and makes no new Plaid or queue request", async () => {
  const harness = createAdapter({ repositoryOptions: { lockAcquired: false } });
  await harness.adapter.exchangePublicToken({
    actor,
    userId: FIREBASE_UID,
    publicToken: "public-sandbox-token",
  });
  harness.repository.state.statuses.set(`${LEGACY_UUID}:${ITEM_ID}:accounts`, {
    product: "accounts",
    status: "complete",
    available: true,
  });
  const before = harness.plaid.calls.length;
  const result = await harness.adapter.startPlaidDataSync({
    actor,
    userId: FIREBASE_UID,
    itemId: ITEM_ID,
  });
  assert.equal(result.sync_in_progress, true);
  assert.equal(result.background_sync_started, false);
  assert.equal(result.available_products.accounts, true);
  assert.equal(harness.plaid.calls.length, before);
  assert.equal(harness.syncQueue.enqueueCalls.length, 0);
  assert.equal(harness.syncQueue.publishCalls.length, 0);
  assert.equal(
    harness.repository.calls.filter(([method]) => method === "tryAcquireSyncLock").length,
    1,
  );
});

test("legacy sync bypasses the start lock while retaining its queue provenance", async () => {
  const harness = createAdapter({ repositoryOptions: { lockAcquired: false } });
  await harness.adapter.exchangePublicToken({
    actor,
    userId: FIREBASE_UID,
    publicToken: "public-sandbox-token",
  });
  const before = harness.plaid.calls.length;

  const result = await harness.adapter.syncPlaidData({
    actor,
    userId: FIREBASE_UID,
    itemId: ITEM_ID,
  });

  assert.equal(result.background_sync_started, true);
  assert.equal(harness.plaid.calls.length > before, true);
  assert.equal(
    harness.repository.calls.filter(([method]) => method === "tryAcquireSyncLock").length,
    0,
  );
  assert.equal(harness.syncQueue.enqueueCalls.length, 1);
  assert.equal(harness.syncQueue.enqueueCalls[0].source, "plaid-data-sync");
});

test("durable background enqueue failure preserves source-compatible summaries for both whole-flow aliases", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));

  for (const [method, source] of [
    ["startPlaidDataSync", "plaid-data-sync-start"],
    ["syncPlaidData", "plaid-data-sync"],
  ]) {
    const enqueueCalls = [];
    const syncQueue = {
      configured: true,
      async enqueueProducts(input) {
        enqueueCalls.push(input);
        throw new RuntimeError(
          "DATABASE_UNAVAILABLE",
          "Database unavailable.",
          503,
          { diagnosticCode: "FINANCIAL_SYNC_OUTBOX_WRITE_FAILED" },
        );
      },
      async publishProducts() {
        assert.fail("enqueue failure must not reach Cloud Tasks publication");
      },
    };
    const harness = createAdapter({ syncQueue });
    await harness.adapter.exchangePublicToken({
      actor,
      userId: FIREBASE_UID,
      publicToken: "public-sandbox-token",
      institutionName: "Test Bank",
      institutionId: "ins_1",
    });

    const result = await harness.adapter[method]({
      actor,
      userId: FIREBASE_UID,
      itemId: ITEM_ID,
    });

    assert.deepEqual(result, {
      status: "complete",
      item_id: ITEM_ID,
      institution: { id: "ins_1", name: "Test Bank" },
      available_products: {
        accounts: true,
        balance: true,
        auth: true,
        identity: true,
        investments: true,
        liabilities: true,
        signal: true,
      },
      products_available: 7,
      fetch_errors: {},
      can_proceed: true,
      background_products: PLAID_BACKGROUND_PRODUCTS,
      background_sync_started: true,
    });
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0].source, source);
    assert.deepEqual(enqueueCalls[0].products, PLAID_BACKGROUND_PRODUCTS);
  }

  assert.deepEqual(warnings, [
    [
      "[plaid-data-sync-start] Background sync enqueue failed",
      { diagnostic_code: "FINANCIAL_SYNC_OUTBOX_WRITE_FAILED" },
    ],
    [
      "[plaid-data-sync] Background sync enqueue failed",
      { diagnostic_code: "FINANCIAL_SYNC_OUTBOX_WRITE_FAILED" },
    ],
  ]);
});

test("background task publishing cannot fail an immediate source-compatible sync response", async (t) => {
  const publishCalls = [];
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const syncQueue = {
    configured: true,
    async enqueueProducts() {
      return [{ jobId: "job-background-1", product: "assets" }];
    },
    async publishProducts(input) {
      publishCalls.push(input);
      throw new Error("Cloud Tasks temporarily unavailable");
    },
  };
  const harness = createAdapter({ syncQueue });
  await harness.adapter.exchangePublicToken({
    actor,
    userId: FIREBASE_UID,
    publicToken: "public-sandbox-token",
  });

  const result = await harness.adapter.startPlaidDataSync({
    actor,
    userId: FIREBASE_UID,
    itemId: ITEM_ID,
  });

  assert.equal(result.background_sync_started, true);
  assert.equal(result.can_proceed, true);
  assert.equal(publishCalls.length, 1);
  await Promise.resolve();
  assert.deepEqual(warnings, [[
    "[plaid-data-sync-start] Background sync publish failed",
    { diagnostic_code: "FINANCIAL_BACKGROUND_SYNC_SCHEDULING_FAILED" },
  ]]);
});

test("private product sync requires a verified outbox job bound to the UUID principal", async () => {
  const harness = createAdapter();
  await harness.adapter.exchangePublicToken({
    actor,
    userId: FIREBASE_UID,
    publicToken: "public-sandbox-token",
  });
  await assert.rejects(
    harness.adapter.syncProduct({
      legacyUserUuid: LEGACY_UUID,
      itemId: ITEM_ID,
      product: "investments",
      job: { jobId: "other-job" },
    }),
    (error) => runtimeCode(error, "ACCESS_DENIED", 403),
  );
  const result = await harness.adapter.syncProduct({
    legacyUserUuid: LEGACY_UUID,
    itemId: ITEM_ID,
    product: "investments",
    job: { jobId: "job-1" },
  });
  assert.equal(result.available, true);
  assert.equal(result.recordsCount, 0);
  const verification = harness.repository.calls.find(([name]) => name === "verifyQueuedProductSyncJob")[1];
  assert.equal(verification.legacyUserUuid, LEGACY_UUID);
  assert.equal(verification.plaidItemId, ITEM_ID);
});

test("public product sync remains synchronous and creates no durable retry job", async () => {
  const harness = createAdapter();
  await harness.adapter.exchangePublicToken({
    actor,
    userId: FIREBASE_UID,
    publicToken: "public-sandbox-token",
  });

  const result = await harness.adapter.syncProductForUser({
    actor,
    userId: FIREBASE_UID,
    itemId: ITEM_ID,
    product: "investments",
  });

  assert.deepEqual(result, {
    success: true,
    item_id: ITEM_ID,
    result: {
      product: "investments",
      status: "complete",
      available: true,
      recordsCount: 0,
      error: null,
      errorCode: null,
    },
  });
  assert.equal(harness.syncQueue.enqueueCalls.length, 0);
  assert.equal(harness.syncQueue.publishCalls.length, 0);
  assert.equal(
    harness.repository.calls.some(([method]) => method === "verifyQueuedProductSyncJob"),
    false,
  );
});

test("standalone asset report creation retains the legacy pending response", async () => {
  const harness = createAdapter();
  const result = await harness.adapter.createAssetReport({
    actor,
    accessToken: ACCESS_TOKEN,
  });

  assert.deepEqual(result, {
    status: "pending",
    asset_report_token: "asset-report-1",
    asset_report_id: "asset-id-1",
  });
  const call = harness.plaid.calls.at(-1);
  assert.equal(call.path, "/asset_report/create");
  assert.deepEqual(call.body, {
    access_tokens: [ACCESS_TOKEN],
    days_requested: 60,
  });
  assert.equal(
    harness.repository.calls.some(([method]) => method === "mergeFinancialDataProduct"),
    false,
  );
});

test("asset report status polling preserves pending and complete source responses", async () => {
  const pending = new PlaidApiError({
    message: "Asset report not ready",
    statusCode: 400,
    details: { error_code: "PRODUCT_NOT_READY", error_message: "Asset report not ready" },
  });
  const harness = createAdapter({ plaidOptions: { overrides: { "/asset_report/get": pending } } });
  harness.repository.state.financialData.asset_report_token = "asset-report-1";
  const first = await harness.adapter.getAssetReport({
    actor,
    userId: FIREBASE_UID,
    assetReportToken: "asset-report-1",
  });
  assert.deepEqual(first, { status: "pending", message: "Asset report not ready yet" });

  const secondHarness = createAdapter();
  secondHarness.repository.state.financialData.asset_report_token = "asset-report-1";
  const second = await secondHarness.adapter.getAssetReport({
    actor,
    userId: FIREBASE_UID,
    assetReportToken: "asset-report-1",
  });
  assert.deepEqual(second, { status: "complete", data: { items: [] } });
});

test("diagnostics stay lossy and use a resolved UUID when available", async () => {
  const { adapter, repository } = createAdapter();
  const accepted = await adapter.appendDiagnostics({
    actor,
    sessionId: "c0ffee00-0000-4000-8000-000000000000",
    eventType: "access-sandbox-event-token",
    plaidStep: "public-sandbox-step-token",
    pageState: {
      url: "https://uat.hushhtech.com/onboarding?token=leak#private",
      email: "investor@example.test",
      fullName: "Private Investor",
      isReviewMode: true,
      currentStep: 12,
    },
    plaidMetadata: {
      access_token: "access-sandbox-secret",
      institutionName: "Private Bank",
      accountsCount: 2,
      canProceed: true,
    },
    errorDetails: {
      message: "failed for second-investor@example.test",
      access_token: "access-sandbox-secret",
      stack: "Bearer private-token",
      errorCode: "INVALID_REQUEST",
    },
    browserContext: {
      user_agent: "private-browser",
      note: "Bearer private-token",
      online: true,
      viewport: { width: 1440, height: 900, privateName: "Jane Doe" },
    },
  });
  assert.deepEqual(accepted, { accepted: true });
  assert.equal(repository.state.diagnostics[0].userId, LEGACY_UUID);
  assert.equal(repository.state.diagnostics[0].eventType, "redacted");
  assert.equal(repository.state.diagnostics[0].plaidStep, "redacted");
  assert.deepEqual(repository.state.diagnostics[0].pageState, {
    isReviewMode: true,
    useSandboxDirectConnect: null,
    blockLocalPlaidLink: null,
    isPlaidOAuthResume: null,
    isCompleted: null,
    hasOAuthStateId: null,
    currentStep: 12,
    accessState: null,
  });
  assert.equal(repository.state.diagnostics[0].plaidMetadata.accountsCount, 2);
  assert.equal(repository.state.diagnostics[0].plaidMetadata.canProceed, true);
  assert.equal(repository.state.diagnostics[0].plaidMetadata.institutionPresent, true);
  assert.equal(repository.state.diagnostics[0].errorDetails.errorCode, "INVALID_REQUEST");
  assert.equal(repository.state.diagnostics[0].errorDetails.hasMessage, true);
  assert.equal(repository.state.diagnostics[0].browserContext.online, true);
  assert.equal(repository.state.diagnostics[0].browserContext.viewportWidth, 1440);
  const stored = JSON.stringify(repository.state.diagnostics[0]);
  for (const forbidden of [
    "investor@example.test",
    "second-investor@example.test",
    "access-sandbox-secret",
    "access-sandbox-event-token",
    "public-sandbox-step-token",
    "Private Investor",
    "Private Bank",
    "private-browser",
    "private-token",
    "privateName",
  ]) {
    assert.equal(stored.includes(forbidden), false, forbidden);
  }
  assert.ok(stored.length < 16_000);

  const noEvent = await adapter.logDiagnostics({ eventType: "" });
  assert.deepEqual(noEvent, { accepted: false, reason: "missing_event_type" });

  const unresolved = createAdapter({
    repositoryOptions: { resolveFinancialPrincipalError: new Error("mapping unavailable") },
  });
  const anonymous = await unresolved.adapter.logDiagnostics({
    actor,
    eventType: "financial_link_mount",
  });
  assert.deepEqual(anonymous, { accepted: true });
  assert.equal(unresolved.repository.state.diagnostics[0].userId, null);
});
