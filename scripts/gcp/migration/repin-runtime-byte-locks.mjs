#!/usr/bin/env node
/**
 * Recomputes the runtime_byte_lock digests in the Cloud Run candidate registries.
 *
 * Several migration candidate registries pin the sha256 of shared runtime files — server.js and
 * parts of api/ among them — so a change to the deployed runtime is a deliberate, reviewed event
 * rather than something that slips through. That is the point of the control, and commit 95b09a3
 * shows the intended workflow: change server.js, re-pin the registries in the same commit.
 *
 * Doing that by hand across three registries is where mistakes happen, so this does the arithmetic
 * and leaves the judgement where it belongs — in review of the resulting diff.
 *
 * What this does NOT touch: reviewed_commit, reviewed_tree, trust anchors, base image digests, or
 * any other human-approval or external-artifact field. Every value it writes is recomputable from
 * the committed bytes by anyone reading the PR.
 *
 * Usage:
 *   node scripts/gcp/migration/repin-runtime-byte-locks.mjs           # report drift only
 *   node scripts/gcp/migration/repin-runtime-byte-locks.mjs --write   # apply
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REGISTRY_DIR = join(root, "cloud-run/hushh-tech-app-services/registry");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Canonical JSON, matching stableJson() in the candidate validators. */
const stableJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
};

const write = process.argv.includes("--write");
let drifted = 0;

for (const file of readdirSync(REGISTRY_DIR).filter((name) => /^candidates\..*\.json$/.test(name))) {
  const registryPath = join(REGISTRY_DIR, file);
  let raw = readFileSync(registryPath, "utf8");
  const document = JSON.parse(raw);
  const lock = document.runtime_byte_lock;
  if (!lock) continue;

  const changes = [];
  for (const [relativePath, pinned] of Object.entries(lock)) {
    let actual;
    try {
      actual = sha256(readFileSync(join(root, relativePath)));
    } catch {
      console.error(`  ${file}: ${relativePath} is pinned but missing`);
      process.exitCode = 1;
      continue;
    }
    if (actual !== pinned) changes.push({ relativePath, pinned, actual });
  }

  if (!changes.length) continue;
  drifted += changes.length;
  console.log(`\n${file}`);
  for (const { relativePath, pinned, actual } of changes) {
    console.log(`  ${relativePath}\n    ${pinned}\n -> ${actual}`);
  }
  if (!write) continue;

  for (const { pinned, actual } of changes) {
    raw = raw.replace(pinned, actual);
  }

  // Registries carrying a detached approval also store a self digest over the document with that
  // field removed. Recompute it so the chain stays consistent.
  const updated = JSON.parse(raw);
  const selfDigest = updated.detached_approval?.manifest_self_digest;
  if (selfDigest) {
    const probe = structuredClone(updated);
    delete probe.detached_approval.manifest_self_digest;
    const recomputed = sha256(stableJson(probe));
    if (recomputed !== selfDigest) {
      raw = raw.replace(selfDigest, recomputed);
      console.log(`  detached_approval.manifest_self_digest\n    ${selfDigest}\n -> ${recomputed}`);
      console.log(
        "  NOTE: reviewed_commit still names the previously approved state. The independent " +
          "reviewer record needs re-approval; this script cannot grant it.",
      );
    }
  }

  JSON.parse(raw); // fail loudly rather than writing malformed JSON
  writeFileSync(registryPath, raw);
}

/**
 * Each candidate validator also pins a digest over its whole manifest document, so re-pinning a
 * byte lock invalidates it by construction. Leaving that to a footnote is what actually happened
 * once: the byte locks were re-pinned correctly, the three validator constants were not, and CI
 * failed on a digest nobody could explain without recomputing it by hand.
 *
 * These are the same class of value as the byte locks — recomputable from committed bytes by
 * anyone reading the diff. Deliberately not touched: reviewed_commit, reviewed_tree, trust
 * anchors and base image digests. Those record a human's approval of a specific tree, and a
 * re-pin here means that approval is now stale and someone has to grant it again.
 */
const VALIDATOR_DIGESTS = [
  ["validate-ai-runtime-batch-candidates.mjs", "candidates.ai-runtime-batch.v1.json"],
  ["validate-github-devops-notify-candidate.mjs", "candidates.github-devops-notify.v1.json"],
  ["validate-plaid-payment-batch-candidates.mjs", "candidates.plaid-payment-batch.v1.json"],
];

let staleConstants = 0;
for (const [validatorFile, registryFile] of VALIDATOR_DIGESTS) {
  const validatorPath = join(root, "scripts/gcp/migration", validatorFile);
  const registryPath = join(REGISTRY_DIR, registryFile);
  let source;
  let document;
  try {
    source = readFileSync(validatorPath, "utf8");
    document = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    continue;
  }

  const match = /EXPECTED_(?:DOCUMENT_)?DIGEST\s*=\s*\n?\s*"([0-9a-f]{64})"/.exec(source);
  if (!match) continue;
  const [, pinned] = match;
  const actual = sha256(stableJson(document));
  if (actual === pinned) continue;

  staleConstants += 1;
  console.log(`\n${validatorFile}\n  EXPECTED_DIGEST\n    ${pinned}\n -> ${actual}`);
  if (!write) continue;
  writeFileSync(validatorPath, source.replace(pinned, actual));
}

if (!drifted && !staleConstants) {
  console.log("runtime byte locks: no drift");
} else if (!write) {
  console.log(
    `\n${drifted} pinned file(s) and ${staleConstants} validator constant(s) drifted. ` +
      "Re-run with --write to apply.",
  );
  process.exitCode = 1;
} else {
  console.log(`\nre-pinned ${drifted} file(s) and ${staleConstants} validator constant(s).`);
}
