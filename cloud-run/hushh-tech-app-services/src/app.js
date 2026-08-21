import { createHash, randomUUID } from "node:crypto";

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
import {
  consumeSharedRateLimit,
  createUnavailableSharedRateLimiter,
  verifySharedRateLimiter,
} from "./shared-rate-limit.js";
import {
  buildWebhookCompletion,
  claimWebhookEvent,
  completeWebhookEvent,
  createUnavailableWebhookLedger,
  markWebhookEventRetryable,
  verifyWebhookLedger,
} from "./webhook-ledger.js";

const ROUTE_PREFIX = "/api/v1/legacy-functions/";
const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
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
  const url = new URL(
    request.originalUrl ?? request.url,
    "https://local.invalid",
  );
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
  return Object.freeze({
    slug,
    suffix: Object.freeze(suffix),
    search: url.search,
  });
}

function workerFirebaseUid(request) {
  const value = String(request.headers?.["x-hushh-firebase-uid"] ?? "").trim();
  if (!value) return null;
  if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }
  return value;
}

function databaseFacade(database, firebaseUid, statementTimeoutMs, signal) {
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
        signal,
      });
    },
  });
}

function rateLimitKey(googleCaller, actor, entry) {
  const actorKey = actor.uid ?? actor.eventId ?? actor.email ?? actor.subject;
  if (!actorKey) {
    throw new RuntimeError("AUTH_CONTEXT_INVALID", "Access denied.", 403);
  }
  return createHash("sha256")
    .update(
      JSON.stringify([1, googleCaller.email, actor.kind, actorKey, entry.slug]),
      "utf8",
    )
    .digest("hex");
}

function createRequestDeadline(request, response, timeoutMs) {
  const controller = new AbortController();
  let clientClosed = false;
  let deadlineExpired = false;
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });

  const abort = (error) => {
    if (controller.signal.aborted) return;
    rejectAbort(error);
    controller.abort(error);
  };
  const deadlineError = new RuntimeError(
    "HANDLER_DEADLINE_EXCEEDED",
    "Service unavailable.",
    504,
  );
  const timer = setTimeout(() => {
    deadlineExpired = true;
    abort(deadlineError);
  }, timeoutMs);
  const abortForClient = () => {
    clientClosed = true;
    abort(new RuntimeError("CLIENT_CLOSED", "Client disconnected.", 499));
  };
  const abortForResponse = () => {
    if (!response.writableEnded) abortForClient();
  };
  request.once?.("aborted", abortForClient);
  response.once?.("close", abortForResponse);

  return Object.freeze({
    signal: controller.signal,
    race(promise) {
      return Promise.race([promise, aborted]);
    },
    clientClosed() {
      return clientClosed;
    },
    deadlineExpired() {
      return deadlineExpired;
    },
    cleanup() {
      clearTimeout(timer);
      request.off?.("aborted", abortForClient);
      response.off?.("close", abortForResponse);
    },
  });
}

function portedEntriesForService(registry, serviceOwner, ownsEntry) {
  return Object.values(registry).filter(
    (entry) =>
      entry?.final_disposition === "PORT_TO_GCP" &&
      entry?.migration_state === "PORTED_AND_VERIFIED" &&
      ownsEntry(serviceOwner, entry),
  );
}

function throwIfAborted(signal) {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503);
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

function normalizeHandlerResponse(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new RuntimeError(
      "HANDLER_CONTRACT_INVALID",
      "Service unavailable.",
      503,
    );
  }
  if (
    Object.keys(output).some(
      (name) => !["status", "headers", "body", "outbox"].includes(name),
    ) ||
    (output.headers !== undefined &&
      (!output.headers ||
        typeof output.headers !== "object" ||
        Array.isArray(output.headers)))
  ) {
    throw new RuntimeError(
      "HANDLER_CONTRACT_INVALID",
      "Service unavailable.",
      503,
    );
  }
  const status = Number(output.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RuntimeError(
      "HANDLER_CONTRACT_INVALID",
      "Service unavailable.",
      503,
    );
  }
  const headers = Object.create(null);
  for (const [rawName, rawValue] of Object.entries(output.headers ?? {})) {
    const name = rawName.toLowerCase();
    const value =
      typeof rawValue === "string" || typeof rawValue === "number"
        ? String(rawValue)
        : "";
    if (
      !RESPONSE_HEADER_ALLOWLIST.has(name) ||
      !value ||
      value.length > 2_048 ||
      name in headers
    ) {
      throw new RuntimeError(
        "HANDLER_CONTRACT_INVALID",
        "Service unavailable.",
        503,
      );
    }
    headers[name] = value;
  }

  let body = output.body;
  if (Buffer.isBuffer(body)) body = Buffer.from(body);
  if (body !== undefined && body !== null && !Buffer.isBuffer(body)) {
    let serialized;
    try {
      serialized = JSON.stringify(body);
    } catch {
      serialized = null;
    }
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES
    ) {
      throw new RuntimeError(
        "HANDLER_CONTRACT_INVALID",
        "Service unavailable.",
        503,
      );
    }
    body = JSON.parse(serialized);
  }
  if (Buffer.isBuffer(body) && body.length > MAX_RESPONSE_BYTES) {
    throw new RuntimeError(
      "HANDLER_CONTRACT_INVALID",
      "Service unavailable.",
      503,
    );
  }
  return Object.freeze({
    status,
    headers: Object.freeze(headers),
    body,
  });
}

function sendHandlerResponse(response, output) {
  const normalized = normalizeHandlerResponse(output);
  for (const [name, value] of Object.entries(normalized.headers)) {
    response.setHeader(name, value);
  }

  if (normalized.body === undefined || normalized.body === null) {
    return response.status(normalized.status).end();
  }
  if (Buffer.isBuffer(normalized.body)) {
    return response.status(normalized.status).send(normalized.body);
  }
  return response
    .status(normalized.status)
    .type("application/json")
    .send(JSON.stringify(normalized.body));
}

