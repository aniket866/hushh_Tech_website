import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_MANIFEST_PATH = path.join(
  "migration",
  "manifests",
  "supabase-retirement.v1.json"
);
export const DEFAULT_BUNDLE_EVIDENCE_PATH = path.join(
  "migration",
  "evidence",
  "supabase-live-function-bundles.v1.json"
);
export const DEFAULT_TRAFFIC_EVIDENCE_PATH = path.join(
  "migration",
  "evidence",
  "supabase-function-traffic-30d.v1.json"
);

export const EXPECTED_PROJECT_REF = "ibsisfnjxeowvdtvgzff";
export const WINDOW_COUNT = 30;
export const WINDOW_HOURS = 24;
export const PROVIDER_RETENTION_DAYS = 90;
export const MINIMUM_REQUEST_DELAY_MS = 6500;
export const UNATTRIBUTED_SLUG = "__UNATTRIBUTED__";
export const MAX_MANAGEMENT_API_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MANAGEMENT_API_TIMEOUT_MS = 30000;

export const QUERY_RESULT_FIELDS = [
  "auth_absent_count",
  "auth_present_count",
  "latency_max_ms",
  "latency_min_ms",
  "latency_observed_count",
  "method_delete_count",
  "method_get_count",
  "method_head_count",
  "method_options_count",
  "method_other_count",
  "method_patch_count",
  "method_post_count",
  "method_put_count",
  "request_count",
  "response_size_max_bytes",
  "response_size_min_bytes",
  "response_size_observed_count",
  "slug",
  "status_1xx_count",
  "status_2xx_count",
  "status_3xx_count",
  "status_4xx_count",
  "status_5xx_count",
  "status_other_count",
];

const COUNT_FIELDS = QUERY_RESULT_FIELDS.filter(
  (field) => field.endsWith("_count") && field !== "request_count"
);

export const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
};

export const stableJson = (value) => JSON.stringify(stableValue(value));

export const digestTrafficEvidence = (evidence) => {
  const copy = structuredClone(evidence);
  delete copy.evidence_digest;
  return sha256(`${stableJson(copy)}\n`);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const exactObjectKeys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort(compareUtf8)) ===
    JSON.stringify([...expected].sort(compareUtf8));

const quoteSqlLiteral = (value) => {
  assert(/^[a-z0-9_-]+$/.test(value), "Function slug is not safe for a SQL literal.");
  return `'${value}'`;
};

export const WINDOW_START_QUERY_MARKER = "{{window_start_utc}}";
export const WINDOW_END_QUERY_MARKER = "{{window_end_utc}}";

const quoteSqlTimestamp = (value, marker) => {
  if (value === marker) return `'${marker}'`;
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "Traffic query timestamp is not a full UTC hour."
  );
  return `'${value}'`;
};

export const buildFunctionTrafficAggregateQuery = (
  functionSlugs,
  startUtc = WINDOW_START_QUERY_MARKER,
  endUtc = WINDOW_END_QUERY_MARKER
) => {
  const sortedSlugs = [...functionSlugs].sort(compareUtf8);
  assert(sortedSlugs.length === 112, "Traffic query requires exactly 112 function slugs.");
  assert(new Set(sortedSlugs).size === sortedSlugs.length, "Traffic query slugs must be unique.");
  const slugList = sortedSlugs.map(quoteSqlLiteral).join(",");
  const extractedSlug =
    "arrayElement(splitByChar('/', log_attributes['request.pathname']), 4)";

  return [
    "SELECT",
    `if(${extractedSlug} IN (${slugList}), ${extractedSlug}, '${UNATTRIBUTED_SLUG}') AS slug,`,
    "count() AS request_count,",
    "countIf(toInt32OrZero(log_attributes['response.status_code']) BETWEEN 100 AND 199) AS status_1xx_count,",
    "countIf(toInt32OrZero(log_attributes['response.status_code']) BETWEEN 200 AND 299) AS status_2xx_count,",
    "countIf(toInt32OrZero(log_attributes['response.status_code']) BETWEEN 300 AND 399) AS status_3xx_count,",
    "countIf(toInt32OrZero(log_attributes['response.status_code']) BETWEEN 400 AND 499) AS status_4xx_count,",
    "countIf(toInt32OrZero(log_attributes['response.status_code']) BETWEEN 500 AND 599) AS status_5xx_count,",
    "countIf(toInt32OrZero(log_attributes['response.status_code']) < 100 OR toInt32OrZero(log_attributes['response.status_code']) >= 600) AS status_other_count,",
    "countIf(upper(log_attributes['request.method']) = 'GET') AS method_get_count,",
    "countIf(upper(log_attributes['request.method']) = 'POST') AS method_post_count,",
    "countIf(upper(log_attributes['request.method']) = 'PUT') AS method_put_count,",
    "countIf(upper(log_attributes['request.method']) = 'PATCH') AS method_patch_count,",
    "countIf(upper(log_attributes['request.method']) = 'DELETE') AS method_delete_count,",
    "countIf(upper(log_attributes['request.method']) = 'OPTIONS') AS method_options_count,",
    "countIf(upper(log_attributes['request.method']) = 'HEAD') AS method_head_count,",
    "countIf(upper(log_attributes['request.method']) NOT IN ('GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD')) AS method_other_count,",
    "countIf(notEmpty(log_attributes['request.sb.jwt.authorization.payload.signature_prefix'])) AS auth_present_count,",
    "countIf(empty(log_attributes['request.sb.jwt.authorization.payload.signature_prefix'])) AS auth_absent_count,",
    "countIf(notEmpty(log_attributes['execution_time_ms'])) AS latency_observed_count,",
    "minIf(toUInt64OrZero(log_attributes['execution_time_ms']), notEmpty(log_attributes['execution_time_ms'])) AS latency_min_ms,",
    "maxIf(toUInt64OrZero(log_attributes['execution_time_ms']), notEmpty(log_attributes['execution_time_ms'])) AS latency_max_ms,",
    "countIf(notEmpty(log_attributes['response.headers.content_length'])) AS response_size_observed_count,",
    "minIf(toUInt64OrZero(log_attributes['response.headers.content_length']), notEmpty(log_attributes['response.headers.content_length'])) AS response_size_min_bytes,",
    "maxIf(toUInt64OrZero(log_attributes['response.headers.content_length']), notEmpty(log_attributes['response.headers.content_length'])) AS response_size_max_bytes",
    "FROM logs",
    "WHERE source = 'function_edge_logs'",
    `AND timestamp >= parseDateTime64BestEffort(${quoteSqlTimestamp(
      startUtc,
      WINDOW_START_QUERY_MARKER
    )})`,
    `AND timestamp < parseDateTime64BestEffort(${quoteSqlTimestamp(
      endUtc,
      WINDOW_END_QUERY_MARKER
    )})`,
    "GROUP BY slug",
    "ORDER BY slug",
    "LIMIT 113",
  ].join(" ");
};

