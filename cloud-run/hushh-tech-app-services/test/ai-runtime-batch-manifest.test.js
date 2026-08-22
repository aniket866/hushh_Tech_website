import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseAndValidateAiRuntimeBatchManifestText,
  validateAiRuntimeBatchCandidateHandlerBytes,
  validateAiRuntimeBatchCandidateManifest,
  validateAiRuntimeBatchManifestDocument,
} from "../../../scripts/gcp/migration/validate-ai-runtime-batch-candidates.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const manifestUrl = new URL(
  "cloud-run/hushh-tech-app-services/registry/candidates.ai-runtime-batch.v1.json",
  repoRoot,
);

async function rawManifest() {
  return readFile(manifestUrl, "utf8");
}

async function manifest() {
  return JSON.parse(await rawManifest());
}

test("manifest binds six frozen source, current-v2, deployment, end-metadata, and runtime records", async () => {
  const matrix = await validateAiRuntimeBatchCandidateManifest({
    repoRoot: repoRoot.pathname,
  });
  assert.equal(matrix.functions.length, 6);
  assert.equal(matrix.functions.every(({ current_v2: current }) => current.version_delta === 43), true);
  assert.equal(matrix.functions.every(({ deployment }) => deployment.request_count_30d === 0), true);
});

test("manifest validator rejects activation, evidence, auth, privacy, security, and blocker drift", async () => {
  const attacks = [
    ["top-level field", (value) => { value.enabled = true; }],
    ["production target", (value) => { value.target_project = "hushh-tech-prod"; }],
    ["runtime import", (value) => { value.candidate_implementation.runtime_imports.push("src/app.js"); }],
    ["handler bytes", (value) => { value.candidate_implementation.bytes += 1; }],
    ["handler digest", (value) => { value.candidate_implementation.sha256 = "0".repeat(64); }],
    ["enabled default", (value) => { value.candidate_implementation.enabled_by_default = true; }],
    ["approval artifact", (value) => { value.candidate_implementation.activation_artifact = "approved"; }],
    ["tool execution", (value) => { value.security_contract.tool_execution = "auto"; }],
    ["caller URL", (value) => { value.security_contract.caller_urls = "allowed"; }],
    ["recovery equivalence", (value) => { value.source_recovery.equivalence_to_current_v2_6162 = "MATCH"; }],
    ["source revision", (value) => { value.source_approval.source_revision = "claimed"; }],
    ["version", (value) => { value.functions[0].current_v2.current_version += 1; }],
    ["bundle", (value) => { value.functions[0].current_v2.bundle_sha256 = "0".repeat(64); }],
    ["source method", (value) => { value.functions[0].source_contract.methods.length = 0; }],
    ["source auth", (value) => { value.functions[0].source_contract.auth = "anonymous"; }],
    ["source table", (value) => { value.functions[5].source_contract.tables[1] = "invented"; }],
    ["source PII", (value) => { value.functions[2].source_contract.pii.input.length = 0; }],
    ["auth", (value) => { value.functions[1].target.auth = "firebase_bearer"; }],
    ["owner", (value) => { value.functions[1].target.owner_group = "investor-api"; }],
    ["CORS", (value) => { value.functions[0].cors_policy = "*"; }],
    ["cache", (value) => { value.functions[0].cache_policy = "public"; }],
    ["body limit", (value) => { value.functions[0].body_limit_bytes += 1; }],
    ["dependency", (value) => { value.functions[0].dependencies.length = 0; }],
    ["security boundary", (value) => { value.functions[0].security_boundaries.length = 0; }],
    ["PII field", (value) => { value.functions[0].pii.raw_prompt = "stored"; }],
    ["blocker removal", (value) => { value.functions[0].blockers.pop(); }],
    ["global blocker reorder", (value) => { value.functions[0].blockers.reverse(); }],
  ];
  for (const [name, mutate] of attacks) {
    const value = await manifest();
    mutate(value);
    assert.throws(() => validateAiRuntimeBatchManifestDocument(value), undefined, name);
  }
});

test("candidate handler bytes are exact-hash bound and one-byte drift fails", async () => {
  const matrix = await manifest();
  const bytes = await readFile(new URL(matrix.candidate_implementation.path, repoRoot));
  assert.doesNotThrow(() => validateAiRuntimeBatchCandidateHandlerBytes(matrix, bytes));

  const drifted = Buffer.from(bytes);
  drifted[Math.floor(drifted.length / 2)] ^= 1;
  assert.throws(
    () => validateAiRuntimeBatchCandidateHandlerBytes(matrix, drifted),
    /candidate handler: exact digest/,
  );
  assert.throws(
    () => validateAiRuntimeBatchCandidateHandlerBytes(matrix, bytes.subarray(0, -1)),
    /candidate handler: exact bytes/,
  );
});

test("raw manifest parser rejects nested and escaped-equivalent duplicate keys", async () => {
  const raw = await rawManifest();
  const attacks = [
    raw.replace(
      '"deployment_state": "DEFAULT_OFF",',
      '"deployment_state": "DEFAULT_OFF", "deployment_state": "LIVE",',
    ),
    raw.replace(
      '"auth": "firebase_bearer",',
      '"auth": "firebase_bearer", "auth": "public",',
    ),
    raw.replace(
      '"cache_policy": "private, no-store",',
      '"cache_policy": "private, no-store", "cache_policy": "public",',
    ),
    raw.replace(
      '"deployment_state": "DEFAULT_OFF",',
      String.raw`"deployment_state": "DEFAULT_OFF", "\u0064eployment_state": "LIVE",`,
    ),
    raw.replace(
      '"code": "SOURCE_BUNDLE_VERSION_UNBOUND",',
      '"code": "SOURCE_BUNDLE_VERSION_UNBOUND", "code": "REMOVED",',
    ),
  ];
  for (const attack of attacks) {
    assert.throws(
      () => parseAndValidateAiRuntimeBatchManifestText(attack),
      /Duplicate JSON object key/,
    );
  }
});

test("unique object-key order is cosmetic but canonical evidence is fixed", async () => {
  const value = await manifest();
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.doesNotThrow(() =>
    parseAndValidateAiRuntimeBatchManifestText(JSON.stringify(reordered)),
  );
});
