import { RuntimeError } from "./errors.js";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const BODY_POLICIES = new Set(["forbidden", "optional", "required"]);
const QUERY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const TEMPLATE_LITERAL_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const TEMPLATE_PARAMETER_PATTERN = /^:[a-z][a-z0-9_]{0,31}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const CACHE_CONTROL_VALUES = new Set([
  "private, no-store",
  "public, max-age=86400",
  "public, max-age=3600, s-maxage=86400",
]);
const CREDENTIAL_KEY_PATTERN =
  /(?:authorization|credential|password|private[_-]?key|secret|service[_-]?role|token)/i;
const MAX_QUERY_BYTES = 4_096;
const MAX_QUERY_VALUES = 32;
const MAX_REQUEST_BYTES = 1_048_576;

function invalidDefinition(slug, reason) {
  throw new Error(`Invalid function contract for ${slug}: ${reason}.`);
}

function compilePathTemplate(slug, template) {
  if (template === "") return Object.freeze([]);
  if (
    typeof template !== "string" ||
    template.startsWith("/") ||
    template.endsWith("/")
  ) {
    invalidDefinition(slug, "invalid subpath template");
  }
  const segments = template.split("/");
  if (
    segments.length > 8 ||
    segments.some(
      (segment) =>
        !TEMPLATE_LITERAL_PATTERN.test(segment) &&
        !TEMPLATE_PARAMETER_PATTERN.test(segment),
    )
  ) {
    invalidDefinition(slug, "invalid subpath template");
  }
  const parameters = segments.filter((segment) => segment.startsWith(":"));
  if (new Set(parameters).size !== parameters.length) {
    invalidDefinition(slug, "duplicate subpath parameter");
  }
  return Object.freeze(segments);
}

function compileQuery(slug, query) {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    invalidDefinition(slug, "query rules must be an object");
  }
  const output = Object.create(null);
  for (const [key, rule] of Object.entries(query)) {
    if (!QUERY_KEY_PATTERN.test(key) || CREDENTIAL_KEY_PATTERN.test(key)) {
      invalidDefinition(slug, `query key ${key} is not allowed`);
    }
    if (
      !rule ||
      typeof rule !== "object" ||
      Array.isArray(rule) ||
      typeof rule.required !== "boolean" ||
      typeof rule.multiple !== "boolean" ||
      !Number.isSafeInteger(rule.maxLength) ||
      rule.maxLength < 1 ||
      rule.maxLength > 2_048 ||
      Object.keys(rule).some(
        (name) => !["required", "multiple", "maxLength"].includes(name),
      )
    ) {
      invalidDefinition(slug, `query rule ${key} is invalid`);
    }
    output[key] = Object.freeze({ ...rule });
  }
  return Object.freeze(output);
}

