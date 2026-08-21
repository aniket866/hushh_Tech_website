#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StorageCutoverError,
  buildCheckpointPlan,
  buildDeltaPlan,
  buildSeedCopyPlan,
  parseJsonLines,
  reconcileInventories,
  safeContractSummary,
  validateSecondaryReferenceGates,
  validateSourceInventory,
  validateTargetInventory,
} from "./storage-cutover-contract.mjs";

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const VALUE_ARGUMENTS = new Set([
  "--mode",
  "--environment",
  "--source",
  "--target",
  "--checkpoint",
  "--secondary",
]);
const ALLOWED_MODES = new Set([
  "contract",
  "validate-source",
  "validate-target",
  "seed-plan",
  "delta-plan",
  "checkpoint-plan",
  "reconcile",
  "secondary-gate",
]);
const COMMON_ARGUMENTS = new Set(["--mode", "--environment"]);
const MODE_ARGUMENTS = new Map([
  ["contract", { allowed: [], required: [] }],
  ["validate-source", { allowed: ["--source", "--checkpoint"], required: ["--source"] }],
  ["validate-target", { allowed: ["--target"], required: ["--target"] }],
  ["seed-plan", { allowed: ["--source"], required: ["--source"] }],
  ["delta-plan", { allowed: ["--source", "--target", "--checkpoint"], required: ["--source", "--target", "--checkpoint"] }],
  ["checkpoint-plan", { allowed: ["--source", "--target", "--checkpoint"], required: ["--source", "--target"] }],
  ["reconcile", { allowed: ["--source", "--target", "--checkpoint"], required: ["--source", "--target"] }],
  ["secondary-gate", { allowed: ["--secondary"], required: ["--secondary"] }],
]);

const fail = (code, message) => {
  throw new StorageCutoverError(code, message);
};

const parseArguments = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!VALUE_ARGUMENTS.has(argument)) {
      fail("UNSUPPORTED_ARGUMENT", "Only documented planning arguments are accepted.");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("MISSING_ARGUMENT_VALUE", `${argument} requires a value.`);
    }
    if (values.has(argument)) fail("DUPLICATE_ARGUMENT", `${argument} was supplied more than once.`);
    values.set(argument, value);
    index += 1;
  }
  return values;
};

const assertPlanningEnvironment = (environment) => {
  if (environment !== "uat") {
    fail("PRODUCTION_EXECUTION_BLOCKED", "This foundation only accepts the UAT planning environment.");
  }
};

const assertModeArguments = (values, mode) => {
  const specification = MODE_ARGUMENTS.get(mode);
  const allowed = new Set([...COMMON_ARGUMENTS, ...specification.allowed]);
  for (const argument of values.keys()) {
    if (!allowed.has(argument)) {
      fail("UNEXPECTED_ARGUMENT_FOR_MODE", `${argument} is not accepted in ${mode} mode.`);
    }
  }
  for (const argument of specification.required) {
    if (!values.has(argument)) fail("MISSING_MODE_ARGUMENT", `${mode} mode requires ${argument}.`);
  }
};

const lstatLexicalPathWithoutSymlinks = (absolutePath, label) => {
  const { root } = parse(absolutePath);
  const components = relative(root, absolutePath).split(sep).filter(Boolean);
  let currentPath = root;
  let status = lstatSync(root);
  for (const component of components) {
    currentPath = resolve(currentPath, component);
    try {
      status = lstatSync(currentPath);
    } catch {
      fail("PRIVATE_INPUT_NOT_FOUND", `${label} input was not found.`);
    }
    if (status.isSymbolicLink()) {
      fail(
        "PRIVATE_INPUT_SYMLINK_BLOCKED",
        `${label} path must not contain a symbolic link.`,
      );
    }
  }
  return status;
};

