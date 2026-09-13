import { RuntimeError } from "../errors.js";
import { PLAID_DATA_PRODUCTS, PlaidApiError } from "../financial/plaid-client.js";

// This is deliberately a thin route layer.  Financial state, Plaid access
// tokens, KMS envelopes, and durable jobs live behind the GCP
// financial adapter; these handlers only preserve the old Edge-function wire
// contracts and keep untrusted request fields out of that boundary.
export const FINANCIAL_LINK_PRIVATE_JSON_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-type": "application/json",
});

const PLAID_DATA_PRODUCT_SET = new Set(PLAID_DATA_PRODUCTS);
const SYNC_SUMMARY_STATUSES = new Set(["complete", "partial", "failed"]);
const PRODUCT_SYNC_STATUSES = new Set([
  "pending",
  "syncing",
  "complete",
  "partial",
  "unsupported",
  "access_required",
  "failed",
]);
const DIAGNOSTIC_REASONS = new Set([
  "db_error",
  "invalid_payload",
  "missing_event_type",
  "service_unavailable",
  "unexpected",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const CREDENTIAL_RESPONSE_KEY =
  /(?:access|public|refresh|service)[_-]?token|authorization|credential|secret|password|passcode/i;

function fail(code = "INVALID_REQUEST", message = "Invalid request.", statusCode = 400) {
  throw new RuntimeError(code, message, statusCode);
}

function json(body, status = 200) {
  return Object.freeze({
    status,
    headers: FINANCIAL_LINK_PRIVATE_JSON_HEADERS,
    body: Object.freeze(body),
  });
}

function providerErrorText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 2_048 && !hasControlCharacters(text)
    ? text
    : fallback;
}

function providerErrorCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  return SAFE_CODE_PATTERN.test(code) ? code : null;
}

// The existing Supabase functions pass a Plaid provider failure through as an
// `{ error }` JSON body with the provider's HTTP status. Preserve that
// browser contract without reflecting unbounded provider details or turning
// non-provider runtime faults into a user-controlled error channel.
function sourceErrorText(error, fallback) {
  return providerErrorText(error instanceof Error ? error.message : null, fallback);
}

function sourceProviderFailure(error, fallback, { details = false, errorCode = false } = {}) {
  if (!(error instanceof PlaidApiError)) return null;
  const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode
    : 502;
  const providerCode = providerErrorCode(error.details?.error_code);
  const body = { error: sourceErrorText(error, fallback) };
  if (details) body.details = sourceProviderDetails(error.details);
  if (errorCode && providerCode) body.error_code = providerCode;
  return json(body, status);
}

function sourceOuterFailure(error, fallback) {
  // The source functions turn unexpected failures (including a transport
  // failure before Plaid replied) into their historical 500 `{ error }`
  // envelope. Keep that per-route contract rather than treating a provider
  // error as a generic gateway failure.
  return json({ error: sourceErrorText(error, fallback) }, 500);
}

function sourceProviderDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 16_384) {
      return {};
    }
    const copy = JSON.parse(serialized);
    assertNoCredentialResponseFields(copy);
    return copy;
  } catch {
    // Plaid failures normally contain a small JSON object. If a malformed
    // provider body ever contains a credential-like field, preserve the
    // legacy envelope without reflecting that unsafe detail.
    return {};
  }
}

function sourceCreateLinkFailure(error) {
  return sourceProviderFailure(error, "Failed to create link token")
    ?? sourceOuterFailure(error, "Internal server error");
}

function sourceExchangeFailure(error) {
  return sourceProviderFailure(error, "Failed to exchange token", { details: true })
    ?? sourceOuterFailure(error, "Internal server error");
}

function sourceAssetReportFailure(error, fallback) {
  return sourceProviderFailure(error, fallback, { errorCode: true })
    ?? sourceOuterFailure(error, "Internal server error");
}

function sourceSyncFailure(error) {
  return json(
    { error: sourceErrorText(error, "Internal server error") },
    500,
  );
}

function plainObject(value, code = "INVALID_REQUEST", statusCode = 400) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, code === "HANDLER_CONTRACT_INVALID" ? "Service unavailable." : "Invalid request.", statusCode);
  }
  return value;
}

