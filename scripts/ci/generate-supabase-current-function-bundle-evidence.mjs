import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import {
  CAPTURE_TOOL_VERSION,
  EXPECTED_ACTIVE_FUNCTIONS,
  EXPECTED_PROJECT_REF,
  normalizeLiveFunctionMetadata,
} from "./capture-supabase-current-function-bundles.mjs";

export const DEFAULT_MANIFEST_PATH = path.join(
  "migration",
  "manifests",
  "supabase-retirement.v1.json"
);
export const DEFAULT_HISTORICAL_EVIDENCE_PATH = path.join(
  "migration",
  "evidence",
  "supabase-live-function-bundles.v1.json"
);
export const DEFAULT_CURRENT_EVIDENCE_PATH = path.join(
  "migration",
  "evidence",
  "supabase-current-live-function-bundles.v2.json"
);

export const CANONICAL_RECORD_ENCODING =
  "uint32be_field_count_then_uint64be_length_prefixed_utf8_fields_v2";
export const BUNDLE_DIGEST_ALGORITHM =
  "sha256_length_prefixed_utf8_bundle_file_records_v2";
export const METADATA_DIGEST_ALGORITHM =
  "sha256_length_prefixed_utf8_current_function_metadata_records_v2";
export const CURRENT_SOURCE_TREE_DIGEST_ALGORITHM =
  "sha256_length_prefixed_utf8_per_slug_bundle_summary_records_v2";
export const EVIDENCE_DIGEST_ALGORITHM =
  "sha256_length_prefixed_utf8_canonical_json_record_v2";
export const ATTEMPT_EVIDENCE_DIGEST_ALGORITHM =
  "sha256_length_prefixed_utf8_attempt_response_class_records_v2";
export const RECOVERY_SNAPSHOT_DIGEST_ALGORITHM =
  "sha256_length_prefixed_utf8_recovery_file_records_v2";

export const DEFAULT_RECOVERY_LIMITS = Object.freeze({
  maxFiles: 1_024,
  maxDirectories: 768,
  maxDepth: 16,
  maxComponentBytes: 255,
  maxRelativePathBytes: 4_096,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFunctionFiles: 512,
  maxFunctionBytes: 32 * 1024 * 1024,
});

const EXPECTED_LINKED_PROJECT_FILE_DIGEST =
  "159c45434d2c598698e61218b70d9f6168d14da193ae6780d4f8c175b8a41433";
const EXPECTED_CLI_LATEST_FILE_DIGEST =
  "c9bc27863494f40747ca15f4ffc262af03b0d7a212c5344d0c94ad387436baac";
const EMPTY_FILE_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const APPROVED_DEPENDENCY_DIRECTORIES = new Set([
  "_shared",
  "fund-payment-request",
  "kyc-agent-a2a-protocol",
]);
const SAFE_MODE_MASK = 0o7022;
const decoder = new TextDecoder("utf-8", { fatal: true });

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

export const assertSafeCanonicalString = (value, label = "Canonical field") => {
  assert(typeof value === "string", `${label} must be a string.`);
  assert(value === value.normalize("NFC"), `${label} must use Unicode NFC normalization.`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    assert(
      !((code >= 0 && code <= 31) || (code >= 127 && code <= 159)),
      `${label} contains a forbidden control character.`
    );
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      assert(
        next >= 0xdc00 && next <= 0xdfff,
        `${label} contains an unpaired Unicode surrogate.`
      );
      index += 1;
    } else {
      assert(
        code < 0xdc00 || code > 0xdfff,
        `${label} contains an unpaired Unicode surrogate.`
      );
    }
  }
  return value;
};

const uint64be = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
};

export const encodeCanonicalRecord = (fields) => {
  assert(Array.isArray(fields), "Canonical record fields must be an array.");
  assert(fields.length <= 1_024, "Canonical record has too many fields.");
  const count = Buffer.alloc(4);
  count.writeUInt32BE(fields.length);
  const chunks = [count];
  for (const [index, field] of fields.entries()) {
    const normalized = assertSafeCanonicalString(String(field), `Canonical field ${index}`);
    const bytes = Buffer.from(normalized, "utf8");
    chunks.push(uint64be(bytes.length), bytes);
  }
  return Buffer.concat(chunks);
};

const digestCanonicalRecords = (domain, records) => {
  assertSafeCanonicalString(domain, "Canonical record domain");
  const header = encodeCanonicalRecord([
    "hushh-current-function-evidence",
    CANONICAL_RECORD_ENCODING,
    domain,
    String(records.length),
  ]);
  const hash = crypto.createHash("sha256");
  hash.update(header);
  for (const record of records) hash.update(encodeCanonicalRecord(record));
  return hash.digest("hex");
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => {
          assertSafeCanonicalString(key, "Canonical JSON key");
          return [key, canonicalize(value[key])];
        })
    );
  }
  if (typeof value === "string") assertSafeCanonicalString(value, "Canonical JSON string");
  return value;
};

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));

const validateLimits = (limits) => {
  const keys = Object.keys(DEFAULT_RECOVERY_LIMITS);
  assert(
    Object.keys(limits).length === keys.length && keys.every((key) => key in limits),
    "Recovery limits must define the exact global cap set."
  );
  for (const key of keys) {
    assert(Number.isSafeInteger(limits[key]) && limits[key] > 0, `Recovery limit ${key} is invalid.`);
  }
  assert(limits.maxDepth <= 64, "Recovery depth cap is unsafe.");
  assert(limits.maxComponentBytes <= 255, "Recovery component-byte cap is unsafe.");
  assert(limits.maxRelativePathBytes <= 4_096, "Recovery path-byte cap is unsafe.");
};

