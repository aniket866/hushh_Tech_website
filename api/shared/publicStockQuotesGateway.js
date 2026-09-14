import { createHash, createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { createStockQuoteCache } from "./stockQuoteCache.js";

const PUBLIC_PATH = "/api/stock-quotes";
const PRIVATE_PATH = "/api/v1/public/stock-quotes";
const MAX_REQUEST_BYTES = 8_192;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const PROJECTS = Object.freeze({
  "hushh-tech-uat": Object.freeze({
    publicOrigin: "https://uat.hushhtech.com",
    serviceOrigin:
      "https://hushh-tech-investor-api-175298245599.us-central1.run.app",
  }),
  "hushh-tech-prod": Object.freeze({
    publicOrigin: "https://hushhtech.com",
    serviceOrigin:
      "https://hushh-tech-investor-api-646258530541.us-central1.run.app",
  }),
});

export class PublicStockQuotesGatewayError extends Error {
  constructor(code, message, statusCode, retryAfter = null) {
    super(message);
    this.name = "PublicStockQuotesGatewayError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function headerValue(request, name) {
  const raw = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.join(",").trim();
  return clean(raw);
}

function exactFlag(env) {
  const value = clean(env.HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED);
  if (!value || value === "false") return false;
  if (value !== "true") {
    throw new PublicStockQuotesGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Service unavailable.",
      503,
    );
  }
  return true;
}

function canonicalServiceOrigin(value, expected) {
  let parsed;
  try {
    parsed = new URL(clean(value));
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    parsed.origin !== expected ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new PublicStockQuotesGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Service unavailable.",
      503,
    );
  }
  return parsed.origin;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const normalized = clean(value);
  const result = normalized ? Number(normalized) : fallback;
  if (
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw new PublicStockQuotesGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Service unavailable.",
      503,
    );
  }
  return result;
}

/**
 * What every public, unauthenticated endpoint on this host needs: the feature flag, the origin it
 * must be called from, and the salt and budget its rate limiter is built from.
 *
 * Split out so api/ticker-search.js shares this exact code rather than a second copy of it. The
 * quotes-only half stays below: a service origin and a proxy timeout are meaningless to an
 * endpoint that proxies nothing, and requiring HUSHH_TECH_INVESTOR_API_URL to be set before a
 * ticker search can answer would be a dependency invented by the refactor rather than by the code.
 */
export function readPublicSurfaceConfig(env = process.env) {
  if (!exactFlag(env)) return Object.freeze({ enabled: false });
  const projectId = clean(env.GOOGLE_CLOUD_PROJECT);
  const project = PROJECTS[projectId];
  const salt = clean(env.HUSHH_TECH_PUBLIC_RATE_LIMIT_SALT);
  if (
    !project ||
    Buffer.byteLength(salt, "utf8") < 32 ||
    Buffer.byteLength(salt, "utf8") > 4_096
  ) {
    throw new PublicStockQuotesGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Service unavailable.",
      503,
    );
  }
  return Object.freeze({
    enabled: true,
    projectId,
    publicOrigin: project.publicOrigin,
    rateLimitSalt: salt,
    rateLimit: boundedInteger(
      env.PUBLIC_STOCK_QUOTES_GATEWAY_RATE_LIMIT,
      DEFAULT_RATE_LIMIT,
      1,
      120,
    ),
  });
}

export function readPublicStockQuotesGatewayConfig(env = process.env) {
  const base = readPublicSurfaceConfig(env);
  if (!base.enabled) return base;
  return Object.freeze({
    ...base,
    serviceOrigin: canonicalServiceOrigin(
      env.HUSHH_TECH_INVESTOR_API_URL,
      PROJECTS[base.projectId].serviceOrigin,
    ),
    timeoutMs: boundedInteger(
      env.PUBLIC_STOCK_QUOTES_GATEWAY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1_000,
      30_000,
    ),
  });
}

function requestUrl(request) {
  return new URL(request.originalUrl ?? request.url ?? "/", "https://local.invalid");
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Request aborted.");
}

