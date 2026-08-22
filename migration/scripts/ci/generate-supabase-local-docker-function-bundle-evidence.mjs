import crypto from "node:crypto";

import {
  CAPTURE_TOOL_VERSION,
  EXPECTED_ACTIVE_FUNCTIONS,
  EXPECTED_PROJECT_REF,
  assertMetadataStableAcrossCapture,
  normalizeLiveFunctionMetadata,
} from "../../../scripts/ci/capture-supabase-current-function-bundles.mjs";
import {
  BUNDLE_TRANSPORT,
  RAW_BODY_SURFACE,
  TRANSPORT_RECEIPT_FILE,
} from "./capture-supabase-current-function-bundles-local-docker.mjs";
import {
  CANONICAL_RECORD_ENCODING,
  buildCurrentFunctionBundleEvidence,
  digestCurrentEvidence,
  encodeCanonicalRecord,
  inspectRecoverySnapshot,
  sha256,
} from "../../../scripts/ci/generate-supabase-current-function-bundle-evidence.mjs";

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort(compareUtf8)) ===
    JSON.stringify([...keys].sort(compareUtf8));

const parseCanonicalSnapshotJson = (snapshot, relativePath, label) => {
  const value = snapshot.files.get(relativePath);
  assert(value, `${label} is missing.`);
  const bytes = Buffer.from(value);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
  const canonicalBytes = Buffer.from(JSON.stringify(parsed, null, 2) + "\n");
  assert(bytes.equals(canonicalBytes), `${label} is not exact canonical JSON.`);
  return parsed;
};

const digestRecoverySnapshot = (files) => {
  const records = [...files.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([relativePath, bytes]) => [
      relativePath,
      sha256(Buffer.from(bytes)),
      String(Buffer.from(bytes).length),
    ]);
  const hash = crypto.createHash("sha256");
  hash.update(
    encodeCanonicalRecord([
      "hushh-current-function-evidence",
      CANONICAL_RECORD_ENCODING,
      "recovery-snapshot-files-v2",
      String(records.length),
    ])
  );
  for (const record of records) hash.update(encodeCanonicalRecord(record));
  return hash.digest("hex");
};

const exactSnapshotCounts = (snapshot) => ({
  files: snapshot.files.size,
  directories: snapshot.directories.size,
  total_bytes: [...snapshot.files.values()].reduce(
    (sum, bytes) => sum + Buffer.from(bytes).length,
    0
  ),
});