function compileContract(slug, contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    invalidDefinition(slug, "contract must be an object");
  }
  if (
    !Array.isArray(contract.methods) ||
    contract.methods.length < 1 ||
    contract.methods.some((method) => !ALLOWED_METHODS.has(method)) ||
    new Set(contract.methods).size !== contract.methods.length
  ) {
    invalidDefinition(slug, "methods are invalid");
  }
  if (
    !Array.isArray(contract.subpaths) ||
    contract.subpaths.length < 1 ||
    contract.subpaths.length > 16 ||
    new Set(contract.subpaths).size !== contract.subpaths.length
  ) {
    invalidDefinition(slug, "subpaths are invalid");
  }
  if (!BODY_POLICIES.has(contract.body)) {
    invalidDefinition(slug, "body policy is invalid");
  }
  if (
    !Array.isArray(contract.mediaTypes) ||
    contract.mediaTypes.length > 8 ||
    contract.mediaTypes.some(
      (mediaType) =>
        typeof mediaType !== "string" ||
        !MEDIA_TYPE_PATTERN.test(mediaType) ||
        mediaType !== mediaType.toLowerCase(),
    ) ||
    new Set(contract.mediaTypes).size !== contract.mediaTypes.length ||
    (contract.body === "forbidden" && contract.mediaTypes.length !== 0) ||
    (contract.body !== "forbidden" && contract.mediaTypes.length === 0)
  ) {
    invalidDefinition(slug, "media types are invalid");
  }
  if (
    Object.keys(contract).some(
      (name) =>
        ![
          "methods",
          "subpaths",
          "query",
          "body",
          "mediaTypes",
          "cacheControl",
          "maxRequestBytes",
        ].includes(name),
    )
  ) {
    invalidDefinition(slug, "unknown field");
  }
  const cacheControl = contract.cacheControl ?? "private, no-store";
  if (!CACHE_CONTROL_VALUES.has(cacheControl)) {
    invalidDefinition(slug, "cache control is invalid");
  }
  if (
    !Number.isSafeInteger(contract.maxRequestBytes) ||
    contract.maxRequestBytes < 0 ||
    contract.maxRequestBytes > MAX_REQUEST_BYTES
  ) {
    invalidDefinition(slug, "maximum request bytes is invalid");
  }
  return Object.freeze({
    methods: Object.freeze([...contract.methods]),
    subpaths: Object.freeze(
      contract.subpaths.map((template) => compilePathTemplate(slug, template)),
    ),
    query: compileQuery(slug, contract.query),
    body: contract.body,
    mediaTypes: Object.freeze([...contract.mediaTypes]),
    cacheControl,
    maxRequestBytes: contract.maxRequestBytes,
  });
}

export function createFunctionContracts(definitions) {
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) {
    throw new Error("Function contract definitions must be an object.");
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(definitions).map(([slug, contract]) => {
        if (!SLUG_PATTERN.test(slug)) {
          invalidDefinition(slug, "slug is invalid");
        }
        return [slug, compileContract(slug, contract)];
      }),
    ),
  );
}

function pathMatches(template, suffix) {
  return (
    template.length === suffix.length &&
    template.every(
      (segment, index) =>
        segment.startsWith(":") || segment === suffix[index],
    )
  );
}

