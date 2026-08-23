import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const repoFile = (path: string) => new URL(`../${path}`, import.meta.url);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const slugs = [
  "veo-generate-video",
  "kyc-agent-a2a",
  "investor-chat",
  "investor-agent-mcp",
  "hushh-profile-search",
  "hushh-ai-chat",
];

describe("default-off AI runtime candidate source evidence", () => {
  it("binds all six historical, current-v2, deployment, end-metadata, and terminal records", async () => {
    const matrix = JSON.parse(
      await readFile(
        repoFile(
          "cloud-run/hushh-tech-app-services/registry/candidates.ai-runtime-batch.v1.json",
        ),
        "utf8",
      ),
    );
    const historicalBytes = await readFile(
      repoFile("migration/evidence/supabase-live-function-bundles.v1.json"),
    );
    const currentBytes = await readFile(
      repoFile("migration/evidence/supabase-current-live-function-bundles.v2.json"),
    );
    const trafficBytes = await readFile(
      repoFile("migration/evidence/supabase-function-traffic-30d.v1.json"),
    );
    const terminalBytes = await readFile(
      repoFile("migration/evidence/edge-function-terminal-matrix.v1.json"),
    );
    const candidateHandlerBytes = await readFile(
      repoFile(matrix.candidate_implementation.path),
    );
    const historical = JSON.parse(historicalBytes.toString("utf8"));
    const current = JSON.parse(currentBytes.toString("utf8"));
    const traffic = JSON.parse(trafficBytes.toString("utf8"));
    const terminal = JSON.parse(terminalBytes.toString("utf8"));

    expect(matrix).toMatchObject({
      schema_version: 2,
      base_commit: "51a3e6753e0f0194be8d55b68ba2bc99bfdc4bd9",
      deployment_state: "DEFAULT_OFF",
      required_registry_state: "INVENTORY_FROZEN",
      target_project: "hushh-tech-uat",
      target_region: "us-central1",
      source_approval: {
        status: "BLOCKED",
        historical_bundle_file_sha256: digest(historicalBytes),
        current_v2_file_sha256: digest(currentBytes),
        current_v2_evidence_digest: current.evidence_digest.digest,
        canonical_source_tree_digest: current.canonical_source_tree.digest,
        current_metadata_digest: current.current_metadata_digest.digest,
        traffic_file_sha256: digest(trafficBytes),
        traffic_evidence_digest: traffic.evidence_digest.digest,
        deployment_inventory_digest: traffic.deployment_capture.normalized_digest,
        terminal_matrix_file_sha256: digest(terminalBytes),
        terminal_matrix_evidence_digest: terminal.evidence_digest,
        metadata_end_check_status: "NOT_PERFORMED_IN_V2_BLOCKING",
        bundle_to_metadata_binding: "NOT_PROVEN_WITHOUT_END_METADATA_CHECK",
        source_revision_status: "NOT_PROVEN",
        source_revision: null,
      },
      candidate_implementation: {
        bytes: candidateHandlerBytes.length,
        sha256: digest(candidateHandlerBytes),
        runtime_imports: [],
        enabled_by_default: false,
        activation_artifact: "forbidden",
      },
      security_contract: {
        caller_system_roles: "forbidden",
        caller_tool_schemas: "forbidden",
        tool_execution: "disabled_plan_only",
        caller_urls: "forbidden",
        status: "NOT_LIVE_PROVEN",
      },
    });
    expect(matrix.functions.map(({ slug }: { slug: string }) => slug)).toEqual(slugs);
    for (const row of matrix.functions) {
      const historicalRow = historical.entries.find(
        ({ slug }: { slug: string }) => slug === row.slug,
      );
      const currentRow = current.entries.find(
        ({ slug }: { slug: string }) => slug === row.slug,
      );
      const trafficRow = traffic.entries.find(
        ({ slug }: { slug: string }) => slug === row.slug,
      );
      const terminalRow = terminal.entries.find(
        ({ slug }: { slug: string }) => slug === row.slug,
      );
      expect(historicalRow).toMatchObject({
        version: row.current_v2.manifest_version,
        verify_jwt: true,
        bundle_evidence: { canonical_digest: row.source_snapshot.historical_v1_bundle_sha256 },
      });
      expect(currentRow).toMatchObject({
        function_id: row.current_v2.function_id,
        status: "ACTIVE",
        manifest_version: row.current_v2.manifest_version,
        current_version: row.current_v2.current_version,
        version_delta: 43,
        verify_jwt: true,
        bundle_evidence: {
          canonical_digest: row.current_v2.bundle_sha256,
          file_count: row.current_v2.file_count,
          total_bytes: row.current_v2.total_bytes,
        },
      });
      expect(trafficRow).toMatchObject({
        deployment_observed_at_utc_bucket: row.deployment.observed_at,
        deployment_binding_sha256: row.deployment.binding_sha256,
        deployment_manifest_match_status: "CUTOVER_BLOCKING_VERSION_DRIFT",
        terminal_traffic_status: "ZERO_TRAFFIC_OBSERVED",
        request_count: 0,
      });
      expect(terminalRow).toMatchObject({
        auth_mode: row.target.auth,
        owner_group: row.target.owner_group,
        blockers: row.blockers.slice(0, 6),
      });
      expect(row.end_metadata).toEqual({
        status: "NOT_PERFORMED_IN_V2_BLOCKING",
        source_revision: "NOT_PROVEN",
        bundle_binding: "NOT_PROVEN_WITHOUT_END_METADATA_CHECK",
      });
      expect(row.source_contract).toMatchObject({
        evidence_scope: expect.stringContaining("is not asserted"),
        auth: expect.stringContaining("verify_jwt=true"),
        cache: expect.stringMatching(/Cache-Control|cache/i),
        cors: expect.stringContaining("Access-Control-Allow-Origin: *"),
      });
      expect(row.source_contract.methods.length).toBeGreaterThanOrEqual(2);
      expect(row.source_contract.dependencies.length).toBeGreaterThanOrEqual(3);
      expect(row.source_contract.side_effects.length).toBeGreaterThanOrEqual(3);
      expect(row.source_contract.pii.input.length).toBeGreaterThan(0);
      expect(row.source_contract.pii.output.length).toBeGreaterThan(0);
      expect(row.blockers[6].code).toBe("DETACHED_CANDIDATE_APPROVAL_MISSING");
      expect(row.blockers.at(-1).code).toBe(
        "DOMAIN_OPERATION_ADAPTER_NOT_RUNTIME_WIRED",
      );
      if (row.source_snapshot.mode === "CHECKED_IN_AT_BASE") {
        for (const file of row.source_snapshot.files) {
          const source = await readFile(repoFile(file.path));
          expect(source.length).toBe(file.bytes);
          expect(digest(source)).toBe(file.sha256);
        }
      }
    }
  });

  it("pins profile-search Git recovery without claiming current-v2 equivalence", async () => {
    const matrix = JSON.parse(
      await readFile(
        repoFile(
          "cloud-run/hushh-tech-app-services/registry/candidates.ai-runtime-batch.v1.json",
        ),
        "utf8",
      ),
    );
    expect(matrix.source_recovery).toMatchObject({
      slug: "hushh-profile-search",
      mode: "GIT_RECOVERY_PIN_ONLY",
      revision: "cbfde1b1bf5ef97ebb71766953857750b711d791",
      equivalence_to_manifest_6119: "NOT_ASSERTED",
      equivalence_to_current_v2_6162: "NOT_ASSERTED",
      blocker: "RECOVERED_GIT_TREE_NOT_BOUND_TO_CURRENT_V2_BUNDLE",
    });
    expect(matrix.source_recovery.tree_files).toHaveLength(5);
    expect(
      matrix.functions.find(({ slug }: { slug: string }) => slug === "hushh-profile-search"),
    ).toMatchObject({
      source_snapshot: { mode: "GIT_RECOVERY_PIN_ONLY", files: [] },
      source_contract: {
        evidence_scope: expect.stringContaining(
          "cbfde1b1bf5ef97ebb71766953857750b711d791",
        ),
      },
    });
  });

  it("locks all serving registries and runtime files while every slug remains frozen", async () => {
    const matrix = JSON.parse(
      await readFile(
        repoFile(
          "cloud-run/hushh-tech-app-services/registry/candidates.ai-runtime-batch.v1.json",
        ),
        "utf8",
      ),
    );
    for (const [path, expected] of Object.entries(matrix.runtime_byte_lock)) {
      expect(digest(await readFile(repoFile(path)))).toBe(expected);
    }
    const registry = JSON.parse(
      await readFile(
        repoFile("cloud-run/hushh-tech-app-services/registry/functions.v1.json"),
        "utf8",
      ),
    );
    for (const row of matrix.functions) {
      const runtimeRow = registry.find(
        ({ slug }: { slug: string }) => slug === row.slug,
      );
      expect(runtimeRow).toMatchObject({
        migration_state: "INVENTORY_FROZEN",
        final_disposition: "PORT_TO_GCP",
        auth_mode: row.target.auth,
        owner_group: row.target.owner_group,
      });
    }
  });
});
