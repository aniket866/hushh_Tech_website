#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const MANIFEST_PATH =
  "cloud-run/hushh-tech-app-services/registry/candidates.ai-runtime-batch.v1.json";
const EXPECTED_DIGEST =
  "c279a30edd8f0081a7046311ad74664d41a3c17df3d9517339e1d7edd370cc73";
const BASE_COMMIT = "51a3e6753e0f0194be8d55b68ba2bc99bfdc4bd9";
const PROFILE_RECOVERY_REVISION = "cbfde1b1bf5ef97ebb71766953857750b711d791";
const SLUGS = [
  "veo-generate-video",
  "kyc-agent-a2a",
  "investor-chat",
  "investor-agent-mcp",
  "hushh-profile-search",
  "hushh-ai-chat",
];
const AUTHORITATIVE_CODES = [
  "SOURCE_BUNDLE_VERSION_UNBOUND",
  "SOURCE_METADATA_END_CHECK_MISSING",
  "SOURCE_REVISION_UNPROVEN",
  "SOURCE_VERSION_DRIFT",
  "TARGET_CONTRACT_MISSING",
  "TARGET_REGISTRY_NOT_ENABLED",
];
const EXPECTED_SOURCE_TABLES = Object.freeze({
  "veo-generate-video": Object.freeze([]),
  "kyc-agent-a2a": Object.freeze([
    "kyc_policies",
    "kyc_check_logs",
    "kyc_consent_tokens",
    "investor_profiles",
    "kyc_attestations",
  ]),
  "investor-chat": Object.freeze([
    "chat_access_tokens",
    "investor_profiles",
    "onboarding_data",
    "public_chat_messages",
  ]),
  "investor-agent-mcp": Object.freeze([
    "investor_profiles",
    "onboarding_data",
    "investor_agents",
    "agent_messages",
  ]),
  "hushh-profile-search": Object.freeze([]),
  "hushh-ai-chat": Object.freeze([
    "hushh_ai_rate_limits",
    "hushh_ai_media_limits",
    "hushh_ai_cache",
    "hushh_ai_analytics",
  ]),
});
const EXPECTED_ROWS = Object.freeze({
  "veo-generate-video": Object.freeze({
    functionId: "b22e572e-5b93-4c3d-a033-66273bce3c16",
    manifestVersion: 6107,
    currentVersion: 6150,
    currentBundle: "d79f6c795afdcf8619ab2d2592e04f43e8e4250e505c2cb74c2cc95b2442d677",
    historicalBundle: "eaf87021ff25219bdf513a129ca81cf1cea35def05f094242f29bf3ea67fa685",
    deploymentBinding: "a28d459e0cb470dc8dfa25ce8b5cf36a6cb442b527f8ca6a02d4e6ef0ffc0c75",
    auth: "firebase_bearer",
    owner: "investor-api",
    bodyLimit: 16_384,
  }),
  "kyc-agent-a2a": Object.freeze({
    functionId: "fba3785b-d893-4845-b567-e7fb682a5ac5",
    manifestVersion: 6164,
    currentVersion: 6207,
    currentBundle: "11f29ef2515bb9524c6d2a461e07bdb8932b5176e151092b02e4fe3078fe2dfb",
    historicalBundle: "162321848a8345dd111d526c2e8a4c6bfb610b9c137fec79e9651f62cc803693",
    deploymentBinding: "3b7caa3a909f1f7edf9f14bed3c908ef53a5d9b0bdcac2fe0a7663b031474835",
    auth: "firebase_bearer_recent_auth",
    owner: "identity-api",
    bodyLimit: 32_768,
  }),
  "investor-chat": Object.freeze({
    functionId: "ce9bb50a-29b6-41e4-a267-2ceda720f39d",
    manifestVersion: 6177,
    currentVersion: 6220,
    currentBundle: "f1b67ef629dc52066cf6a0e84fc1032722edb2bf46b44d3517b5e9ad71bde1db",
    historicalBundle: "f2cea72210fe8c5349c648756ccb0e292f4f2023a7f664b92db567788f50b9b0",
    deploymentBinding: "428d1bc72bc9d4dc124f779e7d57d5d8f403e9bdaca05243594d5fa9861df748",
    auth: "firebase_bearer",
    owner: "investor-api",
    bodyLimit: 65_536,
  }),
  "investor-agent-mcp": Object.freeze({
    functionId: "ab924c88-1269-4a67-8a94-1bb76bee6eae",
    manifestVersion: 6170,
    currentVersion: 6213,
    currentBundle: "03f6e845fb0e651e651d0164f20967969d8002f70e2c7128c5e4dc866ac155e7",
    historicalBundle: "7112a6dd44bf397e53e020b661e9d8d28ccf3df582f0579fbb27b100cf7d4f17",
    deploymentBinding: "e42c722aab84cef5f4f7de1309d05942b3834c4e0ab808e081a58ab7e0c40f39",
    auth: "firebase_bearer",
    owner: "investor-api",
    bodyLimit: 65_536,
  }),
  "hushh-profile-search": Object.freeze({
    functionId: "672b359b-50cd-43c4-8617-6f6dd87f6199",
    manifestVersion: 6119,
    currentVersion: 6162,
    currentBundle: "36d4b0c00e1d8e660536551ad00033e6005342a26b1c47672e402c2b5ab1bd57",
    historicalBundle: "702d2c588eb7e3292bced707964dc8f20aaa55ff16bdfa0d8d86f5b76832f5bc",
    deploymentBinding: "65bbc09fcaffb5eb4135959c3872aed4311671227bbffad816d7a6ebb50e5500",
    auth: "firebase_bearer",
    owner: "investor-api",
    bodyLimit: 32_768,
  }),
  "hushh-ai-chat": Object.freeze({
    functionId: "478ec6e2-2fbb-421d-b2fc-e0ed1047daca",
    manifestVersion: 6130,
    currentVersion: 6173,
    currentBundle: "94a3fad68b862bf657d66318c406d3a07c333f410dfa4a24196448d281678d50",
    historicalBundle: "48d281ccf7deb47a934fefe8631c15c1e8e0ef393a374a10d66a9fe869c2bd96",
    deploymentBinding: "88526a96d9cb4b4f7cea9d1478067c0dc59d3cd4262054076753c80ad9f94814",
    auth: "firebase_bearer",
    owner: "investor-api",
    bodyLimit: 98_304,
  }),
});

