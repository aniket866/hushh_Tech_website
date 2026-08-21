import { canonicalHash } from "./canonical.js";
import {
  BASE_IMAGE_DIGEST,
  BASE_PR_HEAD,
  CHECK_NAMES,
  COLLECTIONS,
  EXPECTED_BOUNDS_QUERY_SHA256,
  EXPECTED_CATALOG_QUERY_SHA256,
  EXPECTED_EXECUTION_CONTRACT_SHA256,
  EXPECTED_QUERY_SET_SHA256,
  EXPECTED_SOURCE_SHA256,
  HARD_PROCESS_DEADLINE_MS,
  MAX_CANONICAL_ROW_BYTES,
  MAX_COLLECTION_ROW_COUNT,
  MAX_OUTPUT_BYTES,
  MAX_RESULT_ROWS,
  TARGET,
  WORKER_DEADLINE_MS,
} from "./constants.js";
import { AttestorError } from "./errors.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EVIDENCE_KIND = "HUSHH_TECH_UAT_CLOUDSQL_CATALOG_CAPTURE";
const TRANSPORT_RETRY_POLICY = "CONNECTOR_LIBRARY_MANAGED_READ_ONLY_NOT_COUNTED";

const CHECK_BLOCKERS = Object.freeze({
  databaseMatches: "DATABASE_TARGET_MISMATCH",
  auditRoleMatches: "AUDIT_ROLE_MISMATCH",
  postgres17: "POSTGRES_MAJOR_MISMATCH",
  transactionReadOnly: "TRANSACTION_NOT_READ_ONLY",
  applicationRelationsEmpty: "APPLICATION_RELATIONS_PRESENT",
  applicationSequencesEmpty: "APPLICATION_SEQUENCES_PRESENT",
  applicationFunctionsEmpty: "APPLICATION_FUNCTIONS_PRESENT",
  applicationTriggersEmpty: "APPLICATION_TRIGGERS_PRESENT",
  expectedRoleSetPresent: "EXPECTED_ROLE_SET_MISSING",
  roleFlagsSafe: "PRIVILEGED_ROLE_FLAGS_PRESENT",
  auditTemporaryPrivilegeDenied: "AUDIT_TEMPORARY_PRIVILEGE_PRESENT",
  auditDatabaseCreateDenied: "AUDIT_DATABASE_CREATE_PRIVILEGE_PRESENT",
  auditPublicSchemaCreateDenied: "AUDIT_SCHEMA_CREATE_PRIVILEGE_PRESENT",
  auditAllSchemaCreateDenied: "AUDIT_SCHEMA_CREATE_PRIVILEGE_PRESENT",
  auditWritableMembershipDenied: "AUDIT_WRITABLE_MEMBERSHIP_PRESENT",
  auditWritableObjectPrivilegesDenied: "AUDIT_WRITABLE_OBJECT_PRIVILEGE_PRESENT",
  auditWritableDefaultPrivilegesDenied: "AUDIT_WRITABLE_DEFAULT_PRIVILEGE_PRESENT",
  catalogBoundsSatisfied: "CATALOG_BOUNDS_EXCEEDED",
});

const NON_CAPTURE_BLOCKERS = new Set([
  "ACTIVATION_CONTRACT_MISMATCH",
  "ATTESTATION_ABORTED",
  "CATALOG_BOUNDS_EXCEEDED",
  "CATALOG_CHECK_FAILED",
  "CATALOG_RESULT_INVALID",
  "CONNECTOR_CONTRACT_INVALID",
  "EVIDENCE_INVALID",
  "EXECUTION_GATE_FALSE",
  "FORBIDDEN_CREDENTIAL_ENV",
  "HARD_PROCESS_DEADLINE_EXCEEDED",
  "IMAGE_DIGEST_REQUIRED",
  "QUERY_CONTRACT_DRIFT",
  "RUNTIME_CONNECTION_FAILED",
  "SOURCE_CONTRACT_DRIFT",
  "TARGET_BOUNDARY_VIOLATION",
  "WORKER_DEADLINE_EXCEEDED",
  "WORKER_EXIT_FAILED",
  "WORKER_OUTPUT_INVALID",
]);

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function publicTarget() {
  return {
    environment: TARGET.environment,
    project: TARGET.project,
    region: TARGET.region,
    instance: TARGET.instance,
    database: TARGET.database,
    postgresMajor: TARGET.postgresMajor,
    auditRole: "audit",
  };
}

