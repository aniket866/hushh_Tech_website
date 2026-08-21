import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalJson } from "./canonical-hash.mjs";
import {
  CUSTOM_PUBLIC_FUNCTION_SIGNATURES,
  MigrationContractError,
  PUBLIC_TABLES,
  SOURCE_CONTRACT,
} from "./contract.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_QUERY_BYTES = 256 * 1024;
const QUERY_URL = new URL(
  "../../../migration/sql/source_schema_capture_read_only.sql",
  import.meta.url
);
const ROOT_KEYS = Object.freeze([
  "columns",
  "constraints",
  "custom_functions",
  "database_name",
  "enums",
  "extensions",
  "indexes",
  "policies",
  "publication_tables",
  "routine_grants",
  "schema_version",
  "sequences",
  "server_version_num",
  "source_project_ref",
  "table_grants",
  "tables",
  "triggers",
]);
const COLLECTION_CONTRACTS = Object.freeze({
  tables: {
    count: 70,
    keys: [
      "comment",
      "force_row_security",
      "kind",
      "name",
      "partition_bound",
      "partition_key",
      "reloptions",
      "row_security",
      "schema",
    ],
  },
  columns: {
    count: 1061,
    keys: [
      "collation",
      "comment",
      "default",
      "generated",
      "identity",
      "name",
      "not_null",
      "ordinal",
      "schema",
      "table",
      "type",
    ],
  },
  constraints: {
    count: 270,
    keys: [
      "deferrable",
      "definition",
      "initially_deferred",
      "name",
      "schema",
      "table",
      "type",
      "validated",
    ],
  },
  indexes: {
    count: 232,
    keys: [
      "clustered",
      "definition",
      "name",
      "primary",
      "ready",
      "replica_identity",
      "schema",
      "table",
      "unique",
      "valid",
    ],
  },
  triggers: {
    count: 24,
    keys: ["definition", "enabled", "name", "schema", "table"],
  },
  policies: {
    count: 118,
    keys: ["check", "command", "name", "permissive", "roles", "schema", "table", "using"],
  },
  custom_functions: {
    count: 24,
    keys: [
      "definition",
      "identity_arguments",
      "kind",
      "name",
      "parallel",
      "result",
      "schema",
      "security_definer",
      "volatility",
    ],
  },
  sequences: {
    count: 0,
    keys: [
      "cache_size",
      "cycle",
      "data_type",
      "increment",
      "maximum_value",
      "minimum_value",
      "name",
      "owner",
      "schema",
      "start_value",
    ],
    nullableWhenEmpty: true,
  },
  enums: {
    count: 12,
    keys: ["label", "name", "order", "schema"],
  },
  extensions: {
    count: 6,
    keys: ["name", "schema", "version"],
  },
  table_grants: {
    count: 1929,
    keys: ["grantable", "grantee", "privilege", "schema", "table"],
  },
  routine_grants: {
    count: 585,
    keys: ["grantable", "grantee", "privilege", "routine", "schema", "specific_name"],
  },
  publication_tables: {
    count: 3,
    keys: ["publication", "schema", "table"],
  },
});
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /postgres(?:ql)?:\/\/[^\s"']+/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:sk_live_|sk_test_|sb_secret_|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/i,
]);
const FORBIDDEN_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "bearertoken",
  "clientsecret",
  "connectionstring",
  "dsn",
  "encryptedpassword",
  "idtoken",
  "magiclink",
  "otp",
  "passwordhash",
  "privatekey",
  "refreshtoken",
  "servicerolekey",
  "sessiontoken",
  "signingkey",
]);

function fail(code, message) {
  throw new MigrationContractError(code, message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeDefinition(definition) {
  return definition
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/^ +| +$/g, "");
}

function definitionSha256(definition) {
  return sha256Bytes(Buffer.from(normalizeDefinition(definition), "utf8"));
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_SCHEMA_CAPTURE_SHAPE", `${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail("INVALID_SCHEMA_CAPTURE_SHAPE", `${label} has an unexpected field set.`);
  }
}

function assertNoSecretLikeMaterial(value) {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      fail("SECRET_SHAPED_CAPTURE_MATERIAL", "Schema capture contains secret-shaped material.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoSecretLikeMaterial);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
    if (FORBIDDEN_FIELD_NAMES.has(normalizedKey)) {
      fail("SECRET_SHAPED_CAPTURE_MATERIAL", "Schema capture contains a forbidden field name.");
    }
    assertNoSecretLikeMaterial(entry);
  }
}

function readRegularFile(path, maxBytes, label) {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
    fail("UNSAFE_CAPTURE_FILE", `${label} must be a bounded regular file, not a symlink.`);
  }
  return readFileSync(resolved);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("INVALID_SCHEMA_CAPTURE_JSON", `${label} must contain valid JSON.`);
  }
}

function normalizedCollection(capture, name, contract) {
  const raw = capture[name];
  const entries = raw === null && contract.nullableWhenEmpty ? [] : raw;
  if (!Array.isArray(entries) || entries.length !== contract.count) {
    fail(
      "SCHEMA_CAPTURE_COUNT_MISMATCH",
      `${name} does not match the locked live-schema count.`
    );
  }
  for (const entry of entries) {
    assertExactKeys(entry, contract.keys, `${name} entry`);
  }
  return entries;
}

