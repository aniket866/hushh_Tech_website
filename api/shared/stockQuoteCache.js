/**
 * A shared cache in front of the upstream quote provider, so traffic to it stops scaling with
 * readers.
 *
 * Without this every visitor's browser polls all 27 symbols every 120 seconds and the gateway
 * proxies each one straight through — a hundred concurrent readers is roughly fifty requests a
 * minute to the provider for byte-identical data. The existing limiter is per client key, so it
 * stops one abuser and does nothing about many honest visitors. Turning the feature flag on
 * without this is what would trip the provider's rate limit.
 *
 * The policy is ported from hushh-research (`market_refresh_policy.py`), which already settled
 * these numbers rather than guessing new ones:
 *
 *   - While the US market is open, a quote is stale in two minutes.
 *   - While it is closed, it is good for thirty. Nothing moves overnight or at the weekend, and
 *     that is most of the week — this is where the bulk of the saving comes from.
 *   - A miss under load fires ONE upstream call. Everyone else waits on it and reads the result.
 *     Without that, a cold cache and fifty simultaneous readers is fifty upstream calls, which is
 *     precisely the moment a rate limit bites.
 *
 * Market data is identical for every visitor, so there is nothing per-user to leak by sharing it.
 * Errors are never cached: a failed fetch must not pin a bad response for half an hour.
 */

/** Bounds from hushh-research. A quote may be stale by at most this long during the session. */
export const US_MARKET_OPEN_TTL_SECONDS = 120;

/** And by at most this long outside it. */
export const US_MARKET_CLOSED_TTL_SECONDS = 1_800;

/** Cap on distinct symbol sets held at once. The site asks for one; the rest is headroom. */
const MAX_ENTRIES = 32;

/**
 * Is the US equity market open?
 *
 * Weekday, 09:30 to 16:00 New York time. Deliberately ignores market holidays: being wrong on
 * roughly nine days a year means holding a quote for two minutes instead of thirty, which costs a
 * few extra upstream calls and never serves anything incorrect.
 */
export const usMarketIsOpen = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;

  // Intl renders midnight as "24" in some ICU versions; normalise so it does not read as late.
  const hour = Number(get("hour")) % 24;
  const minuteOfDay = hour * 60 + Number(get("minute"));
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;
};

/** Seconds a quote stays fresh, given when it was fetched. */
export const quoteTtlSeconds = (now = new Date()) =>
  usMarketIsOpen(now) ? US_MARKET_OPEN_TTL_SECONDS : US_MARKET_CLOSED_TTL_SECONDS;

/**
 * One cache plus single-flight. Kept as a factory so tests drive their own clock and the module
 * holds no ambient state.
 */
export const createStockQuoteCache = ({ now = Date.now, ttlSeconds = quoteTtlSeconds } = {}) => {
  /** key -> { expiresAt, value } */
  const entries = new Map();
  /** key -> Promise, the call everyone else waits on rather than making their own. */
  const inFlight = new Map();

  const evictExpired = (at) => {
    for (const [key, entry] of entries) if (entry.expiresAt <= at) entries.delete(key);
  };

  return {
    /**
     * `load` is called at most once per key per TTL window, however many callers arrive.
     * It must throw on failure — a rejected load is propagated to every waiter and cached by none.
     */
    async resolve(key, load, { shouldCache = () => true } = {}) {
      const at = now();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > at) return { value: hit.value, cached: true };

      const pending = inFlight.get(key);
      if (pending) return { value: await pending, cached: true };

      const request = (async () => load())();
      inFlight.set(key, request);
      try {
        const value = await request;
        // An upstream error still has to reach the caller — a 429 body and its Retry-After are
        // useful — but storing it would pin the outage for the whole window.
        if (!shouldCache(value)) return { value, cached: false };
        const ttl = Math.max(1, Math.floor(ttlSeconds(new Date(now()))));
        evictExpired(now());
        // Oldest-first eviction; insertion order is Map's own iteration order.
        while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
        entries.set(key, { expiresAt: now() + ttl * 1000, value });
        return { value, cached: false };
      } finally {
        inFlight.delete(key);
      }
    },

    /** For the response header, so a reader can see how long the copy they hold is good for. */
    ttlSeconds: () => Math.max(1, Math.floor(ttlSeconds(new Date(now())))),

    /** Testing and diagnostics only. */
    size: () => entries.size,
    clear: () => {
      entries.clear();
      inFlight.clear();
    },
  };
};

export default createStockQuoteCache;