const requireOwnedSafeMode = (stat, label, { file = false } = {}) => {
  assert(typeof process.getuid === "function", "Recovery ownership checks require a POSIX user ID.");
  assert(Number(stat.uid) === process.getuid(), `${label} is not owned by the current user.`);
  if (file) assert(Number(stat.nlink) === 1, `${label} must have exactly one hard link.`);
  assert((Number(stat.mode) & SAFE_MODE_MASK) === 0, `${label} has an unsafe mode.`);
};

const sameStableFileStat = (before, after) =>
  ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeNs", "ctimeNs"]
    .every((field) => before[field] === after[field]);

const sameStableDirectoryStat = (before, after) =>
  ["dev", "ino", "mode", "nlink", "uid", "gid", "mtimeMs", "ctimeMs"]
    .every((field) => before[field] === after[field]);

const readStableFileOnce = ({ absolutePath, relativePath, state, limits }) => {
  assert(state.fileCount + 1 <= limits.maxFiles, "Recovery tree exceeds the global file cap.");
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assert(before.isFile(), `Recovery entry ${relativePath} is not a regular file.`);
    requireOwnedSafeMode(before, `Recovery file ${relativePath}`, { file: true });
    assert(before.size <= BigInt(limits.maxFileBytes), `Recovery file ${relativePath} is oversized.`);
    assert(
      BigInt(state.totalBytes) + before.size <= BigInt(limits.maxTotalBytes),
      "Recovery tree exceeds the global byte cap."
    );
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    assert(
      sameStableFileStat(before, after) && BigInt(bytes.length) === before.size,
      `Recovery file ${relativePath} changed while it was being sealed.`
    );
    state.fileCount += 1;
    state.totalBytes += bytes.length;
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
};

export const snapshotRecoveryTree = ({
  recoveryRoot,
  limits = DEFAULT_RECOVERY_LIMITS,
}) => {
  validateLimits(limits);
  const absoluteRoot = path.resolve(recoveryRoot);
  const rootStat = fs.lstatSync(absoluteRoot);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Recovery root must be a real directory.");
  requireOwnedSafeMode(rootStat, "Recovery root");

  const state = { fileCount: 0, directoryCount: 1, totalBytes: 0 };
  assert(state.directoryCount <= limits.maxDirectories, "Recovery tree exceeds the global directory cap.");
  const files = new Map();
  const directories = new Set([""]);

  const walk = (absoluteDirectory, relativeDirectory, depth) => {
    assert(depth <= limits.maxDepth, "Recovery tree exceeds the global depth cap.");
    const beforeDirectory = fs.lstatSync(absoluteDirectory);
    const directory = fs.opendirSync(absoluteDirectory);
    try {
      let entry;
      while ((entry = directory.readSync()) !== null) {
      assertSafeCanonicalString(entry.name, "Recovery path component");
      assert(entry.name !== "." && entry.name !== "..", "Recovery path component is unsafe.");
      assert(
        Buffer.byteLength(entry.name, "utf8") <= limits.maxComponentBytes,
        "Recovery path component exceeds the global byte cap."
      );
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      assert(
        Buffer.byteLength(relativePath, "utf8") <= limits.maxRelativePathBytes,
        "Recovery relative path exceeds the global byte cap."
      );
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stat = fs.lstatSync(absolutePath);
      assert(!stat.isSymbolicLink(), `Recovery entry ${relativePath} is a forbidden symbolic link.`);
      if (stat.isDirectory()) {
        requireOwnedSafeMode(stat, `Recovery directory ${relativePath}`);
        assert(
          state.directoryCount + 1 <= limits.maxDirectories,
          "Recovery tree exceeds the global directory cap."
        );
        assert(depth + 1 <= limits.maxDepth, "Recovery tree exceeds the global depth cap.");
        state.directoryCount += 1;
        directories.add(relativePath);
        walk(absolutePath, relativePath, depth + 1);
      } else {
        const bytes = readStableFileOnce({ absolutePath, relativePath, state, limits });
        files.set(relativePath, bytes);
      }
      }
    } finally {
      directory.closeSync();
    }
    const afterDirectory = fs.lstatSync(absoluteDirectory);
    assert(
      sameStableDirectoryStat(beforeDirectory, afterDirectory),
      `Recovery directory ${relativeDirectory || "."} changed while it was being sealed.`
    );
  };
  walk(absoluteRoot, "", 0);
  return Object.freeze({
    files,
    directories,
    counts: Object.freeze({
      files: state.fileCount,
      directories: state.directoryCount,
      total_bytes: state.totalBytes,
    }),
  });
};

const parseSnapshotJson = (snapshot, relativePath, label) => {
  const bytes = snapshot.files.get(relativePath);
  assert(bytes, `${label} is missing from the recovery snapshot.`);
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
};

const exactKeys = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort(compareUtf8)) ===
    JSON.stringify([...keys].sort(compareUtf8))
  );
};

