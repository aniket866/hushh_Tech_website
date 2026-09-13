import { RuntimeError } from "../errors.js";

const VALID_ENVIRONMENTS = new Set(["sandbox", "production"]);
const PRIMARY_PRODUCT_ALLOWLIST = new Set([
  "auth",
  "transactions",
  "identity",
  "investments",
  "liabilities",
  "assets",
  "transfer",
]);
const ADDITIONAL_CONSENTED_PRODUCT_ALLOWLIST = new Set([
  "balance_plus",
  "identity",
  "investments",
  "investments_auth",
  "liabilities",
  "signal",
  "transactions",
]);
const REQUIRED_IF_SUPPORTED_PRODUCT_ALLOWLIST = new Set([
  "investments",
  "liabilities",
  "transactions",
  "auth",
]);
const NEVER_REQUIRED_PRODUCTS = new Set(["investments", "liabilities"]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function required(value, name) {
  const normalized = clean(value);
  if (!normalized) {
    throw new RuntimeError(
      "PLAID_CONFIGURATION_INVALID",
      "Financial service is unavailable.",
      503,
      { diagnosticCode: `${name}_MISSING` },
    );
  }
  return normalized;
}

function parseProducts(value, fallback, allowlist) {
  const raw = clean(value);
  if (!raw) return [...fallback];

  const accepted = raw
    .split(",")
    .map((product) => product.trim())
    .filter((product) => allowlist.has(product));
  const unique = [...new Set(accepted)];
  return unique.length > 0 ? unique : [...fallback];
}

/**
 * Preserves the server-side configuration behavior of
 * `supabase/functions/_shared/plaid.ts`.  The credentials are intentionally
 * retained only in this private object and must never be returned by callers.
 */
export function readPlaidConfiguration(env = process.env) {
  const environment = clean(env.PLAID_ENV) || "sandbox";
  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw new RuntimeError(
      "PLAID_CONFIGURATION_INVALID",
      "Financial service is unavailable.",
      503,
      { diagnosticCode: "PLAID_ENV_INVALID" },
    );
  }

  const primaryFallback = environment === "production" ? ["auth"] : ["transfer"];
  return Object.freeze({
    configured: true,
    environment,
    baseUrl: `https://${environment}.plaid.com`,
    clientId: required(env.PLAID_CLIENT_ID, "PLAID_CLIENT_ID"),
    secret: required(env.PLAID_SECRET, "PLAID_SECRET"),
    primaryProducts: parseProducts(
      env.PLAID_PRIMARY_PRODUCTS,
      primaryFallback,
      PRIMARY_PRODUCT_ALLOWLIST,
    ),
    additionalConsentedProducts: parseProducts(
      env.PLAID_ADDITIONAL_CONSENTED_PRODUCTS,
      ["identity", "transactions", "signal"],
      ADDITIONAL_CONSENTED_PRODUCT_ALLOWLIST,
    ),
    requiredIfSupportedProducts: parseProducts(
      env.PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS,
      ["investments", "liabilities"],
      REQUIRED_IF_SUPPORTED_PRODUCT_ALLOWLIST,
    ),
    dataWebhookUrl: clean(env.PLAID_DATA_WEBHOOK_URL) || null,
  });
}

function validConfiguration(config) {
  return Boolean(
    config &&
      config.configured === true &&
      VALID_ENVIRONMENTS.has(config.environment) &&
      typeof config.baseUrl === "string" &&
      /^https:\/\/(?:sandbox|production)\.plaid\.com$/.test(config.baseUrl) &&
      typeof config.clientId === "string" && config.clientId.length > 0 &&
      typeof config.secret === "string" && config.secret.length > 0 &&
      Array.isArray(config.primaryProducts) &&
      Array.isArray(config.additionalConsentedProducts) &&
      Array.isArray(config.requiredIfSupportedProducts),
  );
}

function responseData(response) {
  return response.json().catch(() => ({}));
}

export class PlaidApiError extends Error {
  constructor({ message, statusCode, details, path, cause } = {}) {
    super(message || "Plaid request failed.", { cause });
    this.name = "PlaidApiError";
    this.statusCode = Number.isInteger(statusCode) ? statusCode : 502;
    this.details = details && typeof details === "object" ? details : {};
    this.path = path || null;
  }
}

/**
 * Private HTTP boundary for Plaid.  It deliberately supports only the
 * methods the migrated financial-link contract uses; credentials are added
 * here so higher-level code cannot accidentally persist or expose them.
 */
