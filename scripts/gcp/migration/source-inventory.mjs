import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalJson } from "./canonical-hash.mjs";
import {
  APPLICATION_RPC_SIGNATURES,
  CUSTOM_PUBLIC_FUNCTION_SIGNATURES,
  CUSTOM_TRIGGER_FUNCTION_SIGNATURES,
  MigrationContractError,
  PUBLIC_TABLES,
  SOURCE_CONTRACT,
  assertSqlIdentifier,
  isAllowlistedPublicTable,
} from "./contract.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_RAW_FIELDS = new Set([
  "passwordhash",
  "encryptedpassword",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "otp",
  "magiclink",
  "privatekey",
  "servicerolekey",
  "clientsecret",
  "apikey",
  "connectionstring",
  "dsn",
  "bearertoken",
  "idtoken",
  "encryptionkey",
  "signingkey",
]);
const FORBIDDEN_RAW_VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\//i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^\$2[aby]\$\d{2}\$/,
  /\b(?:eyJ|sk[_-]|sb_secret_)[A-Za-z0-9._-]{12,}\b/,
];
const SCHEMA_FACT_COLLECTIONS = Object.freeze([
  "foreignKeys",
  "checkConstraints",
  "indexes",
  "sequences",
  "triggers",
  "functions",
  "publicPolicies",
  "storagePolicies",
  "extensions",
  "grants",
]);
const CATALOG_COUNT_KEYS = Object.freeze([
  "publicTables",
  "columns",
  "foreignKeys",
  "checkConstraints",
  "indexes",
  "sequences",
  "triggers",
  "publicFunctionSignatures",
  "customPublicFunctions",
  "applicationRpcs",
  "customTriggerFunctions",
  "publicPolicies",
  "storagePolicies",
  "extensions",
  "grants",
  "authUsers",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../supabase/migrations/", import.meta.url)
);

function fail(code, message) {
  throw new MigrationContractError(code, message);
}

function assertNoRawSecrets(value, path = "inventory") {
  if (
    typeof value === "string" &&
    FORBIDDEN_RAW_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    fail("RAW_SECRET_FORBIDDEN", `${path} contains secret-shaped material.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
    if (FORBIDDEN_RAW_FIELDS.has(normalizedKey)) {
      fail(
        "RAW_SECRET_FORBIDDEN",
        `${path}.${key} must not enter the sanitized inventory contract.`
      );
    }
    assertNoRawSecrets(entry, `${path}.${key}`);
  }
}

function assertObjectShape(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_SCHEMA_FACT", `${label} must be a metadata object.`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    fail("UNEXPECTED_SCHEMA_FACT_FIELD", `${label} contains an unapproved metadata field.`);
  }
}

function assertBoundedText(value, label, { nullable = false, max = 100_000 } = {}) {
  if (nullable && value === null) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.includes("\u0000")
  ) {
    fail("INVALID_SCHEMA_FACT", `${label} must be bounded text without null bytes.`);
  }
}

function assertPublicTableReference(entry, label) {
  if (entry.schema !== "public" || !isAllowlistedPublicTable(entry.table)) {
    fail(
      "SCHEMA_FACT_OUTSIDE_ALLOWLIST",
      `${label} must reference one of the 70 allowlisted public tables.`
    );
  }
}

function validateColumn(column, tableName) {
  const keys = [
    "name",
    "ordinalPosition",
    "dataType",
    "udtSchema",
    "udtName",
    "nullable",
    "hasDefault",
    "defaultExpressionHash",
    "identity",
    "generated",
  ];
  assertObjectShape(column, keys, `${tableName} column`);
  assertSqlIdentifier(column.name, `${tableName} column`);
  if (!Number.isSafeInteger(column.ordinalPosition) || column.ordinalPosition < 1) {
    fail("INVALID_COLUMN_ORDINAL", `${tableName} column ordinalPosition must be positive.`);
  }
  for (const key of ["dataType", "udtSchema", "udtName"]) {
    assertBoundedText(column[key], `${tableName}.${column.name} ${key}`, { max: 256 });
  }
  for (const key of ["nullable", "hasDefault", "identity", "generated"]) {
    if (typeof column[key] !== "boolean") {
      fail("INVALID_COLUMN_METADATA", `${tableName}.${column.name} ${key} must be boolean.`);
    }
  }
  if (
    (column.hasDefault && !SHA256_PATTERN.test(column.defaultExpressionHash ?? "")) ||
    (!column.hasDefault && column.defaultExpressionHash !== null)
  ) {
    fail(
      "INVALID_DEFAULT_HASH",
      `${tableName}.${column.name} must bind default presence to a SHA-256 expression hash.`
    );
  }
}

function validateTableEntry(table) {
  assertObjectShape(
    table,
    ["schema", "name", "rowCount", "primaryKey", "columns"],
    "table"
  );
  if (table.schema !== "public" || typeof table.name !== "string") {
    fail("INVALID_TABLE_ENTRY", "Every source table must be a named public-schema table.");
  }
  if (!Array.isArray(table.primaryKey) || table.primaryKey.length === 0) {
    fail("PRIMARY_KEY_REQUIRED", `${table.name} must declare at least one primary-key column.`);
  }
  if (new Set(table.primaryKey).size !== table.primaryKey.length) {
    fail("DUPLICATE_PRIMARY_KEY_COLUMN", `${table.name} repeats a primary-key column.`);
  }
  table.primaryKey.forEach((column) =>
    assertSqlIdentifier(column, `${table.name} primary key`)
  );
  if (!Number.isSafeInteger(table.rowCount) || table.rowCount < 0) {
    fail(
      "INVALID_ROW_COUNT",
      `${table.name} rowCount must be a non-negative safe integer.`
    );
  }
  if (!Array.isArray(table.columns) || table.columns.length === 0) {
    fail("TABLE_COLUMNS_REQUIRED", `${table.name} must include sanitized column metadata.`);
  }
  table.columns.forEach((column) => validateColumn(column, table.name));
  const columnNames = table.columns.map(({ name }) => name);
  const ordinals = table.columns.map(({ ordinalPosition }) => ordinalPosition);
  if (
    new Set(columnNames).size !== columnNames.length ||
    new Set(ordinals).size !== ordinals.length
  ) {
    fail("DUPLICATE_COLUMN", `${table.name} repeats a column name or ordinal.`);
  }
  if (table.primaryKey.some((column) => !columnNames.includes(column))) {
    fail("PRIMARY_KEY_COLUMN_MISSING", `${table.name} primary key is absent from its columns.`);
  }
}

function validateNamedDefinition(entry, collection) {
  assertObjectShape(entry, ["schema", "table", "name", "definition"], collection);
  assertPublicTableReference(entry, collection);
  assertBoundedText(entry.name, `${collection} name`, { max: 63 });
  assertBoundedText(entry.definition, `${collection} definition`);
}

function validateSequence(entry) {
  assertObjectShape(
    entry,
    [
      "schema",
      "name",
      "dataType",
      "startValue",
      "minValue",
      "maxValue",
      "incrementBy",
      "cycle",
      "cacheSize",
      "ownedBy",
    ],
    "sequence"
  );
  if (entry.schema !== "public") {
    fail("SCHEMA_FACT_OUTSIDE_ALLOWLIST", "Sequence metadata must be in public.");
  }
  assertBoundedText(entry.name, "sequence name", { max: 63 });
  assertBoundedText(entry.dataType, "sequence data type", { max: 256 });
  for (const key of [
    "startValue",
    "minValue",
    "maxValue",
    "incrementBy",
    "cacheSize",
  ]) {
    assertBoundedText(entry[key], `sequence ${key}`, { max: 64 });
  }
  if (typeof entry.cycle !== "boolean") {
    fail("INVALID_SCHEMA_FACT", "sequence cycle must be boolean.");
  }
  assertBoundedText(entry.ownedBy, "sequence ownedBy", { nullable: true, max: 256 });
}

function validateFunction(entry) {
  assertObjectShape(
    entry,
    [
      "schema",
      "name",
      "identityArguments",
      "resultType",
      "language",
      "kind",
      "volatility",
      "securityDefiner",
      "extensionOwned",
      "definitionHash",
    ],
    "function"
  );
  if (entry.schema !== "public") {
    fail("SCHEMA_FACT_OUTSIDE_ALLOWLIST", "Function metadata must be in public.");
  }
  assertBoundedText(entry.name, "function name", { max: 63 });
  if (typeof entry.identityArguments !== "string" || entry.identityArguments.length > 20_000) {
    fail("INVALID_SCHEMA_FACT", "function identityArguments must be bounded text.");
  }
  for (const key of ["resultType", "language", "kind", "volatility"]) {
    assertBoundedText(entry[key], `function ${key}`, { max: 20_000 });
  }
  if (typeof entry.securityDefiner !== "boolean") {
    fail("INVALID_SCHEMA_FACT", "function securityDefiner must be boolean.");
  }
  if (typeof entry.extensionOwned !== "boolean") {
    fail("INVALID_SCHEMA_FACT", "function extensionOwned must be boolean.");
  }
  const definitionMustBeHashed = !entry.extensionOwned && entry.kind !== "AGGREGATE";
  if (
    (definitionMustBeHashed && !SHA256_PATTERN.test(entry.definitionHash ?? "")) ||
    (!definitionMustBeHashed && entry.definitionHash !== null)
  ) {
    fail(
      "INVALID_FUNCTION_DEFINITION_HASH",
      "Custom function definitions require SHA-256 hashes; extension bodies stay excluded."
    );
  }
}

export function functionSignature(entry) {
  return `${entry.name}(${entry.identityArguments})->${entry.resultType}`;
}

function validatePolicy(entry, expectedSchema) {
  assertObjectShape(
    entry,
    [
      "schema",
      "table",
      "name",
      "command",
      "permissive",
      "roles",
      "usingExpression",
      "checkExpression",
    ],
    "policy"
  );
  if (expectedSchema === "public") {
    assertPublicTableReference(entry, "public policy");
  } else if (expectedSchema === "storage") {
    if (entry.schema !== "storage") {
      fail("SCHEMA_FACT_OUTSIDE_ALLOWLIST", "Storage policy metadata must be in storage.");
    }
    assertSqlIdentifier(entry.table, "storage policy table");
  } else {
    fail("INVALID_SCHEMA_FACT", "Policy schema must be public or storage.");
  }
  for (const key of ["name", "command", "permissive"]) {
    assertBoundedText(entry[key], `policy ${key}`, { max: 256 });
  }
  if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
    fail("INVALID_SCHEMA_FACT", "policy roles must be a non-empty array.");
  }
  entry.roles.forEach((role) => assertBoundedText(role, "policy role", { max: 63 }));
  assertBoundedText(entry.usingExpression, "policy usingExpression", { nullable: true });
  assertBoundedText(entry.checkExpression, "policy checkExpression", { nullable: true });
}

function validateTrigger(entry) {
  assertObjectShape(
    entry,
    ["schema", "table", "name", "functionSchema", "functionName", "definition"],
    "trigger"
  );
  assertPublicTableReference(entry, "trigger");
  for (const key of ["name", "functionSchema", "functionName"]) {
    assertBoundedText(entry[key], `trigger ${key}`, { max: 63 });
  }
  assertBoundedText(entry.definition, "trigger definition");
}

function validateExtension(entry) {
  assertObjectShape(entry, ["name", "schema", "version"], "extension");
  for (const key of ["name", "schema", "version"]) {
    assertBoundedText(entry[key], `extension ${key}`, { max: 256 });
  }
}

function validateGrant(entry) {
  assertObjectShape(
    entry,
    ["objectType", "objectSchema", "objectName", "grantee", "privilege", "isGrantable"],
    "grant"
  );
  if (entry.objectSchema !== "public") {
    fail("SCHEMA_FACT_OUTSIDE_ALLOWLIST", "Grant metadata must describe public objects.");
  }
  for (const key of ["objectType", "grantee", "privilege"]) {
    assertBoundedText(entry[key], `grant ${key}`, { max: 256 });
  }
  assertBoundedText(entry.objectName, "grant objectName", { max: 20_000 });
  if (typeof entry.isGrantable !== "boolean") {
    fail("INVALID_SCHEMA_FACT", "grant isGrantable must be boolean.");
  }
}

function schemaFactIdentity(collection, entry) {
  switch (collection) {
    case "foreignKeys":
    case "checkConstraints":
    case "indexes":
    case "triggers":
    case "publicPolicies":
    case "storagePolicies":
      return `${entry.schema}\u0000${entry.table}\u0000${entry.name}`;
    case "sequences":
    case "extensions":
      return `${entry.schema}\u0000${entry.name}`;
    case "functions":
      return `${entry.schema}\u0000${entry.name}\u0000${entry.identityArguments}`;
    case "grants":
      return [
        entry.objectType,
        entry.objectSchema,
        entry.objectName,
        entry.grantee,
        entry.privilege,
      ].join("\u0000");
    default:
      fail("INVALID_SCHEMA_FACT_COLLECTION", "Unknown schema fact collection.");
  }
}

function validateSchemaFacts(schemaFacts) {
  assertObjectShape(schemaFacts, SCHEMA_FACT_COLLECTIONS, "schemaFacts");
  for (const collection of SCHEMA_FACT_COLLECTIONS) {
    const entries = schemaFacts[collection];
    if (!Array.isArray(entries)) {
      fail("SCHEMA_FACT_COLLECTION_REQUIRED", `${collection} must be an array.`);
    }
    const identities = new Set();
    for (const entry of entries) {
      if (["foreignKeys", "checkConstraints", "indexes"].includes(collection)) {
        validateNamedDefinition(entry, collection);
      } else if (collection === "sequences") {
        validateSequence(entry);
      } else if (collection === "triggers") {
        validateTrigger(entry);
      } else if (collection === "functions") {
        validateFunction(entry);
      } else if (collection === "publicPolicies") {
        validatePolicy(entry, "public");
      } else if (collection === "storagePolicies") {
        validatePolicy(entry, "storage");
      } else if (collection === "extensions") {
        validateExtension(entry);
      } else if (collection === "grants") {
        validateGrant(entry);
      }
      const identity = schemaFactIdentity(collection, entry);
      if (identities.has(identity)) {
        fail("DUPLICATE_SCHEMA_FACT", `${collection} contains duplicate metadata.`);
      }
      identities.add(identity);
    }
  }
  if (schemaFacts.publicPolicies.length !== SOURCE_CONTRACT.expected.livePublicPolicies) {
    fail(
      "POLICY_COUNT_MISMATCH",
      "Inventory must contain exactly 118 live public policies."
    );
  }
  if (schemaFacts.storagePolicies.length !== SOURCE_CONTRACT.expected.liveStoragePolicies) {
    fail("POLICY_COUNT_MISMATCH", "Inventory must contain exactly 10 live storage policies.");
  }
  if (
    schemaFacts.functions.length !== SOURCE_CONTRACT.expected.livePublicFunctionSignatures
  ) {
    fail(
      "FUNCTION_COUNT_MISMATCH",
      "Inventory must contain exactly 142 live public function signatures."
    );
  }

  const customSignatures = schemaFacts.functions
    .filter((entry) => !entry.extensionOwned)
    .map(functionSignature)
    .sort();
  if (
    customSignatures.length !== CUSTOM_PUBLIC_FUNCTION_SIGNATURES.length ||
    customSignatures.some(
      (signature, index) => signature !== CUSTOM_PUBLIC_FUNCTION_SIGNATURES[index]
    )
  ) {
    fail(
      "CUSTOM_FUNCTION_ALLOWLIST_MISMATCH",
      "Inventory custom functions must match the frozen 24-signature allowlist exactly."
    );
  }
  const callableSignatures = customSignatures.filter(
    (signature) => !signature.endsWith("->trigger")
  );
  const triggerSignatures = customSignatures.filter((signature) =>
    signature.endsWith("->trigger")
  );
  if (
    callableSignatures.some(
      (signature, index) => signature !== APPLICATION_RPC_SIGNATURES[index]
    ) ||
    triggerSignatures.some(
      (signature, index) => signature !== CUSTOM_TRIGGER_FUNCTION_SIGNATURES[index]
    )
  ) {
    fail(
      "RPC_ALLOWLIST_MISMATCH",
      "Inventory must split the custom allowlist into 16 callable RPCs and 8 triggers."
    );
  }
}

function sortEvidenceFacts(entries) {
  return [...entries].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right))
  );
}

function policyEvidenceFact(entry) {
  return {
    schemaname: entry.schema,
    tablename: entry.table,
    policyname: entry.name,
    permissive: entry.permissive,
    roles: `{${[...entry.roles].sort().join(",")}}`,
    cmd: entry.command,
    qual: entry.usingExpression,
    with_check: entry.checkExpression,
  };
}

function functionEvidenceFact(entry) {
  const prokind = {
    FUNCTION: "f",
    PROCEDURE: "p",
    AGGREGATE: "a",
  }[entry.kind];
  const volatility = {
    IMMUTABLE: "i",
    STABLE: "s",
    VOLATILE: "v",
  }[entry.volatility];
  if (!prokind || !volatility) {
    fail("INVALID_FUNCTION_CONTRACT", "Function kind or volatility is unsupported.");
  }
  return {
    function_name: entry.name,
    identity_arguments: entry.identityArguments,
    result_type: entry.resultType,
    prokind,
    security_definer: entry.securityDefiner,
    volatility,
  };
}

function defaultExpressionEvidenceFacts(tables) {
  return sortEvidenceFacts(
    tables.flatMap((table) =>
      table.columns
        .filter((column) => column.hasDefault)
        .map((column) => ({
          table: table.name,
          column: column.name,
          defaultExpressionHash: column.defaultExpressionHash,
        }))
    )
  );
}

function validateFrozenSchemaFactHashes(snapshot) {
  const expected = SOURCE_CONTRACT.liveSchemaEvidence;
  const publicPolicies = sortEvidenceFacts(
    snapshot.schemaFacts.publicPolicies.map(policyEvidenceFact)
  );
  const storagePolicies = sortEvidenceFacts(
    snapshot.schemaFacts.storagePolicies.map(policyEvidenceFact)
  );
  const allPolicies = sortEvidenceFacts([...publicPolicies, ...storagePolicies]);
  const allFunctions = sortEvidenceFacts(
    snapshot.schemaFacts.functions.map(functionEvidenceFact)
  );
  const customFunctions = sortEvidenceFacts(
    snapshot.schemaFacts.functions
      .filter((entry) => !entry.extensionOwned)
      .map(functionEvidenceFact)
  );
  const applicationRpcs = sortEvidenceFacts(
    snapshot.schemaFacts.functions
      .filter((entry) => !entry.extensionOwned && entry.resultType !== "trigger")
      .map(functionEvidenceFact)
  );
  const customTriggerFunctions = sortEvidenceFacts(
    snapshot.schemaFacts.functions
      .filter((entry) => !entry.extensionOwned && entry.resultType === "trigger")
      .map(functionEvidenceFact)
  );
  const defaultExpressions = defaultExpressionEvidenceFacts(snapshot.tables);
  const actual = {
    publicPoliciesHash: canonicalHash(publicPolicies),
    storagePoliciesHash: canonicalHash(storagePolicies),
    allPoliciesHash: canonicalHash(allPolicies),
    publicFunctionSignaturesHash: canonicalHash(allFunctions),
    customFunctionSignaturesHash: canonicalHash(customFunctions),
    applicationRpcSignaturesHash: canonicalHash(applicationRpcs),
    customTriggerSignaturesHash: canonicalHash(customTriggerFunctions),
    defaultExpressionHashesHash: canonicalHash(defaultExpressions),
  };
  for (const [key, value] of Object.entries(actual)) {
    if (value !== expected[key]) {
      fail(
        "FROZEN_SCHEMA_FACT_HASH_MISMATCH",
        `${key} does not match the frozen sanitized live-schema facts.`
      );
    }
  }
  if (defaultExpressions.length !== SOURCE_CONTRACT.expected.defaultExpressions) {
    fail(
      "DEFAULT_EXPRESSION_COUNT_MISMATCH",
      "Inventory must contain exactly 381 frozen default-expression hashes."
    );
  }
  const untrustedObservedDefinitionInputHash = canonicalHash(
    sortEvidenceFacts(
      snapshot.schemaFacts.functions
        .filter((entry) => !entry.extensionOwned)
        .map((entry) => ({
          signature: functionSignature(entry),
          definitionHash: entry.definitionHash,
        }))
    )
  );
  return Object.freeze({
    ...actual,
    customFunctionDefinitionEvidence: Object.freeze({
      state: expected.customFunctionDefinitionEvidence.state,
      hash: expected.customFunctionDefinitionEvidence.hash,
      untrustedObservedDefinitionInputHash,
    }),
  });
}

function validateCatalogCounts(catalogCounts, snapshot) {
  assertObjectShape(catalogCounts, CATALOG_COUNT_KEYS, "catalogCounts");
  for (const key of CATALOG_COUNT_KEYS) {
    if (!Number.isSafeInteger(catalogCounts[key]) || catalogCounts[key] < 0) {
      fail("INVALID_CATALOG_COUNT", `${key} must be a non-negative safe integer.`);
    }
  }
  const capturedCounts = {
    publicTables: snapshot.tables.length,
    columns: snapshot.tables.reduce((total, table) => total + table.columns.length, 0),
    foreignKeys: snapshot.schemaFacts.foreignKeys.length,
    checkConstraints: snapshot.schemaFacts.checkConstraints.length,
    indexes: snapshot.schemaFacts.indexes.length,
    sequences: snapshot.schemaFacts.sequences.length,
    triggers: snapshot.schemaFacts.triggers.length,
    publicFunctionSignatures: snapshot.schemaFacts.functions.length,
    customPublicFunctions: snapshot.schemaFacts.functions.filter(
      (entry) => !entry.extensionOwned
    ).length,
    applicationRpcs: snapshot.schemaFacts.functions.filter(
      (entry) => !entry.extensionOwned && entry.resultType !== "trigger"
    ).length,
    customTriggerFunctions: snapshot.schemaFacts.functions.filter(
      (entry) => !entry.extensionOwned && entry.resultType === "trigger"
    ).length,
    publicPolicies: snapshot.schemaFacts.publicPolicies.length,
    storagePolicies: snapshot.schemaFacts.storagePolicies.length,
    extensions: snapshot.schemaFacts.extensions.length,
    grants: snapshot.schemaFacts.grants.length,
    authUsers: snapshot.authUsers.length,
  };
  for (const key of CATALOG_COUNT_KEYS) {
    if (catalogCounts[key] !== capturedCounts[key]) {
      fail(
        "CATALOG_CAPTURE_COUNT_MISMATCH",
        `${key} metadata count does not match the captured inventory.`
      );
    }
  }
  if (catalogCounts.publicTables !== SOURCE_CONTRACT.expected.publicTables) {
    fail("PUBLIC_TABLE_COUNT_MISMATCH", "Source catalog must contain exactly 70 public tables.");
  }
  const lockedCatalogCounts = {
    publicFunctionSignatures: SOURCE_CONTRACT.expected.livePublicFunctionSignatures,
    customPublicFunctions: SOURCE_CONTRACT.expected.liveCustomPublicFunctions,
    applicationRpcs: SOURCE_CONTRACT.expected.applicationRpcs,
    customTriggerFunctions: SOURCE_CONTRACT.expected.customTriggerFunctions,
    publicPolicies: SOURCE_CONTRACT.expected.livePublicPolicies,
    storagePolicies: SOURCE_CONTRACT.expected.liveStoragePolicies,
  };
  for (const [key, expected] of Object.entries(lockedCatalogCounts)) {
    if (catalogCounts[key] !== expected) {
      fail(
        "LIVE_SCHEMA_COUNT_MISMATCH",
        `${key} does not match the frozen sanitized live-schema count.`
      );
    }
  }
  if (catalogCounts.authUsers !== SOURCE_CONTRACT.expected.authUsers) {
    fail("AUTH_USER_COUNT_MISMATCH", "Source catalog must contain exactly 369 Auth users.");
  }
}

function listSqlFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSqlFiles(path));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
      files.push(path);
    }
  }
  return files.sort();
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\r\n]*/g, " ");
}

export function validateRepositoryPolicyDeclarations(
  migrationsDirectory = DEFAULT_MIGRATIONS_DIR
) {
  const files = listSqlFiles(migrationsDirectory);
  const declarationFacts = files
    .map((path) => {
      const sql = stripSqlComments(readFileSync(path, "utf8"));
      const count = [...sql.matchAll(/\bCREATE\s+POLICY\b/gi)].length;
      return {
        path: relative(migrationsDirectory, path).replaceAll("\\", "/"),
        count,
      };
    })
    .filter(({ count }) => count > 0);
  const count = declarationFacts.reduce((total, entry) => total + entry.count, 0);
  if (count !== SOURCE_CONTRACT.expected.repoPolicyDeclarations) {
    fail(
      "REPOSITORY_POLICY_DECLARATION_MISMATCH",
      "Repository migrations must contain exactly 203 CREATE POLICY declarations."
    );
  }
  return Object.freeze({
    count,
    declarationIndexHash: canonicalHash(declarationFacts),
  });
}

function validateFrozenLiveEvidence(evidence) {
  const expected = SOURCE_CONTRACT.liveSchemaEvidence;
  assertObjectShape(evidence, Object.keys(expected), "frozenLiveEvidence");
  if (canonicalJson(evidence) !== canonicalJson(expected)) {
    fail(
      "LIVE_SCHEMA_EVIDENCE_MISMATCH",
      "Inventory must bind to the exact frozen sanitized live-schema evidence."
    );
  }
}

function validateSchemaDumpArtifact(artifact) {
  assertObjectShape(
    artifact,
    ["state", "sha256", "encryption", "reviewed", "containsData"],
    "schemaDumpArtifact"
  );
  if (artifact.containsData !== false) {
    fail("SCHEMA_DUMP_DATA_FORBIDDEN", "The schema artifact must never contain row data.");
  }
  if (artifact.state === "NOT_CAPTURED_BLOCKING") {
    if (
      artifact.sha256 !== null ||
      artifact.encryption !== null ||
      artifact.reviewed !== false
    ) {
      fail(
        "INVALID_SCHEMA_DUMP_ARTIFACT",
        "An uncaptured schema artifact cannot claim a hash, encryption, or review."
      );
    }
    return Object.freeze({
      ready: false,
      blocker: "ENCRYPTED_SCHEMA_DUMP_ARTIFACT_NOT_CAPTURED",
    });
  }
  if (
    artifact.state !== "CAPTURED_ENCRYPTED_REVIEWED" ||
    !SHA256_PATTERN.test(artifact.sha256 ?? "") ||
    artifact.encryption !== SOURCE_CONTRACT.schemaDumpArtifactContract.requiredEncryption ||
    artifact.reviewed !== true
  ) {
    fail(
      "INVALID_SCHEMA_DUMP_ARTIFACT",
      "Seed or restore requires a reviewed Cloud KMS-encrypted schema-only dump hash."
    );
  }
  return Object.freeze({ ready: true, blocker: null });
}

function validateRowCountCapture(capture, totalRowCount) {
  assertObjectShape(capture, ["baselineRowCount", "observedDelta"], "rowCountCapture");
  if (
    capture.baselineRowCount !== SOURCE_CONTRACT.expected.baselineRowCount ||
    !Number.isSafeInteger(capture.observedDelta) ||
    capture.baselineRowCount + capture.observedDelta < 0 ||
    capture.baselineRowCount + capture.observedDelta !== totalRowCount
  ) {
    fail(
      "ROW_COUNT_RECONCILIATION_MISMATCH",
      "Total rows must equal the frozen 44,811 baseline plus the recorded capture delta."
    );
  }
}

function validateAuthUser(user) {
  if (!user || !UUID_PATTERN.test(user.legacyUserUuid ?? "")) {
    fail("INVALID_LEGACY_UUID", "Every source Auth user must carry a valid legacy UUID.");
  }
  if (!Array.isArray(user.providerSubjects)) {
    fail("INVALID_PROVIDER_SUBJECTS", "providerSubjects must be an array.");
  }
  const localProviderKeys = new Set();
  for (const provider of user.providerSubjects) {
    assertObjectShape(provider, ["providerId", "subject"], "provider subject");
    if (
      !provider ||
      typeof provider.providerId !== "string" ||
      typeof provider.subject !== "string" ||
      provider.subject.length === 0 ||
      provider.subject.length > 512 ||
      provider.subject.includes("\u0000") ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider.providerId)
    ) {
      fail(
        "INVALID_PROVIDER_SUBJECT",
        "Provider evidence requires a provider ID and immutable subject."
      );
    }
    if (["email", "password", "email_link"].includes(provider.providerId.toLowerCase())) {
      fail(
        "EMAIL_EVIDENCE_FORBIDDEN",
        "Email and password providers cannot be stored as provider-subject mapping evidence."
      );
    }
    const providerKey = `${provider.providerId.toLowerCase().normalize("NFC")}\u0000${provider.subject.normalize("NFC")}`;
    if (localProviderKeys.has(providerKey)) {
      fail("DUPLICATE_PROVIDER_SUBJECT", "A source user repeats the same provider subject.");
    }
    localProviderKeys.add(providerKey);
  }
  if (typeof user.emailPresent !== "boolean") {
    fail(
      "EMAIL_PRESENCE_REQUIRED",
      "emailPresent must be a boolean; raw email values are not part of this contract."
    );
  }
  const credential = user.passwordCredential;
  assertObjectShape(credential, ["present", "algorithm"], "passwordCredential");
  if (
    !credential ||
    typeof credential.present !== "boolean" ||
    ![null, "BCRYPT", "UNSUPPORTED"].includes(credential.algorithm ?? null)
  ) {
    fail(
      "INVALID_PASSWORD_METADATA",
      "passwordCredential must contain presence and a supported metadata-only algorithm."
    );
  }
  if (credential.present && credential.algorithm === null) {
    fail(
      "PASSWORD_ALGORITHM_REQUIRED",
      "A present password credential must declare its algorithm."
    );
  }
}

function validateUniqueSourceProviderSubjects(authUsers) {
  const providerOwners = new Map();
  for (const user of authUsers) {
    const legacyUserUuid = user.legacyUserUuid.toLowerCase();
    for (const provider of user.providerSubjects) {
      const providerKey = [
        provider.providerId.toLowerCase().normalize("NFC"),
        provider.subject.normalize("NFC"),
      ].join("\u0000");
      const existingOwner = providerOwners.get(providerKey);
      if (existingOwner !== undefined && existingOwner !== legacyUserUuid) {
        fail(
          "DUPLICATE_SOURCE_PROVIDER_SUBJECT",
          "One immutable provider subject cannot belong to multiple source Auth users."
        );
      }
      providerOwners.set(providerKey, legacyUserUuid);
    }
  }
}

function normalizedFacts(schemaFacts) {
  return Object.fromEntries(
    SCHEMA_FACT_COLLECTIONS.map((collection) => [
      collection,
      schemaFacts[collection]
        .map((entry) =>
          collection === "publicPolicies" || collection === "storagePolicies"
            ? { ...entry, roles: [...entry.roles].sort() }
            : { ...entry }
        )
        .sort((left, right) => {
          const leftJson = canonicalJson(left);
          const rightJson = canonicalJson(right);
          return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
        }),
    ])
  );
}

function normalizedInventoryForHash(snapshot) {
  return {
    version: snapshot.version,
    source: {
      projectRef: snapshot.source.projectRef,
      database: snapshot.source.database,
      schema: snapshot.source.schema,
      readOnly: snapshot.source.readOnly,
    },
    catalogCounts: { ...snapshot.catalogCounts },
    rowCountCapture: { ...snapshot.rowCountCapture },
    frozenLiveEvidence: { ...snapshot.frozenLiveEvidence },
    schemaDumpArtifact: { ...snapshot.schemaDumpArtifact },
    tables: [...snapshot.tables]
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      )
      .map((table) => ({
        schema: table.schema,
        name: table.name,
        rowCount: table.rowCount,
        primaryKey: [...table.primaryKey],
        columns: [...table.columns].sort(
          (left, right) => left.ordinalPosition - right.ordinalPosition
        ),
      })),
    schemaFacts: normalizedFacts(snapshot.schemaFacts),
    authUsers: [...snapshot.authUsers]
      .sort((left, right) =>
        left.legacyUserUuid < right.legacyUserUuid
          ? -1
          : left.legacyUserUuid > right.legacyUserUuid
            ? 1
            : 0
      )
      .map((user) => ({
        legacyUserUuid: user.legacyUserUuid.toLowerCase(),
        providerSubjects: user.providerSubjects
          .map((provider) => ({
            providerId: provider.providerId.toLowerCase(),
            subject: provider.subject.normalize("NFC"),
          }))
          .sort((left, right) => {
            const leftKey = `${left.providerId}\u0000${left.subject}`;
            const rightKey = `${right.providerId}\u0000${right.subject}`;
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          }),
        emailPresent: user.emailPresent,
        passwordCredential: {
          present: user.passwordCredential.present,
          algorithm: user.passwordCredential.algorithm ?? null,
        },
      })),
  };
}

export function validateSourceInventory(snapshot, boundary) {
  assertNoRawSecrets(snapshot);
  if (!snapshot || snapshot.version !== 1) {
    fail("INVALID_INVENTORY", "Inventory version 1 is required.");
  }
  const source = snapshot.source ?? {};
  if (
    source.projectRef !== SOURCE_CONTRACT.source.projectRef ||
    source.database !== SOURCE_CONTRACT.source.database ||
    source.schema !== SOURCE_CONTRACT.source.schema ||
    source.readOnly !== true
  ) {
    fail(
      "SOURCE_BOUNDARY_MISMATCH",
      "Inventory source metadata does not match the locked read-only source boundary."
    );
  }
  if (
    boundary &&
    (boundary.source.projectRef !== source.projectRef ||
      boundary.source.database !== source.database)
  ) {
    fail("SOURCE_BOUNDARY_MISMATCH", "Inventory and CLI source boundaries do not match.");
  }

  if (!Array.isArray(snapshot.tables)) {
    fail("INVALID_TABLES", "Inventory tables must be an array.");
  }
  snapshot.tables.forEach(validateTableEntry);
  const actualTables = snapshot.tables.map(({ name }) => name).sort();
  if (new Set(actualTables).size !== actualTables.length) {
    fail("DUPLICATE_TABLE", "Inventory contains duplicate tables.");
  }
  if (
    actualTables.length !== PUBLIC_TABLES.length ||
    actualTables.some((name, index) => name !== PUBLIC_TABLES[index])
  ) {
    fail(
      "TABLE_ALLOWLIST_MISMATCH",
      "Inventory must match all 70 allowlisted public tables exactly."
    );
  }

  validateSchemaFacts(snapshot.schemaFacts);
  validateFrozenLiveEvidence(snapshot.frozenLiveEvidence);
  const frozenSchemaFactHashes = validateFrozenSchemaFactHashes(snapshot);
  const schemaDump = validateSchemaDumpArtifact(snapshot.schemaDumpArtifact);
  const repositoryPolicies = validateRepositoryPolicyDeclarations();

  if (!Array.isArray(snapshot.authUsers)) {
    fail("INVALID_AUTH_USERS", "authUsers must be an array.");
  }
  if (snapshot.authUsers.length !== SOURCE_CONTRACT.expected.authUsers) {
    fail("AUTH_USER_COUNT_MISMATCH", "Inventory must contain exactly 369 Auth users.");
  }
  snapshot.authUsers.forEach(validateAuthUser);
  validateUniqueSourceProviderSubjects(snapshot.authUsers);
  const legacyUuids = snapshot.authUsers.map(({ legacyUserUuid }) =>
    legacyUserUuid.toLowerCase()
  );
  if (new Set(legacyUuids).size !== legacyUuids.length) {
    fail("DUPLICATE_LEGACY_UUID", "Inventory contains duplicate legacy Auth UUIDs.");
  }
  validateCatalogCounts(snapshot.catalogCounts, snapshot);

  const totalRowCount = snapshot.tables.reduce((total, table) => total + table.rowCount, 0);
  if (!Number.isSafeInteger(totalRowCount)) {
    fail("INVALID_ROW_COUNT", "Combined rowCount must remain a safe integer.");
  }
  validateRowCountCapture(snapshot.rowCountCapture, totalRowCount);
  const inventoryHash = canonicalHash(normalizedInventoryForHash(snapshot));
  return Object.freeze({
    version: 1,
    mode: "READ_ONLY_SNAPSHOT",
    sourceProjectRef: source.projectRef,
    sourceDatabase: source.database,
    publicTableCount: actualTables.length,
    totalRowCount,
    baselineRowCount: snapshot.rowCountCapture.baselineRowCount,
    observedRowCountDelta: snapshot.rowCountCapture.observedDelta,
    columnCount: snapshot.catalogCounts.columns,
    foreignKeyCount: snapshot.catalogCounts.foreignKeys,
    checkConstraintCount: snapshot.catalogCounts.checkConstraints,
    indexCount: snapshot.catalogCounts.indexes,
    sequenceCount: snapshot.catalogCounts.sequences,
    triggerCount: snapshot.catalogCounts.triggers,
    publicFunctionSignatureCount: snapshot.catalogCounts.publicFunctionSignatures,
    customPublicFunctionCount: snapshot.catalogCounts.customPublicFunctions,
    rpcCount: snapshot.catalogCounts.applicationRpcs,
    customTriggerFunctionCount: snapshot.catalogCounts.customTriggerFunctions,
    publicPolicyCount: snapshot.catalogCounts.publicPolicies,
    storagePolicyCount: snapshot.catalogCounts.storagePolicies,
    repositoryPolicyDeclarationCount: repositoryPolicies.count,
    repositoryPolicyDeclarationIndexHash: repositoryPolicies.declarationIndexHash,
    extensionCount: snapshot.catalogCounts.extensions,
    grantCount: snapshot.catalogCounts.grants,
    authUserCount: snapshot.authUsers.length,
    schemaDumpArtifactReady: schemaDump.ready,
    applyReady: false,
    blockers: Object.freeze([
      "PLAN_ONLY_EXECUTION",
      "CUSTOM_FUNCTION_DEFINITION_EVIDENCE_NOT_CAPTURED",
      ...(schemaDump.blocker ? [schemaDump.blocker] : []),
    ]),
    frozenSchemaFactHashes,
    inventoryHash,
  });
}

export function buildSourceInventoryReadOnlySql() {
  const allowlistSql = PUBLIC_TABLES.map((table) => `'${table}'`).join(", ");
  return [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    "SET LOCAL statement_timeout = '30s';",
    "SET LOCAL lock_timeout = '5s';",
    "SELECT",
    "  'tables'::text AS inventory_section,",
    "  n.nspname AS schema_name,",
    "  c.relname AS table_name,",
    "  ((xpath('/table/row/row_count/text()', query_to_xml(",
    "    format('SELECT count(*)::bigint AS row_count FROM %I.%I', n.nspname, c.relname),",
    "    false, false, ''",
    "  )))[1]::text)::bigint AS row_count,",
    "  array_agg(a.attname ORDER BY key_column.ordinal_position) AS primary_key",
    "FROM pg_catalog.pg_class AS c",
    "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace",
    "JOIN pg_catalog.pg_index AS i ON i.indrelid = c.oid AND i.indisprimary",
    "JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinal_position) ON true",
    "JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = key_column.attnum",
    "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')",
    `  AND c.relname IN (${allowlistSql})`,
    "GROUP BY n.nspname, c.relname",
    "ORDER BY c.relname;",
    "SELECT",
    "  'columns'::text AS inventory_section,",
    "  table_schema AS schema_name, table_name, column_name, ordinal_position,",
    "  data_type, udt_schema, udt_name, is_nullable = 'YES' AS nullable,",
    "  column_default IS NOT NULL AS has_default,",
    "  CASE WHEN column_default IS NULL THEN NULL ELSE encode(extensions.digest(convert_to(",
    "    btrim(replace(replace(column_default, chr(13) || chr(10), chr(10)), chr(13), chr(10))), 'UTF8'",
    "  ), 'sha256'), 'hex') END AS default_expression_hash,",
    "  is_identity = 'YES' AS identity,",
    "  is_generated <> 'NEVER' AS generated",
    "FROM information_schema.columns",
    "WHERE table_schema = 'public'",
    `  AND table_name IN (${allowlistSql})`,
    "ORDER BY table_name, ordinal_position;",
    "SELECT",
    "  'foreign_keys'::text AS inventory_section,",
    "  n.nspname AS schema_name, c.relname AS table_name, con.conname AS name,",
    "  pg_catalog.pg_get_constraintdef(con.oid, false) AS definition",
    "FROM pg_catalog.pg_constraint AS con",
    "JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid",
    "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace",
    "WHERE n.nspname = 'public' AND con.contype = 'f'",
    `  AND c.relname IN (${allowlistSql})`,
    "ORDER BY c.relname, con.conname;",
    "SELECT",
    "  'check_constraints'::text AS inventory_section,",
    "  n.nspname AS schema_name, c.relname AS table_name, con.conname AS name,",
    "  pg_catalog.pg_get_constraintdef(con.oid, false) AS definition",
    "FROM pg_catalog.pg_constraint AS con",
    "JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid",
    "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace",
    "WHERE n.nspname = 'public' AND con.contype = 'c'",
    `  AND c.relname IN (${allowlistSql})`,
    "ORDER BY c.relname, con.conname;",
    "SELECT",
    "  'indexes'::text AS inventory_section,",
    "  schemaname AS schema_name, tablename AS table_name, indexname AS name,",
    "  indexdef AS definition",
    "FROM pg_catalog.pg_indexes",
    "WHERE schemaname = 'public'",
    `  AND tablename IN (${allowlistSql})`,
    "ORDER BY tablename, indexname;",
    "SELECT",
    "  'sequences'::text AS inventory_section,",
    "  schemaname AS schema_name, sequencename AS name, data_type::text AS data_type,",
    "  start_value::text, min_value::text, max_value::text, increment_by::text,",
    "  cycle, cache_size::text,",
    "  CASE WHEN dep_table.oid IS NULL THEN NULL ELSE",
    "    quote_ident(dep_table_ns.nspname) || '.' || quote_ident(dep_table.relname) || '.' || quote_ident(dep_column.attname)",
    "  END AS owned_by",
    "FROM pg_catalog.pg_sequences AS seq",
    "LEFT JOIN pg_catalog.pg_namespace AS sequence_namespace",
    "  ON sequence_namespace.nspname = seq.schemaname",
    "LEFT JOIN pg_catalog.pg_class AS sequence_class",
    "  ON sequence_class.relnamespace = sequence_namespace.oid",
    "  AND sequence_class.relname = seq.sequencename AND sequence_class.relkind = 'S'",
    "LEFT JOIN pg_catalog.pg_depend AS dep",
    "  ON dep.objid = sequence_class.oid AND dep.deptype IN ('a', 'i')",
    "LEFT JOIN pg_catalog.pg_class AS dep_table ON dep_table.oid = dep.refobjid",
    "LEFT JOIN pg_catalog.pg_namespace AS dep_table_ns ON dep_table_ns.oid = dep_table.relnamespace",
    "LEFT JOIN pg_catalog.pg_attribute AS dep_column",
    "  ON dep_column.attrelid = dep.refobjid AND dep_column.attnum = dep.refobjsubid",
    "WHERE seq.schemaname = 'public'",
    "ORDER BY seq.sequencename;",
    "SELECT",
    "  'triggers'::text AS inventory_section,",
    "  table_ns.nspname AS schema_name, table_class.relname AS table_name,",
    "  trigger.tgname AS name, function_ns.nspname AS function_schema,",
    "  function_proc.proname AS function_name,",
    "  pg_catalog.pg_get_triggerdef(trigger.oid, false) AS definition",
    "FROM pg_catalog.pg_trigger AS trigger",
    "JOIN pg_catalog.pg_class AS table_class ON table_class.oid = trigger.tgrelid",
    "JOIN pg_catalog.pg_namespace AS table_ns ON table_ns.oid = table_class.relnamespace",
    "JOIN pg_catalog.pg_proc AS function_proc ON function_proc.oid = trigger.tgfoid",
    "JOIN pg_catalog.pg_namespace AS function_ns ON function_ns.oid = function_proc.pronamespace",
    "WHERE table_ns.nspname = 'public' AND NOT trigger.tgisinternal",
    `  AND table_class.relname IN (${allowlistSql})`,
    "ORDER BY table_class.relname, trigger.tgname;",
    "SELECT",
    "  'functions'::text AS inventory_section,",
    "  n.nspname AS schema_name, p.proname AS name,",
    "  pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,",
    "  pg_catalog.pg_get_function_result(p.oid) AS result_type,",
    "  language.lanname AS language,",
    "  CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END AS kind,",
    "  CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility,",
    "  p.prosecdef AS security_definer,",
    "  EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency",
    "    WHERE extension_dependency.classid = 'pg_proc'::regclass",
    "      AND extension_dependency.objid = p.oid",
    "      AND extension_dependency.deptype = 'e') AS extension_owned,",
    "  CASE WHEN p.prokind IN ('f', 'p') AND NOT EXISTS (",
    "    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency",
    "    WHERE extension_dependency.classid = 'pg_proc'::regclass",
    "      AND extension_dependency.objid = p.oid",
    "      AND extension_dependency.deptype = 'e'",
    "  ) THEN encode(extensions.digest(convert_to(",
    "    btrim(replace(replace(pg_catalog.pg_get_functiondef(p.oid), chr(13) || chr(10), chr(10)), chr(13), chr(10))), 'UTF8'",
    "  ), 'sha256'), 'hex') ELSE NULL END AS definition_hash",
    "FROM pg_catalog.pg_proc AS p",
    "JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace",
    "JOIN pg_catalog.pg_language AS language ON language.oid = p.prolang",
    "WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p', 'a')",
    "ORDER BY p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid);",
    "SELECT",
    "  'public_policies'::text AS inventory_section,",
    "  schemaname AS schema_name, tablename AS table_name, policyname AS name,",
    "  cmd AS command, permissive, roles, qual AS using_expression,",
    "  with_check AS check_expression",
    "FROM pg_catalog.pg_policies",
    "WHERE schemaname = 'public'",
    "ORDER BY tablename, policyname;",
    "SELECT",
    "  'storage_policies'::text AS inventory_section,",
    "  schemaname AS schema_name, tablename AS table_name, policyname AS name,",
    "  cmd AS command, permissive, roles, qual AS using_expression,",
    "  with_check AS check_expression",
    "FROM pg_catalog.pg_policies",
    "WHERE schemaname = 'storage'",
    "ORDER BY tablename, policyname;",
    "SELECT",
    "  'extensions'::text AS inventory_section,",
    "  extension.extname AS name, namespace.nspname AS schema_name,",
    "  extension.extversion AS version",
    "FROM pg_catalog.pg_extension AS extension",
    "JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace",
    "ORDER BY extension.extname;",
    "SELECT",
    "  'grants'::text AS inventory_section,",
    "  CASE object.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS object_type,",
    "  namespace.nspname AS object_schema, object.relname AS object_name,",
    "  CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,",
    "  acl.privilege_type AS privilege, acl.is_grantable",
    "FROM pg_catalog.pg_class AS object",
    "JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = object.relnamespace",
    "CROSS JOIN LATERAL pg_catalog.aclexplode(",
    "  coalesce(object.relacl, pg_catalog.acldefault(",
    "    CASE object.relkind WHEN 'S' THEN 'S'::\"char\" ELSE 'r'::\"char\" END,",
    "    object.relowner",
    "  ))",
    ") AS acl",
    "WHERE namespace.nspname = 'public'",
    `  AND ((object.relkind IN ('r', 'p') AND object.relname IN (${allowlistSql})) OR object.relkind = 'S')`,
    "UNION ALL",
    "SELECT",
    "  'grants'::text, 'ROUTINE'::text, namespace.nspname,",
    "  routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')',",
    "  CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,",
    "  acl.privilege_type, acl.is_grantable",
    "FROM pg_catalog.pg_proc AS routine",
    "JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace",
    "CROSS JOIN LATERAL pg_catalog.aclexplode(",
    "  coalesce(routine.proacl, pg_catalog.acldefault('f'::\"char\", routine.proowner))",
    ") AS acl",
    "WHERE namespace.nspname = 'public' AND routine.prokind IN ('f', 'p', 'a')",
    "ORDER BY object_type, object_name, grantee, privilege;",
    "SELECT",
    "  'catalog_counts'::text AS inventory_section,",
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_class AS counted_class",
    "    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_class.relnamespace",
    "    WHERE counted_ns.nspname = 'public' AND counted_class.relkind IN ('r', 'p')) AS public_tables,",
    "  (SELECT count(*)::bigint FROM information_schema.columns",
    "    WHERE table_schema = 'public'",
    `      AND table_name IN (${allowlistSql})) AS columns,`,
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_constraint AS counted_constraint",
    "    JOIN pg_catalog.pg_class AS counted_class ON counted_class.oid = counted_constraint.conrelid",
    "    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_class.relnamespace",
    "    WHERE counted_ns.nspname = 'public' AND counted_constraint.contype = 'f'",
    `      AND counted_class.relname IN (${allowlistSql})) AS foreign_keys,`,
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_constraint AS counted_constraint",
    "    JOIN pg_catalog.pg_class AS counted_class ON counted_class.oid = counted_constraint.conrelid",
    "    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_class.relnamespace",
    "    WHERE counted_ns.nspname = 'public' AND counted_constraint.contype = 'c'",
    `      AND counted_class.relname IN (${allowlistSql})) AS check_constraints,`,
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_indexes",
    "    WHERE schemaname = 'public'",
    `      AND tablename IN (${allowlistSql})) AS indexes,`,
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_sequences",
    "    WHERE schemaname = 'public') AS sequences,",
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_trigger AS counted_trigger",
    "    JOIN pg_catalog.pg_class AS counted_class ON counted_class.oid = counted_trigger.tgrelid",
    "    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_class.relnamespace",
    "    WHERE counted_ns.nspname = 'public' AND NOT counted_trigger.tgisinternal",
    `      AND counted_class.relname IN (${allowlistSql})) AS triggers,`,
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_proc",
    "    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_proc.pronamespace",
    "    WHERE counted_ns.nspname = 'public' AND counted_proc.prokind IN ('f', 'p', 'a')) AS public_function_signatures,",
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_proc",
    "    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_proc.pronamespace",
    "    WHERE counted_ns.nspname = 'public' AND counted_proc.prokind IN ('f', 'p')",
    "      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency",
    "        WHERE extension_dependency.classid = 'pg_proc'::regclass",
    "          AND extension_dependency.objid = counted_proc.oid",
    "          AND extension_dependency.deptype = 'e')) AS custom_public_functions,",
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_proc",
    "    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_proc.pronamespace",
    "    WHERE counted_ns.nspname = 'public' AND counted_proc.prokind IN ('f', 'p')",
    "      AND pg_catalog.pg_get_function_result(counted_proc.oid) <> 'trigger'",
    "      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency",
    "        WHERE extension_dependency.classid = 'pg_proc'::regclass",
    "          AND extension_dependency.objid = counted_proc.oid",
    "          AND extension_dependency.deptype = 'e')) AS application_rpcs,",
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_proc",
    "    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_proc.pronamespace",
    "    WHERE counted_ns.nspname = 'public' AND counted_proc.prokind = 'f'",
    "      AND pg_catalog.pg_get_function_result(counted_proc.oid) = 'trigger'",
    "      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency",
    "        WHERE extension_dependency.classid = 'pg_proc'::regclass",
    "          AND extension_dependency.objid = counted_proc.oid",
    "          AND extension_dependency.deptype = 'e')) AS custom_trigger_functions,",
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_policies",
    "    WHERE schemaname = 'public') AS public_policies,",
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_policies",
    "    WHERE schemaname = 'storage') AS storage_policies,",
    "  (SELECT count(*)::bigint FROM pg_catalog.pg_extension) AS extensions,",
    "  ((SELECT count(*)::bigint FROM pg_catalog.pg_class AS counted_object",
    "      JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_object.relnamespace",
    "      CROSS JOIN LATERAL pg_catalog.aclexplode(",
    "        coalesce(counted_object.relacl, pg_catalog.acldefault(",
    "          CASE counted_object.relkind WHEN 'S' THEN 'S'::\"char\" ELSE 'r'::\"char\" END,",
    "          counted_object.relowner",
    "        ))",
    "      ) AS counted_acl",
    "      WHERE counted_ns.nspname = 'public'",
    `        AND ((counted_object.relkind IN ('r', 'p') AND counted_object.relname IN (${allowlistSql})) OR counted_object.relkind = 'S')) +`,
    "   (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_routine",
    "      JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_routine.pronamespace",
    "      CROSS JOIN LATERAL pg_catalog.aclexplode(",
    "        coalesce(counted_routine.proacl, pg_catalog.acldefault('f'::\"char\", counted_routine.proowner))",
    "      ) AS counted_acl",
    "      WHERE counted_ns.nspname = 'public' AND counted_routine.prokind IN ('f', 'p', 'a'))) AS grants,",
    "  (SELECT count(*)::bigint FROM auth.users) AS auth_users;",
    "ROLLBACK;",
  ].join("\n");
}
