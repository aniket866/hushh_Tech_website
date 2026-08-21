import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { digestBundleEvidenceEntries } from "./generate-supabase-live-function-bundle-evidence.mjs";
import { checkGeneratedFunctionRegistry } from "./generate-supabase-retirement-function-registry.mjs";

export const DEFAULT_MANIFEST_PATH = path.join(
  "migration",
  "manifests",
  "supabase-retirement.v1.json"
);
export const DEFAULT_LIVE_FUNCTION_BUNDLE_EVIDENCE_PATH = path.join(
  "migration",
  "evidence",
  "supabase-live-function-bundles.v1.json"
);

const PRIMARY_PROJECT_REF = "ibsisfnjxeowvdtvgzff";
const REQUIRED_ENTRY_FIELDS = [
  "source",
  "gcp_owner",
  "auth_mode",
  "migration_method",
  "parity_check",
  "rollback_treatment",
  "final_disposition",
];
const TERMINAL_AUTH_DISPOSITIONS = [
  "LINKED_EXISTING_FIREBASE",
  "IMPORTED_FIREBASE",
  "MANUAL_RECOVERY",
  "LEGALLY_RETAINED_NO_LOGIN",
  "INTENTIONALLY_DELETED",
];
const EXPECTED_OWNER_GROUPS = {
  "investor-api": 21,
  "identity-api": 10,
  "content-api": 10,
  "engagement-api-worker": 16,
  "signed-webhook-service": 6,
  "financial-api-worker": 48,
  "security-retirement": 1,
};
const EXPECTED_COUNTS = {
  public_tables: 70,
  exact_frozen_public_rows: 44811,
  active_edge_functions: 112,
  function_verify_jwt_true: 62,
  function_verify_jwt_false: 50,
  function_source_backed: 80,
  function_git_history_recovery: 18,
  function_contract_reconstruction: 14,
  storage_buckets: 6,
  storage_objects: 124,
  storage_bytes: 111078397,
  auth_users: 369,
  auth_provider_identities: 370,
  secondary_project_references: 6,
};
const EXPECTED_DIGESTS = {
  algorithm: "sha256_sorted_newline_v1",
  public_tables: "a5c06f073e40554d69923e1d75e8457dfaaadba70e7ada196d6f4d1a1b592d4e",
  active_functions: "f0a18d0c1ece82c589f294b977b9fc8368a240ea5464724e9ad00e427aa3ce5d",
  function_ownership: "b7ea6e11e20d10e161d107b211c335db0db5af3cc737fea3c5b9ccbc8adc88df",
  function_recovery: "6263f2d28c0ab2c8f1de72120c32f365702aaed2a85207aa89c001d186310a4d",
  storage_buckets: "98d5daf2e7641d71b092268bc699eb1a3a2929a4e6f1795c8bf38b90bd4328ea",
  secondary_projects: "7538097dee2165cc5cacb5081e9753bec9aedcce17c739b0d3be2b9837a261f2",
};
const EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE = {
  path: DEFAULT_LIVE_FUNCTION_BUNDLE_EVIDENCE_PATH,
  schema_version: 1,
  evidence_digest_algorithm:
    "sha256_of_canonical_function_bundle_evidence_lines_v1",
  evidence_digest: "182de37b13bfb9201cbe94f1c850e995f15bcdf92d38e08f73449b5cf119ea7b",
  active_functions: 112,
  extracted_bundles: 96,
  store_not_found: 16,
  extracted_files: 445,
  extracted_bytes: 2677504,
  canonical_source_tree_digest_algorithm:
    "sha256_of_sha256_double_space_relative_path_lines_lc_all_c_v1",
  canonical_source_tree_digest:
    "a976749fa43425152fddb2649ba6442500e412627a004f6ff60ca2892b9011a2",
};
const LIVE_BUNDLE_TOP_LEVEL_KEYS = [
  "schema_version",
  "evidence_id",
  "manifest_binding",
  "capture",
  "sanitization",
  "expected_counts",
  "canonical_source_tree",
  "evidence_digest",
  "entries",
];
const LIVE_BUNDLE_COMMON_ENTRY_KEYS = [
  "slug",
  "function_id",
  "version",
  "verify_jwt",
  "source_recovery_mode",
  "final_disposition",
  "migration_state",
  "capture_status",
];

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asArray = (value) => (Array.isArray(value) ? value : []);

