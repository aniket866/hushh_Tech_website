import crypto from "node:crypto";
import fs from "node:fs";

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

const TRUST_ANCHOR_URL = new URL(
  "../../contracts/supabase-local-docker-function-bundle-trust-anchor.v1.json",
  import.meta.url
);
const COLLECTOR_SOURCE_URL = new URL(
  "./capture-supabase-current-function-bundles-local-docker.mjs",
  import.meta.url
);
const CAPTURE_CORE_SOURCE_URL = new URL(
  "../../../scripts/ci/capture-supabase-current-function-bundles.mjs",
  import.meta.url
);
const STANDARD_EVIDENCE_SOURCE_URL = new URL(
  "../../../scripts/ci/generate-supabase-current-function-bundle-evidence.mjs",
  import.meta.url
);
const TRUST_ANCHOR_FILE_SHA256 =
  "f0abd5feb3736b841f656fc7b966bd140e270bb94812a4ebf868bc174ea8d9c3";
const TRUST_ANCHOR_KEYS = Object.freeze([
  "schema_version",
  "provisioning_status",
  "project_ref",
  "tool",
  "tool_version",
  "bundle_transport",
  "raw_body_surface",
  "collector_closure_digest_sha256",
  "docker_image",
  "docker_image_id",
  "docker_image_os",
  "docker_image_architecture",
  "docker_context_class",
  "docker_context_endpoint_sha256",
  "docker_server_version",
  "provider_metadata_digest_sha256",
  "raw_body_attempts_digest_sha256",
  "recovered_source_tree_digest_sha256",
  "raw_archive_to_recovered_tree_digest_sha256",
]);
const PROVISIONED_TRUST_FIELDS = Object.freeze([
  "collector_closure_digest_sha256",
  "docker_image",
  "docker_image_id",
  "docker_image_os",
  "docker_image_architecture",
  "docker_context_endpoint_sha256",
  "docker_server_version",
  "provider_metadata_digest_sha256",
  "raw_body_attempts_digest_sha256",
  "recovered_source_tree_digest_sha256",
  "raw_archive_to_recovered_tree_digest_sha256",
]);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const digestCanonicalTrustRecords = (domain, records) => {
  const hash = crypto.createHash("sha256");
  hash.update(
    encodeCanonicalRecord([
      "hushh-local-docker-function-bundle-trust-anchor",
      CANONICAL_RECORD_ENCODING,
      domain,
      String(records.length),
    ])
  );
  for (const record of records) hash.update(encodeCanonicalRecord(record));
  return hash.digest("hex");
};

const digestProviderMetadata = (metadata) =>
  digestCanonicalTrustRecords(
    "provider-metadata-v1",
    metadata.map((entry) => [
      entry.slug,
      entry.function_id,
      entry.status,
      String(entry.current_version),
      String(entry.manifest_version),
      String(entry.version_delta),
      String(entry.verify_jwt),
      entry.provider_bundle_digest ?? "NULL",
    ])
  );

const digestRawBodyAttempts = (attempts) =>
  digestCanonicalTrustRecords(
    "raw-body-attempts-v1",
    attempts.map((attempt, index) => [
      String(index),
      attempt.slug,
      String(attempt.status),
      String(attempt.bytes),
      attempt.sha256 ?? "NULL",
      attempt.recovered_tree_digest_sha256 ?? "NULL",
      attempt.recovered_file_count === null ? "NULL" : String(attempt.recovered_file_count),
      attempt.recovered_total_bytes === null ? "NULL" : String(attempt.recovered_total_bytes),
    ])
  );