export const emptyMetricSet = () => ({
  request_count: 0,
  status_class_counts: {
    status_1xx: 0,
    status_2xx: 0,
    status_3xx: 0,
    status_4xx: 0,
    status_5xx: 0,
    status_other: 0,
  },
  method_counts: {
    DELETE: 0,
    GET: 0,
    HEAD: 0,
    OPTIONS: 0,
    OTHER: 0,
    PATCH: 0,
    POST: 0,
    PUT: 0,
  },
  auth_marker_counts: {
    authorization_jwt_marker_absent: 0,
    authorization_jwt_marker_present: 0,
  },
  latency_ms_range: {
    observed_count: 0,
    min: null,
    max: null,
  },
  response_size_bytes_range: {
    observed_count: 0,
    min: null,
    max: null,
  },
});

const asSafeInteger = (value, field) => {
  const stringValue = String(value);
  assert(/^\d+$/.test(stringValue), `Provider aggregate ${field} is not an integer.`);
  const numberValue = Number(stringValue);
  assert(Number.isSafeInteger(numberValue), `Provider aggregate ${field} exceeds safe range.`);
  return numberValue;
};

const metricSetFromProviderRow = (row) => {
  assert(
    exactObjectKeys(row, QUERY_RESULT_FIELDS),
    "Provider aggregate response schema contains a non-allowlisted field."
  );
  for (const field of COUNT_FIELDS) asSafeInteger(row[field], field);

  const requestCount = asSafeInteger(row.request_count, "request_count");
  const latencyObserved = asSafeInteger(
    row.latency_observed_count,
    "latency_observed_count"
  );
  const sizeObserved = asSafeInteger(
    row.response_size_observed_count,
    "response_size_observed_count"
  );
  const metrics = {
    request_count: requestCount,
    status_class_counts: {
      status_1xx: asSafeInteger(row.status_1xx_count, "status_1xx_count"),
      status_2xx: asSafeInteger(row.status_2xx_count, "status_2xx_count"),
      status_3xx: asSafeInteger(row.status_3xx_count, "status_3xx_count"),
      status_4xx: asSafeInteger(row.status_4xx_count, "status_4xx_count"),
      status_5xx: asSafeInteger(row.status_5xx_count, "status_5xx_count"),
      status_other: asSafeInteger(row.status_other_count, "status_other_count"),
    },
    method_counts: {
      DELETE: asSafeInteger(row.method_delete_count, "method_delete_count"),
      GET: asSafeInteger(row.method_get_count, "method_get_count"),
      HEAD: asSafeInteger(row.method_head_count, "method_head_count"),
      OPTIONS: asSafeInteger(row.method_options_count, "method_options_count"),
      OTHER: asSafeInteger(row.method_other_count, "method_other_count"),
      PATCH: asSafeInteger(row.method_patch_count, "method_patch_count"),
      POST: asSafeInteger(row.method_post_count, "method_post_count"),
      PUT: asSafeInteger(row.method_put_count, "method_put_count"),
    },
    auth_marker_counts: {
      authorization_jwt_marker_absent: asSafeInteger(
        row.auth_absent_count,
        "auth_absent_count"
      ),
      authorization_jwt_marker_present: asSafeInteger(
        row.auth_present_count,
        "auth_present_count"
      ),
    },
    latency_ms_range: {
      observed_count: latencyObserved,
      min:
        latencyObserved === 0 ? null : asSafeInteger(row.latency_min_ms, "latency_min_ms"),
      max:
        latencyObserved === 0 ? null : asSafeInteger(row.latency_max_ms, "latency_max_ms"),
    },
    response_size_bytes_range: {
      observed_count: sizeObserved,
      min:
        sizeObserved === 0
          ? null
          : asSafeInteger(row.response_size_min_bytes, "response_size_min_bytes"),
      max:
        sizeObserved === 0
          ? null
          : asSafeInteger(row.response_size_max_bytes, "response_size_max_bytes"),
    },
  };

  const statusTotal = Object.values(metrics.status_class_counts).reduce(
    (sum, count) => sum + count,
    0
  );
  const methodTotal = Object.values(metrics.method_counts).reduce(
    (sum, count) => sum + count,
    0
  );
  const authTotal = Object.values(metrics.auth_marker_counts).reduce(
    (sum, count) => sum + count,
    0
  );
  assert(statusTotal === requestCount, "Provider status-class counts do not reconcile.");
  assert(methodTotal === requestCount, "Provider method counts do not reconcile.");
  assert(authTotal === requestCount, "Provider auth-marker counts do not reconcile.");
  assert(latencyObserved <= requestCount, "Provider latency count exceeds requests.");
  assert(sizeObserved <= requestCount, "Provider response-size count exceeds requests.");
  return metrics;
};

