const PRODUCT_CLIENT_ID = "hushh-tech";
const PRODUCT_CLIENT_APP_ID = "app_hushh-technologies_cd1895ef";
const DATABASE_NAME = "hushh_tech_app";

export const SERVICE_OWNERS = Object.freeze([
  "investor-api",
  "identity-api",
  "financial-api",
  "content-api",
  "engagement-api-worker",
  "signed-webhook-service",
  "worker",
]);

const DATABASE_ACCOUNT_STEMS = Object.freeze({
  "investor-api": "hushh-tech-investor-api",
  "identity-api": "hushh-tech-identity-api",
  "financial-api": "hushh-tech-financial-api",
  "content-api": "hushh-tech-content-api",
  "engagement-api-worker": "hushh-tech-engagement-api",
  "signed-webhook-service": "hushh-tech-webhooks",
  worker: "hushh-tech-worker",
});

const CLOUD_RUN_SERVICE_NAMES = Object.freeze({
  "investor-api": "hushh-tech-investor-api",
  "identity-api": "hushh-tech-identity-api",
  "financial-api": "hushh-tech-financial-api",
  "content-api": "hushh-tech-content-api",
  "engagement-api-worker": "hushh-tech-engagement-api",
  "signed-webhook-service": "hushh-tech-webhooks",
  worker: "hushh-tech-worker",
});

const PROJECT_CONTRACTS = Object.freeze({
  "hushh-tech-uat": Object.freeze({
    stage: "uat",
    number: "175298245599",
    region: "us-central1",
    productAudience: "hushh-tech-uat",
    firebaseProjectId: "hushh-tech-uat",
    instanceConnectionName: "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat",
  }),
  "hushh-tech-prod": Object.freeze({
    stage: "prod",
    number: "646258530541",
    region: "us-central1",
    productAudience: "hushh-tech-prod",
    firebaseProjectId: "hushh-tech-prod",
    instanceConnectionName:
      "hushh-tech-prod:us-central1:hushh-tech-app-pg-prod",
  }),
});

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function required(env, name) {
  const value = clean(env[name]);
  if (!value) throw new ConfigurationError(`${name} is required.`);
  return value;
}

function boundedInteger(env, name, fallback, minimum, maximum) {
  const raw = clean(env[name]);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function exactBoolean(env, name, fallback = false) {
  const raw = clean(env[name]);
  if (!raw) return fallback;
  if (raw !== "true" && raw !== "false") {
    throw new ConfigurationError(`${name} must be true or false.`);
  }
  return raw === "true";
}

function canonicalAudience(value, expectedOrigin) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError("SERVICE_AUDIENCE must be a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.port ||
    parsed.origin !== expectedOrigin
  ) {
    throw new ConfigurationError(
      "SERVICE_AUDIENCE does not match this service and project.",
    );
  }
  return parsed.origin;
}

function expectedGoogleCaller(serviceOwner, projectId, stage) {
  const account =
    serviceOwner === "worker"
      ? `hushh-tech-task-runner-${stage}`
      : `hushh-tech-web-${stage}`;
  return `${account}@${projectId}.iam.gserviceaccount.com`;
}

function googleCallers(value, expected) {
  const callers = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (callers.length !== 1 || callers[0] !== expected) {
    throw new ConfigurationError(
      "ALLOWED_GOOGLE_CALLERS does not match this service and project.",
    );
  }
  return Object.freeze(callers);
}

function assertNoDatabasePassword(env) {
  if (clean(env.DATABASE_URL) || clean(env.PGPASSWORD)) {
    throw new ConfigurationError(
      "Password-based database configuration is not allowed.",
    );
  }
}