function assertPublicTableReference(entry, collection, tableSet) {
  if (entry.schema !== "public" || !tableSet.has(entry.table)) {
    fail(
      "SCHEMA_CAPTURE_BOUNDARY_MISMATCH",
      `${collection} must reference one of the 70 public tables.`
    );
  }
}

function sanitizeCollections(capture) {
  const collections = Object.fromEntries(
    Object.entries(COLLECTION_CONTRACTS).map(([name, contract]) => [
      name,
      normalizedCollection(capture, name, contract),
    ])
  );
  const tableNames = collections.tables.map(({ name }) => name).sort(compareText);
  if (
    tableNames.length !== PUBLIC_TABLES.length ||
    tableNames.some((name, index) => name !== PUBLIC_TABLES[index]) ||
    new Set(tableNames).size !== tableNames.length ||
    collections.tables.some((entry) => entry.schema !== "public")
  ) {
    fail("SCHEMA_CAPTURE_TABLE_MISMATCH", "Capture must contain the exact 70 public tables.");
  }
  const tableSet = new Set(tableNames);
  for (const collection of ["columns", "constraints", "indexes", "triggers", "policies"]) {
    collections[collection].forEach((entry) =>
      assertPublicTableReference(entry, collection, tableSet)
    );
  }
  if (collections.sequences.some((entry) => entry.schema !== "public")) {
    fail("SCHEMA_CAPTURE_BOUNDARY_MISMATCH", "Sequences must stay inside public.");
  }
  if (collections.enums.some((entry) => entry.schema !== "public")) {
    fail("SCHEMA_CAPTURE_BOUNDARY_MISMATCH", "Enums must stay inside public.");
  }
  if (
    collections.table_grants.some(
      (entry) => entry.schema !== "public" || !tableSet.has(entry.table)
    ) ||
    collections.routine_grants.some((entry) => entry.schema !== "public") ||
    collections.publication_tables.some(
      (entry) => entry.schema !== "public" || !tableSet.has(entry.table)
    )
  ) {
    fail("SCHEMA_CAPTURE_BOUNDARY_MISMATCH", "Grants and publications must stay in public.");
  }

  const customFunctionDefinitionHashes = collections.custom_functions
    .map((entry) => {
      if (
        entry.schema !== "public" ||
        typeof entry.name !== "string" ||
        typeof entry.identity_arguments !== "string" ||
        typeof entry.result !== "string" ||
        typeof entry.definition !== "string" ||
        entry.definition.length === 0 ||
        entry.definition.length > 1_000_000 ||
        entry.definition.includes("\u0000")
      ) {
        fail("INVALID_CUSTOM_FUNCTION_CAPTURE", "Custom function capture is malformed.");
      }
      return {
        signature: `${entry.name}(${entry.identity_arguments})->${entry.result}`,
        definitionHash: definitionSha256(entry.definition),
      };
    })
    .sort((left, right) => compareText(left.signature, right.signature));
  const signatures = customFunctionDefinitionHashes.map(({ signature }) => signature);
  if (
    signatures.length !== CUSTOM_PUBLIC_FUNCTION_SIGNATURES.length ||
    signatures.some((signature, index) => signature !== CUSTOM_PUBLIC_FUNCTION_SIGNATURES[index]) ||
    new Set(signatures).size !== signatures.length
  ) {
    fail(
      "CUSTOM_FUNCTION_CAPTURE_MISMATCH",
      "Capture must contain the exact 24 custom public function signatures."
    );
  }

  const hashableCollections = {
    tables: collections.tables,
    columns: collections.columns,
    constraints: collections.constraints,
    indexes: collections.indexes,
    triggers: collections.triggers,
    policies: collections.policies,
    customFunctions: collections.custom_functions.map(({ definition, ...metadata }) => ({
      ...metadata,
      definitionHash: definitionSha256(definition),
    })),
    sequences: collections.sequences,
    enums: collections.enums,
    extensions: collections.extensions,
    tableGrants: collections.table_grants,
    routineGrants: collections.routine_grants,
    publicationTables: collections.publication_tables,
  };
  const collectionHashes = Object.fromEntries(
    Object.entries(hashableCollections).map(([name, entries]) => [
      name,
      canonicalHash(
        [...entries].sort((left, right) =>
          compareText(canonicalJson(left), canonicalJson(right))
        )
      ),
    ])
  );
  return { collectionHashes, customFunctionDefinitionHashes };
}

function validateReadOnlyQuery(queryBytes) {
  const query = queryBytes.toString("utf8");
  const statements = query
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    statements[0] !== "BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ;" ||
    statements.at(-1) !== "ROLLBACK;" ||
    (query.match(/\bBEGIN\b/g) ?? []).length !== 1 ||
    (query.match(/\bROLLBACK\b/g) ?? []).length !== 1 ||
    /\bCOMMIT\b/i.test(query) ||
    /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY)\b/im.test(
      query
    )
  ) {
    fail(
      "SCHEMA_CAPTURE_QUERY_NOT_READ_ONLY",
      "Capture query must be one read-only repeatable-read transaction ending in rollback."
    );
  }
}

