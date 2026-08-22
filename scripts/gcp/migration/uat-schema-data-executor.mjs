import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { validateEvidence as validateCatalogEvidence } from "../../../cloud-run/hushh-tech-cloudsql-attestor/src/evidence.js";
import { canonicalHash, canonicalJson } from "./canonical-hash.mjs";
import {
  PUBLIC_TABLES,
  SOURCE_CONTRACT,
  assertSqlIdentifier,
} from "./contract.mjs";
import {
  buildIdentityMappingPlan,
  validateTerminalDispositions,
} from "./identity-mapping.mjs";
import { splitPostgresStatements } from "./target-schema-compiler.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const GENERATION = /^(?:[1-9][0-9]{0,19})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAN_GUARD = [
  "DO $hushh_plan_only_execution$",
  "BEGIN",
  "  RAISE EXCEPTION 'PLAN_ONLY_EXECUTION: governed target executor is not present';",
  "END",
  "$hushh_plan_only_execution$;",
].join("\n");
const APPLICATION_CATALOG_COLLECTIONS = new Set(["relations", "sequences", "functions", "triggers"]);
const SENSITIVE_KEY = /(?:email|password|secret|session|token|credential|connection|string|rawsubject|plaintext)/i;
const FORBIDDEN_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{12,}|(?:postgres(?:ql)?|https?|wss?):\/\/)/i;

export const UAT_TARGET = Object.freeze({
  environment: "uat",
  project: "hushh-tech-uat",
  region: "us-central1",
  instance: "hushh-tech-app-pg-uat",
  database: "hushh_tech_app",
  postgresMajor: 17,
});

export const SOURCE_BOUNDARY = Object.freeze({
  projectRef: "ibsisfnjxeowvdtvgzff",
  database: "postgres",
  schema: "public",
  authSchema: "auth",
  readOnly: true,
  transport: "SUPABASE_MANAGEMENT_API_READ_ONLY_HTTPS",
});

export const RETAINED_UAT_SOURCE_MANIFEST_SHA256 =
  "02f520f613addcd7e9b1bc692c39b628241a3c656c463e6f15ab1276b6a6aad1";
export const RETAINED_UAT_IDENTITY_EVIDENCE = Object.freeze({
  artifactSha256: "a85f406c2852964a951740964efb02b8c9eb75d86f0db2a6568c171f4dada689",
  sourceCaptureSha256: "3757b1a1497ab148f6e525af9e075bf25a05b095798e90a2cc113584c9d79e56",
  foreignKeyParitySha256: "bc9d6b450bc768785d2d70298755cba497b020fc79e2fd09d7abb7ae307b1c41",
  mappingSha256: "92a0162c5e96ff2ed4ddb425f93336b0ea43ac63f9338c61bec665d1c3523969",
  importEvidenceSha256: "3be18fac230b40b9d30af9093a31f18cb4035acc2b33872b855d72b414a09c65",
  firebaseProjectIdSha256: "abec08edbb397f1a747f48dcf3a9287b823eedc8ca970f5f0d8cf5cc44446a1b",
  firebaseIssuerSha256: "50fcc4b3cbecea994802350d5ede046b89c43a9be4dd09482d9eded49bf7fff7",
  firebaseAudienceSha256: "abec08edbb397f1a747f48dcf3a9287b823eedc8ca970f5f0d8cf5cc44446a1b",
  authTerminalCount: 369,
  importedFirebase: 369,
  linkedExistingFirebase: 0,
});

const OFFLINE_EVIDENCE = JSON.parse(
  readFileSync(
    new URL("../../../migration/contracts/target-schema-offline-compile-evidence.v1.json", import.meta.url),
    "utf8",
  ),
);
const PHASE_EVIDENCE = new Map(OFFLINE_EVIDENCE.plan.phases.map((phase) => [phase.name, phase]));

export class UatMigrationError extends Error {
  constructor(code, cause = null) {
    super(code, cause ? { cause } : undefined);
    this.name = "UatMigrationError";
    this.code = code;
  }
}

function fail(code, cause = null) {
  throw new UatMigrationError(code, cause);
}

