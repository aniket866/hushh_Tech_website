import {
  createFinnhubQuoteAdapter,
  createGeocodingAdapter,
} from "./adapters/investor-read-only.js";
import {
  createGeocodeHandler,
  createStockQuotesHandler,
} from "./handlers/investor-read-only.js";
import { createNdaAdminFetchHandler } from "./handlers/engagement-admin.js";

const GEOCODE_SLUG = "hushh-location-geocode";
const STOCK_QUOTES_SLUG = "stock-quotes";
const NDA_ADMIN_FETCH_SLUG = "nda-admin-fetch";

export function createRuntimeHandlers({
  config,
  fetchImpl = globalThis.fetch,
  now,
  delay,
} = {}) {
  if (!config || typeof fetchImpl !== "function") {
    throw new Error("Runtime handler configuration is required.");
  }

  if (config.serviceOwner === "engagement-api-worker") {
    if (config.publicStockQuotesEnabled) {
      throw new Error("Public stock quotes belong only to investor-api.");
    }
    return Object.freeze({
      handlers: Object.freeze({
        [NDA_ADMIN_FETCH_SLUG]: createNdaAdminFetchHandler(),
      }),
      databaseRequired: true,
      verifyPublicHandlerReadiness: async () => false,
    });
  }

  if (config.serviceOwner !== "investor-api") {
    if (config.publicStockQuotesEnabled) {
      throw new Error("Public stock quotes belong only to investor-api.");
    }
    return Object.freeze({
      handlers: Object.freeze({}),
      databaseRequired: false,
      verifyPublicHandlerReadiness: async () => false,
    });
  }

  const handlers = {
    [GEOCODE_SLUG]: createGeocodeHandler({
      geocoder: createGeocodingAdapter({
        fetchImpl,
        googleMapsApiKey: config.googleMapsApiKey,
        nominatimUserAgent: config.nominatimUserAgent,
      }),
    }),
  };

  if (!config.publicStockQuotesEnabled) {
    return Object.freeze({
      handlers: Object.freeze(handlers),
      databaseRequired: false,
      verifyPublicHandlerReadiness: async () => false,
    });
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
    handlers: Object.freeze({ ...handlers, [STOCK_QUOTES_SLUG]: handler }),
    databaseRequired: false,
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

export const PRIVATE_RUNTIME_HANDLER_SLUGS = Object.freeze([
  GEOCODE_SLUG,
  NDA_ADMIN_FETCH_SLUG,
]);