const assertPrivateLocalInput = (inputPath, label) => {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    fail("MISSING_PRIVATE_INPUT", `${label} input is required.`);
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(inputPath)) {
    fail("LIVE_OR_REMOTE_INPUT_BLOCKED", `${label} must be a local file, not a URL or cloud path.`);
  }
  const resolvedPath = resolve(inputPath);
  let initialStatus;
  try {
    initialStatus = lstatLexicalPathWithoutSymlinks(resolvedPath, label);
  } catch (error) {
    if (error instanceof StorageCutoverError) throw error;
    fail("PRIVATE_INPUT_NOT_FOUND", `${label} input was not found.`);
  }
  if (!initialStatus.isFile()) {
    fail("PRIVATE_INPUT_NOT_REGULAR", `${label} must be a regular file.`);
  }
  if (initialStatus.size > 8_388_608) {
    fail("PRIVATE_INPUT_TOO_LARGE", `${label} exceeds the 8388608-byte safety limit.`);
  }
  let realPath;
  try {
    realPath = realpathSync(resolvedPath);
  } catch {
    fail("PRIVATE_INPUT_NOT_FOUND", `${label} input was not found.`);
  }
  const pathFromRoot = relative(repositoryRoot, realPath);
  const isInsideRepository = pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`);
  const isIgnoredTemporaryInput = pathFromRoot === "tmp" || pathFromRoot.startsWith(`tmp${sep}`);
  if (isInsideRepository && !isIgnoredTemporaryInput) {
    fail(
      "TRACKED_PRIVATE_INPUT_BLOCKED",
      `${label} must stay outside tracked repository paths; use the ignored tmp directory or an external path.`,
    );
  }
  return resolvedPath;
};

const readPrivateLocalInput = (values, flag, label) => {
  const path = assertPrivateLocalInput(values.get(flag), label);
  let descriptor;
  try {
    const initialStatus = lstatSync(path);
    if (initialStatus.isSymbolicLink()) {
      fail("PRIVATE_INPUT_SYMLINK_BLOCKED", `${label} must not be a symbolic link.`);
    }
    if (!initialStatus.isFile()) fail("PRIVATE_INPUT_NOT_REGULAR", `${label} must be a regular file.`);
    if (initialStatus.size > 8_388_608) {
      fail("PRIVATE_INPUT_TOO_LARGE", `${label} exceeds the 8388608-byte safety limit.`);
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const status = fstatSync(descriptor);
    if (!status.isFile()) fail("PRIVATE_INPUT_NOT_REGULAR", `${label} must be a regular file.`);
    if (status.size > 8_388_608) {
      fail("PRIVATE_INPUT_TOO_LARGE", `${label} exceeds the 8388608-byte safety limit.`);
    }
    if (
      status.dev !== initialStatus.dev ||
      status.ino !== initialStatus.ino ||
      status.size !== initialStatus.size
    ) {
      fail("PRIVATE_INPUT_CHANGED", `${label} changed while it was opened.`);
    }
    const bytes = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const overflowProbe = Buffer.alloc(1);
    if (offset !== bytes.length || readSync(descriptor, overflowProbe, 0, 1, offset) !== 0) {
      fail("PRIVATE_INPUT_CHANGED", `${label} changed while it was read.`);
    }
    return bytes.toString("utf8");
  } catch (error) {
    if (error instanceof StorageCutoverError) throw error;
    fail("PRIVATE_INPUT_READ_FAILED", `${label} could not be read safely.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const loadJsonLines = (values, flag, label) => {
  return parseJsonLines(readPrivateLocalInput(values, flag, label), label);
};

const loadJson = (values, flag, label) => {
  try {
    return JSON.parse(readPrivateLocalInput(values, flag, label));
  } catch (error) {
    if (error instanceof StorageCutoverError) throw error;
    fail("INVALID_JSON_INPUT", `${label} is not valid JSON.`);
  }
};

const loadOptionalJson = (values, flag, label) =>
  values.has(flag) ? loadJson(values, flag, label) : null;

const safeInventorySummary = (inventory) => ({
  valid: true,
  digestSha256: inventory.digestSha256,
  bucketCount: inventory.bucketRecords.length,
  objectCount: inventory.objectCount,
  totalBytes: inventory.totalBytes,
});

export const runStorageCutoverPlanner = (argv) => {
  const values = parseArguments(argv);
  const mode = values.get("--mode") || "contract";
  if (!ALLOWED_MODES.has(mode)) fail("UNSUPPORTED_MODE", "Only documented dry-run modes are accepted.");
  assertModeArguments(values, mode);
  assertPlanningEnvironment(values.get("--environment") || "uat");

  if (mode === "contract") return safeContractSummary();
  if (mode === "validate-source") {
    return safeInventorySummary(
      validateSourceInventory(loadJsonLines(values, "--source", "source inventory"), {
        previousCheckpoint: loadOptionalJson(values, "--checkpoint", "previous checkpoint"),
      }),
    );
  }
  if (mode === "validate-target") {
    return safeInventorySummary(validateTargetInventory(loadJsonLines(values, "--target", "target inventory")));
  }
  if (mode === "seed-plan") {
    return buildSeedCopyPlan(loadJsonLines(values, "--source", "source inventory"));
  }
  if (mode === "checkpoint-plan") {
    return buildCheckpointPlan(
      loadJsonLines(values, "--source", "source inventory"),
      loadJsonLines(values, "--target", "target inventory"),
      loadOptionalJson(values, "--checkpoint", "previous checkpoint"),
    );
  }
  if (mode === "delta-plan") {
    return buildDeltaPlan(
      loadJsonLines(values, "--source", "source inventory"),
      loadJsonLines(values, "--target", "target inventory"),
      loadJson(values, "--checkpoint", "checkpoint"),
    );
  }
  if (mode === "reconcile") {
    return reconcileInventories(
      loadJsonLines(values, "--source", "source inventory"),
      loadJsonLines(values, "--target", "target inventory"),
      loadOptionalJson(values, "--checkpoint", "previous checkpoint"),
    );
  }
  return validateSecondaryReferenceGates(loadJson(values, "--secondary", "secondary gate"));
};

const invokedAsScript = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));

if (invokedAsScript) {
  try {
    process.stdout.write(`${JSON.stringify(runStorageCutoverPlanner(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    const code = error instanceof StorageCutoverError ? error.code : "PLANNER_FAILED";
    const message = error instanceof Error ? error.message : "Storage cutover planner failed.";
    process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    process.exitCode = 1;
  }
}
