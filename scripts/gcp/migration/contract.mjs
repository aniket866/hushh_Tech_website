import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const contractUrl = new URL(
  "../../../migration/contracts/source-inventory.v1.json",
  import.meta.url
);
const frozenSchemaFactsUrl = new URL(
  "../../../migration/contracts/frozen-live-schema-facts.v1.json",
  import.meta.url
);
const frozenSchemaCaptureHashesUrl = new URL(
  "../../../migration/contracts/frozen-live-schema-capture-hashes.v1.json",
  import.meta.url
);
const frozenEncryptedSchemaDumpEvidenceUrl = new URL(
  "../../../migration/contracts/frozen-encrypted-schema-dump-evidence.v1.json",
  import.meta.url
);
const schemaCaptureSqlUrl = new URL(
  "../../../migration/sql/source_schema_capture_read_only.sql",
  import.meta.url
);

export class MigrationContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MigrationContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MigrationContractError(code, message);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readContract() {
  const parsed = JSON.parse(readFileSync(contractUrl, "utf8"));
  const frozenSchemaFactsBytes = readFileSync(frozenSchemaFactsUrl);
  const frozenSchemaCaptureHashesBytes = readFileSync(frozenSchemaCaptureHashesUrl);
  const frozenEncryptedSchemaDumpEvidenceBytes = readFileSync(
    frozenEncryptedSchemaDumpEvidenceUrl
  );
  const schemaCaptureSqlBytes = readFileSync(schemaCaptureSqlUrl);
  const tables = parsed.publicTables;
  if (!Array.isArray(tables) || tables.length !== parsed.expected.publicTables) {
    fail("INVALID_CONTRACT", "The source contract must name exactly 70 public tables.");
  }
  if (new Set(tables).size !== tables.length) {
    fail("INVALID_CONTRACT", "The source contract contains duplicate public tables.");
  }
  if ([...tables].sort().some((name, index) => name !== tables[index])) {
    fail("INVALID_CONTRACT", "The source table allowlist must remain sorted.");
  }
  for (const table of tables) {
    assertSqlIdentifier(table, "public table");
  }
  const retirementManifest = parsed.retirementManifest;
  if (
    retirementManifest?.path !== "migration/manifests/supabase-retirement.v1.json" ||
    retirementManifest?.tableDigestAlgorithm !== "sha256_sorted_newline_v1"
  ) {
    fail(
      "INVALID_CONTRACT",
      "The source contract must bind to the canonical Supabase retirement manifest."
    );
  }
  const tableDigest = createHash("sha256")
    .update(tables.map((table) => `public.${table}`).sort().join("\n") + "\n", "utf8")
    .digest("hex");
  if (tableDigest !== retirementManifest.publicTablesDigest) {
    fail(
      "INVALID_CONTRACT",
      "The source table allowlist does not match the retirement-manifest digest."
    );
  }