const validateReceipt = ({ receipt, normalizedMetadata }) => {
  assert(
    exactKeys(receipt, [
      "schema_version",
      "project_ref",
      "tool",
      "tool_version",
      "source_write_mode",
      "capture_started_at_utc",
      "capture_completed_at_utc",
      "active_functions",
      "outcomes",
    ]),
    "Capture receipt fields are invalid."
  );
  assert(receipt.schema_version === 1, "Capture receipt schema is invalid.");
  assert(receipt.project_ref === EXPECTED_PROJECT_REF, "Capture receipt project is invalid.");
  assert(receipt.tool === "supabase_cli", "Capture receipt tool is invalid.");
  assert(receipt.tool_version === CAPTURE_TOOL_VERSION, "Capture receipt tool version is invalid.");
  assert(receipt.source_write_mode === "READ_ONLY_NO_DEPLOYMENT", "Capture receipt is not read-only.");
  for (const field of ["capture_started_at_utc", "capture_completed_at_utc"]) {
    assertSafeCanonicalString(receipt[field], `Capture receipt ${field}`);
    assert(
      typeof receipt[field] === "string" && new Date(receipt[field]).toISOString() === receipt[field],
      `Capture receipt ${field} is invalid.`
    );
  }
  assert(
    Date.parse(receipt.capture_completed_at_utc) >= Date.parse(receipt.capture_started_at_utc),
    "Capture receipt timestamps are reversed."
  );
  assert(receipt.active_functions === EXPECTED_ACTIVE_FUNCTIONS, "Capture receipt count is invalid.");
  assert(Array.isArray(receipt.outcomes), "Capture receipt outcomes are missing.");
  assert(receipt.outcomes.length === normalizedMetadata.length, "Capture receipt outcomes are incomplete.");
  const expectedSlugs = normalizedMetadata.map((entry) => entry.slug);
  const observedSlugs = receipt.outcomes.map((entry) => entry.slug);
  assert(
    JSON.stringify(observedSlugs) === JSON.stringify(expectedSlugs),
    "Capture receipt outcomes must match the sorted live metadata slugs."
  );
};

const validateCliBookkeeping = (snapshot, slug, accountedFiles, { requireCliLatest }) => {
  const prefix = slug ? `${slug}/` : "";
  const label = slug || "capture root";
  const linkedPath = `${prefix}supabase/.temp/linked-project.json`;
  const cliPath = `${prefix}supabase/.temp/cli-latest`;
  const linkedBytes = snapshot.files.get(linkedPath);
  const cliBytes = snapshot.files.get(cliPath);
  assert(linkedBytes, `CLI bookkeeping is incomplete for ${label}.`);
  assert(
    requireCliLatest ? Boolean(cliBytes) : !cliBytes,
    `CLI version bookkeeping topology is invalid for ${label}.`
  );
  assert(sha256(linkedBytes) === EXPECTED_LINKED_PROJECT_FILE_DIGEST, `Linked-project metadata changed for ${label}.`);
  if (cliBytes) {
    assert(
      [EXPECTED_CLI_LATEST_FILE_DIGEST, EMPTY_FILE_DIGEST].includes(sha256(cliBytes)),
      `CLI version metadata changed for ${label}.`
    );
  }
  const linked = parseSnapshotJson(snapshot, linkedPath, `Linked-project metadata for ${label}`);
  assert(
    exactKeys(linked, ["ref", "name", "organization_id", "organization_slug"]) &&
      linked.ref === EXPECTED_PROJECT_REF &&
      linked.name === "hushh-ai" &&
      linked.organization_id === "rvbvlurmuppmecrarvma" &&
      linked.organization_slug === "rvbvlurmuppmecrarvma",
    `Linked-project metadata is invalid for ${label}.`
  );
  if (cliBytes) {
    assert(
      cliBytes.length === 0 || decoder.decode(cliBytes) === `v${CAPTURE_TOOL_VERSION}`,
      `CLI version metadata is invalid for ${label}.`
    );
  }
  accountedFiles.add(linkedPath);
  if (cliBytes) accountedFiles.add(cliPath);
};

const classifyAttemptResponse = ({ stdout, slug }) => {
  if (
    exactKeys(stdout, ["message", "project_ref", "function_slugs"]) &&
    stdout.message === "Downloaded Edge Function source." &&
    stdout.project_ref === EXPECTED_PROJECT_REF &&
    JSON.stringify(stdout.function_slugs) === JSON.stringify([slug])
  ) {
    return "EXTRACTED";
  }
  if (
    exactKeys(stdout, ["_tag", "error"]) &&
    stdout._tag === "Error" &&
    exactKeys(stdout.error, ["code", "message"]) &&
    stdout.error.code === "UnknownError" &&
    stdout.error.message === 'Error status 404: {"message":"Function store not found"}'
  ) {
    return "STORE_NOT_FOUND";
  }
  if (
    exactKeys(stdout, ["_tag", "error"]) &&
    stdout._tag === "Error" &&
    exactKeys(stdout.error, ["code", "message"]) &&
    stdout.error.code === "FunctionsApiStatusError" &&
    stdout.error.message === 'Error status 500: {"message":"Failed to retrieve function bundle"}'
  ) {
    return "BUNDLE_RETRIEVAL_FAILED";
  }
  return "UNEXPECTED_RESPONSE";
};

export const digestAttemptEvidence = (attemptClasses) =>
  digestCanonicalRecords(
    "attempt-response-classes-v2",
    attemptClasses.map((responseClass, index) => [String(index + 1), responseClass])
  );

const canonicalRecoveredSourcePath = ({ slug, sourceRelativePath }) => {
  const prefix = `${slug}/supabase/functions/`;
  assert(sourceRelativePath.startsWith(prefix), `Recovered source path is outside ${slug}.`);
  const withinFunctions = sourceRelativePath.slice(prefix.length);
  const components = withinFunctions.split("/");
  assert(components.every(Boolean), `Recovered source path is malformed for ${slug}.`);
  const direct = components[0];
  if (direct === "import_map.json") {
    assert(components.length === 1, `Recovered import map path is malformed for ${slug}.`);
    return `supabase/functions/${slug}/__dependencies__/import_map.json`;
  }
  if (direct === slug) {
    assert(components.length >= 2, `Recovered source path lacks a file under exact slug ${slug}.`);
    return `supabase/functions/${slug}/${components.slice(1).join("/")}`;
  }
  assert(
    APPROVED_DEPENDENCY_DIRECTORIES.has(direct) && components.length >= 2,
    `Recovered source has an unapproved direct child for ${slug}.`
  );
  return `supabase/functions/${slug}/__dependencies__/${components.join("/")}`;
};