function exactObject(value, allowed, required = []) {
  const object = plainObject(value);
  if (
    Object.keys(object).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    fail();
  }
  return object;
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    fail();
  }
}

function aliasedValue(object, aliases) {
  const present = aliases.filter((key) =>
    Object.prototype.hasOwnProperty.call(object, key),
  );
  if (
    present.length > 1 &&
    present.some((key) => stableJson(object[key]) !== stableJson(object[present[0]]))
  ) {
    fail();
  }
  return present.length ? object[present[0]] : undefined;
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function boundedText(value, maximum, { required = false, nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (value === undefined || value === null || value === "") {
    if (required) fail();
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    hasControlCharacters(value)
  ) {
    fail();
  }
  const normalized = value.trim();
  if (required && !normalized) fail();
  return normalized || null;
}

function requireFirebaseActor(actor) {
  if (
    actor?.kind !== "firebase" ||
    typeof actor.uid !== "string" ||
    !actor.uid ||
    actor.uid.length > 128 ||
    hasControlCharacters(actor.uid)
  ) {
    fail("ACCESS_DENIED", "Access denied.", 403);
  }
  return actor;
}

// The source diagnostics function is public and only associates a user when
// its bearer token can be verified. Invalid or absent credentials are a
// deliberately anonymous, lossy diagnostic event — never an authorization
// path for financial data. The gateway's optional-auth decision remains a
// separate frozen-inventory activation requirement.
function optionalDiagnosticsActor(actor) {
  if (
    actor?.kind === "firebase" &&
    typeof actor.uid === "string" &&
    actor.uid &&
    actor.uid.length <= 128 &&
    !hasControlCharacters(actor.uid)
  ) {
    return actor;
  }
  return null;
}

function requireGoogleWorkerActor(actor) {
  if (
    actor?.kind !== "google-service" ||
    typeof actor.email !== "string" ||
    !actor.email ||
    actor.email.length > 320 ||
    hasControlCharacters(actor.email) ||
    typeof actor.subject !== "string" ||
    !actor.subject ||
    actor.subject.length > 256 ||
    hasControlCharacters(actor.subject)
  ) {
    fail("ACCESS_DENIED", "Access denied.", 403);
  }
  return actor;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503);
}

function requireFinancialAdapter(financialLinkAdapter) {
  const methods = [
    "createLinkToken",
    "exchangePublicToken",
    "startPlaidDataSync",
    "syncPlaidData",
    "syncProductForUser",
    "createAssetReport",
    "getAssetReport",
    "logDiagnostics",
  ];
  if (
    financialLinkAdapter?.configured !== true ||
    methods.some((method) => typeof financialLinkAdapter[method] !== "function")
  ) {
    throw new Error("Configured financial-link adapter is required.");
  }
  return financialLinkAdapter;
}

function handlerContractError() {
  fail("HANDLER_CONTRACT_INVALID", "Service unavailable.", 503);
}

function responseObject(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    handlerContractError();
  }
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    handlerContractError();
  }
  return value;
}

function responseText(value, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    hasControlCharacters(value)
  ) {
    handlerContractError();
  }
  return value;
}

function responseBoolean(value) {
  if (typeof value !== "boolean") handlerContractError();
  return value;
}

function responseInteger(value, minimum, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    handlerContractError();
  }
  return value;
}

function responseTimestamp(value) {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    hasControlCharacters(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    handlerContractError();
  }
  return value;
}

function assertNoCredentialResponseFields(value, depth = 0) {
  if (depth > 16) handlerContractError();
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) assertNoCredentialResponseFields(child, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_RESPONSE_KEY.test(key)) handlerContractError();
    assertNoCredentialResponseFields(child, depth + 1);
  }
}

function projectInstitution(value) {
  const institution = responseObject(value, ["id", "name"], ["id", "name"]);
  return Object.freeze({
    id: responseText(institution.id, 128, { nullable: true }),
    name: responseText(institution.name, 256, { nullable: true }),
  });
}