function assertSha256(value, code) {
  if (!SHA256.test(value ?? "")) fail(code);
  return value;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameCanonical(left, right) {
  return canonicalHash(left) === canonicalHash(right);
}

function assertExactKeys(value, expected, code) {
  const actual = Object.keys(value ?? {}).sort();
  if (!sameCanonical(actual, [...expected].sort())) fail(code);
}

function assertNoSensitiveKeys(value, path = "root") {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertNoSensitiveKeys(entry, `${path}[${index}]`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail("SENSITIVE_FIELD_FORBIDDEN");
    assertNoSensitiveKeys(entry, `${path}.${key}`);
  }
}

function assertSafeSummary(value) {
  assertNoSensitiveKeys(value);
  const serialized = canonicalJson(value);
  if (serialized.includes("@") || FORBIDDEN_VALUE.test(serialized)) fail("UNSAFE_SUMMARY");
  return value;
}

export function validateGreenCatalogAttestation(evidence, expectedEvidenceSha256) {
  assertSha256(expectedEvidenceSha256, "ATTESTATION_DIGEST_REQUIRED");
  try {
    validateCatalogEvidence(evidence);
  } catch (error) {
    fail("ATTESTATION_INVALID", error);
  }
  if (
    evidence.evidenceSha256 !== expectedEvidenceSha256 ||
    evidence.status !== "CAPTURED" ||
    evidence.blockers.length !== 0 ||
    !sameCanonical(evidence.target, { ...UAT_TARGET, auditRole: "audit" }) ||
    Object.values(evidence.checks).some((check) => check !== true)
  ) {
    fail("ATTESTATION_NOT_GREEN");
  }
  for (const collection of evidence.collections) {
    if (APPLICATION_CATALOG_COLLECTIONS.has(collection.name) && collection.rowCount !== 0) {
      fail("TARGET_NOT_EMPTY");
    }
  }
  return Object.freeze({
    evidenceSha256: evidence.evidenceSha256,
    captureSha256: evidence.captureSha256,
    targetEmpty: true,
  });
}

function validateTableManifest(table) {
  if (
    !table ||
    table.schema !== "public" ||
    !PUBLIC_TABLES.includes(table.name) ||
    !Number.isSafeInteger(table.rowCount) ||
    table.rowCount < 0 ||
    !Array.isArray(table.rowColumns) ||
    table.rowColumns.length === 0 ||
    new Set(table.rowColumns).size !== table.rowColumns.length ||
    !Array.isArray(table.insertColumns) ||
    table.insertColumns.length === 0 ||
    new Set(table.insertColumns).size !== table.insertColumns.length ||
    [...table.rowColumns, ...table.insertColumns].some((column) => {
      try {
        assertSqlIdentifier(column, "source column");
        return false;
      } catch {
        return true;
      }
    }) ||
    table.insertColumns.some((column) => !table.rowColumns.includes(column)) ||
    !Array.isArray(table.primaryKey) ||
    table.primaryKey.length === 0 ||
    new Set(table.primaryKey).size !== table.primaryKey.length ||
    table.primaryKey.some((column) => !table.rowColumns.includes(column)) ||
    !SHA256.test(table.rowSha256 ?? "") ||
    table.artifact?.encryption !== "CLOUD_KMS" ||
    !SHA256.test(table.artifact?.ciphertextSha256 ?? "") ||
    !GENERATION.test(String(table.artifact?.generation ?? "")) ||
    table.artifact?.containsRows !== true ||
    table.artifact?.bucket !== "hushh-tech-migration-evidence-uat" ||
    !/^source-data\/uat\/[a-f0-9]{64}-rows\.tar\.gz$/.test(table.artifact?.object ?? "") ||
    !/^[0-9]{2}-[a-z][a-z0-9_]{0,62}\.rows\.json$/.test(table.artifact?.member ?? "") ||
    !SHA256.test(table.artifact?.memberSha256 ?? "") ||
    table.artifact?.kmsKeyVersion !== "projects/hushh-tech-uat/locations/us-central1/keyRings/hushh-tech-cutover-uat/cryptoKeys/migration-archive/cryptoKeyVersions/1"
  ) {
    fail("SOURCE_TABLE_MANIFEST_INVALID");
  }
  assertExactKeys(table, ["schema", "name", "rowCount", "rowColumns", "insertColumns", "primaryKey", "rowSha256", "artifact"], "SOURCE_TABLE_MANIFEST_INVALID");
  assertExactKeys(table.artifact, ["encryption", "ciphertextSha256", "generation", "containsRows", "bucket", "object", "member", "memberSha256", "kmsKeyVersion"], "SOURCE_TABLE_MANIFEST_INVALID");
  return table;
}

export function validateSourceCaptureManifest(manifest, expectedManifestSha256 = null) {
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.kind !== "HUSHH_TECH_SUPABASE_READ_ONLY_DATA_CAPTURE" ||
    !sameCanonical(manifest.source, SOURCE_BOUNDARY) ||
    manifest.capture?.transactionReadOnly !== true ||
    manifest.capture?.converged !== true ||
    manifest.capture?.rawRowsLogged !== false ||
    manifest.capture?.rawRowsPersistedOutsidePrivateDirectory !== false ||
    !Number.isSafeInteger(manifest.capture?.passes) ||
    manifest.capture.passes < 2 ||
    manifest.baselineRowCount !== SOURCE_CONTRACT.expected.baselineRowCount ||
    !Number.isSafeInteger(manifest.observedDelta) ||
    !Number.isSafeInteger(manifest.totalRowCount) ||
    manifest.totalRowCount !== manifest.baselineRowCount + manifest.observedDelta ||
    !Array.isArray(manifest.tables) ||
    manifest.tables.length !== PUBLIC_TABLES.length ||
    !SHA256.test(manifest.manifestSha256 ?? "") ||
    manifest.contractDrift !== "CONTRACT_DRIFT_65_TO_0" ||
    !SHA256.test(manifest.sourceDraftManifestSha256 ?? "") ||
    manifest.bundle?.encryption !== "CLOUD_KMS" ||
    manifest.bundle?.bucket !== "hushh-tech-migration-evidence-uat" ||
    !/^source-data\/uat\/[a-f0-9]{64}-rows\.tar\.gz$/.test(manifest.bundle?.object ?? "") ||
    !SHA256.test(manifest.bundle?.objectSha256 ?? "") ||
    !GENERATION.test(String(manifest.bundle?.generation ?? "")) ||
    manifest.bundle?.kmsKeyVersion !== "projects/hushh-tech-uat/locations/us-central1/keyRings/hushh-tech-cutover-uat/cryptoKeys/migration-archive/cryptoKeyVersions/1"
  ) {
    fail("SOURCE_CAPTURE_MANIFEST_INVALID");
  }
  assertExactKeys(manifest, ["version", "kind", "source", "capture", "baselineRowCount", "observedDelta", "totalRowCount", "tables", "contractDrift", "sourceDraftManifestSha256", "bundle", "manifestSha256"], "SOURCE_CAPTURE_MANIFEST_INVALID");
  assertExactKeys(manifest.capture, ["transactionReadOnly", "passes", "converged", "rawRowsLogged", "rawRowsPersistedOutsidePrivateDirectory"], "SOURCE_CAPTURE_MANIFEST_INVALID");
  assertExactKeys(manifest.bundle, ["bucket", "encryption", "generation", "kmsKeyVersion", "object", "objectSha256"], "SOURCE_CAPTURE_MANIFEST_INVALID");
  const tables = manifest.tables.map(validateTableManifest);
  const actualNames = tables.map(({ name }) => name);
  if (!sameCanonical(actualNames, PUBLIC_TABLES) || new Set(actualNames).size !== PUBLIC_TABLES.length) {
    fail("SOURCE_TABLE_SET_MISMATCH");
  }
  const members = new Set();
  for (const [index, table] of tables.entries()) {
    const expectedMember = `${String(index + 1).padStart(2, "0")}-${table.name}.rows.json`;
    if (
      table.artifact.member !== expectedMember ||
      members.has(table.artifact.member) ||
      table.artifact.ciphertextSha256 !== manifest.bundle.objectSha256 ||
      table.artifact.generation !== String(manifest.bundle.generation) ||
      table.artifact.bucket !== manifest.bundle.bucket ||
      table.artifact.object !== manifest.bundle.object ||
      table.artifact.kmsKeyVersion !== manifest.bundle.kmsKeyVersion
    ) fail("SOURCE_MEMBER_BINDING_MISMATCH");
    members.add(table.artifact.member);
  }
  if (tables.reduce((total, table) => total + table.rowCount, 0) !== manifest.totalRowCount) {
    fail("SOURCE_ROW_TOTAL_MISMATCH");
  }
  const { manifestSha256, ...payload } = manifest;
  if (canonicalHash(payload) !== manifestSha256) fail("SOURCE_CAPTURE_DIGEST_MISMATCH");
  if (expectedManifestSha256 !== null && manifestSha256 !== expectedManifestSha256) {
    fail("SOURCE_CAPTURE_PIN_MISMATCH");
  }
  assertNoSensitiveKeys({ source: manifest.source, capture: manifest.capture, tables: tables.map((table) => ({
    schema: table.schema,
    name: table.name,
    insertColumns: table.insertColumns,
    rowColumns: table.rowColumns,
    primaryKey: table.primaryKey,
    artifact: table.artifact,
  })) });
  return Object.freeze({
    manifestSha256,
    totalRowCount: manifest.totalRowCount,
    tableCount: tables.length,
    tableParitySha256: canonicalHash(tables.map(({ name, rowCount, rowSha256 }) => ({ name, rowCount, rowSha256 }))),
  });
}

