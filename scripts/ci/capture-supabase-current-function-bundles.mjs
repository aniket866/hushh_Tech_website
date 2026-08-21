import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_PROJECT_REF = "ibsisfnjxeowvdtvgzff";
export const CAPTURE_TOOL_VERSION = "2.115.0";
export const EXPECTED_ACTIVE_FUNCTIONS = 112;
export const DEFAULT_MANIFEST_PATH = path.join(
  "migration",
  "manifests",
  "supabase-retirement.v1.json"
);

const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 45_000;
const DEFAULT_MINIMUM_START_INTERVAL_MS = 1_100;
const DEFAULT_MAX_DOWNLOAD_ATTEMPTS = 3;
const SAFE_SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const safeWriteCreateOnly = (filePath, contents, mode = 0o600) => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode
  );
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

export const assertExactReadOnlyProjectRef = (projectRef) => {
  assert(
    projectRef === EXPECTED_PROJECT_REF,
    `Current function capture only permits project ${EXPECTED_PROJECT_REF}.`
  );
  return projectRef;
};

export const buildFunctionsListArgs = ({ projectRef = EXPECTED_PROJECT_REF } = {}) => {
  assertExactReadOnlyProjectRef(projectRef);
  return [
    "--yes",
    `supabase@${CAPTURE_TOOL_VERSION}`,
    "functions",
    "list",
    "--project-ref",
    projectRef,
    "--output",
    "json",
  ];
};

export const buildFunctionDownloadArgs = ({ slug, projectRef = EXPECTED_PROJECT_REF }) => {
  assertExactReadOnlyProjectRef(projectRef);
  assert(typeof slug === "string" && SAFE_SLUG.test(slug), "Function slug is invalid.");
  return [
    "--yes",
    `supabase@${CAPTURE_TOOL_VERSION}`,
    "functions",
    "download",
    slug,
    "--project-ref",
    projectRef,
    "--use-api",
    "--output-format",
    "json",
  ];
};

export const assertReadOnlySupabaseCliArgs = (args) => {
  assert(Array.isArray(args), "Supabase CLI arguments must be an array.");
  const isList =
    args.length === 8 &&
    args[0] === "--yes" &&
    args[1] === `supabase@${CAPTURE_TOOL_VERSION}` &&
    args[2] === "functions" &&
    args[3] === "list" &&
    args[4] === "--project-ref" &&
    args[5] === EXPECTED_PROJECT_REF &&
    args[6] === "--output" &&
    args[7] === "json";
  const isDownload =
    args.length === 10 &&
    args[0] === "--yes" &&
    args[1] === `supabase@${CAPTURE_TOOL_VERSION}` &&
    args[2] === "functions" &&
    args[3] === "download" &&
    typeof args[4] === "string" &&
    SAFE_SLUG.test(args[4]) &&
    args[5] === "--project-ref" &&
    args[6] === EXPECTED_PROJECT_REF &&
    args[7] === "--use-api" &&
    args[8] === "--output-format" &&
    args[9] === "json";
  assert(isList || isDownload, "Only exact functions list and functions download commands are permitted.");
  return args;
};

export const normalizeLiveFunctionMetadata = ({ manifest, liveMetadata }) => {
  assert(Array.isArray(manifest?.functions), "Retirement manifest must contain functions.");
  assert(Array.isArray(liveMetadata), "Live function metadata must be an array.");
  assert(
    manifest.source_system?.project_ref === EXPECTED_PROJECT_REF,
    "Retirement manifest targets an unexpected project."
  );
  assert(
    manifest.functions.length === EXPECTED_ACTIVE_FUNCTIONS,
    `Retirement manifest must contain ${EXPECTED_ACTIVE_FUNCTIONS} functions.`
  );
  assert(
    liveMetadata.length === EXPECTED_ACTIVE_FUNCTIONS,
    `Live metadata must contain exactly ${EXPECTED_ACTIVE_FUNCTIONS} functions.`
  );

  const manifestBySlug = new Map();
  for (const entry of manifest.functions) {
    const source = entry?.source;
    assert(source && SAFE_SLUG.test(source.slug), "Manifest contains an invalid function slug.");
    assert(!manifestBySlug.has(source.slug), `Manifest has duplicate function ${source.slug}.`);
    manifestBySlug.set(source.slug, source);
  }

  const observedSlugs = new Set();
  const normalized = liveMetadata.map((entry) => {
    assert(entry && typeof entry === "object" && !Array.isArray(entry), "Invalid live function entry.");
    const slug = entry.slug;
    assert(typeof slug === "string" && SAFE_SLUG.test(slug), "Live function slug is invalid.");
    assert(!observedSlugs.has(slug), `Live metadata has duplicate function ${slug}.`);
    observedSlugs.add(slug);
    const frozen = manifestBySlug.get(slug);
    assert(frozen, `Live metadata contains unknown function ${slug}.`);
    assert(entry.status === "ACTIVE", `Live function ${slug} is not ACTIVE.`);
    assert(entry.id === frozen.function_id, `Live function ${slug} changed function ID.`);
    assert(
      entry.verify_jwt === frozen.verify_jwt,
      `Live function ${slug} changed verify_jwt.`
    );
    assert(Number.isSafeInteger(entry.version), `Live function ${slug} has an invalid version.`);
    assert(
      entry.version >= frozen.version,
      `Live function ${slug} version moved backwards from the frozen manifest.`
    );
    const providerDigest = entry.ezbr_sha256 ?? null;
    assert(
      providerDigest === null || /^[a-f0-9]{64}$/.test(providerDigest),
      `Live function ${slug} has an invalid provider bundle digest.`
    );
    return {
      slug,
      function_id: entry.id,
      status: entry.status,
      current_version: entry.version,
      manifest_version: frozen.version,
      version_delta: entry.version - frozen.version,
      verify_jwt: entry.verify_jwt,
      provider_bundle_digest: providerDigest,
    };
  });

  for (const slug of manifestBySlug.keys()) {
    assert(observedSlugs.has(slug), `Live metadata is missing manifest function ${slug}.`);
  }
  return normalized.sort((left, right) => compareUtf8(left.slug, right.slug));
};

