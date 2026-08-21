import { createFinnhubQuoteAdapter } from "./adapters/investor-read-only.js";
import { createStockQuotesHandler } from "./handlers/investor-read-only.js";

const STOCK_QUOTES_SLUG = "stock-quotes";

export function createRuntimeHandlers({
  config,
  fetchImpl = globalThis.fetch,
  now,
  delay,
} = {}) {
  if (!config || typeof fetchImpl !== "function") {
    throw new Error("Runtime handler configuration is required.");
  }

  if (!config.publicStockQuotesEnabled) {
    return Object.freeze({
      handlers: Object.freeze({}),
      verifyPublicHandlerReadiness: async () => false,
    });
  }
  if (config.serviceOwner !== "investor-api") {
    throw new Error("Public stock quotes belong only to investor-api.");
  }

  const adapter = createFinnhubQuoteAdapter({
    fetchImpl,
    apiKey: config.finnhubApiKey,
    timeoutMs: config.finnhubQuoteTimeoutMs,
  });
  const handler = createStockQuotesHandler({
    stockQuotes: adapter,
    ...(now === undefined ? {} : { now }),
    ...(delay === undefined ? {} : { delay }),
  });

  return Object.freeze({
    handlers: Object.freeze({ [STOCK_QUOTES_SLUG]: handler }),
    async verifyPublicHandlerReadiness(slug) {
      if (slug !== STOCK_QUOTES_SLUG || adapter.configured !== true) {
        throw new Error("The stock-quotes provider is unavailable.");
      }
      return true;
    },
  });
}

export const PUBLIC_RUNTIME_HANDLER_SLUGS = Object.freeze([
  STOCK_QUOTES_SLUG,
]);
