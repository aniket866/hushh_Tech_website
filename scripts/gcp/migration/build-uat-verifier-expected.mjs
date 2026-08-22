#!/usr/bin/env node

import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalJson } from "./canonical-hash.mjs";
import {
  RETAINED_UAT_IDENTITY_EVIDENCE,
  RETAINED_UAT_SOURCE_MANIFEST_SHA256,
  UAT_TARGET,
  deriveUatIdentityEvidence,
  validateSourceCaptureManifest,
  validateUatIdentityArtifact,
} from "./uat-schema-data-executor.mjs";
import {
  loadRetainedUatSourceKeyManifest,
  validateUatSourceKeyManifest,
} from "./uat-source-key-manifest.mjs";

export const PRE_APPLY_CATALOG_EVIDENCE_SHA256 =
  "ba52ac25a77276fe47046ea8eca69344b75e4b10e1a08d6f235561fa4224431c";
export const REPLAY_KEY_SHA256 =
  "23c656b86552921f356dfc65d7021c6a588277e500be8e35fdcc89a325eb4a86";

export function buildUatVerifierExpected({ sourceManifest, identityArtifact }) {
  const source = validateSourceCaptureManifest(sourceManifest, RETAINED_UAT_SOURCE_MANIFEST_SHA256);
  validateUatIdentityArtifact(identityArtifact, RETAINED_UAT_IDENTITY_EVIDENCE);
  const sourceKeys = loadRetainedUatSourceKeyManifest();
  validateUatSourceKeyManifest(sourceKeys, sourceManifest);
  const replayKey = canonicalHash({
    catalogEvidenceSha256: PRE_APPLY_CATALOG_EVIDENCE_SHA256,
    sourceManifestSha256: source.manifestSha256,
    identityArtifactSha256: identityArtifact.artifactSha256,
    target: UAT_TARGET,
  });
  if (replayKey !== REPLAY_KEY_SHA256) throw new Error("VERIFIER_REPLAY_KEY_MISMATCH");
  const payload = {
    version: 1,
    kind: "HUSHH_TECH_UAT_SCHEMA_DATA_VERIFIER_INPUT",
    target: UAT_TARGET,
    preApplyCatalogEvidenceSha256: PRE_APPLY_CATALOG_EVIDENCE_SHA256,
    replayKey,
    sourceManifest,
    sourceKeys,
    identity: deriveUatIdentityEvidence(identityArtifact),
    expectedCatalog: {
      publicTables: 70,
      publicSequences: 0,
      forcedRlsTables: 70,
      publicPolicies: 280,
      operationalPolicies: 19,
      executorPolicies: 0,
      publicTriggers: 24,
      explicitIndexes: 121,
      triggerFunctions: 8,
      identityFunctions: 2,
      migrationFunctions: 1,
      reviewedExtensions: 3,
    },
    expectedIdentity: {
      total: 369,
      active: 369,
      unclaimed: 0,
      foreignKeys: 37,
      referencedRows: 2363,
    },
    expectedAccess: {
      engagementNdaAdminFetch: {
        role: "hushh-tech-engagement-api-uat@hushh-tech-uat.iam",
        table: "public.nda_signatures",
        selectColumns: ["id", "user_id", "signed_at", "nda_version", "pdf_url"],
        rlsPolicy: "nda_signatures_engagement_api_select",
        rlsClaimSetting: "app.firebase_fund_admin",
        rlsClaimValue: "true",
        tableWideSelect: false,
        publicDml: false,
        elevatedPrivileges: false,
        expectedTotalPublicPolicies: 281,
      },
    },
  };
  return Object.freeze({ ...payload, expectedSha256: canonicalHash(payload) });
}

function parseArgs(argv) {
  const args = Object.fromEntries(argv.map((value) => {
    const match = /^--([a-z-]+)=(.+)$/.exec(value);
    if (!match) throw new Error("VERIFIER_EXPECTED_ARGUMENT_INVALID");
    return [match[1], match[2]];
  }));
  for (const name of ["source-manifest", "identity-artifact", "output"]) {
    if (!isAbsolute(args[name] ?? "")) throw new Error("VERIFIER_EXPECTED_PATH_INVALID");
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceInput = JSON.parse(readFileSync(resolve(args["source-manifest"]), "utf8"));
  const expected = buildUatVerifierExpected({
    sourceManifest: sourceInput.sourceManifest ?? sourceInput,
    identityArtifact: JSON.parse(readFileSync(resolve(args["identity-artifact"]), "utf8")),
  });
  const output = resolve(args.output);
  const fd = openSync(output, "wx", 0o644);
  try {
    writeFileSync(fd, `${canonicalJson(expected)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  process.stdout.write(`${JSON.stringify({ status: "CAPTURED", output, expectedSha256: expected.expectedSha256, sourceManifestSha256: expected.sourceManifest.manifestSha256, identityMappingSha256: expected.identity.mappingSha256 })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    const blocker = /^[A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "VERIFIER_EXPECTED_BUILD_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "BLOCKED", blocker })}\n`);
    process.exitCode = 1;
  }
}
