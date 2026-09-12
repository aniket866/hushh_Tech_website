import { lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, sha256 } from "./canonical.js";
import {
  BASE_IMAGE_DIGEST,
  BASE_PR_HEAD,
  EXPECTED_BOUNDS_QUERY_SHA256,
  EXPECTED_CATALOG_QUERY_SHA256,
  EXPECTED_EXECUTION_CONTRACT_SHA256,
  EXPECTED_QUERY_SET_SHA256,
  EXPECTED_SOURCE_SHA256,
  HARD_PROCESS_DEADLINE_MS,
  MAX_CANONICAL_ROW_BYTES,
  MAX_COLLECTION_ROW_COUNT,
  MAX_OUTPUT_BYTES,
  TARGET,
  WORKER_DEADLINE_MS,
} from "./constants.js";
import { AttestorError } from "./errors.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTION_CONTRACT_PATH = resolve(PACKAGE_ROOT, "contracts/execution-contract.v1.json");
const SOURCE_MANIFEST_PATH = resolve(PACKAGE_ROOT, "contracts/source-manifest.v1.json");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const EXPECTED_SOURCE_FILES = Object.freeze([
  ".dockerignore",
  "Dockerfile",
  "contracts/attestation-evidence.schema.json",
  "contracts/attestation-baseline.v1.json",
  "package-lock.json",
  "package.json",
  "sql/catalog-bounds.v1.sql",
  "sql/catalog-attestation.v1.sql",
  "src/canonical.js",
  "src/cli.js",
  "src/config.js",
  "src/constants.js",
  "src/contracts.js",
  "src/errors.js",
  "src/evidence.js",
  "src/query-contract.js",
  "src/runner.js",
  "src/supervisor.js",
  "src/verifier.js",
]);

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateSourceManifest(manifest) {
  if (
    !exactKeys(manifest, ["version", "files", "sourceSha256"]) ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== EXPECTED_SOURCE_FILES.length ||
    !SHA256_PATTERN.test(manifest.sourceSha256 ?? "")
  ) {
    throw new AttestorError("SOURCE_CONTRACT_DRIFT");
  }
  for (const [index, entry] of manifest.files.entries()) {
    if (
      !exactKeys(entry, ["path", "sha256"]) ||
      entry.path !== EXPECTED_SOURCE_FILES[index] ||
      !SHA256_PATTERN.test(entry.sha256 ?? "")
    ) {
      throw new AttestorError("SOURCE_CONTRACT_DRIFT");
    }
    const absolute = resolve(PACKAGE_ROOT, entry.path);
    const packageRelative = relative(PACKAGE_ROOT, absolute);
    const metadata = lstatSync(absolute);
    if (
      packageRelative.startsWith(`..${sep}`) ||
      packageRelative === ".." ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      sha256(readFileSync(absolute)) !== entry.sha256
    ) {
      throw new AttestorError("SOURCE_CONTRACT_DRIFT");
    }
  }
  const payload = { version: manifest.version, files: manifest.files };
  if (
    canonicalHash(payload) !== manifest.sourceSha256 ||
    manifest.sourceSha256 !== EXPECTED_SOURCE_SHA256
  ) {
    throw new AttestorError("SOURCE_CONTRACT_DRIFT");
  }
  return manifest.sourceSha256;
}

function validateExecutionContract(contract, sourceSha256) {
  if (
    !exactKeys(contract, [
      "version",
      "state",
      "basePrHead",
      "target",
      "connector",
      "query",
      "limits",
      "activation",
      "sourceSha256",
      "baseImageDigest",
      "contractSha256",
    ]) ||
    contract.version !== 1 ||
    contract.state !== "CODE_ONLY_DEFAULT_OFF_NOT_EXECUTED" ||
    contract.basePrHead !== BASE_PR_HEAD ||
    canonicalHash(contract.target) !== canonicalHash(TARGET) ||
    canonicalHash(contract.connector) !==
      canonicalHash({
        ipType: "PRIVATE",
        authType: "IAM",
        passwordAllowed: false,
        applicationRetries: 0,
        transportRetryPolicy: "CONNECTOR_LIBRARY_MANAGED_READ_ONLY_NOT_COUNTED",
        transportRetryCountAttested: false,
      }) ||
    canonicalHash(contract.query) !==
      canonicalHash({
        transaction: "REPEATABLE_READ_READ_ONLY_ROLLBACK",
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 1_000,
        idleInTransactionTimeoutMs: 15_000,
        workMemMb: 4,
        statementCount: 9,
        querySetSha256: EXPECTED_QUERY_SET_SHA256,
        boundsQuerySha256: EXPECTED_BOUNDS_QUERY_SHA256,
        catalogQuerySha256: EXPECTED_CATALOG_QUERY_SHA256,
        canonicalDigest: "SHA256_JSON_ARRAY_OF_ROW_SHA256",
      }) ||
    canonicalHash(contract.limits) !==
      canonicalHash({
        hardProcessDeadlineMs: HARD_PROCESS_DEADLINE_MS,
        workerDeadlineMs: WORKER_DEADLINE_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        maxCollectionRowCount: MAX_COLLECTION_ROW_COUNT,
        maxCanonicalRowBytes: MAX_CANONICAL_ROW_BYTES,
        maxPoolConnections: 1,
      }) ||
    canonicalHash(contract.activation) !==
      canonicalHash({
        defaultExecute: false,
        explicitExecuteValue: "true",
        exactContractApprovalRequired: true,
        exactQueryApprovalRequired: true,
        exactSourceApprovalRequired: true,
        imageDigestClaimRequired: true,
        externalActualImageVerificationRequired: true,
      }) ||
    contract.sourceSha256 !== sourceSha256 ||
    contract.baseImageDigest !== BASE_IMAGE_DIGEST ||
    !SHA256_PATTERN.test(contract.contractSha256 ?? "")
  ) {
    throw new AttestorError("ACTIVATION_CONTRACT_MISMATCH");
  }
  const { contractSha256, ...payload } = contract;
  if (
    canonicalHash(payload) !== contractSha256 ||
    contractSha256 !== EXPECTED_EXECUTION_CONTRACT_SHA256
  ) {
    throw new AttestorError("ACTIVATION_CONTRACT_MISMATCH");
  }
  return contract.contractSha256;
}

export function validateRuntimeContracts({ sourceManifest, executionContract } = {}) {
  try {
    const source = sourceManifest ?? readJson(SOURCE_MANIFEST_PATH);
    const contract = executionContract ?? readJson(EXECUTION_CONTRACT_PATH);
    const sourceSha256 = validateSourceManifest(source);
    const executionContractSha256 = validateExecutionContract(contract, sourceSha256);
    return Object.freeze({ sourceSha256, executionContractSha256 });
  } catch (error) {
    if (error instanceof AttestorError) throw error;
    throw new AttestorError("SOURCE_CONTRACT_DRIFT");
  }
}

export { EXPECTED_SOURCE_FILES };