export const assertMetadataStableAcrossCapture = ({ startMetadata, endMetadata }) => {
  assert(
    JSON.stringify(startMetadata) === JSON.stringify(endMetadata),
    "Live function metadata changed during bundle capture; freeze deployments and start a new capture."
  );
  return true;
};

export const classifyDownloadResponse = ({ exitCode, stdout, stderr }) => {
  assert(Buffer.byteLength(stdout, "utf8") <= MAX_COMMAND_OUTPUT_BYTES, "CLI stdout is too large.");
  assert(Buffer.byteLength(stderr, "utf8") <= MAX_COMMAND_OUTPUT_BYTES, "CLI stderr is too large.");
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: "CAPTURE_FAILED", retryable: true, failure_class: "INVALID_CLI_JSON" };
  }

  if (
    exitCode === 0 &&
    parsed?.message === "Downloaded Edge Function source." &&
    parsed?.project_ref === EXPECTED_PROJECT_REF &&
    Array.isArray(parsed?.function_slugs) &&
    parsed.function_slugs.length === 1
  ) {
    return {
      status: "EXTRACTED",
      retryable: false,
      project_ref: parsed.project_ref,
      slug: parsed.function_slugs[0],
    };
  }

  const code = parsed?.error?.code;
  const message = parsed?.error?.message;
  if (
    exitCode !== 0 &&
    code === "UnknownError" &&
    message === 'Error status 404: {"message":"Function store not found"}'
  ) {
    return {
      status: "STORE_NOT_FOUND",
      retryable: false,
      http_status: 404,
      provider_error_code: "UnknownError",
      failure_class: "FUNCTION_STORE_NOT_FOUND",
    };
  }
  if (
    exitCode !== 0 &&
    code === "FunctionsApiStatusError" &&
    message === 'Error status 500: {"message":"Failed to retrieve function bundle"}'
  ) {
    return {
      status: "BUNDLE_RETRIEVAL_FAILED",
      retryable: true,
      http_status: 500,
      provider_error_code: "FunctionsApiStatusError",
      failure_class: "FAILED_TO_RETRIEVE_FUNCTION_BUNDLE",
    };
  }
  return {
    status: "CAPTURE_FAILED",
    retryable: true,
    failure_class: "UNEXPECTED_CLI_FAILURE",
  };
};

export const createPrivateRecoveryRoot = ({ temporaryDirectory = os.tmpdir() } = {}) => {
  const realTemporaryDirectory = fs.realpathSync(temporaryDirectory);
  const root = fs.mkdtempSync(
    path.join(realTemporaryDirectory, "hushh-supabase-current-function-bundles.")
  );
  fs.chmodSync(root, 0o700);
  const stat = fs.lstatSync(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Recovery root must be a real directory.");
  return root;
};

const runCommand = ({ command, args, cwd, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }) =>
  new Promise((resolve, reject) => {
    assertReadOnlySupabaseCliArgs(args);
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        NO_UPDATE_NOTIFIER: "1",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
        exceeded = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (exceeded) {
        reject(new Error("Supabase CLI output exceeded the bounded capture limit."));
        return;
      }
      resolve({ exitCode: exitCode ?? -1, signal, stdout, stderr });
    });
  });

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const makeGlobalStartLimiter = ({
  minimumStartIntervalMs = DEFAULT_MINIMUM_START_INTERVAL_MS,
  now = () => Date.now(),
  sleep = wait,
} = {}) => {
  let lastStartedAt = null;
  return async () => {
    if (lastStartedAt !== null) {
      const remaining = minimumStartIntervalMs - (now() - lastStartedAt);
      if (remaining > 0) await sleep(remaining);
    }
    lastStartedAt = now();
  };
};

