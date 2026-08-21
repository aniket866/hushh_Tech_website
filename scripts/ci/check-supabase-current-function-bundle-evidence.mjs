import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CURRENT_EVIDENCE_PATH,
  DEFAULT_HISTORICAL_EVIDENCE_PATH,
  DEFAULT_MANIFEST_PATH,
  ATTEMPT_EVIDENCE_DIGEST_ALGORITHM,
  BUNDLE_DIGEST_ALGORITHM,
  CANONICAL_RECORD_ENCODING,
  CURRENT_SOURCE_TREE_DIGEST_ALGORITHM,
  EVIDENCE_DIGEST_ALGORITHM,
  METADATA_DIGEST_ALGORITHM,
  RECOVERY_SNAPSHOT_DIGEST_ALGORITHM,
  digestAttemptEvidence,
  digestCurrentEvidence,
  digestCurrentMetadata,
  digestCurrentSourceTree,
  sha256,
} from "./generate-supabase-current-function-bundle-evidence.mjs";
import {
  validateLiveFunctionBundleEvidence,
  validateManifest,
} from "./check-supabase-retirement-manifest.mjs";
import {
  CAPTURE_TOOL_VERSION,
  EXPECTED_ACTIVE_FUNCTIONS,
  EXPECTED_PROJECT_REF,
} from "./capture-supabase-current-function-bundles.mjs";

export const DEFAULT_REPORT_PATH = path.join(
  "tmp",
  "ci",
  "supabase-current-function-bundles-report.json"
);

const CANONICAL_RETIREMENT_MANIFEST_ID = "hushh-tech-no-hybrid-supabase-retirement";
const CANONICAL_HISTORICAL_EVIDENCE_ID = "hushh-tech-supabase-live-function-bundles";
const CANONICAL_MANIFEST_FILE_DIGEST =
  "038e2221e48321b8c28f3df104093d28d3c44b18cfb9b3918c8ea0e73aaa1b85";
const COMPOSED_TRAFFIC_MANIFEST_FILE_DIGEST =
  "2b288311ea816a39e512977de8f3161d9192113ce308e757e41540fae136d4b2";
const CANONICAL_HISTORICAL_EVIDENCE_FILE_DIGEST =
  "3ae1b5b8225347cee63cb8e42fdfe744e8f905ee7b3a9d2c4eccee3ae2c81bd4";
const CANONICAL_RETIREMENT_CHECKER_FILE_DIGEST =
  "11c22b12cfe0a8d2f994181558b633cf6e526b315a8137d42b52223a8010ea6d";
const COMPOSED_TRAFFIC_RETIREMENT_CHECKER_FILE_DIGEST =
  "a5093c0119bee4826bffe4cceeb380e2745a698152289c931ab21381588f6c35";
const CANONICAL_HISTORICAL_GENERATOR_FILE_DIGEST =
  "35eb33b00a1dd79ef8da6ee35cd5480123dc037c1c444e47e4eb78f54a07ac43";

const COMPOSED_MANIFEST_FILE_DIGESTS = new Set([
  CANONICAL_MANIFEST_FILE_DIGEST,
  COMPOSED_TRAFFIC_MANIFEST_FILE_DIGEST,
]);
const COMPOSED_RETIREMENT_CHECKER_FILE_DIGESTS = new Set([
  CANONICAL_RETIREMENT_CHECKER_FILE_DIGEST,
  COMPOSED_TRAFFIC_RETIREMENT_CHECKER_FILE_DIGEST,
]);

