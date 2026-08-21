import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import { MigrationContractError } from "./contract.mjs";

function fail(code, message) {
  throw new MigrationContractError(code, message);
}

function toBigInt(value, label) {
  if (typeof value === "bigint") return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  fail("INVALID_INPUT_FILE", `Protected input ${label} metadata is invalid.`);
}

export function assertProtectedInputOwnershipAndMode(
  metadata,
  currentUid = typeof process.getuid === "function" ? process.getuid() : undefined
) {
  if (!metadata || typeof metadata.isFile !== "function" || !metadata.isFile()) {
    fail("INVALID_INPUT_FILE", "Protected input must be a regular file.");
  }
  if (!Number.isSafeInteger(currentUid) || currentUid < 0) {
    fail(
      "INPUT_OWNERSHIP_UNAVAILABLE",
      "Current-user ownership cannot be verified on this platform."
    );
  }
  const ownerUid = toBigInt(metadata.uid, "owner");
  const mode = toBigInt(metadata.mode, "mode");
  if (ownerUid !== BigInt(currentUid)) {
    fail(
      "PRIVATE_INPUT_OWNER_REQUIRED",
      "Protected input must be owned by the current user."
    );
  }
  if ((mode & 0o777n) !== 0o600n) {
    fail(
      "PRIVATE_INPUT_MODE_REQUIRED",
      "Protected input permissions must be exactly 0600."
    );
  }
  return true;
}

function isInsideRepository(repositoryRoot, candidatePath) {
  const repositoryRelativePath = relative(repositoryRoot, candidatePath);
  return (
    repositoryRelativePath === "" ||
    (repositoryRelativePath !== ".." &&
      !repositoryRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(repositoryRelativePath))
  );
}

export function assertProtectedInputSnapshotUnchanged(before, after, byteLength) {
  const snapshotKeys = ["dev", "ino", "uid", "mode", "size", "mtimeNs", "ctimeNs"];
  if (
    !before ||
    !after ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    snapshotKeys.some(
      (key) => typeof before[key] !== "bigint" || typeof after[key] !== "bigint"
    )
  ) {
    fail("INVALID_INPUT_FILE", "Protected input snapshot metadata is invalid.");
  }
  const unchanged =
    BigInt(byteLength) === before.size &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.uid === before.uid &&
    after.mode === before.mode &&
    after.size === before.size &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs;
  if (!unchanged) {
    fail("INPUT_CHANGED_DURING_READ", "Protected input changed during the dry run.");
  }
  return true;
}

export function readProtectedJsonFile({
  path,
  label,
  maximumBytes,
  repositoryRoot,
}) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 4096 ||
    path.includes("\u0000")
  ) {
    fail("INPUT_REQUIRED", `${label} input is required.`);
  }
  if (
    typeof label !== "string" ||
    label.length === 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 2 ||
    typeof repositoryRoot !== "string" ||
    repositoryRoot.length === 0
  ) {
    fail("INVALID_INPUT_POLICY", "Protected input policy is invalid.");
  }
  let descriptor;
  try {
    const linkMetadata = lstatSync(path);
    if (linkMetadata.isSymbolicLink()) {
      fail("INVALID_INPUT_FILE", `${label} input cannot be a symbolic link.`);
    }
    const canonicalPath = realpathSync(path);
    if (isInsideRepository(repositoryRoot, canonicalPath)) {
      fail(
        "PROTECTED_INPUT_IN_REPOSITORY",
        `${label} identity rows must remain outside the repository.`
      );
    }
    descriptor = openSync(
      canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    const before = fstatSync(descriptor, { bigint: true });
    assertProtectedInputOwnershipAndMode(before);
    if (before.size < 2n || before.size > BigInt(maximumBytes)) {
      fail("INVALID_INPUT_FILE", `${label} input must be a bounded regular file.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    assertProtectedInputOwnershipAndMode(after);
    assertProtectedInputSnapshotUnchanged(before, after, bytes.length);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("INVALID_JSON", `${label} input is not valid JSON.`);
    }
  } catch (error) {
    if (error instanceof MigrationContractError) throw error;
    fail("INPUT_READ_FAILED", `${label} input could not be read safely.`);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // No write path exists. Never expose a platform close error or file path.
      }
    }
  }
}
