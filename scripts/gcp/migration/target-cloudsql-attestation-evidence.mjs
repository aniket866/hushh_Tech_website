import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { canonicalHash } from "./canonical-hash.mjs";
import { MigrationContractError } from "./contract.mjs";

const EVIDENCE_URL = new URL(
  "../../../migration/contracts/uat-cloudsql-readonly-attestation.v1.json",
  import.meta.url
);
const QUERY_URL = new URL(
  "../../../migration/sql/target_cloudsql_attestation_read_only.sql",
  import.meta.url
);
const SOURCE_COMPILE_EVIDENCE_URL = new URL(
  "../../../migration/contracts/history/pr-1965-target-schema-offline-compile-evidence.v1.json",
  import.meta.url
);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EXPECTED_QUERY_SHA256 =
  "a287cdfe84449aaeaa1f6266c5ef19968fe815528d5c6ecb12efecf0c822f1e4";
const EXPECTED_SOURCE_COMPILE_SHA256 =
  "3b5d53544710bd8e41f870667bed1fb645f539341be82819470c0078bf7cf666";
const EXPECTED_SOURCE_COMPILE_PATH =
  "migration/contracts/history/pr-1965-target-schema-offline-compile-evidence.v1.json";
const EXPECTED_ADMIN_API_DIGESTS = Object.freeze({
  instanceCanonicalSha256:
    "0ce2feb7fdcd12be96a28e742edb35a2df65bb82a87bcbb07978c1f245af24ae",
  databaseInventoryCanonicalSha256:
    "48c8f8c42cfb4e2c2056cb707f99b6ee39f02eabe61fbf647acf8058d2d716d1",
  iamDatabaseUsersCanonicalSha256:
    "b90876d25696008a084447db6507f260dd6b3738c4f38128a4fe6c4b3efa73c3",
});
const EXPECTED_COMPILE_BLOCKERS = Object.freeze([
  "PLAN_ONLY_EXECUTION",
  "GOVERNED_EXECUTOR_NOT_PRESENT",
  "SEALED_SCHEMA_OWNER_EXECUTOR_BINDING_REQUIRED",
  "LIVE_TARGET_ATTESTATION_REQUIRED",
  "48_SOURCE_POLICY_CONTRACTS_BLOCKED",
  "16_LEGACY_RPC_CONTRACTS_BLOCKED",
  "SOURCE_EXTENSION_SET_REVIEW_REQUIRED",
]);
const EXPECTED_COLLECTIONS = Object.freeze([
  "database_identity",
  "schemas",
  "relations",
  "sequences",
  "functions",
  "triggers",
  "extensions",
  "roles",
  "role_memberships",
  "object_ownership",
  "object_acls",
  "default_acls",
]);
const EXPECTED_IAM_DATABASE_USER_LABELS = Object.freeze([
  "audit",
  "content_api",
  "engagement_api",
  "financial_api",
  "identity_api",
  "investor_api",
  "migration",
  "rollback",
  "webhooks",
  "worker",
]);
const EXPECTED_TARGET_ROLE_LABELS = Object.freeze([
  "hushh_tech_schema_owner",
  "hushh_tech_migration",
  "hushh_tech_runtime",
  "hushh_tech_audit",
  "hushh_tech_rollback",
]);
const EXPECTED_AUDIT_DB_USERNAME = "hushh-tech-audit-uat@hushh-tech-uat.iam";
const SECRET_OR_PRINCIPAL_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~-]{12,}/i,
  /\b(?:postgres(?:ql)?|https?|wss?):\/\//i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:sk_live_|sk_test_|sb_secret_|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /@/,
]);

function fail(code, message) {
  throw new MigrationContractError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_TARGET_ATTESTATION", `${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail("INVALID_TARGET_ATTESTATION", `${label} has an unexpected field set.`);
  }
}

function assertExactArray(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    fail("INVALID_TARGET_ATTESTATION", `${label} does not match the locked order.`);
  }
}