const collectSourceFiles = ({ snapshot, slug, limits, accountedFiles, accountedDirectories }) => {
  const sourceRoot = `${slug}/supabase/functions`;
  assert(snapshot.directories.has(sourceRoot), `Extracted function ${slug} has no functions directory.`);
  const exactSlugRoot = `${sourceRoot}/${slug}`;
  assert(snapshot.directories.has(exactSlugRoot), `Extracted function ${slug} lacks its exact-slug root.`);
  const sourceFiles = [...snapshot.files.entries()]
    .filter(([relativePath]) => relativePath.startsWith(`${sourceRoot}/`))
    .map(([sourceRelativePath, bytes]) => ({
      sourceRelativePath,
      canonicalPath: canonicalRecoveredSourcePath({ slug, sourceRelativePath }),
      bytes,
    }));
  assert(sourceFiles.length >= 1, `Extracted function ${slug} contains no source files.`);
  assert(sourceFiles.length <= limits.maxFunctionFiles, `Extracted function ${slug} contains too many files.`);
  assert(
    sourceFiles.some(({ sourceRelativePath }) => sourceRelativePath.startsWith(`${exactSlugRoot}/`)),
    `Extracted function ${slug} has no file under its exact-slug root.`
  );
  const totalBytes = sourceFiles.reduce((sum, entry) => sum + entry.bytes.length, 0);
  assert(totalBytes <= limits.maxFunctionBytes, `Extracted function ${slug} is too large.`);
  const canonicalPaths = sourceFiles.map((entry) => entry.canonicalPath);
  assert(new Set(canonicalPaths).size === canonicalPaths.length, `Canonical source paths collide for ${slug}.`);

  for (const entry of sourceFiles) accountedFiles.add(entry.sourceRelativePath);
  const sourceDirectories = [...snapshot.directories].filter(
    (relativePath) => relativePath === sourceRoot || relativePath.startsWith(`${sourceRoot}/`)
  );
  for (const relativePath of sourceDirectories) {
    if (relativePath !== sourceRoot) {
      const withinFunctions = relativePath.slice(`${sourceRoot}/`.length);
      const direct = withinFunctions.split("/")[0];
      assert(
        direct === slug || APPROVED_DEPENDENCY_DIRECTORIES.has(direct),
        `Recovered source has an unapproved directory for ${slug}.`
      );
      assert(
        sourceFiles.some(({ sourceRelativePath }) => sourceRelativePath.startsWith(`${relativePath}/`)),
        `Recovered source contains an empty directory for ${slug}.`
      );
    }
    accountedDirectories.add(relativePath);
  }
  return sourceFiles
    .map((entry) => ({
      relativePath: entry.canonicalPath,
      bytes: entry.bytes,
      size: entry.bytes.length,
      digest: sha256(entry.bytes),
    }))
    .sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
};

const bundleEvidenceForFiles = (files) => ({
  digest_algorithm: BUNDLE_DIGEST_ALGORITHM,
  canonical_digest: digestCanonicalRecords(
    "bundle-files-v2",
    files.map((file) => [file.relativePath, file.digest, String(file.size)])
  ),
  file_count: files.length,
  total_bytes: files.reduce((sum, file) => sum + file.size, 0),
});

const readAttemptResponses = ({ snapshot, outcome, accountedFiles }) => {
  return Array.from({ length: outcome.attempts }, (_, index) => {
    const attempt = index + 1;
    const stdoutPath = `${outcome.slug}.attempt-${attempt}.stdout`;
    const stderrPath = `${outcome.slug}.attempt-${attempt}.stderr`;
    assert(snapshot.files.has(stdoutPath) && snapshot.files.has(stderrPath), `Capture attempts are incomplete for ${outcome.slug}.`);
    const stderr = snapshot.files.get(stderrPath);
    assert(stderr.length === 0, `Capture stderr must stay empty for ${outcome.slug}.`);
    const stdout = parseSnapshotJson(snapshot, stdoutPath, `Capture stdout for ${outcome.slug}`);
    accountedFiles.add(stdoutPath);
    accountedFiles.add(stderrPath);
    return { attempt, stdout };
  });
};

