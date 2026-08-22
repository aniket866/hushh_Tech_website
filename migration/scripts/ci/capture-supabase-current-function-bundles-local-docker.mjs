import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CAPTURE_TOOL_VERSION,
  DEFAULT_MANIFEST_PATH,
  EXPECTED_PROJECT_REF,
  assertExactReadOnlyProjectRef,
  assertReadOnlySupabaseCliArgs,
  buildFunctionsListArgs,
  captureCurrentFunctionBundles,
  createPrivateRecoveryRoot,
} from "../../../scripts/ci/capture-supabase-current-function-bundles.mjs";

export const BUNDLE_TRANSPORT =
  "DIRECT_MANAGEMENT_API_RAW_ESZIP_GET_LOCAL_DOCKER_UNBUNDLE_NO_CLI_FALLBACK";
export const TRANSPORT_RECEIPT_FILE = "local-docker-transport-receipt.json";
export const EDGE_RUNTIME_IMAGE = "UNPROVISIONED";
export const RAW_BODY_SURFACE =
  "GET /v1/projects/{ref}/functions/{slug}/body ACCEPT_APPLICATION_OCTET_STREAM";

const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const MAX_RAW_BODY_BYTES = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 45_000;
const DOCKER_TIMEOUT_MS = 10_000;
const SAFE_SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const isAbsoluteLocalDockerSocket = (value) =>
  typeof value === "string" &&
  /^unix:\/\/[A-Za-z0-9._/-]+$/.test(value) &&
  value.startsWith("unix:///") &&
  !value.split("/").includes("..");

export const buildDockerInfoArgs = () => ["info", "--format", "{{json .ServerVersion}}"];
export const buildDockerContextInspectArgs = () => [
  "context",
  "inspect",
  "default",
  "--format",
  "{{json .Endpoints.docker.Host}}",
];

const assertPinnedEdgeRuntimeImage = (value) => {
  assert(
    typeof value === "string" &&
      /^public\.ecr\.aws\/supabase\/edge-runtime@sha256:[a-f0-9]{64}$/.test(value),
    "Pinned edge-runtime image is unprovisioned."
  );
  return value;
};

export const buildDockerImageInspectArgs = (edgeRuntimeImage) => {
  assertPinnedEdgeRuntimeImage(edgeRuntimeImage);
  return ["image", "inspect", "--format", "{{json .}}", edgeRuntimeImage];
};

export const assertExactDockerInfoArgs = (args) => {
  assert(
    Array.isArray(args) &&
      args.length === 3 &&
      args[0] === "info" &&
      args[1] === "--format" &&
      args[2] === "{{json .ServerVersion}}",
    "Only the exact local Docker availability command is permitted."
  );
  return args;
};

export const assertExactDockerContextInspectArgs = (args) => {
  assert(
    Array.isArray(args) &&
      args.length === 5 &&
      args[0] === "context" &&
      args[1] === "inspect" &&
      args[2] === "default" &&
      args[3] === "--format" &&
      args[4] === "{{json .Endpoints.docker.Host}}",
    "Only the exact default Docker context inspection is permitted."
  );
  return args;
};

export const assertExactDockerImageInspectArgs = (args, edgeRuntimeImage) => {
  assertPinnedEdgeRuntimeImage(edgeRuntimeImage);
  assert(
    Array.isArray(args) &&
      args.length === 5 &&
      args[0] === "image" &&
      args[1] === "inspect" &&
      args[2] === "--format" &&
      args[3] === "{{json .}}" &&
      args[4] === edgeRuntimeImage,
    "Only the exact pinned edge-runtime image inspection is permitted."
  );
  return args;
};

const assertBoundedCommandResponse = ({ stdout, stderr }) => {
  assert(Buffer.byteLength(stdout, "utf8") <= MAX_COMMAND_OUTPUT_BYTES, "Command stdout is too large.");
  assert(Buffer.byteLength(stderr, "utf8") <= MAX_COMMAND_OUTPUT_BYTES, "Command stderr is too large.");
};