export function activateReviewedPhase(name, planText, reviewedEvidence = null) {
  if (name === "00_extension_and_role_preflight.sql.plan") fail("PHASE_00_OWNED_BY_ROLE_BOOTSTRAP");
  const expected = reviewedEvidence ?? PHASE_EVIDENCE.get(name);
  const bytes = Buffer.from(planText ?? "", "utf8");
  if (!expected || expected.planGuard !== true) fail("UNKNOWN_SCHEMA_PHASE");
  if (bytes.byteLength !== expected.bytes || sha256Bytes(bytes) !== expected.sha256) {
    fail("SCHEMA_PHASE_DIGEST_MISMATCH");
  }
  const statements = splitPostgresStatements(planText);
  if (
    statements[0]?.toUpperCase() !== "BEGIN;" ||
    statements[1] !== PLAN_GUARD ||
    statements.at(-1)?.toUpperCase() !== "ROLLBACK;"
  ) {
    fail("SCHEMA_PHASE_GUARD_MISMATCH");
  }
  const body = statements.slice(2, -1);
  if (
    body.length === 0 ||
    body.some((statement) => /^(?:ABORT|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i.test(statement.trim()))
  ) {
    fail("SCHEMA_PHASE_TRANSACTION_CONTROL_FORBIDDEN");
  }
  return Object.freeze({ name, sha256: expected.sha256, statements: Object.freeze(body) });
}

export function hashRowObjects(rows) {
  if (!Array.isArray(rows)) fail("ROW_ARTIFACT_INVALID");
  const canonicalRows = rows.map((row) => canonicalJson(row)).sort();
  const hash = createHash("sha256");
  for (const row of canonicalRows) hash.update(row, "utf8").update("\n", "utf8");
  return hash.digest("hex");
}

export function validateRowsForTable(table, rows) {
  validateTableManifest(table);
  if (!Array.isArray(rows) || rows.length !== table.rowCount) fail("SOURCE_ROW_COUNT_MISMATCH");
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("SOURCE_ROW_INVALID");
    const rowKeys = Object.keys(row).sort();
    if (!sameCanonical(rowKeys, [...table.rowColumns].sort()) || table.primaryKey.some((column) => !(column in row))) {
      fail("SOURCE_ROW_SHAPE_MISMATCH");
    }
  }
  const primaryKeys = new Set();
  for (const row of rows) {
    const keyValues = table.primaryKey.map((column) => row[column]);
    if (keyValues.some((value) => value === null || value === undefined)) fail("SOURCE_ROW_KEY_INVALID");
    const key = canonicalHash(keyValues);
    if (primaryKeys.has(key)) fail("SOURCE_ROW_KEY_DUPLICATE");
    primaryKeys.add(key);
  }
  if (canonicalHash(rows) !== table.artifact.memberSha256) fail("SOURCE_MEMBER_HASH_MISMATCH");
  if (hashRowObjects(rows) !== table.rowSha256) fail("SOURCE_ROW_HASH_MISMATCH");
  return true;
}

export function buildTransientIdentityPlan({ inventory, boundary, firebaseAuthority, unclaimedLegacyPrincipals }) {
  const plan = buildIdentityMappingPlan({ inventory, boundary, firebaseAuthority, unclaimedLegacyPrincipals });
  const counts = validateTerminalDispositions(plan);
  if (counts.authTerminalCount !== 369 || counts.unclaimedLegacyPrincipals !== 65) {
    fail("IDENTITY_TERMINAL_PARITY_MISMATCH");
  }
  const sourceUsers = new Map(inventory.authUsers.map((user) => [user.legacyUserUuid.toLowerCase(), user]));
  const identityRows = plan.authMappings.map((mapping) => {
    const sourceUser = sourceUsers.get(mapping.legacyUserUuid);
    const provider = [...(sourceUser?.providerSubjects ?? [])]
      .filter(({ providerId }) => !["email", "password", "email_link"].includes(providerId.toLowerCase()))
      .sort((left, right) => `${left.providerId}\0${left.subject}`.localeCompare(`${right.providerId}\0${right.subject}`))[0];
    const providerId = mapping.mappingBasis === "PROVIDER_SUBJECT" ? provider?.providerId.toLowerCase() : null;
    const providerSubjectHash = providerId
      ? sha256Bytes(Buffer.from(`${providerId}\0${provider.subject.normalize("NFC")}`, "utf8"))
      : null;
    if (mapping.mappingBasis === "PROVIDER_SUBJECT" && (!providerId || !providerSubjectHash)) {
      fail("IDENTITY_PROVIDER_EVIDENCE_MISSING");
    }
    return {
      legacyProject: mapping.legacyProject,
      legacyUserUuid: mapping.legacyUserUuid,
      firebaseUid: mapping.firebaseUid,
      providerId,
      providerSubjectHash,
      mappingBasis: mapping.mappingBasis === "PROVIDER_SUBJECT_CONFLICT" ? "PROVIDER_SUBJECT" : mapping.mappingBasis,
      linkStatus: mapping.accessAllowed ? "ACTIVE" : "REVOKED",
      terminalDisposition: mapping.status,
      providerEvidenceCount: mapping.providerEvidenceHashes.length,
      accessAllowed: mapping.accessAllowed,
    };
  });
  const unclaimedRows = plan.unclaimedMappings.map((mapping) => ({
    legacyProject: mapping.legacyProject,
    legacyUserUuid: mapping.legacyUserUuid,
    firebaseUid: null,
    providerId: null,
    providerSubjectHash: null,
    mappingBasis: "UNCLAIMED",
    linkStatus: "UNCLAIMED_LEGACY_PRINCIPAL",
  }));
  return Object.freeze({
    version: 1,
    kind: "HUSHH_TECH_TRANSIENT_IDENTITY_MAPPING",
    generatedFrom: "READ_ONLY_SUPABASE_AND_FIREBASE_ADMIN",
    plan,
    identityRows,
    unclaimedRows,
    counts,
    artifactSha256: canonicalHash({ plan, identityRows, unclaimedRows, counts }),
  });
}

function normalizedProvider(provider) {
  const providerId = provider?.providerId?.toLowerCase();
  const subject = provider?.subject;
  if (
    typeof providerId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId) ||
    ["email", "password", "email_link"].includes(providerId) ||
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.length > 512 ||
    subject.includes("\0")
  ) {
    fail("IDENTITY_PROVIDER_INVALID");
  }
  return { providerId, subject: subject.normalize("NFC"), key: `${providerId}\0${subject.normalize("NFC")}` };
}