export const inspectLocalDockerRecoverySnapshot = ({ snapshot, manifest, limits }) => {
  assert(snapshot?.files instanceof Map, "Recovery snapshot files are invalid.");
  assert(snapshot?.directories instanceof Set, "Recovery snapshot directories are invalid.");
  const observedCounts = exactSnapshotCounts(snapshot);
  assert(
    JSON.stringify(snapshot.counts) === JSON.stringify(observedCounts),
    "Recovery snapshot counts are not exact."
  );

  const rawMetadata = parseCanonicalSnapshotJson(
    snapshot,
    "functions-list.json",
    "Function metadata"
  );
  const rawEndMetadata = parseCanonicalSnapshotJson(
    snapshot,
    "functions-list-end.json",
    "End-of-capture function metadata"
  );
  const receipt = parseCanonicalSnapshotJson(
    snapshot,
    "capture-receipt.json",
    "Capture receipt"
  );
  const transportReceipt = parseCanonicalSnapshotJson(
    snapshot,
    TRANSPORT_RECEIPT_FILE,
    "Local-Docker transport receipt"
  );
  assert(
    exactKeys(receipt, [
      "schema_version",
      "project_ref",
      "tool",
      "tool_version",
      "source_write_mode",
      "metadata_end_check",
      "capture_started_at_utc",
      "capture_completed_at_utc",
      "active_functions",
      "outcomes",
    ]),
    "Capture receipt fields are invalid."
  );
  assert(receipt.schema_version === 1, "Capture receipt schema is invalid.");
  assert(receipt.project_ref === EXPECTED_PROJECT_REF, "Capture project is invalid.");
  assert(receipt.tool === "supabase_cli", "Capture tool is invalid.");
  assert(receipt.tool_version === CAPTURE_TOOL_VERSION, "Capture tool version is invalid.");
  assert(receipt.source_write_mode === "READ_ONLY_NO_DEPLOYMENT", "Capture is not read-only.");
  assert(receipt.metadata_end_check === "MATCHED_EXACTLY", "End-metadata receipt is invalid.");
  assert(receipt.active_functions === EXPECTED_ACTIVE_FUNCTIONS, "Capture count is invalid.");
  assert(
    exactKeys(transportReceipt, [
      "schema_version",
      "project_ref",
      "tool",
      "tool_version",
      "bundle_transport",
      "raw_body_surface",
      "docker_image",
      "docker_image_id",
      "docker_image_os",
      "docker_image_architecture",
      "docker_context_class",
      "docker_context_endpoint_sha256",
      "docker_server_version",
      "download_attempts",
      "raw_body_attempts",
      "capture_receipt_sha256",
      "start_metadata_sha256",
      "end_metadata_sha256",
    ]),
    "Local-Docker transport receipt fields are invalid."
  );
  assert(transportReceipt.schema_version === 1, "Local-Docker transport schema is invalid.");
  assert(transportReceipt.project_ref === EXPECTED_PROJECT_REF, "Local-Docker transport project is invalid.");
  assert(
    transportReceipt.tool === "supabase_cli_metadata_plus_direct_management_api_body",
    "Local-Docker transport tool is invalid."
  );
  assert(transportReceipt.tool_version === CAPTURE_TOOL_VERSION, "Local-Docker transport version is invalid.");
  assert(transportReceipt.bundle_transport === BUNDLE_TRANSPORT, "Local-Docker bundle transport is invalid.");
  assert(
    transportReceipt.raw_body_surface === RAW_BODY_SURFACE,
    "Local-Docker raw body surface is invalid."
  );
  assert(
    typeof transportReceipt.docker_image === "string" &&
      /^public\.ecr\.aws\/supabase\/edge-runtime@sha256:[a-f0-9]{64}$/.test(
        transportReceipt.docker_image
      ),
    "Local-Docker image is not digest-pinned."
  );
  assert(
    typeof transportReceipt.docker_image_id === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(transportReceipt.docker_image_id),
    "Local-Docker image ID is invalid."
  );
  assert(transportReceipt.docker_image_os === "linux", "Local-Docker image OS is invalid.");
  assert(
    transportReceipt.docker_image_architecture === "amd64" ||
      transportReceipt.docker_image_architecture === "arm64",
    "Local-Docker image architecture is invalid."
  );
  assert(
    transportReceipt.docker_context_class === "ABSOLUTE_LOCAL_UNIX_SOCKET",
    "Local-Docker context class is invalid."
  );
  assert(
    typeof transportReceipt.docker_server_version === "string" &&
      /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(
        transportReceipt.docker_server_version
      ),
    "Local-Docker server version is invalid."
  );
  for (const [label, digest] of [
    ["context", transportReceipt.docker_context_endpoint_sha256],
    ["capture", transportReceipt.capture_receipt_sha256],
    ["start metadata", transportReceipt.start_metadata_sha256],
    ["end metadata", transportReceipt.end_metadata_sha256],
  ]) {
    assert(typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest), `${label} digest is invalid.`);
  }
  assert(
    transportReceipt.capture_receipt_sha256 === sha256(snapshot.files.get("capture-receipt.json")) &&
      transportReceipt.start_metadata_sha256 === sha256(snapshot.files.get("functions-list.json")) &&
      transportReceipt.end_metadata_sha256 === sha256(snapshot.files.get("functions-list-end.json")),
    "Local-Docker transport receipt does not bind the capture files."
  );
  assert(
    transportReceipt.download_attempts ===
      receipt.outcomes.reduce((sum, outcome) => sum + outcome.attempts, 0),
    "Local-Docker transport attempt count is incomplete."
  );
  assert(
    Array.isArray(transportReceipt.raw_body_attempts) &&
      transportReceipt.raw_body_attempts.length === transportReceipt.download_attempts,
    "Local-Docker raw body attempts are incomplete."
  );
  let attemptOffset = 0;
  for (const outcome of receipt.outcomes) {
    assert(
      Number.isInteger(outcome.attempts) && outcome.attempts >= 1 && outcome.attempts <= 3,
      "Capture outcome attempts are invalid."
    );
    const attempts = transportReceipt.raw_body_attempts.slice(
      attemptOffset,
      attemptOffset + outcome.attempts
    );
    attemptOffset += outcome.attempts;
    assert(attempts.length === outcome.attempts, `Raw body attempts are missing for ${outcome.slug}.`);
    for (const attempt of attempts) {
      assert(
        exactKeys(attempt, ["slug", "status", "bytes", "sha256"]) &&
          attempt.slug === outcome.slug &&
          [200, 404, 500].includes(attempt.status),
        `Raw body attempt is invalid for ${outcome.slug}.`
      );
      if (attempt.status === 200) {
        assert(
          Number.isSafeInteger(attempt.bytes) &&
            attempt.bytes > 0 &&
            attempt.bytes <= 32 * 1024 * 1024 &&
            typeof attempt.sha256 === "string" &&
            /^[a-f0-9]{64}$/.test(attempt.sha256),
          `Raw body success receipt is invalid for ${outcome.slug}.`
        );
      } else {
        assert(
          attempt.bytes === 0 && attempt.sha256 === null,
          `Raw body failure receipt is invalid for ${outcome.slug}.`
        );
      }
    }
    const statuses = attempts.map(({ status }) => status);
    if (outcome.status === "EXTRACTED") {
      assert(
        statuses.at(-1) === 200 && statuses.slice(0, -1).every((status) => status === 500),
        `Raw body success sequence is invalid for ${outcome.slug}.`
      );
    } else if (outcome.status === "STORE_NOT_FOUND") {
      assert(
        statuses.length === 1 && statuses[0] === 404,
        `Raw body store-not-found sequence is invalid for ${outcome.slug}.`
      );
    } else {
      assert(
        outcome.status === "BUNDLE_RETRIEVAL_FAILED" &&
          statuses.every((status) => status === 500),
        `Raw body failure sequence is invalid for ${outcome.slug}.`
      );
    }
  }
  assert(
    attemptOffset === transportReceipt.raw_body_attempts.length,
    "Local-Docker raw body attempts contain trailing records."
  );

  const normalizedMetadata = normalizeLiveFunctionMetadata({ manifest, liveMetadata: rawMetadata });
  const normalizedEndMetadata = normalizeLiveFunctionMetadata({
    manifest,
    liveMetadata: rawEndMetadata,
  });
  assertMetadataStableAcrossCapture({
    startMetadata: normalizedMetadata,
    endMetadata: normalizedEndMetadata,
  });

  const legacyReceipt = {
    schema_version: 1,
    project_ref: receipt.project_ref,
    tool: receipt.tool,
    tool_version: receipt.tool_version,
    source_write_mode: receipt.source_write_mode,
    capture_started_at_utc: receipt.capture_started_at_utc,
    capture_completed_at_utc: receipt.capture_completed_at_utc,
    active_functions: receipt.active_functions,
    outcomes: receipt.outcomes,
  };
  const legacyFiles = new Map(snapshot.files);
  legacyFiles.delete("functions-list-end.json");
  legacyFiles.delete(TRANSPORT_RECEIPT_FILE);
  legacyFiles.set("capture-receipt.json", Buffer.from(JSON.stringify(legacyReceipt)));
  const legacySnapshot = {
    files: legacyFiles,
    directories: new Set(snapshot.directories),
    counts: {
      files: legacyFiles.size,
      directories: snapshot.directories.size,
      total_bytes: [...legacyFiles.values()].reduce(
        (sum, bytes) => sum + Buffer.from(bytes).length,
        0
      ),
    },
  };
  const legacyInventory = inspectRecoverySnapshot({
    snapshot: legacySnapshot,
    manifest,
    ...(limits ? { limits } : {}),
  });
  return Object.freeze({
    ...legacyInventory,
    rawMetadata,
    normalizedMetadata,
    rawEndMetadata,
    normalizedEndMetadata,
    receipt,
    transportReceipt,
    recoveryCounts: Object.freeze(observedCounts),
    recoverySnapshotDigest: digestRecoverySnapshot(snapshot.files),
  });
};

