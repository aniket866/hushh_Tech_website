import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseAndValidatePlaidPaymentBatchManifestText,
  validatePlaidPaymentBatchCandidateManifest,
  validatePlaidPaymentBatchManifestDocument,
} from "../../../scripts/gcp/migration/validate-plaid-payment-batch-candidates.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const manifestUrl = new URL(
  "cloud-run/hushh-tech-app-services/registry/candidates.plaid-payment-batch.v1.json",
  repoRoot,
);

async function manifest() {
  return JSON.parse(await readFile(manifestUrl, "utf8"));
}

async function rawManifest() {
  return readFile(manifestUrl, "utf8");
}

test("exact frozen payment and webhook manifest binds source, current-v2, traffic, terminal blockers, and runtime bytes", async () => {
  const matrix = await validatePlaidPaymentBatchCandidateManifest({
    repoRoot: repoRoot.pathname,
  });
  assert.equal(matrix.functions.length, 4);
  assert.equal(matrix.functions.every((row) => row.blockers.length >= 9), true);
});

test("manifest validator rejects schema drift and deployment hints fail closed", async () => {
  const attacks = [
    ["unknown top-level field", (value) => { value.activate = true; }],
    ["missing top-level field", (value) => { delete value.target_region; }],
    ["production target", (value) => { value.target_project = "hushh-tech-prod"; }],
    ["activation hint", (value) => { value.functions[0].enabled = true; }],
    ["wildcard CORS", (value) => { value.functions[0].cors_policy = "*"; }],
    ["public cache", (value) => { value.functions[0].cache_policy = "public, max-age=3600"; }],
    ["method drift", (value) => { value.functions[0].method = "GET"; }],
    ["media drift", (value) => { value.functions[0].media_type = "text/plain"; }],
    ["body-limit drift", (value) => { value.functions[0].body_limit_bytes += 1; }],
    ["request drift", (value) => { value.functions[0].request = "any JSON"; }],
    ["response drift", (value) => { value.functions[0].response = "any JSON"; }],
    ["dependency removal", (value) => { value.functions[0].dependencies.pop(); }],
    ["auth drift", (value) => { value.functions[0].target_auth = "public"; }],
    ["owner drift", (value) => { value.functions[0].target_owner_group = "browser"; }],
    ["source drift", (value) => { value.functions[0].source_sha256 = "0".repeat(64); }],
    ["traffic drift", (value) => { value.functions[0].traffic_30d.request_count = 0; }],
    ["blocker removal", (value) => { value.functions[0].blockers.pop(); }],
    ["blocker reorder", (value) => { value.functions[0].blockers.reverse(); }],
  ];
  for (const [name, mutate] of attacks) {
    const value = await manifest();
    mutate(value);
    assert.throws(
      () => validatePlaidPaymentBatchManifestDocument(value),
      undefined,
      name,
    );
  }
});

test("raw manifest parser rejects recursive and escaped-equivalent duplicate keys", async () => {
  const raw = await rawManifest();
  const attacks = [
    [
      "top-level deployment state",
      raw.replace(
        '"deployment_state": "DEFAULT_OFF",',
        '"deployment_state": "DEFAULT_OFF", "deployment_state": "DEFAULT_OFF",',
      ),
    ],
    [
      "per-slug CORS",
      raw.replace(
        '"cors_policy": "same-origin allowlist",',
        '"cors_policy": "same-origin allowlist", "cors_policy": "forbidden",',
      ),
    ],
    [
      "per-slug cache",
      raw.replace(
        '"cache_policy": "private, no-store",',
        '"cache_policy": "private, no-store", "cache_policy": "public",',
      ),
    ],
    [
      "nested traffic",
      raw.replace(
        '"request_count": 4,',
        '"request_count": 4, "request_count": 0,',
      ),
    ],
    [
      "blocker code",
      raw.replace(
        '"code": "SOURCE_BUNDLE_VERSION_UNBOUND",',
        '"code": "SOURCE_BUNDLE_VERSION_UNBOUND", "code": "REMOVED",',
      ),
    ],
    [
      "escaped-equivalent key",
      raw.replace(
        '"deployment_state": "DEFAULT_OFF",',
        String.raw`"deployment_state": "DEFAULT_OFF", "\u0064eployment_state": "LIVE",`,
      ),
    ],
    [
      "prototype-like nested key",
      raw.replace(
        '"evidence": "NOT_PROVEN_WITHOUT_END_METADATA_CHECK"',
        '"__proto__": 1, "__proto__": 2, "evidence": "NOT_PROVEN_WITHOUT_END_METADATA_CHECK"',
      ),
    ],
  ];
  for (const [name, attack] of attacks) {
    assert.throws(
      () => parseAndValidatePlaidPaymentBatchManifestText(attack),
      /Duplicate JSON object key/,
      name,
    );
  }
});

test("raw manifest parser treats unique object-key reorder as cosmetic", async () => {
  const matrix = JSON.parse(await rawManifest());
  const reordered = Object.fromEntries(Object.entries(matrix).reverse());
  assert.doesNotThrow(() =>
    parseAndValidatePlaidPaymentBatchManifestText(JSON.stringify(reordered)),
  );
});
