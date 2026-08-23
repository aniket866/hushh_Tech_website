import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { digestBundleEvidenceEntries } from "./generate-supabase-live-function-bundle-evidence.mjs";

import {
  DEFAULT_BUNDLE_EVIDENCE_PATH,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_TRAFFIC_EVIDENCE_PATH,
  EXPECTED_PROJECT_REF,
  MINIMUM_REQUEST_DELAY_MS,
  PROVIDER_RETENTION_DAYS,
  QUERY_RESULT_FIELDS,
  WINDOW_COUNT,
  WINDOW_HOURS,
  buildFunctionTrafficAggregateQuery,
  digestTrafficEvidence,
  emptyMetricSet,
  mergeMetricSets,
  sha256,
  stableJson,
} from "./generate-supabase-function-traffic-evidence.mjs";

const FROZEN_ACTIVE_FUNCTION_INVENTORY_DIGEST =
  "f0a18d0c1ece82c589f294b977b9fc8368a240ea5464724e9ad00e427aa3ce5d";
const FROZEN_LIVE_BUNDLE_EVIDENCE_DIGEST =
  "182de37b13bfb9201cbe94f1c850e995f15bcdf92d38e08f73449b5cf119ea7b";
const FROZEN_LIVE_BUNDLE_SOURCE_TREE_DIGEST =
  "a976749fa43425152fddb2649ba6442500e412627a004f6ff60ca2892b9011a2";
const FROZEN_FUNCTION_TRAFFIC_BINDING = {
  path: DEFAULT_TRAFFIC_EVIDENCE_PATH,
  schema_version: 1,
  evidence_digest_algorithm: "sha256_of_stable_json_without_evidence_digest_v1",
  evidence_digest: "eade0ef6ae4fbd34009a481ddf5771c3338de7034f6fcaff4dfbb3b453a00d51",
  window_start_utc: "2026-07-22T16:00:00.000Z",
  window_end_utc: "2026-08-21T16:00:00.000Z",
  bucket_width_hours: 24,
  interval_semantics:
    "HALF_OPEN_START_INCLUSIVE_END_EXCLUSIVE_ENFORCED_IN_CLICKHOUSE_SQL",
  per_function_bucket_representation:
    "SPARSE_NONZERO_BY_WINDOW_INDEX_OMITTED_IS_ZERO",
  provider_retention_days: 90,
  active_functions: 112,
  traffic_observed_functions: 18,
  zero_traffic_observed: 94,
  known_function_requests: 26481,
  unattributed_requests: 0,
  cutover_blocking_source_contracts: 17,
  deployment_version_drift_functions: 96,
  summary_digest_algorithm: "sha256_of_stable_expected_counts_json_v1",
  summary_digest:
    "523345dd3bf22ec87cedf9a31a1c25aa5647f61db74a192d7fc826643dfba208",
  window_digest_algorithm: "sha256_of_stable_window_json_lines_v1",
  window_digest:
    "36d79314958f9c56dd88a6bf81a0ddb89b6e0bfacb5637b27c72cfbb52699fe5",
  query_template_digest_algorithm: "sha256_utf8_v1",
  query_template_digest:
    "30c9fd867f9001a8bc6e10704f031df42aef3bd4199a5855bad826d7a24b6508",
  deployment_binding_digest_algorithm:
    "sha256_of_sorted_slug_and_deployment_binding_hash_lines_v1",
  deployment_binding_digest:
    "f7ef842b42a08fccca969c4dc1e212ebe764f0ffe7c3c8a3c30df11934842981",
  deployment_updated_at_digest_algorithm:
    "sha256_of_sorted_slug_and_updated_at_hash_lines_v1",
  deployment_updated_at_digest:
    "172b8956911bc48de78984cebfb804059f3751915edd1c95834bc9d2d02c96c9",
  deployment_version_delta_histogram: { 0: 16, 40: 96 },
  deployment_version_delta_digest_algorithm:
    "sha256_of_sorted_delta_count_lines_v1",
  deployment_version_delta_digest:
    "7f4d4af8fb38ece4c5ba58e02a1a204616933db08dc05c9762c05403acead7d7",
};

const TOP_LEVEL_KEYS = [
  "capture",
  "deployment_capture",
  "entries",
  "evidence_digest",
  "evidence_id",
  "expected_counts",
  "manifest_binding",
  "query_binding",
  "sanitization",
  "schema_version",
  "unattributed_traffic_status",
  "windows",
];
const METRIC_KEYS = [
  "auth_marker_counts",
  "latency_ms_range",
  "method_counts",
  "request_count",
  "response_size_bytes_range",
  "status_class_counts",
];
const ENTRY_KEYS = [
  "auth_marker_counts",
  "deployment_binding_sha256",
  "deployment_manifest_match_status",
  "deployment_observed_at_utc_bucket",
  "latency_ms_range",
  "method_counts",
  "nonzero_utc_buckets",
  "request_count",
  "response_size_bytes_range",
  "slug",
  "source_reconstruction_status",
  "status_class_counts",
  "terminal_traffic_status",
];
const BUCKET_KEYS = ["window_index", ...METRIC_KEYS];
const WINDOW_KEYS = [
  "end_utc",
  "known_function_request_count",
  "provider_request_count",
  "provider_response_sha256",
  "result_row_count",
  "source_query_sha256",
  "start_utc",
  "unattributed_request_count",
];

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const sameJson = (left, right) => stableJson(left) === stableJson(right);
const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isIsoUtc = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const exactKeys = (errors, label, value, expected) => {
  if (!isObject(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (!sameJson(actualKeys, expectedKeys)) {
    errors.push(`${label} contains a non-allowlisted or missing field.`);
    return false;
  }
  return true;
};

const safeCount = (errors, label, value) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    errors.push(`${label} must be a non-negative safe integer.`);
    return false;
  }
  return true;
};