export function readRuntimeConfig(env = process.env) {
  const serviceOwner = required(env, "SERVICE_OWNER");
  if (!SERVICE_OWNERS.includes(serviceOwner)) {
    throw new ConfigurationError("SERVICE_OWNER is not allowlisted.");
  }

  const projectId = required(env, "GOOGLE_CLOUD_PROJECT");
  const project = PROJECT_CONTRACTS[projectId];
  if (!project) {
    throw new ConfigurationError("GOOGLE_CLOUD_PROJECT is not allowlisted.");
  }

  const ingressMode = required(env, "CLOUD_RUN_INGRESS_MODE");
  if (
    !["internal", "internal-and-cloud-load-balancing"].includes(ingressMode) ||
    clean(env.PRIVATE_INGRESS_ENFORCED) !== "true"
  ) {
    throw new ConfigurationError("Private Cloud Run ingress is not asserted.");
  }

  const firebaseProjectId = required(env, "FIREBASE_PROJECT_ID");
  const productAudience = required(env, "PRODUCT_AUDIENCE");
  const productClientAppId = required(env, "PRODUCT_CLIENT_APP_ID");
  if (
    firebaseProjectId !== project.firebaseProjectId ||
    productAudience !== project.productAudience ||
    productClientAppId !== PRODUCT_CLIENT_APP_ID
  ) {
    throw new ConfigurationError(
      "Firebase product authority contract drifted.",
    );
  }

  const instanceConnectionName = required(env, "INSTANCE_CONNECTION_NAME");
  const database = required(env, "PGDATABASE");
  const databaseUser = required(env, "PGUSER");
  const expectedDatabaseUser = `${DATABASE_ACCOUNT_STEMS[serviceOwner]}-${project.stage}@${projectId}.iam`;
  if (
    instanceConnectionName !== project.instanceConnectionName ||
    database !== DATABASE_NAME ||
    databaseUser !== expectedDatabaseUser
  ) {
    throw new ConfigurationError("Cloud SQL runtime contract drifted.");
  }
  assertNoDatabasePassword(env);
  const publicStockQuotesEnabled = exactBoolean(
    env,
    "HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED",
  );
  const finnhubApiKey = clean(env.FINNHUB_API_KEY);
  const googleMapsApiKey = clean(env.GOOGLE_MAPS_API_KEY);
  const nominatimUserAgent =
    clean(env.NOMINATIM_USER_AGENT) ||
    "hushh-location-geocode/1.0 (https://hushh.ai)";
  if (/[\r\n]/.test(nominatimUserAgent)) {
    throw new ConfigurationError("NOMINATIM_USER_AGENT is invalid.");
  }
  if (
    serviceOwner !== "investor-api" &&
    (publicStockQuotesEnabled || finnhubApiKey || googleMapsApiKey)
  ) {
    throw new ConfigurationError(
      "The public stock-quotes provider belongs only to investor-api.",
    );
  }
  if (serviceOwner === "investor-api") {
    if (publicStockQuotesEnabled !== Boolean(finnhubApiKey)) {
      throw new ConfigurationError(
        "Public stock quotes and FINNHUB_API_KEY must be enabled together.",
      );
    }
  }
  const expectedServiceAudience = `https://${CLOUD_RUN_SERVICE_NAMES[serviceOwner]}-${project.number}.${project.region}.run.app`;
  const handlerDeadlineMs = boundedInteger(
    env,
    "HANDLER_DEADLINE_MS",
    20_000,
    2_000,
    25_000,
  );
  const databaseStatementTimeoutMs = boundedInteger(
    env,
    "DB_STATEMENT_TIMEOUT_MS",
    15_000,
    1_000,
    24_000,
  );
  if (databaseStatementTimeoutMs >= handlerDeadlineMs) {
    throw new ConfigurationError(
      "DB_STATEMENT_TIMEOUT_MS must be below HANDLER_DEADLINE_MS.",
    );
  }

  return Object.freeze({
    serviceOwner,
    projectId,
    stage: project.stage,
    port: boundedInteger(env, "PORT", 8080, 1, 65_535),
    ingressMode,
    serviceAudience: canonicalAudience(
      required(env, "SERVICE_AUDIENCE"),
      expectedServiceAudience,
    ),
    allowedGoogleCallers: googleCallers(
      required(env, "ALLOWED_GOOGLE_CALLERS"),
      expectedGoogleCaller(serviceOwner, projectId, project.stage),
    ),
    firebaseProjectId,
    productClient: PRODUCT_CLIENT_ID,
    productAudience,
    productClientAppId,
    recentAuthSeconds: boundedInteger(env, "RECENT_AUTH_SECONDS", 300, 60, 900),
    instanceConnectionName,
    database,
    databaseUser,
    databasePoolMax: boundedInteger(env, "DB_POOL_MAX", 5, 1, 20),
    databaseConnectTimeoutMs: boundedInteger(
      env,
      "DB_CONNECT_TIMEOUT_MS",
      5_000,
      500,
      15_000,
    ),
    databaseStatementTimeoutMs,
    handlerDeadlineMs,
    requestBodyLimitBytes: boundedInteger(
      env,
      "REQUEST_BODY_LIMIT_BYTES",
      1_048_576,
      16_384,
      1_048_576,
    ),
    requestRateLimit: boundedInteger(env, "REQUEST_RATE_LIMIT", 120, 10, 600),
    publicStockQuotesEnabled,
    publicStockQuotesRateLimit: boundedInteger(
      env,
      "PUBLIC_STOCK_QUOTES_RATE_LIMIT",
      30,
      1,
      120,
    ),
    publicStockQuotesProviderRequestRateLimit: boundedInteger(
      env,
      "PUBLIC_STOCK_QUOTES_PROVIDER_REQUESTS_PER_MINUTE",
      2,
      1,
      10,
    ),
    finnhubQuoteTimeoutMs: boundedInteger(
      env,
      "FINNHUB_QUOTE_TIMEOUT_MS",
      5_000,
      100,
      15_000,
    ),
    finnhubApiKey,
    googleMapsApiKey,
    nominatimUserAgent,
  });
}

export const RUNTIME_CONSTANTS = Object.freeze({
  firebaseProjectIds: Object.freeze(
    Object.fromEntries(
      Object.entries(PROJECT_CONTRACTS).map(([projectId, contract]) => [
        projectId,
        contract.firebaseProjectId,
      ]),
    ),
  ),
  productClient: PRODUCT_CLIENT_ID,
  productClientAppId: PRODUCT_CLIENT_APP_ID,
  databaseName: DATABASE_NAME,
});
