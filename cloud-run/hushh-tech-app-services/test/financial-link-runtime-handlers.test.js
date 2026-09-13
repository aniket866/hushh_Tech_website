import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_CONSTANTS } from "../src/config.js";
import { createRuntimeHandlers } from "../src/runtime-handlers.js";

function config(serviceOwner, financial) {
  return {
    serviceOwner,
    publicStockQuotesEnabled: false,
    financial,
  };
}

const enabledFinancial = Object.freeze({
  enabled: true,
  plaidClientId: "sandbox-client-id",
  plaidSecret: "sandbox-secret",
  plaidEnvironment: "sandbox",
  plaidPrimaryProducts: "transfer",
  kmsKey: RUNTIME_CONSTANTS.uatFinancial.kmsKey,
  taskQueue: RUNTIME_CONSTANTS.uatFinancial.syncTaskQueue,
  workerAudience: RUNTIME_CONSTANTS.uatFinancial.workerAudience,
  taskRunnerServiceAccount:
    RUNTIME_CONSTANTS.uatFinancial.taskRunnerServiceAccount,
  allowedRedirectOrigin: RUNTIME_CONSTANTS.uatFinancial.allowedRedirectOrigin,
});

test("financial runtime handlers remain absent until UAT financial configuration is complete", () => {
  const runtime = createRuntimeHandlers({
    config: config("financial-api", { enabled: false }),
  });
  assert.deepEqual(runtime.handlers, {});
  assert.equal(runtime.databaseRequired, false);
});

test("configured UAT financial services bind only the preserved compatibility slugs", () => {
  const financialApi = createRuntimeHandlers({
    config: config("financial-api", enabledFinancial),
  });
  assert.equal(financialApi.databaseRequired, true);
  assert.deepEqual(Object.keys(financialApi.handlers).sort(), [
    "asset-report-create",
    "create-link-token",
    "exchange-public-token",
    "plaid-data-sync",
    "plaid-data-sync-product",
    "plaid-data-sync-start",
    "plaid-diagnostics-log",
  ]);

  const worker = createRuntimeHandlers({
    config: config("worker", enabledFinancial),
  });
  assert.equal(worker.databaseRequired, true);
  assert.deepEqual(Object.keys(worker.handlers), ["plaid-data-sync-product"]);
});

test("only legacy diagnostics stays lossy when its isolated runtime cannot initialize", async () => {
  const financialApi = createRuntimeHandlers({
    config: config("financial-api", enabledFinancial),
  });

  const diagnostics = await financialApi.handlers["plaid-diagnostics-log"]({
    request: { body: { event_type: "financial_link_mount" } },
  });
  assert.deepEqual(diagnostics, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
    },
    body: { accepted: false, reason: "service_unavailable" },
  });

  await assert.rejects(
    financialApi.handlers["create-link-token"]({
      request: { body: { userId: "firebase-user-001" } },
    }),
  );
});