const validateRange = (errors, label, value, requestCount) => {
  if (!exactKeys(errors, label, value, ["max", "min", "observed_count"])) return;
  if (!safeCount(errors, `${label}.observed_count`, value.observed_count)) return;
  if (value.observed_count > requestCount) {
    errors.push(`${label}.observed_count exceeds request_count.`);
  }
  if (value.observed_count === 0) {
    if (value.min !== null || value.max !== null) {
      errors.push(`${label} must use null bounds when no values were observed.`);
    }
  } else if (
    !Number.isSafeInteger(value.min) ||
    value.min < 0 ||
    !Number.isSafeInteger(value.max) ||
    value.max < value.min
  ) {
    errors.push(`${label} bounds are invalid.`);
  }
};

const validateMetricSet = (errors, label, value) => {
  if (!isObject(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  const metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, value[key]]));
  if (!safeCount(errors, `${label}.request_count`, metrics.request_count)) return false;
  const countContracts = [
    [
      "status_class_counts",
      ["status_1xx", "status_2xx", "status_3xx", "status_4xx", "status_5xx", "status_other"],
    ],
    [
      "method_counts",
      ["DELETE", "GET", "HEAD", "OPTIONS", "OTHER", "PATCH", "POST", "PUT"],
    ],
    [
      "auth_marker_counts",
      ["authorization_jwt_marker_absent", "authorization_jwt_marker_present"],
    ],
  ];
  for (const [field, expectedKeys] of countContracts) {
    if (!exactKeys(errors, `${label}.${field}`, metrics[field], expectedKeys)) continue;
    let total = 0;
    for (const key of expectedKeys) {
      safeCount(errors, `${label}.${field}.${key}`, metrics[field][key]);
      total += Number(metrics[field][key] || 0);
    }
    if (total !== metrics.request_count) {
      errors.push(`${label}.${field} does not reconcile to request_count.`);
    }
  }
  validateRange(errors, `${label}.latency_ms_range`, metrics.latency_ms_range, metrics.request_count);
  validateRange(
    errors,
    `${label}.response_size_bytes_range`,
    metrics.response_size_bytes_range,
    metrics.request_count
  );
  return true;
};

const metricSetFrom = (value) => ({
  request_count: value.request_count,
  status_class_counts: value.status_class_counts,
  method_counts: value.method_counts,
  auth_marker_counts: value.auth_marker_counts,
  latency_ms_range: value.latency_ms_range,
  response_size_bytes_range: value.response_size_bytes_range,
});

const duplicateValues = (values) =>
  [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));

const digestSortedLines = (values) =>
  sha256(`${[...values].sort(compareUtf8).join("\n")}\n`);

