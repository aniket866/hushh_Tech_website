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
import {
  AI_RUNTIME_BATCH_CANDIDATE_SLUGS,
  AI_RUNTIME_BATCH_CANDIDATE_STATE,
} from "../src/handlers/ai-runtime-batch.js";
import { GCP_READ_BATCH_SLUGS } from "../src/handlers/gcp-read-batch.js";
import { validateAiRuntimeBatchCandidateManifest } from "../../../scripts/gcp/migration/validate-ai-runtime-batch-candidates.mjs";
import { validateGcpReadBatchCandidateMatrix } from "../../../scripts/gcp/migration/validate-gcp-read-batch-candidates.mjs";
import {
  SERVICE_COLUMN_PRIVILEGE_ALLOWLISTS,
  SERVICE_SEQUENCE_PRIVILEGE_ALLOWLISTS,
  SERVICE_TABLE_PRIVILEGE_ALLOWLISTS,
} from "../src/table-privileges.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(root, "../..");
const registryOnly = process.argv.includes("--registry-only");

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
assert.deepEqual(
  retired.map(({ slug }) => slug),
  ["get-secrets"],
);
assert.equal(frozen.length, 111);
assert.equal(replacementCandidates.length, 111);
assert.deepEqual(
  LEGACY_FUNCTIONS.filter(
    ({ migration_state }) => migration_state === "PORTED_AND_VERIFIED",
  ).map(({ slug }) => slug),
  ["hushh-location-geocode"],
);
assert.deepEqual(Object.keys(FUNCTION_CONTRACTS).sort(), [
  "chat-check-access",
  "fund-payment-admin-analytics",
  "fund-payment-admin-overview",
  "fund-payment-admin-overview-list",
  "fund-payment-admin-overview-metrics",
  "generate-investor-profile",
  "get-locations",
  "hushh-location-geocode",
  "investor-og-image",
  "nda-admin-fetch",
  "stock-quotes",
]);
const candidateMatrix = JSON.parse(
  await readFile(resolve(root, "registry/candidates.gcp-read-batch.v1.json"), "utf8"),
);
const currentBundleEvidence = JSON.parse(
  await readFile(resolve(repositoryRoot, candidateMatrix.source_evidence.path), "utf8"),
);
const candidateSourceFiles = Object.fromEntries(
  await Promise.all(
    candidateMatrix.functions.map(async ({ slug, source_path }) => [
      slug,
      await readFile(resolve(repositoryRoot, source_path), "utf8"),
    ]),
  ),
);
validateGcpReadBatchCandidateMatrix({
  matrix: candidateMatrix,
  currentEvidence: currentBundleEvidence,
  sourceFiles: candidateSourceFiles,
});
assert.equal(candidateMatrix.deployment_state, "DEFAULT_OFF");
assert.equal(candidateMatrix.required_registry_state, "INVENTORY_FROZEN");
assert.deepEqual(
  candidateMatrix.functions.map(({ slug }) => slug).sort(),
  [...GCP_READ_BATCH_SLUGS],
);
assert.equal(
  candidateMatrix.functions.every(
    ({ source_sha256, live_bundle_sha256, blockers }) =>
      /^[a-f0-9]{64}$/.test(source_sha256) &&
      /^[a-f0-9]{64}$/.test(live_bundle_sha256) &&
      Array.isArray(blockers) &&
      blockers.length > 0,
  ),
  true,
);
const registryBySlug = new Map(LEGACY_FUNCTIONS.map((entry) => [entry.slug, entry]));
for (const slug of GCP_READ_BATCH_SLUGS) {
  assert.equal(registryBySlug.get(slug)?.migration_state, "INVENTORY_FROZEN");
}
const aiRuntimeCandidateMatrix = await validateAiRuntimeBatchCandidateManifest({
  repoRoot: repositoryRoot,
  verifyGitRecovery: false,
});
assert.equal(AI_RUNTIME_BATCH_CANDIDATE_STATE, "INVENTORY_FROZEN_DEFAULT_OFF");
assert.deepEqual(
  aiRuntimeCandidateMatrix.functions.map(({ slug }) => slug),
  [...AI_RUNTIME_BATCH_CANDIDATE_SLUGS],
);
for (const slug of AI_RUNTIME_BATCH_CANDIDATE_SLUGS) {
  assert.equal(registryBySlug.get(slug)?.migration_state, "INVENTORY_FROZEN");
}
assert.equal(Object.keys(SERVICE_TABLE_PRIVILEGE_ALLOWLISTS).length, 7);
assert.equal(
  Object.values(SERVICE_TABLE_PRIVILEGE_ALLOWLISTS).every(
    (privileges) => privileges.length === 0,
  ),
  true,
);
assert.equal(
  Object.values(SERVICE_SEQUENCE_PRIVILEGE_ALLOWLISTS).every(
    (privileges) => privileges.length === 0,
  ),
  true,
);
assert.deepEqual(
  SERVICE_COLUMN_PRIVILEGE_ALLOWLISTS["engagement-api-worker"],
  [
    "public.nda_signatures.id:SELECT",
    "public.nda_signatures.nda_version:SELECT",
    "public.nda_signatures.pdf_url:SELECT",
    "public.nda_signatures.signed_at:SELECT",
    "public.nda_signatures.user_id:SELECT",
  ],
);
for (const [owner, privileges] of Object.entries(
  SERVICE_COLUMN_PRIVILEGE_ALLOWLISTS,
)) {
  if (owner !== "engagement-api-worker") assert.deepEqual(privileges, []);
}

if (!registryOnly) {
  const packageJson = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    "@google-cloud/cloud-sql-connector",
    "express",
    "firebase-admin",
    "google-auth-library",
    "pg",
  ]);
  assert.deepEqual(packageJson.overrides, { uuid: "11.1.1" });

  const dockerfile = await readFile(resolve(root, "Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /^ARG\s+.*PLATFORM/m);
  assert.match(
    dockerfile,
    /^FROM --platform=linux\/amd64 node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS production$/m,
  );

  const scanTargets = [
    ...(await filesUnder(resolve(root, "src"))),
    ...(await filesUnder(resolve(root, "smoke"))),
    resolve(root, "registry/functions.v1.json"),
    resolve(root, "registry/candidates.gcp-read-batch.v1.json"),
    resolve(root, "package.json"),
    resolve(root, "Dockerfile"),
  ];
  const forbiddenPatterns = [
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
    ported_and_verified_count: 1,
    replacement_candidate_count: replacementCandidates.length,
    mode: registryOnly ? "registry" : "full",
  }),
);