function projectExchangeAccount(value) {
  const account = responseObject(
    value,
    ["account_id", "name", "official_name", "mask", "type", "subtype"],
    ["account_id", "name", "official_name", "mask", "type", "subtype"],
  );
  return Object.freeze({
    account_id: responseText(account.account_id, 256),
    name: responseText(account.name, 256),
    official_name: responseText(account.official_name, 256, { nullable: true }),
    mask: responseText(account.mask, 64, { nullable: true }),
    type: responseText(account.type, 64, { nullable: true }),
    subtype: responseText(account.subtype, 64, { nullable: true }),
  });
}

function projectLinkToken(value) {
  const result = responseObject(value, ["link_token", "expiration"], [
    "link_token",
    "expiration",
  ]);
  const linkToken = responseText(result.link_token, 4_096);
  // Link tokens are intentionally browser-deliverable, but this prevents a
  // malformed provider result from becoming a generic secret-return channel.
  if (!/^link-(?:sandbox|development|production)-[A-Za-z0-9_-]{4,4080}$/.test(linkToken)) {
    handlerContractError();
  }
  return Object.freeze({
    link_token: linkToken,
    expiration: responseTimestamp(result.expiration),
  });
}

function projectExchange(value) {
  const result = responseObject(value, ["item_id", "institution", "accounts"], [
    "item_id",
    "institution",
    "accounts",
  ]);
  if (!Array.isArray(result.accounts) || result.accounts.length > 32) {
    handlerContractError();
  }
  return Object.freeze({
    item_id: responseText(result.item_id, 256),
    institution: projectInstitution(result.institution),
    accounts: Object.freeze(result.accounts.map(projectExchangeAccount)),
  });
}

function projectProductMap(value) {
  const map = responseObject(value, PLAID_DATA_PRODUCTS);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(map).map(([product, available]) => [
        product,
        responseBoolean(available),
      ]),
    ),
  );
}

function projectFetchErrors(value) {
  const errors = responseObject(value, PLAID_DATA_PRODUCTS);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(errors).map(([product, entry]) => {
        const error = responseObject(entry, ["error", "error_code"], [
          "error",
          "error_code",
        ]);
        const message = responseText(error.error, 2_048);
        const errorCode = responseText(error.error_code, 128, { nullable: true });
        if (errorCode !== null && !SAFE_CODE_PATTERN.test(errorCode)) {
          handlerContractError();
        }
        return [product, Object.freeze({ error: message, error_code: errorCode })];
      }),
    ),
  );
}

function projectSyncSummary(value) {
  const result = responseObject(
    value,
    [
      "status",
      "item_id",
      "institution",
      "available_products",
      "products_available",
      "fetch_errors",
      "can_proceed",
      "sync_in_progress",
      "background_products",
      "background_sync_started",
    ],
    [
      "status",
      "item_id",
      "institution",
      "available_products",
      "products_available",
      "fetch_errors",
      "can_proceed",
      "background_products",
      "background_sync_started",
    ],
  );
  if (!SYNC_SUMMARY_STATUSES.has(result.status)) handlerContractError();
  if (
    !Array.isArray(result.background_products) ||
    result.background_products.length > PLAID_DATA_PRODUCTS.length ||
    result.background_products.some((product) => !PLAID_DATA_PRODUCT_SET.has(product))
  ) {
    handlerContractError();
  }
  const output = {
    status: result.status,
    item_id: responseText(result.item_id, 256),
    institution: projectInstitution(result.institution),
    available_products: projectProductMap(result.available_products),
    products_available: responseInteger(
      result.products_available,
      0,
      PLAID_DATA_PRODUCTS.length,
    ),
    fetch_errors: projectFetchErrors(result.fetch_errors),
    can_proceed: responseBoolean(result.can_proceed),
    background_products: Object.freeze([...result.background_products]),
    background_sync_started: responseBoolean(result.background_sync_started),
  };
  if (Object.prototype.hasOwnProperty.call(result, "sync_in_progress")) {
    output.sync_in_progress = responseBoolean(result.sync_in_progress);
  }
  return Object.freeze(output);
}