export const CURRENT_EVIDENCE_LOCK = Object.freeze({
  manifest_file_digest: CANONICAL_MANIFEST_FILE_DIGEST,
  historical_evidence_file_digest: CANONICAL_HISTORICAL_EVIDENCE_FILE_DIGEST,
  canonical_retirement_checker_file_digest: CANONICAL_RETIREMENT_CHECKER_FILE_DIGEST,
  historical_bundle_generator_file_digest: CANONICAL_HISTORICAL_GENERATOR_FILE_DIGEST,
  capture_started_at_utc: "2026-08-21T17:52:04.388Z",
  capture_completed_at_utc: "2026-08-21T18:03:38.344Z",
  gitleaks_config_digest: "7c8ffd31ad658569431be0f53001afc4eb96219d1324371600fe6857ae1811bf",
  recovery_snapshot_digest: "b5621ff988f457f0226748da65770f21c1901a7b9c881f973476832722bbf3c4",
  recovery_file_count: 945,
  recovery_directory_count: 602,
  recovery_total_bytes: 2_968_118,
  version_exact: 16,
  version_drifted: 96,
  version_uniform_drift_delta: 43,
  version_uniform_drift_count: 96,
  provider_bundle_digests_present: 66,
  provider_bundle_digests_missing: 46,
  extracted_bundles: 96,
  store_not_found: 0,
  bundle_retrieval_failed: 16,
  capture_attempts_total: 144,
  extracted_on_first_attempt: 96,
  terminal_failures_after_max_attempts: 16,
  extracted_files: 445,
  extracted_bytes: 2_842_656,
  current_metadata_digest: "b15f57a658b2ae2a1e8399551ae9af92db1a652ade7401ad08b1a148567c798b",
  canonical_source_tree_digest: "2f203e524b8749272f49ae9c4051fefe73e7a877458ac34c2a3cf7b9c322b7d0",
  evidence_digest: "abce166ff5f1af61b1ff7fa8f3839b21ff55d8a255efdf520fd724cfa8bba219",
});

