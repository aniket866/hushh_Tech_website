import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  digestCanonicalRecords,
  digestOrchestrationEvidence,
  readFunctionEvidenceOrchestrationInputs,
  validateFunctionEvidenceOrchestration,
} from "../scripts/ci/check-supabase-function-evidence-orchestration.mjs";
import { digestTrafficEvidence } from "../scripts/ci/generate-supabase-function-traffic-evidence.mjs";
import {
  digestCurrentEvidence,
  digestCurrentMetadata,
  digestCurrentSourceTree,
} from "../scripts/ci/generate-supabase-current-function-bundle-evidence.mjs";

type Inputs = ReturnType<typeof readFunctionEvidenceOrchestrationInputs>;

const root = process.cwd();
const baseInputs = readFunctionEvidenceOrchestrationInputs({ root });
const cloneInputs = (): Inputs => ({
  contractBytes: Buffer.from(baseInputs.contractBytes),
  artifacts: Object.fromEntries(
    Object.entries(baseInputs.artifacts).map(([key, value]) => [key, Buffer.from(value)])
  ),
  validators: Object.fromEntries(
    Object.entries(baseInputs.validators).map(([key, value]) => [key, Buffer.from(value)])
  ),
});
const parse = <T = Record<string, unknown>>(bytes: Buffer): T =>
  JSON.parse(bytes.toString("utf8"));
const serialize = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = (value: Buffer | string) =>
  crypto.createHash("sha256").update(value).digest("hex");
const refreshContract = (contract: any) => {
  contract.evidence_digest.digest = digestOrchestrationEvidence(contract);
};
const refreshCurrentEvidence = (evidence: any) => {
  evidence.current_metadata_digest.digest = digestCurrentMetadata(evidence.entries);
  evidence.canonical_source_tree.digest = digestCurrentSourceTree(evidence.entries);
  evidence.evidence_digest.digest = digestCurrentEvidence(evidence);
};
const currentVersionDigest = (entries: any[]) =>
  digestCanonicalRecords(
    entries.map((entry) => [
      entry.slug,
      entry.function_id,
      String(entry.verify_jwt),
      String(entry.manifest_version),
      String(entry.current_version),
      String(entry.version_delta),
      entry.capture_status,
    ])
  );
const identityAuthDigest = (functions: any[]) =>
  digestCanonicalRecords(
    functions.map((entry) => [
      entry.source.slug,
      entry.source.function_id,
      String(entry.source.verify_jwt),
    ])
  );
const activeInventoryDigest = (functions: any[]) =>
  sha256(
    `${functions
      .map((entry) => `${entry.source.slug}:${entry.source.function_id}`)
      .sort()
      .join("\n")}\n`
  );