const buildMinimalChildEnvironment = () => {
  const env = { NO_UPDATE_NOTIFIER: "1" };
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ]) {
    if (typeof process.env[name] === "string" && process.env[name] !== "") {
      env[name] = process.env[name];
    }
  }
  assert(typeof env.PATH === "string" && env.PATH !== "", "Child process PATH is unavailable.");
  return env;
};

export const assertDockerInfoResponse = ({ exitCode, stdout, stderr }) => {
  assertBoundedCommandResponse({ stdout, stderr });
  assert(exitCode === 0, "Local Docker is required before any remote function body request.");
  assert(stderr.trim() === "", "Local Docker availability returned an unexpected warning.");
  let version;
  try {
    version = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Local Docker availability returned invalid JSON.");
  }
  assert(
    typeof version === "string" && /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(version),
    "Local Docker returned an invalid server version."
  );
  return version;
};

export const assertLocalDockerContextResponse = ({ exitCode, stdout, stderr }) => {
  assertBoundedCommandResponse({ stdout, stderr });
  assert(exitCode === 0, "The exact default Docker context is required.");
  assert(stderr.trim() === "", "Docker context inspection returned an unexpected warning.");
  let endpoint;
  try {
    endpoint = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Docker context inspection returned invalid JSON.");
  }
  assert(isAbsoluteLocalDockerSocket(endpoint), "Docker context must use an absolute local Unix socket.");
  return endpoint;
};

export const assertDockerImageInspectResponse = ({ exitCode, stdout, stderr }, edgeRuntimeImage) => {
  assertPinnedEdgeRuntimeImage(edgeRuntimeImage);
  assertBoundedCommandResponse({ stdout, stderr });
  assert(exitCode === 0, "The pinned edge-runtime image must exist locally before provider access.");
  assert(stderr.trim() === "", "Pinned image inspection returned an unexpected warning.");
  let image;
  try {
    image = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Pinned image inspection returned invalid JSON.");
  }
  assert(
    image && typeof image === "object" && !Array.isArray(image),
    "Pinned image inspection returned an invalid object."
  );
  assert(
    Array.isArray(image.RepoDigests) &&
      image.RepoDigests.length >= 1 &&
      image.RepoDigests.length <= 32 &&
      image.RepoDigests.every(
        (digest) =>
          typeof digest === "string" &&
          /^public\.ecr\.aws\/supabase\/edge-runtime@sha256:[a-f0-9]{64}$/.test(digest)
      ) &&
      new Set(image.RepoDigests).size === image.RepoDigests.length &&
      image.RepoDigests.includes(edgeRuntimeImage),
    "Local edge-runtime image digest does not match the frozen image."
  );
  assert(/^sha256:[a-f0-9]{64}$/.test(image.Id), "Local edge-runtime image ID is invalid.");
  assert(image.Os === "linux", "Local edge-runtime image operating system is invalid.");
  assert(
    image.Architecture === "amd64" || image.Architecture === "arm64",
    "Local edge-runtime image architecture is invalid."
  );
  return Object.freeze({
    imageId: image.Id,
    imageOs: image.Os,
    imageArchitecture: image.Architecture,
  });
};

const spawnBounded = ({ command, args, cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
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
        reject(new Error("Command output exceeded the bounded limit."));
        return;
      }
      resolve({ exitCode: exitCode ?? -1, signal, stdout, stderr });
    });
  });

const runDockerCommand = ({ args, cwd, edgeRuntimeImage }) => {
  if (args[0] === "info") assertExactDockerInfoArgs(args);
  else if (args[0] === "context") assertExactDockerContextInspectArgs(args);
  else assertExactDockerImageInspectArgs(args, edgeRuntimeImage);
  const env = { ...buildMinimalChildEnvironment(), DOCKER_CONTEXT: "default" };
  return spawnBounded({ command: "docker", args, cwd, env, timeoutMs: DOCKER_TIMEOUT_MS });
};

const runSupabaseCommand = ({ args, cwd, dockerHost, accessToken }) => {
  assert(dockerHost === undefined, "Function metadata list must not receive Docker authority.");
  assert(JSON.stringify(args) === JSON.stringify(buildFunctionsListArgs()), "Function list command drifted.");
  assert(/^sbp_[A-Za-z0-9_-]{20,}$/.test(accessToken), "Supabase access token is malformed.");
  const env = { ...buildMinimalChildEnvironment(), SUPABASE_ACCESS_TOKEN: accessToken };
  return spawnBounded({ command: "npx", args, cwd, env, timeoutMs: COMMAND_TIMEOUT_MS });
};

