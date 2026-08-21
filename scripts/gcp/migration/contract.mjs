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

function readContract() {
  const parsed = JSON.parse(readFileSync(contractUrl, "utf8"));
  const frozenSchemaFactsBytes = readFileSync(frozenSchemaFactsUrl);
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
  if (
    liveEvidence.customFunctionDefinitionEvidence?.state !== "NOT_CAPTURED_BLOCKING" ||
    liveEvidence.customFunctionDefinitionEvidence?.hash !== null
  ) {
    fail(
      "INVALID_CONTRACT",
      "Custom function body evidence must remain blocking until governed capture."
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
