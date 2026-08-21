import { randomUUID } from "node:crypto";

import express from "express";

import {
  assertFunctionRequestContract,
  FUNCTION_CONTRACTS,
} from "./contracts.js";
import { withFirebaseTransaction } from "./database.js";
import { asRuntimeError, errorPayload, RuntimeError } from "./errors.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  LEGACY_FUNCTION_REGISTRY,
  REGISTRY_METADATA,
  serviceOwnsEntry,
  serviceRule,
} from "./registry.js";

const ROUTE_PREFIX = "/api/v1/legacy-functions/";
const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-disposition",
  "content-type",
  "etag",
  "location",
  "retry-after",
]);
const HANDLER_REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function requestId(request) {
  const candidate = String(request.headers?.["x-request-id"] ?? "").trim();
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function parseRoute(request) {
  const url = new URL(request.originalUrl ?? request.url, "https://local.invalid");
  if (!url.pathname.startsWith(ROUTE_PREFIX)) {
    throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
  }
  const remainder = url.pathname.slice(ROUTE_PREFIX.length);
  const segments = remainder.split("/");
  let slug;
  try {
    slug = decodeURIComponent(segments.shift() ?? "");
  } catch {
    throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
  }

  const suffix = segments.map((raw) => {
    let value;
    try {
      value = decodeURIComponent(raw);
    } catch {
      throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
    }
    if (
      !value ||
      value.length > 512 ||
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
    }
    return value;
  });
  return Object.freeze({ slug, suffix: Object.freeze(suffix), search: url.search });
}

function workerFirebaseUid(request) {
  const value = String(request.headers?.["x-hushh-firebase-uid"] ?? "").trim();
  if (!value) return null;
  if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }
  return value;
}

function databaseFacade(database, firebaseUid, statementTimeoutMs) {
  return Object.freeze({
    async transaction(work) {
      if (!database?.pool) {
        throw new RuntimeError(
          "DATABASE_UNAVAILABLE",
          "Database unavailable.",
          503,
        );
      }
      if (!firebaseUid) {
        throw new RuntimeError(
          "OWNERSHIP_CONTEXT_REQUIRED",
          "User ownership required.",
          403,
        );
      }
      return withFirebaseTransaction(database.pool, firebaseUid, work, {
        statementTimeoutMs,
      });
    },
  });
}

function handlerHeaders(headers) {
  const projected = Object.create(null);
  for (const name of HANDLER_REQUEST_HEADER_ALLOWLIST) {
    const raw = headers?.[name];
    if (raw === undefined) continue;
    const value = Array.isArray(raw) ? raw.join(",") : String(raw);
    if (value.length > 8_192) {
      throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
    }
    projected[name] = value;
  }
  return Object.freeze(projected);
}

function parsedHandlerBody(request) {
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) return null;
  const contentType = String(request.headers?.["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json" && !contentType.endsWith("+json")) {
    throw new RuntimeError("UNSUPPORTED_MEDIA_TYPE", "Invalid request.", 415);
  }
  try {
    return JSON.parse(request.body.toString("utf8"));
  } catch {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }
}

function setSecurityHeaders(_request, response, next) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  next();
}

function sendHandlerResponse(response, output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new RuntimeError("HANDLER_CONTRACT_INVALID", "Service unavailable.", 503);
  }
  const status = Number(output.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RuntimeError("HANDLER_CONTRACT_INVALID", "Service unavailable.", 503);
  }
  for (const [rawName, rawValue] of Object.entries(output.headers ?? {})) {
    const name = rawName.toLowerCase();
    const value = String(rawValue);
    if (!RESPONSE_HEADER_ALLOWLIST.has(name) || value.length > 2_048) {
      throw new RuntimeError("HANDLER_CONTRACT_INVALID", "Service unavailable.", 503);
    }
    response.setHeader(name, value);
  }

  if (output.body === undefined || output.body === null) {
    return response.status(status).end();
  }
  if (Buffer.isBuffer(output.body)) {
    if (output.body.length > MAX_RESPONSE_BYTES) {
      throw new RuntimeError("HANDLER_CONTRACT_INVALID", "Service unavailable.", 503);
    }
    return response.status(status).send(output.body);
  }
  const serialized = JSON.stringify(output.body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES) {
    throw new RuntimeError("HANDLER_CONTRACT_INVALID", "Service unavailable.", 503);
  }
  return response.status(status).type("application/json").send(serialized);
}