const TOP_KEYS = [
  "schema_version",
  "base_commit",
  "deployment_state",
  "required_registry_state",
  "target_project",
  "target_region",
  "source_approval",
  "runtime_byte_lock",
  "candidate_implementation",
  "security_contract",
  "source_recovery",
  "functions",
];
const FUNCTION_KEYS = [
  "slug",
  "source_snapshot",
  "source_contract",
  "current_v2",
  "deployment",
  "end_metadata",
  "target",
  "methods",
  "paths",
  "request",
  "response",
  "media_type",
  "body_limit_bytes",
  "cache_policy",
  "cors_policy",
  "dependencies",
  "tables",
  "side_effects",
  "pii",
  "security_boundaries",
  "blockers",
];
const SOURCE_CONTRACT_KEYS = [
  "evidence_scope",
  "methods",
  "auth",
  "request",
  "response",
  "media_type",
  "cache",
  "cors",
  "dependencies",
  "tables",
  "side_effects",
  "pii",
];
const CANDIDATE_IMPLEMENTATION_KEYS = [
  "path",
  "bytes",
  "sha256",
  "runtime_imports",
  "enabled_by_default",
  "activation_artifact",
  "provider_adapters",
  "durable_guards",
];

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label}: exact keys`);
}

function rejectDuplicateJsonObjectKeys(rawText) {
  let cursor = 0;
  const malformed = () => {
    throw new SyntaxError(`Malformed JSON at offset ${cursor}`);
  };
  const whitespace = () => {
    while (/\s/.test(rawText[cursor] ?? "")) cursor += 1;
  };
  const string = () => {
    if (rawText[cursor] !== '"') malformed();
    const start = cursor++;
    while (cursor < rawText.length) {
      if (rawText[cursor] === '"') return JSON.parse(rawText.slice(start, ++cursor));
      if (rawText[cursor] === "\\") {
        cursor += rawText[cursor + 1] === "u" ? 6 : 2;
      } else {
        if (rawText.charCodeAt(cursor) < 32) malformed();
        cursor += 1;
      }
    }
    malformed();
  };
  const value = () => {
    whitespace();
    if (rawText[cursor] === "{") return object();
    if (rawText[cursor] === "[") return array();
    if (rawText[cursor] === '"') return string();
    const start = cursor;
    while (cursor < rawText.length && !/[\s,\]}]/.test(rawText[cursor])) cursor += 1;
    if (start === cursor) malformed();
    JSON.parse(rawText.slice(start, cursor));
  };
  const array = () => {
    cursor += 1;
    whitespace();
    if (rawText[cursor] === "]") return void (cursor += 1);
    while (cursor < rawText.length) {
      value();
      whitespace();
      if (rawText[cursor] === "]") return void (cursor += 1);
      if (rawText[cursor++] !== ",") malformed();
      whitespace();
    }
    malformed();
  };
  const object = () => {
    cursor += 1;
    const keys = new Set();
    whitespace();
    if (rawText[cursor] === "}") return void (cursor += 1);
    while (cursor < rawText.length) {
      const key = string();
      if (keys.has(key)) throw new SyntaxError(`Duplicate JSON object key ${JSON.stringify(key)}`);
      keys.add(key);
      whitespace();
      if (rawText[cursor++] !== ":") malformed();
      value();
      whitespace();
      if (rawText[cursor] === "}") return void (cursor += 1);
      if (rawText[cursor++] !== ",") malformed();
      whitespace();
    }
    malformed();
  };
  value();
  whitespace();
  if (cursor !== rawText.length) malformed();
}

export function parseAndValidateAiRuntimeBatchManifestText(rawText) {
  rejectDuplicateJsonObjectKeys(rawText);
  return validateAiRuntimeBatchManifestDocument(JSON.parse(rawText));
}

export function validateAiRuntimeBatchManifestDocument(matrix) {
  exactKeys(matrix, TOP_KEYS, "manifest");
  assert.equal(matrix.schema_version, 2);
  assert.equal(matrix.base_commit, BASE_COMMIT);
  assert.equal(matrix.deployment_state, "DEFAULT_OFF");
  assert.equal(matrix.required_registry_state, "INVENTORY_FROZEN");
  assert.equal(matrix.target_project, "hushh-tech-uat");
  assert.equal(matrix.target_region, "us-central1");
  assert.deepEqual(matrix.functions.map(({ slug }) => slug), SLUGS);
  exactKeys(
    matrix.candidate_implementation,
    CANDIDATE_IMPLEMENTATION_KEYS,
    "candidate_implementation",
  );
  assert.equal(
    matrix.candidate_implementation.path,
    "cloud-run/hushh-tech-app-services/src/handlers/ai-runtime-batch.js",
  );
  assert.ok(
    Number.isSafeInteger(matrix.candidate_implementation.bytes) &&
      matrix.candidate_implementation.bytes > 0,
  );
  assert.match(matrix.candidate_implementation.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(matrix.candidate_implementation.runtime_imports, []);
  assert.equal(matrix.candidate_implementation.enabled_by_default, false);
  assert.equal(matrix.candidate_implementation.activation_artifact, "forbidden");
  assert.equal(matrix.security_contract.tool_execution, "disabled_plan_only");
  assert.equal(matrix.security_contract.caller_urls, "forbidden");
  assert.equal(matrix.security_contract.idempotency_result_protection, "cloud_kms_envelope_v1");
  assert.equal(matrix.security_contract.replay_ttl_seconds_max, 86_400);
  assert.equal(matrix.security_contract.status, "NOT_LIVE_PROVEN");
  assert.equal(matrix.source_approval.status, "BLOCKED");
  assert.equal(matrix.source_approval.metadata_end_check_status, "NOT_PERFORMED_IN_V2_BLOCKING");
  assert.equal(matrix.source_approval.bundle_to_metadata_binding, "NOT_PROVEN_WITHOUT_END_METADATA_CHECK");
  assert.equal(matrix.source_approval.source_revision_status, "NOT_PROVEN");
  assert.equal(matrix.source_approval.source_revision, null);
  assert.equal(matrix.source_recovery.revision, PROFILE_RECOVERY_REVISION);
  assert.equal(matrix.source_recovery.equivalence_to_manifest_6119, "NOT_ASSERTED");
  assert.equal(matrix.source_recovery.equivalence_to_current_v2_6162, "NOT_ASSERTED");

  for (const row of matrix.functions) {
    exactKeys(row, FUNCTION_KEYS, row.slug);
    const expected = EXPECTED_ROWS[row.slug];
    assert.ok(expected, `${row.slug}: expected row`);
    assert.deepEqual(
      [
        row.current_v2.function_id,
        row.current_v2.manifest_version,
        row.current_v2.current_version,
        row.current_v2.version_delta,
        row.current_v2.verify_jwt,
        row.current_v2.bundle_sha256,
      ],
      [
        expected.functionId,
        expected.manifestVersion,
        expected.currentVersion,
        43,
        true,
        expected.currentBundle,
      ],
      `${row.slug}: current v2`,
    );
    assert.equal(row.source_snapshot.historical_v1_bundle_sha256, expected.historicalBundle);
    exactKeys(row.source_contract, SOURCE_CONTRACT_KEYS, `${row.slug}.source_contract`);
    assert.match(row.source_contract.evidence_scope, /equivalence .* is not asserted/);
    assert.ok(Array.isArray(row.source_contract.methods) && row.source_contract.methods.length >= 2);
    assert.match(row.source_contract.auth, /verify_jwt=true/);
    assert.ok(typeof row.source_contract.request === "string" && row.source_contract.request.length >= 80);
    assert.ok(typeof row.source_contract.response === "string" && row.source_contract.response.length >= 80);
    assert.ok(typeof row.source_contract.media_type === "string" && row.source_contract.media_type.length >= 16);
    assert.match(row.source_contract.cache, /Cache-Control|cache/i);
    assert.match(row.source_contract.cors, /Access-Control-Allow-Origin: \*/);
    assert.ok(
      Array.isArray(row.source_contract.dependencies) && row.source_contract.dependencies.length >= 3,
    );
    assert.deepEqual(row.source_contract.tables, EXPECTED_SOURCE_TABLES[row.slug]);
    assert.ok(
      Array.isArray(row.source_contract.side_effects) && row.source_contract.side_effects.length >= 3,
    );
    exactKeys(
      row.source_contract.pii,
      ["input", "output", "storage", "logs"],
      `${row.slug}.source_contract.pii`,
    );
    assert.ok(row.source_contract.pii.input.length > 0);
    assert.ok(row.source_contract.pii.output.length > 0);
    assert.equal(row.deployment.binding_sha256, expected.deploymentBinding);
    assert.equal(row.deployment.traffic_status, "ZERO_TRAFFIC_OBSERVED");
    assert.equal(row.deployment.request_count_30d, 0);
    assert.equal(row.deployment.manifest_match, "CUTOVER_BLOCKING_VERSION_DRIFT");
    assert.deepEqual(row.target, { auth: expected.auth, owner_group: expected.owner });
    assert.equal(row.body_limit_bytes, expected.bodyLimit);
    assert.match(row.cache_policy, /^private, no-store/);
    assert.match(row.cors_policy, /^exact same-origin allowlist/);
    assert.ok(Array.isArray(row.methods) && row.methods.includes("OPTIONS"));
    assert.ok(Array.isArray(row.paths) && row.paths.length > 0);
    assert.ok(typeof row.request === "string" && row.request.length >= 60);
    assert.ok(typeof row.response === "string" && row.response.length >= 50);
    assert.ok(Array.isArray(row.dependencies) && row.dependencies.length >= 5);
    assert.deepEqual(row.tables, EXPECTED_SOURCE_TABLES[row.slug]);
    assert.ok(Array.isArray(row.side_effects) && row.side_effects.length >= 2);
    exactKeys(row.pii, ["input", "output", "storage", "logs"], `${row.slug}.pii`);
    assert.ok(Array.isArray(row.security_boundaries) && row.security_boundaries.length >= 5);
    assert.ok(Array.isArray(row.blockers) && row.blockers.length >= 12);
    for (const blocker of row.blockers) {
      exactKeys(blocker, ["code", "evidence"], `${row.slug}.blocker`);
    }
    assert.deepEqual(row.blockers.slice(0, 6).map(({ code }) => code), AUTHORITATIVE_CODES);
    assert.equal(row.blockers[6].code, "DETACHED_CANDIDATE_APPROVAL_MISSING");
    assert.equal(row.blockers.at(-1).code, "DOMAIN_OPERATION_ADAPTER_NOT_RUNTIME_WIRED");
  }
  assert.equal(digest(stableJson(matrix)), EXPECTED_DIGEST, "manifest canonical digest");
  return matrix;
}

export function validateAiRuntimeBatchCandidateHandlerBytes(matrix, bytes) {
  assert.ok(bytes instanceof Uint8Array, "candidate handler: bytes");
  assert.equal(
    bytes.byteLength,
    matrix.candidate_implementation.bytes,
    "candidate handler: exact bytes",
  );
  assert.equal(
    digest(bytes),
    matrix.candidate_implementation.sha256,
    "candidate handler: exact digest",
  );
  return bytes;
}

async function readJson(root, relativePath) {
  const bytes = await readFile(path.join(root, relativePath));
  return { bytes, value: JSON.parse(bytes) };
}

async function verifyGitRecovery(root, recovery) {
  const { stdout: header } = await execFileAsync(
    "git",
    ["show", "--format=%H%n%s", "--no-patch", recovery.revision],
    { cwd: root, encoding: "utf8" },
  );
  assert.deepEqual(header.trim().split("\n"), [recovery.revision, recovery.revision_subject]);
  for (const file of recovery.tree_files) {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${recovery.revision}:${file.path}`],
      { cwd: root, encoding: "buffer", maxBuffer: 2_000_000 },
    );
    assert.equal(stdout.length, file.bytes, `${file.path}: recovered bytes`);
    assert.equal(digest(stdout), file.sha256, `${file.path}: recovered digest`);
  }
}

