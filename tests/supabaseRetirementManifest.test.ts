import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  validateLiveFunctionBundleEvidence,
  validateManifest,
} from "../scripts/ci/check-supabase-retirement-manifest.mjs";

const manifestPath = path.join(
  process.cwd(),
  "migration",
  "manifests",
  "supabase-retirement.v1.json"
);
const canonicalManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const bundleEvidencePath = path.join(
  process.cwd(),
  "migration",
  "evidence",
  "supabase-live-function-bundles.v1.json"
);
const canonicalBundleEvidence = JSON.parse(fs.readFileSync(bundleEvidencePath, "utf8"));

const cloneManifest = () => structuredClone(canonicalManifest);
const cloneBundleEvidence = () => structuredClone(canonicalBundleEvidence);

const errorText = (manifest: unknown) => validateManifest(manifest).errors.join("\n");

describe("Supabase retirement manifest", () => {
  it("accepts the frozen no-hybrid inventory", () => {
    const result = validateManifest(cloneManifest());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.observed).toMatchObject({
      public_tables: 70,
      active_edge_functions: 112,
      storage_buckets: 6,
      storage_objects: 124,
      storage_bytes: 111078397,
      auth_users: 369,
      secondary_project_references: 6,
    });
  });

  it("binds the sanitized 112-function live bundle capture", () => {
    const result = validateLiveFunctionBundleEvidence(
      cloneManifest(),
      cloneBundleEvidence()
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.observed).toEqual({
      active_functions: 112,
      extracted_bundles: 96,
      store_not_found: 16,
      extracted_files: 445,
      extracted_bytes: 2677504,
      evidence_digest: "182de37b13bfb9201cbe94f1c850e995f15bcdf92d38e08f73449b5cf119ea7b",
      canonical_source_tree_digest:
        "a976749fa43425152fddb2649ba6442500e412627a004f6ff60ca2892b9011a2",
    });
  });

  it("rejects bundle evidence identity, version, and slug drift", () => {
    const evidence = cloneBundleEvidence();
    evidence.entries[0].function_id = "00000000-0000-0000-0000-000000000000";
    evidence.entries[1].version += 1;
    evidence.entries[2].slug = "unknown-function";

    const errors = validateLiveFunctionBundleEvidence(cloneManifest(), evidence).errors.join(
      "\n"
    );
    expect(errors).toContain("function_id must match the retirement manifest");
    expect(errors).toContain("version must match the retirement manifest");
    expect(errors).toContain("contains unknown function unknown-function");
    expect(errors).toContain("entry digest changed");
  });

  it("rejects capture-count drift and unapproved evidence fields", () => {
    const evidence = cloneBundleEvidence();
    const extracted = evidence.entries.find(
      (entry: { capture_status: string }) => entry.capture_status === "EXTRACTED"
    );
    extracted.capture_status = "STORE_NOT_FOUND";
    extracted.store_lookup = { http_status: 404, provider_error_code: "UnknownError" };
    delete extracted.bundle_evidence;
    extracted.raw_source = "must never be committed";

    const errors = validateLiveFunctionBundleEvidence(cloneManifest(), evidence).errors.join(
      "\n"
    );
    expect(errors).toContain("Store-not-found live function bundles must be 16; found 17.");
    expect(errors).toContain("Extracted live function bundles must be 96; found 95.");
    expect(errors).toContain("raw_source");
    expect(errors).toContain("entry digest changed");
  });

  it("keeps newly extracted contracts unported and get-secrets retired", () => {
    const evidence = cloneBundleEvidence();
    const fundList = evidence.entries.find(
      (entry: { slug: string }) => entry.slug === "fund-payment-admin-list"
    );
    const publicMetrics = evidence.entries.find(
      (entry: { slug: string }) => entry.slug === "public-signup-metrics"
    );
    const getSecrets = evidence.entries.find(
      (entry: { slug: string }) => entry.slug === "get-secrets"
    );

    expect(fundList).toMatchObject({
      capture_status: "EXTRACTED",
      source_recovery_mode: "RECONSTRUCT_CONTRACT",
      migration_state: "INVENTORY_FROZEN",
    });
    expect(publicMetrics).toMatchObject({
      capture_status: "EXTRACTED",
      source_recovery_mode: "RECONSTRUCT_CONTRACT",
      migration_state: "INVENTORY_FROZEN",
    });
    expect(getSecrets).toMatchObject({
      capture_status: "STORE_NOT_FOUND",
      final_disposition: "RETIRE_WITH_410",
      migration_state: "INVENTORY_FROZEN",
    });
  });

  it("rejects a missing table even if the JSON remains valid", () => {
    const manifest = cloneManifest();
    manifest.tables.pop();

    expect(errorText(manifest)).toContain("Public table entries must be 70; found 69.");
    expect(errorText(manifest)).toContain("public_tables inventory digest changed");
  });

  it("rejects duplicate function slugs and ids", () => {
    const manifest = cloneManifest();
    manifest.functions.push(structuredClone(manifest.functions[0]));

    const errors = errorText(manifest);
    expect(errors).toContain("Active function entries must be 112; found 113.");
    expect(errors).toContain("Duplicate function slug entries");
    expect(errors).toContain("Duplicate function id entries");
  });

  it("rejects function ownership drift even when the function remains present", () => {
    const manifest = cloneManifest();
    const getLocations = manifest.functions.find(
      (entry: { source: { slug: string } }) => entry.source.slug === "get-locations"
    );
    getLocations.owner_group = "content-api";

    const errors = errorText(manifest);
    expect(errors).toContain("function_ownership inventory digest changed");
    expect(errors).toContain("Function owner counts changed");
  });

  it("rejects recovery-source drift", () => {
    const manifest = cloneManifest();
    const recovered = manifest.functions.find(
      (entry: { source_recovery: { mode: string } }) =>
        entry.source_recovery.mode === "RECOVER_FROM_GIT_HISTORY"
    );
    recovered.source_recovery.mode = "RECONSTRUCT_CONTRACT";
    delete recovered.source_recovery.source_commit;

    const errors = errorText(manifest);
    expect(errors).toContain("function_recovery inventory digest changed");
    expect(errors).toContain("Git-history function sources must be 18; found 17.");
  });

  it("rejects drift in the manifest's live-bundle evidence binding", () => {
    const manifest = cloneManifest();
    manifest.live_function_bundle_evidence.extracted_bundles = 95;

    expect(errorText(manifest)).toContain(
      "live_function_bundle_evidence does not match the locked sanitized bundle evidence contract"
    );
  });

  it("rejects production identity records and a non-terminal Auth count", () => {
    const manifest = cloneManifest();
    manifest.auth_identity_inventory.source_user_count = 368;
    manifest.auth_identity_inventory.emails = ["do-not-commit@example.com"];

    const errors = errorText(manifest);
    expect(errors).toContain("Supabase Auth users must be 369; found 368.");
    expect(errors).toContain("must not check in production PII field emails");
  });

  it("rejects storage byte drift", () => {
    const manifest = cloneManifest();
    manifest.buckets[0].observed_total_bytes += 1;

    expect(errorText(manifest)).toContain(
      "Storage bytes must be 111078397; found 111078398."
    );
  });

  it("rejects an omitted secondary project reference", () => {
    const manifest = cloneManifest();
    manifest.secondary_supabase_references.pop();

    const errors = errorText(manifest);
    expect(errors).toContain("Secondary Supabase project references must be 6; found 5.");
    expect(errors).toContain("secondary_projects inventory digest changed");
  });

  it("keeps get-secrets as the only deliberate 410 retirement", () => {
    const manifest = cloneManifest();
    const getSecrets = manifest.functions.find(
      (entry: { source: { slug: string } }) => entry.source.slug === "get-secrets"
    );
    getSecrets.final_disposition = "PORT_TO_GCP";

    const errors = errorText(manifest);
    expect(errors).toContain("get-secrets must be the single 410 security retirement.");
    expect(errors).toContain("Retired functions must be 1; found 0.");
  });

  it("requires every migration-control field", () => {
    const manifest = cloneManifest();
    manifest.tables[0].rollback_treatment = "";

    expect(errorText(manifest)).toContain(
      "tables[0] is missing required field rollback_treatment."
    );
  });
});