const readSupabaseAccessToken = () => {
  let token = process.env.SUPABASE_ACCESS_TOKEN || "";
  if (!token && process.platform === "darwin") {
    try {
      token = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-a", "access-token", "-s", "Supabase CLI", "-w"],
        {
          encoding: "utf8",
          maxBuffer: 16 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
          env: buildMinimalChildEnvironment(),
        }
      ).trim();
    } catch {
      token = "";
    }
  }
  if (token.startsWith("go-keyring:")) {
    token = Buffer.from(token.slice("go-keyring:".length), "base64").toString("utf8");
  }
  assert(/^sbp_[A-Za-z0-9_-]{20,}$/.test(token), "Supabase access token is unavailable or malformed.");
  return token;
};

const cancelResponseBody = async (response) => {
  if (response?.body && typeof response.body.cancel === "function") {
    try {
      await response.body.cancel();
    } catch {
      // The body is already unusable; cancellation is cleanup only.
    }
  }
};

const streamRawBodyCreateOnly = async ({ response, filePath, declaredBytes }) => {
  assert(
    response.body && typeof response.body.getReader === "function",
    "Raw function body stream is missing."
  );
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  );
  const hash = crypto.createHash("sha256");
  const reader = response.body.getReader();
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > MAX_RAW_BODY_BYTES || (declaredBytes !== null && totalBytes > declaredBytes)) {
        await reader.cancel();
        throw new Error("Raw function body exceeded its exact byte bound.");
      }
      fs.writeSync(descriptor, chunk);
      hash.update(chunk);
    }
    assert(totalBytes > 0, "Raw function body is empty.");
    assert(
      declaredBytes === null || totalBytes === declaredBytes,
      "Raw function body length does not match Content-Length."
    );
    fs.fsyncSync(descriptor);
    completed = true;
    return { bytes: totalBytes, sha256: hash.digest("hex") };
  } finally {
    fs.closeSync(descriptor);
    if (!completed && fs.existsSync(filePath)) {
      const stat = fs.lstatSync(filePath);
      assert(
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
        "Partial ESZIP is unsafe."
      );
      fs.unlinkSync(filePath);
    }
  }
};

const runRawBodyFetch = async ({ slug, projectRef, cwd, accessToken }) => {
  assertExactReadOnlyProjectRef(projectRef);
  assert(SAFE_SLUG.test(slug), "Function slug is invalid.");
  assert(/^sbp_[A-Za-z0-9_-]{20,}$/.test(accessToken), "Supabase access token is malformed.");
  const url = `https://api.supabase.com/v1/projects/${projectRef}/functions/${slug}/body`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/octet-stream",
        "Accept-Encoding": "identity",
        Authorization: `Bearer ${accessToken}`,
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.url !== url || response.redirected) {
      await cancelResponseBody(response);
      throw new Error("Raw function body response URL drifted.");
    }
    if (![200, 404, 500].includes(response.status)) {
      await cancelResponseBody(response);
      throw new Error("Raw function body returned an unsupported status.");
    }
    if (response.status !== 200) {
      await cancelResponseBody(response);
      return { status: response.status, eszipPath: null, bytes: 0, sha256: null };
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/octet-stream") {
      await cancelResponseBody(response);
      throw new Error("Raw function body Content-Type is invalid.");
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") {
      await cancelResponseBody(response);
      throw new Error("Raw function body response was content-encoded.");
    }
    const contentLength = response.headers.get("content-length");
    const declaredBytes = contentLength === null ? null : Number(contentLength);
    if (
      declaredBytes !== null &&
      (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > MAX_RAW_BODY_BYTES)
    ) {
      await cancelResponseBody(response);
      throw new Error("Raw function body Content-Length is invalid.");
    }
    const tempDirectory = path.join(cwd, "supabase", ".temp");
    const eszipPath = path.join(tempDirectory, `output_${slug}.eszip`);
    const bodyReceipt = await streamRawBodyCreateOnly({
      response,
      filePath: eszipPath,
      declaredBytes,
    });
    return { status: 200, eszipPath, ...bodyReceipt };
  } finally {
    clearTimeout(timeout);
  }
};

