/**
 * Ticker search for the header, answered by hushh-research's registry.
 *
 * This route exists so the browser never calls hushh-research directly. Three reasons, in order of
 * how much they cost if ignored: a cross-origin call from the page would expose the dependency and
 * its base URL to every visitor; it would be uncached, so each keystroke would reach the service;
 * and it would be unlimited, so the page would be a free amplifier for anyone pointing a script at
 * it. Same shape as api/stock-quotes.js, and deliberately sharing its guards rather than
 * reimplementing them.
 *
 * SHARED WITH THE QUOTES GATEWAY, not copied:
 *   - the feature flag, the public origin and the rate-limit salt, through readPublicSurfaceConfig
 *   - the per-client limiter
 *   - canonicalTrustedClientIp, which is the hop Cloud Run appended rather than the one the caller
 *     sent — the distinction that made the limiter forgeable when it was got backwards
 *   - the single-flight cache, at a longer TTL: the SEC registry changes daily, not per minute,
 *     so the market-aware window that quotes use would be pointless churn here
 *
 * NOT shared: the same-origin check. The quotes gateway rejects any request carrying a query
 * string, which is right for a POST body endpoint and wrong for a search.
 */

import {
  PublicStockQuotesGatewayError,
  canonicalTrustedClientIp,
  createPublicStockQuotesRateLimiter,
  readPublicSurfaceConfig,
} from "./shared/publicStockQuotesGateway.js";
import { createStockQuoteCache } from "./shared/stockQuoteCache.js";
import {
  createResearchTickerSearch,
  normalizeLimit,
  normalizeQuery,
} from "./shared/researchTickerSearch.js";
import { createHmac } from "node:crypto";

/** The registry is rebuilt from SEC filings, so an hour-old answer is still a correct one. */
export const TICKER_SEARCH_TTL_SECONDS = 3_600;

const headerValue = (request, name) => {
  const value = request?.headers?.[name];
  return String(Array.isArray(value) ? value[0] : (value ?? "")).trim();
};

/**
 * Same-origin, but tolerant of the query string this endpoint needs.
 *
 * The host and the forwarded protocol are what actually bind a request to this site; `Origin` is
 * checked when present and absent on a same-origin GET from many browsers, so its absence cannot
 * be treated as a failure.
 */
export const assertSearchOrigin = (request, config) => {
  const host = headerValue(request, "host").toLowerCase();
  const expected = new URL(config.publicOrigin).host;
  if (host !== expected || headerValue(request, "x-forwarded-proto").toLowerCase() !== "https") {
    throw new PublicStockQuotesGatewayError("SAME_ORIGIN_REQUIRED", "Access denied.", 403);
  }
  const origin = headerValue(request, "origin");
  if (origin && origin !== config.publicOrigin) {
    throw new PublicStockQuotesGatewayError("SAME_ORIGIN_REQUIRED", "Access denied.", 403);
  }
};

export function createTickerSearchHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  search,
} = {}) {
  let limiter = null;
  let limiterSignature = "";
  const cache = createStockQuoteCache({ now, ttlSeconds: () => TICKER_SEARCH_TTL_SECONDS });
  let client = search ?? null;

  return async function tickerSearch(request, response) {
    try {
      const config = readPublicSurfaceConfig(env);
      if (!config.enabled) {
        throw new PublicStockQuotesGatewayError("FEATURE_DISABLED", "Not found.", 404);
      }
      if ((request.method || "GET").toUpperCase() !== "GET") {
        throw new PublicStockQuotesGatewayError("INVALID_REQUEST", "Invalid request.", 405);
      }
      assertSearchOrigin(request, config);

      const url = new URL(request.originalUrl ?? request.url ?? "/", "https://local.invalid");
      const query = normalizeQuery(url.searchParams.get("q"));
      const limit = normalizeLimit(url.searchParams.get("limit"));
      if (!query) {
        throw new PublicStockQuotesGatewayError("INVALID_REQUEST", "Invalid request.", 400);
      }

      const signature = `${config.projectId}:${config.rateLimit}`;
      if (!limiter || limiterSignature !== signature) {
        limiter = createPublicStockQuotesRateLimiter({ limit: config.rateLimit, now });
        limiterSignature = signature;
      }
      limiter(
        createHmac("sha256", config.rateLimitSalt)
          .update(JSON.stringify([1, config.projectId, canonicalTrustedClientIp(request)]), "utf8")
          .digest("hex"),
      );

      if (!client) {
        const baseUrl = String(env.HUSHH_RESEARCH_API_BASE_URL ?? "").trim();
        if (!baseUrl) {
          throw new PublicStockQuotesGatewayError("UPSTREAM_UNAVAILABLE", "Service unavailable.", 503);
        }
        client = createResearchTickerSearch({ baseUrl, fetchImpl, now });
      }

      // One cache entry per query, shared by every visitor who types the same thing — which for a
      // ticker box is most of them.
      const { value: results, cached } = await cache.resolve(
        `${query.toLowerCase()}:${limit}`,
        () => client(query, limit),
        // An empty result is a real answer worth caching; a thrown one never reaches here.
        { shouldCache: (value) => Array.isArray(value) },
      );

      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "private, max-age=60");
      response.setHeader("X-Hushh-Cache", cached ? "hit" : "miss");
      response.end(JSON.stringify({ success: true, query, count: results.length, results }));
    } catch (error) {
      // Only this gateway's own errors carry a message meant for a browser. Anything else — a
      // provider failure, a timeout, a parse error — is reported as an upstream failure with a
      // fixed message: those carry URLs and occasionally headers, and this response is public.
      const known = error instanceof PublicStockQuotesGatewayError;
      response.statusCode = known ? error.statusCode : 503;
      if (known && error.retryAfter) response.setHeader("Retry-After", String(error.retryAfter));
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          success: false,
          code: known ? error.code : "UPSTREAM_UNAVAILABLE",
          error: known ? error.message : "Service unavailable.",
        }),
      );
    }
  };
}

export default createTickerSearchHandler();