  const frozenArtifact = parsed.frozenSchemaFactsArtifact;
  const frozenArtifactHash = createHash("sha256").update(frozenSchemaFactsBytes).digest("hex");
  if (
    frozenArtifact?.path !== "migration/contracts/frozen-live-schema-facts.v1.json" ||
    frozenArtifact?.sha256 !== frozenArtifactHash
  ) {
    fail("INVALID_CONTRACT", "The frozen sanitized schema-facts artifact hash has drifted.");
  }
  const frozenSchemaFacts = JSON.parse(frozenSchemaFactsBytes.toString("utf8"));
  if (
    frozenSchemaFacts.version !== 1 ||
    frozenSchemaFacts.sourceProjectRef !== parsed.source.projectRef ||
    frozenSchemaFacts.contents !== "SANITIZED_CONTRACTS_ONLY" ||
    frozenSchemaFacts.policies?.length !== 128 ||
    frozenSchemaFacts.functions?.length !== 142 ||
    frozenSchemaFacts.defaultExpressionHashes?.length !== 381
  ) {
    fail("INVALID_CONTRACT", "Frozen sanitized schema facts are incomplete.");
  }
  const frozenCaptureArtifact = parsed.frozenSchemaCaptureHashesArtifact;
  const frozenCaptureArtifactHash = createHash("sha256")
    .update(frozenSchemaCaptureHashesBytes)
    .digest("hex");
  if (
    frozenCaptureArtifact?.path !==
      "migration/contracts/frozen-live-schema-capture-hashes.v1.json" ||
    frozenCaptureArtifact?.sha256 !== frozenCaptureArtifactHash
  ) {
    fail("INVALID_CONTRACT", "The frozen schema-capture hash artifact has drifted.");
  }
  const frozenSchemaCaptureHashes = JSON.parse(
    frozenSchemaCaptureHashesBytes.toString("utf8")
  );
  const captureSourceArtifacts = frozenSchemaCaptureHashes.sourceArtifacts ?? {};
  const captureCounts = frozenSchemaCaptureHashes.counts ?? {};
  const captureCollectionHashes = frozenSchemaCaptureHashes.collectionHashes ?? {};
  const lockedCaptureCounts = {
    tables: 70,
    columns: 1061,
    constraints: 270,
    indexes: 232,
    triggers: 24,
    policies: 118,
    custom_functions: 24,
    sequences: 0,
    enums: 12,
    extensions: 6,
    table_grants: 1929,
    routine_grants: 585,
    publication_tables: 3,
  };
  const lockedCaptureCollectionNames = [
    "tables",
    "columns",
    "constraints",
    "indexes",
    "triggers",
    "policies",
    "customFunctions",
    "sequences",
    "enums",
    "extensions",
    "tableGrants",
    "routineGrants",
    "publicationTables",
  ];
  const schemaCaptureSqlHash = createHash("sha256").update(schemaCaptureSqlBytes).digest("hex");
  if (
    frozenSchemaCaptureHashes.version !== 1 ||
    frozenSchemaCaptureHashes.sourceProjectRef !== parsed.source.projectRef ||
    frozenSchemaCaptureHashes.database !== parsed.source.database ||
    frozenSchemaCaptureHashes.postgresMajor !== 17 ||
    frozenSchemaCaptureHashes.contents !== "HASHES_COUNTS_AND_FUNCTION_SIGNATURES_ONLY" ||
    frozenSchemaCaptureHashes.captureMode !== "READ_ONLY_REPEATABLE_READ_ROLLBACK" ||
    Object.keys(captureCounts).length !== Object.keys(lockedCaptureCounts).length ||
    Object.entries(lockedCaptureCounts).some(([key, value]) => captureCounts[key] !== value) ||
    Object.keys(captureCollectionHashes).length !== lockedCaptureCollectionNames.length ||
    lockedCaptureCollectionNames.some(
      (key) => !/^[0-9a-f]{64}$/.test(captureCollectionHashes[key] ?? "")
    ) ||
    captureSourceArtifacts.repositoryStorage !== "FORBIDDEN" ||
    captureSourceArtifacts.encryptedSchemaDumpState !== "CAPTURED_ENCRYPTED_REVIEWED" ||
    captureSourceArtifacts.captureQuerySha256 !== schemaCaptureSqlHash ||
    [
      "normalizedCaptureSha256",
      "canonicalCaptureSha256",
      "rawQueryEnvelopeSha256",
      "captureQuerySha256",
    ].some((key) => !/^[0-9a-f]{64}$/.test(captureSourceArtifacts[key] ?? ""))
  ) {
    fail("INVALID_CONTRACT", "Frozen schema-capture hash evidence is incomplete.");
  }