const mergeRange = (left, right) => {
  const observedCount = left.observed_count + right.observed_count;
  const valuesForMin = [left.min, right.min].filter((value) => value !== null);
  const valuesForMax = [left.max, right.max].filter((value) => value !== null);
  return {
    observed_count: observedCount,
    min: observedCount === 0 ? null : Math.min(...valuesForMin),
    max: observedCount === 0 ? null : Math.max(...valuesForMax),
  };
};

export const mergeMetricSets = (left, right) => ({
  request_count: left.request_count + right.request_count,
  status_class_counts: Object.fromEntries(
    Object.keys(left.status_class_counts).map((key) => [
      key,
      left.status_class_counts[key] + right.status_class_counts[key],
    ])
  ),
  method_counts: Object.fromEntries(
    Object.keys(left.method_counts).map((key) => [
      key,
      left.method_counts[key] + right.method_counts[key],
    ])
  ),
  auth_marker_counts: Object.fromEntries(
    Object.keys(left.auth_marker_counts).map((key) => [
      key,
      left.auth_marker_counts[key] + right.auth_marker_counts[key],
    ])
  ),
  latency_ms_range: mergeRange(left.latency_ms_range, right.latency_ms_range),
  response_size_bytes_range: mergeRange(
    left.response_size_bytes_range,
    right.response_size_bytes_range
  ),
});

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const createManagementApiAttemptLimiter = ({
  minimumDelayMs = MINIMUM_REQUEST_DELAY_MS,
  now = Date.now,
  sleep = wait,
} = {}) => {
  assert(
    Number.isSafeInteger(minimumDelayMs) &&
      minimumDelayMs >= MINIMUM_REQUEST_DELAY_MS,
    `Management API attempt delay must be at least ${MINIMUM_REQUEST_DELAY_MS}ms.`
  );
  assert(typeof now === "function", "Management API limiter clock is required.");
  assert(typeof sleep === "function", "Management API limiter sleep is required.");
  let lastAttemptStartedAt = null;
  let limiterQueue = Promise.resolve();

  const startNextAttempt = async () => {
    const observedNow = now();
    assert(Number.isFinite(observedNow), "Management API limiter clock is invalid.");
    if (lastAttemptStartedAt !== null) {
      const remainingDelay = minimumDelayMs - (observedNow - lastAttemptStartedAt);
      if (remainingDelay > 0) await sleep(remainingDelay);
    }
    const attemptStartedAt = now();
    assert(
      Number.isFinite(attemptStartedAt) &&
        (lastAttemptStartedAt === null ||
          attemptStartedAt - lastAttemptStartedAt >= minimumDelayMs),
      "Management API limiter did not preserve attempt spacing."
    );
    lastAttemptStartedAt = attemptStartedAt;
  };
  return () => {
    const scheduledAttempt = limiterQueue.then(startNextAttempt);
    limiterQueue = scheduledAttempt.catch(() => undefined);
    return scheduledAttempt;
  };
};

const SAFE_MANAGEMENT_API_ERROR_KINDS = Object.freeze({
  INVALID_CONTENT_LENGTH: "INVALID_CONTENT_LENGTH",
  RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
  NON_JSON_RESPONSE: "NON_JSON_RESPONSE",
  HTTP_STATUS: "HTTP_STATUS",
  TRANSPORT_FAILURE: "TRANSPORT_FAILURE",
});
const safeManagementApiErrors = new WeakMap();

const createSafeManagementApiError = (kind, message) => {
  const throwable = Object.create(null);
  Object.defineProperties(throwable, {
    name: {
      value: "SafeManagementApiError",
      enumerable: true,
      configurable: false,
      writable: false,
    },
    message: {
      value: message,
      enumerable: true,
      configurable: false,
      writable: false,
    },
    code: {
      value: kind,
      enumerable: true,
      configurable: false,
      writable: false,
    },
  });
  safeManagementApiErrors.set(throwable, Object.freeze({ kind, message }));
  return Object.freeze(throwable);
};