function requestMediaType(headers) {
  return String(headers?.["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

export function assertFunctionRequestContract(contract, request) {
  if (!contract) {
    throw new RuntimeError(
      "FUNCTION_CONTRACT_MISSING",
      "This feature is not available on GCP yet.",
      503,
    );
  }
  if (!contract.methods.includes(request.method)) {
    throw new RuntimeError("METHOD_NOT_ALLOWED", "Method not allowed.", 405);
  }
  if (
    !contract.subpaths.some((template) =>
      pathMatches(template, request.route.suffix),
    )
  ) {
    throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
  }
  if (Buffer.byteLength(request.route.search, "utf8") > MAX_QUERY_BYTES) {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }
  const parameters = new URLSearchParams(request.route.search);
  const keys = [...new Set(parameters.keys())];
  if ([...parameters].length > MAX_QUERY_VALUES) {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }
  for (const key of keys) {
    const rule = contract.query[key];
    const values = parameters.getAll(key);
    if (
      !rule ||
      (!rule.multiple && values.length !== 1) ||
      values.some(
        (value) =>
          value.length > rule.maxLength ||
          /[\u0000-\u001f\u007f]/.test(value),
      )
    ) {
      throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
    }
  }
  for (const [key, rule] of Object.entries(contract.query)) {
    if (rule.required && !parameters.has(key)) {
      throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
    }
  }

  const bodyBytes = Buffer.isBuffer(request.rawBody) ? request.rawBody.length : 0;
  if (bodyBytes > contract.maxRequestBytes) {
    throw new RuntimeError(
      "PAYLOAD_TOO_LARGE",
      "Request is too large.",
      413,
    );
  }
  const hasBody = bodyBytes > 0;
  if (
    (contract.body === "required" && !hasBody) ||
    (contract.body === "forbidden" && hasBody)
  ) {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }
  if (hasBody && !contract.mediaTypes.includes(requestMediaType(request.headers))) {
    throw new RuntimeError("UNSUPPORTED_MEDIA_TYPE", "Invalid request.", 415);
  }
  return true;
}

export const INVESTOR_READ_ONLY_FUNCTION_CONTRACTS = createFunctionContracts({
  "chat-check-access": {
    methods: ["POST"],
    subpaths: [""],
    query: {},
    body: "required",
    mediaTypes: ["application/json"],
    cacheControl: "private, no-store",
    maxRequestBytes: 8_192,
  },
  "fund-payment-admin-analytics": {
    methods: ["POST"],
    subpaths: [""],
    query: {},
    body: "optional",
    mediaTypes: ["application/json"],
    cacheControl: "private, no-store",
    maxRequestBytes: 4_096,
  },
  "fund-payment-admin-overview": {
    methods: ["POST"],
    subpaths: [""],
    query: {},
    body: "optional",
    mediaTypes: ["application/json"],
    cacheControl: "private, no-store",
    maxRequestBytes: 4_096,
  },
  "fund-payment-admin-overview-list": {
    methods: ["POST"],
    subpaths: [""],
    query: {},
    body: "optional",
    mediaTypes: ["application/json"],
    cacheControl: "private, no-store",
    maxRequestBytes: 8_192,
  },
  "fund-payment-admin-overview-metrics": {
    methods: ["POST"],
    subpaths: [""],
    query: {},
    body: "optional",
    mediaTypes: ["application/json"],
    cacheControl: "private, no-store",
    maxRequestBytes: 4_096,
  },
  "generate-investor-profile": {
    methods: ["POST"],
    subpaths: [""],
    query: {},
    body: "required",
    mediaTypes: ["application/json"],
    cacheControl: "private, no-store",
    maxRequestBytes: 65_536,
  },
  "get-locations": {
    methods: ["GET"],
    subpaths: [""],
    query: {
      type: { required: true, multiple: false, maxLength: 16 },
      country: { required: false, multiple: false, maxLength: 2 },
      state: { required: false, multiple: false, maxLength: 3 },
    },
    body: "forbidden",
    mediaTypes: [],
    cacheControl: "public, max-age=86400",
    maxRequestBytes: 0,
  },
  "hushh-location-geocode": {
    methods: ["POST"],
    subpaths: [""],
    query: {},
    body: "required",
    mediaTypes: ["application/json"],
    cacheControl: "private, no-store",
    maxRequestBytes: 16_384,
  },
  "stock-quotes": {
    methods: ["GET", "POST"],
    subpaths: [""],
    query: {},
    body: "optional",
    mediaTypes: ["application/json"],
    cacheControl: "private, no-store",
    maxRequestBytes: 8_192,
  },
  "investor-og-image": {
    methods: ["GET"],
    subpaths: [""],
    query: {
      slug: { required: true, multiple: false, maxLength: 128 },
    },
    body: "forbidden",
    mediaTypes: [],
    cacheControl: "public, max-age=3600, s-maxage=86400",
    maxRequestBytes: 0,
  },
});

export const ENGAGEMENT_ADMIN_FUNCTION_CONTRACTS = createFunctionContracts({
  "nda-admin-fetch": {
    methods: ["POST"],
    subpaths: [""],
    query: {},
    body: "optional",
    mediaTypes: ["application/json"],
    cacheControl: "private, no-store",
    maxRequestBytes: 4_096,
  },
});

// Contract presence is not enablement. The frozen registry is checked before
// these definitions, and all 112 entries remain unreachable until independent
// UAT parity changes a specific entry to PORTED_AND_VERIFIED.
export const FUNCTION_CONTRACTS = Object.freeze({
  ...INVESTOR_READ_ONLY_FUNCTION_CONTRACTS,
  ...ENGAGEMENT_ADMIN_FUNCTION_CONTRACTS,
});