  const encryptedDumpArtifact = parsed.frozenEncryptedSchemaDumpEvidenceArtifact;
  const encryptedDumpArtifactHash = createHash("sha256")
    .update(frozenEncryptedSchemaDumpEvidenceBytes)
    .digest("hex");
  if (
    encryptedDumpArtifact?.path !==
      "migration/contracts/frozen-encrypted-schema-dump-evidence.v1.json" ||
    encryptedDumpArtifact?.sha256 !== encryptedDumpArtifactHash
  ) {
    fail("INVALID_CONTRACT", "The frozen encrypted schema-dump evidence hash has drifted.");
  }
  const frozenEncryptedSchemaDumpEvidence = JSON.parse(
    frozenEncryptedSchemaDumpEvidenceBytes.toString("utf8")
  );
  const lockedEncryptedSchemaDumpEvidence = {
    version: 1,
    sourceProjectRef: "ibsisfnjxeowvdtvgzff",
    database: "postgres",
    scope: "SCHEMA_ONLY_PUBLIC",
    contents: "HASHES_COUNTS_GENERATIONS_AND_CONTROL_STATE_ONLY",
    dump: {
      plaintextSha256: "330de0785b3d8c109b538f9ffb75886c255e14bdbcfb8ecffa02e94ddaa7c570",
      compressedPlaintextSha256:
        "8f9a5bf29e5cfbf58f71dcf2510f16bb9abff835f76017f8475050daaf4bb4b2",
      bytes: 210_601,
      lines: 6_203,
      tables: 70,
      functions: 24,
      policies: 118,
      triggers: 24,
      explicitIndexes: 121,
      copyOrInsertStatements: 0,
      containsData: false,
    },
    encryption: {
      type: "CLOUD_KMS",
      keyVersion:
        "projects/hushh-tech-uat/locations/us-central1/keyRings/hushh-tech-cutover-uat/cryptoKeys/migration-archive/cryptoKeyVersions/1",
      keyVersionState: "ENABLED",
      algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION",
      protectionLevel: "SOFTWARE",
      ciphertextSha256:
        "da99ca16a8cee1646814f05087db9487555180ae653770b298467ddd63c606d7",
      ciphertextBytes: 25_971,
      roundTripVerified: true,
    },
    storage: {
      projectId: "hushh-tech-uat",
      bucket: "hushh-tech-migration-evidence-uat",
      object: "schema/2026-08-21/hushh-tech-public-schema.sql.gz.kms",
      generation: "1787322787490900",
      manifestObject: "schema/2026-08-21/hushh-tech-public-schema.dump.manifest.v1.json",
      manifestGeneration: "1787322790837124",
      manifestSha256:
        "eb923e8dd35abd11de7b35bc57234e76c5e8415012e701e20f9e9ce9965286ad",
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
      versioning: true,
      softDeleteSeconds: 604_800,
    },
    temporaryLoginRole: {
      roleName: "cli_login_postgres",
      enabledAt: "2026-08-21T14:31:54.410362Z",
      revokedAt: "2026-08-21T14:32:05.139879Z",
      finalCanLogin: false,
      finalValidUntil: "1970-01-01T00:00:00Z",
    },
    postCaptureVerification: {
      cliControlPlaneValidityRefreshObserved: true,
      loginRemainedDisabled: true,
      finalCleanupCanLogin: false,
      finalCleanupValidUntil: "1970-01-01T00:00:00Z",
      exactCleanupTimestampCaptured: false,
    },
    secretScan: {
      engine: "gitleaks",
      findingCount: 0,
    },
    repositoryStorage: {
      plaintextDump: "FORBIDDEN",
      compressedPlaintext: "FORBIDDEN",
      ciphertext: "FORBIDDEN",
      sanitizedEvidenceOnly: true,
    },
  };
  if (
    canonicalJson(frozenEncryptedSchemaDumpEvidence) !==
    canonicalJson(lockedEncryptedSchemaDumpEvidence)
  ) {
    fail(
      "INVALID_CONTRACT",
      "Frozen encrypted schema-dump evidence must match the reviewed hash-only artifact exactly."
    );
  }

  const expected = parsed.expected ?? {};
  const lockedExpectedCounts = {
    publicTables: 70,
    authUsers: 369,
    baselineRowCount: 44_811,
    repoPolicyDeclarations: 203,
    livePublicPolicies: 118,
    liveStoragePolicies: 10,
    livePublicFunctionSignatures: 142,
    liveCustomPublicFunctions: 24,
    applicationRpcs: 16,
    customTriggerFunctions: 8,
    defaultExpressions: 381,
  };
  for (const [name, count] of Object.entries(lockedExpectedCounts)) {
    if (expected[name] !== count) {
      fail("INVALID_CONTRACT", `${name} must remain locked to ${count}.`);
    }
  }