describe("Supabase function evidence orchestration", () => {
  it("accepts only the exact local composition of both frozen upstream captures", () => {
    const result = validateFunctionEvidenceOrchestration(cloneInputs());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.observed).toMatchObject({
      active_functions: 112,
      frozen_functions: 112,
      verify_jwt_true: 62,
      verify_jwt_false: 50,
      traffic_version_delta_histogram: { 0: 16, 40: 96 },
      current_version_delta_histogram: { 0: 16, 43: 96 },
      shared_exact_functions: 16,
      shared_drift_functions: 96,
      traffic_source_blockers: 17,
      current_provider_500_retrieval_failures: 16,
      classification: "CONTINUOUS_VERSION_DRIFT_OBSERVED_BETWEEN_FROZEN_CAPTURES",
    });
  });

  it("rejects a byte-only upstream artifact change even when parsed evidence is unchanged", () => {
    const inputs = cloneInputs();
    inputs.artifacts.traffic_evidence = Buffer.concat([
      inputs.artifacts.traffic_evidence,
      Buffer.from(" "),
    ]);

    const result = validateFunctionEvidenceOrchestration(inputs);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "upstream_file_bindings.traffic_evidence digest does not match the exact upstream file"
    );
  });

  it("rejects a changed upstream validator even though all evidence bytes are untouched", () => {
    const inputs = cloneInputs();
    inputs.validators.traffic_validator = Buffer.concat([
      inputs.validators.traffic_validator,
      Buffer.from("\n"),
    ]);

    const result = validateFunctionEvidenceOrchestration(inputs);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "upstream_validator_bindings.traffic_validator digest does not match the exact upstream file"
    );
  });

  it("rejects a paired current-artifact and contract forgery after both self-digests are refreshed", () => {
    const inputs = cloneInputs();
    const current = parse<any>(inputs.artifacts.current_bundle_evidence);
    const contract = parse<any>(inputs.contractBytes);
    const failed = current.entries.find(
      (entry: any) => entry.capture_status === "BUNDLE_RETRIEVAL_FAILED"
    );
    failed.retrieval_failure.http_status = 501;
    refreshCurrentEvidence(current);
    inputs.artifacts.current_bundle_evidence = serialize(current);
    contract.upstream_file_bindings.current_bundle_evidence.sha256 = sha256(
      inputs.artifacts.current_bundle_evidence
    );
    contract.semantic_digest_bindings.current_evidence_digest =
      current.evidence_digest.digest;
    refreshContract(contract);
    inputs.contractBytes = serialize(contract);

    const result = validateFunctionEvidenceOrchestration(inputs);
    const errors = result.errors.join("\n");

    expect(result.valid).toBe(false);
    expect(errors).toContain("changed from the frozen in-code lock");
    expect(errors).toContain("terminal provider-500 retrieval failures");
  });

  it("rejects a triad manifest-current-contract identity forgery", () => {
    const inputs = cloneInputs();
    const manifest = parse<any>(inputs.artifacts.retirement_manifest);
    const current = parse<any>(inputs.artifacts.current_bundle_evidence);
    const contract = parse<any>(inputs.contractBytes);
    const manifestEntry = manifest.functions[0];
    const currentEntry = current.entries.find(
      (entry: any) => entry.slug === manifestEntry.source.slug
    );
    const forgedId = "00000000-0000-4000-8000-000000000000";
    manifestEntry.source.function_id = forgedId;
    currentEntry.function_id = forgedId;
    manifest.inventory_digests.active_functions = activeInventoryDigest(manifest.functions);
    refreshCurrentEvidence(current);
    inputs.artifacts.retirement_manifest = serialize(manifest);
    inputs.artifacts.current_bundle_evidence = serialize(current);
    contract.upstream_file_bindings.retirement_manifest.sha256 = sha256(
      inputs.artifacts.retirement_manifest
    );
    contract.upstream_file_bindings.current_bundle_evidence.sha256 = sha256(
      inputs.artifacts.current_bundle_evidence
    );
    contract.inventory_binding.function_identity_auth_digest = identityAuthDigest(
      manifest.functions
    );
    contract.semantic_digest_bindings.active_function_inventory_digest =
      manifest.inventory_digests.active_functions;
    contract.semantic_digest_bindings.current_evidence_digest =
      current.evidence_digest.digest;
    contract.snapshot_comparison.current_bundle_snapshot.current_metadata_digest =
      current.current_metadata_digest.digest;
    contract.snapshot_comparison.current_bundle_snapshot.current_source_tree_digest =
      current.canonical_source_tree.digest;
    contract.snapshot_comparison.current_bundle_snapshot.entry_version_digest =
      currentVersionDigest(current.entries);
    refreshContract(contract);
    inputs.contractBytes = serialize(contract);

    const result = validateFunctionEvidenceOrchestration(inputs);
    const errors = result.errors.join("\n");

    expect(result.valid).toBe(false);
    expect(errors).toContain("changed from the frozen in-code lock");
    expect(errors).toContain("active_functions inventory digest changed");
  });

  it("rejects a stale or reversed later snapshot even when the contract timestamp follows it", () => {
    const inputs = cloneInputs();
    const current = parse<any>(inputs.artifacts.current_bundle_evidence);
    const contract = parse<any>(inputs.contractBytes);
    current.capture.capture_started_at_utc = "2026-08-21T16:20:00.000Z";
    refreshCurrentEvidence(current);
    inputs.artifacts.current_bundle_evidence = serialize(current);
    contract.upstream_file_bindings.current_bundle_evidence.sha256 = sha256(
      inputs.artifacts.current_bundle_evidence
    );
    contract.capture_bindings.current_bundle_capture_started_at_utc =
      current.capture.capture_started_at_utc;
    contract.semantic_digest_bindings.current_evidence_digest =
      current.evidence_digest.digest;
    refreshContract(contract);
    inputs.contractBytes = serialize(contract);

    const result = validateFunctionEvidenceOrchestration(inputs);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "Frozen capture order must be window end = deployment observation < traffic capture < current capture start"
    );
  });

  it("rejects a coordinated +44 histogram in place of the exact later +43 snapshot", () => {
    const inputs = cloneInputs();
    const current = parse<any>(inputs.artifacts.current_bundle_evidence);
    const contract = parse<any>(inputs.contractBytes);
    for (const entry of current.entries) {
      if (entry.version_delta !== 0) {
        entry.current_version += 1;
        entry.version_delta += 1;
      }
    }
    current.observed_counts.version_uniform_drift_delta = 44;
    current.observed_counts.version_uniform_drift_count = 96;
    current.cutover_assessment.frozen_snapshot_uniform_version_delta = 44;
    refreshCurrentEvidence(current);
    inputs.artifacts.current_bundle_evidence = serialize(current);
    contract.upstream_file_bindings.current_bundle_evidence.sha256 = sha256(
      inputs.artifacts.current_bundle_evidence
    );
    contract.snapshot_comparison.current_bundle_snapshot.version_delta_histogram = {
      0: 16,
      44: 96,
    };
    contract.snapshot_comparison.current_bundle_snapshot.current_metadata_digest =
      current.current_metadata_digest.digest;
    contract.snapshot_comparison.current_bundle_snapshot.current_source_tree_digest =
      current.canonical_source_tree.digest;
    contract.snapshot_comparison.current_bundle_snapshot.entry_version_digest =
      currentVersionDigest(current.entries);
    contract.semantic_digest_bindings.current_evidence_digest =
      current.evidence_digest.digest;
    refreshContract(contract);
    inputs.contractBytes = serialize(contract);

    const result = validateFunctionEvidenceOrchestration(inputs);
    const errors = result.errors.join("\n");

    expect(result.valid).toBe(false);
    expect(errors).toContain("Version histograms must remain +40 at traffic time and +43");
    expect(errors).toContain("Continuous drift classification is not supported");
  });

  it("rejects a missing function even if another count field is edited", () => {
    const inputs = cloneInputs();
    const traffic = parse<any>(inputs.artifacts.traffic_evidence);
    traffic.entries.pop();
    traffic.expected_counts.active_functions = 111;
    traffic.evidence_digest.digest = digestTrafficEvidence(traffic);
    inputs.artifacts.traffic_evidence = serialize(traffic);

    const result = validateFunctionEvidenceOrchestration(inputs);
    const errors = result.errors.join("\n");

    expect(result.valid).toBe(false);
    expect(errors).toContain("do not contain the same 112 function slugs");
    expect(errors).toContain("Traffic validator");
  });

  it("rejects any changed function auth flag despite refreshed current self-digests", () => {
    const inputs = cloneInputs();
    const current = parse<any>(inputs.artifacts.current_bundle_evidence);
    current.entries[0].verify_jwt = !current.entries[0].verify_jwt;
    refreshCurrentEvidence(current);
    inputs.artifacts.current_bundle_evidence = serialize(current);

    const result = validateFunctionEvidenceOrchestration(inputs);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "Current metadata does not preserve all 112 function IDs and auth flags"
    );
  });

  it("rejects a source-SHA or deployment-cause claim added to the hash-only contract", () => {
    const inputs = cloneInputs();
    const contract = parse<any>(inputs.contractBytes);
    contract.snapshot_comparison.source_revision_claim = "unproven-sha";
    contract.snapshot_comparison.deployment_cause_claim = "unproven-cause";
    refreshContract(contract);
    inputs.contractBytes = serialize(contract);

    const result = validateFunctionEvidenceOrchestration(inputs);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "Cross-snapshot classification exceeds or changes the two-snapshot evidence"
    );
  });

  it("rejects any function reclassified as ported while the cutover is frozen", () => {
    const inputs = cloneInputs();
    const manifest = parse<any>(inputs.artifacts.retirement_manifest);
    manifest.functions[0].migration_state = "PORTED_AND_VERIFIED";
    inputs.artifacts.retirement_manifest = serialize(manifest);

    const result = validateFunctionEvidenceOrchestration(inputs);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "All 112 functions must remain frozen and unported"
    );
  });

  it("rejects reducing the 17 traffic source blockers", () => {
    const inputs = cloneInputs();
    const traffic = parse<any>(inputs.artifacts.traffic_evidence);
    const blocker = traffic.entries.find((entry: any) =>
      String(entry.source_reconstruction_status).startsWith("CUTOVER_BLOCKING_")
    );
    blocker.source_reconstruction_status = "SOURCE_EVIDENCE_AVAILABLE";
    traffic.expected_counts.cutover_blocking_source_contracts = 16;
    traffic.evidence_digest.digest = digestTrafficEvidence(traffic);
    inputs.artifacts.traffic_evidence = serialize(traffic);

    const result = validateFunctionEvidenceOrchestration(inputs);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "The 17 traffic blockers, 16 provider failures, and cutover block must remain exact"
    );
  });

  it("rejects changing any of the 16 terminal provider-500 failures", () => {
    const inputs = cloneInputs();
    const current = parse<any>(inputs.artifacts.current_bundle_evidence);
    const failed = current.entries.find(
      (entry: any) => entry.capture_status === "BUNDLE_RETRIEVAL_FAILED"
    );
    failed.retrieval_failure.provider_error_code = "DifferentProviderError";
    refreshCurrentEvidence(current);
    inputs.artifacts.current_bundle_evidence = serialize(current);

    const result = validateFunctionEvidenceOrchestration(inputs);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "Current bundle failures must remain terminal provider-500 retrieval failures"
    );
  });

  it("leaves all upstream evidence files byte-identical to their signed heads", () => {
    const expected = {
      "migration/evidence/supabase-function-traffic-30d.v1.json":
        "5db78b99f880423c88528817ca422ab862aa1a42f93699e37b0e4ce03fc90ac0",
      "migration/evidence/supabase-current-live-function-bundles.v2.json":
        "54d9535f80d3954902da8f99cf84c46609cd7d971d6344c16704bad5e0963703",
    };
    for (const [relativePath, digest] of Object.entries(expected)) {
      expect(sha256(fs.readFileSync(path.join(root, relativePath)))).toBe(digest);
    }
  });
});
