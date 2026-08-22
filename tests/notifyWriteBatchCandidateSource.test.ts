import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("default-off notification and write candidate source pins", () => {
  it("binds every candidate to checked-in source, live v2 metadata, deployment, and terminal evidence", async () => {
    const matrix = JSON.parse(
      await readFile(
        new URL(
          "../cloud-run/hushh-tech-app-services/registry/candidates.notify-write-batch.v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const liveV2Bytes = await readFile(
      new URL("../migration/evidence/supabase-current-live-function-bundles.v2.json", import.meta.url),
    );
    const trafficBytes = await readFile(
      new URL("../migration/evidence/supabase-function-traffic-30d.v1.json", import.meta.url),
    );
    const terminalBytes = await readFile(
      new URL("../migration/evidence/edge-function-terminal-matrix.v1.json", import.meta.url),
    );
    const liveV2 = JSON.parse(liveV2Bytes.toString("utf8"));
    const traffic = JSON.parse(trafficBytes.toString("utf8"));
    const terminal = JSON.parse(terminalBytes.toString("utf8"));
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

    expect(matrix.source_approval).toMatchObject({
      status: "BLOCKED",
      metadata_end_check_passed: false,
      source_evidence_file_sha256: digest(liveV2Bytes),
      source_evidence_digest: liveV2.evidence_digest.digest,
      canonical_source_tree_digest: liveV2.canonical_source_tree.digest,
      current_metadata_digest: liveV2.current_metadata_digest.digest,
      traffic_evidence_file_sha256: digest(trafficBytes),
      traffic_evidence_digest: traffic.evidence_digest.digest,
      deployment_inventory_digest: traffic.deployment_capture.normalized_digest,
      terminal_matrix_file_sha256: digest(terminalBytes),
      terminal_matrix_evidence_digest: terminal.evidence_digest,
    });
    expect(matrix.durable_operation_ledger).toMatchObject({
      status: "NOT_LIVE_PROVEN",
      required_durability: "cloud_sql_leased_fenced_operation_key_v2",
      required_header: "Idempotency-Key",
      operation_lease_duration_ms: 30_000,
      delivery_lease_duration_ms: 30_000,
      payload_conflict_contract: "same_operation_key_different_payload_rejected_in_every_state",
      blocker: "DURABLE_OPERATION_LEDGER_CLOUD_SQL_LIVE_PROOF_MISSING",
    });

    expect(matrix.functions).toHaveLength(8);
    for (const row of matrix.functions) {
      const source = await readFile(
        new URL(`../supabase/functions/${row.slug}/index.ts`, import.meta.url),
      );
      expect(createHash("sha256").update(source).digest("hex")).toBe(
        row.source_sha256,
      );
      const live = liveV2.entries.find(({ slug }: { slug: string }) => slug === row.slug);
      const terminalRow = terminal.entries.find(({ slug }: { slug: string }) => slug === row.slug);
      expect(live).toMatchObject({
        function_id: row.function_id,
        manifest_version: row.manifest_version,
        current_version: row.source_version,
        verify_jwt: row.verify_jwt,
        bundle_evidence: { canonical_digest: row.live_bundle_sha256 },
      });
      expect(terminalRow.source.deployment_binding_sha256).toBe(
        row.deployment_binding_sha256,
      );
      expect(row.blockers).toEqual(terminalRow.blockers);
      expect(row.blockers).toHaveLength(6);
      expect(row.candidate_activation_blockers).toContain(
        "DURABLE_OPERATION_LEDGER_CLOUD_SQL_LIVE_PROOF_MISSING",
      );
    }
  });
});