export function validateFunctionTrafficUpstream(manifest, bundleEvidence) {
  const errors = [];
  if (!isObject(manifest)) {
    return { valid: false, errors: ["Upstream retirement manifest must be an object."] };
  }
  if (!isObject(bundleEvidence)) {
    return { valid: false, errors: ["Upstream live bundle evidence must be an object."] };
  }

  const functions = asArray(manifest.functions);
  if (
    manifest.schema_version !== 1 ||
    manifest.manifest_id !== "hushh-tech-no-hybrid-supabase-retirement" ||
    manifest.source_system?.project_ref !== EXPECTED_PROJECT_REF ||
    functions.length !== 112
  ) {
    errors.push("Upstream retirement manifest identity or function count is invalid.");
  }
  const usableFunctions = functions.filter(
    (entry) =>
      isObject(entry) &&
      typeof entry.source?.slug === "string" &&
      typeof entry.source?.function_id === "string"
  );
  if (usableFunctions.length !== functions.length) {
    errors.push("Upstream retirement manifest contains an invalid function entry.");
  }
  const functionSlugs = usableFunctions.map((entry) => entry.source.slug);
  const functionIds = usableFunctions.map((entry) => entry.source.function_id);
  if (
    duplicateValues(functionSlugs).length > 0 ||
    duplicateValues(functionIds).length > 0 ||
    !sameJson(functionSlugs, [...functionSlugs].sort(compareUtf8))
  ) {
    errors.push("Upstream retirement manifest function identity ordering is invalid.");
  }
  const activeFunctionDigest = digestSortedLines(
    usableFunctions.map((entry) => `${entry.source.slug}:${entry.source.function_id}`)
  );
  if (
    manifest.inventory_digests?.algorithm !== "sha256_sorted_newline_v1" ||
    manifest.inventory_digests?.active_functions !== activeFunctionDigest ||
    activeFunctionDigest !== FROZEN_ACTIVE_FUNCTION_INVENTORY_DIGEST
  ) {
    errors.push("Upstream frozen active-function inventory digest is invalid.");
  }

  exactKeys(errors, "Upstream live bundle evidence", bundleEvidence, [
    "canonical_source_tree",
    "capture",
    "entries",
    "evidence_digest",
    "evidence_id",
    "expected_counts",
    "manifest_binding",
    "sanitization",
    "schema_version",
  ]);
  if (
    bundleEvidence.schema_version !== 1 ||
    bundleEvidence.evidence_id !== "hushh-tech-supabase-live-function-bundles" ||
    !sameJson(bundleEvidence.manifest_binding, {
      manifest_id: manifest.manifest_id,
      manifest_schema_version: manifest.schema_version,
      source_project_ref: EXPECTED_PROJECT_REF,
    }) ||
    !sameJson(bundleEvidence.capture, {
      tool: "supabase_cli",
      tool_version: "2.115.0",
      method: "functions_download_current_bundle_extractor_read_only",
      source_write_mode: "READ_ONLY_NO_DEPLOYMENT",
    }) ||
    !sameJson(bundleEvidence.sanitization, {
      recovered_source_content_committed: false,
      stdout_or_stderr_committed: false,
      secret_or_token_values_committed: false,
      temporary_absolute_paths_committed: false,
      public_evidence: "per_slug_content_tree_digest_file_count_and_byte_count_only",
    }) ||
    !sameJson(bundleEvidence.expected_counts, {
      active_functions: 112,
      extracted_bundles: 96,
      store_not_found: 16,
      extracted_files: 445,
      extracted_bytes: 2677504,
    }) ||
    !sameJson(bundleEvidence.canonical_source_tree, {
      digest_algorithm:
        "sha256_of_sha256_double_space_relative_path_lines_lc_all_c_v1",
      digest: FROZEN_LIVE_BUNDLE_SOURCE_TREE_DIGEST,
    })
  ) {
    errors.push("Upstream live bundle evidence contract is invalid.");
  }

  const bundleEntries = asArray(bundleEvidence.entries);
  if (bundleEntries.length !== 112) {
    errors.push("Upstream live bundle evidence must contain 112 entries.");
  }
  const manifestBySlug = new Map(
    usableFunctions.map((entry) => [entry.source.slug, entry])
  );
  const bundleSlugs = bundleEntries.map((entry) => entry?.slug);
  if (
    duplicateValues(bundleSlugs).length > 0 ||
    !sameJson(bundleSlugs, [...bundleSlugs].sort(compareUtf8)) ||
    !sameJson(bundleSlugs, functionSlugs)
  ) {
    errors.push("Upstream live bundle evidence function set is invalid.");
  }
  let extractedBundles = 0;
  let storeNotFound = 0;
  let extractedFiles = 0;
  let extractedBytes = 0;
  for (const entry of bundleEntries) {
    if (!isObject(entry) || typeof entry.slug !== "string") {
      errors.push("Upstream live bundle evidence contains an invalid entry.");
      continue;
    }
    const manifestEntry = manifestBySlug.get(entry.slug);
    if (
      !manifestEntry ||
      entry.function_id !== manifestEntry.source.function_id ||
      entry.version !== manifestEntry.source.version ||
      entry.verify_jwt !== manifestEntry.source.verify_jwt ||
      entry.source_recovery_mode !== manifestEntry.source_recovery?.mode ||
      entry.final_disposition !== manifestEntry.final_disposition
    ) {
      errors.push("Upstream live bundle evidence entry does not match its manifest function.");
    }
    if (entry.migration_state !== "INVENTORY_FROZEN") {
      errors.push(
        "Upstream live bundle evidence must preserve its historical migration state."
      );
    }
    if (entry.capture_status === "EXTRACTED") {
      exactKeys(errors, "Upstream extracted live bundle entry", entry, [
        "bundle_evidence",
        "capture_status",
        "final_disposition",
        "function_id",
        "migration_state",
        "slug",
        "source_recovery_mode",
        "verify_jwt",
        "version",
      ]);
      exactKeys(errors, "Upstream extracted live bundle digest", entry.bundle_evidence, [
        "canonical_digest",
        "digest_algorithm",
        "file_count",
        "total_bytes",
      ]);
      if (
        entry.bundle_evidence?.digest_algorithm !==
          "sha256_of_sha256_double_space_relative_path_lines_lc_all_c_v1" ||
        !isSha256(entry.bundle_evidence?.canonical_digest) ||
        !Number.isSafeInteger(entry.bundle_evidence?.file_count) ||
        entry.bundle_evidence.file_count < 1 ||
        !Number.isSafeInteger(entry.bundle_evidence?.total_bytes) ||
        entry.bundle_evidence.total_bytes < 1
      ) {
        errors.push("Upstream extracted live bundle digest contract is invalid.");
      }
      extractedBundles += 1;
      extractedFiles += Number(entry.bundle_evidence?.file_count || 0);
      extractedBytes += Number(entry.bundle_evidence?.total_bytes || 0);
    } else if (entry.capture_status === "STORE_NOT_FOUND") {
      exactKeys(errors, "Upstream store-not-found live bundle entry", entry, [
        "capture_status",
        "final_disposition",
        "function_id",
        "migration_state",
        "slug",
        "source_recovery_mode",
        "store_lookup",
        "verify_jwt",
        "version",
      ]);
      if (!sameJson(entry.store_lookup, { http_status: 404, provider_error_code: "UnknownError" })) {
        errors.push("Upstream store-not-found live bundle lookup is invalid.");
      }
      storeNotFound += 1;
    } else {
      errors.push("Upstream live bundle evidence capture status is invalid.");
    }
  }
  if (
    extractedBundles !== 96 ||
    storeNotFound !== 16 ||
    extractedFiles !== 445 ||
    extractedBytes !== 2677504
  ) {
    errors.push("Upstream live bundle evidence aggregate counts are invalid.");
  }

  const liveBundleDigest =
    bundleEntries.length === 112 && bundleEntries.every(isObject)
      ? digestBundleEvidenceEntries(bundleEntries)
      : null;
  if (
    liveBundleDigest !== FROZEN_LIVE_BUNDLE_EVIDENCE_DIGEST ||
    bundleEvidence.evidence_digest?.digest_algorithm !==
      "sha256_of_canonical_function_bundle_evidence_lines_v1" ||
    bundleEvidence.evidence_digest?.digest !== liveBundleDigest ||
    manifest.live_function_bundle_evidence?.evidence_digest !== liveBundleDigest
  ) {
    errors.push("Upstream frozen live bundle evidence digest is invalid.");
  }

  return {
    valid: errors.length === 0,
    errors,
    observed: { activeFunctionDigest, liveBundleDigest },
  };
}

