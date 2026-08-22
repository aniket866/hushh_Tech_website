#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH =
  "cloud-run/hushh-tech-app-services/registry/candidates.github-devops-notify.v1.json";
const SERVICE_PATH = "cloud-run/hushh-tech-app-services";
const SERVICE_SRC_PATH = `${SERVICE_PATH}/src`;
const SERVICE_ENTRYPOINT = `${SERVICE_SRC_PATH}/server.js`;
const CANDIDATE_HANDLER_PATH =
  `${SERVICE_SRC_PATH}/handlers/github-devops-notify.js`;
const TRUST_ANCHOR_PATH =
  `${SERVICE_PATH}/registry/github-devops-notify-approval-trust-anchor.v1.json`;
const EXPECTED_DOCUMENT_DIGEST =
  "f5117c9acc888b850eb7638cdcd80412e7788b5cc285ae074d21c98182053392";
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

function manifestSelfDigest(document) {
  const digestInput = structuredClone(document);
  delete digestInput.detached_approval.manifest_self_digest;
  return sha256(stableJson(digestInput));
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

function repoPath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function lexicalCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function collectRegularFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => lexicalCompare(left.name, right.name))) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRegularFiles(absolutePath)));
      continue;
    }
    assert.equal(
      entry.isFile(),
      true,
      `${absolutePath}: service src inventory contains a non-regular file`,
    );
    files.push(absolutePath);
  }
  return files;
}

