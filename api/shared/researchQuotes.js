/**
 * Quotes from hushh-research's shared cache, which is the common service both Cloud Runs read.
 *
 * WHY THIS IS PREFERRED OVER THE LOCAL YAHOO CLIENT. hushh-research keeps a two-tier cache in
 * front of the provider ladder — L1 in process, L2 in Postgres (`kai_market_cache_entries`) — with
 * a fresh window of 120s while the US session is scheduled open and 1800s when it is closed. L2 is
 * the part that matters here: it is shared across instances and therefore across services, so a
 * quote this site warms is a quote the research app serves, and the other way round. Two
 * implementations of one cadence was the duplication worth removing.
 *
 * WHY THE LOCAL CLIENT STILL EXISTS. This is a cross-service call, and a marquee that goes blank
 * because another service is redeploying is a worse trade than one extra Yahoo client. See
 * api/stock-quotes.js: research first, Yahoo if it cannot answer.
 *
 * `GET /api/market/quotes?symbols=…` takes no authentication, deliberately and narrowly: it
 * returns prices for symbols the caller names and nothing derived from a person. Same posture as
 * that service's `/api/tickers/search`.
 */

/** Generous, because a cold Cloud Run instance over there has to start before it answers. */
const REQUEST_TIMEOUT_MS = 9_000;

/** After a timeout or a 5xx, stop asking and let the local client carry the strip for a while. */
const COOLDOWN_MS = 120_000;

/** The upstream bound. Asking for more is a bug here, not something to discover over the wire. */
const MAX_SYMBOLS = 50;

/**
 * Map one shared-service row onto the shape the ticker renders.
 *
 * The service reports a percentage rather than an absolute move, so the previous close is
 * recovered from it: price / (1 + pct/100). Exact, and it keeps this consumer's shape identical to
 * the Yahoo client's so nothing downstream can tell which rung answered.
 */
export const mapResearchQuote = (row) => {
  const symbol = String(row?.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;
  const price = Number(row?.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const percentChange = Number.isFinite(Number(row?.change_percent)) ? Number(row.change_percent) : 0;
  const ratio = 1 + percentChange / 100;
  const previousClose = ratio > 0 ? price / ratio : 0;

  return {
    symbol,
    currentPrice: price,
    change: previousClose ? price - previousClose : 0,
    percentChange,
    previousClose,
    name: String(row?.company_name ?? symbol),
    hasQuote: true,
  };
};

export const createResearchQuoteProvider = ({
  baseUrl,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) => {
  const origin = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!origin) throw new Error("hushh-research API base URL is required");

  let cooldownUntil = 0;

  return async (symbols) => {
    const wanted = [...new Set((symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))]
      .slice(0, MAX_SYMBOLS);
    if (!wanted.length) throw new Error("no symbols requested");
    if (now() < cooldownUntil) throw new Error("research quotes in cooldown");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `${origin}/api/market/quotes?symbols=${encodeURIComponent(wanted.join(","))}`,
        { headers: { Accept: "application/json" }, signal: controller.signal, redirect: "error" },
      );
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) cooldownUntil = now() + COOLDOWN_MS;
        throw new Error(`research quotes returned ${response.status}`);
      }
      const body = await response.json();
      const rows = Array.isArray(body?.quotes) ? body.quotes.map(mapResearchQuote).filter(Boolean) : [];
      if (!rows.length) throw new Error("research quotes returned no usable rows");

      // Restore the caller's order; the service answers in the order it was asked, but this
      // consumer should not depend on that.
      const rank = new Map(wanted.map((symbol, index) => [symbol, index]));
      rows.sort((a, b) => (rank.get(a.symbol) ?? 0) - (rank.get(b.symbol) ?? 0));

      return {
        success: true,
        quotes: rows,
        count: rows.length,
        fetchedAt: new Date(now()).toISOString(),
        source: "hushh-research shared cache",
      };
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

/**
 * Try the shared service, fall back to the local provider.
 *
 * Ordered this way on purpose: the shared cache is the source of truth, and the local Yahoo client
 * is what keeps the strip alive while the other service is unreachable — a redeploy, a cold start,
 * a cooldown. It also means the two can ship in either order: until the shared endpoint exists,
 * every call falls through and the site behaves exactly as it does today.
 */
export const createPreferredQuoteProvider = ({ preferred, fallback, onFallback } = {}) => {
  if (typeof fallback !== "function") throw new Error("a fallback quote provider is required");
  if (typeof preferred !== "function") return fallback;

  return async (symbols) => {
    try {
      return await preferred(symbols);
    } catch (error) {
      // Never surface the upstream message: it can carry a URL, and this runs behind a public
      // endpoint. The reason is logged for an operator, not returned to a browser.
      onFallback?.(error);
      return fallback(symbols);
    }
  };
};

export default createResearchQuoteProvider;
