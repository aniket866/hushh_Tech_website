import { useEffect, useRef, useState } from "react";

/**
 * Ticker lookup for the header search, answered by hushh-research's registry through
 * `/api/ticker-search`.
 *
 * The browser never calls that service directly — see api/ticker-search.js for why. What matters
 * here is that a search box fires on every keystroke, so this debounces and cancels: a request
 * still in flight when the next character arrives is aborted rather than raced, which is what
 * stops results arriving out of order and showing the answer to a query the reader has moved past.
 *
 * It fails silently by design. A registry that is slow or unreachable should cost the reader the
 * ticker rows and nothing else; the page results beside them still work.
 */

export interface TickerResult {
  symbol: string;
  name: string;
  exchange: string | null;
  sector: string | null;
}

/** Long enough that a fast typist makes one request rather than six, short enough to feel instant. */
const DEBOUNCE_MS = 200;

export function useTickerSearch(query: string, { limit = 6 }: { limit?: number } = {}) {
  const [tickers, setTickers] = useState<TickerResult[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    abortRef.current?.abort();

    if (!trimmed) {
      setTickers([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/ticker-search?q=${encodeURIComponent(trimmed)}&limit=${limit}`,
          { signal: controller.signal, headers: { Accept: "application/json" } },
        );
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json();
        setTickers(Array.isArray(body?.results) ? body.results : []);
      } catch {
        // Aborted, offline, rate-limited, or the endpoint is switched off. The reader keeps the
        // page results either way, and a header search is not the place to report an outage.
        if (!controller.signal.aborted) setTickers([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, limit]);

  return { tickers, loading };
}

export default useTickerSearch;
