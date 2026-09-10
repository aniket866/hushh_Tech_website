import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOCKED_RPCS,
  BLOCKED_STORAGE_BUCKETS,
  BLOCKED_TABLES,
  RPC_NAMES,
  STORAGE_BUCKETS,
  TABLE_OPERATIONS,
} from "../../api/shared/gcpDataRuntime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(ROOT, "migration/contracts/supabase-uat-mapping.v1.json");
const EXPECTED_SOURCE_PROJECT_REF_SHA256 =
  "4a3a3ef16e9d073db883c7c0029909e8d1728116e242362c710a22bc4e87d20e";
const SOURCE_ROOT = path.join(ROOT, "src");
const ACTIVE_VALUES = new Set(["YES", "CONDITIONAL"]);

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.includes("staticPosts.generated")) files.push(absolute);
  }
  return files;
}

function sourceText() {
  return walk(SOURCE_ROOT).map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

function matches(text, pattern) {
  return new Set([...text.matchAll(pattern)].map((match) => match[1]));
}

function dependencyKey(type, name) {
  return `${type}:${name}`;
}

function countBy(dependencies, selector) {
  return dependencies.reduce((counts, dependency) => {
    const key = selector(dependency);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

export function verifyManifest({ manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")), text = sourceText() } = {}) {
  const errors = [];
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  const allowedStatuses = new Set(manifest.allowed_statuses ?? []);
  const keys = new Set();

  const sourceProjectRef = String(manifest.source?.project_ref || "");
  if (
    crypto.createHash("sha256").update(sourceProjectRef).digest("hex") !==
    EXPECTED_SOURCE_PROJECT_REF_SHA256
  ) {
    errors.push("source project ref is not the canonical legacy project");
  }
  if (manifest.target?.gcp_project !== "hushh-tech-uat") errors.push("target GCP project is not UAT");
  if (manifest.target?.cloud_run_service !== "hushh-tech-website") errors.push("target Cloud Run service is not hushh-tech-website");
  if (manifest.target?.supabase_runtime_credentials !== false) errors.push("manifest permits Supabase runtime credentials");

  for (const dependency of dependencies) {
    const key = dependencyKey(dependency.source_type, dependency.source_name);
    if (keys.has(key)) errors.push(`duplicate dependency: ${key}`);
    keys.add(key);
    if (!allowedStatuses.has(dependency.status)) errors.push(`invalid status for ${key}: ${dependency.status}`);
    if (
      crypto.createHash("sha256").update(String(dependency.source_project || "")).digest("hex") !==
      EXPECTED_SOURCE_PROJECT_REF_SHA256
    ) {
      errors.push(`wrong source project for ${key}`);
    }
    if (ACTIVE_VALUES.has(dependency.active) && (!dependency.caller?.length || !dependency.verification?.length)) {
      errors.push(`active dependency lacks caller or verification: ${key}`);
    }
    if (dependency.status === "MAPPED_EXISTING_GCP" && (!dependency.target_type || !dependency.target_name)) {
      errors.push(`mapped dependency lacks target: ${key}`);
    }
    if (dependency.target_name && !/^[a-zA-Z0-9_./:-]+$/.test(dependency.target_name)) {
      errors.push(`target name is not a stable identifier: ${key}`);
    }
  }

  const discovered = [
    ["table", matches(text, /(?:\b(?:gcpBackend|gcpBackendClient|this\.gcpBackend)|config\.gcpBackendClient)\s*\.\s*from\(\s*["']([^"']+)["']/g)],
    ["rpc", matches(text, /(?:\b(?:gcpBackend|gcpBackendClient|this\.gcpBackend)|config\.gcpBackendClient)\s*\.\s*rpc\(\s*["']([^"']+)["']/g)],
    ["storage_bucket", matches(text, /(?:\b(?:gcpBackend|gcpBackendClient|this\.gcpBackend)|config\.gcpBackendClient)\s*\.\s*storage\s*\.\s*from\(\s*["']([^"']+)["']/g)],
    ["edge_function", new Set([
      ...matches(text, /\/functions\/v1\/([a-z0-9-]+)/g),
      ...matches(text, /functionUrl\(\s*["']([a-z0-9-]+)["']/g),
    ])],
  ];
  const missing = [];
  for (const [type, names] of discovered) {
    for (const name of names) {
      if (!keys.has(dependencyKey(type, name))) missing.push(dependencyKey(type, name));
    }
  }
  if (missing.length) errors.push(`active source references missing from manifest: ${missing.join(", ")}`);

  for (const name of BLOCKED_TABLES) if (TABLE_OPERATIONS[name]) errors.push(`blocked table remains runtime-enabled: ${name}`);
  for (const name of BLOCKED_RPCS) if (RPC_NAMES.has(name)) errors.push(`blocked RPC remains runtime-enabled: ${name}`);
  for (const name of BLOCKED_STORAGE_BUCKETS) if (STORAGE_BUCKETS.has(name)) errors.push(`blocked storage bucket remains runtime-enabled: ${name}`);

  const active = dependencies.filter((dependency) => ACTIVE_VALUES.has(dependency.active));
  const blocked = active.filter((dependency) => dependency.status.startsWith("BLOCKED") || dependency.status === "READY_TO_MAP");
  const result = {
    errors,
    activeCount: active.length,
    activeBlockedCount: blocked.length,
    activeUnmappedCount: missing.length,
    statusCounts: countBy(active, (dependency) => dependency.status),
    typeCounts: countBy(active, (dependency) => dependency.source_type),
    discovered: Object.fromEntries(discovered.map(([type, names]) => [type, [...names].sort()])),
  };
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyManifest();
  console.log(`ACTIVE_DEPENDENCY_COUNT = ${result.activeCount}`);
  console.log(`ACTIVE_BLOCKED_COUNT = ${result.activeBlockedCount}`);
  console.log(`ACTIVE_UNMAPPED_COUNT = ${result.activeUnmappedCount}`);
  console.log(`STATUS_COUNTS = ${JSON.stringify(result.statusCounts)}`);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("MAPPING_VERIFY = PASS");
  }
}