const getCanonicalSafeManagementApiError = (error) =>
  safeManagementApiErrors.get(error);

export const formatFunctionTrafficCliFailure = (error) => {
  const canonicalSafeError = getCanonicalSafeManagementApiError(error);
  return canonicalSafeError
    ? `SafeManagementApiError [${canonicalSafeError.kind}]: ${canonicalSafeError.message}`
    : "Function traffic evidence capture failed.";
};

const throwSafeManagementApiError = (kind, message) => {
  throw createSafeManagementApiError(kind, message);
};

const throwSanitizedManagementApiFailure = () => {
  throwSafeManagementApiError(
    SAFE_MANAGEMENT_API_ERROR_KINDS.TRANSPORT_FAILURE,
    "Read-only Management API request failed or timed out."
  );
};

const waitForRetryOrThrowSanitized = async (sleep, milliseconds) => {
  try {
    await sleep(milliseconds);
  } catch {
    throwSanitizedManagementApiFailure();
  }
};

const cancelResponseBody = async (response) => {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort after the collector has already failed closed.
  }
};

export const readBoundedResponseBytes = async (
  response,
  maxBytes = MAX_MANAGEMENT_API_RESPONSE_BYTES
) => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throwSafeManagementApiError(
        SAFE_MANAGEMENT_API_ERROR_KINDS.INVALID_CONTENT_LENGTH,
        "Management API Content-Length is invalid."
      );
    }
    if (Number(contentLength) > maxBytes) {
      await cancelResponseBody(response);
      throwSafeManagementApiError(
        SAFE_MANAGEMENT_API_ERROR_KINDS.RESPONSE_TOO_LARGE,
        "Management API response exceeds safety limit."
      );
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation cannot replace the fixed, sanitized size-limit error.
        }
        throwSafeManagementApiError(
          SAFE_MANAGEMENT_API_ERROR_KINDS.RESPONSE_TOO_LARGE,
          "Management API response exceeds safety limit."
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing a hostile or already-closed stream must not expose its error.
    }
  }
  return Buffer.concat(chunks, totalBytes);
};

