import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGACY_FUNCTIONS,
  REGISTRY_METADATA,
  validateRegistry,
} from "../src/registry.js";
import { FUNCTION_CONTRACTS } from "../src/contracts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryOnly = process.argv.includes("--registry-only");
const forbiddenVendor = ["supa", "base"].join("");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

validateRegistry(LEGACY_FUNCTIONS);
assert.equal(REGISTRY_METADATA.count, 112);
assert.equal(LEGACY_FUNCTIONS.length, 112);
assert.equal(new Set(LEGACY_FUNCTIONS.map(({ slug }) => slug)).size, 112);

const retired = LEGACY_FUNCTIONS.filter(
  ({ final_disposition }) => final_disposition === "RETIRE_WITH_410",
);
const frozen = LEGACY_FUNCTIONS.filter(
  ({ migration_state }) => migration_state === "INVENTORY_FROZEN",
);
const replacementCandidates = LEGACY_FUNCTIONS.filter(
  ({ final_disposition }) => final_disposition === "PORT_TO_GCP",
);
assert.deepEqual(retired.map(({ slug }) => slug), ["get-secrets"]);
assert.equal(frozen.length, 112);
assert.equal(replacementCandidates.length, 111);
assert.equal(
  LEGACY_FUNCTIONS.some(
    ({ migration_state }) => migration_state === "PORTED_AND_VERIFIED",
  ),
  false,
);
assert.deepEqual(Object.keys(FUNCTION_CONTRACTS), []);

if (!registryOnly) {
  const packageJson = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(packageJson.dependencies).sort(),
    [
      "@google-cloud/cloud-sql-connector",
      "express",
      "firebase-admin",
      "google-auth-library",
      "pg",
    ],
  );
  assert.deepEqual(packageJson.overrides, { uuid: "11.1.1" });

  const scanTargets = [
    ...(await filesUnder(resolve(root, "src"))),
    resolve(root, "registry/functions.v1.json"),
    resolve(root, "package.json"),
    resolve(root, "Dockerfile"),
  ];
  const forbiddenPatterns = [
    new RegExp(forbiddenVendor, "i"),
    new RegExp(`LEGACY_${forbiddenVendor.toUpperCase()}`, "i"),
    /migration\/manifests/i,
    /VITE_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)/,
  ];
  for (const path of scanTargets) {
    const source = await readFile(path, "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(source),
        false,
        `${relative(root, path)} contains forbidden runtime text: ${pattern}`,
      );
    }
  }
}

console.log(
  JSON.stringify({
    status: "ok",
    registry_count: REGISTRY_METADATA.count,
    registry_digest: REGISTRY_METADATA.digest,
    retired_count: retired.length,
    frozen_unverified_count: frozen.length,
    replacement_candidate_count: replacementCandidates.length,
    mode: registryOnly ? "registry" : "full",
  }),
);