function projectProductResult(value) {
  const result = responseObject(
    value,
    ["product", "status", "available", "recordsCount", "error", "errorCode"],
    ["product", "status", "available", "recordsCount", "error", "errorCode"],
  );
  if (!PLAID_DATA_PRODUCT_SET.has(result.product) || !PRODUCT_SYNC_STATUSES.has(result.status)) {
    handlerContractError();
  }
  const error = responseText(result.error, 2_048, { nullable: true });
  const errorCode = responseText(result.errorCode, 128, { nullable: true });
  if (errorCode !== null && !SAFE_CODE_PATTERN.test(errorCode)) handlerContractError();
  return Object.freeze({
    product: result.product,
    status: result.status,
    available: responseBoolean(result.available),
    recordsCount: responseInteger(result.recordsCount, 0, 1_000_000, { nullable: true }),
    error,
    errorCode,
  });
}

function projectProductSync(value) {
  const result = responseObject(value, ["success", "item_id", "result"], [
    "success",
    "item_id",
    "result",
  ]);
  if (result.success !== true) handlerContractError();
  return Object.freeze({
    success: true,
    item_id: responseText(result.item_id, 256),
    result: projectProductResult(result.result),
  });
}

function projectAssetReport(value) {
  const result = responseObject(
    value,
    ["status", "message", "data", "asset_report_token", "asset_report_id"],
    ["status"],
  );
  if (result.status === "pending") {
    if (Object.prototype.hasOwnProperty.call(result, "message")) {
      if (
        Object.prototype.hasOwnProperty.call(result, "data") ||
        Object.prototype.hasOwnProperty.call(result, "asset_report_token") ||
        Object.prototype.hasOwnProperty.call(result, "asset_report_id")
      ) {
        handlerContractError();
      }
      return Object.freeze({ status: "pending", message: responseText(result.message, 512) });
    }
    if (
      Object.prototype.hasOwnProperty.call(result, "data") ||
      !Object.prototype.hasOwnProperty.call(result, "asset_report_token") ||
      !Object.prototype.hasOwnProperty.call(result, "asset_report_id")
    ) {
      handlerContractError();
    }
    // Legacy callers receive this short-lived report token and use it only
    // with the same authenticated polling route; it is not a Plaid access
    // token and must remain an explicit, tightly projected exception.
    return Object.freeze({
      status: "pending",
      asset_report_token: responseText(result.asset_report_token, 4_096),
      asset_report_id: responseText(result.asset_report_id, 512),
    });
  }
  if (result.status !== "complete" || !Object.prototype.hasOwnProperty.call(result, "data")) {
    handlerContractError();
  }
  if (!result.data || typeof result.data !== "object") handlerContractError();
  assertNoCredentialResponseFields(result.data);
  return Object.freeze({ status: "complete", data: result.data });
}

function projectDiagnostics(value) {
  const result = responseObject(value, ["accepted", "reason"], ["accepted"]);
  const accepted = responseBoolean(result.accepted);
  if (accepted) {
    if (Object.prototype.hasOwnProperty.call(result, "reason")) handlerContractError();
    return Object.freeze({ accepted: true });
  }
  const reason = responseText(result.reason, 64);
  if (!DIAGNOSTIC_REASONS.has(reason)) handlerContractError();
  return Object.freeze({ accepted: false, reason });
}

function createDiagnosticsInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  // The old endpoint ignores a caller-supplied user_id and derives identity
  // from authentication. Keep that behavior while copying only its known
  // diagnostic fields; arbitrary caller keys never reach the data layer.
  return Object.freeze({
    sessionId: body.session_id,
    eventType: body.event_type,
    plaidStep: body.plaid_step,
    pageState: body.page_state,
    plaidMetadata: body.plaid_metadata,
    errorDetails: body.error_details,
    browserContext: body.browser_context,
  });
}