  if (
    parsed.firebaseAuthority?.projectId !== "hushh-pda" ||
    parsed.firebaseAuthority?.tenantId !== null ||
    Object.keys(parsed.firebaseAuthority ?? {}).sort().join(",") !== "projectId,tenantId"
  ) {
    fail(
      "INVALID_CONTRACT",
      "Firebase authority must remain locked to the tenantless hushh-pda project."
    );
  }

  const customSignatures = parsed.customPublicFunctionSignatures;
  if (
    !Array.isArray(customSignatures) ||
    customSignatures.length !== expected.liveCustomPublicFunctions ||
    new Set(customSignatures).size !== customSignatures.length ||
    customSignatures.some(
      (signature) =>
        typeof signature !== "string" ||
        signature.length === 0 ||
        signature.length > 20_000 ||
        signature.includes("\u0000")
    ) ||
    [...customSignatures]
      .sort()
      .some((signature, index) => signature !== customSignatures[index])
  ) {
    fail(
      "INVALID_CONTRACT",
      "The contract must contain the exact sorted 24-function custom public allowlist."
    );
  }
  const triggerSignatures = customSignatures.filter((signature) =>
    signature.endsWith("->trigger")
  );
  if (
    triggerSignatures.length !== expected.customTriggerFunctions ||
    customSignatures.length - triggerSignatures.length !== expected.applicationRpcs
  ) {
    fail(
      "INVALID_CONTRACT",
      "The custom function allowlist must split into 16 callable RPCs and 8 trigger functions."
    );
  }
  const definitionHashes = frozenSchemaCaptureHashes.customFunctionDefinitionHashes;
  if (
    !Array.isArray(definitionHashes) ||
    definitionHashes.length !== customSignatures.length ||
    definitionHashes.some(
      (entry, index) =>
        !entry ||
        Object.keys(entry).sort().join(",") !== "definitionHash,signature" ||
        entry.signature !== customSignatures[index] ||
        !/^[0-9a-f]{64}$/.test(entry.definitionHash ?? "")
    )
  ) {
    fail(
      "INVALID_CONTRACT",
      "Frozen schema capture must bind all 24 custom function definition hashes."
    );
  }
  const calculatedDefinitionEvidenceHash = createHash("sha256")
    .update(
      JSON.stringify(
        definitionHashes.map(({ definitionHash, signature }) => ({
          definitionHash,
          signature,
        }))
      ),
      "utf8"
    )
    .digest("hex");
  if (frozenSchemaCaptureHashes.customFunctionDefinitionsHash !== calculatedDefinitionEvidenceHash) {
    fail("INVALID_CONTRACT", "Frozen function-definition evidence hash has drifted.");
  }

