import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeError } from "../src/errors.js";
import {
  buildCreateLinkTokenRequest,
  createPlaidHttpClient,
  PlaidApiError,
  readPlaidConfiguration,
} from "../src/financial/plaid-client.js";

function runtimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
  return true;
}

test("Plaid configuration preserves legacy sandbox/production primary product fallbacks", () => {
  const sandbox = readPlaidConfiguration({
    PLAID_CLIENT_ID: "test-client",
    PLAID_SECRET: "test-secret",
  });
  assert.equal(sandbox.environment, "sandbox");
  assert.deepEqual(sandbox.primaryProducts, ["transfer"]);

  const production = readPlaidConfiguration({
    PLAID_CLIENT_ID: "test-client",
    PLAID_SECRET: "test-secret",
    PLAID_ENV: "production",
  });
  assert.deepEqual(production.primaryProducts, ["auth"]);

  assert.throws(
    () => readPlaidConfiguration({
      PLAID_CLIENT_ID: "test-client",
      PLAID_SECRET: "test-secret",
      PLAID_ENV: "development",
    }),
    (error) => runtimeCode(error, "PLAID_CONFIGURATION_INVALID", 503),
  );
});

test("Link token request keeps optional products non-blocking and strips required products for OAuth resume", () => {
  const config = readPlaidConfiguration({
    PLAID_CLIENT_ID: "test-client",
    PLAID_SECRET: "test-secret",
    PLAID_ENV: "sandbox",
    PLAID_PRIMARY_PRODUCTS: "transfer,investments,liabilities",
    PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS: "investments,liabilities,auth",
    PLAID_ADDITIONAL_CONSENTED_PRODUCTS: "identity,investments,invalid_product",
    PLAID_DATA_WEBHOOK_URL: "https://uat.hushhtech.com/functions/v1/plaid-data-webhook",
  });
  const initial = buildCreateLinkTokenRequest({
    config,
    userId: "b5f0b2f0-9c84-4cac-ae0a-55eb41f680f2",
    userEmail: "person@example.test",
    redirectUri: "https://uat.hushhtech.com/onboarding/financial-link",
  });
  assert.deepEqual(initial.products, ["transfer"]);
  assert.deepEqual(initial.required_if_supported_products, ["auth", "investments", "liabilities"]);
  assert.deepEqual(initial.additional_consented_products, ["identity"]);

  const resumed = buildCreateLinkTokenRequest({
    config,
    userId: "b5f0b2f0-9c84-4cac-ae0a-55eb41f680f2",
    receivedRedirectUri: "https://uat.hushhtech.com/onboarding/financial-link?oauth_state_id=a",
  });
  assert.equal("products" in resumed, false);
  assert.equal("required_if_supported_products" in resumed, false);
  // This is intentionally calculated before the OAuth field deletion, as in
  // the preserved edge function; a product that was required-if-supported is
  // not also sent as additional consent during resume.
  assert.deepEqual(resumed.additional_consented_products, ["identity"]);
  assert.equal(resumed.webhook, "https://uat.hushhtech.com/functions/v1/plaid-data-webhook");
});

test("Plaid HTTP client keeps credentials private and preserves provider failure metadata", async () => {
  const config = readPlaidConfiguration({
    PLAID_CLIENT_ID: "test-client",
    PLAID_SECRET: "test-secret",
  });
  let request;
  const client = createPlaidHttpClient({
    config,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ error_code: "ITEM_LOGIN_REQUIRED", error_message: "Re-authenticate" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(
    client.post("/accounts/get", { access_token: "sealed-token-is-not-persisted" }),
    (error) => {
      assert.ok(error instanceof PlaidApiError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.details.error_code, "ITEM_LOGIN_REQUIRED");
      return true;
    },
  );
  assert.equal(request.url, "https://sandbox.plaid.com/accounts/get");
  const body = JSON.parse(request.options.body);
  assert.equal(body.client_id, "test-client");
  assert.equal(body.secret, "test-secret");
});

test("Plaid transport failures retain the legacy outer-catch status", async () => {
  const config = readPlaidConfiguration({
    PLAID_CLIENT_ID: "test-client",
    PLAID_SECRET: "test-secret",
  });
  const client = createPlaidHttpClient({
    config,
    fetchImpl: async () => {
      throw new Error("synthetic network failure");
    },
  });

  await assert.rejects(
    client.post("/link/token/create", {}),
    (error) => {
      assert.ok(error instanceof PlaidApiError);
      // The old Edge function's outer catch returned 500 when fetch itself
      // failed, unlike a provider HTTP response which retains its status.
      assert.equal(error.statusCode, 500);
      return true;
    },
  );
});