const expectedSourceReconstructionStatus = (manifestEntry, bundleEntry) => {
  if (manifestEntry.source?.slug === "get-secrets") {
    return "RETIRED_WITH_410_NO_RECONSTRUCTION";
  }
  if (manifestEntry.source_recovery?.mode === "RECONSTRUCT_CONTRACT") {
    return "CUTOVER_BLOCKING_AGGREGATES_DO_NOT_PROVE_CONTRACT";
  }
  if (bundleEntry?.capture_status === "STORE_NOT_FOUND") {
    return "CUTOVER_BLOCKING_LIVE_BUNDLE_UNAVAILABLE";
  }
  return "SOURCE_EVIDENCE_AVAILABLE";
};

const scanForSensitiveMaterial = (errors, evidence) => {
  const serialized = JSON.stringify(evidence);
  const prohibitedValuePatterns = [
    [/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/, "email-like value"],
    [/\bsbp_(?:oauth_)?[A-Za-z0-9_-]{10,}/, "Supabase token-like value"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, "JWT-like value"],
    [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "IP-like value"],
    [/Bearer\s+[A-Za-z0-9._-]+/i, "bearer credential-like value"],
  ];
  for (const [pattern, label] of prohibitedValuePatterns) {
    if (pattern.test(serialized)) errors.push(`Traffic evidence contains a prohibited ${label}.`);
  }

  const forbiddenFieldPattern = /^(event_message|log_attributes|request_headers?|response_headers?|request_body|response_body|access_token|refresh_token|service_role_key|email|emails|ip|ip_address|user_agent|object_name|raw_log|raw_request|raw_response|request_path|function_id|deployment_id)$/i;
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenFieldPattern.test(key)) {
        errors.push("Traffic evidence contains a prohibited sensitive field.");
      }
      visit(child);
    }
  };
  visit(evidence);
};