  const liveEvidence = parsed.liveSchemaEvidence ?? {};
  if (
    liveEvidence.state !== "FROZEN_SANITIZED" ||
    liveEvidence.hashAlgorithm !== "sha256_canonical_json_v1" ||
    liveEvidence.publicPolicies !== expected.livePublicPolicies ||
    liveEvidence.storagePolicies !== expected.liveStoragePolicies ||
    liveEvidence.publicFunctionSignatures !== expected.livePublicFunctionSignatures ||
    liveEvidence.customPublicFunctions !== expected.liveCustomPublicFunctions ||
    liveEvidence.applicationRpcs !== expected.applicationRpcs ||
    liveEvidence.customTriggerFunctions !== expected.customTriggerFunctions ||
    liveEvidence.defaultExpressions !== expected.defaultExpressions
  ) {
    fail("INVALID_CONTRACT", "Frozen sanitized live-schema evidence is incomplete.");
  }
  const evidenceHashes = [
    "publicPoliciesHash",
    "storagePoliciesHash",
    "allPoliciesHash",
    "publicFunctionSignaturesHash",
    "customFunctionSignaturesHash",
    "applicationRpcSignaturesHash",
    "customTriggerSignaturesHash",
    "defaultExpressionHashesHash",
  ];
  if (evidenceHashes.some((key) => !/^[0-9a-f]{64}$/.test(liveEvidence[key] ?? ""))) {
    fail("INVALID_CONTRACT", "Frozen live-schema evidence must use SHA-256 hashes.");
  }
  const customFunctionDefinitionEvidence = liveEvidence.customFunctionDefinitionEvidence;
  if (
    customFunctionDefinitionEvidence?.state !== "CAPTURED_HASH_ONLY" ||
    customFunctionDefinitionEvidence?.hashAlgorithm !== "sha256_canonical_json_v1" ||
    customFunctionDefinitionEvidence?.functionCount !== expected.liveCustomPublicFunctions ||
    customFunctionDefinitionEvidence?.hash !==
      frozenSchemaCaptureHashes.customFunctionDefinitionsHash ||
    Object.keys(customFunctionDefinitionEvidence ?? {}).sort().join(",") !==
      "functionCount,hash,hashAlgorithm,state"
  ) {
    fail(
      "INVALID_CONTRACT",
      "Custom function definitions must bind to the reviewed hash-only capture."
    );
  }

  const schemaDump = parsed.schemaDumpArtifactContract ?? {};
  if (
    schemaDump.requiredForSeedOrRestore !== true ||
    schemaDump.hashAlgorithm !== "sha256" ||
    schemaDump.requiredEncryption !== "CLOUD_KMS" ||
    schemaDump.containsData !== false
  ) {
    fail(
      "INVALID_CONTRACT",
      "A reviewed Cloud KMS-encrypted schema-only dump is required for seed or restore."
    );
  }
  parsed.frozenSchemaFacts = frozenSchemaFacts;
  parsed.frozenSchemaCaptureHashes = frozenSchemaCaptureHashes;
  parsed.frozenEncryptedSchemaDumpEvidence = frozenEncryptedSchemaDumpEvidence;
  return deepFreeze(parsed);
}

export const SOURCE_CONTRACT = readContract();
export const PUBLIC_TABLES = Object.freeze([...SOURCE_CONTRACT.publicTables]);
export const CUSTOM_PUBLIC_FUNCTION_SIGNATURES = Object.freeze([
  ...SOURCE_CONTRACT.customPublicFunctionSignatures,
]);
export const APPLICATION_RPC_SIGNATURES = Object.freeze(
  CUSTOM_PUBLIC_FUNCTION_SIGNATURES.filter((signature) => !signature.endsWith("->trigger"))
);
export const CUSTOM_TRIGGER_FUNCTION_SIGNATURES = Object.freeze(
  CUSTOM_PUBLIC_FUNCTION_SIGNATURES.filter((signature) => signature.endsWith("->trigger"))
);
const PUBLIC_TABLE_SET = new Set(PUBLIC_TABLES);

export function isAllowlistedPublicTable(table) {
  return PUBLIC_TABLE_SET.has(table);
}

export function assertSqlIdentifier(value, label = "identifier") {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    fail("INVALID_IDENTIFIER", `${label} is not an allowlisted PostgreSQL identifier.`);
  }
  return value;
}

export function normalizeEnvironment(environment) {
  if (environment === "prod") return "production";
  if (environment === "uat" || environment === "production") return environment;
  fail("INVALID_ENVIRONMENT", "Environment must be uat or production.");
}

export function assertDryRunOnly(options = {}) {
  const dryRun = options.dryRun ?? options["dry-run"] ?? true;
  if (
    options.execute !== undefined ||
    options.apply !== undefined ||
    dryRun === false ||
    dryRun === "false" ||
    dryRun === "0"
  ) {
    fail(
      "EXECUTION_FORBIDDEN",
      "This package is plan-only. Live source or target execution is intentionally unavailable."
    );
  }
  return true;
}