export async function fetchJsonReadOnly({
  url,
  accessToken,
  fetchImpl = fetch,
  timeoutMs = MANAGEMENT_API_TIMEOUT_MS,
  maxResponseBytes = MAX_MANAGEMENT_API_RESPONSE_BYTES,
  maxAttempts = 4,
  sleep = wait,
  attemptLimiter,
}) {
  assert(
    typeof attemptLimiter === "function",
    "A shared Management API attempt limiter is required."
  );
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await attemptLimiter();
    } catch {
      throwSanitizedManagementApiFailure();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
      const responseStatus = response.status;
      if (
        !Number.isSafeInteger(responseStatus) ||
        responseStatus < 100 ||
        responseStatus > 599
      ) {
        await cancelResponseBody(response);
        throwSanitizedManagementApiFailure();
      }
      const responseBytes = await readBoundedResponseBytes(response, maxResponseBytes);
      if (responseStatus >= 200 && responseStatus < 300) {
        let body;
        try {
          body = JSON.parse(responseBytes.toString("utf8"));
        } catch {
          throwSafeManagementApiError(
            SAFE_MANAGEMENT_API_ERROR_KINDS.NON_JSON_RESPONSE,
            "Read-only Management API returned non-JSON data."
          );
        }
        return { body, responseSha256: sha256(responseBytes) };
      }
      const retryable = responseStatus === 429 || responseStatus >= 500;
      if (!retryable || attempt === maxAttempts) {
        throwSafeManagementApiError(
          SAFE_MANAGEMENT_API_ERROR_KINDS.HTTP_STATUS,
          `Read-only Management API request failed with HTTP ${responseStatus}.`
        );
      }
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfterSeconds)
        ? Math.min(Math.max(retryAfterSeconds * 1000, MINIMUM_REQUEST_DELAY_MS), 30000)
        : Math.min(8000 * 2 ** (attempt - 1), 30000);
      await waitForRetryOrThrowSanitized(sleep, backoffMs);
    } catch (error) {
      const canonicalSafeError = getCanonicalSafeManagementApiError(error);
      if (canonicalSafeError) {
        throwSafeManagementApiError(
          canonicalSafeError.kind,
          canonicalSafeError.message
        );
      }
      if (attempt === maxAttempts) {
        throwSanitizedManagementApiFailure();
      }
      await waitForRetryOrThrowSanitized(
        sleep,
        Math.min(8000 * 2 ** (attempt - 1), 30000)
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  throwSanitizedManagementApiFailure();
}

const fetchDeploymentBindings = async ({
  projectRef,
  accessToken,
  manifest,
  attemptLimiter,
}) => {
  const url = new URL(`https://api.supabase.com/v1/projects/${projectRef}/functions`);
  const { body, responseSha256 } = await fetchJsonReadOnly({
    url,
    accessToken,
    attemptLimiter,
  });
  assert(Array.isArray(body), "Function deployment inventory must be an array.");
  assert(body.length === 112, "Function deployment inventory must contain 112 functions.");

  const manifestBySlug = new Map(
    manifest.functions.map((entry) => [entry.source.slug, entry])
  );
  const bindings = body
    .map((entry) => {
      assert(entry && typeof entry === "object", "Function deployment entry is invalid.");
      assert(
        typeof entry.slug === "string" && /^[a-z0-9_-]+$/.test(entry.slug),
        "Function deployment slug is invalid."
      );
      const manifestEntry = manifestBySlug.get(entry.slug);
      assert(manifestEntry, "Function deployment inventory contains an unknown slug.");
      assert(entry.id === manifestEntry.source.function_id, "Function deployment ID drifted.");
      assert(entry.status === "ACTIVE", "Function deployment is not ACTIVE.");
      assert(
        entry.verify_jwt === manifestEntry.source.verify_jwt,
        "Function verify_jwt drifted."
      );
      assert(
        Number.isSafeInteger(entry.version) && entry.version > 0,
        "Function deployment version is invalid."
      );
      const updatedAtMs =
        typeof entry.updated_at === "string"
          ? Date.parse(entry.updated_at)
          : entry.updated_at;
      assert(
        Number.isSafeInteger(updatedAtMs) && Number.isFinite(new Date(updatedAtMs).getTime()),
        "Function deployment updated_at is invalid."
      );
      const updatedAtUtc = new Date(updatedAtMs).toISOString();
      const canonicalLine = [
        entry.slug,
        entry.id,
        String(entry.version),
        entry.status,
        String(entry.verify_jwt),
        updatedAtUtc,
      ].join("\0");
      return {
        slug: entry.slug,
        deployment_binding_sha256: sha256(`${canonicalLine}\n`),
        updated_at_sha256: sha256(`${entry.slug}\0${updatedAtUtc}\n`),
        version_delta: entry.version - manifestEntry.source.version,
        deployment_manifest_match_status:
          entry.version === manifestEntry.source.version
            ? "EXACT_MANIFEST_MATCH"
            : "CUTOVER_BLOCKING_VERSION_DRIFT",
      };
    })
    .sort((left, right) => compareUtf8(left.slug, right.slug));

  assert(new Set(bindings.map((entry) => entry.slug)).size === 112, "Duplicate deployment slug.");
  const normalizedDigest = sha256(
    bindings
      .map((entry) => `${entry.slug}  ${entry.deployment_binding_sha256}\n`)
      .join("")
  );
  const updatedAtDigest = sha256(
    bindings.map((entry) => `${entry.slug}  ${entry.updated_at_sha256}\n`).join("")
  );
  const versionDriftCount = bindings.filter(
    (entry) => entry.deployment_manifest_match_status === "CUTOVER_BLOCKING_VERSION_DRIFT"
  ).length;
  const versionDeltaHistogram = Object.fromEntries(
    [...bindings.reduce((histogram, entry) => {
      const key = String(entry.version_delta);
      histogram.set(key, (histogram.get(key) || 0) + 1);
      return histogram;
    }, new Map())].sort(([left], [right]) => Number(left) - Number(right))
  );
  const versionDeltaDigest = sha256(
    Object.entries(versionDeltaHistogram)
      .map(([delta, count]) => `${delta}  ${count}\n`)
      .join("")
  );
  return {
    bindings,
    normalizedDigest,
    updatedAtDigest,
    responseSha256,
    versionDriftCount,
    versionMatchCount: bindings.length - versionDriftCount,
    versionDeltaHistogram,
    versionDeltaDigest,
  };
};

const fetchTrafficWindowOnce = async ({
  projectRef,
  accessToken,
  query,
  startUtc,
  endUtc,
  attemptLimiter,
}) => {
  const url = new URL(
    `https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs`
  );
  url.searchParams.set("sql", query);
  url.searchParams.set("iso_timestamp_start", startUtc);
  url.searchParams.set("iso_timestamp_end", endUtc);
  const { body, responseSha256 } = await fetchJsonReadOnly({
    url,
    accessToken,
    attemptLimiter,
  });
  assert(
    exactObjectKeys(body, ["error", "result"]),
    "Provider log response root schema is not allowlisted."
  );
  assert(!body.error, "Provider log query returned an error.");
  assert(Array.isArray(body.result), "Provider log result must be an array.");
  assert(body.result.length <= 113, "Provider log result exceeds the aggregate row limit.");

  const bySlug = new Map();
  let unattributedMetrics = emptyMetricSet();
  for (const row of body.result) {
    const metrics = metricSetFromProviderRow(row);
    assert(
      row.slug === UNATTRIBUTED_SLUG || /^[a-z0-9_-]+$/.test(row.slug),
      "Provider aggregate returned a non-sanitized slug."
    );
    assert(!bySlug.has(row.slug), "Provider aggregate returned a duplicate slug.");
    if (row.slug === UNATTRIBUTED_SLUG) {
      unattributedMetrics = metrics;
    } else {
      bySlug.set(row.slug, metrics);
    }
  }
  return {
    bySlug,
    unattributedMetrics,
    providerResponseSha256: responseSha256,
    resultRowCount: body.result.length,
  };
};

const fetchTrafficWindow = async (options) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchTrafficWindowOnce(options);
    } catch (error) {
      if (attempt === 3) throw error;
      await wait(Math.min(8000 * 2 ** (attempt - 1), 30000));
    }
  }
  throw new Error("Provider log retry loop ended unexpectedly.");
};

const parseArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

export const resolveApprovedTrafficEvidenceOutput = ({
  outputPath,
  approvedDirectory = path.dirname(DEFAULT_TRAFFIC_EVIDENCE_PATH),
}) => {
  assert(
    typeof outputPath === "string" && outputPath.trim().length > 0,
    "--output is required and cannot fall back to an existing artifact."
  );
  const approvedDirectoryLexical = path.resolve(approvedDirectory);
  const approvedDirectoryStat = fs.lstatSync(approvedDirectoryLexical);
  assert(
    approvedDirectoryStat.isDirectory() && !approvedDirectoryStat.isSymbolicLink(),
    "Traffic evidence approved directory must be a real directory."
  );
  const approvedDirectoryReal = fs.realpathSync(approvedDirectoryLexical);
  assert(
    approvedDirectoryReal === approvedDirectoryLexical,
    "Traffic evidence approved directory cannot traverse a symlink."
  );

  const outputLexical = path.resolve(outputPath);
  assert(
    path.dirname(outputLexical) === approvedDirectoryLexical,
    "Traffic evidence output must be a direct child of migration/evidence."
  );
  assert(
    /^supabase-function-traffic-30d(?:\.[a-z0-9][a-z0-9_-]*)+\.json$/.test(
      path.basename(outputLexical)
    ),
    "Traffic evidence output filename is outside the approved policy."
  );
  return { outputLexical, approvedDirectoryReal };
};

export const writeTrafficEvidenceCreateOnly = ({
  outputPath,
  evidence,
  approvedDirectory,
}) => {
  const { outputLexical, approvedDirectoryReal } =
    resolveApprovedTrafficEvidenceOutput({ outputPath, approvedDirectory });
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(
    outputLexical,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      noFollow,
    0o600
  );
  let verified = false;
  try {
    assert(fs.fstatSync(descriptor).isFile(), "Traffic evidence output is not a file.");
    assert(
      path.dirname(fs.realpathSync(outputLexical)) === approvedDirectoryReal,
      "Traffic evidence output real path escaped the approved directory."
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    verified = true;
  } finally {
    fs.closeSync(descriptor);
    if (!verified) fs.unlinkSync(outputLexical);
  }
  return outputLexical;
};

const requireUtcBoundary = (value) => {
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value),
    "--window-end must be a full UTC hour in YYYY-MM-DDTHH:00:00.000Z format."
  );
  assert(Number.isFinite(Date.parse(value)), "--window-end is invalid.");
  return value;
};

const sourceReconstructionStatus = ({ manifestEntry, bundleEntry }) => {
  if (manifestEntry.source.slug === "get-secrets") {
    return "RETIRED_WITH_410_NO_RECONSTRUCTION";
  }
  if (manifestEntry.source_recovery.mode === "RECONSTRUCT_CONTRACT") {
    return "CUTOVER_BLOCKING_AGGREGATES_DO_NOT_PROVE_CONTRACT";
  }
  if (bundleEntry.capture_status === "STORE_NOT_FOUND") {
    return "CUTOVER_BLOCKING_LIVE_BUNDLE_UNAVAILABLE";
  }
  return "SOURCE_EVIDENCE_AVAILABLE";
};