export const buildLocalDockerCurrentFunctionBundleEvidence = (options) => {
  assert(
    options?.inventory?.transportReceipt?.bundle_transport === BUNDLE_TRANSPORT,
    "Local-Docker transport inventory is missing."
  );
  const evidence = buildCurrentFunctionBundleEvidence(options);
  evidence.capture.tool = "supabase_cli_metadata_plus_direct_management_api_body";
  evidence.capture.bundle_surface =
    "GET /v1/projects/{ref}/functions/{slug}/body raw_eszip via direct_management_api_then_digest_pinned_local_edge_runtime_unbundle";
  evidence.capture.local_unbundle_image = options.inventory.transportReceipt.docker_image;
  evidence.capture.local_unbundle_image_id = options.inventory.transportReceipt.docker_image_id;
  evidence.capture.local_unbundle_image_os = options.inventory.transportReceipt.docker_image_os;
  evidence.capture.local_unbundle_image_architecture =
    options.inventory.transportReceipt.docker_image_architecture;
  evidence.capture_integrity.transport_receipt_digest_algorithm = "sha256";
  evidence.capture_integrity.transport_receipt_digest = sha256(
    Buffer.from(JSON.stringify(options.inventory.transportReceipt, null, 2) + "\n")
  );
  evidence.capture_integrity.raw_body_attempts =
    options.inventory.transportReceipt.raw_body_attempts.length;
  evidence.cutover_assessment.metadata_end_check_status = "MATCHED_EXACTLY";
  evidence.cutover_assessment.bundle_to_metadata_version_binding_status =
    "BOUND_TO_STABLE_START_END_METADATA";
  evidence.evidence_digest.digest = digestCurrentEvidence(evidence);
  return evidence;
};