export const inspectRecoverySnapshot = ({
  snapshot,
  manifest,
  limits = DEFAULT_RECOVERY_LIMITS,
}) => {
  validateLimits(limits);
  const rawMetadata = parseSnapshotJson(snapshot, "functions-list.json", "Function metadata");
  const normalizedMetadata = normalizeLiveFunctionMetadata({ manifest, liveMetadata: rawMetadata });
  for (const entry of normalizedMetadata) {
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === "string") assertSafeCanonicalString(value, `${entry.slug}.${key}`);
    }
  }
  const receipt = parseSnapshotJson(snapshot, "capture-receipt.json", "Capture receipt");
  validateReceipt({ receipt, normalizedMetadata });

  const accountedFiles = new Set(["functions-list.json", "capture-receipt.json"]);
  const accountedDirectories = new Set(["", "supabase", "supabase/.temp"]);
  assert(
    snapshot.directories.has("supabase") && snapshot.directories.has("supabase/.temp"),
    "Root CLI bookkeeping topology is incomplete."
  );
  validateCliBookkeeping(snapshot, "", accountedFiles, { requireCliLatest: true });
  const sourceFilesBySlug = new Map();
  const attemptClassesBySlug = new Map();
  const outcomeBySlug = new Map();

  for (const outcome of receipt.outcomes) {
    assertSafeCanonicalString(outcome.slug, "Capture outcome slug");
    const successKeys = ["slug", "status", "retryable", "project_ref", "attempts"];
    const failureKeys = [
      "slug",
      "status",
      "retryable",
      "http_status",
      "provider_error_code",
      "failure_class",
      "attempts",
    ];
    assert(
      exactKeys(outcome, outcome.status === "EXTRACTED" ? successKeys : failureKeys),
      `Capture outcome fields are invalid for ${outcome.slug}.`
    );
    assert(!outcomeBySlug.has(outcome.slug), `Capture receipt duplicates ${outcome.slug}.`);
    assert(Number.isInteger(outcome.attempts) && outcome.attempts >= 1 && outcome.attempts <= 3, `Capture attempt count is invalid for ${outcome.slug}.`);
    outcomeBySlug.set(outcome.slug, outcome);

    const baseDirectories = [
      outcome.slug,
      `${outcome.slug}/supabase`,
      `${outcome.slug}/supabase/.temp`,
    ];
    for (const relativePath of baseDirectories) {
      assert(snapshot.directories.has(relativePath), `Recovery topology is incomplete for ${outcome.slug}.`);
      accountedDirectories.add(relativePath);
    }
    validateCliBookkeeping(snapshot, outcome.slug, accountedFiles, {
      requireCliLatest: outcome.status === "EXTRACTED",
    });
    const attempts = readAttemptResponses({ snapshot, outcome, accountedFiles });
    const attemptClasses = attempts.map(({ stdout }) =>
      classifyAttemptResponse({ stdout, slug: outcome.slug })
    );
    attemptClassesBySlug.set(outcome.slug, attemptClasses);

    if (outcome.status === "EXTRACTED") {
      assert(outcome.retryable === false && outcome.project_ref === EXPECTED_PROJECT_REF, `Extracted outcome is invalid for ${outcome.slug}.`);
      assert(
        attemptClasses.at(-1) === "EXTRACTED" &&
          attemptClasses.slice(0, -1).every((value) => value === "BUNDLE_RETRIEVAL_FAILED"),
        `Download retry sequence is invalid for ${outcome.slug}.`
      );
      sourceFilesBySlug.set(
        outcome.slug,
        collectSourceFiles({
          snapshot,
          slug: outcome.slug,
          limits,
          accountedFiles,
          accountedDirectories,
        })
      );
    } else {
      const sourcePrefix = `${outcome.slug}/supabase/functions`;
      assert(
        ![...snapshot.files.keys()].some((relativePath) => relativePath === sourcePrefix || relativePath.startsWith(`${sourcePrefix}/`)) &&
          ![...snapshot.directories].some((relativePath) => relativePath === sourcePrefix || relativePath.startsWith(`${sourcePrefix}/`)),
        `Terminal failed bundle ${outcome.slug} contains partial source under its attempt source root.`
      );
      if (outcome.status === "STORE_NOT_FOUND") {
        assert(
          outcome.retryable === false &&
            outcome.http_status === 404 &&
            outcome.provider_error_code === "UnknownError" &&
            outcome.failure_class === "FUNCTION_STORE_NOT_FOUND" &&
            outcome.attempts === 1 &&
            JSON.stringify(attemptClasses) === JSON.stringify(["STORE_NOT_FOUND"]),
          `Store-not-found outcome is invalid for ${outcome.slug}.`
        );
      } else {
        assert(outcome.status === "BUNDLE_RETRIEVAL_FAILED", `Unexpected capture status for ${outcome.slug}.`);
        assert(
          outcome.retryable === true &&
            outcome.http_status === 500 &&
            outcome.provider_error_code === "FunctionsApiStatusError" &&
            outcome.failure_class === "FAILED_TO_RETRIEVE_FUNCTION_BUNDLE" &&
            outcome.attempts === 3 &&
            attemptClasses.every((value) => value === "BUNDLE_RETRIEVAL_FAILED"),
          `Terminal bundle-retrieval evidence is incomplete for ${outcome.slug}.`
        );
      }
    }
  }

  const unaccountedFiles = [...snapshot.files.keys()].filter((value) => !accountedFiles.has(value));
  const unaccountedDirectories = [...snapshot.directories].filter(
    (value) => !accountedDirectories.has(value)
  );
  assert(unaccountedFiles.length === 0, "Recovery snapshot contains an unaccounted file.");
  assert(unaccountedDirectories.length === 0, "Recovery snapshot contains an unaccounted directory.");
  assert(accountedFiles.size === snapshot.files.size, "Recovery file accounting is incomplete.");
  assert(accountedDirectories.size === snapshot.directories.size, "Recovery directory accounting is incomplete.");

  return Object.freeze({
    rawMetadata,
    normalizedMetadata,
    receipt,
    outcomeBySlug,
    sourceFilesBySlug,
    attemptClassesBySlug,
    recoveryCounts: snapshot.counts,
    recoverySnapshotDigest: digestCanonicalRecords(
      "recovery-snapshot-files-v2",
      [...snapshot.files.entries()]
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([relativePath, bytes]) => [relativePath, sha256(bytes), String(bytes.length)])
    ),
  });
};