const runDockerExtractor = async ({ slug, cwd, dockerHost, eszipPath, edgeRuntimeImage }) => {
  assertPinnedEdgeRuntimeImage(edgeRuntimeImage);
  assert(isAbsoluteLocalDockerSocket(dockerHost), "A validated local Docker socket is required.");
  assert(SAFE_SLUG.test(slug), "Function slug is invalid.");
  const functionsRoot = path.join(cwd, "supabase", "functions");
  fs.mkdirSync(functionsRoot, { recursive: true, mode: 0o700 });
  const args = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=bind,src=${eszipPath},dst=/root/eszips/bundle.eszip,readonly`,
    "--mount",
    `type=bind,src=${functionsRoot},dst=/home/deno`,
    edgeRuntimeImage,
    "unbundle",
    "--eszip",
    "/root/eszips/bundle.eszip",
    "--output",
    `/home/deno/${slug}`,
  ];
  const env = { ...buildMinimalChildEnvironment(), DOCKER_HOST: dockerHost };
  const result = await spawnBounded({
    command: "docker",
    args,
    cwd,
    env,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  assert(result.exitCode === 0, "Local edge-runtime unbundle failed.");
  const sourceRoot = path.join(functionsRoot, slug);
  const stat = fs.lstatSync(sourceRoot);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Local unbundle output is invalid.");
  return result;
};

const prepareCliBookkeeping = ({ recoveryRoot, slugRoot }) => {
  const target = path.join(slugRoot, "supabase", ".temp");
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ["linked-project.json", "cli-latest"]) {
    const sourcePath = path.join(recoveryRoot, "supabase", ".temp", name);
    const sourceStat = fs.lstatSync(sourcePath);
    assert(sourceStat.isFile() && !sourceStat.isSymbolicLink(), "Root CLI bookkeeping is invalid.");
    const destinationPath = path.join(target, name);
    safeWriteCreateOnly(destinationPath, fs.readFileSync(sourcePath));
  }
};

const removeExactEszip = (eszipPath) => {
  if (!eszipPath || !fs.existsSync(eszipPath)) return;
  const stat = fs.lstatSync(eszipPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Temporary ESZIP is unsafe.");
  fs.unlinkSync(eszipPath);
};

const responseForRawBodyStatus = ({ slug, status }) => {
  if (status === 200) {
    return {
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        message: "Downloaded Edge Function source.",
        project_ref: EXPECTED_PROJECT_REF,
        function_slugs: [slug],
      }),
      stderr: `Downloading function: ${slug}\n`,
    };
  }
  if (status === 404) {
    return {
      exitCode: 1,
      signal: null,
      stdout: JSON.stringify({
        _tag: "Error",
        error: {
          code: "UnknownError",
          message: 'Error status 404: {"message":"Function store not found"}',
        },
      }),
      stderr: "",
    };
  }
  if (status === 500) {
    return {
      exitCode: 1,
      signal: null,
      stdout: JSON.stringify({
        _tag: "Error",
        error: {
          code: "FunctionsApiStatusError",
          message: 'Error status 500: {"message":"Failed to retrieve function bundle"}',
        },
      }),
      stderr: "",
    };
  }
  return {
    exitCode: 1,
    signal: null,
    stdout: JSON.stringify({ _tag: "Error", error: { code: "UnexpectedReadStatus" } }),
    stderr: "",
  };
};

const safeWriteCreateOnly = (filePath, contents) => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const captureLocalDockerCore = async ({
  manifest,
  projectRef = EXPECTED_PROJECT_REF,
  recoveryRoot,
  metadataCommandRunner,
  dockerCommandRunner,
  rawBodyRunner,
  dockerExtractor,
  accessToken,
  accessTokenProvider,
  edgeRuntimeImage,
  beforeEveryAttempt,
  maxDownloadAttempts,
  onProgress,
}) => {
  assertPinnedEdgeRuntimeImage(edgeRuntimeImage);
  const captureRoot = recoveryRoot ?? createPrivateRecoveryRoot();
  const rootStat = fs.lstatSync(captureRoot);
  assert(
    rootStat.isDirectory() && !rootStat.isSymbolicLink() && fs.readdirSync(captureRoot).length === 0,
    "Recovery root must be an empty real directory before local preflight."
  );
  const dockerObservations = [];
  const rawBodyAttempts = [];
  let frozenDockerObservation = null;
  const inspectDocker = async (cwd) => {
    const contextResponse = await dockerCommandRunner({
      args: buildDockerContextInspectArgs(),
      cwd,
      edgeRuntimeImage,
    });
    const dockerHost = assertLocalDockerContextResponse(contextResponse);
    const infoResponse = await dockerCommandRunner({
      args: buildDockerInfoArgs(),
      cwd,
      edgeRuntimeImage,
    });
    const dockerServerVersion = assertDockerInfoResponse(infoResponse);
    const imageResponse = await dockerCommandRunner({
      args: buildDockerImageInspectArgs(edgeRuntimeImage),
      cwd,
      edgeRuntimeImage,
    });
    const imageObservation = assertDockerImageInspectResponse(imageResponse, edgeRuntimeImage);
    const observation = { dockerHost, dockerServerVersion, ...imageObservation };
    if (frozenDockerObservation !== null) {
      assert(
        JSON.stringify(observation) === JSON.stringify(frozenDockerObservation),
        "Docker transport changed before a raw provider read."
      );
    } else {
      frozenDockerObservation = observation;
    }
    dockerObservations.push(observation);
    return { dockerHost, dockerServerVersion };
  };
  await inspectDocker(captureRoot);
  const resolvedAccessToken = accessToken ?? accessTokenProvider?.();
  assert(
    /^sbp_[A-Za-z0-9_-]{20,}$/.test(resolvedAccessToken),
    "Supabase access token is malformed."
  );
  const commandRunner = async ({ args, cwd }) => {
    const isList = args[2] === "functions" && args[3] === "list";
    if (isList) return metadataCommandRunner({ args, cwd, accessToken: resolvedAccessToken });
    assertReadOnlySupabaseCliArgs(args);
    const slug = args[4];
    const { dockerHost } = await inspectDocker(cwd);
    prepareCliBookkeeping({ recoveryRoot: captureRoot, slugRoot: cwd });
    const rawBody = await rawBodyRunner({
      slug,
      projectRef,
      cwd,
      accessToken: resolvedAccessToken,
    });
    assert(
      rawBody && Number.isInteger(rawBody.status) && rawBody.status >= 100 && rawBody.status <= 599,
      "Raw function body result is invalid."
    );
    if (rawBody.status === 200) {
      assert(
        typeof rawBody.eszipPath === "string" &&
          Number.isSafeInteger(rawBody.bytes) &&
          rawBody.bytes > 0 &&
          rawBody.bytes <= MAX_RAW_BODY_BYTES &&
          /^[a-f0-9]{64}$/.test(rawBody.sha256),
        "Raw function body receipt is invalid."
      );
      try {
        await dockerExtractor({
          slug,
          cwd,
          dockerHost,
          eszipPath: rawBody.eszipPath,
          edgeRuntimeImage,
        });
      } finally {
        removeExactEszip(rawBody.eszipPath);
      }
    } else {
      assert(
        rawBody.eszipPath === null && rawBody.bytes === 0 && rawBody.sha256 === null,
        "Failed raw body request must not retain an ESZIP receipt."
      );
    }
    rawBodyAttempts.push({
      slug,
      status: rawBody.status,
      bytes: rawBody.bytes,
      sha256: rawBody.sha256,
    });
    return responseForRawBodyStatus({ slug, status: rawBody.status });
  };
  const result = await captureCurrentFunctionBundles({
    manifest,
    projectRef,
    recoveryRoot: captureRoot,
    commandRunner,
    ...(beforeEveryAttempt ? { beforeEveryAttempt } : {}),
    ...(maxDownloadAttempts ? { maxDownloadAttempts } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
  const expectedAttempts = result.outcomes.reduce((sum, outcome) => sum + outcome.attempts, 0);
  assert(
    dockerObservations.length === expectedAttempts + 1,
    "Docker proof is incomplete for preflight and capture attempts."
  );
  assert(rawBodyAttempts.length === expectedAttempts, "Raw body receipt is incomplete.");
  const endpointDigests = [...new Set(dockerObservations.map(({ dockerHost }) => sha256(dockerHost)))];
  const versions = [...new Set(dockerObservations.map(({ dockerServerVersion }) => dockerServerVersion))];
  const imageIds = [...new Set(dockerObservations.map(({ imageId }) => imageId))];
  const imageOperatingSystems = [...new Set(dockerObservations.map(({ imageOs }) => imageOs))];
  const imageArchitectures = [
    ...new Set(dockerObservations.map(({ imageArchitecture }) => imageArchitecture)),
  ];
  assert(
    endpointDigests.length === 1 &&
      versions.length === 1 &&
      imageIds.length === 1 &&
      imageOperatingSystems.length === 1 &&
      imageArchitectures.length === 1,
    "Docker transport changed during capture."
  );
  const captureReceiptBytes = fs.readFileSync(path.join(result.recoveryRoot, "capture-receipt.json"));
  const startMetadataBytes = fs.readFileSync(path.join(result.recoveryRoot, "functions-list.json"));
  const endMetadataBytes = fs.readFileSync(path.join(result.recoveryRoot, "functions-list-end.json"));
  const transportReceipt = {
    schema_version: 1,
    project_ref: projectRef,
    tool: "supabase_cli_metadata_plus_direct_management_api_body",
    tool_version: CAPTURE_TOOL_VERSION,
    bundle_transport: BUNDLE_TRANSPORT,
    raw_body_surface: RAW_BODY_SURFACE,
    docker_image: edgeRuntimeImage,
    docker_image_id: imageIds[0],
    docker_image_os: imageOperatingSystems[0],
    docker_image_architecture: imageArchitectures[0],
    docker_context_class: "ABSOLUTE_LOCAL_UNIX_SOCKET",
    docker_context_endpoint_sha256: endpointDigests[0],
    docker_server_version: versions[0],
    download_attempts: expectedAttempts,
    raw_body_attempts: rawBodyAttempts,
    capture_receipt_sha256: sha256(captureReceiptBytes),
    start_metadata_sha256: sha256(startMetadataBytes),
    end_metadata_sha256: sha256(endMetadataBytes),
  };
  safeWriteCreateOnly(
    path.join(result.recoveryRoot, TRANSPORT_RECEIPT_FILE),
    JSON.stringify(transportReceipt, null, 2) + "\n"
  );
  return { ...result, transportReceipt };
};

export const captureLocalDockerCurrentFunctionBundles = ({
  manifest,
  projectRef = EXPECTED_PROJECT_REF,
  recoveryRoot,
  onProgress,
} = {}) =>
  (() => {
    assertPinnedEdgeRuntimeImage(EDGE_RUNTIME_IMAGE);
    return captureLocalDockerCore({
      manifest,
      projectRef,
      recoveryRoot,
      metadataCommandRunner: runSupabaseCommand,
      dockerCommandRunner: runDockerCommand,
      rawBodyRunner: runRawBodyFetch,
      dockerExtractor: runDockerExtractor,
      accessTokenProvider: readSupabaseAccessToken,
      edgeRuntimeImage: EDGE_RUNTIME_IMAGE,
      onProgress,
    });
  })();

export const __testing = Object.freeze({
  buildMinimalChildEnvironment,
  captureLocalDockerCore,
  runRawBodyFetch,
  streamRawBodyCreateOnly,
});

const parseArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const projectRef = parseArg("--project-ref") || EXPECTED_PROJECT_REF;
  const manifestPath = parseArg("--manifest") || DEFAULT_MANIFEST_PATH;
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  const result = await captureLocalDockerCurrentFunctionBundles({
    manifest,
    projectRef,
    onProgress: ({ completed, total, status }) => {
      console.log(`Captured function bundle ${completed}/${total}: ${status}.`);
    },
  });
  console.log(
    JSON.stringify(
      {
        recovery_root: result.recoveryRoot,
        active_functions: result.liveMetadata.length,
        bundle_transport: BUNDLE_TRANSPORT,
      },
      null,
      2
    )
  );
}
