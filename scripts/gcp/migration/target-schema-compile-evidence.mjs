import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash } from "./canonical-hash.mjs";
import {
  MigrationContractError,
  assertDryRunOnly,
  assertSafeForStdout,
  parseCliArgs,
  safeJsonForStdout,
} from "./contract.mjs";
import {
  TARGET_SCHEMA_PHASES,
  validatePrivateTargetSchemaPlan,
  validateTargetSchemaPlanEvidence,
} from "./target-schema-compiler.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const EVIDENCE_PATH = fileURLToPath(
  new URL(
    "../../../migration/contracts/target-schema-offline-compile-evidence.v1.json",
    import.meta.url,
  ),
);
const COMPILER_PATH = fileURLToPath(new URL("./target-schema-compiler.mjs", import.meta.url));
const VALIDATOR_PATH = fileURLToPath(import.meta.url);
const FOUNDATION_PATH = fileURLToPath(
  new URL("../../../migration/sql/001_identity_migration_foundation.sql", import.meta.url),
);
const ENCRYPTED_EVIDENCE_PATH = fileURLToPath(
  new URL(
    "../../../migration/contracts/frozen-encrypted-schema-dump-evidence.v1.json",
    import.meta.url,
  ),
);
const BASE_HEAD_SHA = "db16ad242cd3bff6164af401bb582862fdaf4e3e";
const EXPECTED_EXACT_PLAN_SHA256 =
  "a0b849fe7747df94a47aa56600011234c889e583d99b9a6d7fca451eaf2c3549";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_EVIDENCE = [
  /(?:^|["\s])\/(?:Users|private|tmp)\//i,
  /gs:\/\//i,
  /projects\/[^/]+\/locations\//i,
  /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE)\s+(?:TABLE|FUNCTION|POLICY|ROLE|SCHEMA)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /postgres(?:ql)?:\/\//i,
  /\b(?:eyJ|sk[_-]|sb_secret_|ghp_|github_pat_)[A-Za-z0-9._-]{12,}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

function fail(code, message) {
  throw new MigrationContractError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (actual.join("\u0000") !== wanted.join("\u0000")) {
    fail("OFFLINE_COMPILE_EVIDENCE_INVALID", `${label} fields have drifted.`);
  }
}

function evidenceEnvelope(evidence) {
  const { evidenceSha256: _digest, ...envelope } = evidence;
  return envelope;
}

function expectedBindings() {
  const encryptedBytes = readFileSync(ENCRYPTED_EVIDENCE_PATH);
  const encrypted = JSON.parse(encryptedBytes.toString("utf8"));
  return {
    compilerSha256: sha256(readFileSync(COMPILER_PATH)),
    validatorSha256: sha256(readFileSync(VALIDATOR_PATH)),
    foundationSha256: sha256(readFileSync(FOUNDATION_PATH)),
    encryptedEvidenceArtifactSha256: sha256(encryptedBytes),
    sourceLocatorSha256: canonicalHash({
      projectId: encrypted.storage.projectId,
      bucket: encrypted.storage.bucket,
      object: encrypted.storage.object,
      generation: encrypted.storage.generation,
    }),
    kmsLocatorSha256: sha256(Buffer.from(encrypted.encryption.keyVersion, "utf8")),
    ciphertextSha256: encrypted.encryption.ciphertextSha256,
    ciphertextBytes: encrypted.encryption.ciphertextBytes,
    compressedPlaintextSha256: encrypted.dump.compressedPlaintextSha256,
    compressedPlaintextBytes: encrypted.dump.compressedPlaintextBytes,
    plaintextSha256: encrypted.dump.plaintextSha256,
    plaintextBytes: encrypted.dump.bytes,
    plaintextLines: encrypted.dump.lines,
  };
}

function assertSanitizedEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  if (FORBIDDEN_EVIDENCE.some((pattern) => pattern.test(serialized))) {
    fail(
      "OFFLINE_COMPILE_EVIDENCE_LEAK",
      "Offline compile evidence contains a forbidden path, SQL body, identity, or credential shape.",
    );
  }
}

export function validateTargetSchemaOfflineCompileEvidence(evidence) {
  assertExactKeys(
    evidence,
    [
      "version",
      "state",
      "baseHeadSha",
      "bindings",
      "plan",
      "scan",
      "retention",
      "evidenceSha256",
    ],
    "offline compile evidence",
  );
  assertExactKeys(
    evidence.bindings,
    [
      "compilerSha256",
      "validatorSha256",
      "foundationSha256",
      "encryptedEvidenceArtifactSha256",
      "sourceLocatorSha256",
      "kmsLocatorSha256",
      "ciphertextSha256",
      "ciphertextBytes",
      "compressedPlaintextSha256",
      "compressedPlaintextBytes",
      "plaintextSha256",
      "plaintextBytes",
      "plaintextLines",
    ],
    "offline compile bindings",
  );
  assertExactKeys(evidence.scan, ["engine", "findingCount", "scope"], "offline compile scan");
  assertExactKeys(
    evidence.retention,
    [
      "repositoryPlaintext",
      "repositoryCompiledSql",
      "repositoryCiphertext",
      "temporaryMaterial",
      "retainedContents",
    ],
    "offline compile retention",
  );

  const expected = expectedBindings();
  if (
    evidence.version !== 1 ||
    evidence.state !== "EXACT_PRIVATE_DUMP_OFFLINE_COMPILE_VERIFIED" ||
    evidence.baseHeadSha !== BASE_HEAD_SHA ||
    !/^[0-9a-f]{40}$/.test(evidence.baseHeadSha) ||
    Object.keys(expected).some((key) => evidence.bindings[key] !== expected[key])
  ) {
    fail("OFFLINE_COMPILE_EVIDENCE_INVALID", "Offline compile input bindings have drifted.");
  }
  if (
    Object.entries(evidence.bindings).some(([key, value]) =>
      key.endsWith("Sha256") ? !SHA256_PATTERN.test(value ?? "") : false,
    ) ||
    evidence.bindings.ciphertextBytes !== 25971 ||
    evidence.bindings.compressedPlaintextBytes !== 25886 ||
    evidence.bindings.plaintextBytes !== 210601 ||
    evidence.bindings.plaintextLines !== 6203
  ) {
    fail("OFFLINE_COMPILE_EVIDENCE_INVALID", "Offline compile hashes or source counts are invalid.");
  }

  validateTargetSchemaPlanEvidence({ report: evidence.plan });
  if (
    evidence.plan.sourceEvidence.plaintextSha256 !== evidence.bindings.plaintextSha256 ||
    evidence.plan.sourceEvidence.encryptedEvidenceArtifactSha256 !==
      evidence.bindings.encryptedEvidenceArtifactSha256 ||
    evidence.plan.phases.length !== TARGET_SCHEMA_PHASES.length ||
    evidence.plan.planSha256 !== EXPECTED_EXACT_PLAN_SHA256 ||
    evidence.plan.execution.blockers.includes("REAL_DUMP_OFFLINE_COMPILE_REQUIRED") ||
    evidence.plan.execution.applyReady !== false ||
    evidence.plan.execution.liveConnectionsAvailable !== false
  ) {
    fail("OFFLINE_COMPILE_EVIDENCE_INVALID", "Offline compile plan binding is incomplete.");
  }
  if (
    evidence.scan.engine !== "gitleaks" ||
    evidence.scan.findingCount !== 0 ||
    evidence.scan.scope !== "DECRYPTED_AND_COMPILED_TEMP" ||
    evidence.retention.repositoryPlaintext !== "FORBIDDEN" ||
    evidence.retention.repositoryCompiledSql !== "FORBIDDEN" ||
    evidence.retention.repositoryCiphertext !== "FORBIDDEN" ||
    evidence.retention.temporaryMaterial !== "OPERATOR_VERIFIED_REMOVED_BEFORE_REVIEW" ||
    evidence.retention.retainedContents !== "HASHES_COUNTS_AND_CONTROL_STATE_ONLY"
  ) {
    fail("OFFLINE_COMPILE_EVIDENCE_INVALID", "Offline compile scan or retention state has drifted.");
  }
  if (
    !SHA256_PATTERN.test(evidence.evidenceSha256 ?? "") ||
    evidence.evidenceSha256 !== canonicalHash(evidenceEnvelope(evidence))
  ) {
    fail("OFFLINE_COMPILE_EVIDENCE_INVALID", "Offline compile evidence digest has drifted.");
  }
  assertSanitizedEvidence(evidence);
  return true;
}

function assertPrivateOutputDirectory(outputDirectory) {
  if (!isAbsolute(outputDirectory)) {
    fail("PRIVATE_PATH_REQUIRED", "The private compiler output directory must be absolute.");
  }
  const resolved = resolve(outputDirectory);
  const repositoryRelative = relative(REPOSITORY_ROOT, resolved);
  if (
    repositoryRelative === "" ||
    (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== "..")
  ) {
    fail("REPOSITORY_PLAINTEXT_FORBIDDEN", "Private compiler output cannot be inside the repository.");
  }
  const status = lstatSync(resolved);
  if (!status.isDirectory() || status.isSymbolicLink() || (statSync(resolved).mode & 0o777) !== 0o700) {
    fail("PRIVATE_OUTPUT_INVALID", "Private compiler output must be a non-symlink mode-0700 directory.");
  }
  const expectedFiles = [...TARGET_SCHEMA_PHASES, "target-schema-plan.v1.json"].sort();
  const actualFiles = readdirSync(resolved).sort();
  if (actualFiles.join("\u0000") !== expectedFiles.join("\u0000")) {
    fail("PRIVATE_OUTPUT_INVALID", "Private compiler output must contain only the exact reviewed files.");
  }
  const phases = {};
  for (const name of TARGET_SCHEMA_PHASES) {
    const path = resolve(resolved, name);
    const fileStatus = lstatSync(path);
    if (!fileStatus.isFile() || fileStatus.isSymbolicLink() || (fileStatus.mode & 0o777) !== 0o600) {
      fail("PRIVATE_OUTPUT_INVALID", "A private phase has unsafe type or permissions.");
    }
    phases[name] = readFileSync(path, "utf8");
  }
  const reportPath = resolve(resolved, "target-schema-plan.v1.json");
  const reportStatus = lstatSync(reportPath);
  if (!reportStatus.isFile() || reportStatus.isSymbolicLink() || (reportStatus.mode & 0o777) !== 0o600) {
    fail("PRIVATE_OUTPUT_INVALID", "The private plan report has unsafe type or permissions.");
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  validatePrivateTargetSchemaPlan({ report, phases });
  return { phases, report };
}

export function buildTargetSchemaOfflineCompileEvidence({
  report,
  phases,
  scanFindingCount,
}) {
  validatePrivateTargetSchemaPlan({ report, phases });
  if (scanFindingCount !== 0) {
    fail("OFFLINE_COMPILE_SCAN_FAILED", "Private compile evidence requires a zero-finding scan.");
  }
  const evidence = {
    version: 1,
    state: "EXACT_PRIVATE_DUMP_OFFLINE_COMPILE_VERIFIED",
    baseHeadSha: BASE_HEAD_SHA,
    bindings: expectedBindings(),
    plan: report,
    scan: {
      engine: "gitleaks",
      findingCount: 0,
      scope: "DECRYPTED_AND_COMPILED_TEMP",
    },
    retention: {
      repositoryPlaintext: "FORBIDDEN",
      repositoryCompiledSql: "FORBIDDEN",
      repositoryCiphertext: "FORBIDDEN",
      temporaryMaterial: "OPERATOR_VERIFIED_REMOVED_BEFORE_REVIEW",
      retainedContents: "HASHES_COUNTS_AND_CONTROL_STATE_ONLY",
    },
  };
  evidence.evidenceSha256 = canonicalHash(evidence);
  validateTargetSchemaOfflineCompileEvidence(evidence);
  return evidence;
}

export function runTargetSchemaCompileEvidenceCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const allowed = new Set(["generate", "validate", "private-output-dir", "scan-findings", "dry-run"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    fail("INVALID_ARGUMENT", "Offline compile evidence received an unsupported argument.");
  }
  assertDryRunOnly({ dryRun: args["dry-run"] ?? true });
  const generate = Object.hasOwn(args, "generate");
  const validate = Object.hasOwn(args, "validate");
  if (generate === validate) {
    fail("INVALID_ARGUMENT", "Choose exactly one of --generate or --validate.");
  }
  let evidence;
  if (generate) {
    if (!args["private-output-dir"] || args["scan-findings"] === undefined) {
      fail("INVALID_ARGUMENT", "Generation requires private output and scan finding count.");
    }
    const scanFindingCount = Number(args["scan-findings"]);
    const { report, phases } = assertPrivateOutputDirectory(args["private-output-dir"]);
    evidence = buildTargetSchemaOfflineCompileEvidence({ report, phases, scanFindingCount });
    if (lstatExists(EVIDENCE_PATH)) {
      fail("EVIDENCE_ALREADY_EXISTS", "Offline compile evidence already exists.");
    }
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } else {
    evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
    validateTargetSchemaOfflineCompileEvidence(evidence);
  }
  const summary = {
    state: evidence.state,
    evidenceSha256: evidence.evidenceSha256,
    planSha256: evidence.plan.planSha256,
    phaseCount: evidence.plan.phases.length,
    applyReady: evidence.plan.execution.applyReady,
    liveConnectionsAvailable: evidence.plan.execution.liveConnectionsAvailable,
    blockerCount: evidence.plan.execution.blockers.length,
    scanFindingCount: evidence.scan.findingCount,
  };
  assertSafeForStdout(summary);
  process.stdout.write(safeJsonForStdout(summary));
  return summary;
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runTargetSchemaCompileEvidenceCli();
  } catch (error) {
    const code = error instanceof MigrationContractError ? error.code : "UNEXPECTED_ERROR";
    const message =
      error instanceof MigrationContractError
        ? error.message
        : "Offline compile evidence validation failed closed.";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