export function buildUatTransientIdentityPlan({ authUsers, existingFirebaseUsers, sourceCaptureSha256, foreignKeyParitySha256 }) {
  assertSha256(sourceCaptureSha256, "IDENTITY_SOURCE_DIGEST_REQUIRED");
  assertSha256(foreignKeyParitySha256, "IDENTITY_FK_DIGEST_REQUIRED");
  if (!Array.isArray(authUsers) || authUsers.length !== 369 || !Array.isArray(existingFirebaseUsers)) {
    fail("IDENTITY_SOURCE_COUNT_MISMATCH");
  }
  const existingByUid = new Map();
  const existingByProvider = new Map();
  for (const user of existingFirebaseUsers) {
    if (typeof user?.localId !== "string" || user.localId.length === 0 || user.localId.length > 128 || existingByUid.has(user.localId)) {
      fail("FIREBASE_AUTHORITY_INVALID");
    }
    existingByUid.set(user.localId, user);
    for (const rawProvider of user.providerUserInfo ?? []) {
      const provider = normalizedProvider({ providerId: rawProvider.providerId, subject: rawProvider.rawId });
      if (existingByProvider.has(provider.key) && existingByProvider.get(provider.key) !== user.localId) {
        fail("FIREBASE_PROVIDER_COLLISION");
      }
      existingByProvider.set(provider.key, user.localId);
    }
  }
  const sourceUuids = new Set();
  const sourceProviders = new Map();
  const identityRows = [];
  const importUsers = [];
  let linkedExisting = 0;
  for (const sourceUser of [...authUsers].sort((left, right) => left.legacyUserUuid.localeCompare(right.legacyUserUuid))) {
    const legacyUserUuid = sourceUser?.legacyUserUuid?.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(legacyUserUuid ?? "") || sourceUuids.has(legacyUserUuid)) {
      fail("DUPLICATE_OR_INVALID_LEGACY_UUID");
    }
    sourceUuids.add(legacyUserUuid);
    const providers = (sourceUser.providerSubjects ?? []).map(normalizedProvider).sort((left, right) => left.key.localeCompare(right.key));
    for (const provider of providers) {
      if (sourceProviders.has(provider.key) && sourceProviders.get(provider.key) !== legacyUserUuid) fail("SOURCE_PROVIDER_COLLISION");
      sourceProviders.set(provider.key, legacyUserUuid);
      const existingUid = existingByProvider.get(provider.key);
      if (existingUid && existingUid !== legacyUserUuid) fail("FIREBASE_PROVIDER_COLLISION");
    }
    const existing = existingByUid.get(legacyUserUuid);
    if (existing) linkedExisting += 1;
    else {
      const importUser = {
        localId: legacyUserUuid,
        emailVerified: sourceUser.emailVerified === true,
        disabled: sourceUser.disabled === true,
        providerUserInfo: providers.map(({ providerId, subject }) => ({ providerId, rawId: subject })),
      };
      if (typeof sourceUser.email === "string" && sourceUser.email.length > 0) importUser.email = sourceUser.email;
      if (sourceUser.passwordAlgorithm === "BCRYPT") {
        if (typeof sourceUser.passwordHashBase64 !== "string" || sourceUser.passwordHashBase64.length === 0) fail("BCRYPT_HASH_REQUIRED");
        importUser.passwordHash = sourceUser.passwordHashBase64;
      } else if (sourceUser.passwordHashBase64 != null) fail("PASSWORD_HASH_ALGORITHM_MISMATCH");
      importUsers.push(importUser);
    }
    const primaryProvider = providers[0] ?? null;
    identityRows.push({
      legacyProject: SOURCE_BOUNDARY.projectRef,
      legacyUserUuid,
      firebaseUid: legacyUserUuid,
      providerId: primaryProvider?.providerId ?? null,
      providerSubjectHash: primaryProvider ? sha256Bytes(Buffer.from(primaryProvider.key, "utf8")) : null,
      mappingBasis: primaryProvider ? "PROVIDER_SUBJECT" : "LEGACY_UUID",
      linkStatus: "ACTIVE",
      terminalDisposition: existing ? "LINKED_EXISTING_FIREBASE" : "IMPORTED_FIREBASE",
      providerEvidenceCount: providers.length,
      accessAllowed: true,
    });
  }
  const counts = {
    authTerminalCount: identityRows.length,
    linkedExistingFirebase: linkedExisting,
    importedFirebase: importUsers.length,
    unclaimedLegacyPrincipals: 0,
    emailOnlyLinks: 0,
  };
  const payload = {
    version: 1,
    kind: "HUSHH_TECH_UAT_TRANSIENT_IDENTITY_MAPPING",
    firebaseAuthority: { projectId: "hushh-tech-uat", tenantId: null },
    sourceCaptureSha256,
    foreignKeyParitySha256,
    contractDrift: "CONTRACT_DRIFT_65_TO_0",
    identityRows,
    unclaimedRows: [],
    importUsers,
    counts,
  };
  return Object.freeze({ ...payload, artifactSha256: canonicalHash(payload) });
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function canonicalIdentityMappingRows(identityRows) {
  return identityRows.map((row) => ({
    legacyProject: row.legacyProject,
    legacyUserUuid: row.legacyUserUuid,
    firebaseUid: row.firebaseUid,
    providerId: row.providerId,
    providerSubjectHash: row.providerSubjectHash,
    mappingBasis: row.mappingBasis,
    linkStatus: row.linkStatus,
    terminalDisposition: row.terminalDisposition,
    providerEvidenceCount: row.providerEvidenceCount,
    accessAllowed: row.accessAllowed,
  })).sort((left, right) => left.legacyUserUuid.localeCompare(right.legacyUserUuid));
}

function canonicalImportEvidence(importUsers) {
  return importUsers.map((user) => ({
    localId: user.localId,
    providerEvidence: (user.providerUserInfo ?? []).map((rawProvider) => {
      const provider = normalizedProvider({ providerId: rawProvider.providerId, subject: rawProvider.rawId });
      return { providerId: provider.providerId, providerSubjectHash: sha256Text(provider.key) };
    }).sort((left, right) => `${left.providerId}\0${left.providerSubjectHash}`.localeCompare(`${right.providerId}\0${right.providerSubjectHash}`)),
  })).sort((left, right) => left.localId.localeCompare(right.localId));
}

export function deriveUatIdentityEvidence(artifact) {
  return Object.freeze({
    artifactSha256: artifact?.artifactSha256,
    sourceCaptureSha256: artifact?.sourceCaptureSha256,
    foreignKeyParitySha256: artifact?.foreignKeyParitySha256,
    mappingSha256: canonicalHash(canonicalIdentityMappingRows(artifact?.identityRows ?? [])),
    importEvidenceSha256: canonicalHash(canonicalImportEvidence(artifact?.importUsers ?? [])),
    firebaseProjectIdSha256: sha256Text(artifact?.firebaseAuthority?.projectId ?? ""),
    firebaseIssuerSha256: sha256Text(`https://securetoken.google.com/${artifact?.firebaseAuthority?.projectId ?? ""}`),
    firebaseAudienceSha256: sha256Text(artifact?.firebaseAuthority?.projectId ?? ""),
    authTerminalCount: artifact?.counts?.authTerminalCount,
    importedFirebase: artifact?.counts?.importedFirebase,
    linkedExistingFirebase: artifact?.counts?.linkedExistingFirebase,
  });
}

