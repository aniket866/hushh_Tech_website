import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_CONTRACT_URL = new URL(
  "../../migration/native/supabase-native-cutover.v1.json",
  import.meta.url,
);

const EXPECTED_CLIENTS = new Map([
  [
    "ios",
    {
      identifier: "ai.hushh.app",
      storeRecordId: "6498471189",
      lastTrackedProjectBuild: 11,
      lastTrackedInfoPlistBuild: 5,
      lastTrackedVersion: "1.0",
    },
  ],
  [
    "android",
    {
      identifier: "ai.hushh.app",
      storeRecordId: "ai.hushh.app",
      lastTrackedProjectBuild: 11,
      lastTrackedVersion: "1.0.8",
    },
  ],
]);

const EXPECTED_SOURCE_REMOVAL = {
  pull_request: 665,
  merge_commit: "5edbad18e51d1935729190e79ac3cc8c4e228217",
  last_source_commit: "e1eaf82ea166d476bd71426e03ade129cb902ffb",
  removed_at: "2026-04-01T11:57:46Z",
  current_repository_mode: "WEB_ONLY",
};

const REQUIRED_BLOCKERS = new Set([
  "IOS_GCP_ONLY_REPLACEMENT_NOT_SHIPPED",
  "ANDROID_GCP_ONLY_REPLACEMENT_NOT_SHIPPED",
  "IOS_LAST_SUPABASE_BUILD_NOT_STORE_ATTESTED",
  "ANDROID_LAST_SUPABASE_BUILD_NOT_STORE_ATTESTED",
  "LIVE_NATIVE_STORE_AND_NETWORK_ATTESTATION_EXECUTOR_REQUIRED",
  "IOS_MINIMUM_VERSION_GATE_NOT_PROVEN",
  "ANDROID_MINIMUM_VERSION_GATE_NOT_PROVEN",
]);

const SHA256 = /^[a-f0-9]{64}$/;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validateReadyReplacement(client, requirements, errors) {
  const replacement = client.replacement ?? {};
  const prefix = `clients.${client.platform}.replacement`;
  const trackedBuildFloor = Math.max(
    client.last_tracked_project_build ?? 0,
    client.last_tracked_info_plist_build ?? 0,
  );

  if (replacement.source_state !== "GCP_ONLY_SOURCE_VERIFIED") {
    errors.push(`${prefix}.source_state must be GCP_ONLY_SOURCE_VERIFIED`);
  }
  if (client.last_supabase_capable_build_state !== "STORE_CONSOLE_ATTESTED") {
    errors.push(`clients.${client.platform}.last_supabase_capable_build_state must be STORE_CONSOLE_ATTESTED`);
  }
  if (!isPositiveInteger(client.last_supabase_capable_build)) {
    errors.push(`clients.${client.platform}.last_supabase_capable_build must be store-attested`);
  } else if (client.last_supabase_capable_build < trackedBuildFloor) {
    errors.push(
      `clients.${client.platform}.last_supabase_capable_build must be at least tracked source build ${trackedBuildFloor}`,
    );
  }
  if (replacement.identifier !== client.legacy_identifier) {
    errors.push(`${prefix}.identifier must preserve the legacy application identity`);
  }
  if (!isPositiveInteger(replacement.minimum_supported_build) ||
      !isPositiveInteger(client.last_supabase_capable_build) ||
      replacement.minimum_supported_build <= client.last_supabase_capable_build) {
    errors.push(`${prefix}.minimum_supported_build must exceed the last Supabase-capable build`);
  }
  if (replacement.store_state !== "PRODUCTION_AVAILABLE") {
    errors.push(`${prefix}.store_state must be PRODUCTION_AVAILABLE`);
  }
  if (replacement.store_rollout_percent !== requirements.store_rollout_percent) {
    errors.push(`${prefix}.store_rollout_percent must be 100`);
  }
  if (replacement.supabase_network_requests !== requirements.legacy_supabase_network_requests) {
    errors.push(`${prefix}.supabase_network_requests must be 0`);
  }

  for (const field of [
    "artifact_sha256",
    "store_evidence_sha256",
    "minimum_version_gate_proof_sha256",
    "forced_upgrade_e2e_proof_sha256",
    "network_trace_sha256",
  ]) {
    if (!SHA256.test(replacement[field] ?? "")) {
      errors.push(`${prefix}.${field} must be a lowercase SHA-256 digest`);
    }
  }
}