export async function validateAiRuntimeBatchCandidateManifest({
  repoRoot,
  verifyGitRecovery: shouldVerifyGitRecovery = true,
} = {}) {
  const root = repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const manifestBytes = await readFile(path.join(root, MANIFEST_PATH));
  const matrix = parseAndValidateAiRuntimeBatchManifestText(manifestBytes.toString("utf8"));
  validateAiRuntimeBatchCandidateHandlerBytes(
    matrix,
    await readFile(path.join(root, matrix.candidate_implementation.path)),
  );
  const [retirement, historical, current, traffic, terminal, registry] = await Promise.all([
    readJson(root, matrix.source_approval.historical_manifest_path),
    readJson(root, matrix.source_approval.historical_bundle_path),
    readJson(root, matrix.source_approval.current_v2_path),
    readJson(root, matrix.source_approval.traffic_path),
    readJson(root, matrix.source_approval.terminal_matrix_path),
    readJson(root, "cloud-run/hushh-tech-app-services/registry/functions.v1.json"),
  ]);
  assert.equal(digest(retirement.bytes), matrix.source_approval.historical_manifest_sha256);
  assert.equal(digest(historical.bytes), matrix.source_approval.historical_bundle_file_sha256);
  assert.equal(digest(current.bytes), matrix.source_approval.current_v2_file_sha256);
  assert.equal(digest(traffic.bytes), matrix.source_approval.traffic_file_sha256);
  assert.equal(digest(terminal.bytes), matrix.source_approval.terminal_matrix_file_sha256);
  assert.equal(current.value.evidence_digest.digest, matrix.source_approval.current_v2_evidence_digest);
  assert.equal(current.value.canonical_source_tree.digest, matrix.source_approval.canonical_source_tree_digest);
  assert.equal(current.value.current_metadata_digest.digest, matrix.source_approval.current_metadata_digest);
  assert.equal(current.value.capture.capture_completed_at_utc, matrix.source_approval.capture_completed_at);
  assert.deepEqual(
    {
      metadataEndCheck: current.value.cutover_assessment.metadata_end_check_status,
      bundleBinding:
        current.value.cutover_assessment.bundle_to_metadata_version_binding_status,
      sourceRevisionStatus: current.value.cutover_assessment.source_revision_status,
      sourceRevision: current.value.cutover_assessment.source_revision,
    },
    {
      metadataEndCheck: matrix.source_approval.metadata_end_check_status,
      bundleBinding: matrix.source_approval.bundle_to_metadata_binding,
      sourceRevisionStatus: matrix.source_approval.source_revision_status,
      sourceRevision: matrix.source_approval.source_revision,
    },
  );
  assert.equal(traffic.value.evidence_digest.digest, matrix.source_approval.traffic_evidence_digest);
  assert.equal(
    traffic.value.deployment_capture.normalized_digest,
    matrix.source_approval.deployment_inventory_digest,
  );
  assert.equal(terminal.value.evidence_digest, matrix.source_approval.terminal_matrix_evidence_digest);

  for (const [runtimePath, expectedDigest] of Object.entries(matrix.runtime_byte_lock)) {
    assert.equal(digest(await readFile(path.join(root, runtimePath))), expectedDigest, runtimePath);
  }
  for (const row of matrix.functions) {
    const retirementRow = retirement.value.functions.find(({ source }) => source.slug === row.slug);
    const historicalRow = historical.value.entries.find(({ slug }) => slug === row.slug);
    const currentRow = current.value.entries.find(({ slug }) => slug === row.slug);
    const trafficRow = traffic.value.entries.find(({ slug }) => slug === row.slug);
    const terminalRow = terminal.value.entries.find(({ slug }) => slug === row.slug);
    const registryRow = registry.value.find(({ slug }) => slug === row.slug);
    assert.ok(retirementRow && historicalRow && currentRow && trafficRow && terminalRow && registryRow);
    assert.deepEqual(
      [retirementRow.source.version, retirementRow.source.verify_jwt, retirementRow.auth_mode, retirementRow.owner_group],
      [row.current_v2.manifest_version, true, row.target.auth, row.target.owner_group],
      `${row.slug}: retirement manifest`,
    );
    assert.deepEqual(
      [historicalRow.version, historicalRow.verify_jwt, historicalRow.bundle_evidence.canonical_digest],
      [row.current_v2.manifest_version, true, row.source_snapshot.historical_v1_bundle_sha256],
      `${row.slug}: historical bundle`,
    );
    assert.deepEqual(
      [
        currentRow.function_id,
        currentRow.status,
        currentRow.manifest_version,
        currentRow.current_version,
        currentRow.version_delta,
        currentRow.verify_jwt,
        currentRow.bundle_evidence.canonical_digest,
        currentRow.bundle_evidence.file_count,
        currentRow.bundle_evidence.total_bytes,
      ],
      [
        row.current_v2.function_id,
        row.current_v2.status,
        row.current_v2.manifest_version,
        row.current_v2.current_version,
        43,
        true,
        row.current_v2.bundle_sha256,
        row.current_v2.file_count,
        row.current_v2.total_bytes,
      ],
      `${row.slug}: current v2 evidence`,
    );
    assert.deepEqual(
      [
        trafficRow.deployment_observed_at_utc_bucket,
        trafficRow.deployment_binding_sha256,
        trafficRow.deployment_manifest_match_status,
        trafficRow.terminal_traffic_status,
        trafficRow.request_count,
      ],
      [
        row.deployment.observed_at,
        row.deployment.binding_sha256,
        row.deployment.manifest_match,
        row.deployment.traffic_status,
        row.deployment.request_count_30d,
      ],
      `${row.slug}: deployment evidence`,
    );
    assert.deepEqual(terminalRow.blockers, row.blockers.slice(0, 6));
    assert.equal(terminalRow.auth_mode, row.target.auth);
    assert.equal(terminalRow.owner_group, row.target.owner_group);
    assert.equal(terminalRow.target.contract_digest, null);
    assert.equal(terminalRow.target.live_evidence_digest, null);
    assert.equal(registryRow.migration_state, "INVENTORY_FROZEN");
    assert.notEqual(registryRow.migration_state, "PORTED_AND_VERIFIED");
    if (row.source_snapshot.mode === "CHECKED_IN_AT_BASE") {
      for (const file of row.source_snapshot.files) {
        const bytes = await readFile(path.join(root, file.path));
        assert.equal(bytes.length, file.bytes, `${file.path}: bytes`);
        assert.equal(digest(bytes), file.sha256, `${file.path}: digest`);
      }
    } else {
      assert.equal(row.slug, "hushh-profile-search");
      assert.deepEqual(row.source_snapshot.files, []);
      assert.deepEqual(retirementRow.source_recovery, {
        mode: "RECOVER_FROM_GIT_HISTORY",
        source_commit: matrix.source_recovery.revision,
      });
      assert.equal(historicalRow.source_recovery_mode, "RECOVER_FROM_GIT_HISTORY");
    }
  }
  if (shouldVerifyGitRecovery) await verifyGitRecovery(root, matrix.source_recovery);
  return matrix;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await validateAiRuntimeBatchCandidateManifest({
    verifyGitRecovery: !process.argv.includes("--skip-git-recovery"),
  });
  process.stdout.write("AI runtime candidate manifest: PASS (6 frozen, 0 wired)\n");
}
