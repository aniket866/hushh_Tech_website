const SAFE_CODES = new Set([
  "ACTIVATION_CONTRACT_MISMATCH",
  "ATTESTATION_ABORTED",
  "CATALOG_CHECK_FAILED",
  "CATALOG_BOUNDS_EXCEEDED",
  "CATALOG_RESULT_INVALID",
  "CONNECTOR_CONTRACT_INVALID",
  "EVIDENCE_INVALID",
  "EXECUTION_GATE_FALSE",
  "FORBIDDEN_CREDENTIAL_ENV",
  "HARD_PROCESS_DEADLINE_EXCEEDED",
  "IMAGE_DIGEST_REQUIRED",
  "QUERY_CONTRACT_DRIFT",
  "RUNTIME_CONNECTION_FAILED",
  "SOURCE_CONTRACT_DRIFT",
  "TARGET_BOUNDARY_VIOLATION",
  "WORKER_EXIT_FAILED",
  "WORKER_DEADLINE_EXCEEDED",
  "WORKER_OUTPUT_INVALID",
  "EXTERNAL_CONTEXT_INVALID",
]);

const DIAGNOSTIC_KIND = "HUSHH_TECH_UAT_CLOUDSQL_CONNECTION_DIAGNOSTIC";
const DIAGNOSTIC_STAGES = new Set([
  "DNS",
  "TCP",
  "TLS",
  "IAM",
  "DB_AUTH",
  "DATABASE",
  "CONNECTOR",
  "POST_CONNECT",
  "UNKNOWN",
]);
const TOKEN_PATTERN = /^-?[A-Za-z0-9_.:-]{1,64}$/;
const HOST_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;

function safeToken(value) {
  const token = typeof value === "string" || typeof value === "number" ? String(value) : null;
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

function safeHost(value) {
  return typeof value === "string" && HOST_PATTERN.test(value) ? value : null;
}

function safePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function classifyStage(error, fallbackStage) {
  const code = String(error?.code ?? "").toUpperCase();
  const name = String(error?.name ?? "").toUpperCase();
  const sqlState = String(
    error?.sqlState ??
      error?.sqlstate ??
      (/^[0-9A-Z]{5}$/.test(code) ? code : ""),
  ).toUpperCase();
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA"].includes(code)) return "DNS";
  if (["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"].includes(code)) {
    return "TCP";
  }
  if (code.startsWith("ERR_TLS") || name.includes("TLS") || name.includes("CERT")) return "TLS";
  if (/^28/.test(sqlState)) return "DB_AUTH";
  if (/^3D/.test(sqlState)) return "DATABASE";
  if (code === "PERMISSION_DENIED" || code === "UNAUTHENTICATED") return "IAM";
  return DIAGNOSTIC_STAGES.has(fallbackStage) ? fallbackStage : "UNKNOWN";
}

function isDiagnostic(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") ===
      "address,code,errno,hostname,kind,name,port,sqlState,stage,syscall" &&
    value.kind === DIAGNOSTIC_KIND &&
    DIAGNOSTIC_STAGES.has(value.stage) &&
    ["name", "code", "errno", "hostname", "address", "syscall", "sqlState"].every(
      (key) => value[key] === null || (typeof value[key] === "string" && (key === "hostname" || key === "address" ? HOST_PATTERN : TOKEN_PATTERN).test(value[key])),
    ) &&
    (value.port === null || safePort(value.port) === value.port)
  );
}

export class AttestorError extends Error {
  constructor(code) {
    super(code);
    this.name = "AttestorError";
    this.code = SAFE_CODES.has(code) ? code : "RUNTIME_CONNECTION_FAILED";
  }
}

export function buildConnectionDiagnostic(error, fallbackStage) {
  if (error instanceof AttestorError) return null;
  const diagnostic = {
    kind: DIAGNOSTIC_KIND,
    stage: classifyStage(error, fallbackStage),
    name: safeToken(error?.name),
    code: safeToken(error?.code),
    errno: safeToken(error?.errno),
    syscall: safeToken(error?.syscall),
    hostname: safeHost(error?.hostname),
    address: safeHost(error?.address),
    port: safePort(error?.port),
    sqlState: safeToken(error?.sqlState ?? error?.sqlstate),
  };
  return Object.freeze(diagnostic);
}

export function serializeConnectionDiagnostic(diagnostic) {
  return isDiagnostic(diagnostic) ? `${JSON.stringify(diagnostic)}\n` : "";
}

export function parseConnectionDiagnostic(serialized) {
  try {
    const diagnostic = JSON.parse(String(serialized ?? "").trim());
    return isDiagnostic(diagnostic) ? Object.freeze(diagnostic) : null;
  } catch {
    return null;
  }
}

export function safeErrorCode(error) {
  return error instanceof AttestorError && SAFE_CODES.has(error.code)
    ? error.code
    : "RUNTIME_CONNECTION_FAILED";
}