export function validateFunctionTrafficEvidence(manifest, bundleEvidence, evidence) {
  const errors = [];
  if (!isObject(evidence)) {
    return { valid: false, errors: ["Function traffic evidence root must be an object."], observed: {} };
  }
  exactKeys(errors, "Function traffic evidence", evidence, TOP_LEVEL_KEYS);
  scanForSensitiveMaterial(errors, evidence);
  const upstream = validateFunctionTrafficUpstream(manifest, bundleEvidence);
  errors.push(...upstream.errors);
  if (!upstream.valid) {
    return {
      valid: false,
      errors,
      observed: {
        active_function_inventory_digest:
          upstream.observed?.activeFunctionDigest ?? null,
        live_bundle_evidence_digest: upstream.observed?.liveBundleDigest ?? null,
      },
    };
  }

  if (evidence.schema_version !== 1) errors.push("Function traffic schema_version must be 1.");
  if (evidence.evidence_id !== "hushh-tech-supabase-function-traffic-30d") {
    errors.push("Function traffic evidence_id is invalid.");
  }

  exactKeys(errors, "Traffic manifest binding", evidence.manifest_binding, [
    "active_function_inventory_digest",
    "active_function_inventory_digest_algorithm",
    "live_bundle_evidence_digest",
    "manifest_id",
    "manifest_schema_version",
    "source_project_ref",
  ]);
  if (
    !sameJson(evidence.manifest_binding, {
      manifest_id: manifest?.manifest_id,
      manifest_schema_version: manifest?.schema_version,
      source_project_ref: EXPECTED_PROJECT_REF,
      active_function_inventory_digest_algorithm: manifest?.inventory_digests?.algorithm,
      active_function_inventory_digest: manifest?.inventory_digests?.active_functions,
      live_bundle_evidence_digest: bundleEvidence?.evidence_digest?.digest,
    })
  ) {
    errors.push("Traffic manifest binding does not match the frozen inventory.");
  }

  exactKeys(errors, "Traffic capture", evidence.capture, [
    "bucket_width_hours",
    "captured_at_utc",
    "interval_semantics",
    "log_source",
    "management_api_endpoint",
    "management_api_method",
    "minimum_inter_request_delay_ms",
    "per_function_bucket_representation",
    "provider_retention_days",
    "provider_retention_status",
    "query_dialect",
    "rate_limit_requests_per_minute",
    "requested_window_available",
    "retry_policy",
    "source_write_mode",
    "window_count",
    "window_end_utc",
    "window_start_utc",
  ]);
  const capture = evidence.capture || {};
  if (!isIsoUtc(capture.captured_at_utc)) errors.push("Traffic captured_at_utc is invalid.");
  if (!isIsoUtc(capture.window_start_utc) || !isIsoUtc(capture.window_end_utc)) {
    errors.push("Traffic window timestamps are invalid.");
  }
  if (
    Date.parse(capture.window_end_utc) - Date.parse(capture.window_start_utc) !==
    WINDOW_COUNT * WINDOW_HOURS * 60 * 60 * 1000
  ) {
    errors.push("Traffic evidence must cover exactly 30 complete UTC days.");
  }
  const expectedCapture = {
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
    provider_retention_days: PROVIDER_RETENTION_DAYS,
    provider_retention_status: "PROVIDER_90_DAY_BOUNDARY_OBSERVED",
    requested_window_available: true,
    retry_policy: "FOUR_HTTP_ATTEMPTS_THREE_COMPLETE_WINDOW_ATTEMPTS_NO_PARTIAL_REUSE",
  };
  for (const [key, expected] of Object.entries(expectedCapture)) {
    if (capture[key] !== expected) errors.push(`Traffic capture.${key} is invalid.`);
  }
  if (capture.minimum_inter_request_delay_ms < MINIMUM_REQUEST_DELAY_MS) {
    errors.push("Traffic capture rate limiting is below the safe minimum.");
  }

  exactKeys(errors, "Traffic deployment capture", evidence.deployment_capture, [
    "active_function_count",
    "inventory_status",
    "management_api_endpoint",
    "management_api_method",
    "normalized_digest",
    "normalized_digest_algorithm",
    "observed_at_utc_bucket",
    "provider_response_sha256",
    "source_write_mode",
    "updated_at_digest",
    "updated_at_digest_algorithm",
    "version_delta_digest",
    "version_delta_digest_algorithm",
    "version_delta_histogram",
    "version_drift_count",
    "version_match_count",
  ]);
  const deployment = evidence.deployment_capture || {};
  if (
    deployment.management_api_method !== "GET" ||
    deployment.management_api_endpoint !== "/v1/projects/{ref}/functions" ||
    deployment.source_write_mode !== "READ_ONLY_NO_DEPLOYMENT" ||
    deployment.active_function_count !== 112 ||
    deployment.version_match_count !== 16 ||
    deployment.version_drift_count !== 96 ||
    deployment.inventory_status !== "CUTOVER_BLOCKING_VERSION_DRIFT" ||
    deployment.normalized_digest_algorithm !==
      "sha256_of_sorted_slug_and_deployment_binding_hash_lines_v1" ||
    deployment.updated_at_digest_algorithm !==
      "sha256_of_sorted_slug_and_updated_at_hash_lines_v1" ||
    deployment.version_delta_digest_algorithm !==
      "sha256_of_sorted_delta_count_lines_v1" ||
    !sameJson(deployment.version_delta_histogram, { 0: 16, 40: 96 }) ||
    deployment.version_delta_digest !==
      sha256("0  16\n40  96\n") ||
    !isIsoUtc(deployment.observed_at_utc_bucket) ||
    !isSha256(deployment.provider_response_sha256) ||
    !isSha256(deployment.normalized_digest) ||
    !isSha256(deployment.updated_at_digest) ||
    !isSha256(deployment.version_delta_digest)
  ) {
    errors.push("Traffic deployment capture contract is invalid.");
  }

  exactKeys(errors, "Traffic sanitization", evidence.sanitization, [
    "email_or_ip_values_committed",
    "object_or_raw_path_values_committed",
    "public_evidence",
    "raw_logs_committed",
    "request_or_response_bodies_committed",
    "request_or_response_headers_committed",
    "token_or_secret_values_committed",
  ]);
  if (
    !sameJson(evidence.sanitization, {
      raw_logs_committed: false,
      request_or_response_bodies_committed: false,
      request_or_response_headers_committed: false,
      token_or_secret_values_committed: false,
      email_or_ip_values_committed: false,
      object_or_raw_path_values_committed: false,
      public_evidence: "per_slug_daily_aggregate_counts_ranges_and_hashes_only",
    })
  ) {
    errors.push("Traffic sanitization contract is invalid.");
  }

  const functionSlugs = asArray(manifest?.functions)
    .map((entry) => entry.source?.slug)
    .sort();
  const queryTemplate = buildFunctionTrafficAggregateQuery(functionSlugs);
  exactKeys(errors, "Traffic query binding", evidence.query_binding, [
    "allowed_result_fields",
    "provider_response_digest_algorithm",
    "query_template_digest",
    "query_template_digest_algorithm",
  ]);
  if (
    evidence.query_binding?.query_template_digest_algorithm !== "sha256_utf8_v1" ||
    evidence.query_binding?.query_template_digest !== sha256(queryTemplate) ||
    evidence.query_binding?.provider_response_digest_algorithm !==
      "sha256_raw_response_bytes_v1" ||
    !sameJson(evidence.query_binding?.allowed_result_fields, QUERY_RESULT_FIELDS)
  ) {
    errors.push("Traffic query binding does not match the allowlisted aggregate query.");
  }

  const windows = asArray(evidence.windows);
  if (windows.length !== WINDOW_COUNT) {
    errors.push(`Traffic evidence must contain ${WINDOW_COUNT} UTC windows.`);
  }
  let previousEnd = capture.window_start_utc;
  for (const [index, window] of windows.entries()) {
    exactKeys(errors, `Traffic window ${index}`, window, WINDOW_KEYS);
    if (!isIsoUtc(window.start_utc) || !isIsoUtc(window.end_utc)) {
      errors.push(`Traffic window ${index} timestamps are invalid.`);
      continue;
    }
    if (
      window.start_utc !== previousEnd ||
      Date.parse(window.end_utc) - Date.parse(window.start_utc) !==
        WINDOW_HOURS * 60 * 60 * 1000
    ) {
      errors.push(`Traffic window ${index} is not contiguous and exactly 24 hours.`);
    }
    previousEnd = window.end_utc;
    for (const field of [
      "provider_request_count",
      "known_function_request_count",
      "unattributed_request_count",
      "result_row_count",
    ]) {
      safeCount(errors, `Traffic window ${index}.${field}`, window[field]);
    }
    if (
      window.provider_request_count !==
      window.known_function_request_count + window.unattributed_request_count
    ) {
      errors.push(`Traffic window ${index} request counts do not reconcile.`);
    }
    if (window.result_row_count > 113) {
      errors.push(`Traffic window ${index} exceeds the aggregate result row limit.`);
    }
    if (!isSha256(window.provider_response_sha256)) {
      errors.push(`Traffic window ${index} provider response digest is invalid.`);
    }
    if (
      window.source_query_sha256 !==
      sha256(
        buildFunctionTrafficAggregateQuery(
          functionSlugs,
          window.start_utc,
          window.end_utc
        )
      )
    ) {
      errors.push(`Traffic window ${index} source query digest changed.`);
    }
  }
  if (windows.at(-1)?.end_utc !== capture.window_end_utc) {
    errors.push("Traffic windows do not end at the declared capture boundary.");
  }

  const entries = asArray(evidence.entries);
  if (entries.length !== 112) errors.push("Function traffic evidence must contain 112 entries.");
  const slugs = entries.map((entry) => entry?.slug);
  if (!sameJson(slugs, [...slugs].sort())) {
    errors.push("Function traffic entries must stay sorted by slug.");
  }
  const duplicates = duplicateValues(slugs);
  if (duplicates.length > 0) errors.push("Function traffic evidence contains duplicate slugs.");
  if (!sameJson([...slugs].sort(), functionSlugs)) {
    errors.push("Function traffic evidence contains an unknown or missing slug.");
  }

  const manifestBySlug = new Map(
    asArray(manifest?.functions).map((entry) => [entry.source?.slug, entry])
  );
  const bundleBySlug = new Map(
    asArray(bundleEvidence?.entries).map((entry) => [entry.slug, entry])
  );
  const entryBySlug = new Map();
  let knownFunctionRequests = 0;
  let trafficObservedFunctions = 0;
  let zeroTrafficObserved = 0;
  let cutoverBlockingSourceContracts = 0;
  let deploymentVersionDriftFunctions = 0;

  for (const [entryIndex, entry] of entries.entries()) {
    exactKeys(errors, `Traffic entry ${entryIndex}`, entry, ENTRY_KEYS);
    if (!manifestBySlug.has(entry.slug)) continue;
    entryBySlug.set(entry.slug, entry);
    validateMetricSet(errors, `Traffic entry ${entry.slug}`, entry);
    knownFunctionRequests += Number(entry.request_count || 0);
    const expectedTerminal =
      entry.request_count === 0 ? "ZERO_TRAFFIC_OBSERVED" : "TRAFFIC_OBSERVED";
    if (entry.terminal_traffic_status !== expectedTerminal) {
      errors.push(`Traffic entry ${entry.slug} has an invalid terminal traffic status.`);
    }
    if (expectedTerminal === "ZERO_TRAFFIC_OBSERVED") zeroTrafficObserved += 1;
    else trafficObservedFunctions += 1;
    if (/UNUSED/i.test(entry.terminal_traffic_status || "")) {
      errors.push(`Traffic entry ${entry.slug} must never infer UNUSED from zero traffic.`);
    }

    const expectedSourceStatus = expectedSourceReconstructionStatus(
      manifestBySlug.get(entry.slug),
      bundleBySlug.get(entry.slug)
    );
    if (entry.source_reconstruction_status !== expectedSourceStatus) {
      errors.push(`Traffic entry ${entry.slug} source reconstruction gate is invalid.`);
    }
    if (expectedSourceStatus.startsWith("CUTOVER_BLOCKING_")) {
      cutoverBlockingSourceContracts += 1;
    }
    if (
      entry.deployment_observed_at_utc_bucket !== deployment.observed_at_utc_bucket ||
      !isSha256(entry.deployment_binding_sha256)
    ) {
      errors.push(`Traffic entry ${entry.slug} deployment binding is invalid.`);
    }
    const expectedDeploymentStatus =
      bundleBySlug.get(entry.slug)?.capture_status === "STORE_NOT_FOUND"
        ? "EXACT_MANIFEST_MATCH"
        : "CUTOVER_BLOCKING_VERSION_DRIFT";
    if (entry.deployment_manifest_match_status !== expectedDeploymentStatus) {
      errors.push(`Traffic entry ${entry.slug} deployment drift status is invalid.`);
    }
    if (expectedDeploymentStatus === "CUTOVER_BLOCKING_VERSION_DRIFT") {
      deploymentVersionDriftFunctions += 1;
    }

    if (!Array.isArray(entry.nonzero_utc_buckets)) {
      errors.push(`Traffic entry ${entry.slug} nonzero_utc_buckets must be an array.`);
    }
    const buckets = asArray(entry.nonzero_utc_buckets);
    let aggregate = emptyMetricSet();
    let previousWindowIndex = -1;
    for (const [bucketIndex, bucket] of buckets.entries()) {
      exactKeys(errors, `Traffic entry ${entry.slug} bucket ${bucketIndex}`, bucket, BUCKET_KEYS);
      if (
        !Number.isSafeInteger(bucket.window_index) ||
        bucket.window_index < 0 ||
        bucket.window_index >= WINDOW_COUNT
      ) {
        errors.push(`Traffic entry ${entry.slug} bucket ${bucketIndex} window_index is invalid.`);
      } else if (bucket.window_index <= previousWindowIndex) {
        errors.push(
          `Traffic entry ${entry.slug} nonzero buckets must have unique ascending window indexes.`
        );
      }
      previousWindowIndex = Number(bucket.window_index);
      if (validateMetricSet(errors, `Traffic entry ${entry.slug} bucket ${bucketIndex}`, bucket)) {
        if (bucket.request_count === 0) {
          errors.push(
            `Traffic entry ${entry.slug} must omit zero buckets from its sparse representation.`
          );
        }
        aggregate = mergeMetricSets(aggregate, metricSetFrom(bucket));
      }
    }
    if (!sameJson(aggregate, metricSetFrom(entry))) {
      errors.push(`Traffic entry ${entry.slug} bucket totals do not match its aggregate.`);
    }
  }

  for (const [windowIndex, window] of windows.entries()) {
    let bucketTotal = 0;
    for (const slug of functionSlugs) {
      const bucket = asArray(entryBySlug.get(slug)?.nonzero_utc_buckets).find(
        (candidate) => candidate.window_index === windowIndex
      );
      bucketTotal += Number(bucket?.request_count || 0);
    }
    if (bucketTotal !== window.known_function_request_count) {
      errors.push(`Traffic window ${windowIndex} does not reconcile to function buckets.`);
    }
  }

  const unattributedRequests = windows.reduce(
    (sum, window) => sum + Number(window.unattributed_request_count || 0),
    0
  );
  const expectedUnattributedStatus =
    unattributedRequests === 0
      ? "ZERO_UNATTRIBUTED_TRAFFIC_OBSERVED"
      : "CUTOVER_BLOCKING_UNATTRIBUTED_TRAFFIC";
  if (evidence.unattributed_traffic_status !== expectedUnattributedStatus) {
    errors.push("Unattributed traffic must fail closed when its count is nonzero.");
  }

  const expectedCounts = {
    active_functions: entries.length,
    utc_buckets: windows.length,
    traffic_observed_functions: trafficObservedFunctions,
    zero_traffic_observed: zeroTrafficObserved,
    deployment_version_drift_functions: deploymentVersionDriftFunctions,
    known_function_requests: knownFunctionRequests,
    unattributed_requests: unattributedRequests,
    cutover_blocking_source_contracts: cutoverBlockingSourceContracts,
  };
  exactKeys(errors, "Traffic expected_counts", evidence.expected_counts, Object.keys(expectedCounts));
  if (!sameJson(evidence.expected_counts, expectedCounts)) {
    errors.push("Traffic expected_counts do not match the evidence entries.");
  }

  const normalizedDeploymentDigest = sha256(
    entries
      .map((entry) => `${entry.slug}  ${entry.deployment_binding_sha256}\n`)
      .join("")
  );
  if (deployment.normalized_digest !== normalizedDeploymentDigest) {
    errors.push("Traffic deployment normalized digest does not match its entries.");
  }

  exactKeys(errors, "Traffic evidence digest", evidence.evidence_digest, [
    "digest",
    "digest_algorithm",
  ]);
  const observedEvidenceDigest = digestTrafficEvidence(evidence);
  if (
    evidence.evidence_digest?.digest_algorithm !==
      "sha256_of_stable_json_without_evidence_digest_v1" ||
    evidence.evidence_digest?.digest !== observedEvidenceDigest
  ) {
    errors.push("Function traffic evidence digest does not match the artifact.");
  }
  const summaryDigest = sha256(`${stableJson(expectedCounts)}\n`);
  const windowDigest = sha256(
    windows.map((window) => `${stableJson(window)}\n`).join("")
  );
  const expectedManifestTrafficBinding = {
    path: DEFAULT_TRAFFIC_EVIDENCE_PATH,
    schema_version: 1,
    evidence_digest_algorithm:
      "sha256_of_stable_json_without_evidence_digest_v1",
    evidence_digest: observedEvidenceDigest,
    window_start_utc: capture.window_start_utc,
    window_end_utc: capture.window_end_utc,
    bucket_width_hours: capture.bucket_width_hours,
    interval_semantics: capture.interval_semantics,
    per_function_bucket_representation:
      capture.per_function_bucket_representation,
    provider_retention_days: capture.provider_retention_days,
    active_functions: expectedCounts.active_functions,
    traffic_observed_functions: expectedCounts.traffic_observed_functions,
    zero_traffic_observed: expectedCounts.zero_traffic_observed,
    known_function_requests: expectedCounts.known_function_requests,
    unattributed_requests: expectedCounts.unattributed_requests,
    cutover_blocking_source_contracts:
      expectedCounts.cutover_blocking_source_contracts,
    deployment_version_drift_functions:
      expectedCounts.deployment_version_drift_functions,
    summary_digest_algorithm: "sha256_of_stable_expected_counts_json_v1",
    summary_digest: summaryDigest,
    window_digest_algorithm: "sha256_of_stable_window_json_lines_v1",
    window_digest: windowDigest,
    query_template_digest_algorithm:
      evidence.query_binding?.query_template_digest_algorithm,
    query_template_digest: evidence.query_binding?.query_template_digest,
    deployment_binding_digest_algorithm: deployment.normalized_digest_algorithm,
    deployment_binding_digest: normalizedDeploymentDigest,
    deployment_updated_at_digest_algorithm: deployment.updated_at_digest_algorithm,
    deployment_updated_at_digest: deployment.updated_at_digest,
    deployment_version_delta_histogram: deployment.version_delta_histogram,
    deployment_version_delta_digest_algorithm:
      deployment.version_delta_digest_algorithm,
    deployment_version_delta_digest: deployment.version_delta_digest,
  };
  if (!sameJson(manifest.live_function_traffic_evidence, expectedManifestTrafficBinding)) {
    errors.push(
      "Manifest live_function_traffic_evidence does not match computed traffic evidence."
    );
  }
  if (!sameJson(expectedManifestTrafficBinding, FROZEN_FUNCTION_TRAFFIC_BINDING)) {
    errors.push("Computed traffic evidence does not match the frozen traffic binding.");
  }

  return {
    valid: errors.length === 0,
    errors,
    observed: {
      active_functions: entries.length,
      utc_buckets: windows.length,
      window_start_utc: capture.window_start_utc ?? null,
      window_end_utc: capture.window_end_utc ?? null,
      provider_retention_days: capture.provider_retention_days ?? null,
      traffic_observed_functions: trafficObservedFunctions,
      zero_traffic_observed: zeroTrafficObserved,
      deployment_version_drift_functions: deploymentVersionDriftFunctions,
      known_function_requests: knownFunctionRequests,
      unattributed_requests: unattributedRequests,
      cutover_blocking_source_contracts: cutoverBlockingSourceContracts,
      evidence_digest: observedEvidenceDigest,
      deployment_digest: normalizedDeploymentDigest,
      summary_digest: summaryDigest,
      window_digest: windowDigest,
    },
  };
}