const isNonEmpty = (value) => {
  if (typeof value === "string") return value.trim().length > 0;
  return isObject(value) && Object.keys(value).length > 0;
};

const countBy = (entries, readKey) => {
  const counts = {};
  for (const entry of entries) {
    const key = readKey(entry);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

const stableDigest = (values) =>
  crypto
    .createHash("sha256")
    .update([...values].sort().join("\n") + "\n", "utf8")
    .digest("hex");

const duplicateValues = (values) => {
  const counts = countBy(values, (value) => value);
  return Object.entries(counts)
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const sameRecord = (left, right) => {
  if (!isObject(left) || !isObject(right)) return false;
  return sameJson(
    Object.fromEntries(Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))),
    Object.fromEntries(Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)))
  );
};

const requireExactKeys = (errors, label, value, expectedKeys) => {
  if (!isObject(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!sameJson(actual, expected)) {
    errors.push(
      `${label} keys must be exactly ${expected.join(", ")}; found ${actual.join(", ")}.`
    );
  }
};

const requireExactCount = (errors, label, actual, expected) => {
  if (actual !== expected) {
    errors.push(`${label} must be ${expected}; found ${actual}.`);
  }
};

const requireSorted = (errors, label, values) => {
  const sorted = [...values].sort();
  if (!sameJson(values, sorted)) {
    errors.push(`${label} must stay sorted for deterministic review.`);
  }
};

const validateEntries = (errors, label, entries) => {
  entries.forEach((entry, index) => {
    if (!isObject(entry)) {
      errors.push(`${label}[${index}] must be an object.`);
      return;
    }
    for (const field of REQUIRED_ENTRY_FIELDS) {
      if (!isNonEmpty(entry[field])) {
        errors.push(`${label}[${index}] is missing required field ${field}.`);
      }
    }
    if (!isNonEmpty(entry.migration_state)) {
      errors.push(`${label}[${index}] is missing migration_state.`);
    }
  });
};

const validateDigest = (errors, label, actual, declared) => {
  const expected = EXPECTED_DIGESTS[label];
  if (actual !== expected) {
    errors.push(`${label} inventory digest changed; expected ${expected}, found ${actual}.`);
  }
  if (declared !== expected) {
    errors.push(`inventory_digests.${label} must remain ${expected}.`);
  }
};

export function validateManifest(manifest) {
  const errors = [];

  if (!isObject(manifest)) {
    return { valid: false, errors: ["Manifest root must be an object."], observed: {} };
  }

  if (manifest.schema_version !== 1) {
    errors.push("schema_version must be 1.");
  }
  if (manifest.contract_state !== "INVENTORY_FROZEN_NOT_MIGRATED") {
    errors.push("contract_state must be INVENTORY_FROZEN_NOT_MIGRATED.");
  }
  if (manifest.source_system?.project_ref !== PRIMARY_PROJECT_REF) {
    errors.push(`source_system.project_ref must be ${PRIMARY_PROJECT_REF}.`);
  }
  if (manifest.target_system?.firebase_project !== "hushh-pda") {
    errors.push("target_system.firebase_project must be hushh-pda.");
  }
  if (manifest.target_system?.gcp_projects?.uat !== "hushh-tech-uat") {
    errors.push("target_system.gcp_projects.uat must be hushh-tech-uat.");
  }
  if (manifest.target_system?.gcp_projects?.production !== "hushh-tech-prod") {
    errors.push("target_system.gcp_projects.production must be hushh-tech-prod.");
  }
  if (manifest.target_system?.region !== "us-central1") {
    errors.push("target_system.region must be us-central1.");
  }

  for (const [name, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (manifest.expected_counts?.[name] !== expected) {
      errors.push(`expected_counts.${name} must be ${expected}.`);
    }
  }
  if (!sameRecord(manifest.expected_counts?.function_owner_groups, EXPECTED_OWNER_GROUPS)) {
    errors.push("expected_counts.function_owner_groups does not match the locked ownership contract.");
  }
  if (!sameJson(manifest.entry_field_contract, REQUIRED_ENTRY_FIELDS)) {
    errors.push("entry_field_contract does not match the required entry fields.");
  }
  if (manifest.inventory_digests?.algorithm !== EXPECTED_DIGESTS.algorithm) {
    errors.push(`inventory_digests.algorithm must be ${EXPECTED_DIGESTS.algorithm}.`);
  }
  if (
    !sameRecord(
      manifest.live_function_bundle_evidence,
      EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE
    )
  ) {
    errors.push(
      "live_function_bundle_evidence does not match the locked sanitized bundle evidence contract."
    );
  }

  const tables = asArray(manifest.tables);
  const functions = asArray(manifest.functions);
  const buckets = asArray(manifest.buckets);
  const secondary = asArray(manifest.secondary_supabase_references);
  const auth = manifest.auth_identity_inventory;

  validateEntries(errors, "tables", tables);
  validateEntries(errors, "functions", functions);
  validateEntries(errors, "buckets", buckets);
  validateEntries(errors, "secondary_supabase_references", secondary);
  validateEntries(errors, "auth_identity_inventory", auth ? [auth] : []);
  if (!isObject(auth)) {
    errors.push("auth_identity_inventory must be an object.");
  }

  requireExactCount(errors, "Public table entries", tables.length, EXPECTED_COUNTS.public_tables);
  requireExactCount(
    errors,
    "Active function entries",
    functions.length,
    EXPECTED_COUNTS.active_edge_functions
  );
  requireExactCount(errors, "Storage bucket entries", buckets.length, EXPECTED_COUNTS.storage_buckets);
  requireExactCount(
    errors,
    "Secondary Supabase project references",
    secondary.length,
    EXPECTED_COUNTS.secondary_project_references
  );

  const tableKeys = tables.map((entry) => `${entry.source?.schema}.${entry.source?.table}`);
  const functionKeys = functions.map(
    (entry) => `${entry.source?.slug}:${entry.source?.function_id}`
  );
  const functionSlugs = functions.map((entry) => entry.source?.slug);
  const functionOwnership = functions.map(
    (entry) => `${entry.source?.slug}:${entry.owner_group}`
  );
  const functionRecovery = functions.map(
    (entry) =>
      `${entry.source?.slug}:${entry.source_recovery?.mode}:${entry.source_recovery?.source_commit || ""}`
  );
  const bucketKeys = buckets.map((entry) => entry.source?.bucket_id);
  const secondaryKeys = secondary.map(
    (entry) => `${entry.source?.reference_key}:${entry.source?.project_ref}`
  );

  for (const [label, values] of [
    ["table", tableKeys],
    ["function slug", functionSlugs],
    ["function id", functions.map((entry) => entry.source?.function_id)],
    ["bucket", bucketKeys],
    ["secondary project", secondary.map((entry) => entry.source?.project_ref)],
    ["secondary reference key", secondary.map((entry) => entry.source?.reference_key)],
  ]) {
    const duplicates = duplicateValues(values);
    if (duplicates.length > 0) {
      errors.push(`Duplicate ${label} entries: ${duplicates.join(", ")}.`);
    }
  }

  requireSorted(errors, "Table entries", tables.map((entry) => entry.source?.table));
  requireSorted(errors, "Function entries", functionSlugs);
  requireSorted(errors, "Bucket entries", bucketKeys);
  requireSorted(errors, "Secondary entries", secondary.map((entry) => entry.source?.project_ref));

  const observedDigests = {
    public_tables: stableDigest(tableKeys),
    active_functions: stableDigest(functionKeys),
    function_ownership: stableDigest(functionOwnership),
    function_recovery: stableDigest(functionRecovery),
    storage_buckets: stableDigest(bucketKeys),
    secondary_projects: stableDigest(secondaryKeys),
  };
  for (const [name, digest] of Object.entries(observedDigests)) {
    validateDigest(errors, name, digest, manifest.inventory_digests?.[name]);
  }

  for (const table of tables) {
    if (
      table.source?.provider !== "supabase" ||
      table.source?.project_ref !== PRIMARY_PROJECT_REF ||
      table.source?.schema !== "public"
    ) {
      errors.push(`Table ${table.source?.table || "<unknown>"} has an invalid source contract.`);
    }
    if (table.source_has_primary_key !== true) {
      errors.push(`Table ${table.source?.table || "<unknown>"} must record a primary key.`);
    }
    if (table.final_disposition !== "MIGRATE_TO_CLOUD_SQL") {
      errors.push(`Table ${table.source?.table || "<unknown>"} must migrate to Cloud SQL.`);
    }
  }

  const ownerGroupCounts = countBy(functions, (entry) => entry.owner_group);
  if (!sameRecord(ownerGroupCounts, EXPECTED_OWNER_GROUPS)) {
    errors.push(
      `Function owner counts changed; expected ${JSON.stringify(
        EXPECTED_OWNER_GROUPS
      )}, found ${JSON.stringify(ownerGroupCounts)}.`
    );
  }

  const verifyJwtTrue = functions.filter((entry) => entry.source?.verify_jwt === true).length;
  const verifyJwtFalse = functions.filter((entry) => entry.source?.verify_jwt === false).length;
  requireExactCount(
    errors,
    "verify_jwt=true functions",
    verifyJwtTrue,
    EXPECTED_COUNTS.function_verify_jwt_true
  );
  requireExactCount(
    errors,
    "verify_jwt=false functions",
    verifyJwtFalse,
    EXPECTED_COUNTS.function_verify_jwt_false
  );

  const recoveryCounts = countBy(functions, (entry) => entry.source_recovery?.mode);
  requireExactCount(
    errors,
    "Checked-in function sources",
    recoveryCounts.CHECKED_IN_SOURCE || 0,
    EXPECTED_COUNTS.function_source_backed
  );
  requireExactCount(
    errors,
    "Git-history function sources",
    recoveryCounts.RECOVER_FROM_GIT_HISTORY || 0,
    EXPECTED_COUNTS.function_git_history_recovery
  );
  requireExactCount(
    errors,
    "Reconstructed function contracts",
    recoveryCounts.RECONSTRUCT_CONTRACT || 0,
    EXPECTED_COUNTS.function_contract_reconstruction
  );

  for (const entry of functions) {
    const slug = entry.source?.slug || "<unknown>";
    if (
      entry.source?.provider !== "supabase" ||
      entry.source?.project_ref !== PRIMARY_PROJECT_REF ||
      entry.source?.kind !== "edge_function" ||
      entry.source?.status !== "ACTIVE"
    ) {
      errors.push(`Function ${slug} is not a frozen ACTIVE Supabase function entry.`);
    }
    if (!Object.hasOwn(EXPECTED_OWNER_GROUPS, entry.owner_group)) {
      errors.push(`Function ${slug} has unknown owner group ${entry.owner_group}.`);
    }
    if (slug === "get-secrets") {
      if (
        entry.owner_group !== "security-retirement" ||
        entry.final_disposition !== "RETIRE_WITH_410" ||
        entry.migration_method !== "do_not_port_return_410_feature_retired"
      ) {
        errors.push("get-secrets must be the single 410 security retirement.");
      }
    } else if (entry.final_disposition !== "PORT_TO_GCP") {
      errors.push(`Function ${slug} must have final_disposition PORT_TO_GCP.`);
    }
  }

  const retiredFunctions = functions.filter(
    (entry) => entry.final_disposition === "RETIRE_WITH_410"
  );
  requireExactCount(errors, "Retired functions", retiredFunctions.length, 1);
  if (retiredFunctions[0]?.source?.slug !== "get-secrets") {
    errors.push("get-secrets must be the only retired function.");
  }

  const storageObjects = buckets.reduce(
    (sum, entry) => sum + Number(entry.observed_object_count || 0),
    0
  );
  const storageBytes = buckets.reduce(
    (sum, entry) => sum + Number(entry.observed_total_bytes || 0),
    0
  );
  requireExactCount(errors, "Storage objects", storageObjects, EXPECTED_COUNTS.storage_objects);
  requireExactCount(errors, "Storage bytes", storageBytes, EXPECTED_COUNTS.storage_bytes);
  for (const bucket of buckets) {
    if (
      bucket.source?.provider !== "supabase" ||
      bucket.source?.project_ref !== PRIMARY_PROJECT_REF ||
      bucket.source?.kind !== "storage_bucket"
    ) {
      errors.push(`Bucket ${bucket.source?.bucket_id || "<unknown>"} has an invalid source.`);
    }
    if (bucket.final_disposition !== "MIGRATE_TO_GCS") {
      errors.push(`Bucket ${bucket.source?.bucket_id || "<unknown>"} must migrate to GCS.`);
    }
  }

  if (isObject(auth)) {
    if (
      auth.source?.project_ref !== PRIMARY_PROJECT_REF ||
      auth.source?.privacy_mode !== "aggregate_only_no_production_pii_in_repository"
    ) {
      errors.push("Auth inventory must use the privacy-safe aggregate source contract.");
    }
    requireExactCount(
      errors,
      "Supabase Auth users",
      auth.source_user_count,
      EXPECTED_COUNTS.auth_users
    );
    requireExactCount(
      errors,
      "Supabase provider identities",
      auth.source_provider_identity_count,
      EXPECTED_COUNTS.auth_provider_identities
    );
    if (!sameJson(auth.provider_counts, { apple: 12, email: 4, google: 354 })) {
      errors.push("Auth provider counts must remain apple=12, email=4, google=354.");
    }
    const plannedMappings = Object.values(auth.planned_mapping_counts || {}).reduce(
      (sum, count) => sum + Number(count || 0),
      0
    );
    requireExactCount(errors, "Planned Auth mappings", plannedMappings, EXPECTED_COUNTS.auth_users);
    if (!sameJson(auth.terminal_disposition_schema, TERMINAL_AUTH_DISPOSITIONS)) {
      errors.push("Auth terminal disposition schema does not match the locked contract.");
    }
    if (!asArray(auth.prohibited_mapping_keys).includes("email")) {
      errors.push("Auth mapping must explicitly prohibit email as a mapping key.");
    }
    if (auth.special_cases?.unclaimed_legacy_principals !== 65) {
      errors.push("Auth special cases must preserve 65 unclaimed legacy principals.");
    }
    for (const forbiddenKey of [
      "users",
      "identity_records",
      "emails",
      "phones",
      "provider_subjects",
    ]) {
      if (Object.hasOwn(auth, forbiddenKey)) {
        errors.push(`Auth inventory must not check in production PII field ${forbiddenKey}.`);
      }
    }
  }

  for (const entry of secondary) {
    if (
      entry.source?.provider !== "supabase" ||
      entry.source?.kind !== "secondary_project_reference"
    ) {
      errors.push(
        `Secondary reference ${entry.source?.reference_key || "<unknown>"} has an invalid source.`
      );
    }
    if (entry.source?.project_ref === PRIMARY_PROJECT_REF) {
      errors.push("The primary Supabase project cannot appear in secondary references.");
    }
    if (entry.final_disposition !== "REMOVE_REFERENCE_BEFORE_ZERO_DEPENDENCY") {
      errors.push(
        `Secondary reference ${entry.source?.reference_key || "<unknown>"} must be removed before zero dependency.`
      );
    }
  }

  const observed = {
    public_tables: tables.length,
    active_edge_functions: functions.length,
    function_owner_groups: ownerGroupCounts,
    function_source_recovery: recoveryCounts,
    function_verify_jwt_true: verifyJwtTrue,
    function_verify_jwt_false: verifyJwtFalse,
    storage_buckets: buckets.length,
    storage_objects: storageObjects,
    storage_bytes: storageBytes,
    auth_users: auth?.source_user_count ?? null,
    auth_provider_identities: auth?.source_provider_identity_count ?? null,
    secondary_project_references: secondary.length,
    inventory_digests: observedDigests,
  };

  return { valid: errors.length === 0, errors, observed };
}

export function validateLiveFunctionBundleEvidence(manifest, evidence) {
  const errors = [];

  if (!isObject(evidence)) {
    return {
      valid: false,
      errors: ["Live function bundle evidence root must be an object."],
      observed: {},
    };
  }

  requireExactKeys(errors, "Live function bundle evidence", evidence, LIVE_BUNDLE_TOP_LEVEL_KEYS);
  if (evidence.schema_version !== 1) {
    errors.push("Live function bundle evidence schema_version must be 1.");
  }
  if (evidence.evidence_id !== "hushh-tech-supabase-live-function-bundles") {
    errors.push("Live function bundle evidence_id is invalid.");
  }

  requireExactKeys(errors, "Live bundle manifest_binding", evidence.manifest_binding, [
    "manifest_id",
    "manifest_schema_version",
    "source_project_ref",
  ]);
  if (
    !sameRecord(evidence.manifest_binding, {
      manifest_id: manifest?.manifest_id,
      manifest_schema_version: manifest?.schema_version,
      source_project_ref: PRIMARY_PROJECT_REF,
    })
  ) {
    errors.push("Live bundle manifest_binding does not match the retirement manifest.");
  }

  requireExactKeys(errors, "Live bundle capture", evidence.capture, [
    "tool",
    "tool_version",
    "method",
    "source_write_mode",
  ]);
  if (
    !sameRecord(evidence.capture, {
      tool: "supabase_cli",
      tool_version: "2.115.0",
      method: "functions_download_current_bundle_extractor_read_only",
      source_write_mode: "READ_ONLY_NO_DEPLOYMENT",
    })
  ) {
    errors.push("Live bundle capture provenance does not match the locked read-only capture.");
  }

  requireExactKeys(errors, "Live bundle sanitization", evidence.sanitization, [
    "recovered_source_content_committed",
    "stdout_or_stderr_committed",
    "secret_or_token_values_committed",
    "temporary_absolute_paths_committed",
    "public_evidence",
  ]);
  if (
    !sameRecord(evidence.sanitization, {
      recovered_source_content_committed: false,
      stdout_or_stderr_committed: false,
      secret_or_token_values_committed: false,
      temporary_absolute_paths_committed: false,
      public_evidence: "per_slug_content_tree_digest_file_count_and_byte_count_only",
    })
  ) {
    errors.push("Live bundle evidence sanitization contract changed.");
  }

  const expectedEvidenceCounts = {
    active_functions: EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.active_functions,
    extracted_bundles: EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.extracted_bundles,
    store_not_found: EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.store_not_found,
    extracted_files: EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.extracted_files,
    extracted_bytes: EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.extracted_bytes,
  };
  requireExactKeys(
    errors,
    "Live bundle expected_counts",
    evidence.expected_counts,
    Object.keys(expectedEvidenceCounts)
  );
  if (!sameRecord(evidence.expected_counts, expectedEvidenceCounts)) {
    errors.push("Live bundle expected_counts do not match the locked 112/96/16 capture.");
  }

  requireExactKeys(errors, "Live bundle canonical_source_tree", evidence.canonical_source_tree, [
    "digest_algorithm",
    "digest",
  ]);
  if (
    !sameRecord(evidence.canonical_source_tree, {
      digest_algorithm:
        EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.canonical_source_tree_digest_algorithm,
      digest: EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.canonical_source_tree_digest,
    })
  ) {
    errors.push("Live bundle canonical source-tree digest changed.");
  }

  requireExactKeys(errors, "Live bundle evidence_digest", evidence.evidence_digest, [
    "digest_algorithm",
    "digest",
  ]);
  if (
    !sameRecord(evidence.evidence_digest, {
      digest_algorithm: EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.evidence_digest_algorithm,
      digest: EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.evidence_digest,
    })
  ) {
    errors.push("Live bundle evidence digest declaration changed.");
  }

  const entries = asArray(evidence.entries);
  requireExactCount(
    errors,
    "Live function bundle evidence entries",
    entries.length,
    EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.active_functions
  );
  const usableEntries = entries.filter(
    (entry) => isObject(entry) && typeof entry.slug === "string"
  );
  if (usableEntries.length !== entries.length) {
    errors.push("Every live function bundle evidence entry must be an object with a slug.");
  }

  const slugs = usableEntries.map((entry) => entry.slug);
  const duplicates = duplicateValues(slugs);
  if (duplicates.length > 0) {
    errors.push(`Duplicate live bundle evidence slugs: ${duplicates.join(", ")}.`);
  }
  requireSorted(errors, "Live function bundle evidence entries", slugs);

  const manifestBySlug = new Map(
    asArray(manifest?.functions).map((entry) => [entry.source?.slug, entry])
  );
  let extractedFiles = 0;
  let extractedBytes = 0;

  for (const entry of usableEntries) {
    const manifestEntry = manifestBySlug.get(entry.slug);
    if (!manifestEntry) {
      errors.push(`Live bundle evidence contains unknown function ${entry.slug}.`);
      continue;
    }

    const expectedCommon = {
      function_id: manifestEntry.source?.function_id,
      version: manifestEntry.source?.version,
      verify_jwt: manifestEntry.source?.verify_jwt,
      source_recovery_mode: manifestEntry.source_recovery?.mode,
      final_disposition: manifestEntry.final_disposition,
      migration_state: manifestEntry.migration_state,
    };
    for (const [field, expected] of Object.entries(expectedCommon)) {
      if (entry[field] !== expected) {
        errors.push(
          `Live bundle evidence ${entry.slug}.${field} must match the retirement manifest.`
        );
      }
    }

    if (entry.capture_status === "EXTRACTED") {
      requireExactKeys(
        errors,
        `Live bundle evidence entry ${entry.slug}`,
        entry,
        [...LIVE_BUNDLE_COMMON_ENTRY_KEYS, "bundle_evidence"]
      );
      requireExactKeys(
        errors,
        `Live bundle evidence ${entry.slug}.bundle_evidence`,
        entry.bundle_evidence,
        ["digest_algorithm", "canonical_digest", "file_count", "total_bytes"]
      );
      if (
        entry.bundle_evidence?.digest_algorithm !==
        EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.canonical_source_tree_digest_algorithm
      ) {
        errors.push(`Live bundle evidence ${entry.slug} uses an invalid digest algorithm.`);
      }
      if (!/^[a-f0-9]{64}$/.test(entry.bundle_evidence?.canonical_digest || "")) {
        errors.push(`Live bundle evidence ${entry.slug} has an invalid canonical digest.`);
      }
      if (!Number.isInteger(entry.bundle_evidence?.file_count) || entry.bundle_evidence.file_count < 1) {
        errors.push(`Live bundle evidence ${entry.slug} must contain at least one file.`);
      }
      if (!Number.isInteger(entry.bundle_evidence?.total_bytes) || entry.bundle_evidence.total_bytes < 1) {
        errors.push(`Live bundle evidence ${entry.slug} must contain positive source bytes.`);
      }
      extractedFiles += Number(entry.bundle_evidence?.file_count || 0);
      extractedBytes += Number(entry.bundle_evidence?.total_bytes || 0);
    } else if (entry.capture_status === "STORE_NOT_FOUND") {
      requireExactKeys(
        errors,
        `Live bundle evidence entry ${entry.slug}`,
        entry,
        [...LIVE_BUNDLE_COMMON_ENTRY_KEYS, "store_lookup"]
      );
      requireExactKeys(
        errors,
        `Live bundle evidence ${entry.slug}.store_lookup`,
        entry.store_lookup,
        ["http_status", "provider_error_code"]
      );
      if (
        !sameRecord(entry.store_lookup, {
          http_status: 404,
          provider_error_code: "UnknownError",
        })
      ) {
        errors.push(`Live bundle evidence ${entry.slug} must record the exact store 404.`);
      }
    } else {
      requireExactKeys(
        errors,
        `Live bundle evidence entry ${entry.slug}`,
        entry,
        LIVE_BUNDLE_COMMON_ENTRY_KEYS
      );
      errors.push(`Live bundle evidence ${entry.slug} has an invalid capture_status.`);
    }
  }

  for (const slug of manifestBySlug.keys()) {
    if (!slugs.includes(slug)) {
      errors.push(`Live bundle evidence is missing manifest function ${slug}.`);
    }
  }

  const captureCounts = countBy(usableEntries, (entry) => entry.capture_status);
  requireExactCount(
    errors,
    "Extracted live function bundles",
    captureCounts.EXTRACTED || 0,
    EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.extracted_bundles
  );
  requireExactCount(
    errors,
    "Store-not-found live function bundles",
    captureCounts.STORE_NOT_FOUND || 0,
    EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.store_not_found
  );
  requireExactCount(
    errors,
    "Extracted live function source files",
    extractedFiles,
    EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.extracted_files
  );
  requireExactCount(
    errors,
    "Extracted live function source bytes",
    extractedBytes,
    EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.extracted_bytes
  );

  if (usableEntries.length === entries.length) {
    const observedDigest = digestBundleEvidenceEntries(usableEntries);
    if (observedDigest !== EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.evidence_digest) {
      errors.push(
        `Live bundle evidence entry digest changed; expected ${EXPECTED_LIVE_FUNCTION_BUNDLE_EVIDENCE.evidence_digest}, found ${observedDigest}.`
      );
    }
    if (evidence.evidence_digest?.digest !== observedDigest) {
      errors.push("Live bundle evidence_digest does not match its entries.");
    }
  }

  const getSecrets = usableEntries.find((entry) => entry.slug === "get-secrets");
  if (
    getSecrets?.capture_status !== "STORE_NOT_FOUND" ||
    getSecrets?.final_disposition !== "RETIRE_WITH_410" ||
    getSecrets?.migration_state === "PORTED_AND_VERIFIED"
  ) {
    errors.push("get-secrets must remain store-not-found and retired with 410, never ported.");
  }
  for (const slug of ["fund-payment-admin-list", "public-signup-metrics"]) {
    const entry = usableEntries.find((candidate) => candidate.slug === slug);
    if (
      entry?.capture_status !== "EXTRACTED" ||
      entry?.source_recovery_mode !== "RECONSTRUCT_CONTRACT" ||
      entry?.migration_state !== "INVENTORY_FROZEN"
    ) {
      errors.push(
        `${slug} must record extracted live evidence without being reclassified or ported.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    observed: {
      active_functions: entries.length,
      extracted_bundles: captureCounts.EXTRACTED || 0,
      store_not_found: captureCounts.STORE_NOT_FOUND || 0,
      extracted_files: extractedFiles,
      extracted_bytes: extractedBytes,
      evidence_digest:
        usableEntries.length === entries.length
          ? digestBundleEvidenceEntries(usableEntries)
          : null,
      canonical_source_tree_digest: evidence.canonical_source_tree?.digest ?? null,
    },
  };
}

export function readAndValidateManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const absolutePath = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const manifestResult = validateManifest(manifest);
  const evidencePath = path.resolve(DEFAULT_LIVE_FUNCTION_BUNDLE_EVIDENCE_PATH);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const evidenceResult = validateLiveFunctionBundleEvidence(manifest, evidence);
  return {
    manifestPath: absolutePath,
    evidencePath,
    valid: manifestResult.valid && evidenceResult.valid,
    errors: [...manifestResult.errors, ...evidenceResult.errors],
    observed: {
      ...manifestResult.observed,
      live_function_bundle_evidence: evidenceResult.observed,
    },
  };
}

const parseArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const manifestPath = parseArg("--manifest") || DEFAULT_MANIFEST_PATH;
  const reportPath =
    parseArg("--report") ||
    process.env.SUPABASE_RETIREMENT_REPORT_PATH ||
    path.join("tmp", "ci", "supabase-retirement-manifest-report.json");

  let result;
  try {
    result = readAndValidateManifest(manifestPath);
  } catch (error) {
    result = {
      manifestPath: path.resolve(manifestPath),
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      observed: {},
    };
  }

  try {
    const generatedRegistry = checkGeneratedFunctionRegistry({ manifestPath });
    result.generatedRegistry = {
      valid: generatedRegistry.valid,
      generatedPath: generatedRegistry.generatedPath,
      functionCount: generatedRegistry.functionCount,
      digest: generatedRegistry.digest,
    };
    if (!generatedRegistry.valid) {
      result.valid = false;
      result.errors.push(generatedRegistry.error);
    }
  } catch (error) {
    result.valid = false;
    result.errors.push(
      `Unable to validate generated function registry: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(path.resolve(reportPath), JSON.stringify(result, null, 2) + "\n");

  if (!result.valid) {
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Supabase retirement contract valid: ${result.observed.public_tables} tables, ${result.observed.active_edge_functions} functions, ${result.observed.storage_buckets} buckets, ${result.observed.auth_users} Auth users.`
    );
  }
}
