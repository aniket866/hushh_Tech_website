#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const MANIFEST_PATH =
  "cloud-run/hushh-tech-app-services/registry/candidates.plaid-payment-batch.v1.json";
const EXPECTED_DIGEST =
  "0020b8200e74558b541d725d3d01d43b4099c79b9ac5c2aadebcc4bc7c4da281";
const TOP_KEYS = [
  "schema_version", "base_commit", "deployment_state", "required_registry_state",
  "target_project", "target_region", "source_approval", "runtime_byte_lock",
  "raw_signature_contract", "durable_operation_ledger", "functions",
];
const SOURCE_APPROVAL_KEYS = [
  "status", "checked_in_source_binding", "live_v2_bundle_binding",
  "exact_source_version_binding", "metadata_end_check_passed",
  "metadata_end_check_status", "source_evidence_file_sha256",
  "source_evidence_digest", "canonical_source_tree_digest",
  "current_metadata_digest", "traffic_evidence_file_sha256",
  "traffic_evidence_digest", "deployment_inventory_digest",
  "terminal_matrix_file_sha256", "terminal_matrix_evidence_digest",
  "detached_approval_status", "end_metadata_artifact_status",
  "checked_in_approval_artifact",
];
const FUNCTION_KEYS = [
  "slug", "source_path", "source_sha256", "live_bundle_sha256", "function_id",
  "source_version", "manifest_version", "verify_jwt", "deployment_binding_sha256",
  "traffic_30d", "target_auth", "target_owner_group", "request", "response",
  "tables", "side_effects", "method", "media_type", "body_limit_bytes",
  "cache_policy", "cors_policy", "dependencies", "blockers",
];
const TRAFFIC_KEYS = [
  "request_count", "status_2xx", "status_4xx", "options", "post", "jwt_present",
];
const AUTHORITATIVE_CODES = [
  "SOURCE_BUNDLE_VERSION_UNBOUND",
  "SOURCE_METADATA_END_CHECK_MISSING",
  "SOURCE_REVISION_UNPROVEN",
  "SOURCE_VERSION_DRIFT",
  "TARGET_CONTRACT_MISSING",
  "TARGET_REGISTRY_NOT_ENABLED",
];
const SLUGS = [
  "create-link-token", "exchange-public-token", "fund-coupon-redeem",
  "fund-payment-request-create", "fund-payment-status", "plaid-data-sync-start",
  "plaid-data-webhook", "plaid-diagnostics-log",
];

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label}: exact keys`);
}

function rejectDuplicateJsonObjectKeys(rawText) {
  assert.equal(typeof rawText, "string", "manifest raw text");
  let cursor = 0;

  const malformed = () => {
    throw new SyntaxError(`Malformed JSON at offset ${cursor}`);
  };
  const skipWhitespace = () => {
    while (/\s/.test(rawText[cursor] ?? "")) cursor += 1;
  };
  const parseString = () => {
    if (rawText[cursor] !== '"') malformed();
    const start = cursor;
    cursor += 1;
    while (cursor < rawText.length) {
      const character = rawText[cursor];
      if (character === '"') {
        cursor += 1;
        return JSON.parse(rawText.slice(start, cursor));
      }
      if (character === "\\") {
        cursor += 1;
        const escape = rawText[cursor];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(rawText.slice(cursor + 1, cursor + 5))) {
            malformed();
          }
          cursor += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape ?? "")) malformed();
        cursor += 1;
        continue;
      }
      if (character.codePointAt(0) < 32) malformed();
      cursor += 1;
    }
    malformed();
  };
  const parsePrimitive = () => {
    const start = cursor;
    while (cursor < rawText.length && !/[\s,\]}]/.test(rawText[cursor])) {
      cursor += 1;
    }
    if (start === cursor) malformed();
    JSON.parse(rawText.slice(start, cursor));
  };
  const parseValue = () => {
    skipWhitespace();
    if (rawText[cursor] === "{") {
      parseObject();
    } else if (rawText[cursor] === "[") {
      parseArray();
    } else if (rawText[cursor] === '"') {
      parseString();
    } else {
      parsePrimitive();
    }
  };
  const parseArray = () => {
    cursor += 1;
    skipWhitespace();
    if (rawText[cursor] === "]") {
      cursor += 1;
      return;
    }
    while (cursor < rawText.length) {
      parseValue();
      skipWhitespace();
      if (rawText[cursor] === "]") {
        cursor += 1;
        return;
      }
      if (rawText[cursor] !== ",") malformed();
      cursor += 1;
      skipWhitespace();
    }
    malformed();
  };
  const parseObject = () => {
    cursor += 1;
    const keys = new Set();
    skipWhitespace();
    if (rawText[cursor] === "}") {
      cursor += 1;
      return;
    }
    while (cursor < rawText.length) {
      const key = parseString();
      if (keys.has(key)) {
        throw new SyntaxError(`Duplicate JSON object key ${JSON.stringify(key)}`);
      }
      keys.add(key);
      skipWhitespace();
      if (rawText[cursor] !== ":") malformed();
      cursor += 1;
      parseValue();
      skipWhitespace();
      if (rawText[cursor] === "}") {
        cursor += 1;
        return;
      }
      if (rawText[cursor] !== ",") malformed();
      cursor += 1;
      skipWhitespace();
    }
    malformed();
  };

  parseValue();
  skipWhitespace();
  if (cursor !== rawText.length) malformed();
}

export function parseAndValidatePlaidPaymentBatchManifestText(rawText) {
  rejectDuplicateJsonObjectKeys(rawText);
  return validatePlaidPaymentBatchManifestDocument(JSON.parse(rawText));
}

export function validatePlaidPaymentBatchManifestDocument(matrix) {
  exactKeys(matrix, TOP_KEYS, "manifest");
  exactKeys(matrix.source_approval, SOURCE_APPROVAL_KEYS, "source_approval");
  assert.equal(matrix.schema_version, 2);
  assert.equal(matrix.base_commit, "95a88840d7f575e9852e89051e5b34f3f689a39f");
  assert.equal(matrix.deployment_state, "DEFAULT_OFF");
  assert.equal(matrix.required_registry_state, "INVENTORY_FROZEN");
  assert.equal(matrix.target_project, "hushh-tech-uat");
  assert.equal(matrix.target_region, "us-central1");
  assert.deepEqual(
    {
      status: matrix.source_approval.status,
      metadata_end_check_passed: matrix.source_approval.metadata_end_check_passed,
      detached_approval_status: matrix.source_approval.detached_approval_status,
      end_metadata_artifact_status: matrix.source_approval.end_metadata_artifact_status,
      checked_in_approval_artifact: matrix.source_approval.checked_in_approval_artifact,
    },
    {
      status: "BLOCKED",
      metadata_end_check_passed: false,
      detached_approval_status: "MISSING",
      end_metadata_artifact_status: "MISSING",
      checked_in_approval_artifact: "forbidden",
    },
  );
  assert.deepEqual(matrix.functions.map(({ slug }) => slug), SLUGS);
  for (const row of matrix.functions) {
    exactKeys(row, FUNCTION_KEYS, row.slug);
    exactKeys(row.traffic_30d, TRAFFIC_KEYS, `${row.slug}.traffic_30d`);
    assert.equal(row.method, "POST");
    assert.equal(row.media_type, "application/json");
    assert.equal(row.body_limit_bytes, row.slug === "plaid-data-webhook" ? 1_048_576 : 262_144);
    assert.equal(row.cache_policy, "private, no-store");
    assert.equal(row.cors_policy, row.slug === "plaid-data-webhook" ? "forbidden" : "same-origin allowlist");
    assert.equal(typeof row.request, "string");
    assert.equal(typeof row.response, "string");
    assert.ok(Array.isArray(row.dependencies) && row.dependencies.length >= 2);
    assert.ok(Array.isArray(row.tables));
    assert.ok(Array.isArray(row.side_effects));
    assert.ok(Array.isArray(row.blockers) && row.blockers.length >= 9);
    for (const blocker of row.blockers) exactKeys(blocker, ["code", "evidence"], `${row.slug}.blocker`);
    assert.deepEqual(row.blockers.slice(0, 6).map(({ code }) => code), AUTHORITATIVE_CODES);
    assert.equal(row.blockers[6].code, "DETACHED_CANDIDATE_APPROVAL_MISSING");
    assert.equal(row.blockers.at(-1).code, "DOMAIN_OPERATION_ADAPTER_NOT_RUNTIME_WIRED");
  }
  assert.equal(digest(stableJson(matrix)), EXPECTED_DIGEST, "manifest canonical digest");
  return matrix;
}

export async function validatePlaidPaymentBatchCandidateManifest({ repoRoot } = {}) {
  const root = repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const bytes = await readFile(path.join(root, MANIFEST_PATH));
  const matrix = parseAndValidatePlaidPaymentBatchManifestText(bytes.toString("utf8"));
  const [liveBytes, trafficBytes, terminalBytes] = await Promise.all([
    readFile(path.join(root, "migration/evidence/supabase-current-live-function-bundles.v2.json")),
    readFile(path.join(root, "migration/evidence/supabase-function-traffic-30d.v1.json")),
    readFile(path.join(root, "migration/evidence/edge-function-terminal-matrix.v1.json")),
  ]);
  const live = JSON.parse(liveBytes);
  const traffic = JSON.parse(trafficBytes);
  const terminal = JSON.parse(terminalBytes);
  assert.equal(digest(liveBytes), matrix.source_approval.source_evidence_file_sha256);
  assert.equal(digest(trafficBytes), matrix.source_approval.traffic_evidence_file_sha256);
  assert.equal(digest(terminalBytes), matrix.source_approval.terminal_matrix_file_sha256);
  for (const [runtimePath, expectedDigest] of Object.entries(matrix.runtime_byte_lock)) {
    assert.equal(digest(await readFile(path.join(root, runtimePath))), expectedDigest);
  }
  for (const row of matrix.functions) {
    assert.equal(digest(await readFile(path.join(root, row.source_path))), row.source_sha256);
    const current = live.entries.find(({ slug }) => slug === row.slug);
    const trafficRow = traffic.entries.find(({ slug }) => slug === row.slug);
    const terminalRow = terminal.entries.find(({ slug }) => slug === row.slug);
    assert.deepEqual(
      [current.function_id, current.current_version, current.manifest_version,
        current.verify_jwt, current.bundle_evidence.canonical_digest],
      [row.function_id, row.source_version, row.manifest_version, row.verify_jwt,
        row.live_bundle_sha256],
    );
    assert.deepEqual(
      [trafficRow.request_count, trafficRow.deployment_binding_sha256,
        trafficRow.status_class_counts.status_2xx, trafficRow.status_class_counts.status_4xx,
        trafficRow.method_counts.OPTIONS, trafficRow.method_counts.POST,
        trafficRow.auth_marker_counts.authorization_jwt_marker_present],
      [row.traffic_30d.request_count, row.deployment_binding_sha256,
        row.traffic_30d.status_2xx, row.traffic_30d.status_4xx,
        row.traffic_30d.options, row.traffic_30d.post, row.traffic_30d.jwt_present],
    );
    assert.deepEqual(row.blockers.slice(0, 6), terminalRow.blockers);
  }
  return matrix;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await validatePlaidPaymentBatchCandidateManifest();
  process.stdout.write("Plaid/payment candidate manifest: PASS (8 frozen, 0 wired)\n");
}
