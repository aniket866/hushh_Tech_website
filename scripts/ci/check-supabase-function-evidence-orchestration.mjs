import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateLiveFunctionBundleEvidence,
  validateManifest,
} from "./check-supabase-retirement-manifest.mjs";
import { validateFunctionTrafficEvidence } from "./check-supabase-function-traffic-evidence.mjs";
import { validateCurrentFunctionBundleEvidence } from "./check-supabase-current-function-bundle-evidence.mjs";
import { digestBundleEvidenceEntries } from "./generate-supabase-live-function-bundle-evidence.mjs";
import {
  digestTrafficEvidence,
  stableJson as stableTrafficJson,
} from "./generate-supabase-function-traffic-evidence.mjs";
import {
  digestCurrentEvidence,
  digestCurrentMetadata,
  digestCurrentSourceTree,
} from "./generate-supabase-current-function-bundle-evidence.mjs";

export const DEFAULT_ORCHESTRATION_EVIDENCE_PATH = path.join(
  "migration",
  "evidence",
  "supabase-function-evidence-orchestration.v1.json"
);

export const FROZEN_ORCHESTRATION_EVIDENCE_DIGEST =
  "e27264e79bddd826c7085b5f3b3ad3e2eba322212691985fd14109d8d383acce";

export const ARTIFACT_PATHS = Object.freeze({
  retirement_manifest: "migration/manifests/supabase-retirement.v1.json",
  historical_bundle_evidence: "migration/evidence/supabase-live-function-bundles.v1.json",
  traffic_evidence: "migration/evidence/supabase-function-traffic-30d.v1.json",
  current_bundle_evidence: "migration/evidence/supabase-current-live-function-bundles.v2.json",
});

export const VALIDATOR_PATHS = Object.freeze({
  retirement_validator: "scripts/ci/check-supabase-retirement-manifest.mjs",
  historical_bundle_generator:
    "scripts/ci/generate-supabase-live-function-bundle-evidence.mjs",
  traffic_validator: "scripts/ci/check-supabase-function-traffic-evidence.mjs",
  traffic_generator: "scripts/ci/generate-supabase-function-traffic-evidence.mjs",
  current_bundle_capture: "scripts/ci/capture-supabase-current-function-bundles.mjs",
  current_bundle_validator:
    "scripts/ci/check-supabase-current-function-bundle-evidence.mjs",
  current_bundle_generator:
    "scripts/ci/generate-supabase-current-function-bundle-evidence.mjs",
});

const MAX_BOUND_FILE_BYTES = 16 * 1024 * 1024;
const DIGEST_ALGORITHM = "sha256_of_sorted_utf8_length_prefixed_records_v1";
const STACK_BINDINGS = Object.freeze({
  retirement_base_commit: "06f55286edadce331445debceafcff0cc3342f72",
  traffic_evidence_head_commit: "91b70d27c69d939b7e132655b440dd11e144a2ea",
  current_bundle_head_commit: "2ba71a5d823aa8dce0d51381b5cfef1d08896975",
});
const TOP_LEVEL_KEYS = [
  "capture_bindings",
  "cutover_blockers",
  "evidence_digest",
  "evidence_id",
  "inventory_binding",
  "schema_version",
  "semantic_digest_bindings",
  "snapshot_comparison",
  "source_write_mode",
  "stack_bindings",
  "upstream_file_bindings",
  "upstream_validator_bindings",
];

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareUtf8)
      .map((key) => [key, stableValue(value[key])])
  );
};

export const stableJson = (value) => JSON.stringify(stableValue(value));
const sameJson = (left, right) => stableJson(left) === stableJson(right);

export const digestOrchestrationEvidence = (evidence) => {
  const candidate = structuredClone(evidence);
  delete candidate.evidence_digest;
  return sha256(stableJson(candidate));
};