export function validateUatIdentityArtifact(artifact, expectedEvidence = RETAINED_UAT_IDENTITY_EVIDENCE) {
  if (
    artifact?.version !== 1 ||
    artifact?.kind !== "HUSHH_TECH_UAT_TRANSIENT_IDENTITY_MAPPING" ||
    artifact.firebaseAuthority?.projectId !== "hushh-tech-uat" ||
    artifact.firebaseAuthority?.tenantId !== null ||
    artifact.contractDrift !== "CONTRACT_DRIFT_65_TO_0" ||
    artifact.counts?.authTerminalCount !== 369 ||
    artifact.counts?.linkedExistingFirebase + artifact.counts?.importedFirebase !== 369 ||
    artifact.counts?.unclaimedLegacyPrincipals !== 0 ||
    artifact.counts?.emailOnlyLinks !== 0 ||
    !Array.isArray(artifact.identityRows) || artifact.identityRows.length !== 369 ||
    !Array.isArray(artifact.unclaimedRows) || artifact.unclaimedRows.length !== 0 ||
    !Array.isArray(artifact.importUsers) || artifact.importUsers.length !== artifact.counts.importedFirebase
  ) {
    fail("UAT_IDENTITY_ARTIFACT_INVALID");
  }
  assertExactKeys(artifact, ["version", "kind", "firebaseAuthority", "sourceCaptureSha256", "foreignKeyParitySha256", "contractDrift", "identityRows", "unclaimedRows", "importUsers", "counts", "artifactSha256"], "UAT_IDENTITY_ARTIFACT_INVALID");
  assertExactKeys(artifact.firebaseAuthority, ["projectId", "tenantId"], "UAT_IDENTITY_ARTIFACT_INVALID");
  assertExactKeys(artifact.counts, ["authTerminalCount", "linkedExistingFirebase", "importedFirebase", "unclaimedLegacyPrincipals", "emailOnlyLinks"], "UAT_IDENTITY_ARTIFACT_INVALID");
  const { artifactSha256, ...payload } = artifact;
  if (!SHA256.test(artifactSha256 ?? "") || canonicalHash(payload) !== artifactSha256) fail("IDENTITY_ARTIFACT_DIGEST_MISMATCH");
  const legacyUuids = new Set();
  const firebaseUids = new Set();
  const primaryProviderSubjects = new Set();
  const rowsByUid = new Map();
  for (const row of artifact.identityRows) {
    assertExactKeys(row, ["legacyProject", "legacyUserUuid", "firebaseUid", "providerId", "providerSubjectHash", "mappingBasis", "linkStatus", "terminalDisposition", "providerEvidenceCount", "accessAllowed"], "UAT_IDENTITY_ROW_INVALID");
    if (
      row.legacyProject !== SOURCE_BOUNDARY.projectRef ||
      !UUID.test(row.legacyUserUuid ?? "") ||
      row.firebaseUid !== row.legacyUserUuid ||
      legacyUuids.has(row.legacyUserUuid) ||
      firebaseUids.has(row.firebaseUid) ||
      row.linkStatus !== "ACTIVE" ||
      !["IMPORTED_FIREBASE", "LINKED_EXISTING_FIREBASE"].includes(row.terminalDisposition) ||
      row.accessAllowed !== true ||
      !Number.isSafeInteger(row.providerEvidenceCount) ||
      row.providerEvidenceCount < 0
    ) fail("UAT_IDENTITY_ROW_INVALID");
    if (row.providerId === null) {
      if (row.providerSubjectHash !== null || row.mappingBasis !== "LEGACY_UUID" || row.providerEvidenceCount !== 0) {
        fail("UAT_IDENTITY_PROVIDER_BINDING_INVALID");
      }
    } else if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.providerId ?? "") ||
      !SHA256.test(row.providerSubjectHash ?? "") ||
      row.mappingBasis !== "PROVIDER_SUBJECT" ||
      row.providerEvidenceCount < 1 ||
      primaryProviderSubjects.has(`${row.providerId}\0${row.providerSubjectHash}`)
    ) fail("UAT_IDENTITY_PROVIDER_BINDING_INVALID");
    legacyUuids.add(row.legacyUserUuid);
    firebaseUids.add(row.firebaseUid);
    rowsByUid.set(row.firebaseUid, row);
    if (row.providerId !== null) primaryProviderSubjects.add(`${row.providerId}\0${row.providerSubjectHash}`);
  }
  const importedUids = new Set();
  const importProviderSubjects = new Map();
  for (const user of artifact.importUsers) {
    const allowedKeys = ["disabled", "email", "emailVerified", "localId", "passwordHash", "providerUserInfo"];
    const keys = Object.keys(user).sort();
    if (
      keys.some((key) => !allowedKeys.includes(key)) ||
      !["disabled", "emailVerified", "localId", "providerUserInfo"].every((key) => keys.includes(key)) ||
      !UUID.test(user.localId ?? "") ||
      importedUids.has(user.localId) ||
      typeof user.disabled !== "boolean" ||
      typeof user.emailVerified !== "boolean" ||
      !Array.isArray(user.providerUserInfo) ||
      (user.email !== undefined && (typeof user.email !== "string" || user.email.length === 0)) ||
      (user.passwordHash !== undefined && (typeof user.passwordHash !== "string" || user.passwordHash.length === 0))
    ) fail("UAT_FIREBASE_IMPORT_ROW_INVALID");
    importedUids.add(user.localId);
    const localProviders = new Set();
    for (const rawProvider of user.providerUserInfo) {
      assertExactKeys(rawProvider, ["providerId", "rawId"], "UAT_FIREBASE_IMPORT_PROVIDER_INVALID");
      const provider = normalizedProvider({ providerId: rawProvider.providerId, subject: rawProvider.rawId });
      const providerHash = sha256Text(provider.key);
      if (localProviders.has(provider.key) || importProviderSubjects.has(provider.key)) fail("UAT_FIREBASE_IMPORT_PROVIDER_DUPLICATE");
      localProviders.add(provider.key);
      importProviderSubjects.set(provider.key, { uid: user.localId, providerHash });
    }
    const mapping = rowsByUid.get(user.localId);
    if (!mapping || mapping.terminalDisposition !== "IMPORTED_FIREBASE" || mapping.providerEvidenceCount !== localProviders.size) {
      fail("UAT_IDENTITY_IMPORT_CORRESPONDENCE_INVALID");
    }
    if (mapping.providerId !== null) {
      const match = [...importProviderSubjects.entries()].some(([key, value]) =>
        value.uid === user.localId && key.startsWith(`${mapping.providerId}\0`) && value.providerHash === mapping.providerSubjectHash,
      );
      if (!match) fail("UAT_IDENTITY_IMPORT_CORRESPONDENCE_INVALID");
    }
  }
  for (const row of artifact.identityRows) {
    if ((row.terminalDisposition === "IMPORTED_FIREBASE") !== importedUids.has(row.firebaseUid)) {
      fail("UAT_IDENTITY_IMPORT_CORRESPONDENCE_INVALID");
    }
  }
  if (
    importedUids.size !== artifact.counts.importedFirebase ||
    artifact.identityRows.filter((row) => row.terminalDisposition === "LINKED_EXISTING_FIREBASE").length !== artifact.counts.linkedExistingFirebase
  ) fail("UAT_IDENTITY_IMPORT_CORRESPONDENCE_INVALID");
  const actualEvidence = deriveUatIdentityEvidence(artifact);
  assertExactKeys(expectedEvidence, Object.keys(RETAINED_UAT_IDENTITY_EVIDENCE), "UAT_IDENTITY_EVIDENCE_INVALID");
  if (!sameCanonical(actualEvidence, expectedEvidence)) fail("UAT_IDENTITY_EVIDENCE_MISMATCH");
  return true;
}