function bindings(imageDigest) {
  return {
    basePrHead: BASE_PR_HEAD,
    executionContractSha256: EXPECTED_EXECUTION_CONTRACT_SHA256,
    querySetSha256: EXPECTED_QUERY_SET_SHA256,
    boundsQuerySha256: EXPECTED_BOUNDS_QUERY_SHA256,
    catalogQuerySha256: EXPECTED_CATALOG_QUERY_SHA256,
    sourceSha256: EXPECTED_SOURCE_SHA256,
    baseImageDigest: BASE_IMAGE_DIGEST,
    imageDigest,
  };
}

function emptyChecks() {
  return Object.fromEntries(CHECK_NAMES.map((name) => [name, null]));
}

function emptyCollections() {
  return COLLECTIONS.map((name) => ({
    name,
    status: "NOT_CAPTURED",
    rowCount: null,
    sha256: null,
  }));
}

function executionState({
  enabled,
  hardProcessSupervisor = false,
  connectorCreated = false,
  poolCreated = false,
  connectorCloseCalled = false,
  poolCloseCalled = false,
  connectorCalls = 0,
  connectionAttempts = 0,
  queryStatements = 0,
}) {
  return {
    enabled,
    dryRun: !enabled,
    hardProcessSupervisor,
    hardProcessDeadlineMs: HARD_PROCESS_DEADLINE_MS,
    workerDeadlineMs: WORKER_DEADLINE_MS,
    connectorCreated,
    poolCreated,
    connectorCloseCalled,
    poolCloseCalled,
    connectorCalls,
    connectionAttempts,
    queryStatements,
    applicationRetries: 0,
    connectorTransportRetryCount: null,
    connectorTransportRetryPolicy: TRANSPORT_RETRY_POLICY,
    rawCatalogRowsLogged: false,
    rawCatalogRowsPersisted: false,
  };
}

function sealEvidence(payload) {
  const captureSha256 = canonicalHash({ checks: payload.checks, collections: payload.collections });
  const envelope = { ...payload, captureSha256 };
  const evidence = { ...envelope, evidenceSha256: canonicalHash(envelope) };
  validateEvidence(evidence);
  return Object.freeze(evidence);
}

export function buildNotExecutedEvidence({
  blocker = "EXECUTION_GATE_FALSE",
  hardProcessSupervisor = false,
} = {}) {
  return sealEvidence({
    version: 1,
    kind: EVIDENCE_KIND,
    status: blocker === "EXECUTION_GATE_FALSE" ? "NOT_EXECUTED" : "BLOCKED",
    target: publicTarget(),
    bindings: bindings(null),
    execution: executionState({ enabled: false, hardProcessSupervisor }),
    checks: emptyChecks(),
    collections: emptyCollections(),
    blockers: [blocker],
  });
}

export function normalizeBoundsResult(result) {
  if (
    Array.isArray(result) ||
    !result ||
    result.command !== "SELECT" ||
    result.rowCount !== MAX_RESULT_ROWS ||
    !Array.isArray(result.rows) ||
    result.rows.length !== MAX_RESULT_ROWS
  ) {
    throw new AttestorError("CATALOG_RESULT_INVALID");
  }
  for (const [index, row] of result.rows.entries()) {
    if (
      !exactKeys(row, ["collection", "row_count", "max_row_bytes"]) ||
      row.collection !== COLLECTIONS[index] ||
      !/^(0|[1-9][0-9]*)$/.test(row.row_count ?? "") ||
      !/^(0|[1-9][0-9]*)$/.test(row.max_row_bytes ?? "")
    ) {
      throw new AttestorError("CATALOG_RESULT_INVALID");
    }
    const rowCount = Number(row.row_count);
    const maxRowBytes = Number(row.max_row_bytes);
    if (
      !Number.isSafeInteger(rowCount) ||
      !Number.isSafeInteger(maxRowBytes) ||
      rowCount > MAX_COLLECTION_ROW_COUNT ||
      maxRowBytes > MAX_CANONICAL_ROW_BYTES
    ) {
      throw new AttestorError("CATALOG_BOUNDS_EXCEEDED");
    }
  }
  return true;
}

