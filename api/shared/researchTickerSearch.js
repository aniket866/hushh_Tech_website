/**
 * Ticker search, served by hushh-research rather than reimplemented here.
 *
 * WHY THIS IS A CALL AND NOT A COPY. hushh-research maintains the ticker universe already — an
 * SEC-registry-backed table keyed on CIK, with exchange, SIC code, sector and industry per symbol,
 * loaded into an in-memory cache behind `GET /api/tickers/search`. That route takes no
 * authentication (`consent-protocol/api/routes/tickers.py` declares no dependency, and both
 * https://api.uat.hushh.ai and https://api.hushh.ai answer 200 to an anonymous request), so this
 * project can use it directly. Duplicating even a slice of that table here would mean a second
 * copy going stale on its own schedule.
 *
 * WHAT IT CANNOT REPLACE, measured rather than assumed:
 *
 *   - QUOTES. There is no shared quote service to call. Every price-bearing route over there is
 *     per-user and consent-gated — `/stock-preview/{user_id}` requires a vault-owner token whose
 *     user_id must match, and returns one symbol joined to that user's picks. The fetchers behind
 *     them are private functions, not an API. An anonymous 27-symbol marquee has nothing to call,
 *     which is why api/shared/yahooQuotes.js still exists.
 *   - THE MARQUEE LIST. The registry is US-listed only. Seven of the header's symbols return an
 *     empty result: 2222.SR, 1398.HK, 601939.SS, 601288.SS, 601988.SS, 0857.HK and TCEHY. The
 *     curated list stays local because the service genuinely does not hold it.
 *
 * One useful side effect: the registry's canonical form for a share class uses a hyphen — it
 * answers "BRK" with BRK-A — which is the form Yahoo accepts and the form this project had wrong.
 */

/** Warm, UAT answers in under half a second. Cold, production took 19.5s on measurement. */
const REQUEST_TIMEOUT_MS = 8_000;

/** After a timeout or a 5xx, stop asking for a while. Mirrors the quote provider's ladder. */
const COOLDOWN_MS = 120_000;

/** The endpoint caps at 100; the sheet shows far fewer. */
const MAX_LIMIT = 25;

/** Longest query worth forwarding. The endpoint's own bound is 100. */
const MAX_QUERY_LENGTH = 64;

/** Reject before the network what the upstream would reject after it. */
export const normalizeQuery = (value) => {
  const query = String(value ?? "").trim();
  if (!query || query.length > MAX_QUERY_LENGTH) return null;
  // Symbols and company names only. Nothing here should be able to steer a URL.
  if (!/^[A-Za-z0-9][A-Za-z0-9 .&'^-]*$/.test(query)) return null;
  return query;
};

export const normalizeLimit = (value, fallback = 8) => {
  const limit = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(limit, MAX_LIMIT);
};

/**
 * The registry's row, reduced to what a search result renders.
 *
 * Deliberately narrow: CIK and SIC codes are real data the endpoint returns and have no business
 * in a browser payload, so they are dropped here rather than passed through.
 */
export const mapTicker = (row) => {
  const symbol = String(row?.ticker ?? "").trim().toUpperCase();
  if (!symbol) return null;
  const name = String(row?.title ?? "").trim();
  return {
    symbol,
    name: name || symbol,
    exchange: String(row?.exchange ?? "").trim() || null,
    sector: String(row?.sector_primary ?? row?.sector ?? "").trim() || null,
  };
};

export const createResearchTickerSearch = ({
  baseUrl,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) => {
  const origin = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!origin) throw new Error("hushh-research API base URL is required");

  let cooldownUntil = 0;

  return async (query, limit = 8) => {
    const q = normalizeQuery(query);
    if (!q) throw new Error("invalid ticker query");
    if (now() < cooldownUntil) throw new Error("ticker search in cooldown");

    const url = `${origin}/api/tickers/search?q=${encodeURIComponent(q)}&limit=${normalizeLimit(limit)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        // 5xx and 429 mean back off. A 4xx is this request's problem, not the service's, and
        // benching it would turn one malformed query into an outage for everyone.
        if (response.status === 429 || response.status >= 500) cooldownUntil = now() + COOLDOWN_MS;
        throw new Error(`ticker search returned ${response.status}`);
      }
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error("ticker search returned an unexpected shape");
      return body.map(mapTicker).filter(Boolean);
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TypeError") {
        cooldownUntil = now() + COOLDOWN_MS;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
};

export default createResearchTickerSearch;
