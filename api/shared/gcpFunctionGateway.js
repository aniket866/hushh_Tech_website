import { randomUUID } from "node:crypto";

const OWNER_CONFIG = Object.freeze({
  "investor-api": Object.freeze({
    env: "HUSHH_TECH_INVESTOR_API_URL",
    service: "hushh-tech-investor-api",
  }),
  "identity-api": Object.freeze({
    env: "HUSHH_TECH_IDENTITY_API_URL",
    service: "hushh-tech-identity-api",
  }),
  "content-api": Object.freeze({
    env: "HUSHH_TECH_CONTENT_API_URL",
    service: "hushh-tech-content-api",
  }),
  "engagement-api-worker": Object.freeze({
    env: "HUSHH_TECH_ENGAGEMENT_API_URL",
    service: "hushh-tech-engagement-api",
  }),
  "signed-webhook-service": Object.freeze({
    env: "HUSHH_TECH_WEBHOOKS_URL",
    service: "hushh-tech-webhooks",
  }),
  "financial-api-worker": Object.freeze({
    env: "HUSHH_TECH_FINANCIAL_API_URL",
    service: "hushh-tech-financial-api",
  }),
});

const PROJECT_CONFIG = Object.freeze({
  "hushh-tech-uat": Object.freeze({
    number: "175298245599",
    region: "us-central1",
  }),
  "hushh-tech-prod": Object.freeze({
    number: "646258530541",
    region: "us-central1",
  }),
});

const AUTH_MODES = new Set([
  "firebase_bearer",
  "firebase_bearer_or_google_service_identity",
  "firebase_bearer_recent_auth",
  "firebase_bearer_recent_auth_or_google_service_identity",
  "provider_signature_raw_body",
  "none_feature_retired",
]);
const PUBLIC_COMPATIBILITY_FIREBASE_MODES = new Set([
  "firebase_bearer",
  "firebase_bearer_or_google_service_identity",
  "firebase_bearer_recent_auth",
  "firebase_bearer_recent_auth_or_google_service_identity",
]);
// The frozen inventory predates the Finance Link migration and labels these
// browser compatibility routes as recent-auth endpoints. The corresponding
// Supabase handlers accepted any valid product session, however. Keep that
// source behavior in a deliberately narrow compatibility boundary instead of
// relaxing recent-auth enforcement for the rest of the gateway.
const LEGACY_FINANCIAL_LINK_SLUGS = new Set([
  "asset-report-create",
  "create-link-token",
  "exchange-public-token",
  "plaid-data-sync",
  "plaid-data-sync-product",
  "plaid-data-sync-start",
  "plaid-diagnostics-log",
]);

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "idempotency-key",
  "plaid-verification",
  "stripe-signature",
  "x-github-delivery",
  "x-github-event",
  "x-hub-signature-256",
  "x-plaid-verification",
  "x-request-id",
]);

const BASE_RESPONSE_HEADERS = new Set([
  "content-disposition",
  "content-type",
  "etag",
  "retry-after",
]);

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_QUERY_BYTES = 4096;
const MAX_QUERY_VALUES = 32;
const RECENT_AUTH_SECONDS = 5 * 60;
const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const CREDENTIAL_QUERY_PATTERN =
  /(?:authorization|credential|password|private[_-]?key|secret|service[_-]?role|token)/i;