function createGatewayDeadline(request, response, timeoutMs) {
  const controller = new AbortController();
  let clientClosed = request.aborted === true;
  const timeoutError = new PublicStockQuotesGatewayError(
    "UPSTREAM_UNAVAILABLE",
    "Service unavailable.",
    503,
  );
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onRequestAborted = () => {
    clientClosed = true;
    abort(new Error("Client disconnected."));
  };
  const onResponseClosed = () => {
    if (response.writableEnded === true) return;
    clientClosed = true;
    abort(new Error("Client disconnected."));
  };
  request.once?.("aborted", onRequestAborted);
  response.once?.("close", onResponseClosed);
  if (clientClosed) abort(new Error("Client disconnected."));
  const timer = setTimeout(() => abort(timeoutError), timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    clientClosed: () => clientClosed,
    cleanup() {
      clearTimeout(timer);
      request.removeListener?.("aborted", onRequestAborted);
      response.removeListener?.("close", onResponseClosed);
    },
  });
}

function assertSameOrigin(request, config) {
  const url = requestUrl(request);
  if (url.pathname !== PUBLIC_PATH || url.search || url.hash) {
    throw new PublicStockQuotesGatewayError(
      "INVALID_REQUEST",
      "Invalid request.",
      400,
    );
  }
  const expected = new URL(config.publicOrigin);
  if (
    headerValue(request, "host").toLowerCase() !== expected.host ||
    headerValue(request, "x-forwarded-proto").toLowerCase() !== "https"
  ) {
    throw new PublicStockQuotesGatewayError(
      "SAME_ORIGIN_REQUIRED",
      "Access denied.",
      403,
    );
  }
  const origin = headerValue(request, "origin");
  if (origin && origin !== config.publicOrigin) {
    throw new PublicStockQuotesGatewayError(
      "SAME_ORIGIN_REQUIRED",
      "Access denied.",
      403,
    );
  }
  const referer = headerValue(request, "referer");
  if (referer) {
    let refererOrigin;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      refererOrigin = "";
    }
    if (refererOrigin !== config.publicOrigin) {
      throw new PublicStockQuotesGatewayError(
        "SAME_ORIGIN_REQUIRED",
        "Access denied.",
        403,
      );
    }
  }
  const fetchSite = headerValue(request, "sec-fetch-site").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    throw new PublicStockQuotesGatewayError(
      "SAME_ORIGIN_REQUIRED",
      "Access denied.",
      403,
    );
  }
}

/**
 * The caller's IP, taken from the one hop the platform itself wrote.
 *
 * This used to demand a chain of exactly two and return `chain[0]`, which was wrong twice over and
 * had never been exercised because the feature was switched off in every environment.
 *
 * It broke every real request. That two-hop shape is what an external HTTP(S) load balancer
 * produces. This service sits directly behind Cloud Run's own front end, which supplies a
 * single-entry chain, so every browser was refused with TRUSTED_PROXY_REQUIRED.
 *
 * And where it did match, it trusted the wrong end. Cloud Run APPENDS the real peer to whatever
 * the client sent, so a request carrying `X-Forwarded-For: 203.0.113.7` arrives as
 * "203.0.113.7, <real client>" — length two, passing the old check, with `chain[0]` being the
 * value the caller chose. The rate-limit key is an HMAC of that value, so a caller could hand
 * itself a fresh identity on every request and never meet the limiter at all. Verified against the
 * deployed service before this was changed.
 *
 * The last entry is the one Cloud Run appended and the only one a caller cannot forge, so that is
 * what the key is derived from. A longer chain is fine — the entries before it are caller-supplied
 * noise either way.
 */
function canonicalTrustedClientIp(request) {
  const raw = request.headers?.["x-forwarded-for"];
  if (typeof raw !== "string" || raw.length > 256) {
    throw new PublicStockQuotesGatewayError(
      "TRUSTED_PROXY_REQUIRED",
      "Access denied.",
      403,
    );
  }
  const chain = raw.split(",").map((value) => value.trim());
  const peer = chain[chain.length - 1];
  if (!chain.length || !peer || isIP(peer) === 0) {
    throw new PublicStockQuotesGatewayError(
      "TRUSTED_PROXY_REQUIRED",
      "Access denied.",
      403,
    );
  }
  return peer;
}

/**
 * Exported so api/ticker-search.js derives its rate-limit key exactly the same way. This is the
 * hop Cloud Run appended, not the one the caller sent — a second implementation of that rule is a
 * second chance to get it backwards, which is how the limiter was forgeable before.
 */
