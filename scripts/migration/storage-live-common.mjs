import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, parse, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StorageCutoverError } from "./storage-cutover-contract.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = realpathSync(resolve(moduleDirectory, "..", ".."));
export const CONTRACT_PATH = resolve(
  REPOSITORY_ROOT,
  "migration/storage/supabase-storage-cutover.v1.json",
);
export const MAXIMUM_PRIVATE_INPUT_BYTES = 8_388_608;
export const MAXIMUM_APPROVAL_BYTES = 65_536;

export const fail = (code, message) => {
  throw new StorageCutoverError(code, message);
};

export const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const CRC32C_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32C_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
  }
  CRC32C_TABLE[index] = value >>> 0;
}

export const createCrc32c = () => {
  let checksum = 0xffffffff;
  return {
    update(value) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      for (const byte of bytes) {
        checksum = CRC32C_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
      }
      return this;
    },
    digestBase64() {
      const bytes = Buffer.allocUnsafe(4);
      bytes.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, 0);
      return bytes.toString("base64");
    },
  };
};

export const isSha256 = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export const requireSha256 = (value, code, label) => {
  if (!isSha256(value)) fail(code, `${label} must be a lowercase SHA-256 digest.`);
  return value;
};

export const requireExactKeys = (value, keys, code, label) => {
  if (!isPlainObject(value)) fail(code, `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(code, `${label} does not match the exact schema.`);
  }
};

export const requireSafeText = (value, code, label, maximumLength = 256) => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    fail(code, `${label} must be bounded non-empty text.`);
  }
  if (value.trim() !== value || [...value].some((character) => {
    const point = character.codePointAt(0);
    return point <= 31 || point === 127;
  })) {
    fail(code, `${label} contains unsafe text.`);
  }
  return value;
};

export const requireIsoTimestamp = (value, code, label) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(code, `${label} must be an ISO-8601 timestamp.`);
  }
  return value;
};

const failureFor = (code, message) => {
  try {
    fail(code, message);
  } catch (error) {
    return error;
  }
};

export const readStreamWithDeadline = async (reader, deadlineAt, code, message) => {
  const remainingMilliseconds = Math.max(0, deadlineAt - Date.now());
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          void reader.cancel().catch(() => {});
          reject(failureFor(code, message));
        }, remainingMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const lstatPathWithoutSymlinks = (absolutePath, { allowMissingLeaf = false } = {}) => {
  const { root } = parse(absolutePath);
  const components = relative(root, absolutePath).split(sep).filter(Boolean);
  let currentPath = root;
  let status = lstatSync(root);
  for (const [index, component] of components.entries()) {
    currentPath = resolve(currentPath, component);
    try {
      status = lstatSync(currentPath);
    } catch (error) {
      if (allowMissingLeaf && index === components.length - 1 && error?.code === "ENOENT") {
        return null;
      }
      fail("PRIVATE_PATH_NOT_FOUND", "A private artifact path was not found.");
    }
    if (status.isSymbolicLink()) {
      fail("PRIVATE_PATH_SYMLINK_BLOCKED", "Private artifact paths must not contain symbolic links.");
    }
  }
  return status;
};

const assertPrivateLocation = (absolutePath) => {
  let realParent;
  try {
    realParent = realpathSync(dirname(absolutePath));
  } catch {
    fail("PRIVATE_PATH_NOT_FOUND", "A private artifact parent path was not found.");
  }
  const lexicalParent = resolve(dirname(absolutePath));
  if (realParent !== lexicalParent) {
    fail("PRIVATE_PATH_SYMLINK_BLOCKED", "Private artifact parent paths must not use symbolic links.");
  }
  const fromRepository = relative(REPOSITORY_ROOT, absolutePath);
  const insideRepository =
    fromRepository !== ".." && !fromRepository.startsWith(`..${sep}`);
  const insideIgnoredTmp =
    fromRepository === "tmp" || fromRepository.startsWith(`tmp${sep}`);
  if (insideRepository && !insideIgnoredTmp) {
    fail(
      "TRACKED_PRIVATE_ARTIFACT_BLOCKED",
      "Private artifacts must stay outside tracked paths; use the ignored tmp directory or an external path.",
    );
  }
};

export const assertPrivateInputPath = (
  inputPath,
  { maximumBytes = MAXIMUM_PRIVATE_INPUT_BYTES } = {},
) => {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    fail("MISSING_PRIVATE_ARTIFACT", "A private artifact path is required.");
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(inputPath)) {
    fail("REMOTE_PRIVATE_ARTIFACT_BLOCKED", "Private artifacts must be local files.");
  }
  const absolutePath = resolve(inputPath);
  const status = lstatPathWithoutSymlinks(absolutePath);
  if (!status?.isFile()) fail("PRIVATE_ARTIFACT_NOT_REGULAR", "A private artifact is not a regular file.");
  if (status.nlink !== 1) {
    fail(
      "PRIVATE_ARTIFACT_HARDLINK_BLOCKED",
      "Private input artifacts must have exactly one filesystem link.",
    );
  }
  if (status.size > maximumBytes) {
    fail("PRIVATE_ARTIFACT_TOO_LARGE", `A private artifact exceeds ${maximumBytes} bytes.`);
  }
  assertPrivateLocation(absolutePath);
  return absolutePath;
};

export const readPrivateBytes = (
  inputPath,
  { maximumBytes = MAXIMUM_PRIVATE_INPUT_BYTES } = {},
) => {
  const absolutePath = assertPrivateInputPath(inputPath, { maximumBytes });
  let descriptor;
  try {
    const initialStatus = lstatSync(absolutePath);
    descriptor = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const openedStatus = fstatSync(descriptor);
    if (
      !openedStatus.isFile() ||
      initialStatus.nlink !== 1 ||
      openedStatus.nlink !== 1 ||
      openedStatus.dev !== initialStatus.dev ||
      openedStatus.ino !== initialStatus.ino ||
      openedStatus.size !== initialStatus.size ||
      openedStatus.mtimeMs !== initialStatus.mtimeMs ||
      openedStatus.ctimeMs !== initialStatus.ctimeMs ||
      openedStatus.size > maximumBytes
    ) {
      fail("PRIVATE_ARTIFACT_CHANGED", "A private artifact changed while it was opened.");
    }
    const bytes = Buffer.alloc(openedStatus.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const probe = Buffer.alloc(1);
    if (offset !== bytes.length || readSync(descriptor, probe, 0, 1, offset) !== 0) {
      fail("PRIVATE_ARTIFACT_CHANGED", "A private artifact changed while it was read.");
    }
    const finalStatus = fstatSync(descriptor);
    if (
      !finalStatus.isFile() ||
      finalStatus.nlink !== 1 ||
      finalStatus.dev !== openedStatus.dev ||
      finalStatus.ino !== openedStatus.ino ||
      finalStatus.size !== openedStatus.size ||
      finalStatus.mtimeMs !== openedStatus.mtimeMs ||
      finalStatus.ctimeMs !== openedStatus.ctimeMs
    ) {
      fail("PRIVATE_ARTIFACT_CHANGED", "A private artifact changed while its descriptor was read.");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

export const readPrivateJson = (inputPath, options = {}) => {
  try {
    return JSON.parse(readPrivateBytes(inputPath, options).toString("utf8"));
  } catch (error) {
    if (error instanceof StorageCutoverError) throw error;
    fail("INVALID_PRIVATE_JSON", "A private artifact is not valid JSON.");
  }
};

export const readPrivateArtifact = (inputPath, options = {}) => {
  const bytes = readPrivateBytes(inputPath, options);
  return { bytes, fileDigestSha256: sha256(bytes) };
};

export const writePrivateArtifact = (outputPath, bytes) => {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const reservation = reservePrivateArtifact(outputPath);
  try {
    return commitPrivateArtifact(reservation, bytes);
  } catch (error) {
    abandonPrivateArtifact(reservation);
    throw error;
  }
};

export const reservePrivateArtifact = (outputPath) => {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    fail("MISSING_PRIVATE_OUTPUT", "A private output path is required.");
  }
  const absolutePath = resolve(outputPath);
  lstatPathWithoutSymlinks(absolutePath, { allowMissingLeaf: true });
  assertPrivateLocation(absolutePath);
  if (existsSync(absolutePath)) {
    fail("PRIVATE_OUTPUT_EXISTS", "Private artifact outputs are create-only and must not already exist.");
  }
  let descriptor;
  try {
    descriptor = openSync(
      absolutePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o600,
    );
    const status = fstatSync(descriptor);
    return {
      absolutePath,
      descriptor,
      device: status.dev,
      inode: status.ino,
      committed: false,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
};

export const commitPrivateArtifact = (reservation, bytes) => {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (
    !isPlainObject(reservation) ||
    reservation.committed !== false ||
    !Number.isSafeInteger(reservation.descriptor) ||
    reservation.descriptor < 0
  ) {
    fail("PRIVATE_OUTPUT_RESERVATION_INVALID", "A private output reservation is invalid.");
  }
  const openedStatus = fstatSync(reservation.descriptor);
  const pathStatus = lstatPathWithoutSymlinks(reservation.absolutePath);
  if (
    !openedStatus.isFile() ||
    openedStatus.size !== 0 ||
    openedStatus.dev !== reservation.device ||
    openedStatus.ino !== reservation.inode ||
    pathStatus?.dev !== reservation.device ||
    pathStatus?.ino !== reservation.inode
  ) {
    fail("PRIVATE_OUTPUT_RESERVATION_CHANGED", "A private output reservation changed before commit.");
  }
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(
      reservation.descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
  }
  fsyncSync(reservation.descriptor);
  const finalStatus = fstatSync(reservation.descriptor);
  if (finalStatus.size !== bytes.length) {
    fail("PRIVATE_OUTPUT_WRITE_FAILED", "A private output did not reach its exact byte count.");
  }
  closeSync(reservation.descriptor);
  reservation.descriptor = null;
  reservation.committed = true;
  return reservation.absolutePath;
};

export const abandonPrivateArtifact = (reservation) => {
  if (!isPlainObject(reservation) || reservation.committed === true) return;
  if (Number.isSafeInteger(reservation.descriptor) && reservation.descriptor >= 0) {
    try { closeSync(reservation.descriptor); } catch { void 0; }
  }
  reservation.descriptor = null;
  try {
    const status = lstatPathWithoutSymlinks(reservation.absolutePath);
    if (status?.dev === reservation.device && status?.ino === reservation.inode) {
      // This removal only abandons the empty local reservation; provider objects are never deleted.
      unlinkSync(reservation.absolutePath);
    }
  } catch {
    void 0;
  }
};

export const exactFileDigestSha256 = (path, options = {}) =>
  readPrivateArtifact(path, options).fileDigestSha256;

export const contractFileDigestSha256 = () => sha256(readFileSync(CONTRACT_PATH));

export const calculateSelfBoundDigest = (artifact, digestField) => {
  if (!isPlainObject(artifact)) fail("INVALID_ARTIFACT", "Artifact must be an object.");
  const payload = { ...artifact };
  delete payload[digestField];
  return sha256(canonicalJson(payload));
};

export const runCommand = (executable, args, { maximumOutputBytes = 8_388_608 } = {}) => {
  const result = spawnSync(executable, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: maximumOutputBytes,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    fail("LOCAL_COMMAND_FAILED", `${executable} failed without exposing command output.`);
  }
  return result.stdout;
};

export const runCommandJson = (executable, args, options = {}) => {
  try {
    return JSON.parse(runCommand(executable, args, options));
  } catch (error) {
    if (error instanceof StorageCutoverError) throw error;
    fail("LOCAL_COMMAND_INVALID_JSON", `${executable} returned invalid JSON.`);
  }
};

export const currentCleanGitHead = () => {
  const status = runCommand("git", ["status", "--porcelain=v1"]);
  if (status.trim().length > 0) {
    fail("REVIEWED_WORKTREE_DIRTY", "Execution requires a clean reviewed worktree.");
  }
  const head = runCommand("git", ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) fail("INVALID_REVIEWED_COMMIT", "Git HEAD is invalid.");
  return head;
};

export const safeErrorResult = (error, fallbackCode) => ({
  ok: false,
  code: error instanceof StorageCutoverError ? error.code : fallbackCode,
  message: error instanceof StorageCutoverError
    ? error.message
    : "Storage migration command failed without exposing provider or local details.",
});