export function readAndValidateFunctionTrafficEvidence({
  manifestPath = DEFAULT_MANIFEST_PATH,
  bundleEvidencePath = DEFAULT_BUNDLE_EVIDENCE_PATH,
  trafficEvidencePath = DEFAULT_TRAFFIC_EVIDENCE_PATH,
} = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  const bundleEvidence = JSON.parse(
    fs.readFileSync(path.resolve(bundleEvidencePath), "utf8")
  );
  const trafficEvidence = JSON.parse(
    fs.readFileSync(path.resolve(trafficEvidencePath), "utf8")
  );
  return {
    trafficEvidencePath: path.resolve(trafficEvidencePath),
    ...validateFunctionTrafficEvidence(manifest, bundleEvidence, trafficEvidence),
  };
}

const parseArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const result = readAndValidateFunctionTrafficEvidence({
    manifestPath: parseArg("--manifest") || DEFAULT_MANIFEST_PATH,
    bundleEvidencePath: parseArg("--bundle-evidence") || DEFAULT_BUNDLE_EVIDENCE_PATH,
    trafficEvidencePath: parseArg("--traffic-evidence") || DEFAULT_TRAFFIC_EVIDENCE_PATH,
  });
  if (!result.valid) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Function traffic evidence valid: ${result.observed.active_functions} functions, ` +
        `${result.observed.utc_buckets} UTC buckets, ` +
        `${result.observed.known_function_requests} known requests.`
    );
  }
}