const encodeCanonicalField = (value) => {
  const bytes = Buffer.from(String(value).normalize("NFC"), "utf8");
  return Buffer.concat([Buffer.from(`${bytes.length}:`, "ascii"), bytes]);
};

const encodeCanonicalRecord = (fields) =>
  Buffer.concat(fields.map((field) => encodeCanonicalField(field)));

export const digestCanonicalRecords = (records) => {
  const encoded = records.map(encodeCanonicalRecord).sort(Buffer.compare);
  return sha256(
    Buffer.concat(
      encoded.flatMap((record) => [
        Buffer.from(`${record.length}:`, "ascii"),
        record,
      ])
    )
  );
};

const requireExactKeys = (errors, label, value, expectedKeys) => {
  if (!isObject(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...expectedKeys].sort(compareUtf8);
  if (!sameJson(actual, expected)) {
    errors.push(`${label} contains a missing or non-allowlisted field.`);
    return false;
  }
  return true;
};

const requireRecord = (errors, label, actual, expected) => {
  if (!requireExactKeys(errors, label, actual, Object.keys(expected))) return;
  if (!sameJson(actual, expected)) errors.push(`${label} does not match the bound snapshot.`);
};

const prefixErrors = (errors, label, result) => {
  for (const error of result.errors || []) errors.push(`${label}: ${error}`);
};

const parseJson = (errors, label, bytes) => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    errors.push(`${label} is not valid JSON.`);
    return null;
  }
};