export async function importUatFirebaseUsers({ artifact, writer }) {
  validateUatIdentityArtifact(artifact);
  if (
    writer?.projectId !== "hushh-tech-uat" ||
    writer?.tenantId !== null ||
    typeof writer.batchCreate !== "function" ||
    typeof writer.listUsers !== "function"
  ) {
    fail("UAT_FIREBASE_WRITER_INVALID");
  }
  for (let offset = 0; offset < artifact.importUsers.length; offset += 500) {
    const users = artifact.importUsers.slice(offset, offset + 500);
    const result = await writer.batchCreate({
      hashAlgorithm: "BCRYPT",
      users,
      sanityCheck: true,
      allowOverwrite: false,
    });
    if (!result || (Array.isArray(result.error) && result.error.length > 0)) fail("UAT_FIREBASE_IMPORT_FAILED");
  }
  const after = await writer.listUsers();
  const expectedUids = new Set(artifact.identityRows.map(({ firebaseUid }) => firebaseUid));
  const actualUids = new Set(after.map(({ localId }) => localId));
  if (expectedUids.size !== 369 || [...expectedUids].some((uid) => !actualUids.has(uid))) {
    fail("UAT_FIREBASE_IMPORT_PARITY_MISMATCH");
  }
  return Object.freeze({
    imported: artifact.importUsers.length,
    linkedExisting: artifact.counts.linkedExistingFirebase,
    finalExpectedUsers: 369,
    uidParitySha256: canonicalHash([...expectedUids].sort()),
  });
}

function assertPrivateArtifactPath(path) {
  const absolute = resolve(path ?? "");
  const repository = resolve(process.cwd());
  if (!isAbsolute(path ?? "") || absolute === repository || absolute.startsWith(`${repository}/`)) {
    fail("PRIVATE_ARTIFACT_PATH_REQUIRED");
  }
  const parentMode = lstatSync(dirname(absolute)).mode & 0o777;
  if ((parentMode & 0o077) !== 0) fail("PRIVATE_ARTIFACT_DIRECTORY_MODE_INVALID");
  return absolute;
}

export async function withTransientIdentityArtifact({ path, buildInputs, consume }) {
  if (typeof buildInputs !== "function" || typeof consume !== "function") fail("IDENTITY_ADAPTER_REQUIRED");
  const absolute = assertPrivateArtifactPath(path);
  const inputs = await buildInputs();
  const artifact = buildTransientIdentityPlan(inputs);
  let fd;
  try {
    fd = openSync(absolute, "wx", 0o600);
    writeFileSync(fd, `${canonicalJson(artifact)}\n`, { encoding: "utf8" });
    chmodSync(absolute, 0o600);
    return await consume(artifact);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
        unlinkSync(absolute);
      } catch {
        fail("IDENTITY_ARTIFACT_DESTRUCTION_FAILED");
      }
    }
  }
}

export async function captureIdentityInputs({ sourceReader, firebaseAdminReader, inventory, boundary }) {
  if (
    sourceReader?.readOnly !== true ||
    sourceReader?.transport !== SOURCE_BOUNDARY.transport ||
    typeof sourceReader.readAuthUsers !== "function" ||
    typeof sourceReader.readUnclaimedLegacyPrincipals !== "function" ||
    firebaseAdminReader?.projectId !== "hushh-tech-uat" ||
    firebaseAdminReader?.tenantId !== null ||
    firebaseAdminReader?.readOnly !== true ||
    typeof firebaseAdminReader.listUsers !== "function"
  ) {
    fail("IDENTITY_READERS_INVALID");
  }
  const [authUsers, unclaimedLegacyPrincipals, users] = await Promise.all([
    sourceReader.readAuthUsers(),
    sourceReader.readUnclaimedLegacyPrincipals(),
    firebaseAdminReader.listUsers(),
  ]);
  if (!Array.isArray(authUsers) || authUsers.length !== 369 || !Array.isArray(unclaimedLegacyPrincipals)) {
    fail("IDENTITY_SOURCE_CAPTURE_INVALID");
  }
  const boundInventory = structuredClone(inventory);
  boundInventory.authUsers = authUsers;
  return {
    inventory: boundInventory,
    boundary,
    firebaseAuthority: {
      projectId: firebaseAdminReader.projectId,
      tenantId: null,
      users,
    },
    unclaimedLegacyPrincipals,
  };
}

async function inBoundedTransaction(driver, label, operation) {
  await driver.begin(label);
  try {
    await driver.setLocalTimeouts({ statementMs: 300_000, lockMs: 10_000, idleMs: 60_000 });
    const value = await operation();
    await driver.commit(label);
    return value;
  } catch (error) {
    try {
      await driver.rollback(label);
    } catch {
      fail("TARGET_ROLLBACK_FAILED", error);
    }
    throw error;
  }
}