const digestRecoveredSourceMembers = (sourceFilesBySlug) =>
  digestCanonicalTrustRecords(
    "recovered-source-tree-members-v1",
    [...sourceFilesBySlug.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .flatMap(([slug, files]) =>
        files.map((file) => [slug, file.relativePath, file.digest, String(file.size)])
      )
  );

const digestRecoveredSlugMembers = (files) =>
  digestCanonicalTrustRecords(
    "recovered-source-tree-per-slug-v1",
    files.map((file) => [file.relativePath, file.digest, String(file.size)])
  );

const digestRawArchiveToRecoveredTree = ({ receipt, rawBodyAttempts, sourceFilesBySlug }) => {
  let attemptOffset = 0;
  const records = [];
  for (const outcome of receipt.outcomes) {
    const attempts = rawBodyAttempts.slice(attemptOffset, attemptOffset + outcome.attempts);
    attemptOffset += outcome.attempts;
    if (outcome.status !== "EXTRACTED") continue;
    const successfulAttempt = attempts.at(-1);
    const files = sourceFilesBySlug.get(outcome.slug);
    assert(
      successfulAttempt?.status === 200 && Array.isArray(files) && files.length > 0,
      `Raw archive mapping is incomplete for ${outcome.slug}.`
    );
    const recoveredTreeDigest = digestRecoveredSlugMembers(files);
    const recoveredTotalBytes = files.reduce((sum, file) => sum + file.size, 0);
    assert(
      successfulAttempt.recovered_tree_digest_sha256 === recoveredTreeDigest &&
        successfulAttempt.recovered_file_count === files.length &&
        successfulAttempt.recovered_total_bytes === recoveredTotalBytes,
      `Raw archive does not bind every recovered source member for ${outcome.slug}.`
    );
    records.push([
      outcome.slug,
      successfulAttempt.sha256,
      String(successfulAttempt.bytes),
      successfulAttempt.recovered_tree_digest_sha256,
      String(successfulAttempt.recovered_file_count),
      String(successfulAttempt.recovered_total_bytes),
    ]);
  }
  assert(attemptOffset === rawBodyAttempts.length, "Raw archive mapping contains trailing attempts.");
  return digestCanonicalTrustRecords("raw-archive-to-recovered-source-tree-v1", records);
};

const digestCollectorClosure = () =>
  digestCanonicalTrustRecords(
    "collector-executable-closure-v1",
    [
      [
        "migration/scripts/ci/capture-supabase-current-function-bundles-local-docker.mjs",
        fs.readFileSync(COLLECTOR_SOURCE_URL),
      ],
      [
        "scripts/ci/capture-supabase-current-function-bundles.mjs",
        fs.readFileSync(CAPTURE_CORE_SOURCE_URL),
      ],
      [
        "scripts/ci/generate-supabase-current-function-bundle-evidence.mjs",
        fs.readFileSync(STANDARD_EVIDENCE_SOURCE_URL),
      ],
    ].map(([relativePath, bytes]) => [
      relativePath,
      sha256(bytes),
      String(bytes.length),
    ])
  );

const assertFixedTrustAnchorIdentity = (anchor) => {
  assert(exactKeys(anchor, TRUST_ANCHOR_KEYS), "Local-Docker trust-anchor fields are invalid.");
  assert(anchor.schema_version === 1, "Local-Docker trust-anchor schema is invalid.");
  assert(anchor.project_ref === EXPECTED_PROJECT_REF, "Local-Docker trust-anchor project is invalid.");
  assert(
    anchor.tool === "supabase_cli_metadata_plus_direct_management_api_body" &&
      anchor.tool_version === CAPTURE_TOOL_VERSION,
    "Local-Docker trust-anchor tool identity is invalid."
  );
  assert(
    anchor.bundle_transport === BUNDLE_TRANSPORT && anchor.raw_body_surface === RAW_BODY_SURFACE,
    "Local-Docker trust-anchor transport identity is invalid."
  );
  return anchor;
};

const assertReviewedTrustAnchor = (anchor) => {
  assertFixedTrustAnchorIdentity(anchor);
  assert(
    anchor.provisioning_status === "REVIEWED",
    "Local-Docker trust anchor is unprovisioned; no recovery snapshot may be accepted."
  );
  for (const field of [
    "collector_closure_digest_sha256",
    "provider_metadata_digest_sha256",
    "raw_body_attempts_digest_sha256",
    "docker_context_endpoint_sha256",
    "recovered_source_tree_digest_sha256",
    "raw_archive_to_recovered_tree_digest_sha256",
  ]) {
    assert(
      typeof anchor[field] === "string" && /^[a-f0-9]{64}$/.test(anchor[field]),
      `Local-Docker trust-anchor ${field} is invalid.`
    );
  }
  assert(
    typeof anchor.docker_image === "string" &&
      /^public\.ecr\.aws\/supabase\/edge-runtime@sha256:[a-f0-9]{64}$/.test(anchor.docker_image),
    "Local-Docker trust-anchor image is invalid."
  );
  assert(
    typeof anchor.docker_image_id === "string" && /^sha256:[a-f0-9]{64}$/.test(anchor.docker_image_id),
    "Local-Docker trust-anchor image ID is invalid."
  );
  assert(anchor.docker_image_os === "linux", "Local-Docker trust-anchor image OS is invalid.");
  assert(
    anchor.docker_image_architecture === "amd64" || anchor.docker_image_architecture === "arm64",
    "Local-Docker trust-anchor image architecture is invalid."
  );
  assert(
    anchor.docker_context_class === "ABSOLUTE_LOCAL_UNIX_SOCKET",
    "Local-Docker trust-anchor context class is invalid."
  );
  assert(
    typeof anchor.docker_server_version === "string" &&
      /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(anchor.docker_server_version),
    "Local-Docker trust-anchor server version is invalid."
  );
  assert(
    anchor.collector_closure_digest_sha256 === digestCollectorClosure(),
    "Local-Docker collector closure changed from the reviewed trust anchor."
  );
  return anchor;
};

const loadFrozenTrustAnchor = () => {
  const bytes = fs.readFileSync(TRUST_ANCHOR_URL);
  assert(
    sha256(bytes) === TRUST_ANCHOR_FILE_SHA256,
    "Local-Docker trust-anchor file changed from its immutable lock."
  );
  let anchor;
  try {
    anchor = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Local-Docker trust-anchor file is invalid JSON.");
  }
  assert(
    bytes.equals(Buffer.from(JSON.stringify(anchor, null, 2) + "\n")),
    "Local-Docker trust-anchor file is not exact canonical JSON."
  );
  assertFixedTrustAnchorIdentity(anchor);
  if (anchor.provisioning_status === "UNPROVISIONED") {
    assert(
      PROVISIONED_TRUST_FIELDS.every((field) => anchor[field] === null),
      "Unprovisioned Local-Docker trust anchor contains review claims."
    );
  }
  return assertReviewedTrustAnchor(anchor);
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

const inspectLocalDockerRecoverySnapshotWithTrustAnchor = ({
  snapshot,
  manifest,
  limits,
  trustAnchor,
}) => {
  const reviewedTrustAnchor = assertReviewedTrustAnchor(trustAnchor);
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
  assert(transportReceipt.schema_version === 2, "Local-Docker transport schema is invalid.");
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
  for (const field of [
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
  ]) {
    assert(
      transportReceipt[field] === reviewedTrustAnchor[field],
      `Local-Docker transport ${field} changed from the reviewed trust anchor.`
    );
  }
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
        exactKeys(attempt, [
          "slug",
          "status",
          "bytes",
          "sha256",
          "recovered_tree_digest_sha256",
          "recovered_file_count",
          "recovered_total_bytes",
        ]) &&
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
            /^[a-f0-9]{64}$/.test(attempt.sha256) &&
            typeof attempt.recovered_tree_digest_sha256 === "string" &&
            /^[a-f0-9]{64}$/.test(attempt.recovered_tree_digest_sha256) &&
            Number.isSafeInteger(attempt.recovered_file_count) &&
            attempt.recovered_file_count > 0 &&
            Number.isSafeInteger(attempt.recovered_total_bytes) &&
            attempt.recovered_total_bytes > 0,
          `Raw body success receipt is invalid for ${outcome.slug}.`
        );
      } else {
        assert(
          attempt.bytes === 0 &&
            attempt.sha256 === null &&
            attempt.recovered_tree_digest_sha256 === null &&
            attempt.recovered_file_count === null &&
            attempt.recovered_total_bytes === null,
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
  assert(
    digestProviderMetadata(normalizedMetadata) ===
      reviewedTrustAnchor.provider_metadata_digest_sha256,
    "Provider metadata changed from the reviewed trust anchor."
  );
  assert(
    digestRawBodyAttempts(transportReceipt.raw_body_attempts) ===
      reviewedTrustAnchor.raw_body_attempts_digest_sha256,
    "Raw function body receipts changed from the reviewed trust anchor."
  );

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
  assert(
    digestRecoveredSourceMembers(legacyInventory.sourceFilesBySlug) ===
      reviewedTrustAnchor.recovered_source_tree_digest_sha256,
    "Recovered source tree changed from the reviewed trust anchor."
  );
  assert(
    digestRawArchiveToRecoveredTree({
      receipt,
      rawBodyAttempts: transportReceipt.raw_body_attempts,
      sourceFilesBySlug: legacyInventory.sourceFilesBySlug,
    }) === reviewedTrustAnchor.raw_archive_to_recovered_tree_digest_sha256,
    "Raw archive to recovered source-tree mapping changed from the reviewed trust anchor."
  );
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

export const inspectLocalDockerRecoverySnapshot = ({ snapshot, manifest, limits }) =>
  inspectLocalDockerRecoverySnapshotWithTrustAnchor({
    snapshot,
    manifest,
    ...(limits ? { limits } : {}),
    trustAnchor: loadFrozenTrustAnchor(),
  });

export const __testing = Object.freeze({
  inspectLocalDockerRecoverySnapshotWithTrustAnchor,
});

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