function staticImportSpecifiers(source, relativePath) {
  assert.equal(
    /\b(?:import\s*\(|require\s*\()/.test(source),
    false,
    `${relativePath}: dynamic or CommonJS imports are forbidden in the locked graph`,
  );
  const declarations = source.match(/(?:^|\n)\s*import(?=\s)/g) ?? [];
  const exportsFrom =
    source.match(/(?:^|\n)\s*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+/g) ?? [];
  const matches = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"'\r\n]+)["']\s*;?/g,
    /(?:^|\n)\s*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"'\r\n]+)["']\s*;?/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) matches.push(match[1]);
  }
  assert.equal(
    matches.length,
    declarations.length + exportsFrom.length,
    `${relativePath}: unparsed static import in locked graph`,
  );
  return matches.sort();
}

export async function computeServiceExecutableClosure(root) {
  const sourceRoot = path.join(root, SERVICE_SRC_PATH);
  const absoluteFiles = await collectRegularFiles(sourceRoot);
  const inventory = [];
  const sourceByPath = new Map();
  for (const absolutePath of absoluteFiles) {
    const relativePath = repoPath(root, absolutePath);
    const bytes = await readFile(absolutePath);
    inventory.push({
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
    if (path.extname(absolutePath) === ".js") {
      sourceByPath.set(relativePath, bytes.toString("utf8"));
    }
  }
  inventory.sort((left, right) => lexicalCompare(left.path, right.path));
  assert.equal(
    inventory.every(({ path: relativePath }) => relativePath.endsWith(".js")),
    true,
    "Cloud Run service src inventory contains a non-JavaScript file",
  );
  assert.equal(sourceByPath.has(SERVICE_ENTRYPOINT), true, "Cloud Run entrypoint missing");

  const localEdges = new Map();
  for (const [from, source] of sourceByPath) {
    const edges = staticImportSpecifiers(source, from).map((specifier) => {
      if (!specifier.startsWith(".")) {
        return { from, specifier, to: null };
      }
      assert.equal(
        specifier.endsWith(".js"),
        true,
        `${from}: local imports must use an exact .js path`,
      );
      const absoluteTarget = path.resolve(
        root,
        path.dirname(from),
        specifier,
      );
      const target = repoPath(root, absoluteTarget);
      assert.equal(
        target === SERVICE_SRC_PATH || target.startsWith(`${SERVICE_SRC_PATH}/`),
        true,
        `${from}: local import escapes the locked src inventory`,
      );
      assert.equal(
        sourceByPath.has(target),
        true,
        `${from}: local import target ${target} is absent from the locked inventory`,
      );
      return { from, specifier, to: target };
    });
    localEdges.set(from, edges);
  }

  const reachable = new Set([SERVICE_ENTRYPOINT]);
  const pending = [SERVICE_ENTRYPOINT];
  while (pending.length > 0) {
    const from = pending.shift();
    for (const edge of localEdges.get(from) ?? []) {
      if (edge.to === null || reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      pending.push(edge.to);
    }
  }
  assert.equal(
    reachable.has(CANDIDATE_HANDLER_PATH),
    false,
    "detached GitHub notify candidate became transitively runtime reachable",
  );
  const bootReachable = [...reachable].sort();
  const bootEdges = bootReachable
    .flatMap((relativePath) => localEdges.get(relativePath) ?? [])
    .sort((left, right) => lexicalCompare(stableJson(left), stableJson(right)));
  const bootGraph = {
    entrypoint: SERVICE_ENTRYPOINT,
    reachable: bootReachable,
    edges: bootEdges,
  };
  return {
    schema_version: 1,
    entrypoint: SERVICE_ENTRYPOINT,
    candidate_handler: CANDIDATE_HANDLER_PATH,
    src_inventory_digest: sha256(stableJson(inventory)),
    src_inventory: inventory,
    boot_graph_digest: sha256(stableJson(bootGraph)),
    boot_reachable: bootReachable,
    boot_edges: bootEdges,
  };
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
  assert.equal(
    manifest.recipient_group_resource,
    "groups/hushh-tech-devops-notify",
  );
  assert.deepEqual(manifest.base_branch_allowlist, ["main"]);
  assert.deepEqual(manifest.detached_approval, {
    scope: "github-devops-notify-detached-candidate-v1",
    algorithm: "Ed25519",
    key_id: "github-devops-notify-independent-reviewer-v1",
    trust_anchor_state: "UNPROVISIONED",
    trust_anchor_path: TRUST_ANCHOR_PATH,
    trust_anchor_file_sha256:
      "fb0f9ce52de16975f25d3f5dce05e8694efc9e589b9780f87ef0332eb9964bd8",
    handler_path:
      "cloud-run/hushh-tech-app-services/src/handlers/github-devops-notify.js",
    manifest_path: MANIFEST_PATH,
    manifest_self_digest:
      "1fcd0831c9ca5871833720e6a41228c94e94a5f17dc53ca75efdd65b0edff0c7",
    reviewed_commit: "2df49536f5e9c1eff3324f225e33b042eec1dea6",
    reviewed_tree: "10aaac108dd01bea0e240d96137c8860aa1d488b",
  });
  assert.equal(
    manifestSelfDigest(manifest),
    manifest.detached_approval.manifest_self_digest,
    "GitHub notify candidate manifest self digest drift",
  );
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
  const servicePackage = await readJson(
    root,
    "cloud-run/hushh-tech-app-services/package.json",
  );
  assert.equal(
    servicePackage.scripts?.start,
    "node src/server.js",
    "Cloud Run package start entrypoint drift",
  );
  const servicePackageLock = await readJson(
    root,
    `${SERVICE_PATH}/package-lock.json`,
  );
  assert.deepEqual(
    servicePackageLock.packages?.[""]?.dependencies,
    servicePackage.dependencies,
    "Cloud Run package-lock root dependency drift",
  );
  assert.equal(
    servicePackageLock.packages?.[""]?.name,
    servicePackage.name,
    "Cloud Run package-lock root package drift",
  );
  assert.equal(
    servicePackageLock.packages?.[""]?.version,
    servicePackage.version,
    "Cloud Run package-lock root version drift",
  );
  const dockerfile = await readFile(
    path.join(root, `${SERVICE_PATH}/Dockerfile`),
    "utf8",
  );
  assert.deepEqual(
    dockerfile.match(/^[ \t]*CMD[ \t]+.*$/gm),
    ['CMD ["node", "src/server.js"]'],
    "Cloud Run Docker CMD entrypoint drift",
  );
  assert.equal(
    /^[ \t]*ENTRYPOINT\b/m.test(dockerfile),
    false,
    "Cloud Run Docker ENTRYPOINT is forbidden",
  );
  assert.deepEqual(
    manifest.service_executable_closure,
    await computeServiceExecutableClosure(root),
    "Cloud Run executable src inventory or boot graph drift",
  );
  const trustAnchor = await readJson(root, TRUST_ANCHOR_PATH);
  assert.deepEqual(trustAnchor, {
    schema_version: 1,
    provisioning_state: "UNPROVISIONED",
    algorithm: "Ed25519",
    key_id: "github-devops-notify-independent-reviewer-v1",
    public_key_spki_der_base64url: null,
    public_key_sha256: null,
    reviewer_identity: "UNPROVISIONED",
  });
  const runtimeFiles = [
    "cloud-run/hushh-tech-app-services/src/runtime-handlers.js",
    "cloud-run/hushh-tech-app-services/src/app.js",
    "cloud-run/hushh-tech-app-services/src/server.js",
    "server.js",
  ];
  for (const relativePath of runtimeFiles) {
    const runtimeSource = await readFile(path.join(root, relativePath), "utf8");
    assert.equal(
      runtimeSource.includes("github-devops-notify") ||
        runtimeSource.includes("githubDevopsNotify"),
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