export function assertMigrationBoundary({
  environment,
  sourceProjectRef,
  sourceDatabase,
  targetProject,
  targetRegion,
  targetInstance,
  targetDatabase,
  postgresMajor,
  dryRun = true,
  execute,
  apply,
}) {
  assertDryRunOnly({ dryRun, execute, apply });
  const normalizedEnvironment = normalizeEnvironment(environment);
  const expectedTarget = SOURCE_CONTRACT.targets[normalizedEnvironment];

  const actual = {
    sourceProjectRef,
    sourceDatabase,
    targetProject,
    targetRegion,
    targetInstance,
    targetDatabase,
    postgresMajor: Number(postgresMajor),
  };
  const expected = {
    sourceProjectRef: SOURCE_CONTRACT.source.projectRef,
    sourceDatabase: SOURCE_CONTRACT.source.database,
    targetProject: expectedTarget.projectId,
    targetRegion: expectedTarget.region,
    targetInstance: expectedTarget.instance,
    targetDatabase: expectedTarget.database,
    postgresMajor: expectedTarget.postgresMajor,
  };

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) {
      fail(
        "BOUNDARY_MISMATCH",
        `${key} does not match the locked ${normalizedEnvironment} migration boundary.`
      );
    }
  }

  return deepFreeze({
    mode: "DRY_RUN",
    environment: normalizedEnvironment,
    source: {
      projectRef: sourceProjectRef,
      database: sourceDatabase,
      schema: SOURCE_CONTRACT.source.schema,
    },
    target: {
      projectId: targetProject,
      region: targetRegion,
      instance: targetInstance,
      database: targetDatabase,
      postgresMajor: Number(postgresMajor),
    },
  });
}

const forbiddenOutputKey =
  /(?:password|secret|private.?key|service.?role|credential|authorization|access.?token|refresh.?token|connection.?string|dsn)/i;
const forbiddenOutputValue = [
  /postgres(?:ql)?:\/\//i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:eyJ|sk[_-]|sb_secret_)[A-Za-z0-9._-]{12,}\b/,
];

export function assertSafeForStdout(value, path = "output") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeForStdout(entry, `${path}[${index}]`));
    return value;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenOutputKey.test(key)) {
        fail("SECRET_OUTPUT_FORBIDDEN", `${path}.${key} is not allowed in standard output.`);
      }
      assertSafeForStdout(entry, `${path}.${key}`);
    }
    return value;
  }
  if (
    typeof value === "string" &&
    forbiddenOutputValue.some((pattern) => pattern.test(value))
  ) {
    fail("SECRET_OUTPUT_FORBIDDEN", `${path} contains secret-shaped material.`);
  }
  return value;
}

export function safeJsonForStdout(value) {
  assertSafeForStdout(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseCliArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      fail("INVALID_ARGUMENT", "Only named --arguments are accepted.");
    }
    const equalsAt = argument.indexOf("=");
    if (equalsAt !== -1) {
      const name = argument.slice(2, equalsAt);
      if (Object.hasOwn(result, name)) {
        fail("DUPLICATE_ARGUMENT", `--${name} may be provided only once.`);
      }
      result[name] = argument.slice(equalsAt + 1);
      continue;
    }
    const name = argument.slice(2);
    if (Object.hasOwn(result, name)) {
      fail("DUPLICATE_ARGUMENT", `--${name} may be provided only once.`);
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[name] = next;
      index += 1;
    } else {
      result[name] = true;
    }
  }
  return result;
}

export function boundaryFromCliArgs(args) {
  const environment = normalizeEnvironment(args.environment);
  const target = SOURCE_CONTRACT.targets[environment];
  return assertMigrationBoundary({
    environment,
    sourceProjectRef: args["source-project-ref"],
    sourceDatabase: args["source-database"],
    targetProject: args["target-project"],
    targetRegion: args["target-region"],
    targetInstance: args["target-instance"],
    targetDatabase: args["target-database"],
    postgresMajor: args["postgres-major"] ?? target.postgresMajor,
    dryRun: args["dry-run"] ?? true,
    execute: Object.hasOwn(args, "execute") ? true : undefined,
    apply: Object.hasOwn(args, "apply") ? true : undefined,
  });
}