const TOP_LEVEL_KEYS = [
  "schema_version",
  "evidence_id",
  "canonicalization",
  "capture",
  "capture_integrity",
  "historical_binding",
  "sanitization",
  "source_secret_scan",
  "cutover_assessment",
  "historical_comparison",
  "observed_counts",
  "current_metadata_digest",
  "canonical_source_tree",
  "entries",
  "evidence_digest",
];
const ENTRY_COMMON_KEYS = [
  "slug",
  "function_id",
  "status",
  "current_version",
  "manifest_version",
  "version_delta",
  "verify_jwt",
  "provider_bundle_digest",
  "historical_capture_status",
  "capture_status",
  "capture_attempts",
];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const requireExactKeys = (errors, label, value, keys) => {
  if (!isObject(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (!sameJson(actual, expected)) {
    errors.push(`${label} keys must be exactly ${expected.join(", ")}; found ${actual.join(", ")}.`);
  }
};

const requireRecord = (errors, label, actual, expected) => {
  requireExactKeys(errors, label, actual, Object.keys(expected));
  if (!isObject(actual)) return;
  for (const [key, value] of Object.entries(expected)) {
    if (!sameJson(actual[key], value)) errors.push(`${label}.${key} changed.`);
  }
};

const countBy = (entries, predicate) => entries.filter(predicate).length;

const safeDigest = (errors, label, callback) => {
  try {
    return callback();
  } catch (error) {
    errors.push(`${label} could not be recomputed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

const composeCanonicalRetirementValidation = ({
  errors,
  manifest,
  historicalEvidence,
  manifestBytes,
  historicalEvidenceBytes,
  canonicalCheckerBytes,
  historicalGeneratorBytes,
}) => {
  if (!manifestBytes || !COMPOSED_MANIFEST_FILE_DIGESTS.has(sha256(manifestBytes))) {
    errors.push("Retirement manifest file digest changed from the canonical lock.");
  }
  if (!historicalEvidenceBytes || sha256(historicalEvidenceBytes) !== CANONICAL_HISTORICAL_EVIDENCE_FILE_DIGEST) {
    errors.push("Historical v1 bundle evidence file digest changed from the canonical lock.");
  }
  if (
    !canonicalCheckerBytes ||
    !COMPOSED_RETIREMENT_CHECKER_FILE_DIGESTS.has(sha256(canonicalCheckerBytes))
  ) {
    errors.push("Canonical retirement validator file digest changed from the composed lock.");
  }
  if (!historicalGeneratorBytes || sha256(historicalGeneratorBytes) !== CANONICAL_HISTORICAL_GENERATOR_FILE_DIGEST) {
    errors.push("Historical bundle digest generator file changed from the composed lock.");
  }
  if (manifest?.manifest_id !== CANONICAL_RETIREMENT_MANIFEST_ID) {
    errors.push("Retirement manifest_id changed from the canonical identity.");
  }
  if (historicalEvidence?.evidence_id !== CANONICAL_HISTORICAL_EVIDENCE_ID) {
    errors.push("Historical bundle evidence_id changed from the canonical identity.");
  }

  const manifestResult = validateManifest(manifest);
  for (const error of manifestResult.errors) errors.push(`Canonical retirement manifest: ${error}`);
  const historicalResult = validateLiveFunctionBundleEvidence(manifest, historicalEvidence);
  for (const error of historicalResult.errors) errors.push(`Canonical historical bundle evidence: ${error}`);
};

export const validateCurrentFunctionBundleEvidence = ({
  manifest,
  historicalEvidence,
  evidence,
  manifestBytes,
  historicalEvidenceBytes,
  canonicalCheckerBytes,
  historicalGeneratorBytes,
}) => {
  const errors = [];
  composeCanonicalRetirementValidation({
    errors,
    manifest,
    historicalEvidence,
    manifestBytes,
    historicalEvidenceBytes,
    canonicalCheckerBytes,
    historicalGeneratorBytes,
  });
  if (!isObject(evidence)) {
    return { valid: false, errors: [...errors, "Current function bundle evidence must be an object."], observed: {} };
  }

  requireExactKeys(errors, "Current function bundle evidence", evidence, TOP_LEVEL_KEYS);
  if (evidence.schema_version !== 2) errors.push("Current function bundle evidence schema_version must be 2.");
  if (evidence.evidence_id !== "hushh-tech-supabase-current-live-function-bundles") {
    errors.push("Current function bundle evidence_id is invalid.");
  }

  requireRecord(errors, "Current function canonicalization", evidence.canonicalization, {
    version: 2,
    record_encoding: CANONICAL_RECORD_ENCODING,
    string_contract: "UTF8_NFC_NO_C0_C1_OR_DEL_CONTROL_CHARACTERS",
    recovery_snapshot_contract:
      "SINGLE_OPEN_O_NOFOLLOW_REGULAR_NLINK1_CURRENT_OWNER_SAFE_MODE_STABLE_FSTAT_IMMUTABLE_PRIVATE_COPY_V2",
  });
  requireRecord(errors, "Current function capture", evidence.capture, {
    project_ref: EXPECTED_PROJECT_REF,
    capture_started_at_utc: CURRENT_EVIDENCE_LOCK.capture_started_at_utc,
    capture_completed_at_utc: CURRENT_EVIDENCE_LOCK.capture_completed_at_utc,
    metadata_surface: "GET /v1/projects/{ref}/functions via supabase_cli",
    bundle_surface: "GET /v1/projects/{ref}/functions/{slug}/body via supabase_cli_download_use_api",
    tool: "supabase_cli",
    tool_version: CAPTURE_TOOL_VERSION,
    source_write_mode: "READ_ONLY_NO_DEPLOYMENT",
  });
  requireRecord(errors, "Current function capture integrity", evidence.capture_integrity, {
    recovery_snapshot_digest_algorithm: RECOVERY_SNAPSHOT_DIGEST_ALGORITHM,
    recovery_snapshot_digest: CURRENT_EVIDENCE_LOCK.recovery_snapshot_digest,
    recovery_file_count: CURRENT_EVIDENCE_LOCK.recovery_file_count,
    recovery_directory_count: CURRENT_EVIDENCE_LOCK.recovery_directory_count,
    recovery_total_bytes: CURRENT_EVIDENCE_LOCK.recovery_total_bytes,
    accounting_status: "EXACT_NO_UNACCOUNTED_FILES_OR_DIRECTORIES",
  });

  const expectedHistoricalBinding = {
    manifest_id: CANONICAL_RETIREMENT_MANIFEST_ID,
    manifest_schema_version: 1,
    manifest_file_digest: CANONICAL_MANIFEST_FILE_DIGEST,
    manifest_active_functions_digest: manifest?.inventory_digests?.active_functions,
    historical_evidence_id: CANONICAL_HISTORICAL_EVIDENCE_ID,
    historical_evidence_schema_version: 1,
    historical_evidence_file_digest: CANONICAL_HISTORICAL_EVIDENCE_FILE_DIGEST,
    historical_entry_digest: historicalEvidence?.evidence_digest?.digest,
    historical_source_tree_digest_algorithm:
      historicalEvidence?.canonical_source_tree?.digest_algorithm,
    historical_source_tree_digest: historicalEvidence?.canonical_source_tree?.digest,
  };
  requireRecord(errors, "Current function historical binding", evidence.historical_binding, expectedHistoricalBinding);

  requireRecord(errors, "Current function sanitization", evidence.sanitization, {
    recovered_source_content_committed: false,
    raw_cli_output_committed: false,
    secret_or_token_values_committed: false,
    temporary_absolute_paths_committed: false,
    public_evidence: "current_metadata_safe_digests_file_counts_byte_counts_and_retry_classes_only",
  });
  requireRecord(errors, "Current function source secret scan", evidence.source_secret_scan, {
    tool: "gitleaks",
    tool_version: "8.24.2",
    config_digest: CURRENT_EVIDENCE_LOCK.gitleaks_config_digest,
    status: "PASS",
    finding_count: 0,
  });
  requireRecord(errors, "Current function cutover assessment", evidence.cutover_assessment, {
    status: "CUTOVER_BLOCKING_VERSION_DRIFT",
    frozen_snapshot_uniform_version_delta: CURRENT_EVIDENCE_LOCK.version_uniform_drift_delta,
    required_next_capture: "FREEZE_EDGE_FUNCTION_DEPLOYMENTS_THEN_REPEAT_FULL_READ_ONLY_112_FUNCTION_CAPTURE",
    metadata_end_check_status: "NOT_PERFORMED_IN_V2_BLOCKING",
    bundle_to_metadata_version_binding_status: "NOT_PROVEN_WITHOUT_END_METADATA_CHECK",
    source_revision_status: "NOT_PROVEN",
    source_revision: null,
    source_revision_reason: "SUPPORTED_LIST_AND_BODY_METADATA_DO_NOT_EXPOSE_A_DEPLOY_RUN_OR_GIT_SHA",
  });

  const historicalExpectedCounts = historicalEvidence?.expected_counts || {};
  requireRecord(errors, "Current function historical comparison", evidence.historical_comparison, {
    comparison_basis: "SAFE_DIGESTS_AND_COUNTS_ONLY",
    content_equivalence_status: "NOT_ASSERTED_BETWEEN_V1_AND_V2_CANONICALIZATION",
    historical_extracted_bundles: historicalExpectedCounts.extracted_bundles,
    historical_extracted_files: historicalExpectedCounts.extracted_files,
    historical_extracted_bytes: historicalExpectedCounts.extracted_bytes,
    historical_source_tree_digest_algorithm: historicalEvidence?.canonical_source_tree?.digest_algorithm,
    historical_source_tree_digest: historicalEvidence?.canonical_source_tree?.digest,
    current_extracted_bundles: CURRENT_EVIDENCE_LOCK.extracted_bundles,
    current_extracted_files: CURRENT_EVIDENCE_LOCK.extracted_files,
    current_extracted_bytes: CURRENT_EVIDENCE_LOCK.extracted_bytes,
    current_source_tree_digest_algorithm: CURRENT_SOURCE_TREE_DIGEST_ALGORITHM,
    current_source_tree_digest: CURRENT_EVIDENCE_LOCK.canonical_source_tree_digest,
  });

  const entries = Array.isArray(evidence.entries) ? evidence.entries : [];
  if (!Array.isArray(evidence.entries)) errors.push("Current function entries must be an array.");
  if (entries.length !== EXPECTED_ACTIVE_FUNCTIONS) {
    errors.push(`Current function entries must be ${EXPECTED_ACTIVE_FUNCTIONS}; found ${entries.length}.`);
  }
  const slugs = entries.filter(isObject).map((entry) => entry.slug);
  if (!sameJson(slugs, [...slugs].sort(compareUtf8))) errors.push("Current function entries must stay UTF-8 sorted.");
  if (new Set(slugs).size !== slugs.length) errors.push("Current function entries contain duplicate slugs.");

  const manifestBySlug = new Map(
    (Array.isArray(manifest?.functions) ? manifest.functions : []).map((entry) => [entry.source?.slug, entry])
  );
  const historicalBySlug = new Map(
    (Array.isArray(historicalEvidence?.entries) ? historicalEvidence.entries : []).map((entry) => [entry.slug, entry])
  );
  let extractedFiles = 0;
  let extractedBytes = 0;
  for (const [index, entry] of entries.entries()) {
    if (!isObject(entry)) {
      errors.push(`Current function entries[${index}] must be an object.`);
      continue;
    }
    const manifestEntry = manifestBySlug.get(entry.slug);
    const historicalEntry = historicalBySlug.get(entry.slug);
    if (!manifestEntry) errors.push(`Current evidence contains unknown function ${entry.slug}.`);
    if (!historicalEntry) errors.push(`Current evidence lacks historical binding for ${entry.slug}.`);
    if (manifestEntry) {
      const source = manifestEntry.source;
      if (entry.function_id !== source.function_id) errors.push(`${entry.slug}.function_id changed.`);
      if (entry.status !== "ACTIVE") errors.push(`${entry.slug}.status must be ACTIVE.`);
      if (entry.manifest_version !== source.version) errors.push(`${entry.slug}.manifest_version changed.`);
      if (entry.verify_jwt !== source.verify_jwt) errors.push(`${entry.slug}.verify_jwt changed.`);
      if (!Number.isSafeInteger(entry.current_version) || entry.current_version < source.version) {
        errors.push(`${entry.slug}.current_version is invalid.`);
      }
      if (entry.version_delta !== entry.current_version - source.version) {
        errors.push(`${entry.slug}.version_delta does not match current and manifest versions.`);
      }
    }
    if (historicalEntry && entry.historical_capture_status !== historicalEntry.capture_status) {
      errors.push(`${entry.slug}.historical_capture_status changed.`);
    }
    if (entry.provider_bundle_digest !== null && !/^[a-f0-9]{64}$/.test(entry.provider_bundle_digest || "")) {
      errors.push(`${entry.slug}.provider_bundle_digest is invalid.`);
    }
    if (!Number.isInteger(entry.capture_attempts) || entry.capture_attempts < 1 || entry.capture_attempts > 3) {
      errors.push(`${entry.slug}.capture_attempts is invalid.`);
    }

    if (entry.capture_status === "EXTRACTED") {
      requireExactKeys(errors, `Current function entry ${entry.slug}`, entry, [...ENTRY_COMMON_KEYS, "bundle_evidence"]);
      requireRecord(errors, `Current function bundle ${entry.slug}`, entry.bundle_evidence, {
        digest_algorithm: BUNDLE_DIGEST_ALGORITHM,
        canonical_digest: entry.bundle_evidence?.canonical_digest,
        file_count: entry.bundle_evidence?.file_count,
        total_bytes: entry.bundle_evidence?.total_bytes,
      });
      if (!/^[a-f0-9]{64}$/.test(entry.bundle_evidence?.canonical_digest || "")) errors.push(`${entry.slug}.bundle_evidence canonical digest is invalid.`);
      if (!Number.isInteger(entry.bundle_evidence?.file_count) || entry.bundle_evidence.file_count < 1) errors.push(`${entry.slug}.bundle_evidence file count is invalid.`);
      if (!Number.isInteger(entry.bundle_evidence?.total_bytes) || entry.bundle_evidence.total_bytes < 1) errors.push(`${entry.slug}.bundle_evidence byte count is invalid.`);
      extractedFiles += Number(entry.bundle_evidence?.file_count || 0);
      extractedBytes += Number(entry.bundle_evidence?.total_bytes || 0);
    } else if (entry.capture_status === "STORE_NOT_FOUND" || entry.capture_status === "BUNDLE_RETRIEVAL_FAILED") {
      requireExactKeys(errors, `Current function entry ${entry.slug}`, entry, [...ENTRY_COMMON_KEYS, "retrieval_failure"]);
      const attemptClasses =
        entry.capture_status === "STORE_NOT_FOUND"
          ? ["STORE_NOT_FOUND"]
          : ["BUNDLE_RETRIEVAL_FAILED", "BUNDLE_RETRIEVAL_FAILED", "BUNDLE_RETRIEVAL_FAILED"];
      const expectedFailure =
        entry.capture_status === "STORE_NOT_FOUND"
          ? {
              http_status: 404,
              provider_error_code: "UnknownError",
              failure_class: "FUNCTION_STORE_NOT_FOUND",
              terminal_after_max_attempts: false,
              attempt_response_classes: attemptClasses,
              attempt_evidence_digest_algorithm: ATTEMPT_EVIDENCE_DIGEST_ALGORITHM,
              attempt_evidence_digest: digestAttemptEvidence(attemptClasses),
            }
          : {
              http_status: 500,
              provider_error_code: "FunctionsApiStatusError",
              failure_class: "FAILED_TO_RETRIEVE_FUNCTION_BUNDLE",
              terminal_after_max_attempts: true,
              attempt_response_classes: attemptClasses,
              attempt_evidence_digest_algorithm: ATTEMPT_EVIDENCE_DIGEST_ALGORITHM,
              attempt_evidence_digest: digestAttemptEvidence(attemptClasses),
            };
      requireRecord(errors, `Current function retrieval failure ${entry.slug}`, entry.retrieval_failure, expectedFailure);
    } else {
      requireExactKeys(errors, `Current function entry ${entry.slug}`, entry, ENTRY_COMMON_KEYS);
      errors.push(`${entry.slug}.capture_status is invalid.`);
    }
  }
  for (const slug of manifestBySlug.keys()) {
    if (!slugs.includes(slug)) errors.push(`Current evidence is missing manifest function ${slug}.`);
  }

  const observedDeltas = [...new Set(entries.map((entry) => entry?.version_delta).filter((delta) => Number.isInteger(delta) && delta !== 0))];
  const observedCounts = {
    active_functions: entries.length,
    version_exact: countBy(entries, (entry) => entry?.version_delta === 0),
    version_drifted: countBy(entries, (entry) => entry?.version_delta !== 0),
    version_uniform_drift_delta: observedDeltas.length === 1 ? observedDeltas[0] : null,
    version_uniform_drift_count: countBy(entries, (entry) => entry?.version_delta === CURRENT_EVIDENCE_LOCK.version_uniform_drift_delta),
    provider_bundle_digests_present: countBy(entries, (entry) => Boolean(entry?.provider_bundle_digest)),
    provider_bundle_digests_missing: countBy(entries, (entry) => !entry?.provider_bundle_digest),
    extracted_bundles: countBy(entries, (entry) => entry?.capture_status === "EXTRACTED"),
    store_not_found: countBy(entries, (entry) => entry?.capture_status === "STORE_NOT_FOUND"),
    bundle_retrieval_failed: countBy(entries, (entry) => entry?.capture_status === "BUNDLE_RETRIEVAL_FAILED"),
    capture_attempts_total: entries.reduce((sum, entry) => sum + Number(entry?.capture_attempts || 0), 0),
    extracted_on_first_attempt: countBy(entries, (entry) => entry?.capture_status === "EXTRACTED" && entry?.capture_attempts === 1),
    terminal_failures_after_max_attempts: countBy(entries, (entry) => entry?.capture_status === "BUNDLE_RETRIEVAL_FAILED" && entry?.capture_attempts === 3),
    extracted_files: extractedFiles,
    extracted_bytes: extractedBytes,
  };
  const expectedCounts = {
    active_functions: EXPECTED_ACTIVE_FUNCTIONS,
    version_exact: CURRENT_EVIDENCE_LOCK.version_exact,
    version_drifted: CURRENT_EVIDENCE_LOCK.version_drifted,
    version_uniform_drift_delta: CURRENT_EVIDENCE_LOCK.version_uniform_drift_delta,
    version_uniform_drift_count: CURRENT_EVIDENCE_LOCK.version_uniform_drift_count,
    provider_bundle_digests_present: CURRENT_EVIDENCE_LOCK.provider_bundle_digests_present,
    provider_bundle_digests_missing: CURRENT_EVIDENCE_LOCK.provider_bundle_digests_missing,
    extracted_bundles: CURRENT_EVIDENCE_LOCK.extracted_bundles,
    store_not_found: CURRENT_EVIDENCE_LOCK.store_not_found,
    bundle_retrieval_failed: CURRENT_EVIDENCE_LOCK.bundle_retrieval_failed,
    capture_attempts_total: CURRENT_EVIDENCE_LOCK.capture_attempts_total,
    extracted_on_first_attempt: CURRENT_EVIDENCE_LOCK.extracted_on_first_attempt,
    terminal_failures_after_max_attempts: CURRENT_EVIDENCE_LOCK.terminal_failures_after_max_attempts,
    extracted_files: CURRENT_EVIDENCE_LOCK.extracted_files,
    extracted_bytes: CURRENT_EVIDENCE_LOCK.extracted_bytes,
  };
  requireRecord(errors, "Current function observed counts", evidence.observed_counts, expectedCounts);
  if (!sameJson(observedCounts, expectedCounts)) errors.push("Current function observed entry counts do not match the locked capture.");

  const observedMetadataDigest = safeDigest(errors, "Current function metadata digest", () => digestCurrentMetadata(entries));
  requireRecord(errors, "Current function metadata digest", evidence.current_metadata_digest, {
    digest_algorithm: METADATA_DIGEST_ALGORITHM,
    digest: CURRENT_EVIDENCE_LOCK.current_metadata_digest,
  });
  if (observedMetadataDigest !== CURRENT_EVIDENCE_LOCK.current_metadata_digest) errors.push("Current function metadata entry digest changed from the lock.");
  if (evidence.current_metadata_digest?.digest !== observedMetadataDigest) errors.push("Current function metadata digest does not match its entries.");

  const observedSourceTreeDigest = safeDigest(errors, "Current function source-tree digest", () => digestCurrentSourceTree(entries));
  requireRecord(errors, "Current function canonical source tree", evidence.canonical_source_tree, {
    digest_algorithm: CURRENT_SOURCE_TREE_DIGEST_ALGORITHM,
    digest: CURRENT_EVIDENCE_LOCK.canonical_source_tree_digest,
  });
  if (observedSourceTreeDigest !== CURRENT_EVIDENCE_LOCK.canonical_source_tree_digest) errors.push("Current function source-tree digest changed from the lock.");
  if (evidence.canonical_source_tree?.digest !== observedSourceTreeDigest) errors.push("Current function source-tree digest does not match its entries.");

  const observedEvidenceDigest = safeDigest(errors, "Current function canonical evidence digest", () => digestCurrentEvidence(evidence));
  requireRecord(errors, "Current function evidence digest", evidence.evidence_digest, {
    digest_algorithm: EVIDENCE_DIGEST_ALGORITHM,
    digest: CURRENT_EVIDENCE_LOCK.evidence_digest,
  });
  if (observedEvidenceDigest !== CURRENT_EVIDENCE_LOCK.evidence_digest) errors.push("Current function canonical evidence digest changed from the lock.");
  if (evidence.evidence_digest?.digest !== observedEvidenceDigest) errors.push("Current function evidence digest does not match the artifact.");

  const getSecrets = entries.find((entry) => entry?.slug === "get-secrets");
  const manifestGetSecrets = manifestBySlug.get("get-secrets");
  if (
    getSecrets?.historical_capture_status !== "STORE_NOT_FOUND" ||
    getSecrets?.capture_status !== "BUNDLE_RETRIEVAL_FAILED" ||
    manifestGetSecrets?.final_disposition !== "RETIRE_WITH_410" ||
    manifestGetSecrets?.migration_state === "PORTED_AND_VERIFIED"
  ) {
    errors.push("get-secrets must remain unavailable and retired with 410, never ported.");
  }

  return {
    valid: errors.length === 0,
    errors,
    observed: {
      ...observedCounts,
      recovery_snapshot_digest: evidence.capture_integrity?.recovery_snapshot_digest ?? null,
      current_metadata_digest: observedMetadataDigest,
      canonical_source_tree_digest: observedSourceTreeDigest,
      evidence_digest: observedEvidenceDigest,
    },
  };
};

export const assertApprovedReportPath = (reportPath) => {
  const absolute = path.resolve(reportPath);
  const approved = path.resolve(DEFAULT_REPORT_PATH);
  const approvedParent = path.dirname(approved);
  if (absolute !== approved || path.dirname(absolute) !== approvedParent) {
    throw new Error(`Report path must be the exact approved direct child ${DEFAULT_REPORT_PATH}.`);
  }
  const parentStat = fs.lstatSync(approvedParent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== process.getuid() ||
    (parentStat.mode & 0o7022) !== 0 ||
    fs.realpathSync(approvedParent) !== approvedParent
  ) {
    throw new Error("Approved report directory is missing or untrusted.");
  }
  if (fs.lstatSync(absolute, { throwIfNoEntry: false })) {
    throw new Error("Current function bundle report is create-only and must not be overwritten.");
  }
  return absolute;
};

export const writeApprovedReport = ({ reportPath = DEFAULT_REPORT_PATH, result }) => {
  const absolute = assertApprovedReportPath(reportPath);
  const descriptor = fs.openSync(
    absolute,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("Created report file did not preserve the required private mode.");
    }
    fs.writeFileSync(descriptor, JSON.stringify(result, null, 2) + "\n");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const parseArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const manifestPath = parseArg("--manifest") || DEFAULT_MANIFEST_PATH;
  const historicalEvidencePath = parseArg("--historical-evidence") || DEFAULT_HISTORICAL_EVIDENCE_PATH;
  const currentEvidencePath = parseArg("--evidence") || DEFAULT_CURRENT_EVIDENCE_PATH;
  const reportPath = parseArg("--report") || DEFAULT_REPORT_PATH;
  let result;
  try {
    const manifestBytes = fs.readFileSync(path.resolve(manifestPath));
    const historicalEvidenceBytes = fs.readFileSync(path.resolve(historicalEvidencePath));
    const canonicalCheckerBytes = fs.readFileSync(
      path.resolve("scripts/ci/check-supabase-retirement-manifest.mjs")
    );
    const historicalGeneratorBytes = fs.readFileSync(
      path.resolve("scripts/ci/generate-supabase-live-function-bundle-evidence.mjs")
    );
    result = validateCurrentFunctionBundleEvidence({
      manifest: JSON.parse(manifestBytes.toString("utf8")),
      historicalEvidence: JSON.parse(historicalEvidenceBytes.toString("utf8")),
      evidence: JSON.parse(fs.readFileSync(path.resolve(currentEvidencePath), "utf8")),
      manifestBytes,
      historicalEvidenceBytes,
      canonicalCheckerBytes,
      historicalGeneratorBytes,
    });
  } catch (error) {
    result = {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      observed: {},
    };
  }
  writeApprovedReport({ reportPath, result });
  console.log(JSON.stringify(result.observed, null, 2));
  if (!result.valid) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
}
