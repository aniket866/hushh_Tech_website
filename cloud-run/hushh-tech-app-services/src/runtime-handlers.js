import {
  createFinnhubQuoteAdapter,
  createGeocodingAdapter,
} from "./adapters/investor-read-only.js";
import {
  createGeocodeHandler,
  createStockQuotesHandler,
} from "./handlers/investor-read-only.js";
import { createNdaAdminFetchHandler } from "./handlers/engagement-admin.js";
import {
  createFinancialLinkApiHandlers,
  createFinancialLinkWorkerHandlers,
  createUnavailablePlaidDiagnosticsHandler,
} from "./handlers/financial-link.js";
import { createFinancialLinkRuntime } from "./financial/gcp-runtime.js";

const GEOCODE_SLUG = "hushh-location-geocode";
const STOCK_QUOTES_SLUG = "stock-quotes";
const NDA_ADMIN_FETCH_SLUG = "nda-admin-fetch";

function createFinancialRuntimeFactory({ config, fetchImpl, now }) {
  return function runtimeForRequest(context) {
    return createFinancialLinkRuntime({
      config,
      database: context?.database,
      actor: context?.actor,
      fetchImpl,
      ...(now === undefined ? {} : { now }),
    });
  };
}

function createFinancialApiRuntimeHandlers({ config, fetchImpl, now }) {
  const runtimeForRequest = createFinancialRuntimeFactory({
    config,
    fetchImpl,
    now,
  });
  const slugs = [
    "create-link-token",
    "exchange-public-token",
    "plaid-data-sync",
    "plaid-data-sync-start",
    "plaid-data-sync-product",
    "asset-report-create",
    "plaid-diagnostics-log",
  ];
  const unavailableDiagnostics = createUnavailablePlaidDiagnosticsHandler();
  return Object.freeze(
    Object.fromEntries(
      slugs.map((slug) => [
        slug,
        async (context) => {
          let handler;
          try {
            const runtime = runtimeForRequest(context);
            handler = createFinancialLinkApiHandlers({
              financialLinkAdapter: runtime.financialLinkAdapter,
            })[slug];
          } catch (error) {
            // Source diagnostics are explicitly lossy even when their own
            // service setup is absent. This is scoped to the frozen logging
            // slug; all financial-data routes retain their fail-closed
            // runtime construction behavior.
            if (slug === "plaid-diagnostics-log") {
              return unavailableDiagnostics(context);
            }
            throw error;
          }
          return handler(context);
        },
      ]),
    ),
  );
}

function createFinancialWorkerRuntimeHandlers({ config, fetchImpl, now }) {
  const runtimeForRequest = createFinancialRuntimeFactory({
    config,
    fetchImpl,
    now,
  });
  return createFinancialLinkWorkerHandlers({
    async queuedProductSync(context) {
      const runtime = runtimeForRequest(context);
      return runtime.queuedProductSync(context);
    },
  });
}

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

  if (
    config.financial?.enabled === true &&
    config.serviceOwner === "financial-api"
  ) {
    return Object.freeze({
      handlers: createFinancialApiRuntimeHandlers({ config, fetchImpl, now }),
      databaseRequired: true,
      verifyPublicHandlerReadiness: async () => false,
    });
  }

  if (config.financial?.enabled === true && config.serviceOwner === "worker") {
    return Object.freeze({
      handlers: createFinancialWorkerRuntimeHandlers({ config, fetchImpl, now }),
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