export function normalizeCatalogResult(result) {
  if (
    Array.isArray(result) ||
    !result ||
    result.command !== "SELECT" ||
    result.rowCount !== MAX_RESULT_ROWS ||
    !Array.isArray(result.rows) ||
    result.rows.length !== MAX_RESULT_ROWS
  ) {
    throw new AttestorError("CATALOG_RESULT_INVALID");
  }

  let checks = null;
  const collections = result.rows.map((row, index) => {
    if (
      !exactKeys(row, ["collection", "row_count", "canonical_sha256", "checks"]) ||
      row.collection !== COLLECTIONS[index] ||
      !/^(0|[1-9][0-9]*)$/.test(row.row_count ?? "") ||
      !SHA256_PATTERN.test(row.canonical_sha256 ?? "") ||
      (index === 0 ? !exactKeys(row.checks, CHECK_NAMES) : row.checks !== null)
    ) {
      throw new AttestorError("CATALOG_RESULT_INVALID");
    }
    const rowCount = Number(row.row_count);
    if (!Number.isSafeInteger(rowCount) || rowCount > MAX_COLLECTION_ROW_COUNT) {
      throw new AttestorError("CATALOG_RESULT_INVALID");
    }
    if (index === 0) {
      if (CHECK_NAMES.some((name) => typeof row.checks[name] !== "boolean")) {
        throw new AttestorError("CATALOG_RESULT_INVALID");
      }
      checks = Object.fromEntries(CHECK_NAMES.map((name) => [name, row.checks[name]]));
    }
    return { name: row.collection, status: "CAPTURED", rowCount, sha256: row.canonical_sha256 };
  });
  return Object.freeze({ checks: Object.freeze(checks), collections: Object.freeze(collections) });
}

export function buildCapturedEvidence({ normalized, imageDigest, cleanup }) {
  if (!IMAGE_DIGEST_PATTERN.test(imageDigest ?? "")) throw new AttestorError("IMAGE_DIGEST_REQUIRED");
  if (
    !cleanup ||
    cleanup.connectorCreated !== true ||
    cleanup.poolCreated !== true ||
    cleanup.connectorCloseCalled !== true ||
    cleanup.poolCloseCalled !== true
  ) {
    throw new AttestorError("CATALOG_CHECK_FAILED");
  }
  const blockers = CHECK_NAMES.filter((name) => normalized.checks[name] !== true).map(
    (name) => CHECK_BLOCKERS[name],
  );
  return sealEvidence({
    version: 1,
    kind: EVIDENCE_KIND,
    status: blockers.length === 0 ? "CAPTURED" : "BLOCKED",
    target: publicTarget(),
    bindings: bindings(imageDigest),
    execution: executionState({
      enabled: true,
      connectorCreated: true,
      poolCreated: true,
      connectorCloseCalled: true,
      poolCloseCalled: true,
      connectorCalls: 1,
      connectionAttempts: 1,
      queryStatements: 9,
    }),
    checks: normalized.checks,
    collections: normalized.collections,
    blockers,
  });
}

export function buildFailedExecutionEvidence({
  blocker,
  imageDigest,
  metrics,
  hardProcessSupervisor = false,
}) {
  if (
    !NON_CAPTURE_BLOCKERS.has(blocker) ||
    blocker === "EXECUTION_GATE_FALSE" ||
    !IMAGE_DIGEST_PATTERN.test(imageDigest ?? "") ||
    !metrics
  ) {
    throw new AttestorError("EVIDENCE_INVALID");
  }
  const allowedMetric = (value, max) => value === null || (Number.isInteger(value) && value >= 0 && value <= max);
  if (
    !allowedMetric(metrics.connectorCalls, 1) ||
    !allowedMetric(metrics.connectionAttempts, 1) ||
    !allowedMetric(metrics.queryStatements, 9) ||
    ![true, false, null].includes(metrics.connectorCreated) ||
    ![true, false, null].includes(metrics.poolCreated) ||
    ![true, false, null].includes(metrics.connectorCloseCalled) ||
    ![true, false, null].includes(metrics.poolCloseCalled) ||
    (metrics.connectorCreated !== null &&
      metrics.connectorCloseCalled !== null &&
      metrics.connectorCreated !== metrics.connectorCloseCalled) ||
    (metrics.poolCreated !== null &&
      metrics.poolCloseCalled !== null &&
      metrics.poolCreated !== metrics.poolCloseCalled)
  ) {
    throw new AttestorError("EVIDENCE_INVALID");
  }
  return sealEvidence({
    version: 1,
    kind: EVIDENCE_KIND,
    status: "BLOCKED",
    target: publicTarget(),
    bindings: bindings(imageDigest),
    execution: executionState({ enabled: true, hardProcessSupervisor, ...metrics }),
    checks: emptyChecks(),
    collections: emptyCollections(),
    blockers: [blocker],
  });
}