// Both preserved sync slugs use this one wire handler. The trusted adapter
// method is selected by the route table, preserving the source-only lock
// distinction without letting a browser choose it.
async function handlePlaidDataSync(financial, adapterMethod, { actor, request, signal } = {}) {
  throwIfAborted(signal);
  const body = exactObject(
    request?.body,
    ["userId", "user_id", "itemId", "item_id", "plaid_item_id"],
  );
  let result;
  try {
    result = await financial[adapterMethod]({
      actor: requireFirebaseActor(actor),
      userId: boundedText(aliasedValue(body, ["userId", "user_id"]), 128, {
        required: true,
      }),
      itemId: boundedText(
        aliasedValue(body, ["itemId", "item_id", "plaid_item_id"]),
        256,
      ),
      signal,
    });
  } catch (error) {
    return sourceSyncFailure(error);
  }
  throwIfAborted(signal);
  return json(projectSyncSummary(result));
}

/**
 * Browser-facing handlers for the preserved financial-link route.  They do
 * not register routes or promote the frozen inventory; the surrounding GCP
 * runtime controls both of those decisions.
 */
export function createFinancialLinkApiHandlers({ financialLinkAdapter } = {}) {
  const financial = requireFinancialAdapter(financialLinkAdapter);

  return Object.freeze({
    async "create-link-token"({ actor, request, signal } = {}) {
      throwIfAborted(signal);
      const body = exactObject(
        request?.body,
        ["userId", "userEmail", "redirectUri", "receivedRedirectUri"],
        ["userId"],
      );
      let result;
      try {
        result = await financial.createLinkToken({
          actor: requireFirebaseActor(actor),
          userId: boundedText(body.userId, 128, { required: true }),
          userEmail: body.userEmail,
          redirectUri: body.redirectUri,
          receivedRedirectUri: body.receivedRedirectUri,
          signal,
        });
      } catch (error) {
        return sourceCreateLinkFailure(error);
      }
      throwIfAborted(signal);
      return json(projectLinkToken(result));
    },

    async "exchange-public-token"({ actor, request, signal } = {}) {
      throwIfAborted(signal);
      const body = exactObject(
        request?.body,
        [
          "publicToken",
          "public_token",
          "userId",
          "user_id",
          "institutionName",
          "institution_name",
          "institutionId",
          "institution_id",
          "accounts",
        ],
      );
      let result;
      try {
        result = await financial.exchangePublicToken({
          actor: requireFirebaseActor(actor),
          publicToken: boundedText(
            aliasedValue(body, ["publicToken", "public_token"]),
            1_024,
            { required: true },
          ),
          userId: boundedText(aliasedValue(body, ["userId", "user_id"]), 128, {
            required: true,
          }),
          institutionName: boundedText(
            aliasedValue(body, ["institutionName", "institution_name"]),
            256,
          ),
          institutionId: boundedText(
            aliasedValue(body, ["institutionId", "institution_id"]),
            128,
          ),
          accounts: body.accounts,
          signal,
        });
      } catch (error) {
        return sourceExchangeFailure(error);
      }
      throwIfAborted(signal);
      return json(projectExchange(result));
    },

    "plaid-data-sync-start": (context) =>
      handlePlaidDataSync(financial, "startPlaidDataSync", context),
    "plaid-data-sync": (context) => handlePlaidDataSync(financial, "syncPlaidData", context),

    async "plaid-data-sync-product"({ actor, request, signal } = {}) {
      throwIfAborted(signal);
      const body = exactObject(
        request?.body,
        ["userId", "user_id", "itemId", "item_id", "plaid_item_id", "product"],
        ["product"],
      );
      const product = boundedText(body.product, 64, { required: true });
      if (!PLAID_DATA_PRODUCT_SET.has(product)) fail();
      let result;
      try {
        result = await financial.syncProductForUser({
          actor: requireFirebaseActor(actor),
          userId: boundedText(aliasedValue(body, ["userId", "user_id"]), 128, {
            required: true,
          }),
          itemId: boundedText(
            aliasedValue(body, ["itemId", "item_id", "plaid_item_id"]),
            256,
          ),
          product,
          signal,
        });
      } catch (error) {
        return sourceSyncFailure(error);
      }
      throwIfAborted(signal);
      return json(projectProductSync(result));
    },

    async "asset-report-create"({ actor, request, signal } = {}) {
      throwIfAborted(signal);
      const body = exactObject(
        request?.body,
        [
          "userId",
          "user_id",
          "assetReportToken",
          "asset_report_token",
          "accessToken",
          "access_token",
          "action",
        ],
      );
      let result;
      try {
        const assetReportToken = aliasedValue(body, ["assetReportToken", "asset_report_token"]);
        if (assetReportToken && body.action === "get") {
          result = await financial.getAssetReport({
            actor: requireFirebaseActor(actor),
            userId: boundedText(aliasedValue(body, ["userId", "user_id"]), 128, {
              required: true,
            }),
            assetReportToken: boundedText(assetReportToken, 4_096, { required: true }),
            signal,
          });
        } else {
          result = await financial.createAssetReport({
            actor: requireFirebaseActor(actor),
            accessToken: boundedText(
              aliasedValue(body, ["accessToken", "access_token"]),
              4_096,
              { required: true },
            ),
            signal,
          });
        }
      } catch (error) {
        return sourceAssetReportFailure(error, "Failed to check asset report");
      }
      throwIfAborted(signal);
      return json(projectAssetReport(result));
    },

    async "plaid-diagnostics-log"({ actor, request, signal } = {}) {
      // Diagnostics are intentionally non-blocking and lossy. Preserve the
      // source's anonymous fallback while keeping every financial-data route
      // on the strict Firebase boundary above. The frozen gateway cannot
      // enable optional auth until its separate parity/security contract is
      // approved and evidenced.
      const diagnosticsActor = optionalDiagnosticsActor(actor);
      const input = createDiagnosticsInput(request?.body);
      if (!input) return json({ accepted: false, reason: "invalid_payload" });
      try {
        throwIfAborted(signal);
        const result = await financial.logDiagnostics({
          actor: diagnosticsActor,
          ...input,
        });
        throwIfAborted(signal);
        return json(projectDiagnostics(result));
      } catch (error) {
        if (signal?.aborted) throw error;
        return json({ accepted: false, reason: "unexpected" });
      }
    },
  });
}