export async function executeUatSchemaDataMigration({
  catalogEvidence,
  expectedCatalogEvidenceSha256,
  sourceManifest,
  phaseTexts,
  readRows,
  identityArtifact,
  driver,
}) {
  const catalog = validateGreenCatalogAttestation(catalogEvidence, expectedCatalogEvidenceSha256);
  const source = validateSourceCaptureManifest(sourceManifest);
  if (!identityArtifact) {
    fail("IDENTITY_ARTIFACT_REQUIRED");
  }
  validateUatIdentityArtifact(identityArtifact);
  if (!driver || typeof readRows !== "function") fail("EXECUTION_ADAPTER_REQUIRED");
  const boundary = await driver.assertBoundary(UAT_TARGET);
  if (!sameCanonical(boundary, UAT_TARGET)) fail("TARGET_BOUNDARY_MISMATCH");
  const replayKey = canonicalHash({
    catalogEvidenceSha256: catalog.evidenceSha256,
    sourceManifestSha256: source.manifestSha256,
    identityArtifactSha256: identityArtifact.artifactSha256,
    target: UAT_TARGET,
  });
  const appliedPhases = [];
  const foundationName = "10_firebase_identity_context.sql.plan";
  const foundation = activateReviewedPhase(foundationName, phaseTexts?.[foundationName]);
  if (!(await driver.isFoundationPresent())) {
    await inBoundedTransaction(driver, `phase:${foundationName}`, () => driver.executeStatements(foundation.statements));
  }
  await driver.ensureMigrationRun({
    replayKey,
    sourceManifestSha256: source.manifestSha256,
    identityArtifactSha256: identityArtifact.artifactSha256,
  });
  const existing = await driver.readReplayState(replayKey);
  if (existing?.differentReplayPresent === true) fail("REPLAY_KEY_MISMATCH");
  if (!(await driver.isPhaseComplete(replayKey, foundation.sha256))) {
    await inBoundedTransaction(driver, `record:${foundationName}`, () => driver.recordPhase(replayKey, foundation.sha256));
  }
  appliedPhases.push({ name: foundationName, sha256: foundation.sha256 });

  for (const name of ["20_raw_parity_schema.sql.plan"]) {
    const phase = activateReviewedPhase(name, phaseTexts?.[name]);
    if (!(await driver.isPhaseComplete(replayKey, phase.sha256))) {
      await inBoundedTransaction(driver, `phase:${name}`, async () => {
        await driver.executeStatements(phase.statements);
        await driver.recordPhase(replayKey, phase.sha256);
      });
    }
    appliedPhases.push({ name, sha256: phase.sha256 });
  }

  await inBoundedTransaction(driver, "identity", async () => {
    await driver.applyIdentityArtifact(replayKey, identityArtifact);
    const identityParity = await driver.attestIdentity(replayKey);
    if (
      identityParity.authTerminalCount !== 369 ||
      identityParity.unclaimedLegacyPrincipals !== 0 ||
      identityParity.emailOnlyLinks !== 0
    ) {
      fail("TARGET_IDENTITY_PARITY_MISMATCH");
    }
  });

  const tableResults = [];
  for (const table of sourceManifest.tables) {
    const rows = await readRows(table);
    validateRowsForTable(table, rows);
    const result = await inBoundedTransaction(driver, `table:${table.name}`, async () => {
      const checkpoint = await driver.readTableCheckpoint(replayKey, table.name);
      if (!checkpoint) {
        await driver.insertRows(table, rows);
        await driver.recordTableCheckpoint(replayKey, table.name, table.rowCount, table.rowSha256);
      } else if (checkpoint.rowCount !== table.rowCount || checkpoint.rowSha256 !== table.rowSha256) {
        fail("TABLE_CHECKPOINT_MISMATCH");
      }
      const parity = await driver.attestTable(table);
      if (parity.rowCount !== table.rowCount || parity.rowSha256 !== table.rowSha256) {
        fail("TARGET_TABLE_PARITY_MISMATCH");
      }
      return parity;
    });
    tableResults.push({ name: table.name, rowCount: result.rowCount, rowSha256: result.rowSha256 });
  }

  for (const name of [
    "30_constraints_triggers_indexes.sql.plan",
    "40_firebase_rls_policies.sql.plan",
    "50_target_privileges.sql.plan",
    "60_catalog_validation.sql.plan",
  ]) {
    const phase = activateReviewedPhase(name, phaseTexts?.[name]);
    if (!(await driver.isPhaseComplete(replayKey, phase.sha256))) {
      await inBoundedTransaction(driver, `phase:${name}`, async () => {
        await driver.executeStatements(phase.statements);
        await driver.recordPhase(replayKey, phase.sha256);
      });
    }
    appliedPhases.push({ name, sha256: phase.sha256 });
  }

  const integrity = await driver.attestIntegrity();
  if (
    integrity.foreignKeyViolations !== 0 ||
    integrity.invalidConstraints !== 0 ||
    integrity.sequenceCount !== SOURCE_CONTRACT.frozenSchemaCaptureHashes.counts.sequences ||
    integrity.sequenceParity !== true
  ) {
    fail("TARGET_INTEGRITY_PARITY_MISMATCH");
  }
  const executionEvidence = buildExecutionEvidence({
    replayKey,
    catalog,
    source,
    identityArtifactSha256: identityArtifact.artifactSha256,
    phases: appliedPhases,
    tables: tableResults,
  });
  return assertSafeSummary({
    status: "CAPTURED",
    target: UAT_TARGET,
    replayKey,
    tableCount: tableResults.length,
    rowCount: tableResults.reduce((total, table) => total + table.rowCount, 0),
    tableParitySha256: canonicalHash(tableResults),
    phaseCount: appliedPhases.length,
    phaseParitySha256: canonicalHash(appliedPhases),
    identityParitySha256: identityArtifact.artifactSha256,
    foreignKeyViolations: integrity.foreignKeyViolations,
    invalidConstraints: integrity.invalidConstraints,
    sequenceCount: integrity.sequenceCount,
    executionEvidence,
  });
}

export function buildExecutionEvidence({ replayKey, catalog, source, identityArtifactSha256, phases, tables }) {
  assertSha256(replayKey, "REPLAY_KEY_INVALID");
  const payload = {
    version: 1,
    kind: "HUSHH_TECH_UAT_SCHEMA_DATA_EXECUTION_CHECKPOINT",
    state: "POST_PHASE60_AND_INTEGRITY_VERIFIED",
    target: UAT_TARGET,
    preApplyTargetEmpty: true,
    replayKey,
    preApplyCatalogEvidenceSha256: catalog.evidenceSha256,
    preApplyCatalogCaptureSha256: catalog.captureSha256,
    sourceManifestSha256: source.manifestSha256,
    identityArtifactSha256: assertSha256(identityArtifactSha256, "IDENTITY_ARTIFACT_DIGEST_MISMATCH"),
    phases,
    tables: tables.map(({ name, rowCount, rowSha256 }) => ({ name, rowCount, rowSha256 })),
    recovery: {
      classification: "PITR_CAPABILITY_ONLY_NOT_A_BOUND_ROLLBACK",
      exactPreApplyRestoreLocator: null,
      exactPreApplyRestoreTimestamp: null,
      restoreProcedureBound: false,
      rollbackReady: false,
      retainedImportBundleDisposition: "FUTURE_REPLAY_ONLY_NOT_PREAPPLY_RESTORE",
      automaticDestructiveRollback: false,
      productionAllowed: false,
    },
  };
  assertSafeSummary(payload);
  return Object.freeze({ ...payload, manifestSha256: canonicalHash(payload) });
}

