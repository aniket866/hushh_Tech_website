#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH =
  "cloud-run/hushh-tech-app-services/registry/candidates.github-devops-notify.v1.json";
const EXPECTED_DOCUMENT_DIGEST =
  "a2647d58a80b818a7b31cc2baf0b11fafea833982944d2e23c0d2819d72630f7";
const AUTHORITATIVE_BLOCKERS = Object.freeze([
  "SOURCE_BUNDLE_VERSION_UNBOUND",
  "SOURCE_METADATA_END_CHECK_MISSING",
  "SOURCE_REVISION_UNPROVEN",
  "SOURCE_VERSION_DRIFT",
  "TARGET_CONTRACT_MISSING",
  "TARGET_REGISTRY_NOT_ENABLED",
]);

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rejectDuplicateJsonObjectKeys(rawText) {
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
    if (rawText[cursor] === "{") parseObject();
    else if (rawText[cursor] === "[") parseArray();
    else if (rawText[cursor] === '"') parseString();
    else parsePrimitive();
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

export function parseAndValidateGithubDevopsNotifyManifest(rawText) {
  assert.equal(typeof rawText, "string");
  rejectDuplicateJsonObjectKeys(rawText);
  const document = JSON.parse(rawText);
  assert.equal(
    sha256(stableJson(document)),
    EXPECTED_DOCUMENT_DIGEST,
    "GitHub notify candidate manifest canonical digest drift",
  );
  return document;
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

export async function validateGithubDevopsNotifyCandidate({ repoRoot }) {
  const root = path.resolve(repoRoot);
  const rawManifest = await readFile(path.join(root, MANIFEST_PATH), "utf8");
  const manifest = parseAndValidateGithubDevopsNotifyManifest(rawManifest);

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.deployment_state, "DEFAULT_OFF");
  assert.equal(manifest.required_registry_state, "INVENTORY_FROZEN");
  assert.equal(manifest.target_project, "hushh-tech-uat");
  assert.equal(manifest.target_region, "us-central1");
  assert.equal(manifest.target_auth, "provider_signature_raw_body");
  assert.equal(manifest.cors_policy, "forbidden");
  assert.equal(manifest.cache_policy, "private, no-store");
  assert.deepEqual(manifest.repository_allowlist, [
    "hushh-labs/hushh_Tech_website",
  ]);
  assert.deepEqual(manifest.base_branch_allowlist, ["main"]);
  assert.deepEqual(
    manifest.blockers.slice(0, 6).map(({ code }) => code),
    AUTHORITATIVE_BLOCKERS,
  );

  for (const source of manifest.source_files) {
    const bytes = await readFile(path.join(root, source.path));
    assert.equal(bytes.length, source.bytes, `${source.path}: byte drift`);
    assert.equal(sha256(bytes), source.sha256, `${source.path}: SHA-256 drift`);
  }

  const livePath = "migration/evidence/supabase-current-live-function-bundles.v2.json";
  const trafficPath = "migration/evidence/supabase-function-traffic-30d.v1.json";
  const terminalPath = "migration/evidence/edge-function-terminal-matrix.v1.json";
  const [liveBytes, trafficBytes, terminalBytes] = await Promise.all([
    readFile(path.join(root, livePath)),
    readFile(path.join(root, trafficPath)),
    readFile(path.join(root, terminalPath)),
  ]);
  const live = JSON.parse(liveBytes);
  const traffic = JSON.parse(trafficBytes);
  const terminal = JSON.parse(terminalBytes);
  assert.equal(sha256(liveBytes), manifest.source_evidence.source_evidence_file_sha256);
  assert.equal(sha256(trafficBytes), manifest.source_evidence.traffic_evidence_file_sha256);
  assert.equal(sha256(terminalBytes), manifest.source_evidence.terminal_matrix_file_sha256);
  assert.equal(live.evidence_digest.digest, manifest.source_evidence.source_evidence_digest);
  assert.equal(live.canonical_source_tree.digest, manifest.source_evidence.canonical_source_tree_digest);
  assert.equal(live.current_metadata_digest.digest, manifest.source_evidence.current_metadata_digest);
  assert.equal(traffic.evidence_digest.digest, manifest.source_evidence.traffic_evidence_digest);
  assert.equal(traffic.deployment_capture.normalized_digest, manifest.source_evidence.deployment_inventory_digest);
  assert.equal(terminal.evidence_digest, manifest.source_evidence.terminal_matrix_evidence_digest);

  const liveRow = live.entries.find(({ slug }) => slug === manifest.slug);
  const trafficRow = traffic.entries.find(({ slug }) => slug === manifest.slug);
  const terminalRow = terminal.entries.find(({ slug }) => slug === manifest.slug);
  assert.deepEqual(
    {
      function_id: liveRow.function_id,
      manifest_version: liveRow.manifest_version,
      current_version: liveRow.current_version,
      version_delta: liveRow.version_delta,
      verify_jwt: liveRow.verify_jwt,
      provider_bundle_digest: liveRow.provider_bundle_digest,
      live_bundle_sha256: liveRow.bundle_evidence.canonical_digest,
      file_count: liveRow.bundle_evidence.file_count,
      total_bytes: liveRow.bundle_evidence.total_bytes,
      deployment_binding_sha256: trafficRow.deployment_binding_sha256,
    },
    manifest.source,
  );
  assert.deepEqual(
    {
      request_count: trafficRow.request_count,
      post: trafficRow.method_counts.POST,
      status_2xx: trafficRow.status_class_counts.status_2xx,
      status_4xx: trafficRow.status_class_counts.status_4xx,
      jwt_present: trafficRow.auth_marker_counts.authorization_jwt_marker_present,
      jwt_absent: trafficRow.auth_marker_counts.authorization_jwt_marker_absent,
    },
    manifest.traffic_30d,
  );
  assert.deepEqual(terminalRow.blockers, manifest.blockers.slice(0, 6));
  assert.equal(terminalRow.target.contract_digest, null);
  assert.equal(terminalRow.target.live_evidence_digest, null);

  const registry = await readJson(
    root,
    "cloud-run/hushh-tech-app-services/registry/functions.v1.json",
  );
  assert.deepEqual(
    registry.find(({ slug }) => slug === manifest.slug),
    {
      slug: manifest.slug,
      owner_group: manifest.target_owner_group,
      auth_mode: manifest.target_auth,
      migration_state: "INVENTORY_FROZEN",
      final_disposition: "PORT_TO_GCP",
    },
  );
  for (const [relativePath, expected] of Object.entries(manifest.runtime_byte_lock)) {
    assert.equal(
      sha256(await readFile(path.join(root, relativePath))),
      expected,
      `${relativePath}: runtime byte drift`,
    );
  }
  const runtimeFiles = [
    "cloud-run/hushh-tech-app-services/src/runtime-handlers.js",
    "cloud-run/hushh-tech-app-services/src/app.js",
    "server.js",
  ];
  for (const relativePath of runtimeFiles) {
    const runtimeSource = await readFile(path.join(root, relativePath), "utf8");
    assert.equal(
      runtimeSource.includes("github-devops-notify.js"),
      false,
      `${relativePath}: detached candidate became runtime reachable`,
    );
  }
  return Object.freeze({ slug: manifest.slug, frozen: true, wired: false });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repoRoot = process.argv[2] ?? process.cwd();
  validateGithubDevopsNotifyCandidate({ repoRoot })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "validation failed"}\n`);
      process.exitCode = 1;
    });
}