export function createApp({
  config,
  database,
  verifyGoogleServiceRequest,
  verifyFirebaseProductRequest,
  verifyWebhookRequest,
  verifyReadiness,
  handlers = Object.freeze({}),
  contracts = FUNCTION_CONTRACTS,
  registry = LEGACY_FUNCTION_REGISTRY,
  ownsEntry = serviceOwnsEntry,
  rateLimiter = createRateLimiter({ limit: config.requestRateLimit }),
  log = () => {},
} = {}) {
  if (
    !config ||
    typeof verifyGoogleServiceRequest !== "function" ||
    typeof verifyFirebaseProductRequest !== "function" ||
    typeof verifyWebhookRequest !== "function" ||
    typeof verifyReadiness !== "function"
  ) {
    throw new Error("Complete runtime dependencies are required.");
  }
  const rule = serviceRule(config.serviceOwner);
  if (!rule) throw new Error("SERVICE_OWNER rule is required.");

  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use(setSecurityHeaders);

  app.get("/healthz", (_request, response) => {
    response.status(200).json({
      status: "ok",
      service_owner: config.serviceOwner,
      registry_version: REGISTRY_METADATA.version,
      registry_count: REGISTRY_METADATA.count,
    });
  });

  app.get("/readyz", async (_request, response) => {
    try {
      await verifyReadiness();
      response.status(200).json({ status: "ready", service_owner: config.serviceOwner });
    } catch {
      response.status(503).json({ status: "not_ready", service_owner: config.serviceOwner });
    }
  });

  app.use(
    "/api/v1/legacy-functions",
    express.raw({
      type: () => true,
      limit: config.requestBodyLimitBytes,
      inflate: false,
    }),
  );

  app.all("/api/v1/legacy-functions/*splat", async (request, response) => {
    const id = requestId(request);
    response.setHeader("X-Request-Id", id);
    try {
      const method = String(request.method ?? "").toUpperCase();
      if (!ALLOWED_METHODS.has(method)) {
        throw new RuntimeError("METHOD_NOT_ALLOWED", "Method not allowed.", 405);
      }
      const googleCaller = await verifyGoogleServiceRequest(request);
      const route = parseRoute(request);
      const entry = registry[route.slug] ?? null;
      if (!entry || !ownsEntry(config.serviceOwner, entry)) {
        throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
      }
      if (entry.final_disposition === "RETIRE_WITH_410") {
        throw new RuntimeError(
          "FEATURE_RETIRED",
          "This feature is no longer available.",
          410,
        );
      }
      if (entry.migration_state !== "PORTED_AND_VERIFIED") {
        throw new RuntimeError(
          "FUNCTION_NOT_MIGRATED",
          "This feature is not available on GCP yet.",
          503,
        );
      }
      assertFunctionRequestContract(contracts[entry.slug], {
        method,
        route,
        headers: request.headers,
        rawBody: request.body,
      });
      const handler = handlers[entry.slug];
      if (typeof handler !== "function") {
        throw new RuntimeError(
          "FUNCTION_NOT_IMPLEMENTED",
          "This feature is not available on GCP yet.",
          503,
        );
      }

      let actor;
      let firebaseUid = null;
      if (rule.actor === "firebase") {
        actor = await verifyFirebaseProductRequest(request, entry);
        firebaseUid = actor.uid;
      } else if (rule.actor === "webhook") {
        actor = await verifyWebhookRequest(request, entry);
      } else if (rule.actor === "google-worker") {
        actor = googleCaller;
        firebaseUid = workerFirebaseUid(request);
      } else {
        throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
      }

      const actorKey = actor.uid ?? actor.eventId ?? actor.email ?? actor.subject;
      if (!actorKey) {
        throw new RuntimeError("AUTH_CONTEXT_INVALID", "Access denied.", 403);
      }
      rateLimiter(`${googleCaller.email}:${actor.kind}:${actorKey}:${entry.slug}`);
      const projectedRequest = {
        method,
        headers: handlerHeaders(request.headers),
        route,
        requestId: id,
      };
      if (entry.auth_mode === "provider_signature_raw_body") {
        projectedRequest.rawBody = request.body;
      } else {
        projectedRequest.body = parsedHandlerBody(request);
      }
      const output = await handler({
        actor,
        googleCaller,
        request: Object.freeze(projectedRequest),
        database: databaseFacade(
          database,
          firebaseUid,
          config.databaseStatementTimeoutMs,
        ),
        entry,
      });
      return sendHandlerResponse(response, output);
    } catch (error) {
      const typed = asRuntimeError(error);
      log({
        level: typed.statusCode >= 500 ? "error" : "info",
        code: typed.code,
        requestId: id,
        serviceOwner: config.serviceOwner,
      });
      return response.status(typed.statusCode).json(errorPayload(typed, id));
    }
  });

  app.use((error, _request, response, _next) => {
    const id = randomUUID();
    response.setHeader("X-Request-Id", id);
    const typed =
      error?.type === "entity.too.large"
        ? new RuntimeError("PAYLOAD_TOO_LARGE", "Request is too large.", 413)
        : error?.type === "encoding.unsupported"
          ? new RuntimeError("INVALID_REQUEST", "Invalid request.", 415)
          : asRuntimeError(error);
    return response.status(typed.statusCode).json(errorPayload(typed, id));
  });

  app.use((_request, response) => {
    response.status(404).json({
      detail: { code: "INVALID_ROUTE", message: "Not found." },
    });
  });

  return app;
}