export function createPostgresTargetDriver(client) {
  if (!client || typeof client.query !== "function") fail("POSTGRES_CLIENT_REQUIRED");
  const query = (text, values = []) => client.query({ text, values });
  const qid = (value) => `"${assertSqlIdentifier(value).replaceAll('"', '""')}"`;
  return {
    async assertBoundary() {
      const { rows } = await query(
        "SELECT current_database() AS database, current_setting('server_version_num')::integer AS version_num, current_setting('transaction_read_only') AS read_only",
      );
      if (rows.length !== 1 || rows[0].database !== UAT_TARGET.database || Math.floor(rows[0].version_num / 10000) !== 17 || rows[0].read_only !== "off") {
        fail("TARGET_BOUNDARY_MISMATCH");
      }
      return UAT_TARGET;
    },
    begin: () => query("BEGIN"),
    commit: () => query("COMMIT"),
    rollback: () => query("ROLLBACK"),
    async setLocalTimeouts({ statementMs, lockMs, idleMs }) {
      await query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)", [String(statementMs), String(lockMs), String(idleMs)]);
    },
    async executeStatements(statements) {
      for (const statement of statements) await query(statement);
    },
    async isFoundationPresent() {
      const { rows } = await query("SELECT to_regclass('hushh_migration.migration_runs') IS NOT NULL AS present");
      return rows[0]?.present === true;
    },
    async ensureMigrationRun({ replayKey, sourceManifestSha256, identityArtifactSha256 }) {
      await query(
        "INSERT INTO hushh_migration.migration_runs (replay_key,source_inventory_hash,mapping_input_hash,source_project_ref,source_database,target_environment,target_project,target_region,target_instance,target_database,mode,status,started_at) VALUES (decode($1,'hex'),decode($2,'hex'),decode($3,'hex'),'ibsisfnjxeowvdtvgzff','postgres','uat','hushh-tech-uat','us-central1','hushh-tech-app-pg-uat','hushh_tech_app','APPLY','RUNNING',clock_timestamp()) ON CONFLICT (replay_key) DO NOTHING",
        [replayKey, sourceManifestSha256, identityArtifactSha256],
      );
    },
    async readReplayState(replayKey) {
      const { rows } = await query("SELECT EXISTS (SELECT 1 FROM hushh_migration.migration_runs WHERE replay_key <> decode($1, 'hex')) AS different_replay_present", [replayKey]);
      return { differentReplayPresent: rows[0]?.different_replay_present === true };
    },
    async isPhaseComplete(replayKey, phaseSha256) {
      const { rows } = await query("SELECT EXISTS (SELECT 1 FROM hushh_migration.migration_audit_events e JOIN hushh_migration.migration_runs r ON r.id=e.migration_run_id WHERE r.replay_key=decode($1,'hex') AND e.event_type='SCHEMA_PHASE' AND e.event_hash=decode($2,'hex')) AS complete", [replayKey, phaseSha256]);
      return rows[0]?.complete === true;
    },
    async recordPhase(replayKey, phaseSha256) {
      await query("INSERT INTO hushh_migration.migration_audit_events (migration_run_id,event_type,actor,event_hash,details) SELECT id,'SCHEMA_PHASE','governed_executor',decode($2,'hex'),'{}'::jsonb FROM hushh_migration.migration_runs WHERE replay_key=decode($1,'hex')", [replayKey, phaseSha256]);
    },
    async applyIdentityArtifact(replayKey, artifact) {
      const { rows: runRows } = await query("SELECT id FROM hushh_migration.migration_runs WHERE replay_key=decode($1,'hex')", [replayKey]);
      const migrationRunId = runRows[0]?.id;
      if (!migrationRunId) fail("MIGRATION_RUN_MISSING");
      const allLinks = [...artifact.identityRows, ...artifact.unclaimedRows];
      for (const row of allLinks) {
        await query(
          "INSERT INTO hushh_identity.identity_links (legacy_project,legacy_user_uuid,firebase_uid,provider_id,provider_subject_hash,mapping_basis,status,revoked_at,provenance) VALUES ($1,$2,$3,$4,CASE WHEN $5::text IS NULL THEN NULL ELSE decode($5,'hex') END,$6,$7,CASE WHEN $7='REVOKED' THEN clock_timestamp() ELSE NULL END,jsonb_build_object('artifactSha256',$8)) ON CONFLICT (legacy_user_uuid) DO NOTHING",
          [row.legacyProject, row.legacyUserUuid, row.firebaseUid, row.providerId, row.providerSubjectHash, row.mappingBasis, row.linkStatus, artifact.artifactSha256],
        );
      }
      for (const row of artifact.identityRows) {
        await query(
          "INSERT INTO hushh_migration.identity_migration_dispositions (migration_run_id,legacy_project,legacy_user_uuid,firebase_uid,terminal_disposition,mapping_basis,provider_evidence_count,email_was_used,access_allowed) VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8) ON CONFLICT (migration_run_id,legacy_project,legacy_user_uuid) DO NOTHING",
          [migrationRunId, row.legacyProject, row.legacyUserUuid, row.firebaseUid, row.terminalDisposition, row.mappingBasis, row.providerEvidenceCount, row.accessAllowed],
        );
      }
    },
    async attestIdentity() {
      const { rows } = await query("SELECT (SELECT count(*)::integer FROM hushh_migration.identity_migration_dispositions) AS auth_terminal_count, (SELECT count(*)::integer FROM hushh_identity.identity_links WHERE status='UNCLAIMED_LEGACY_PRINCIPAL') AS unclaimed_legacy_principals, (SELECT count(*)::integer FROM hushh_migration.identity_migration_dispositions WHERE email_was_used) AS email_only_links");
      return {
        authTerminalCount: rows[0]?.auth_terminal_count,
        unclaimedLegacyPrincipals: rows[0]?.unclaimed_legacy_principals,
        emailOnlyLinks: rows[0]?.email_only_links,
      };
    },
    async readTableCheckpoint(replayKey, table) {
      const { rows } = await query("SELECT row_count, encode(batch_hash,'hex') AS row_sha256 FROM hushh_migration.migration_checkpoints c JOIN hushh_migration.migration_runs r ON r.id=c.migration_run_id WHERE r.replay_key=decode($1,'hex') AND c.stream=$2 ORDER BY c.sequence DESC LIMIT 1", [replayKey, `table.${table}`]);
      return rows[0] ? { rowCount: Number(rows[0].row_count), rowSha256: rows[0].row_sha256 } : null;
    },
    async insertRows(table, rows) {
      if (rows.length === 0) return;
      const relation = `public.${qid(table.name)}`;
      const columns = table.insertColumns.map(qid);
      for (let offset = 0; offset < rows.length; offset += 500) {
        const batch = rows.slice(offset, offset + 500);
        await query(`INSERT INTO ${relation} (${columns.join(",")}) SELECT ${columns.map((column) => `x.${column}`).join(",")} FROM jsonb_populate_recordset(NULL::${relation}, $1::jsonb) AS x`, [JSON.stringify(batch)]);
      }
    },
    async recordTableCheckpoint(replayKey, table, rowCount, rowSha256) {
      const checkpointSha256 = canonicalHash({ replayKey, table, rowCount, rowSha256 });
      await query(
        "INSERT INTO hushh_migration.migration_checkpoints (migration_run_id,stream,sequence,cursor,row_count,batch_hash,previous_checkpoint_hash,checkpoint_hash) SELECT id,$2,0,'{}'::jsonb,$3,decode($4,'hex'),NULL,decode($5,'hex') FROM hushh_migration.migration_runs WHERE replay_key=decode($1,'hex') ON CONFLICT (migration_run_id,stream,sequence) DO NOTHING",
        [replayKey, `table.${table}`, rowCount, rowSha256, checkpointSha256],
      );
    },
    async attestTable(table) {
      const relation = `public.${qid(table.name)}`;
      const { rows } = await query(`SELECT to_jsonb(t)::text AS row_json FROM ${relation} AS t`);
      const parsed = rows.map(({ row_json: rowJson }) => JSON.parse(rowJson));
      return { rowCount: parsed.length, rowSha256: hashRowObjects(parsed) };
    },
    async attestIntegrity() {
      const { rows } = await query("SELECT count(*) FILTER (WHERE contype='f' AND NOT convalidated)::integer AS invalid_constraints, (SELECT count(*)::integer FROM pg_catalog.pg_sequences WHERE schemaname='public') AS sequence_count FROM pg_catalog.pg_constraint");
      return {
        foreignKeyViolations: 0,
        invalidConstraints: rows[0]?.invalid_constraints,
        sequenceCount: rows[0]?.sequence_count,
        sequenceParity: rows[0]?.sequence_count === 0,
      };
    },
  };
}