function assertSha(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) {
    fail("INVALID_TARGET_ATTESTATION", `${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertNoSecretOrPrincipalMaterial(value) {
  const serialized = JSON.stringify(value).replaceAll(
    EXPECTED_AUDIT_DB_USERNAME,
    "REVIEWED_AUDIT_DB_USERNAME"
  );
  for (const pattern of SECRET_OR_PRINCIPAL_PATTERNS) {
    if (pattern.test(serialized)) {
      fail(
        "SENSITIVE_TARGET_ATTESTATION",
        "The checked-in attestation contains a credential, endpoint, IP address, or full principal."
      );
    }
  }
}

function validateReviewedInVpcRemedy(remedy) {
  assertExactKeys(
    remedy,
    [
      "status",
      "roleLabel",
      "iamDatabaseUsername",
      "existingIamDatabaseUser",
      "cloudSqlClient",
      "cloudSqlInstanceUser",
      "iamOrNetworkChangeRequiredForEvidenceRecord",
      "requiredExecutionBoundary",
    ],
    "reviewed in-VPC remedy"
  );
  if (
    remedy.status !== "NOT_EXECUTED" ||
    remedy.roleLabel !== "audit" ||
    remedy.iamDatabaseUsername !== EXPECTED_AUDIT_DB_USERNAME ||
    remedy.existingIamDatabaseUser !== true ||
    remedy.cloudSqlClient !== true ||
    remedy.cloudSqlInstanceUser !== true ||
    remedy.iamOrNetworkChangeRequiredForEvidenceRecord !== false ||
    remedy.requiredExecutionBoundary !==
      "PREEXISTING_IN_VPC_EXECUTOR_USING_REVIEWED_AUDIT_IDENTITY"
  ) {
    fail("UNSAFE_IN_VPC_REMEDY", "The reviewed audit-identity remedy boundary changed.");
  }
}

function validateQuery() {
  const queryBytes = readFileSync(QUERY_URL);
  const query = queryBytes.toString("utf8");
  if (sha256(queryBytes) !== EXPECTED_QUERY_SHA256) {
    fail("TARGET_ATTESTATION_QUERY_DRIFT", "The locked read-only attestation query has drifted.");
  }
  if (
    !query.includes("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;") ||
    !query.includes("SET LOCAL statement_timeout = '10s';") ||
    !query.includes("SET LOCAL lock_timeout = '1s';") ||
    !query.includes("SET LOCAL idle_in_transaction_session_timeout = '15s';") ||
    !query.trimEnd().endsWith("ROLLBACK;") ||
    /(^|\n)\s*COMMIT\s*;/i.test(query)
  ) {
    fail(
      "UNSAFE_TARGET_ATTESTATION_QUERY",
      "The target attestation query must stay repeatable-read, read-only, time-bounded, and rollback-only."
    );
  }
  const emittedCollections = [...query.matchAll(/'collection',\s*'([a-z_]+)'/g)].map(
    ([, name]) => name
  );
  assertExactArray(emittedCollections, EXPECTED_COLLECTIONS, "query collection order");
}

function validateSourceCompileEvidence(evidence) {
  const sourceBytes = readFileSync(SOURCE_COMPILE_EVIDENCE_URL);
  if (sha256(sourceBytes) !== EXPECTED_SOURCE_COMPILE_SHA256) {
    fail(
      "SOURCE_COMPILE_EVIDENCE_DRIFT",
      "The byte-stable PR 1965 compile evidence has drifted."
    );
  }
  const source = JSON.parse(sourceBytes.toString("utf8"));
  assertExactArray(
    source.plan?.execution?.blockers,
    EXPECTED_COMPILE_BLOCKERS,
    "source compile blockers"
  );
  if (
    evidence.compileBlockerDisposition.source !== EXPECTED_SOURCE_COMPILE_PATH ||
    evidence.compileBlockerDisposition.sourceSha256 !== EXPECTED_SOURCE_COMPILE_SHA256
  ) {
    fail(
      "SOURCE_COMPILE_EVIDENCE_DRIFT",
      "The attestation does not bind the immutable PR 1965 evidence."
    );
  }
}

function validateAdminApiFacts(admin) {
  assertExactKeys(
    admin,
    [
      "status",
      "instanceCanonicalSha256",
      "databaseInventoryCanonicalSha256",
      "iamDatabaseUsersCanonicalSha256",
      "instance",
      "databases",
      "iamDatabaseUsers",
    ],
    "Cloud SQL Admin API evidence"
  );
  if (admin.status !== "ATTESTED") {
    fail("INVALID_TARGET_ATTESTATION", "Cloud SQL Admin API status must remain ATTESTED.");
  }
  for (const [key, value] of Object.entries(admin)) {
    if (key.endsWith("Sha256")) assertSha(value, key);
  }
  for (const [key, expected] of Object.entries(EXPECTED_ADMIN_API_DIGESTS)) {
    if (admin[key] !== expected) {
      fail(
        "TARGET_ADMIN_API_DIGEST_DRIFT",
        `${key} does not match the independently pinned live-read digest.`
      );
    }
  }
  assertExactKeys(
    admin.instance,
    [
      "name",
      "project",
      "region",
      "zone",
      "databaseVersion",
      "state",
      "availabilityType",
      "activationPolicy",
      "privateNetworkConfigured",
      "publicIpv4Enabled",
      "observedIpAddressTypes",
      "sslMode",
      "requireSslLegacyFlag",
      "backupEnabled",
      "pointInTimeRecoveryEnabled",
      "transactionLogRetentionDays",
      "storageAutoResize",
      "storageAutoResizeLimitGb",
      "dataDiskType",
      "dataDiskSizeGb",
      "deletionProtectionEnabled",
      "iamDatabaseAuthenticationEnabled",
      "serverCaPresent",
    ],
    "instance facts"
  );
  const expectedInstance = {
    name: "hushh-tech-app-pg-uat",
    project: "hushh-tech-uat",
    region: "us-central1",
    zone: "us-central1-a",
    databaseVersion: "POSTGRES_17",
    state: "RUNNABLE",
    availabilityType: "ZONAL",
    activationPolicy: "ALWAYS",
    privateNetworkConfigured: true,
    publicIpv4Enabled: false,
    observedIpAddressTypes: ["PRIVATE"],
    sslMode: "ENCRYPTED_ONLY",
    requireSslLegacyFlag: false,
    backupEnabled: true,
    pointInTimeRecoveryEnabled: true,
    transactionLogRetentionDays: 7,
    storageAutoResize: true,
    storageAutoResizeLimitGb: 0,
    dataDiskType: "PD_SSD",
    dataDiskSizeGb: 20,
    deletionProtectionEnabled: false,
    iamDatabaseAuthenticationEnabled: true,
    serverCaPresent: true,
  };
  if (canonicalHash(admin.instance) !== canonicalHash(expectedInstance)) {
    fail("TARGET_INSTANCE_FACT_DRIFT", "The UAT Cloud SQL instance facts changed.");
  }
  const expectedDatabases = [
    { name: "hushh_tech_app", charset: "UTF8", collation: "en_US.UTF8" },
    { name: "postgres", charset: "UTF8", collation: "en_US.UTF8" },
  ];
  if (canonicalHash(admin.databases) !== canonicalHash(expectedDatabases)) {
    fail("TARGET_DATABASE_FACT_DRIFT", "The UAT Cloud SQL database inventory changed.");
  }
  assertExactKeys(
    admin.iamDatabaseUsers,
    ["type", "count", "reviewedRoleLabels"],
    "IAM database user facts"
  );
  if (
    admin.iamDatabaseUsers.type !== "CLOUD_IAM_SERVICE_ACCOUNT" ||
    admin.iamDatabaseUsers.count !== 10
  ) {
    fail("TARGET_IAM_DATABASE_USER_DRIFT", "The IAM database user inventory changed.");
  }
  assertExactArray(
    admin.iamDatabaseUsers.reviewedRoleLabels,
    EXPECTED_IAM_DATABASE_USER_LABELS,
    "IAM database user labels"
  );
}

function validateBlockedCatalog(catalog) {
  assertExactKeys(
    catalog,
    [
      "status",
      "targetEmptyAndSafe",
      "systemIdentifier",
      "serverVersionNum",
      "transactionReadOnlyObserved",
      "query",
      "connectionAttempt",
      "accessFacts",
      "blockers",
      "collections",
    ],
    "catalog attestation"
  );
  if (
    catalog.status !== "BLOCKED" ||
    catalog.targetEmptyAndSafe !== "NOT_PROVEN" ||
    catalog.systemIdentifier !== null ||
    catalog.serverVersionNum !== null ||
    catalog.transactionReadOnlyObserved !== false
  ) {
    fail("FALSE_CATALOG_CLAIM", "Blocked catalog evidence must make zero database catalog claims.");
  }
  assertExactKeys(
    catalog.query,
    [
      "path",
      "sha256",
      "transaction",
      "statementTimeoutMs",
      "lockTimeoutMs",
      "idleInTransactionTimeoutMs",
    ],
    "catalog query binding"
  );
  if (
    catalog.query.path !== "migration/sql/target_cloudsql_attestation_read_only.sql" ||
    catalog.query.sha256 !== EXPECTED_QUERY_SHA256 ||
    catalog.query.transaction !== "REPEATABLE_READ_READ_ONLY_ROLLBACK" ||
    catalog.query.statementTimeoutMs !== 10_000 ||
    catalog.query.lockTimeoutMs !== 1_000 ||
    catalog.query.idleInTransactionTimeoutMs !== 15_000
  ) {
    fail("TARGET_ATTESTATION_QUERY_DRIFT", "The catalog query binding changed.");
  }
  assertExactKeys(
    catalog.connectionAttempt,
    ["method", "result", "authenticationEvaluated", "rawOutputRetained"],
    "connection attempt"
  );
  if (
    catalog.connectionAttempt.method !== "CLOUD_SQL_AUTH_PROXY_AUTO_IAM_PRIVATE_IP" ||
    catalog.connectionAttempt.result !== "PRIVATE_NETWORK_PATH_UNAVAILABLE" ||
    catalog.connectionAttempt.authenticationEvaluated !== false ||
    catalog.connectionAttempt.rawOutputRetained !== false
  ) {
    fail("FALSE_CONNECTION_CLAIM", "The fail-closed connection result changed.");
  }
  assertExactKeys(
    catalog.accessFacts,
    [
      "currentOperatorIsExistingIamDatabaseUser",
      "existingIamDatabaseUserCount",
      "impersonableExistingIamDatabaseUserCount",
      "userRoleGrantOrPasswordMutationAttempted",
    ],
    "catalog access facts"
  );
  if (
    catalog.accessFacts.currentOperatorIsExistingIamDatabaseUser !== false ||
    catalog.accessFacts.existingIamDatabaseUserCount !== 10 ||
    catalog.accessFacts.impersonableExistingIamDatabaseUserCount !== 0 ||
    catalog.accessFacts.userRoleGrantOrPasswordMutationAttempted !== false
  ) {
    fail("FALSE_ACCESS_CLAIM", "The fail-closed database access facts changed.");
  }
  assertExactArray(
    catalog.blockers,
    [
      "PRIVATE_NETWORK_PATH_UNAVAILABLE_FROM_OPERATOR_HOST",
      "CURRENT_OPERATOR_NOT_EXISTING_IAM_DATABASE_USER",
      "NO_EXISTING_IMPERSONATION_PERMISSION_FOR_IAM_DATABASE_USERS",
    ],
    "catalog blockers"
  );
  if (!Array.isArray(catalog.collections) || catalog.collections.length !== EXPECTED_COLLECTIONS.length) {
    fail("INVALID_TARGET_ATTESTATION", "All catalog result slots must be present.");
  }
  for (const [index, collection] of catalog.collections.entries()) {
    assertExactKeys(collection, ["name", "status", "rowCount", "sha256"], "catalog result slot");
    if (
      collection.name !== EXPECTED_COLLECTIONS[index] ||
      collection.status !== "NOT_CAPTURED" ||
      collection.rowCount !== null ||
      collection.sha256 !== null
    ) {
      fail("FALSE_CATALOG_CLAIM", "A blocked catalog result slot contains an attested value.");
    }
  }
}

function validateRoleAndGrantBoundary(roleEvidence) {
  assertExactKeys(
    roleEvidence,
    [
      "status",
      "reviewedTargetRoleLabels",
      "flags",
      "memberships",
      "ownership",
      "databaseTemporaryPrivilege",
      "bypassRls",
      "createRole",
      "superuser",
      "login",
      "grants",
    ],
    "role and grant boundary"
  );
  assertExactArray(
    roleEvidence.reviewedTargetRoleLabels,
    EXPECTED_TARGET_ROLE_LABELS,
    "target role labels"
  );
  if (roleEvidence.status !== "NOT_ATTESTED") {
    fail("FALSE_ROLE_CLAIM", "Database role and grant status must remain NOT_ATTESTED.");
  }
  for (const [key, value] of Object.entries(roleEvidence)) {
    if (key !== "status" && key !== "reviewedTargetRoleLabels" && value !== null) {
      fail("FALSE_ROLE_CLAIM", "Blocked role and grant fields must stay null.");
    }
  }
}

function validateCleanup(cleanup) {
  assertExactKeys(
    cleanup,
    [
      "verifiedAt",
      "proxyProcessCountAfter",
      "temporaryProxyDirectoryCountAfter",
      "temporaryCredentialFilesCreated",
      "temporaryCredentialFilesPresentAfter",
      "rawPsqlOutputRetained",
    ],
    "cleanup evidence"
  );
  if (
    !ISO_UTC_PATTERN.test(cleanup.verifiedAt) ||
    cleanup.proxyProcessCountAfter !== 0 ||
    cleanup.temporaryProxyDirectoryCountAfter !== 0 ||
    cleanup.temporaryCredentialFilesCreated !== 0 ||
    cleanup.temporaryCredentialFilesPresentAfter !== 0 ||
    cleanup.rawPsqlOutputRetained !== false
  ) {
    fail("INCOMPLETE_TARGET_ATTESTATION_CLEANUP", "Proxy and credential cleanup is incomplete.");
  }
}

export function validateTargetCloudSqlAttestation(evidence) {
  assertExactKeys(
    evidence,
    [
      "version",
      "capturedAt",
      "mode",
      "sourcePr",
      "target",
      "cloudSqlAdminApi",
      "catalogAttestation",
      "roleAndGrantAttestation",
      "reviewedInVpcRemedy",
      "cleanup",
      "compileBlockerDisposition",
      "evidenceSha256",
    ],
    "target Cloud SQL attestation"
  );
  if (
    evidence.version !== 1 ||
    !ISO_UTC_PATTERN.test(evidence.capturedAt) ||
    evidence.mode !== "LIVE_READ_ONLY_PARTIAL_ATTESTATION"
  ) {
    fail("INVALID_TARGET_ATTESTATION", "The target attestation header is invalid.");
  }
  if (
    evidence.sourcePr?.number !== 1965 ||
    evidence.sourcePr?.headSha !== "0276f9742428bb0868e288e8fa7a08287499a742"
  ) {
    fail("TARGET_ATTESTATION_BASE_DRIFT", "The attestation must bind exact PR 1965 head.");
  }
  const expectedTarget = {
    environment: "uat",
    project: "hushh-tech-uat",
    region: "us-central1",
    instance: "hushh-tech-app-pg-uat",
    database: "hushh_tech_app",
    postgresMajor: 17,
  };
  if (canonicalHash(evidence.target) !== canonicalHash(expectedTarget)) {
    fail("TARGET_ATTESTATION_BOUNDARY", "The attestation is outside the locked UAT target.");
  }
  validateQuery();
  validateSourceCompileEvidence(evidence);
  validateAdminApiFacts(evidence.cloudSqlAdminApi);
  validateBlockedCatalog(evidence.catalogAttestation);
  validateRoleAndGrantBoundary(evidence.roleAndGrantAttestation);
  validateReviewedInVpcRemedy(evidence.reviewedInVpcRemedy);
  validateCleanup(evidence.cleanup);

  const disposition = evidence.compileBlockerDisposition;
  assertExactKeys(
    disposition,
    [
      "source",
      "sourceSha256",
      "sourceBlockers",
      "closedByThisAttestation",
      "remaining",
      "liveTargetAttestationProgress",
    ],
    "compile blocker disposition"
  );
  assertExactArray(disposition.sourceBlockers, EXPECTED_COMPILE_BLOCKERS, "source blockers");
  assertExactArray(disposition.closedByThisAttestation, [], "closed blockers");
  assertExactArray(disposition.remaining, EXPECTED_COMPILE_BLOCKERS, "remaining blockers");
  if (disposition.liveTargetAttestationProgress !== "INSTANCE_CONFIG_ONLY_CATALOG_BLOCKED") {
    fail("FALSE_BLOCKER_CLAIM", "The live target catalog blocker must remain open.");
  }

  assertSha(evidence.evidenceSha256, "evidenceSha256");
  const { evidenceSha256, ...hashPayload } = evidence;
  if (canonicalHash(hashPayload) !== evidenceSha256) {
    fail("TARGET_ATTESTATION_HASH_MISMATCH", "The sanitized attestation root hash is invalid.");
  }
  assertNoSecretOrPrincipalMaterial(evidence);
  return Object.freeze({
    valid: true,
    state: evidence.mode,
    catalogStatus: evidence.catalogAttestation.status,
    blockerCount: evidence.compileBlockerDisposition.remaining.length,
    evidenceSha256,
  });
}

function main() {
  const evidence = JSON.parse(readFileSync(EVIDENCE_URL, "utf8"));
  const result = validateTargetCloudSqlAttestation(evidence);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