export function createPlaidHttpClient({ config, fetchImpl = globalThis.fetch } = {}) {
  if (!validConfiguration(config) || typeof fetchImpl !== "function") {
    throw new Error("Plaid client configuration is required.");
  }

  async function post(path, body, { signal } = {}) {
    if (typeof path !== "string" || !path.startsWith("/") || /[\r\n]/.test(path)) {
      throw new Error("Plaid path is invalid.");
    }
    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          secret: config.secret,
          ...body,
        }),
        signal,
      });
    } catch (cause) {
      throw new PlaidApiError({
        message: "Plaid request failed.",
        // The legacy Edge handler's outer catch returned a generic 500 when
        // the network request itself failed (as distinct from a Plaid HTTP
        // response, whose status/body were passed through). Keep that
        // compatibility contract at the private GCP boundary.
        statusCode: 500,
        details: {},
        path,
        cause,
      });
    }

    const data = await responseData(response);
    if (!response.ok) {
      throw new PlaidApiError({
        message: data?.error_message || data?.error_code || "Plaid request failed.",
        statusCode: response.status,
        details: data,
        path,
      });
    }
    return Object.freeze({
      data,
      requestId: typeof data?.request_id === "string" ? data.request_id : null,
    });
  }

  return Object.freeze({
    configured: true,
    environment: config.environment,
    configuration: config,
    post,
  });
}

/**
 * Reproduces the old Link-token product handling.  Institution-dependent
 * products remain `required_if_supported_products` so linking a bank without
 * investments or liabilities never fails at Link creation.
 */
export function buildCreateLinkTokenRequest({
  config,
  userId,
  userEmail = null,
  redirectUri = null,
  receivedRedirectUri = null,
} = {}) {
  if (!validConfiguration(config)) {
    throw new Error("Plaid client configuration is required.");
  }
  if (typeof userId !== "string" || !userId.trim()) {
    throw new RuntimeError("INVALID_REQUEST", "userId is required", 400);
  }

  const rawPrimaryProducts = config.primaryProducts;
  const primaryProducts = rawPrimaryProducts.filter(
    (product) => !NEVER_REQUIRED_PRODUCTS.has(product),
  );
  const forcedGracefulProducts = rawPrimaryProducts.filter((product) =>
    NEVER_REQUIRED_PRODUCTS.has(product),
  );
  const requiredIfSupportedProducts = [...new Set([
    ...config.requiredIfSupportedProducts,
    ...forcedGracefulProducts,
  ].filter((product) => !primaryProducts.includes(product)))];
  if (primaryProducts.includes("transfer") && !primaryProducts.includes("auth")) {
    requiredIfSupportedProducts.unshift("auth");
  }
  const uniqueRequiredIfSupportedProducts = [...new Set(requiredIfSupportedProducts)];

  const body = {
    user: {
      client_user_id: userId,
      ...(typeof userEmail === "string" && userEmail.trim()
        ? { email_address: userEmail.trim() }
        : {}),
    },
    client_name: "Hushh",
    products: primaryProducts,
    country_codes: ["US"],
    language: "en",
    ...(uniqueRequiredIfSupportedProducts.length > 0
      ? { required_if_supported_products: uniqueRequiredIfSupportedProducts }
      : {}),
    ...(config.dataWebhookUrl ? { webhook: config.dataWebhookUrl } : {}),
  };

  const consentedProducts = config.additionalConsentedProducts.filter(
    (product) => !uniqueRequiredIfSupportedProducts.includes(product),
  );
  if (consentedProducts.length > 0) {
    body.additional_consented_products = consentedProducts;
  }
  if (typeof redirectUri === "string" && redirectUri.trim()) {
    body.redirect_uri = redirectUri.trim();
  }
  if (typeof receivedRedirectUri === "string" && receivedRedirectUri.trim()) {
    body.redirect_uri = receivedRedirectUri.trim();
    // Plaid requires no products on an OAuth resume.  Preserve all other
    // historical fields, including consent configuration and webhook.
    delete body.products;
    delete body.required_if_supported_products;
  }
  return Object.freeze(body);
}

export const PLAID_IMMEDIATE_PRODUCTS = Object.freeze([
  "accounts",
  "balance",
  "auth",
  "identity",
  "investments",
  "liabilities",
  "signal",
]);

export const PLAID_BACKGROUND_PRODUCTS = Object.freeze([
  "identity_match",
  "transactions",
  "assets",
  "investment_transactions",
  "statements",
  "income",
]);

export const PLAID_DATA_PRODUCTS = Object.freeze([
  ...PLAID_IMMEDIATE_PRODUCTS,
  ...PLAID_BACKGROUND_PRODUCTS,
]);
