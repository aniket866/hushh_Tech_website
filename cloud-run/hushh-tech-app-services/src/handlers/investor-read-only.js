const PRIVATE_JSON_HEADERS = Object.freeze({
  "content-type": "application/json",
  "cache-control": "private, no-store",
});

export const LEGACY_STOCK_SYMBOLS = Object.freeze([
  "AAPL",
  "GOOGL",
  "MSFT",
  "NVDA",
  "AMZN",
  "META",
  "BRK.B",
  "JPM",
  "XOM",
  "TSM",
  "TM",
  "WMT",
  "BAC",
  "V",
  "JNJ",
  "PG",
  "MA",
  "HD",
  "CVX",
  "MRK",
  "PFE",
  "ABBV",
  "KO",
  "PEP",
  "COST",
  "AVGO",
  "ORCL",
]);

const REQUIRED_ADAPTER_METHODS = Object.freeze({
  geocoder: ["reverse"],
  stockQuotes: ["quote"],
});

function json(status, body) {
  return Object.freeze({ status, headers: PRIVATE_JSON_HEADERS, body });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Request aborted.");
}

function requireAdapter(name, adapter) {
  const methods = REQUIRED_ADAPTER_METHODS[name];
  if (
    !adapter ||
    methods.some((method) => typeof adapter[method] !== "function")
  ) {
    throw new Error(`${name} adapter is required.`);
  }
  return adapter;
}

function legacyErrorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isoTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Clock is invalid.");
  return date.toISOString();
}

function validCoordinates(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Request aborted."),
      );
    };
    if (signal?.aborted) return onAbort();
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function geocode({ request, geocoder, signal }) {
  const body = request.body;
  const latitude = body?.latitude;
  const longitude = body?.longitude;
  if (
    latitude === undefined ||
    latitude === null ||
    longitude === undefined ||
    longitude === null
  ) {
    return json(400, {
      success: false,
      error: "Missing latitude or longitude",
    });
  }
  const latNum = typeof latitude === "number" ? latitude : Number(latitude);
  const lonNum = typeof longitude === "number" ? longitude : Number(longitude);
  if (!validCoordinates(latNum, lonNum)) {
    return json(400, {
      success: false,
      error: "Invalid latitude or longitude",
    });
  }
  try {
    const data = await geocoder.reverse({
      latitude: latNum,
      longitude: lonNum,
      signal,
    });
    throwIfAborted(signal);
    return json(200, { success: true, data });
  } catch (error) {
    throwIfAborted(signal);
    return json(500, {
      success: false,
      error: legacyErrorMessage(error, "Geocoding failed"),
    });
  }
}

async function stock({ stockQuotes, signal, now, delay }) {
  if (stockQuotes.configured !== true) {
    return json(500, { error: "Stock API not configured", quotes: [] });
  }
  try {
    const quotes = [];
    const batchSize = 10;
    for (let index = 0; index < LEGACY_STOCK_SYMBOLS.length; index += batchSize) {
      throwIfAborted(signal);
      const batch = LEGACY_STOCK_SYMBOLS.slice(index, index + batchSize);
      const values = await Promise.all(
        batch.map((symbol) => stockQuotes.quote(symbol, { signal })),
      );
      for (const value of values) {
        if (value) quotes.push(value);
      }
      if (index + batchSize < LEGACY_STOCK_SYMBOLS.length) {
        await delay(200, signal);
      }
    }
    throwIfAborted(signal);
    return json(200, {
      success: true,
      quotes,
      fetchedAt: isoTimestamp(now),
      count: quotes.length,
    });
  } catch (error) {
    throwIfAborted(signal);
    return json(500, {
      error: "Failed to fetch stock quotes",
      message: legacyErrorMessage(error, "Unknown error"),
      quotes: [],
    });
  }
}

export function createInvestorReadOnlyHandlers({
  geocoder,
  stockQuotes,
  now = () => new Date(),
  delay = abortableDelay,
} = {}) {
  const adapters = Object.freeze({
    geocoder: requireAdapter("geocoder", geocoder),
    stockQuotes: requireAdapter("stockQuotes", stockQuotes),
  });
  if (typeof now !== "function" || typeof delay !== "function") {
    throw new Error("Clock and delay adapters are required.");
  }
  return Object.freeze({
    "hushh-location-geocode": (context) =>
      geocode({ ...context, geocoder: adapters.geocoder }),
    "stock-quotes": (context) =>
      stock({ ...context, stockQuotes: adapters.stockQuotes, now, delay }),
  });
}

export function createStockQuotesHandler({
  stockQuotes,
  now = () => new Date(),
  delay = abortableDelay,
} = {}) {
  const adapter = requireAdapter("stockQuotes", stockQuotes);
  if (typeof now !== "function" || typeof delay !== "function") {
    throw new Error("Clock and delay adapters are required.");
  }
  return (context) =>
    stock({ ...context, stockQuotes: adapter, now, delay });
}

export function createGeocodeHandler({ geocoder } = {}) {
  const adapter = requireAdapter("geocoder", geocoder);
  return (context) => geocode({ ...context, geocoder: adapter });
}