export function validateNativeCutoverContract(contract) {
  const errors = [];

  if (contract?.schema_version !== 1) errors.push("schema_version must be 1");
  if (contract?.contract_id !== "hushh-tech-supabase-native-cutover-v1") {
    errors.push("contract_id mismatch");
  }
  if (contract?.tracking_issue !== 1950) errors.push("tracking_issue must be 1950");
  if (contract?.firebase_authority !== "hushh-pda") {
    errors.push("firebase_authority must be hushh-pda");
  }
  if (contract?.runtime_owner !== "hushh-labs/hushh_Tech_website") {
    errors.push("runtime_owner mismatch");
  }
  if (contract?.live_attestation_executor !== "NOT_IMPLEMENTED_BLOCKING") {
    errors.push("live_attestation_executor must remain NOT_IMPLEMENTED_BLOCKING until a reviewed live verifier lands");
  }

  const removal = contract?.legacy_source_removal ?? {};
  for (const [field, expected] of Object.entries(EXPECTED_SOURCE_REMOVAL)) {
    if (removal[field] !== expected) {
      errors.push(`legacy_source_removal.${field} mismatch`);
    }
  }

  const separateProduct = contract?.separate_native_product ?? {};
  if (separateProduct.repository !== "hushh-labs/hushh-research") {
    errors.push("separate native product repository mismatch");
  }
  if (separateProduct.ios_bundle_id !== "com.hushh.app") {
    errors.push("separate native product iOS identifier mismatch");
  }
  if (separateProduct.relationship !== "SEPARATE_PRODUCT_NOT_A_REPLACEMENT_BUILD") {
    errors.push("separate native product must not satisfy the Hushh Tech replacement gate");
  }
  if (separateProduct.supabase_source_reference_count !== 0) {
    errors.push("separate native product Supabase source reference count must be 0");
  }

  const requirements = contract?.required_for_supabase_deletion ?? {};
  const exactRequirements = {
    same_legacy_identity: true,
    firebase_only_auth: true,
    gcp_only_runtime: true,
    store_rollout_percent: 100,
    legacy_supabase_network_requests: 0,
    minimum_version_http_status: 426,
    minimum_version_error_code: "CLIENT_UPGRADE_REQUIRED",
    minimum_version_enforcement: "SERVER_AND_CLIENT",
    minimum_version_fail_closed: true,
  };
  for (const [field, expected] of Object.entries(exactRequirements)) {
    if (requirements[field] !== expected) {
      errors.push(`required_for_supabase_deletion.${field} must equal ${JSON.stringify(expected)}`);
    }
  }

  if (!Array.isArray(contract?.clients) || contract.clients.length !== EXPECTED_CLIENTS.size) {
    errors.push("clients must contain exactly iOS and Android");
  } else {
    const seen = new Set();
    for (const client of contract.clients) {
      if (seen.has(client.platform)) errors.push(`duplicate client platform ${client.platform}`);
      seen.add(client.platform);
      const expected = EXPECTED_CLIENTS.get(client.platform);
      if (!expected) {
        errors.push(`unexpected client platform ${client.platform}`);
        continue;
      }
      if (client.legacy_identifier !== expected.identifier) {
        errors.push(`clients.${client.platform}.legacy_identifier mismatch`);
      }
      if (client.store_record_id !== expected.storeRecordId) {
        errors.push(`clients.${client.platform}.store_record_id mismatch`);
      }
      if (client.last_tracked_project_build !== expected.lastTrackedProjectBuild) {
        errors.push(`clients.${client.platform}.last_tracked_project_build mismatch`);
      }
      if (client.last_tracked_version !== expected.lastTrackedVersion) {
        errors.push(`clients.${client.platform}.last_tracked_version mismatch`);
      }
      if (expected.lastTrackedInfoPlistBuild === undefined) {
        if (client.last_tracked_info_plist_build !== undefined) {
          errors.push(`clients.${client.platform}.last_tracked_info_plist_build must be absent`);
        }
      } else if (client.last_tracked_info_plist_build !== expected.lastTrackedInfoPlistBuild) {
        errors.push(`clients.${client.platform}.last_tracked_info_plist_build mismatch`);
      }
      if (
        client.last_supabase_capable_build_state !== "NOT_CAPTURED_BLOCKING" &&
        client.last_supabase_capable_build_state !== "SOURCE_ONLY_BLOCKING" &&
        client.last_supabase_capable_build_state !== "STORE_CONSOLE_ATTESTED"
      ) {
        errors.push(`clients.${client.platform}.last_supabase_capable_build_state is invalid`);
      }
      if (
        client.last_supabase_capable_build !== null &&
        !isPositiveInteger(client.last_supabase_capable_build)
      ) {
        errors.push(`clients.${client.platform}.last_supabase_capable_build must be null or positive`);
      }
      if (
        client.last_supabase_capable_build_state === "NOT_CAPTURED_BLOCKING" &&
        client.last_supabase_capable_build !== null
      ) {
        errors.push(`clients.${client.platform}.last_supabase_capable_build must be null until captured`);
      }
      if (
        client.last_supabase_capable_build_state === "SOURCE_ONLY_BLOCKING" &&
        client.last_supabase_capable_build !== expected.lastTrackedProjectBuild
      ) {
        errors.push(
          `clients.${client.platform}.last_supabase_capable_build must equal tracked source build while source-only`,
        );
      }
      if (client.replacement?.identifier !== expected.identifier) {
        errors.push(`clients.${client.platform}.replacement.identifier mismatch`);
      }
    }
    for (const platform of EXPECTED_CLIENTS.keys()) {
      if (!seen.has(platform)) errors.push(`missing ${platform} client`);
    }
  }

  const blockers = new Set(contract?.blockers ?? []);
  if (contract?.overall_state === "BLOCKED") {
    for (const blocker of REQUIRED_BLOCKERS) {
      if (!blockers.has(blocker)) errors.push(`missing fail-closed blocker ${blocker}`);
    }
  } else if (contract?.overall_state === "READY_FOR_SUPABASE_DELETION") {
    if (blockers.size !== 0) errors.push("ready contract must have no blockers");
    for (const client of contract.clients ?? []) {
      validateReadyReplacement(client, requirements, errors);
    }
  } else {
    errors.push("overall_state must be BLOCKED or READY_FOR_SUPABASE_DELETION");
  }

  return errors;
}

export function assertNativeCutoverReady(contract) {
  const errors = validateNativeCutoverContract(contract);
  errors.push("live native store and network attestation executor is not implemented");
  if (contract?.overall_state !== "READY_FOR_SUPABASE_DELETION") {
    errors.push("native cutover is not READY_FOR_SUPABASE_DELETION");
  }
  return errors;
}

export function loadNativeCutoverContract(url = DEFAULT_CONTRACT_URL) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function runCli() {
  const contract = loadNativeCutoverContract();
  const assertReady = process.argv.includes("--assert-ready");
  const errors = assertReady
    ? assertNativeCutoverReady(contract)
    : validateNativeCutoverContract(contract);

  if (errors.length > 0) {
    for (const error of errors) console.error(`native-cutover: ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    assertReady
      ? "native-cutover: ready for Supabase deletion"
      : `native-cutover: contract valid (${contract.overall_state})`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli();
