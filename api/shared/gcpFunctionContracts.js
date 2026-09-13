const METHOD_PATTERN = /^(?:DELETE|GET|HEAD|PATCH|POST|PUT)$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const HEADER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QUERY_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_ROUTE_BYTES = 2048;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values, label, normalize = (value) => value) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  const result = values.map((value) => normalize(clean(value)));
  if (result.some((value) => !value) || new Set(result).size !== result.length) {
    throw new Error(`${label} contains an empty or duplicate value.`);
  }
  return Object.freeze(result);
}

function normalizeSubpath(value) {
  const path = clean(value);
  if (path === "") return "";
  if (
    !path.startsWith("/") ||
    path.length > MAX_ROUTE_BYTES ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    path.includes("//")
  ) {
    throw new Error(`Invalid compatibility subpath: ${path || "<empty>"}.`);
  }
  return path;
}

function normalizeContentType(value) {
  const contentType = clean(value).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) {
    throw new Error(`Invalid compatibility content type: ${contentType}.`);
  }
  return contentType;
}

function normalizeHeader(value) {
  const header = clean(value).toLowerCase();
  if (!HEADER_PATTERN.test(header)) {
    throw new Error(`Invalid compatibility response header: ${header}.`);
  }
  return header;
}

function normalizeQueryKey(value) {
  const key = clean(value);
  if (!QUERY_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid compatibility query key: ${key}.`);
  }
  return key;
}

export function buildGcpFunctionContracts(entries = []) {
  if (!Array.isArray(entries)) {
    throw new Error("Function contracts must be an array.");
  }

  const contracts = new Map();
  for (const raw of entries) {
    const slug = clean(raw?.slug);
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`Invalid compatibility contract slug: ${slug || "<empty>"}.`);
    }
    if (contracts.has(slug)) {
      throw new Error(`Duplicate compatibility contract slug: ${slug}.`);
    }

    const methods = uniqueStrings(raw.methods, `${slug} methods`, (value) =>
      value.toUpperCase(),
    );
    if (methods.some((method) => !METHOD_PATTERN.test(method))) {
      throw new Error(`Invalid compatibility method for ${slug}.`);
    }

    if (!Array.isArray(raw.subpaths) || raw.subpaths.length === 0) {
      throw new Error(`${slug} subpaths must be a non-empty array.`);
    }
    const subpaths = Object.freeze(raw.subpaths.map(normalizeSubpath));
    if (new Set(subpaths).size !== subpaths.length) {
      throw new Error(`${slug} subpaths contain duplicates.`);
    }
    const queryKeys = Object.freeze(
      Array.isArray(raw.queryKeys)
        ? raw.queryKeys.map(normalizeQueryKey)
        : [],
    );
    if (new Set(queryKeys).size !== queryKeys.length) {
      throw new Error(`${slug} query keys contain duplicates.`);
    }

    const contentTypes = Object.freeze(
      Array.isArray(raw.contentTypes)
        ? raw.contentTypes.map(normalizeContentType)
        : [],
    );
    if (new Set(contentTypes).size !== contentTypes.length) {
      throw new Error(`${slug} content types contain duplicates.`);
    }

    const responseHeaders = Object.freeze(
      Array.isArray(raw.responseHeaders)
        ? raw.responseHeaders.map(normalizeHeader)
        : [],
    );
    if (new Set(responseHeaders).size !== responseHeaders.length) {
      throw new Error(`${slug} response headers contain duplicates.`);
    }

    const maxRequestBytes = Number(raw.maxRequestBytes ?? 1024 * 1024);
    const timeoutMs = Number(raw.timeoutMs ?? 30_000);
    if (
      !Number.isSafeInteger(maxRequestBytes) ||
      maxRequestBytes < 0 ||
      maxRequestBytes > MAX_REQUEST_BYTES ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 60_000
    ) {
      throw new Error(`Invalid compatibility limits for ${slug}.`);
    }

    contracts.set(
      slug,
      Object.freeze({
        slug,
        methods,
        subpaths,
        queryKeys,
        contentTypes,
        responseHeaders,
        maxRequestBytes,
        timeoutMs,
        publicCache: raw.publicCache === true,
      }),
    );
  }
  return contracts;
}

// Contract presence is not enablement. The generated 112-function registry is
// checked before this map. Geocode is the only browser-reachable port; stock,
// NDA, and the reviewed read-batch contracts remain default-off until each
// exact slug has its own live UAT proof and registry transition.
export const GCP_FUNCTION_CONTRACTS = buildGcpFunctionContracts([
  {
    slug: "chat-check-access",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 8_192,
    timeoutMs: 25_000,
  },
  {
    slug: "fund-payment-admin-analytics",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 4_096,
    timeoutMs: 25_000,
  },
  {
    slug: "fund-payment-admin-overview",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 4_096,
    timeoutMs: 25_000,
  },
  {
    slug: "fund-payment-admin-overview-list",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 8_192,
    timeoutMs: 25_000,
  },
  {
    slug: "fund-payment-admin-overview-metrics",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 4_096,
    timeoutMs: 25_000,
  },
  {
    slug: "generate-investor-profile",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 65_536,
    timeoutMs: 25_000,
  },
  // These preserve the existing financial-link compatibility contracts. A
  // declaration here is intentionally not route activation: the generated
  // retirement registry still rejects each entry until its independent UAT
  // source/end, service, IAM, KMS, and sandbox evidence is accepted.
  {
    slug: "asset-report-create",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 262_144,
    timeoutMs: 25_000,
  },
  {
    slug: "create-link-token",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 262_144,
    timeoutMs: 25_000,
  },
  {
    slug: "exchange-public-token",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 262_144,
    timeoutMs: 25_000,
  },
  {
    slug: "get-locations",
    methods: ["GET"],
    subpaths: [""],
    queryKeys: ["type", "country", "state"],
    contentTypes: [],
    responseHeaders: [],
    maxRequestBytes: 0,
    timeoutMs: 25_000,
    publicCache: true,
  },
  {
    slug: "hushh-location-geocode",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 16_384,
    timeoutMs: 25_000,
  },
  {
    slug: "stock-quotes",
    methods: ["GET", "POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 8_192,
    timeoutMs: 25_000,
  },
  {
    slug: "investor-og-image",
    methods: ["GET"],
    subpaths: [""],
    queryKeys: ["slug"],
    contentTypes: [],
    responseHeaders: [],
    maxRequestBytes: 0,
    timeoutMs: 25_000,
    publicCache: true,
  },
  {
    slug: "plaid-data-sync-product",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 262_144,
    timeoutMs: 25_000,
  },
  {
    // Preserved Supabase compatibility alias. The gateway continues to select
    // the existing slug; the private adapter shares the implementation while
    // retaining this source route's trusted no-lock mode.
    slug: "plaid-data-sync",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 262_144,
    timeoutMs: 25_000,
  },
  {
    slug: "plaid-data-sync-start",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 262_144,
    timeoutMs: 25_000,
  },
  {
    slug: "plaid-diagnostics-log",
    methods: ["POST"],
    subpaths: [""],
    queryKeys: [],
    contentTypes: ["application/json"],
    responseHeaders: [],
    maxRequestBytes: 262_144,
    timeoutMs: 25_000,
  },
]);