export function buildSchemaCaptureEvidence({
  capture,
  captureBytes,
  rawEnvelope,
  rawEnvelopeBytes,
  queryBytes,
}) {
  assertExactKeys(capture, ROOT_KEYS, "schema capture");
  assertExactKeys(rawEnvelope, ["boundary", "rows", "warning"], "raw query envelope");
  if (
    !Array.isArray(rawEnvelope.rows) ||
    rawEnvelope.rows.length !== 1 ||
    !rawEnvelope.rows[0] ||
    Object.keys(rawEnvelope.rows[0]).length !== 1 ||
    canonicalJson(rawEnvelope.rows[0].schema_capture) !== canonicalJson(capture)
  ) {
    fail(
      "SCHEMA_CAPTURE_ENVELOPE_MISMATCH",
      "Raw query envelope must contain exactly the normalized schema capture."
    );
  }
  if (typeof rawEnvelope.boundary !== "string" || typeof rawEnvelope.warning !== "string") {
    fail("INVALID_SCHEMA_CAPTURE_SHAPE", "Raw query envelope metadata must be text.");
  }
  if (
    capture.schema_version !== 1 ||
    capture.source_project_ref !== SOURCE_CONTRACT.source.projectRef ||
    capture.database_name !== SOURCE_CONTRACT.source.database ||
    !Number.isSafeInteger(capture.server_version_num) ||
    Math.floor(capture.server_version_num / 10_000) !== 17
  ) {
    fail(
      "SCHEMA_CAPTURE_SOURCE_MISMATCH",
      "Capture does not match the locked Supabase PostgreSQL 17 source."
    );
  }
  assertNoSecretLikeMaterial(capture);
  assertNoSecretLikeMaterial(rawEnvelope);
  validateReadOnlyQuery(queryBytes);
  const { collectionHashes, customFunctionDefinitionHashes } = sanitizeCollections(capture);
  const customFunctionDefinitionsHash = canonicalHash(customFunctionDefinitionHashes);
  if (!SHA256_PATTERN.test(customFunctionDefinitionsHash)) {
    fail("INVALID_SCHEMA_CAPTURE_HASH", "Definition evidence must use SHA-256.");
  }
  return Object.freeze({
    version: 1,
    sourceProjectRef: capture.source_project_ref,
    database: capture.database_name,
    postgresMajor: 17,
    contents: "HASHES_COUNTS_AND_FUNCTION_SIGNATURES_ONLY",
    captureMode: "READ_ONLY_REPEATABLE_READ_ROLLBACK",
    sourceArtifacts: Object.freeze({
      normalizedCaptureSha256: sha256Bytes(captureBytes),
      canonicalCaptureSha256: canonicalHash(capture),
      rawQueryEnvelopeSha256: sha256Bytes(rawEnvelopeBytes),
      captureQuerySha256: sha256Bytes(queryBytes),
      repositoryStorage: "FORBIDDEN",
      encryptedSchemaDumpState: "CAPTURED_ENCRYPTED_REVIEWED",
    }),
    counts: Object.freeze(
      Object.fromEntries(
        Object.entries(COLLECTION_CONTRACTS).map(([name, contract]) => [name, contract.count])
      )
    ),
    collectionHashes: Object.freeze(collectionHashes),
    customFunctionDefinitionHashes: Object.freeze(customFunctionDefinitionHashes),
    customFunctionDefinitionsHash,
  });
}

function parseArgs(argv) {
  const args = Object.fromEntries(
    argv.map((argument) => {
      const match = /^--([a-z-]+)=(.+)$/.exec(argument);
      if (!match) fail("INVALID_ARGUMENT", "Arguments must use --name=/absolute/path form.");
      return [match[1], match[2]];
    })
  );
  const unexpected = Object.keys(args).filter(
    (name) => !["capture", "raw-envelope", "query"].includes(name)
  );
  if (!args.capture || !args["raw-envelope"] || unexpected.length > 0) {
    fail(
      "INVALID_ARGUMENT",
      "--capture and --raw-envelope are required; --query is optional."
    );
  }
  return args;
}

export function runSchemaCaptureEvidenceCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const captureBytes = readRegularFile(args.capture, MAX_CAPTURE_BYTES, "normalized capture");
  const rawEnvelopeBytes = readRegularFile(
    args["raw-envelope"],
    MAX_CAPTURE_BYTES,
    "raw query envelope"
  );
  const queryBytes = args.query
    ? readRegularFile(args.query, MAX_QUERY_BYTES, "capture query")
    : readFileSync(QUERY_URL);
  const evidence = buildSchemaCaptureEvidence({
    capture: parseJson(captureBytes, "normalized capture"),
    captureBytes,
    rawEnvelope: parseJson(rawEnvelopeBytes, "raw query envelope"),
    rawEnvelopeBytes,
    queryBytes,
  });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runSchemaCaptureEvidenceCli();
  } catch (error) {
    const code = error instanceof MigrationContractError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof Error ? error.message : "Schema evidence binding failed.";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