const readBoundRegularFile = (root, relativePath) => {
  const realRoot = fs.realpathSync(root);
  const absolute = path.resolve(realRoot, relativePath);
  if (absolute !== realRoot && !absolute.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Bound path escapes the repository root: ${relativePath}.`);
  }
  const stat = fs.lstatSync(absolute);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > MAX_BOUND_FILE_BYTES ||
    fs.realpathSync(absolute) !== absolute
  ) {
    throw new Error(`Bound path is not an approved regular file: ${relativePath}.`);
  }
  return fs.readFileSync(absolute);
};

export const readFunctionEvidenceOrchestrationInputs = ({ root = process.cwd() } = {}) => ({
  contractBytes: readBoundRegularFile(root, DEFAULT_ORCHESTRATION_EVIDENCE_PATH),
  artifacts: Object.fromEntries(
    Object.entries(ARTIFACT_PATHS).map(([key, relativePath]) => [
      key,
      readBoundRegularFile(root, relativePath),
    ])
  ),
  validators: Object.fromEntries(
    Object.entries(VALIDATOR_PATHS).map(([key, relativePath]) => [
      key,
      readBoundRegularFile(root, relativePath),
    ])
  ),
});

const validateFileBindings = ({ errors, label, bindings, expectedPaths, files }) => {
  if (!requireExactKeys(errors, label, bindings, Object.keys(expectedPaths))) return;
  for (const [key, expectedPath] of Object.entries(expectedPaths)) {
    const binding = bindings[key];
    requireExactKeys(errors, `${label}.${key}`, binding, ["path", "sha256"]);
    if (binding?.path !== expectedPath) errors.push(`${label}.${key}.path changed.`);
    if (!Buffer.isBuffer(files?.[key])) {
      errors.push(`${label}.${key} bytes are missing.`);
      continue;
    }
    if (binding?.sha256 !== sha256(files[key])) {
      errors.push(`${label}.${key} digest does not match the exact upstream file.`);
    }
  }
};

const countHistogram = (values) => {
  const histogram = {};
  for (const value of values) histogram[String(value)] = (histogram[String(value)] || 0) + 1;
  return Object.fromEntries(
    Object.entries(histogram).sort(([left], [right]) => Number(left) - Number(right))
  );
};

const stableSortedSlugs = (entries, predicate) =>
  entries.filter(predicate).map((entry) => entry.slug).sort(compareUtf8);

const digestSlugSet = (slugs) => digestCanonicalRecords(slugs.map((slug) => [slug]));

const validateTimestampBindings = ({ errors, contract, traffic, current }) => {
  const expected = {
    traffic_window_start_utc: traffic.capture?.window_start_utc,
    traffic_window_end_utc: traffic.capture?.window_end_utc,
    traffic_deployment_observed_at_utc:
      traffic.deployment_capture?.observed_at_utc_bucket,
    traffic_captured_at_utc: traffic.capture?.captured_at_utc,
    current_bundle_capture_started_at_utc: current.capture?.capture_started_at_utc,
    current_bundle_capture_completed_at_utc:
      current.capture?.capture_completed_at_utc,
    ordering_contract:
      "TRAFFIC_WINDOW_END_EQ_DEPLOYMENT_OBSERVED_LT_TRAFFIC_CAPTURE_LT_CURRENT_START_LT_CURRENT_END",
  };
  requireRecord(errors, "capture_bindings", contract.capture_bindings, expected);

  const parsed = Object.fromEntries(
    Object.entries(expected)
      .filter(([key]) => key !== "ordering_contract")
      .map(([key, value]) => [key, Date.parse(value)])
  );
  if (Object.values(parsed).some((value) => !Number.isFinite(value))) {
    errors.push("Capture bindings contain an invalid timestamp.");
    return false;
  }
  const orderValid =
    parsed.traffic_window_start_utc < parsed.traffic_window_end_utc &&
    parsed.traffic_window_end_utc === parsed.traffic_deployment_observed_at_utc &&
    parsed.traffic_deployment_observed_at_utc < parsed.traffic_captured_at_utc &&
    parsed.traffic_captured_at_utc < parsed.current_bundle_capture_started_at_utc &&
    parsed.current_bundle_capture_started_at_utc <
      parsed.current_bundle_capture_completed_at_utc;
  if (!orderValid) {
    errors.push(
      "Frozen capture order must be window end = deployment observation < traffic capture < current capture start < current capture end."
    );
  }
  return orderValid;
};

export const validateFunctionEvidenceOrchestration = ({
  contractBytes,
  artifacts,
  validators,
}) => {
  const errors = [];
  if (!Buffer.isBuffer(contractBytes)) {
    return { valid: false, errors: ["Orchestration contract bytes are missing."], observed: {} };
  }
  const contract = parseJson(errors, "Orchestration contract", contractBytes);
  const manifest = parseJson(
    errors,
    "Retirement manifest",
    artifacts?.retirement_manifest || Buffer.alloc(0)
  );
  const historical = parseJson(
    errors,
    "Historical bundle evidence",
    artifacts?.historical_bundle_evidence || Buffer.alloc(0)
  );
  const traffic = parseJson(
    errors,
    "Traffic evidence",
    artifacts?.traffic_evidence || Buffer.alloc(0)
  );
  const current = parseJson(
    errors,
    "Current bundle evidence",
    artifacts?.current_bundle_evidence || Buffer.alloc(0)
  );
  if (![contract, manifest, historical, traffic, current].every(isObject)) {
    return { valid: false, errors, observed: {} };
  }

  requireExactKeys(errors, "Orchestration contract", contract, TOP_LEVEL_KEYS);
  if (contract.schema_version !== 1) errors.push("Orchestration schema_version must be 1.");
  if (contract.evidence_id !== "hushh-tech-supabase-function-evidence-orchestration") {
    errors.push("Orchestration evidence_id is invalid.");
  }
  if (contract.source_write_mode !== "LOCAL_HASH_ONLY_NO_LIVE_IO") {
    errors.push("Orchestration must remain local hash-only with no live I/O.");
  }
  requireRecord(errors, "stack_bindings", contract.stack_bindings, STACK_BINDINGS);

  requireExactKeys(errors, "evidence_digest", contract.evidence_digest, [
    "digest",
    "digest_algorithm",
  ]);
  const observedContractDigest = digestOrchestrationEvidence(contract);
  if (
    contract.evidence_digest?.digest_algorithm !==
      "sha256_of_stable_json_without_evidence_digest_v1" ||
    contract.evidence_digest?.digest !== observedContractDigest
  ) {
    errors.push("Orchestration evidence digest does not match the contract.");
  }
  if (observedContractDigest !== FROZEN_ORCHESTRATION_EVIDENCE_DIGEST) {
    errors.push("Orchestration evidence changed from the frozen in-code lock.");
  }

  validateFileBindings({
    errors,
    label: "upstream_file_bindings",
    bindings: contract.upstream_file_bindings,
    expectedPaths: ARTIFACT_PATHS,
    files: artifacts,
  });
  validateFileBindings({
    errors,
    label: "upstream_validator_bindings",
    bindings: contract.upstream_validator_bindings,
    expectedPaths: VALIDATOR_PATHS,
    files: validators,
  });

  const manifestResult = validateManifest(manifest);
  const historicalResult = validateLiveFunctionBundleEvidence(manifest, historical);
  const trafficResult = validateFunctionTrafficEvidence(manifest, historical, traffic);
  const currentResult = validateCurrentFunctionBundleEvidence({
    manifest,
    historicalEvidence: historical,
    evidence: current,
    manifestBytes: artifacts.retirement_manifest,
    historicalEvidenceBytes: artifacts.historical_bundle_evidence,
    canonicalCheckerBytes: validators?.retirement_validator,
    historicalGeneratorBytes: validators?.historical_bundle_generator,
  });
  prefixErrors(errors, "Retirement manifest validator", manifestResult);
  prefixErrors(errors, "Historical bundle validator", historicalResult);
  prefixErrors(errors, "Traffic validator", trafficResult);
  prefixErrors(errors, "Current bundle validator", currentResult);

  const functions = asArray(manifest.functions);
  const trafficEntries = asArray(traffic.entries);
  const currentEntries = asArray(current.entries);
  const historicalEntries = asArray(historical.entries);
  const manifestSlugs = functions.map((entry) => entry.source?.slug).sort(compareUtf8);
  const trafficSlugs = trafficEntries.map((entry) => entry.slug).sort(compareUtf8);
  const currentSlugs = currentEntries.map((entry) => entry.slug).sort(compareUtf8);
  const historicalSlugs = historicalEntries.map((entry) => entry.slug).sort(compareUtf8);
  if (
    !sameJson(manifestSlugs, trafficSlugs) ||
    !sameJson(manifestSlugs, currentSlugs) ||
    !sameJson(manifestSlugs, historicalSlugs)
  ) {
    errors.push("The four bound artifacts do not contain the same 112 function slugs.");
  }

  const currentBySlug = new Map(currentEntries.map((entry) => [entry.slug, entry]));
  let identityAuthMismatch = false;
  for (const entry of functions) {
    const currentEntry = currentBySlug.get(entry.source?.slug);
    if (
      currentEntry?.function_id !== entry.source?.function_id ||
      currentEntry?.verify_jwt !== entry.source?.verify_jwt
    ) {
      identityAuthMismatch = true;
    }
  }
  if (identityAuthMismatch) {
    errors.push("Current metadata does not preserve all 112 function IDs and auth flags.");
  }

  const identityAuthDigest = digestCanonicalRecords(
    functions.map((entry) => [
      entry.source?.slug,
      entry.source?.function_id,
      String(entry.source?.verify_jwt),
    ])
  );
  const functionSlugSetDigest = digestSlugSet(manifestSlugs);
  const frozenFunctions = functions.filter(
    (entry) => entry.migration_state === "INVENTORY_FROZEN"
  ).length;
  const portedFunctions = functions.filter(
    (entry) => entry.migration_state === "PORTED_AND_VERIFIED"
  ).length;
  const verifyJwtTrue = functions.filter((entry) => entry.source?.verify_jwt === true).length;
  const verifyJwtFalse = functions.filter((entry) => entry.source?.verify_jwt === false).length;
  requireRecord(errors, "inventory_binding", contract.inventory_binding, {
    active_functions: functions.length,
    frozen_functions: frozenFunctions,
    ported_and_verified_functions: portedFunctions,
    verify_jwt_true: verifyJwtTrue,
    verify_jwt_false: verifyJwtFalse,
    digest_algorithm: DIGEST_ALGORITHM,
    function_slug_set_digest: functionSlugSetDigest,
    function_identity_auth_digest: identityAuthDigest,
  });
  if (
    functions.length !== 112 ||
    frozenFunctions !== 112 ||
    portedFunctions !== 0 ||
    manifest.contract_state !== "INVENTORY_FROZEN_NOT_MIGRATED"
  ) {
    errors.push("All 112 functions must remain frozen and unported.");
  }

  const captureOrderValid = validateTimestampBindings({ errors, contract, traffic, current });

  const trafficExact = stableSortedSlugs(
    trafficEntries,
    (entry) => entry.deployment_manifest_match_status === "EXACT_MANIFEST_MATCH"
  );
  const trafficDrift = stableSortedSlugs(
    trafficEntries,
    (entry) => entry.deployment_manifest_match_status === "CUTOVER_BLOCKING_VERSION_DRIFT"
  );
  const currentExact = stableSortedSlugs(currentEntries, (entry) => entry.version_delta === 0);
  const currentDrift = stableSortedSlugs(currentEntries, (entry) => entry.version_delta !== 0);
  const exactSetsMatch = sameJson(trafficExact, currentExact);
  const driftSetsMatch = sameJson(trafficDrift, currentDrift);
  if (!exactSetsMatch || !driftSetsMatch) {
    errors.push("The exact and drifted function sets changed between frozen snapshots.");
  }

  const trafficHistogram = traffic.deployment_capture?.version_delta_histogram;
  const currentHistogram = countHistogram(currentEntries.map((entry) => entry.version_delta));
  const trafficHistogramValid = sameJson(trafficHistogram, { 0: 16, 40: 96 });
  const currentHistogramValid = sameJson(currentHistogram, { 0: 16, 43: 96 });
  if (!trafficHistogramValid || !currentHistogramValid) {
    errors.push("Version histograms must remain +40 at traffic time and +43 at the later capture.");
  }

  const trafficStatusDigest = digestCanonicalRecords(
    trafficEntries.map((entry) => [
      entry.slug,
      entry.deployment_manifest_match_status,
      entry.source_reconstruction_status,
    ])
  );
  const currentVersionDigest = digestCanonicalRecords(
    currentEntries.map((entry) => [
      entry.slug,
      entry.function_id,
      String(entry.verify_jwt),
      String(entry.manifest_version),
      String(entry.current_version),
      String(entry.version_delta),
      entry.capture_status,
    ])
  );
  const snapshotComparison = contract.snapshot_comparison;
  requireExactKeys(errors, "snapshot_comparison", snapshotComparison, [
    "classification",
    "classification_basis",
    "continuity_scope",
    "current_bundle_snapshot",
    "deployment_cause_claim",
    "digest_algorithm",
    "shared_drift_function_count",
    "shared_drift_function_set_digest",
    "shared_exact_function_count",
    "shared_exact_function_set_digest",
    "source_revision_claim",
    "traffic_snapshot",
  ]);
  requireRecord(errors, "snapshot_comparison.traffic_snapshot", snapshotComparison?.traffic_snapshot, {
    version_delta_histogram: trafficHistogram,
    version_exact: trafficExact.length,
    version_drifted: trafficDrift.length,
    deployment_binding_digest: traffic.deployment_capture?.normalized_digest,
    deployment_updated_at_digest: traffic.deployment_capture?.updated_at_digest,
    entry_status_digest: trafficStatusDigest,
  });
  requireRecord(
    errors,
    "snapshot_comparison.current_bundle_snapshot",
    snapshotComparison?.current_bundle_snapshot,
    {
      version_delta_histogram: currentHistogram,
      version_exact: currentExact.length,
      version_drifted: currentDrift.length,
      current_metadata_digest: digestCurrentMetadata(currentEntries),
      current_source_tree_digest: digestCurrentSourceTree(currentEntries),
      entry_version_digest: currentVersionDigest,
    }
  );
  const classificationEligible =
    captureOrderValid &&
    trafficHistogramValid &&
    currentHistogramValid &&
    exactSetsMatch &&
    driftSetsMatch &&
    trafficDrift.length === 96 &&
    currentDrift.length === 96 &&
    traffic.deployment_capture?.source_write_mode === "READ_ONLY_NO_DEPLOYMENT" &&
    current.capture?.source_write_mode === "READ_ONLY_NO_DEPLOYMENT";
  if (
    snapshotComparison?.classification !==
      "CONTINUOUS_VERSION_DRIFT_OBSERVED_BETWEEN_FROZEN_CAPTURES" ||
    snapshotComparison?.classification_basis !==
      "TWO_EXACT_HASH_BOUND_READ_ONLY_METADATA_SNAPSHOTS_ONLY" ||
    snapshotComparison?.continuity_scope !==
      "SAME_96_FUNCTION_SET_DRIFTED_AT_BOTH_BOUND_SNAPSHOT_TIMESTAMPS_ONLY" ||
    snapshotComparison?.source_revision_claim !== null ||
    snapshotComparison?.deployment_cause_claim !== null ||
    snapshotComparison?.digest_algorithm !== DIGEST_ALGORITHM ||
    snapshotComparison?.shared_exact_function_count !== trafficExact.length ||
    snapshotComparison?.shared_exact_function_set_digest !== digestSlugSet(trafficExact) ||
    snapshotComparison?.shared_drift_function_count !== trafficDrift.length ||
    snapshotComparison?.shared_drift_function_set_digest !== digestSlugSet(trafficDrift)
  ) {
    errors.push("Cross-snapshot classification exceeds or changes the two-snapshot evidence.");
  }
  if (!classificationEligible) {
    errors.push("Continuous drift classification is not supported by the two exact bound snapshots.");
  }
  if (
    current.cutover_assessment?.source_revision !== null ||
    current.cutover_assessment?.source_revision_status !== "NOT_PROVEN"
  ) {
    errors.push("The orchestration must not claim a source revision or source SHA.");
  }

  const blockers = trafficEntries.filter((entry) =>
    String(entry.source_reconstruction_status).startsWith("CUTOVER_BLOCKING_")
  );
  const blockerDigest = digestCanonicalRecords(
    blockers.map((entry) => [entry.slug, entry.source_reconstruction_status])
  );
  const providerFailures = currentEntries.filter(
    (entry) => entry.capture_status === "BUNDLE_RETRIEVAL_FAILED"
  );
  const invalidProviderFailure = providerFailures.some(
    (entry) =>
      entry.retrieval_failure?.http_status !== 500 ||
      entry.retrieval_failure?.provider_error_code !== "FunctionsApiStatusError" ||
      entry.retrieval_failure?.failure_class !== "FAILED_TO_RETRIEVE_FUNCTION_BUNDLE" ||
      entry.retrieval_failure?.terminal_after_max_attempts !== true ||
      entry.capture_attempts !== 3
  );
  if (invalidProviderFailure) {
    errors.push("Current bundle failures must remain terminal provider-500 retrieval failures.");
  }
  const providerFailureDigest = digestCanonicalRecords(
    providerFailures.map((entry) => [
      entry.slug,
      entry.capture_status,
      String(entry.retrieval_failure?.http_status),
      entry.retrieval_failure?.provider_error_code,
      entry.retrieval_failure?.failure_class,
      String(entry.retrieval_failure?.terminal_after_max_attempts),
    ])
  );
  requireRecord(errors, "cutover_blockers", contract.cutover_blockers, {
    status: "BLOCKED_ALL_112_FUNCTIONS_REMAIN_FROZEN",
    traffic_source_contracts: {
      count: blockers.length,
      digest_algorithm: DIGEST_ALGORITHM,
      digest: blockerDigest,
    },
    current_provider_500_retrieval_failures: {
      count: providerFailures.length,
      digest_algorithm: DIGEST_ALGORITHM,
      digest: providerFailureDigest,
    },
    current_metadata_end_check_status:
      current.cutover_assessment?.metadata_end_check_status,
    bundle_to_metadata_version_binding_status:
      current.cutover_assessment?.bundle_to_metadata_version_binding_status,
  });
  if (
    blockers.length !== 17 ||
    providerFailures.length !== 16 ||
    current.cutover_assessment?.status !== "CUTOVER_BLOCKING_VERSION_DRIFT" ||
    traffic.deployment_capture?.inventory_status !== "CUTOVER_BLOCKING_VERSION_DRIFT"
  ) {
    errors.push("The 17 traffic blockers, 16 provider failures, and cutover block must remain exact.");
  }

  const activeInventoryDigest = sha256(
    `${functions
      .map((entry) => `${entry.source?.slug}:${entry.source?.function_id}`)
      .sort(compareUtf8)
      .join("\n")}\n`
  );
  const trafficSummaryDigest = sha256(`${stableTrafficJson(traffic.expected_counts)}\n`);
  const trafficWindowDigest = sha256(
    asArray(traffic.windows).map((window) => `${stableTrafficJson(window)}\n`).join("")
  );
  requireRecord(errors, "semantic_digest_bindings", contract.semantic_digest_bindings, {
    active_function_inventory_digest: activeInventoryDigest,
    historical_bundle_entry_digest: digestBundleEvidenceEntries(historicalEntries),
    historical_source_tree_digest: historical.canonical_source_tree?.digest,
    traffic_evidence_digest: digestTrafficEvidence(traffic),
    traffic_summary_digest: trafficSummaryDigest,
    traffic_window_digest: trafficWindowDigest,
    traffic_query_template_digest: traffic.query_binding?.query_template_digest,
    traffic_deployment_provider_response_digest:
      traffic.deployment_capture?.provider_response_sha256,
    current_recovery_snapshot_digest:
      current.capture_integrity?.recovery_snapshot_digest,
    current_evidence_digest: digestCurrentEvidence(current),
  });

  return {
    valid: errors.length === 0,
    errors,
    observed: {
      active_functions: functions.length,
      frozen_functions: frozenFunctions,
      verify_jwt_true: verifyJwtTrue,
      verify_jwt_false: verifyJwtFalse,
      traffic_version_delta_histogram: trafficHistogram,
      current_version_delta_histogram: currentHistogram,
      shared_exact_functions: trafficExact.length,
      shared_drift_functions: trafficDrift.length,
      traffic_source_blockers: blockers.length,
      current_provider_500_retrieval_failures: providerFailures.length,
      classification: snapshotComparison?.classification ?? null,
      evidence_digest: observedContractDigest,
    },
  };
};

export const readAndValidateFunctionEvidenceOrchestration = ({
  root = process.cwd(),
} = {}) => validateFunctionEvidenceOrchestration(
  readFunctionEvidenceOrchestrationInputs({ root })
);

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  let result;
  try {
    result = readAndValidateFunctionEvidenceOrchestration();
  } catch (error) {
    result = {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      observed: {},
    };
  }
  if (!result.valid) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(
    `Function evidence orchestration valid: ${result.observed.active_functions} frozen functions, ` +
      `${result.observed.shared_drift_functions} drifted at both snapshots, ` +
      `${result.observed.traffic_source_blockers} traffic source blockers, ` +
      `${result.observed.current_provider_500_retrieval_failures} provider-500 bundle failures.`
  );
}