// This deliberately contains no financial adapter access. The source
// diagnostics endpoint reports an unavailable logging service as a lossy 200
// response, so the one legacy diagnostics slug can preserve that behavior if
// its otherwise independent Plaid/KMS/queue runtime cannot be constructed.
export function createUnavailablePlaidDiagnosticsHandler() {
  return async () => json({ accepted: false, reason: "service_unavailable" });
}

/**
 * Private Cloud Tasks endpoint for the same legacy product-sync slug.  The
 * task payload contains only a durable job UUID; ownership, item, product,
 * and Firebase identity must be resolved by `queuedProductSync` before it
 * calls the adapter and opens a KMS token envelope.
 */
export function createFinancialLinkWorkerHandlers({ queuedProductSync } = {}) {
  if (typeof queuedProductSync !== "function") {
    throw new Error("Queued financial product-sync executor is required.");
  }
  return Object.freeze({
    async "plaid-data-sync-product"({ actor, request, database, signal } = {}) {
      throwIfAborted(signal);
      const verifiedActor = requireGoogleWorkerActor(actor);
      const body = exactObject(request?.body, ["jobId"], ["jobId"]);
      const jobId = boundedText(body.jobId, 64, { required: true });
      if (!UUID_PATTERN.test(jobId)) fail();
      await queuedProductSync({
        actor: verifiedActor,
        request: Object.freeze({
          ...request,
          body: Object.freeze({ jobId: jobId.toLowerCase() }),
        }),
        database,
        signal,
      });
      throwIfAborted(signal);
      // Cloud Tasks needs only an acknowledgement.  Suppressing the product
      // payload here also makes this private route unable to return financial
      // data or credentials accidentally.
      return json({ success: true });
    },
  });
}

export function createFinancialLinkHandlers({
  financialLinkAdapter,
  queuedProductSync = null,
} = {}) {
  return Object.freeze({
    financialApi: createFinancialLinkApiHandlers({ financialLinkAdapter }),
    worker:
      queuedProductSync === null
        ? Object.freeze({})
        : createFinancialLinkWorkerHandlers({ queuedProductSync }),
  });
}
