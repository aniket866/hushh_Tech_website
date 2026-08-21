import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  validateFunctionTrafficEvidence,
  validateFunctionTrafficUpstream,
} from "../scripts/ci/check-supabase-function-traffic-evidence.mjs";
import { digestBundleEvidenceEntries } from "../scripts/ci/generate-supabase-live-function-bundle-evidence.mjs";
import {
  digestTrafficEvidence,
  sha256,
} from "../scripts/ci/generate-supabase-function-traffic-evidence.mjs";

const readJson = (relativePath: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), "utf8"));

const canonicalManifest = readJson("migration/manifests/supabase-retirement.v1.json");
const canonicalBundleEvidence = readJson(
  "migration/evidence/supabase-live-function-bundles.v1.json"
);
const canonicalTrafficEvidence = readJson(
  "migration/evidence/supabase-function-traffic-30d.v1.json"
);

const validate = (evidence: unknown) =>
  validateFunctionTrafficEvidence(
    structuredClone(canonicalManifest),
    structuredClone(canonicalBundleEvidence),
    evidence
  );
const errorsFor = (evidence: unknown) => validate(evidence).errors.join("\n");

describe("Supabase Edge Function traffic evidence", () => {
  it("accepts the sanitized, hash-bound 30-day capture", () => {
    const result = validate(structuredClone(canonicalTrafficEvidence));

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.observed).toMatchObject({
      active_functions: 112,
      utc_buckets: 30,
      provider_retention_days: 90,
      traffic_observed_functions: 18,
      zero_traffic_observed: 94,
      deployment_version_drift_functions: 96,
      known_function_requests: 26481,
      unattributed_requests: 0,
      cutover_blocking_source_contracts: 17,
      evidence_digest: "eade0ef6ae4fbd34009a481ddf5771c3338de7034f6fcaff4dfbb3b453a00d51",
      deployment_digest: "f7ef842b42a08fccca969c4dc1e212ebe764f0ffe7c3c8a3c30df11934842981",
      summary_digest: "523345dd3bf22ec87cedf9a31a1c25aa5647f61db74a192d7fc826643dfba208",
      window_digest: "36d79314958f9c56dd88a6bf81a0ddb89b6e0bfacb5637b27c72cfbb52699fe5",
    });
    expect(canonicalTrafficEvidence.deployment_capture).toMatchObject({
      version_delta_histogram: { 0: 16, 40: 96 },
      version_delta_digest_algorithm: "sha256_of_sorted_delta_count_lines_v1",
      version_delta_digest:
        "7f4d4af8fb38ece4c5ba58e02a1a204616933db08dc05c9762c05403acead7d7",
    });
  });

  it("independently rejects a consistent manifest, bundle, and traffic slug substitution", () => {
    const manifest = structuredClone(canonicalManifest);
    const bundle = structuredClone(canonicalBundleEvidence);
    const traffic = structuredClone(canonicalTrafficEvidence);
    const originalSlug = manifest.functions[0].source.slug;
    const replacementSlug = "a-consistent-substitution";
    manifest.functions[0].source.slug = replacementSlug;
    manifest.functions.sort((left: any, right: any) =>
      left.source.slug.localeCompare(right.source.slug)
    );
    manifest.inventory_digests.active_functions = sha256(
      `${manifest.functions
        .map((entry: any) => `${entry.source.slug}:${entry.source.function_id}`)
        .sort()
        .join("\n")}\n`
    );
    bundle.entries.find((entry: any) => entry.slug === originalSlug).slug =
      replacementSlug;
    bundle.entries.sort((left: any, right: any) => left.slug.localeCompare(right.slug));
    bundle.evidence_digest.digest = digestBundleEvidenceEntries(bundle.entries);
    manifest.live_function_bundle_evidence.evidence_digest =
      bundle.evidence_digest.digest;
    traffic.entries.find((entry: any) => entry.slug === originalSlug).slug =
      replacementSlug;
    traffic.entries.sort((left: any, right: any) => left.slug.localeCompare(right.slug));
    traffic.manifest_binding.active_function_inventory_digest =
      manifest.inventory_digests.active_functions;
    traffic.manifest_binding.live_bundle_evidence_digest =
      bundle.evidence_digest.digest;
    traffic.evidence_digest.digest = digestTrafficEvidence(traffic);

    const upstream = validateFunctionTrafficUpstream(manifest, bundle);
    const result = validateFunctionTrafficEvidence(manifest, bundle, traffic);
    expect(upstream.valid).toBe(false);
    expect(upstream.errors.join("\n")).toContain(
      "frozen active-function inventory digest is invalid"
    );
    expect(upstream.errors.join("\n")).toContain(
      "frozen live bundle evidence digest is invalid"
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a paired artifact and manifest deployment-digest mutation", () => {
    const manifest = structuredClone(canonicalManifest);
    const traffic = structuredClone(canonicalTrafficEvidence);
    traffic.deployment_capture.updated_at_digest = "0".repeat(64);
    traffic.evidence_digest.digest = digestTrafficEvidence(traffic);
    manifest.live_function_traffic_evidence.deployment_updated_at_digest =
      traffic.deployment_capture.updated_at_digest;
    manifest.live_function_traffic_evidence.evidence_digest =
      traffic.evidence_digest.digest;

    const result = validateFunctionTrafficEvidence(
      manifest,
      structuredClone(canonicalBundleEvidence),
      traffic
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "does not match the frozen traffic binding"
    );
  });

  it("gives every live-only function a terminal traffic status without inferring unused", () => {
    const liveOnlySlugs = canonicalBundleEvidence.entries
      .filter((entry: { capture_status: string }) => entry.capture_status === "STORE_NOT_FOUND")
      .map((entry: { slug: string }) => entry.slug)
      .sort();
    const trafficBySlug = new Map(
      canonicalTrafficEvidence.entries.map((entry: { slug: string }) => [entry.slug, entry])
    );

    expect(liveOnlySlugs).toHaveLength(16);
    for (const slug of liveOnlySlugs) {
      const entry = trafficBySlug.get(slug) as {
        terminal_traffic_status: string;
        deployment_manifest_match_status: string;
      };
      expect(entry.terminal_traffic_status).toMatch(
        /^(?:TRAFFIC_OBSERVED|ZERO_TRAFFIC_OBSERVED)$/
      );
      expect(entry.terminal_traffic_status).not.toContain("UNUSED");
      expect(entry.deployment_manifest_match_status).toBe("EXACT_MANIFEST_MATCH");
    }
  });

  it("stores only nonzero per-function buckets keyed by global window index", () => {
    for (const entry of canonicalTrafficEvidence.entries) {
      let previousWindowIndex = -1;
      for (const bucket of entry.nonzero_utc_buckets) {
        expect(bucket.request_count).toBeGreaterThan(0);
        expect(bucket.window_index).toBeGreaterThan(previousWindowIndex);
        expect(bucket.window_index).toBeLessThan(30);
        previousWindowIndex = bucket.window_index;
      }
      if (entry.terminal_traffic_status === "ZERO_TRAFFIC_OBSERVED") {
        expect(entry.nonzero_utc_buckets).toEqual([]);
      }
    }
    expect(
      canonicalTrafficEvidence.entries.every(
        (entry: Record<string, unknown>) => !("utc_buckets" in entry)
      )
    ).toBe(true);
  });

  it("rejects an unknown slug even when the entry count remains 112", () => {
    const evidence = structuredClone(canonicalTrafficEvidence);
    evidence.entries[0].slug = "unknown-live-function";

    expect(errorsFor(evidence)).toContain("contains an unknown or missing slug");
  });

  it("rejects sensitive or raw provider fields", () => {
    const evidence = structuredClone(canonicalTrafficEvidence);
    evidence.entries[0].request_headers = { authorization: "redacted" };

    const errors = errorsFor(evidence);
    expect(errors).toContain("prohibited sensitive field");
    expect(errors).toContain("non-allowlisted or missing field");
  });

  it("rejects UNUSED inference for a zero-traffic slug", () => {
    const evidence = structuredClone(canonicalTrafficEvidence);
    const entry = evidence.entries.find(
      (candidate: { request_count: number }) => candidate.request_count === 0
    );
    entry.terminal_traffic_status = "UNUSED";

    const errors = errorsFor(evidence);
    expect(errors).toContain("invalid terminal traffic status");
    expect(errors).toContain("must never infer UNUSED");
  });

  it("keeps live-only source reconstruction cutover-blocking", () => {
    const evidence = structuredClone(canonicalTrafficEvidence);
    const entry = evidence.entries.find((candidate: { source_reconstruction_status: string }) =>
      candidate.source_reconstruction_status.startsWith("CUTOVER_BLOCKING_")
    );
    entry.source_reconstruction_status = "SOURCE_EVIDENCE_AVAILABLE";

    expect(errorsFor(evidence)).toContain("source reconstruction gate is invalid");
  });

  it("enforces contiguous half-open daily windows and their materialized query hashes", () => {
    const semanticsDrift = structuredClone(canonicalTrafficEvidence);
    semanticsDrift.capture.interval_semantics = "INCLUSIVE_END";
    expect(errorsFor(semanticsDrift)).toContain("capture.interval_semantics is invalid");

    const boundaryDrift = structuredClone(canonicalTrafficEvidence);
    boundaryDrift.windows[1].start_utc = "2026-07-23T17:00:00.000Z";
    const errors = errorsFor(boundaryDrift);
    expect(errors).toContain("not contiguous and exactly 24 hours");
    expect(errors).toContain("source query digest changed");
  });

  it("rejects bucket, window, response-hash, and deployment-drift reconciliation changes", () => {
    const evidence = structuredClone(canonicalTrafficEvidence);
    const entry = evidence.entries.find(
      (candidate: { nonzero_utc_buckets: unknown[] }) =>
        candidate.nonzero_utc_buckets.length > 0
    );
    entry.nonzero_utc_buckets[0].status_class_counts.status_other += 1;
    evidence.windows[0].provider_response_sha256 = "not-a-sha256";
    evidence.entries[0].deployment_manifest_match_status = "EXACT_MANIFEST_MATCH";

    const errors = errorsFor(evidence);
    expect(errors).toContain("does not reconcile to request_count");
    expect(errors).toContain("bucket totals do not match its aggregate");
    expect(errors).toContain("provider response digest is invalid");
    expect(errors).toContain("deployment drift status is invalid");
    expect(errors).toContain("evidence digest does not match");
  });

  it("rejects duplicate sparse window indexes", () => {
    const evidence = structuredClone(canonicalTrafficEvidence);
    const entry = evidence.entries.find(
      (candidate: { nonzero_utc_buckets: unknown[] }) =>
        candidate.nonzero_utc_buckets.length > 0
    );
    entry.nonzero_utc_buckets.splice(
      1,
      0,
      structuredClone(entry.nonzero_utc_buckets[0])
    );

    expect(errorsFor(evidence)).toContain(
      "nonzero buckets must have unique ascending window indexes"
    );
  });
});