export function bindSupervisorEvidence(evidence) {
  validateEvidence(evidence);
  const payload = structuredClone(evidence);
  delete payload.captureSha256;
  delete payload.evidenceSha256;
  payload.execution.hardProcessSupervisor = true;
  return sealEvidence(payload);
}

function validateCollections(collections, captured) {
  if (!Array.isArray(collections) || collections.length !== COLLECTIONS.length) return false;
  return collections.every((collection, index) => {
    if (!exactKeys(collection, ["name", "status", "rowCount", "sha256"])) return false;
    if (collection.name !== COLLECTIONS[index]) return false;
    if (!captured) {
      return collection.status === "NOT_CAPTURED" && collection.rowCount === null && collection.sha256 === null;
    }
    return (
      collection.status === "CAPTURED" &&
      Number.isSafeInteger(collection.rowCount) &&
      collection.rowCount >= 0 &&
      collection.rowCount <= MAX_COLLECTION_ROW_COUNT &&
      SHA256_PATTERN.test(collection.sha256 ?? "")
    );
  });
}

function assertSanitized(evidence) {
  const serialized = JSON.stringify(evidence);
  if (
    serialized.length > MAX_OUTPUT_BYTES ||
    serialized.includes(TARGET.auditIamDatabaseUser) ||
    /@/.test(serialized) ||
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(serialized) ||
    /\b(?:postgres(?:ql)?|https?|wss?):\/\//i.test(serialized) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(serialized) ||
    /\bBearer\s+[A-Za-z0-9._~-]{12,}/i.test(serialized)
  ) {
    throw new AttestorError("EVIDENCE_INVALID");
  }
}