export async function captureFunctionTrafficEvidence({
  manifest,
  bundleEvidence,
  projectRef,
  accessToken,
  windowEndUtc,
  minimumRequestDelayMs = MINIMUM_REQUEST_DELAY_MS,
  onWindowComplete = () => {},
  managementApiNow = Date.now,
  managementApiSleep = wait,
}) {
  assert(projectRef === EXPECTED_PROJECT_REF, "Source project ref is not the locked primary project.");
  assert(
    typeof accessToken === "string" &&
      accessToken.startsWith("sbp_") &&
      accessToken.length >= 20 &&
      !/\s/.test(accessToken),
    "SUPABASE_ACCESS_TOKEN is missing or malformed."
  );
  assert(manifest.schema_version === 1, "Retirement manifest schema is not supported.");
  assert(manifest.source_system.project_ref === projectRef, "Manifest project ref drifted.");
  assert(manifest.functions.length === 112, "Retirement manifest must contain 112 functions.");
  assert(bundleEvidence.entries.length === 112, "Bundle evidence must contain 112 functions.");
  assert(
    minimumRequestDelayMs >= MINIMUM_REQUEST_DELAY_MS,
    `Minimum request delay must be at least ${MINIMUM_REQUEST_DELAY_MS}ms.`
  );

  const sortedFunctions = [...manifest.functions].sort((left, right) =>
    compareUtf8(left.source.slug, right.source.slug)
  );
  const functionSlugs = sortedFunctions.map((entry) => entry.source.slug);
  const bundleBySlug = new Map(bundleEvidence.entries.map((entry) => [entry.slug, entry]));
  const queryTemplate = buildFunctionTrafficAggregateQuery(functionSlugs);
  const queryDigest = sha256(queryTemplate);
  const windowEndMs = Date.parse(requireUtcBoundary(windowEndUtc));
  const windowStartMs = windowEndMs - WINDOW_COUNT * WINDOW_HOURS * 60 * 60 * 1000;
  const attemptLimiter = createManagementApiAttemptLimiter({
    minimumDelayMs: minimumRequestDelayMs,
    now: managementApiNow,
    sleep: managementApiSleep,
  });

  const deployment = await fetchDeploymentBindings({
    projectRef,
    accessToken,
    manifest,
    attemptLimiter,
  });
  const deploymentBySlug = new Map(
    deployment.bindings.map((entry) => [entry.slug, entry])
  );
  const deploymentObservedAtUtcBucket = new Date(
    Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000
  ).toISOString();

  const entryBuckets = new Map(functionSlugs.map((slug) => [slug, []]));
  const windows = [];

  for (let index = 0; index < WINDOW_COUNT; index += 1) {
    const startUtc = new Date(
      windowStartMs + index * WINDOW_HOURS * 60 * 60 * 1000
    ).toISOString();
    const endUtc = new Date(
      windowStartMs + (index + 1) * WINDOW_HOURS * 60 * 60 * 1000
    ).toISOString();
    const query = buildFunctionTrafficAggregateQuery(functionSlugs, startUtc, endUtc);
    const result = await fetchTrafficWindow({
      projectRef,
      accessToken,
      query,
      startUtc,
      endUtc,
      attemptLimiter,
    });

    for (const observedSlug of result.bySlug.keys()) {
      assert(entryBuckets.has(observedSlug), "Provider aggregate returned an unknown active slug.");
    }

    let knownFunctionRequestCount = 0;
    for (const slug of functionSlugs) {
      const metrics = result.bySlug.get(slug) || emptyMetricSet();
      knownFunctionRequestCount += metrics.request_count;
      if (metrics.request_count > 0) {
        entryBuckets.get(slug).push({ window_index: index, ...metrics });
      }
    }
    windows.push({
      start_utc: startUtc,
      end_utc: endUtc,
      source_query_sha256: sha256(query),
      provider_response_sha256: result.providerResponseSha256,
      result_row_count: result.resultRowCount,
      provider_request_count:
        knownFunctionRequestCount + result.unattributedMetrics.request_count,
      known_function_request_count: knownFunctionRequestCount,
      unattributed_request_count: result.unattributedMetrics.request_count,
    });
    onWindowComplete({ completed: index + 1, total: WINDOW_COUNT });
  }

  const entries = sortedFunctions.map((manifestEntry) => {
    const slug = manifestEntry.source.slug;
    const buckets = entryBuckets.get(slug);
    const totals = buckets.reduce(
      (aggregate, bucket) => mergeMetricSets(aggregate, bucket),
      emptyMetricSet()
    );
    return {
      slug,
      terminal_traffic_status:
        totals.request_count === 0 ? "ZERO_TRAFFIC_OBSERVED" : "TRAFFIC_OBSERVED",
      source_reconstruction_status: sourceReconstructionStatus({
        manifestEntry,
        bundleEntry: bundleBySlug.get(slug),
      }),
      deployment_observed_at_utc_bucket: deploymentObservedAtUtcBucket,
      deployment_binding_sha256: deploymentBySlug.get(slug).deployment_binding_sha256,
      deployment_manifest_match_status:
        deploymentBySlug.get(slug).deployment_manifest_match_status,
      ...totals,
      nonzero_utc_buckets: buckets,
    };
  });

  const trafficObservedFunctions = entries.filter(
    (entry) => entry.terminal_traffic_status === "TRAFFIC_OBSERVED"
  ).length;
  const zeroTrafficObserved = entries.length - trafficObservedFunctions;
  const knownFunctionRequests = entries.reduce(
    (sum, entry) => sum + entry.request_count,
    0
  );
  const unattributedRequests = windows.reduce(
    (sum, window) => sum + window.unattributed_request_count,
    0
  );
  const cutoverBlockingSourceContracts = entries.filter((entry) =>
    entry.source_reconstruction_status.startsWith("CUTOVER_BLOCKING_")
  ).length;

  const evidence = {
    schema_version: 1,
    evidence_id: "hushh-tech-supabase-function-traffic-30d",
    manifest_binding: {
      manifest_id: manifest.manifest_id,
      manifest_schema_version: manifest.schema_version,
      source_project_ref: projectRef,
      active_function_inventory_digest_algorithm: manifest.inventory_digests.algorithm,
      active_function_inventory_digest: manifest.inventory_digests.active_functions,
      live_bundle_evidence_digest: bundleEvidence.evidence_digest.digest,
    },
    capture: {
      captured_at_utc: new Date().toISOString(),
      window_start_utc: new Date(windowStartMs).toISOString(),
      window_end_utc: new Date(windowEndMs).toISOString(),
      window_count: WINDOW_COUNT,
      bucket_width_hours: WINDOW_HOURS,
      interval_semantics:
        "HALF_OPEN_START_INCLUSIVE_END_EXCLUSIVE_ENFORCED_IN_CLICKHOUSE_SQL",
      per_function_bucket_representation:
        "SPARSE_NONZERO_BY_WINDOW_INDEX_OMITTED_IS_ZERO",
      log_source: "function_edge_logs",
      management_api_method: "GET",
      management_api_endpoint: "/v1/projects/{ref}/analytics/endpoints/logs",
      query_dialect: "clickhouse_sql",
      source_write_mode: "READ_ONLY_NO_DATABASE_NO_DEPLOYMENT",
      rate_limit_requests_per_minute: 10,
      minimum_inter_request_delay_ms: minimumRequestDelayMs,
      retry_policy: "FOUR_HTTP_ATTEMPTS_THREE_COMPLETE_WINDOW_ATTEMPTS_NO_PARTIAL_REUSE",
      provider_retention_days: PROVIDER_RETENTION_DAYS,
      provider_retention_status: "PROVIDER_90_DAY_BOUNDARY_OBSERVED",
      requested_window_available: true,
    },
    deployment_capture: {
      observed_at_utc_bucket: deploymentObservedAtUtcBucket,
      management_api_method: "GET",
      management_api_endpoint: "/v1/projects/{ref}/functions",
      source_write_mode: "READ_ONLY_NO_DEPLOYMENT",
      active_function_count: deployment.bindings.length,
      version_match_count: deployment.versionMatchCount,
      version_drift_count: deployment.versionDriftCount,
      version_delta_histogram: deployment.versionDeltaHistogram,
      version_delta_digest_algorithm: "sha256_of_sorted_delta_count_lines_v1",
      version_delta_digest: deployment.versionDeltaDigest,
      inventory_status:
        deployment.versionDriftCount === 0
          ? "EXACT_MANIFEST_MATCH"
          : "CUTOVER_BLOCKING_VERSION_DRIFT",
      provider_response_sha256: deployment.responseSha256,
      normalized_digest_algorithm:
        "sha256_of_sorted_slug_and_deployment_binding_hash_lines_v1",
      normalized_digest: deployment.normalizedDigest,
      updated_at_digest_algorithm:
        "sha256_of_sorted_slug_and_updated_at_hash_lines_v1",
      updated_at_digest: deployment.updatedAtDigest,
    },
    sanitization: {
      raw_logs_committed: false,
      request_or_response_bodies_committed: false,
      request_or_response_headers_committed: false,
      token_or_secret_values_committed: false,
      email_or_ip_values_committed: false,
      object_or_raw_path_values_committed: false,
      public_evidence: "per_slug_daily_aggregate_counts_ranges_and_hashes_only",
    },
    query_binding: {
      query_template_digest_algorithm: "sha256_utf8_v1",
      query_template_digest: queryDigest,
      provider_response_digest_algorithm: "sha256_raw_response_bytes_v1",
      allowed_result_fields: QUERY_RESULT_FIELDS,
    },
    expected_counts: {
      active_functions: entries.length,
      utc_buckets: windows.length,
      traffic_observed_functions: trafficObservedFunctions,
      zero_traffic_observed: zeroTrafficObserved,
      deployment_version_drift_functions: deployment.versionDriftCount,
      known_function_requests: knownFunctionRequests,
      unattributed_requests: unattributedRequests,
      cutover_blocking_source_contracts: cutoverBlockingSourceContracts,
    },
    unattributed_traffic_status:
      unattributedRequests === 0
        ? "ZERO_UNATTRIBUTED_TRAFFIC_OBSERVED"
        : "CUTOVER_BLOCKING_UNATTRIBUTED_TRAFFIC",
    windows,
    entries,
  };
  evidence.evidence_digest = {
    digest_algorithm: "sha256_of_stable_json_without_evidence_digest_v1",
    digest: digestTrafficEvidence(evidence),
  };
  return evidence;
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

const runDirectExecution = async () => {
  const manifestPath = parseArg("--manifest") || DEFAULT_MANIFEST_PATH;
  const bundleEvidencePath =
    parseArg("--bundle-evidence") || DEFAULT_BUNDLE_EVIDENCE_PATH;
  const outputPathArgument = parseArg("--output");
  const { outputLexical: outputPath } = resolveApprovedTrafficEvidenceOutput({
    outputPath: outputPathArgument,
  });
  const projectRef = parseArg("--project-ref") || EXPECTED_PROJECT_REF;
  const windowEndUtc = parseArg("--window-end");
  assert(windowEndUtc, "--window-end is required.");
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  const bundleEvidence = JSON.parse(
    fs.readFileSync(path.resolve(bundleEvidencePath), "utf8")
  );
  const evidence = await captureFunctionTrafficEvidence({
    manifest,
    bundleEvidence,
    projectRef,
    accessToken,
    windowEndUtc,
    onWindowComplete: ({ completed, total }) => {
      console.log(`Completed aggregate traffic window ${completed}/${total}.`);
    },
  });
  const writtenOutputPath = writeTrafficEvidenceCreateOnly({
    outputPath,
    evidence,
  });
  console.log(
    `Generated ${path.relative(process.cwd(), writtenOutputPath)}: ` +
      `${evidence.expected_counts.active_functions} functions, ` +
      `${evidence.expected_counts.utc_buckets} UTC buckets, ` +
      `${evidence.expected_counts.known_function_requests} known requests, ` +
      `${evidence.expected_counts.zero_traffic_observed} zero-traffic observations.`
  );
};

if (isDirectExecution) {
  try {
    await runDirectExecution();
  } catch (error) {
    console.error(formatFunctionTrafficCliFailure(error));
    process.exitCode = 1;
  }
}