export class GcpFunctionGatewayError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "GcpFunctionGatewayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRegistryEntry(entry) {
  const slug = clean(entry?.slug ?? entry?.source?.slug);
  const ownerGroup = clean(entry?.owner_group);
  const authMode = clean(entry?.auth_mode);
  const migrationState = clean(entry?.migration_state);
  const finalDisposition = clean(entry?.final_disposition);

  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid legacy function slug: ${slug || "<empty>"}.`);
  }
  if (finalDisposition === "RETIRE_WITH_410") {
    if (slug !== "get-secrets" || authMode !== "none_feature_retired") {
      throw new Error("Only get-secrets may use RETIRE_WITH_410.");
    }
  } else if (!OWNER_CONFIG[ownerGroup]) {
    throw new Error(`Invalid GCP function owner for ${slug}.`);
  }
  if (!AUTH_MODES.has(authMode)) {
    throw new Error(`Invalid auth mode for ${slug}.`);
  }

  return Object.freeze({
    slug,
    ownerGroup,
    authMode,
    migrationState,
    finalDisposition,
  });
}

export function buildGcpFunctionRegistry(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("Function registry entries must be an array.");
  }

  const registry = new Map();
  for (const rawEntry of entries) {
    const entry = normalizeRegistryEntry(rawEntry);
    if (registry.has(entry.slug)) {
      throw new Error(`Duplicate legacy function slug: ${entry.slug}.`);
    }
    registry.set(entry.slug, entry);
  }
  return registry;
}

function canonicalServiceOrigin(value, ownerGroup, project) {
  const owner = OWNER_CONFIG[ownerGroup];
  const projectConfig = PROJECT_CONFIG[project];
  const envName = owner?.env ?? "<unknown>";
  const configured = clean(value);
  if (!configured || !owner || !projectConfig) {
    throw new GcpFunctionGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Service unavailable.",
      503,
    );
  }

  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new GcpFunctionGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Service unavailable.",
      503,
    );
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new GcpFunctionGatewayError(
      "UPSTREAM_UNAVAILABLE",
      `Invalid ${envName} service origin.`,
      503,
    );
  }
  const expectedHostname = `${owner.service}-${projectConfig.number}.${projectConfig.region}.run.app`;
  if (parsed.hostname !== expectedHostname || parsed.port) {
    throw new GcpFunctionGatewayError(
      "UPSTREAM_UNAVAILABLE",
      `Invalid ${envName} service origin.`,
      503,
    );
  }
  return parsed.origin;
}

function requestPath(req) {
  const url = new URL(req.originalUrl ?? req.url ?? "/", "https://local.invalid");
  return { pathname: url.pathname, search: url.search };
}

function parseLegacyFunctionPath(req) {
  const { pathname, search } = requestPath(req);
  const prefix = "/functions/v1/";
  if (!pathname.startsWith(prefix)) return null;

  const remainder = pathname.slice(prefix.length);
  const [rawSlug, ...rawSegments] = remainder.split("/");
  let slug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    throw new GcpFunctionGatewayError("INVALID_ROUTE", "Not found.", 404);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new GcpFunctionGatewayError("INVALID_ROUTE", "Not found.", 404);
  }

  const safeSegments = rawSegments.map((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new GcpFunctionGatewayError("INVALID_ROUTE", "Not found.", 404);
    }
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new GcpFunctionGatewayError("INVALID_ROUTE", "Not found.", 404);
    }
    return encodeURIComponent(decoded);
  });

  return {
    slug,
    suffix: safeSegments.length ? `/${safeSegments.join("/")}` : "",
    search,
  };
}

function validateRouteContract(route, req, contract) {
  if (!contract || contract.slug !== route.slug) {
    throw new GcpFunctionGatewayError(
      "FUNCTION_NOT_MIGRATED",
      "This feature is not available on GCP yet.",
      503,
    );
  }

  const method = String(req.method || "GET").toUpperCase();
  if (!contract.methods.includes(method)) {
    throw new GcpFunctionGatewayError(
      "METHOD_NOT_ALLOWED",
      "Method not allowed.",
      405,
    );
  }
  if (!contract.subpaths.includes(route.suffix)) {
    throw new GcpFunctionGatewayError("INVALID_ROUTE", "Not found.", 404);
  }
  if (Buffer.byteLength(route.search, "utf8") > MAX_QUERY_BYTES) {
    throw new GcpFunctionGatewayError("INVALID_QUERY", "Invalid query.", 400);
  }

  const params = new URLSearchParams(route.search);
  let values = 0;
  for (const [key, value] of params) {
    values += 1;
    if (
      values > MAX_QUERY_VALUES ||
      CREDENTIAL_QUERY_PATTERN.test(key) ||
      !contract.queryKeys.includes(key) ||
      Buffer.byteLength(value, "utf8") > 2048
    ) {
      throw new GcpFunctionGatewayError("INVALID_QUERY", "Invalid query.", 400);
    }
  }
  return method;
}

function headerValue(req, name) {
  const headers = req.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : clean(value);
}

function requestBody(req, entry) {
  if (["GET", "HEAD"].includes(String(req.method).toUpperCase())) return null;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (entry.authMode === "provider_signature_raw_body") {
    throw new GcpFunctionGatewayError(
      "INVALID_BODY",
      "A signed raw request body is required.",
      400,
    );
  }
  if (req.body === undefined || req.body === null) return Buffer.alloc(0);
  return Buffer.from(
    typeof req.body === "string" ? req.body : JSON.stringify(req.body),
    "utf8",
  );
}

function requestMediaType(req) {
  return headerValue(req, "content-type").split(";", 1)[0].trim().toLowerCase();
}

function validateRequestBody(req, entry, contract) {
  const body = requestBody(req, entry);
  if (!body) return null;
  if (body.length > contract.maxRequestBytes || body.length > MAX_REQUEST_BYTES) {
    throw new GcpFunctionGatewayError(
      "PAYLOAD_TOO_LARGE",
      "Request is too large.",
      413,
    );
  }
  if (body.length === 0) return body;

  const mediaType = requestMediaType(req);
  if (!mediaType || !contract.contentTypes.includes(mediaType)) {
    if (isLossyPlaidDiagnosticsRoute(entry)) return body;
    throw new GcpFunctionGatewayError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Unsupported request type.",
      415,
    );
  }
  if (mediaType === "application/json") {
    try {
      JSON.parse(body.toString("utf8"));
    } catch {
      if (isLossyPlaidDiagnosticsRoute(entry)) return body;
      throw new GcpFunctionGatewayError(
        "INVALID_BODY",
        "Invalid request body.",
        400,
      );
    }
  }
  return body;
}

function jsonError(res, error) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  return res.status(error.statusCode).json({
    detail: { code: error.code, message: error.message },
  });
}

function isRecentAuthMode(authMode) {
  return authMode.includes("recent_auth");
}

function isLegacyFinancialLinkCompatibilityRoute(entry) {
  return (
    entry?.ownerGroup === "financial-api-worker" &&
    LEGACY_FINANCIAL_LINK_SLUGS.has(entry.slug)
  );
}

function requiresRecentFirebaseAuth(entry) {
  return (
    isRecentAuthMode(entry.authMode) &&
    !isLegacyFinancialLinkCompatibilityRoute(entry)
  );
}

function isLossyPlaidDiagnosticsRoute(entry) {
  return (
    entry?.slug === "plaid-diagnostics-log" &&
    entry.ownerGroup === "financial-api-worker" &&
    entry.authMode ===
      "firebase_bearer_recent_auth_or_google_service_identity"
  );
}

async function requireFirebaseIdentity({
  req,
  entry,
  verifyFirebaseToken,
  now,
}) {
  if (typeof verifyFirebaseToken !== "function") {
    throw new GcpFunctionGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Sign-in service unavailable.",
      503,
    );
  }

  const authorization = headerValue(req, "authorization");
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match || match[1].length > 8192) {
    throw new GcpFunctionGatewayError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }

  let identity;
  try {
    identity = await verifyFirebaseToken(match[1]);
  } catch (error) {
    if (error?.state === "UPSTREAM_UNAVAILABLE") {
      throw new GcpFunctionGatewayError(
        "UPSTREAM_UNAVAILABLE",
        "Sign-in service unavailable.",
        503,
      );
    }
    throw new GcpFunctionGatewayError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }

  const uid = clean(identity?.uid);
  const authTime = Number(identity?.authTime);
  if (!uid || uid.length > 128 || !Number.isFinite(authTime)) {
    throw new GcpFunctionGatewayError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }
  if (
    requiresRecentFirebaseAuth(entry) &&
    Math.floor(now() / 1000) - authTime > RECENT_AUTH_SECONDS
  ) {
    throw new GcpFunctionGatewayError(
      "RECENT_AUTH_REQUIRED",
      "Sign in again.",
      401,
    );
  }

  return { uid, authTime, token: match[1] };
}

async function requireCompatibilityFirebaseIdentity(args) {
  try {
    return await requireFirebaseIdentity(args);
  } catch (error) {
    // The source diagnostics endpoint was intentionally public and lossy:
    // valid bearers associate an actor, while absent or unverifiable bearers
    // are recorded anonymously. This exception is constrained to the one
    // frozen diagnostics slug; every financial-data route remains fail closed.
    if (
      isLossyPlaidDiagnosticsRoute(args.entry) &&
      error instanceof GcpFunctionGatewayError &&
      ["UNAUTHENTICATED", "UPSTREAM_UNAVAILABLE"].includes(error.code)
    ) {
      return null;
    }
    throw error;
  }
}

function copyRequestHeaders(req) {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = headerValue(req, name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function setResponseHeaders(res, response, contract) {
  const names = new Set([...BASE_RESPONSE_HEADERS, ...contract.responseHeaders]);
  if (contract.publicCache) names.add("cache-control");
  for (const name of names) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!contract.publicCache) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
  }
  res.setHeader("X-Hushh-Compatibility-Source", "gcp");
}

async function readBoundedResponse(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GcpFunctionGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          502,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function waitForDrainOrClose(res, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off?.("drain", onDrain);
      res.off?.("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Client connection closed."));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Upstream deadline exceeded."));
    };
    if (signal?.aborted) return onAbort();
    res.once("drain", onDrain);
    res.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function sendUpstreamResponse(res, response, contract, signal) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new GcpFunctionGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Service unavailable.",
      502,
    );
  }

  // Unit-test and Vercel-style response adapters do not expose a streaming
  // writer. They still use a bounded reader; real Express responses stream.
  if (typeof res.write !== "function" || typeof res.end !== "function") {
    const bytes = await readBoundedResponse(response);
    setResponseHeaders(res, response, contract);
    return res.status(response.status).send(bytes);
  }

  setResponseHeaders(res, response, contract);
  res.status(response.status);
  if (!response.body) return res.end();

  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        res.destroy?.();
        return;
      }
      if (!res.write(Buffer.from(value))) await waitForDrainOrClose(res, signal);
    }
    return res.end();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createGcpFunctionGateway({
  registry,
  contracts,
  env = process.env,
  fetchImpl = globalThis.fetch,
  verifyFirebaseToken,
  getServiceIdentityToken,
  now = Date.now,
  requestId = randomUUID,
} = {}) {
  if (!(registry instanceof Map)) {
    throw new Error("A validated GCP function registry is required.");
  }
  if (!(contracts instanceof Map)) {
    throw new Error("A validated GCP function contract map is required.");
  }

  return async function gcpFunctionGateway(req, res) {
    try {
      const route = parseLegacyFunctionPath(req);
      if (!route) {
        throw new GcpFunctionGatewayError("INVALID_ROUTE", "Not found.", 404);
      }

      const entry = registry.get(route.slug);
      if (!entry) {
        throw new GcpFunctionGatewayError("INVALID_ROUTE", "Not found.", 404);
      }
      if (entry.finalDisposition === "RETIRE_WITH_410") {
        throw new GcpFunctionGatewayError(
          "FEATURE_RETIRED",
          "This feature is no longer available.",
          410,
        );
      }
      if (entry.migrationState !== "PORTED_AND_VERIFIED") {
        throw new GcpFunctionGatewayError(
          "FUNCTION_NOT_MIGRATED",
          "This feature is not available on GCP yet.",
          503,
        );
      }

      const contract = contracts.get(entry.slug);
      const method = validateRouteContract(route, req, contract);

      const project = clean(env.GOOGLE_CLOUD_PROJECT);
      const enabled = clean(env.HUSHH_TECH_GCP_FUNCTIONS_ENABLED) === "true";
      if (
        !enabled ||
        !["hushh-tech-uat", "hushh-tech-prod"].includes(project)
      ) {
        throw new GcpFunctionGatewayError(
          "FEATURE_DISABLED",
          "This feature is unavailable.",
          404,
        );
      }

      const body = validateRequestBody(req, entry, contract);

      // The public compatibility surface always requires a Firebase product
      // session. Registry modes ending in google_service_identity describe the
      // private target's worker contract; Cloud Tasks and Scheduler call that
      // private Cloud Run service directly and never enter this gateway.
      if (
        entry.authMode !== "provider_signature_raw_body" &&
        !PUBLIC_COMPATIBILITY_FIREBASE_MODES.has(entry.authMode)
      ) {
        throw new GcpFunctionGatewayError(
          "FEATURE_DISABLED",
          "This feature is unavailable.",
          404,
        );
      }
      const identity =
        entry.authMode === "provider_signature_raw_body"
          ? null
          : await requireCompatibilityFirebaseIdentity({
              req,
              entry,
              verifyFirebaseToken,
              now,
            });

      const owner = OWNER_CONFIG[entry.ownerGroup];
      const origin = canonicalServiceOrigin(
        env[owner.env],
        entry.ownerGroup,
        project,
      );
      if (typeof getServiceIdentityToken !== "function") {
        throw new GcpFunctionGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          503,
        );
      }

      let serviceToken;
      try {
        serviceToken = await getServiceIdentityToken(origin);
      } catch {
        throw new GcpFunctionGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          503,
        );
      }
      if (!clean(serviceToken)) {
        throw new GcpFunctionGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          503,
        );
      }

      const headers = copyRequestHeaders(req);
      headers.set("Authorization", `Bearer ${serviceToken}`);
      headers.set("X-Hushh-Request-Id", requestId());
      headers.set("X-Hushh-Legacy-Function", entry.slug);
      if (identity) {
        headers.set(
          "X-Hushh-Firebase-Authorization",
          `Bearer ${identity.token}`,
        );
        headers.set("X-Hushh-Firebase-Uid", identity.uid);
        headers.set("X-Hushh-Firebase-Auth-Time", String(identity.authTime));
      }

      const target = `${origin}/api/v1/legacy-functions/${entry.slug}${route.suffix}${route.search}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), contract.timeoutMs);
      const abortForClient = () => controller.abort();
      const abortForResponseClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once?.("aborted", abortForClient);
      res.once?.("close", abortForResponseClose);
      let response;
      try {
        const fetchOptions = {
          method,
          headers,
          redirect: "error",
          signal: controller.signal,
        };
        if (body !== null) fetchOptions.body = body;
        response = await fetchImpl(target, fetchOptions);
        return await sendUpstreamResponse(res, response, contract, controller.signal);
      } catch {
        if (res.headersSent) {
          res.destroy?.();
          return;
        }
        throw new GcpFunctionGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          503,
        );
      } finally {
        clearTimeout(timer);
        req.off?.("aborted", abortForClient);
        res.off?.("close", abortForResponseClose);
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy?.();
        return;
      }
      const typed =
        error instanceof GcpFunctionGatewayError
          ? error
          : new GcpFunctionGatewayError(
              "UPSTREAM_UNAVAILABLE",
              "Service unavailable.",
              503,
            );
      return jsonError(res, typed);
    }
  };
}

export const GCP_FUNCTION_OWNER_ENV = Object.freeze(
  Object.fromEntries(
    Object.entries(OWNER_CONFIG).map(([owner, config]) => [owner, config.env]),
  ),
);