export const captureCurrentFunctionBundles = async ({
  manifest,
  projectRef = EXPECTED_PROJECT_REF,
  recoveryRoot = createPrivateRecoveryRoot(),
  commandRunner = runCommand,
  beforeEveryAttempt = makeGlobalStartLimiter(),
  maxDownloadAttempts = DEFAULT_MAX_DOWNLOAD_ATTEMPTS,
  onProgress = () => {},
}) => {
  assertExactReadOnlyProjectRef(projectRef);
  assert(Number.isInteger(maxDownloadAttempts) && maxDownloadAttempts >= 1 && maxDownloadAttempts <= 3,
    "Download attempts must stay between one and three.");
  const rootStat = fs.lstatSync(recoveryRoot);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Recovery root is unsafe.");
  assert(fs.readdirSync(recoveryRoot).length === 0, "Recovery root must start empty.");
  const captureStartedAtUtc = new Date().toISOString();

  await beforeEveryAttempt();
  const listResult = await commandRunner({
    command: "npx",
    args: buildFunctionsListArgs({ projectRef }),
    cwd: recoveryRoot,
  });
  assert(listResult.exitCode === 0, "Read-only function metadata capture failed.");
  let liveMetadata;
  try {
    liveMetadata = JSON.parse(listResult.stdout);
  } catch {
    throw new Error("Read-only function metadata capture returned invalid JSON.");
  }
  const normalized = normalizeLiveFunctionMetadata({ manifest, liveMetadata });
  safeWriteCreateOnly(
    path.join(recoveryRoot, "functions-list.json"),
    JSON.stringify(liveMetadata, null, 2) + "\n"
  );

  const outcomes = [];
  for (const [index, metadata] of normalized.entries()) {
    const slugRoot = path.join(recoveryRoot, metadata.slug);
    fs.mkdirSync(slugRoot, { mode: 0o700 });
    let finalClassification;
    for (let attempt = 1; attempt <= maxDownloadAttempts; attempt += 1) {
      await beforeEveryAttempt();
      const result = await commandRunner({
        command: "npx",
        args: buildFunctionDownloadArgs({ slug: metadata.slug, projectRef }),
        cwd: slugRoot,
      });
      const classification = classifyDownloadResponse(result);
      safeWriteCreateOnly(
        path.join(recoveryRoot, `${metadata.slug}.attempt-${attempt}.stdout`),
        result.stdout
      );
      safeWriteCreateOnly(
        path.join(recoveryRoot, `${metadata.slug}.attempt-${attempt}.stderr`),
        result.stderr
      );
      finalClassification = { ...classification, attempts: attempt };
      if (classification.status === "EXTRACTED") {
        assert(
          classification.slug === metadata.slug,
          `Downloaded bundle response did not bind to ${metadata.slug}.`
        );
        break;
      }
      if (!classification.retryable) break;
    }
    outcomes.push({ slug: metadata.slug, ...finalClassification });
    onProgress({ completed: index + 1, total: normalized.length, slug: metadata.slug, status: finalClassification.status });
  }

  await beforeEveryAttempt();
  const endListResult = await commandRunner({
    command: "npx",
    args: buildFunctionsListArgs({ projectRef }),
    cwd: recoveryRoot,
  });
  assert(endListResult.exitCode === 0, "Read-only end-of-capture metadata check failed.");
  let endLiveMetadata;
  try {
    endLiveMetadata = JSON.parse(endListResult.stdout);
  } catch {
    throw new Error("End-of-capture function metadata returned invalid JSON.");
  }
  const normalizedEndMetadata = normalizeLiveFunctionMetadata({
    manifest,
    liveMetadata: endLiveMetadata,
  });
  safeWriteCreateOnly(
    path.join(recoveryRoot, "functions-list-end.json"),
    JSON.stringify(endLiveMetadata, null, 2) + "\n"
  );
  assertMetadataStableAcrossCapture({
    startMetadata: normalized,
    endMetadata: normalizedEndMetadata,
  });

  const receipt = {
    schema_version: 1,
    project_ref: projectRef,
    tool: "supabase_cli",
    tool_version: CAPTURE_TOOL_VERSION,
    source_write_mode: "READ_ONLY_NO_DEPLOYMENT",
    metadata_end_check: "MATCHED_EXACTLY",
    capture_started_at_utc: captureStartedAtUtc,
    capture_completed_at_utc: new Date().toISOString(),
    active_functions: normalized.length,
    outcomes,
  };
  safeWriteCreateOnly(
    path.join(recoveryRoot, "capture-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n"
  );
  return { recoveryRoot, liveMetadata: normalized, outcomes };
};

const parseArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const projectRef = parseArg("--project-ref") || EXPECTED_PROJECT_REF;
  const manifestPath = parseArg("--manifest") || DEFAULT_MANIFEST_PATH;
  const manifest = readJson(path.resolve(manifestPath));
  const result = await captureCurrentFunctionBundles({
    manifest,
    projectRef,
    onProgress: ({ completed, total, status }) => {
      console.log(`Captured function bundle ${completed}/${total}: ${status}.`);
    },
  });
  const counts = Object.fromEntries(
    [...new Set(result.outcomes.map((entry) => entry.status))]
      .sort(compareUtf8)
      .map((status) => [status, result.outcomes.filter((entry) => entry.status === status).length])
  );
  console.log(
    JSON.stringify(
      {
        recovery_root: result.recoveryRoot,
        active_functions: result.liveMetadata.length,
        capture_status_counts: counts,
      },
      null,
      2
    )
  );
}