export function createApp({
  config,
  database,
  verifyGoogleServiceRequest,
  verifyFirebaseProductRequest,
  verifyWebhookRequest,
  verifyReadiness,
  sharedRateLimiter = createUnavailableSharedRateLimiter(),
  webhookLedger = createUnavailableWebhookLedger(),
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
    typeof verifyReadiness !== "function" ||
    !Number.isSafeInteger(config.handlerDeadlineMs) ||
    config.handlerDeadlineMs < 1 ||
    !Number.isSafeInteger(config.databaseStatementTimeoutMs) ||
    config.databaseStatementTimeoutMs >= config.handlerDeadlineMs
  ) {
    throw new Error("Complete runtime dependencies are required.");
  }
  const rule = serviceRule(config.serviceOwner);
  if (!rule) throw new Error("SERVICE_OWNER rule is required.");
  const portedEntries = portedEntriesForService(
    registry,
    config.serviceOwner,
    ownsEntry,
  );
  const requiresWebhookLedger = portedEntries.some(
    (entry) => entry.auth_mode === "provider_signature_raw_body",
  );

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
      if (portedEntries.length > 0) {
        await verifySharedRateLimiter(sharedRateLimiter);
      }
      if (requiresWebhookLedger) {
        await verifyWebhookLedger(webhookLedger);
      }
      response
        .status(200)
        .json({ status: "ready", service_owner: config.serviceOwner });
    } catch {
      response
        .status(503)
        .json({ status: "not_ready", service_owner: config.serviceOwner });
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
    const deadline = createRequestDeadline(
      request,
      response,
      config.handlerDeadlineMs,
    );
    try {
      const execution = (async () => {
        const method = String(request.method ?? "").toUpperCase();
        if (!ALLOWED_METHODS.has(method)) {
          throw new RuntimeError(
            "METHOD_NOT_ALLOWED",
            "Method not allowed.",
            405,
          );
        }
        const googleCaller = await verifyGoogleServiceRequest(request, {
          signal: deadline.signal,
        });
        throwIfAborted(deadline.signal);
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
          actor = await verifyFirebaseProductRequest(request, entry, {
            signal: deadline.signal,
          });
          throwIfAborted(deadline.signal);
          firebaseUid = actor.uid;
        } else if (rule.actor === "webhook") {
          actor = await verifyWebhookRequest(request, entry, {
            signal: deadline.signal,
          });
          throwIfAborted(deadline.signal);
        } else if (rule.actor === "google-worker") {
          actor = googleCaller;
          firebaseUid = workerFirebaseUid(request);
        } else {
          throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
        }

        const limiterKey = rateLimitKey(googleCaller, actor, entry);
        rateLimiter(limiterKey);
        await consumeSharedRateLimit(sharedRateLimiter, {
          key: limiterKey,
          limit: config.requestRateLimit,
          windowMs: 60_000,
          signal: deadline.signal,
        });
        throwIfAborted(deadline.signal);

        const webhookState =
          rule.actor === "webhook"
            ? await claimWebhookEvent(webhookLedger, actor, request.body, {
                signal: deadline.signal,
                leaseMs: config.handlerDeadlineMs + 10_000,
              })
            : null;
        throwIfAborted(deadline.signal);
        if (webhookState?.disposition === "COMPLETED") {
          return Object.freeze({ status: 204, headers: {}, body: null });
        }
        const webhookClaim = webhookState?.claim ?? null;
        let webhookCompleted = false;
        try {
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
          throwIfAborted(deadline.signal);
          const output = await handler({
            actor,
            googleCaller,
            request: Object.freeze(projectedRequest),
            database:
              rule.actor === "webhook"
                ? Object.freeze({})
                : databaseFacade(
                    database,
                    firebaseUid,
                    config.databaseStatementTimeoutMs,
                    deadline.signal,
                  ),
            entry,
            signal: deadline.signal,
            webhookClaim,
          });
          throwIfAborted(deadline.signal);
          const normalizedOutput = normalizeHandlerResponse(output);
          if (webhookClaim) {
            const completion = buildWebhookCompletion(
              normalizedOutput,
              output.outbox,
            );
            await completeWebhookEvent(
              webhookLedger,
              webhookClaim,
              completion,
              { signal: deadline.signal },
            );
            webhookCompleted = true;
          } else if (output.outbox !== undefined) {
            throw new RuntimeError(
              "HANDLER_CONTRACT_INVALID",
              "Service unavailable.",
              503,
            );
          }
          throwIfAborted(deadline.signal);
          return normalizedOutput;
        } catch (error) {
          if (webhookClaim && !webhookCompleted) {
            await markWebhookEventRetryable(webhookLedger, webhookClaim, error);
          }
          throw error;
        }
      })();
      const output = await deadline.race(execution);
      if (deadline.deadlineExpired()) {
        throw deadline.signal.reason;
      }
      if (deadline.clientClosed() || response.destroyed) return;
      return sendHandlerResponse(response, output);
    } catch (error) {
      if (deadline.clientClosed() || response.destroyed) {
        log({
          level: "info",
          code: "CLIENT_CLOSED",
          requestId: id,
          serviceOwner: config.serviceOwner,
        });
        return;
      }
      const typed = asRuntimeError(error);
      log({
        level: typed.statusCode >= 500 ? "error" : "info",
        code: typed.code,
        requestId: id,
        serviceOwner: config.serviceOwner,
      });
      return response.status(typed.statusCode).json(errorPayload(typed, id));
    } finally {
      deadline.cleanup();
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