export { canonicalTrustedClientIp };

export const __testing = Object.freeze({ canonicalTrustedClientIp });

function publicRateKey(request, config) {
  const clientIp = canonicalTrustedClientIp(request);
  return createHmac("sha256", config.rateLimitSalt)
    .update(JSON.stringify([1, config.projectId, clientIp]), "utf8")
    .digest("hex");
}

async function requestBytes(request, signal) {
  if (Buffer.isBuffer(request.rawBody)) return Buffer.from(request.rawBody);
  if (Buffer.isBuffer(request.body)) return Buffer.from(request.body);
  if (typeof request.body === "string") {
    return Buffer.from(request.body, "utf8");
  }
  if (request.body !== undefined && request.body !== null) {
    try {
      return Buffer.from(JSON.stringify(request.body), "utf8");
    } catch {
      throw new PublicStockQuotesGatewayError(
        "INVALID_REQUEST",
        "Invalid request.",
        400,
      );
    }
  }
  if (!request || typeof request[Symbol.asyncIterator] !== "function") {
    return Buffer.alloc(0);
  }
  const chunks = [];
  let total = 0;
  for await (const rawChunk of request) {
    throwIfAborted(signal);
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk);
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      request.resume?.();
      throw new PublicStockQuotesGatewayError(
        "PAYLOAD_TOO_LARGE",
        "Request is too large.",
        413,
      );
    }
    chunks.push(chunk);
  }
  throwIfAborted(signal);
  return Buffer.concat(chunks, total);
}

async function requestBody(request, signal) {
  const method = String(request.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new PublicStockQuotesGatewayError(
      "METHOD_NOT_ALLOWED",
      "Method not allowed.",
      405,
    );
  }
  if (headerValue(request, "authorization") || headerValue(request, "apikey")) {
    throw new PublicStockQuotesGatewayError(
      "INVALID_REQUEST",
      "Invalid request.",
      400,
    );
  }
  if (method === "GET") return null;
  if (headerValue(request, "content-encoding")) {
    throw new PublicStockQuotesGatewayError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Invalid request.",
      415,
    );
  }
  const mediaType = headerValue(request, "content-type")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const declaredLength = headerValue(request, "content-length");
  if (declaredLength) {
    if (!/^\d{1,10}$/.test(declaredLength)) {
      throw new PublicStockQuotesGatewayError(
        "INVALID_REQUEST",
        "Invalid request.",
        400,
      );
    }
    if (Number(declaredLength) > MAX_REQUEST_BYTES) {
      throw new PublicStockQuotesGatewayError(
        "PAYLOAD_TOO_LARGE",
        "Request is too large.",
        413,
      );
    }
  }
  const body = await requestBytes(request, signal);
  if (body.length > MAX_REQUEST_BYTES) {
    throw new PublicStockQuotesGatewayError(
      "PAYLOAD_TOO_LARGE",
      "Request is too large.",
      413,
    );
  }
  if (body.length > 0) {
    if (mediaType !== "application/json") {
      throw new PublicStockQuotesGatewayError(
        "UNSUPPORTED_MEDIA_TYPE",
        "Invalid request.",
        415,
      );
    }
    try {
      JSON.parse(body.toString("utf8"));
    } catch {
      throw new PublicStockQuotesGatewayError(
        "INVALID_REQUEST",
        "Invalid request.",
        400,
      );
    }
  }
  return body;
}

export function createPublicStockQuotesRateLimiter({
  limit,
  now = Date.now,
  maxKeys = 10_000,
} = {}) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(maxKeys) ||
    maxKeys < 1 ||
    typeof now !== "function"
  ) {
    throw new Error("A bounded public rate limiter is required.");
  }
  const buckets = new Map();
  return function consume(key) {
    const timestamp = now();
    const resetAt =
      Math.floor(timestamp / RATE_WINDOW_MS) * RATE_WINDOW_MS + RATE_WINDOW_MS;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt !== resetAt) {
      if (buckets.size >= maxKeys) {
        for (const [storedKey, stored] of buckets) {
          if (stored.resetAt <= timestamp) buckets.delete(storedKey);
        }
      }
      if (buckets.size >= maxKeys && !buckets.has(key)) {
        throw new PublicStockQuotesGatewayError(
          "RATE_LIMITED",
          "Try again later.",
          429,
          Math.max(1, Math.ceil((resetAt - timestamp) / 1_000)),
        );
      }
      bucket = { count: 0, resetAt };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      throw new PublicStockQuotesGatewayError(
        "RATE_LIMITED",
        "Try again later.",
        429,
        Math.max(1, Math.ceil((resetAt - timestamp) / 1_000)),
      );
    }
    return true;
  };
}

