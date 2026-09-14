/**
 * Quotes from Yahoo's public quote endpoint — the free provider hushh-research already relies on.
 *
 * Its `fetchers.py` runs Finnhub, then FMP, then this. Neither keyed provider has a secret in this
 * project (37 secrets in `hushh-tech-uat`, none market-data), so this is the whole ladder here and
 * the one rung that needs no key at all.
 *
 * Two things carried over from that implementation because they were learned the hard way there:
 * explicit per-phase timeouts, and a provider-wide cooldown after one. Its comment records that
 * the `yfinance` library "is synchronous and can hang in some Cloud Run environments" — this
 * endpoint is the lighter-weight answer to exactly that.
 *
 * One deliberate difference: this batches. Yahoo accepts a comma-separated `symbols` list, so the
 * ticker's 27 symbols are one request rather than 27. Per-symbol fetching is what makes a provider
 * limit arrive early.
 */

/*
 * The chart endpoint, not the quote endpoint.
 *
 * `v7/finance/quote` is what hushh-research's fetchers.py calls, and it now answers 401
 * Unauthorized to any client without Yahoo credentials — "User is unable to access this feature".
 * That fallback is dead there too; it sits behind two keyed providers, so nothing surfaced it.
 *
 * `v8/finance/chart` is still open to an unauthenticated client and its `meta` block carries the
 * price and the previous close, which is everything the ticker renders. The cost is that it takes
 * one symbol per request rather than a list, so the fan-out below is bounded and the shared cache
 * in front of it is what keeps that off the provider.
 */
const ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart";

/** Symbols fetched at once. Enough to finish 27 quickly without arriving as a burst. */
const FETCH_CONCURRENCY = 6;

/** Matches hushh-research's KAI_YAHOO_FAST_TIMEOUT_SECONDS default. */
const REQUEST_TIMEOUT_MS = 8_000;

/** And its KAI_YAHOO_FAST_TIMEOUT_COOLDOWN_SECONDS. After a timeout, stop asking for a while. */
const COOLDOWN_MS = 180_000;

/** Yahoo rejects an unreasonable list outright; the ticker asks for 27. */
const MAX_SYMBOLS = 60;

const numberOr = (value, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Yahoo's quote shape, reduced to the fields the ticker renders.
 *
 * `hasQuote` is what stops the UI inventing a number: a row only claims a price and a direction
 * when the provider actually returned one.
 */
export const mapQuote = (meta) => {
  const symbol = String(meta?.symbol ?? "").trim();
  if (!symbol) return null;
  const price = numberOr(meta?.regularMarketPrice, null);
  if (price === null) return null;

  // The chart endpoint gives the previous close rather than a change, so the move is derived. A
  // missing or zero previous close means no honest percentage exists, and the row says so rather
  // than dividing by zero into Infinity.
  const previousClose = numberOr(meta?.chartPreviousClose ?? meta?.previousClose, 0);
  const change = previousClose ? price - previousClose : 0;
  const percentChange = previousClose ? (change / previousClose) * 100 : 0;

  return {
    symbol,
    currentPrice: price,
    change,
    percentChange,
    previousClose,
    name: String(meta?.longName ?? meta?.shortName ?? symbol),
    hasQuote: true,
  };
};

export const createYahooQuoteProvider = ({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) => {
  let cooldownUntil = 0;

  const fetchOne = async (symbol) => {
    const url = `${ENDPOINT}/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          // Yahoo answers an unidentified client inconsistently. hushh-research sends a named
          // agent for the same reason.
          "User-Agent": "HushhTech/1.0 (+https://hushhtech.com)",
        },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        // 429 and 5xx mean back off. A 4xx that is not 429 is usually one bad symbol, and benching
        // the provider over it would turn a typo into an outage.
        if (response.status === 429 || response.status >= 500) cooldownUntil = now() + COOLDOWN_MS;
        return null;
      }
      const body = await response.json();
      return mapQuote(body?.chart?.result?.[0]?.meta);
    } catch {
      cooldownUntil = now() + COOLDOWN_MS;
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return async (symbols) => {
    const wanted = [...new Set((symbols || []).map((s) => String(s).trim()).filter(Boolean))].slice(
      0,
      MAX_SYMBOLS,
    );
    if (!wanted.length) throw new Error("no symbols requested");
    if (now() < cooldownUntil) throw new Error("yahoo provider in cooldown");

    const queue = [...wanted];
    const quotes = [];
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
          const quote = await fetchOne(queue.shift());
          if (quote) quotes.push(quote);
        }
      }),
    );

    // Restore the caller's order; the fan-out finishes out of order.
    const rank = new Map(wanted.map((symbol, index) => [symbol, index]));
    quotes.sort((a, b) => (rank.get(a.symbol) ?? 0) - (rank.get(b.symbol) ?? 0));

    return {
      success: quotes.length > 0,
      quotes,
      count: quotes.length,
      fetchedAt: new Date(now()).toISOString(),
      source: "Yahoo Chart",
    };
  };
};

export default createYahooQuoteProvider;