export function validateEvidence(evidence) {
  const evidenceKeys = [
    "version", "kind", "status", "target", "bindings", "execution", "checks",
    "collections", "blockers", "captureSha256", "evidenceSha256",
  ];
  if (
    !exactKeys(evidence, evidenceKeys) ||
    evidence.version !== 1 ||
    evidence.kind !== EVIDENCE_KIND ||
    canonicalHash(evidence.target) !== canonicalHash(publicTarget()) ||
    !exactKeys(evidence.bindings, [
      "basePrHead", "executionContractSha256", "querySetSha256", "boundsQuerySha256",
      "catalogQuerySha256", "sourceSha256", "baseImageDigest", "imageDigest",
    ]) ||
    evidence.bindings.basePrHead !== BASE_PR_HEAD ||
    evidence.bindings.executionContractSha256 !== EXPECTED_EXECUTION_CONTRACT_SHA256 ||
    evidence.bindings.querySetSha256 !== EXPECTED_QUERY_SET_SHA256 ||
    evidence.bindings.boundsQuerySha256 !== EXPECTED_BOUNDS_QUERY_SHA256 ||
    evidence.bindings.catalogQuerySha256 !== EXPECTED_CATALOG_QUERY_SHA256 ||
    evidence.bindings.sourceSha256 !== EXPECTED_SOURCE_SHA256 ||
    evidence.bindings.baseImageDigest !== BASE_IMAGE_DIGEST ||
    !exactKeys(evidence.execution, [
      "enabled", "dryRun", "hardProcessSupervisor", "hardProcessDeadlineMs",
      "workerDeadlineMs", "connectorCreated", "poolCreated", "connectorCloseCalled",
      "poolCloseCalled", "connectorCalls", "connectionAttempts", "queryStatements",
      "applicationRetries", "connectorTransportRetryCount", "connectorTransportRetryPolicy",
      "rawCatalogRowsLogged", "rawCatalogRowsPersisted",
    ]) ||
    evidence.execution.hardProcessDeadlineMs !== HARD_PROCESS_DEADLINE_MS ||
    evidence.execution.workerDeadlineMs !== WORKER_DEADLINE_MS ||
    evidence.execution.applicationRetries !== 0 ||
    evidence.execution.connectorTransportRetryCount !== null ||
    evidence.execution.connectorTransportRetryPolicy !== TRANSPORT_RETRY_POLICY ||
    evidence.execution.rawCatalogRowsLogged !== false ||
    evidence.execution.rawCatalogRowsPersisted !== false ||
    typeof evidence.execution.hardProcessSupervisor !== "boolean" ||
    !exactKeys(evidence.checks, CHECK_NAMES) ||
    !Array.isArray(evidence.collections) ||
    !Array.isArray(evidence.blockers) ||
    !SHA256_PATTERN.test(evidence.captureSha256 ?? "") ||
    !SHA256_PATTERN.test(evidence.evidenceSha256 ?? "")
  ) {
    throw new AttestorError("EVIDENCE_INVALID");
  }

  const captured = evidence.collections.every((collection) => collection.status === "CAPTURED");
  if (
    !validateCollections(evidence.collections, captured) ||
    canonicalHash({ checks: evidence.checks, collections: evidence.collections }) !== evidence.captureSha256
  ) {
    throw new AttestorError("EVIDENCE_INVALID");
  }

  if (evidence.execution.enabled && captured) {
    const expectedBlockers = CHECK_NAMES.filter((name) => evidence.checks[name] !== true).map(
      (name) => CHECK_BLOCKERS[name],
    );
    if (
      evidence.execution.dryRun !== false ||
      evidence.execution.connectorCreated !== true ||
      evidence.execution.poolCreated !== true ||
      evidence.execution.connectorCloseCalled !== true ||
      evidence.execution.poolCloseCalled !== true ||
      evidence.execution.connectorCalls !== 1 ||
      evidence.execution.connectionAttempts !== 1 ||
      evidence.execution.queryStatements !== 9 ||
      !IMAGE_DIGEST_PATTERN.test(evidence.bindings.imageDigest ?? "") ||
      CHECK_NAMES.some((name) => typeof evidence.checks[name] !== "boolean") ||
      canonicalHash(evidence.blockers) !== canonicalHash(expectedBlockers) ||
      evidence.status !== (expectedBlockers.length === 0 ? "CAPTURED" : "BLOCKED")
    ) {
      throw new AttestorError("EVIDENCE_INVALID");
    }
  } else if (evidence.execution.enabled) {
    const metricValid = (value, max) => value === null || (Number.isInteger(value) && value >= 0 && value <= max);
    const nullableBoolean = (value) => value === null || typeof value === "boolean";
    if (
      evidence.execution.dryRun !== false ||
      !nullableBoolean(evidence.execution.connectorCreated) ||
      !nullableBoolean(evidence.execution.poolCreated) ||
      !nullableBoolean(evidence.execution.connectorCloseCalled) ||
      !nullableBoolean(evidence.execution.poolCloseCalled) ||
      (evidence.execution.connectorCreated !== null &&
        evidence.execution.connectorCloseCalled !== null &&
        evidence.execution.connectorCreated !== evidence.execution.connectorCloseCalled) ||
      (evidence.execution.poolCreated !== null &&
        evidence.execution.poolCloseCalled !== null &&
        evidence.execution.poolCreated !== evidence.execution.poolCloseCalled) ||
      !metricValid(evidence.execution.connectorCalls, 1) ||
      !metricValid(evidence.execution.connectionAttempts, 1) ||
      !metricValid(evidence.execution.queryStatements, 9) ||
      !IMAGE_DIGEST_PATTERN.test(evidence.bindings.imageDigest ?? "") ||
      CHECK_NAMES.some((name) => evidence.checks[name] !== null) ||
      evidence.blockers.length !== 1 ||
      !NON_CAPTURE_BLOCKERS.has(evidence.blockers[0]) ||
      evidence.blockers[0] === "EXECUTION_GATE_FALSE" ||
      evidence.status !== "BLOCKED"
    ) {
      throw new AttestorError("EVIDENCE_INVALID");
    }
  } else if (
    evidence.execution.dryRun !== true ||
    evidence.execution.connectorCreated !== false ||
    evidence.execution.poolCreated !== false ||
    evidence.execution.connectorCloseCalled !== false ||
    evidence.execution.poolCloseCalled !== false ||
    evidence.execution.connectorCalls !== 0 ||
    evidence.execution.connectionAttempts !== 0 ||
    evidence.execution.queryStatements !== 0 ||
    captured ||
    evidence.bindings.imageDigest !== null ||
    CHECK_NAMES.some((name) => evidence.checks[name] !== null) ||
    evidence.blockers.length !== 1 ||
    !NON_CAPTURE_BLOCKERS.has(evidence.blockers[0]) ||
    evidence.status !== (evidence.blockers[0] === "EXECUTION_GATE_FALSE" ? "NOT_EXECUTED" : "BLOCKED")
  ) {
    throw new AttestorError("EVIDENCE_INVALID");
  }

  const { evidenceSha256, ...payload } = evidence;
  if (canonicalHash(payload) !== evidenceSha256) throw new AttestorError("EVIDENCE_INVALID");
  assertSanitized(evidence);
  return true;
}

export function serializeEvidence(evidence) {
  validateEvidence(evidence);
  const output = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
    throw new AttestorError("EVIDENCE_INVALID");
  }
  return output;
}