function setPrivateHeaders(response) {
  response.removeHeader?.("Access-Control-Allow-Origin");
  response.removeHeader?.("Access-Control-Allow-Credentials");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendError(response, error) {
  setPrivateHeaders(response);
  if (Number.isSafeInteger(error.retryAfter)) {
    response.setHeader("Retry-After", String(error.retryAfter));
  }
  return response.status(error.statusCode).json({
    detail: { code: error.code, message: error.message },
  });
}

function assertBoundedResponse(response) {
  if (
    !response ||
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status > 599
  ) {
    throw new PublicStockQuotesGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Service unavailable.",
      502,
    );
  }
  const mediaType = clean(response.headers?.get?.("content-type"))
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return mediaType;
}

async function readBoundedResponse(response, signal) {
  const mediaType = assertBoundedResponse(response);
  const declaredRaw = clean(response.headers?.get?.("content-length"));
  if (declaredRaw) {
    if (!/^\d{1,10}$/.test(declaredRaw)) {
      throw new PublicStockQuotesGatewayError(
        "UPSTREAM_UNAVAILABLE",
        "Service unavailable.",
        502,
      );
    }
    if (Number(declaredRaw) > MAX_RESPONSE_BYTES) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new PublicStockQuotesGatewayError(
        "UPSTREAM_UNAVAILABLE",
        "Service unavailable.",
        502,
      );
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new PublicStockQuotesGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          502,
        );
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new PublicStockQuotesGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          502,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  if (bytes.length > 0 && mediaType !== "application/json") {
    throw new PublicStockQuotesGatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Service unavailable.",
      502,
    );
  }
  if (bytes.length > 0) {
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new PublicStockQuotesGatewayError(
        "UPSTREAM_UNAVAILABLE",
        "Service unavailable.",
        502,
      );
    }
  }
  return bytes;
}