const writeImmutableFile = (filePath, bytes, mode = 0o400) => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode
  );
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const readTrustedFileOnce = (filePath, label) => {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assert(before.isFile() && before.nlink === 1n, `${label} must be a single-link regular file.`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    assert(sameStableFileStat(before, after) && before.size === BigInt(bytes.length), `${label} changed while being read.`);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
};

const materializeImmutableSourceSnapshot = ({ inventory, configPath }) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "hushh-current-source-scan."));
  fs.chmodSync(base, 0o700);
  const sourceRoot = path.join(base, "recovered");
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  const createdDirectories = new Set([sourceRoot]);
  const allFiles = [...inventory.sourceFilesBySlug.values()].flat();
  for (const sourceFile of allFiles) {
    const components = sourceFile.relativePath.split("/");
    let parent = sourceRoot;
    for (const component of components.slice(0, -1)) {
      parent = path.join(parent, component);
      if (!createdDirectories.has(parent)) {
        fs.mkdirSync(parent, { mode: 0o700 });
        createdDirectories.add(parent);
      }
    }
    const destination = path.join(sourceRoot, ...components);
    assert(destination.startsWith(`${sourceRoot}${path.sep}`), "Immutable source destination escaped its root.");
    writeImmutableFile(destination, sourceFile.bytes);
  }
  const configBytes = readTrustedFileOnce(configPath, "Gitleaks config");
  const configCopy = path.join(base, "gitleaks.toml");
  writeImmutableFile(configCopy, configBytes);
  for (const directory of [...createdDirectories].sort((left, right) => right.length - left.length)) {
    fs.chmodSync(directory, 0o500);
  }
  return { base, sourceRoot, configCopy, configBytes, createdDirectories };
};

const removePrivateSnapshot = ({ base, createdDirectories }) => {
  const realTemp = `${fs.realpathSync(os.tmpdir())}${path.sep}`;
  assert(base.startsWith(realTemp) && path.basename(base).startsWith("hushh-current-source-scan."), "Private scan cleanup target is invalid.");
  for (const directory of [...createdDirectories].sort((left, right) => left.length - right.length)) {
    if (fs.existsSync(directory)) fs.chmodSync(directory, 0o700);
  }
  fs.rmSync(base, { recursive: true, force: false });
};