export function createPublicStockQuotesGateway({
  env = process.env,
  fetchImpl = globalThis.fetch,
  getServiceIdentityToken,
  now = Date.now,
  requestId = randomUUID,
  /*
   * Where quotes come from. Supplied, the gateway calls it directly instead of proxying to the
   * investor API — which has no `/api/v1/public/stock-quotes` route at all, so the proxy path answered
   * Google's HTML 404 and every request became a 502.
   *
   * Everything around it is unchanged: the feature flag, the same-origin assertion, the per-client
   * limiter, the deadline, and the shared cache all still apply. Only the data source moves.
   */
  quoteProvider = null,
} = {}) {
  if (
    typeof fetchImpl !== "function" ||
    typeof getServiceIdentityToken !== "function" ||
    typeof now !== "function" ||
    typeof requestId !== "function"
  ) {
    throw new Error("Public stock-quotes gateway dependencies are required.");
  }
  let limiter = null;
  let limiterSignature = "";
  /*
   * One cache for the whole instance. Quotes are identical for every visitor, so a request that
   * arrives inside the window is answered without touching the provider at all. See
   * stockQuoteCache.js for the window, which is market-aware and ported from hushh-research.
   */
  const quoteCache = createStockQuoteCache();

  return async function publicStockQuotesGateway(request, response) {
    let deadline = null;
    try {
      const config = readPublicStockQuotesGatewayConfig(env);
      if (!config.enabled) {
        throw new PublicStockQuotesGatewayError(
          "FEATURE_DISABLED",
          "Not found.",
          404,
        );
      }
      deadline = createGatewayDeadline(request, response, config.timeoutMs);
      throwIfAborted(deadline.signal);
      assertSameOrigin(request, config);
      const body = await requestBody(request, deadline.signal);
      const rateKey = publicRateKey(request, config);
      const nextLimiterSignature = `${config.projectId}:${config.rateLimit}`;
      if (!limiter || limiterSignature !== nextLimiterSignature) {
        limiter = createPublicStockQuotesRateLimiter({
          limit: config.rateLimit,
          now,
        });
        limiterSignature = nextLimiterSignature;
      }
      limiter(rateKey);

      let serviceToken;
      try {
        serviceToken = await getServiceIdentityToken(config.serviceOrigin, {
          signal: deadline.signal,
        });
        throwIfAborted(deadline.signal);
      } catch {
        throwIfAborted(deadline.signal);
        throw new PublicStockQuotesGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          503,
        );
      }
      if (typeof serviceToken !== "string" || serviceToken.trim().length < 32) {
        throw new PublicStockQuotesGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          503,
        );
      }

      let upstream;
      try {
        const headers = new Headers({
          Accept: "application/json",
          Authorization: `Bearer ${serviceToken.trim()}`,
          "X-Hushh-Public-Rate-Key": rateKey,
          "X-Request-Id": requestId(),
        });
        if (body !== null && body.length > 0) {
          headers.set("Content-Type", "application/json");
        }
        // Keyed on the symbol set, so two pages asking for different symbols do not share an
        // answer, and everyone asking for the same set shares one upstream call.
        const cacheKey = createHash("sha256")
          .update(String(request.method ?? "GET").toUpperCase())
          .update("\u0000")
          .update(body ?? Buffer.alloc(0))
          .digest("hex");

        const { value: fetched, cached } = await quoteCache.resolve(
          cacheKey,
          async () => {
            if (quoteProvider) {
              let requested = [];
              try {
                requested = JSON.parse((body ?? Buffer.alloc(0)).toString("utf8") || "{}").symbols;
              } catch {
                throw new PublicStockQuotesGatewayError("INVALID_REQUEST", "Invalid request.", 400);
              }
              const result = await quoteProvider(requested ?? []);
              return {
                status: 200,
                retryAfter: null,
                bytes: Buffer.from(JSON.stringify(result), "utf8"),
              };
            }

            upstream = await fetchImpl(`${config.serviceOrigin}${PRIVATE_PATH}`, {
              method: String(request.method ?? "GET").toUpperCase(),
              headers,
              ...(body === null ? {} : { body }),
              redirect: "error",
              signal: deadline.signal,
            });
            const payload = await readBoundedResponse(upstream, deadline.signal);
            return {
              status: upstream.status,
              retryAfter: upstream.headers?.get?.("retry-after") ?? null,
              bytes: payload,
            };
          },
          { shouldCache: (value) => value.status === 200 },
        );

        throwIfAborted(deadline.signal);
        setPrivateHeaders(response);
        response.setHeader("Content-Type", "application/json");
        // Diagnostic only. The response stays private/no-store: the cache is the server's, not the
        // browser's, so one reader's copy is never handed to another by an intermediary.
        response.setHeader("X-Hushh-Quote-Cache", cached ? "hit" : "miss");
        if (fetched.retryAfter && /^\d{1,5}$/.test(fetched.retryAfter)) {
          response.setHeader("Retry-After", fetched.retryAfter);
        }
        return response.status(fetched.status).send(fetched.bytes);
      } catch (error) {
        if (error instanceof PublicStockQuotesGatewayError) throw error;
        throwIfAborted(deadline.signal);
        throw new PublicStockQuotesGatewayError(
          "UPSTREAM_UNAVAILABLE",
          "Service unavailable.",
          503,
        );
      }
    } catch (error) {
      if (deadline?.clientClosed() || response.destroyed === true) return;
      const typed =
        error instanceof PublicStockQuotesGatewayError
          ? error
          : new PublicStockQuotesGatewayError(
              "UPSTREAM_UNAVAILABLE",
              "Service unavailable.",
              503,
          );
      return sendError(response, typed);
    } finally {
      deadline?.cleanup();
    }
  };
}

export const PUBLIC_STOCK_QUOTES_GATEWAY_CONTRACT = Object.freeze({
  publicPath: PUBLIC_PATH,
  privatePath: PRIVATE_PATH,
  maxRequestBytes: MAX_REQUEST_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  rateWindowMs: RATE_WINDOW_MS,
});