export const runRecoveredSourceSecretScan = ({
  inventory,
  configPath = path.resolve(".gitleaks.toml"),
  gitleaksBinary = "gitleaks",
}) => {
  const approvedConfigPath = path.resolve(".gitleaks.toml");
  assert(path.resolve(configPath) === approvedConfigPath, "Gitleaks config path is not approved.");
  const immutable = materializeImmutableSourceSnapshot({ inventory, configPath: approvedConfigPath });
  try {
    const versionResult = spawnSync(gitleaksBinary, ["version"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    assert(versionResult.status === 0, "Unable to resolve gitleaks version.");
    assert(/^8\.24\.2(?:\b|$)/.test(versionResult.stdout.trim()), "Recovered source scan requires gitleaks 8.24.2.");
    const result = spawnSync(
      gitleaksBinary,
      [
        "dir",
        immutable.sourceRoot,
        "--config",
        immutable.configCopy,
        "--redact=100",
        "--no-banner",
        "--max-target-megabytes",
        "16",
      ],
      {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 512 * 1024,
      }
    );
    assert(result.status === 0 || result.status === 1, "Recovered source gitleaks scan failed to run.");
    assert(result.status === 0, "Recovered live source contains gitleaks findings; evidence integration is blocked.");
    return {
      tool: "gitleaks",
      tool_version: "8.24.2",
      config_digest: sha256(immutable.configBytes),
      status: "PASS",
      finding_count: 0,
    };
  } finally {
    removePrivateSnapshot(immutable);
  }
};

export const digestCurrentMetadata = (entries) =>
  digestCanonicalRecords(
    "current-function-metadata-v2",
    [...entries]
      .sort((left, right) => compareUtf8(left.slug, right.slug))
      .map((entry) => [
        entry.slug,
        entry.function_id,
        entry.status,
        String(entry.current_version),
        String(entry.manifest_version),
        String(entry.version_delta),
        String(entry.verify_jwt),
        entry.provider_bundle_digest || "",
      ])
  );

export const digestCurrentSourceTree = (entries) =>
  digestCanonicalRecords(
    "current-source-tree-v2",
    entries
      .filter((entry) => entry.capture_status === "EXTRACTED")
      .sort((left, right) => compareUtf8(left.slug, right.slug))
      .map((entry) => [
        entry.slug,
        entry.bundle_evidence.canonical_digest,
        String(entry.bundle_evidence.file_count),
        String(entry.bundle_evidence.total_bytes),
      ])
  );

export const digestCurrentEvidence = (evidence) => {
  const clone = structuredClone(evidence);
  delete clone.evidence_digest;
  return digestCanonicalRecords("current-evidence-canonical-json-v2", [[canonicalJson(clone)]]);
};

export const buildCurrentFunctionBundleEvidence = ({
  manifest,
  historicalEvidence,
  inventory,
  sourceSecretScan,
  manifestBytes,
  historicalEvidenceBytes,
}) => {
  assert(historicalEvidence?.schema_version === 1, "Historical bundle evidence is invalid.");
  assert(historicalEvidence?.evidence_id === "hushh-tech-supabase-live-function-bundles", "Historical bundle evidence identity is invalid.");
  assert(historicalEvidence.manifest_binding?.source_project_ref === EXPECTED_PROJECT_REF, "Historical evidence targets an unexpected project.");
  assert(
    sourceSecretScan?.tool === "gitleaks" &&
      sourceSecretScan?.tool_version === "8.24.2" &&
      sourceSecretScan.status === "PASS" &&
      sourceSecretScan.finding_count === 0,
    "Recovered source scan provenance is invalid."
  );

  const historicalBySlug = new Map(historicalEvidence.entries.map((entry) => [entry.slug, entry]));
  const entries = inventory.normalizedMetadata.map((metadata) => {
    const historical = historicalBySlug.get(metadata.slug);
    const outcome = inventory.outcomeBySlug.get(metadata.slug);
    const attemptClasses = inventory.attemptClassesBySlug.get(metadata.slug);
    assert(historical && outcome && attemptClasses, `Current evidence inputs are incomplete for ${metadata.slug}.`);
    assert(historical.function_id === metadata.function_id, `Historical ID drift for ${metadata.slug}.`);
    assert(historical.verify_jwt === metadata.verify_jwt, `Historical auth drift for ${metadata.slug}.`);
    const common = {
      ...metadata,
      historical_capture_status: historical.capture_status,
      capture_status: outcome.status,
      capture_attempts: outcome.attempts,
    };
    if (outcome.status === "EXTRACTED") {
      return {
        ...common,
        bundle_evidence: bundleEvidenceForFiles(inventory.sourceFilesBySlug.get(metadata.slug)),
      };
    }
    return {
      ...common,
      retrieval_failure: {
        http_status: outcome.http_status,
        provider_error_code: outcome.provider_error_code,
        failure_class: outcome.failure_class,
        terminal_after_max_attempts: outcome.status === "BUNDLE_RETRIEVAL_FAILED",
        attempt_response_classes: attemptClasses,
        attempt_evidence_digest_algorithm: ATTEMPT_EVIDENCE_DIGEST_ALGORITHM,
        attempt_evidence_digest: digestAttemptEvidence(attemptClasses),
      },
    };
  });

  const nonZeroVersionDeltas = [...new Set(entries.map((entry) => entry.version_delta).filter((delta) => delta !== 0))];
  assert(nonZeroVersionDeltas.length === 1, "Current version drift must have one explicit uniform delta for deterministic review.");
  const counts = {
    active_functions: entries.length,
    version_exact: entries.filter((entry) => entry.version_delta === 0).length,
    version_drifted: entries.filter((entry) => entry.version_delta !== 0).length,
    version_uniform_drift_delta: nonZeroVersionDeltas[0],
    version_uniform_drift_count: entries.filter((entry) => entry.version_delta === nonZeroVersionDeltas[0]).length,
    provider_bundle_digests_present: entries.filter((entry) => entry.provider_bundle_digest).length,
    provider_bundle_digests_missing: entries.filter((entry) => !entry.provider_bundle_digest).length,
    extracted_bundles: entries.filter((entry) => entry.capture_status === "EXTRACTED").length,
    store_not_found: entries.filter((entry) => entry.capture_status === "STORE_NOT_FOUND").length,
    bundle_retrieval_failed: entries.filter((entry) => entry.capture_status === "BUNDLE_RETRIEVAL_FAILED").length,
    capture_attempts_total: entries.reduce((sum, entry) => sum + entry.capture_attempts, 0),
    extracted_on_first_attempt: entries.filter((entry) => entry.capture_status === "EXTRACTED" && entry.capture_attempts === 1).length,
    terminal_failures_after_max_attempts: entries.filter((entry) => entry.capture_status === "BUNDLE_RETRIEVAL_FAILED" && entry.capture_attempts === 3).length,
    extracted_files: entries.reduce((sum, entry) => sum + Number(entry.bundle_evidence?.file_count || 0), 0),
    extracted_bytes: entries.reduce((sum, entry) => sum + Number(entry.bundle_evidence?.total_bytes || 0), 0),
  };
  const currentSourceTreeDigest = digestCurrentSourceTree(entries);
  const evidence = {
    schema_version: 2,
    evidence_id: "hushh-tech-supabase-current-live-function-bundles",
    canonicalization: {
      version: 2,
      record_encoding: CANONICAL_RECORD_ENCODING,
      string_contract: "UTF8_NFC_NO_C0_C1_OR_DEL_CONTROL_CHARACTERS",
      recovery_snapshot_contract:
        "SINGLE_OPEN_O_NOFOLLOW_REGULAR_NLINK1_CURRENT_OWNER_SAFE_MODE_STABLE_FSTAT_IMMUTABLE_PRIVATE_COPY_V2",
    },
    capture: {
      project_ref: EXPECTED_PROJECT_REF,
      capture_started_at_utc: inventory.receipt.capture_started_at_utc,
      capture_completed_at_utc: inventory.receipt.capture_completed_at_utc,
      metadata_surface: "GET /v1/projects/{ref}/functions via supabase_cli",
      bundle_surface: "GET /v1/projects/{ref}/functions/{slug}/body via supabase_cli_download_use_api",
      tool: "supabase_cli",
      tool_version: CAPTURE_TOOL_VERSION,
      source_write_mode: "READ_ONLY_NO_DEPLOYMENT",
    },
    capture_integrity: {
      recovery_snapshot_digest_algorithm: RECOVERY_SNAPSHOT_DIGEST_ALGORITHM,
      recovery_snapshot_digest: inventory.recoverySnapshotDigest,
      recovery_file_count: inventory.recoveryCounts.files,
      recovery_directory_count: inventory.recoveryCounts.directories,
      recovery_total_bytes: inventory.recoveryCounts.total_bytes,
      accounting_status: "EXACT_NO_UNACCOUNTED_FILES_OR_DIRECTORIES",
    },
    historical_binding: {
      manifest_id: manifest.manifest_id,
      manifest_schema_version: manifest.schema_version,
      manifest_file_digest: sha256(manifestBytes),
      manifest_active_functions_digest: manifest.inventory_digests.active_functions,
      historical_evidence_id: historicalEvidence.evidence_id,
      historical_evidence_schema_version: historicalEvidence.schema_version,
      historical_evidence_file_digest: sha256(historicalEvidenceBytes),
      historical_entry_digest: historicalEvidence.evidence_digest.digest,
      historical_source_tree_digest_algorithm: historicalEvidence.canonical_source_tree.digest_algorithm,
      historical_source_tree_digest: historicalEvidence.canonical_source_tree.digest,
    },
    sanitization: {
      recovered_source_content_committed: false,
      raw_cli_output_committed: false,
      secret_or_token_values_committed: false,
      temporary_absolute_paths_committed: false,
      public_evidence: "current_metadata_safe_digests_file_counts_byte_counts_and_retry_classes_only",
    },
    source_secret_scan: sourceSecretScan,
    cutover_assessment: {
      status: "CUTOVER_BLOCKING_VERSION_DRIFT",
      frozen_snapshot_uniform_version_delta: nonZeroVersionDeltas[0],
      required_next_capture: "FREEZE_EDGE_FUNCTION_DEPLOYMENTS_THEN_REPEAT_FULL_READ_ONLY_112_FUNCTION_CAPTURE",
      metadata_end_check_status: "NOT_PERFORMED_IN_V2_BLOCKING",
      bundle_to_metadata_version_binding_status: "NOT_PROVEN_WITHOUT_END_METADATA_CHECK",
      source_revision_status: "NOT_PROVEN",
      source_revision: null,
      source_revision_reason: "SUPPORTED_LIST_AND_BODY_METADATA_DO_NOT_EXPOSE_A_DEPLOY_RUN_OR_GIT_SHA",
    },
    historical_comparison: {
      comparison_basis: "SAFE_DIGESTS_AND_COUNTS_ONLY",
      content_equivalence_status: "NOT_ASSERTED_BETWEEN_V1_AND_V2_CANONICALIZATION",
      historical_extracted_bundles: historicalEvidence.expected_counts.extracted_bundles,
      historical_extracted_files: historicalEvidence.expected_counts.extracted_files,
      historical_extracted_bytes: historicalEvidence.expected_counts.extracted_bytes,
      historical_source_tree_digest_algorithm: historicalEvidence.canonical_source_tree.digest_algorithm,
      historical_source_tree_digest: historicalEvidence.canonical_source_tree.digest,
      current_extracted_bundles: counts.extracted_bundles,
      current_extracted_files: counts.extracted_files,
      current_extracted_bytes: counts.extracted_bytes,
      current_source_tree_digest_algorithm: CURRENT_SOURCE_TREE_DIGEST_ALGORITHM,
      current_source_tree_digest: currentSourceTreeDigest,
    },
    observed_counts: counts,
    current_metadata_digest: {
      digest_algorithm: METADATA_DIGEST_ALGORITHM,
      digest: digestCurrentMetadata(entries),
    },
    canonical_source_tree: {
      digest_algorithm: CURRENT_SOURCE_TREE_DIGEST_ALGORITHM,
      digest: currentSourceTreeDigest,
    },
    entries,
  };
  evidence.evidence_digest = {
    digest_algorithm: EVIDENCE_DIGEST_ALGORITHM,
    digest: digestCurrentEvidence(evidence),
  };
  return evidence;
};

const safeWriteApprovedEvidence = ({ outputPath, evidence }) => {
  const absolute = path.resolve(outputPath);
  const approved = path.resolve(DEFAULT_CURRENT_EVIDENCE_PATH);
  assert(absolute === approved, `Evidence output must be exactly ${DEFAULT_CURRENT_EVIDENCE_PATH}.`);
  assert(!fs.existsSync(absolute), "Current evidence output is create-only.");
  const parent = path.dirname(absolute);
  const parentStat = fs.lstatSync(parent);
  assert(parentStat.isDirectory() && !parentStat.isSymbolicLink(), "Evidence directory is missing or unsafe.");
  const descriptor = fs.openSync(
    absolute,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o644
  );
  try {
    fs.writeFileSync(descriptor, JSON.stringify(evidence, null, 2) + "\n");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const parseArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const manifestPath = parseArg("--manifest") || DEFAULT_MANIFEST_PATH;
  const historicalEvidencePath = parseArg("--historical-evidence") || DEFAULT_HISTORICAL_EVIDENCE_PATH;
  const recoveryRoot = parseArg("--recovery-root");
  const outputPath = parseArg("--output") || DEFAULT_CURRENT_EVIDENCE_PATH;
  assert(recoveryRoot, "--recovery-root is required and never written into public evidence.");
  const manifestBytes = fs.readFileSync(path.resolve(manifestPath));
  const historicalEvidenceBytes = fs.readFileSync(path.resolve(historicalEvidencePath));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const historicalEvidence = JSON.parse(historicalEvidenceBytes.toString("utf8"));
  const snapshot = snapshotRecoveryTree({ recoveryRoot: path.resolve(recoveryRoot) });
  const inventory = inspectRecoverySnapshot({ snapshot, manifest });
  const sourceSecretScan = runRecoveredSourceSecretScan({ inventory });
  const evidence = buildCurrentFunctionBundleEvidence({
    manifest,
    historicalEvidence,
    inventory,
    sourceSecretScan,
    manifestBytes,
    historicalEvidenceBytes,
  });
  safeWriteApprovedEvidence({ outputPath, evidence });
  console.log(
    `Generated ${outputPath}: ${evidence.observed_counts.active_functions} active, ` +
      `${evidence.observed_counts.extracted_bundles} extracted, ` +
      `${evidence.observed_counts.bundle_retrieval_failed} retrieval failures.`
  );
}
