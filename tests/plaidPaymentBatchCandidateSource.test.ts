import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const repoFile = (path: string) => new URL(`../${path}`, import.meta.url);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("default-off Plaid and payment candidate source evidence", () => {
  it("binds all eight candidates to checked-in source, current-v2, traffic, and terminal evidence", async () => {
    const matrixBytes = await readFile(
      repoFile(
        "cloud-run/hushh-tech-app-services/registry/candidates.plaid-payment-batch.v1.json",
      ),
    );
    const matrix = JSON.parse(matrixBytes.toString("utf8"));
    const liveV2Bytes = await readFile(
      repoFile("migration/evidence/supabase-current-live-function-bundles.v2.json"),
    );
    const trafficBytes = await readFile(
      repoFile("migration/evidence/supabase-function-traffic-30d.v1.json"),
    );
    const terminalBytes = await readFile(
      repoFile("migration/evidence/edge-function-terminal-matrix.v1.json"),
    );
    const liveV2 = JSON.parse(liveV2Bytes.toString("utf8"));
    const traffic = JSON.parse(trafficBytes.toString("utf8"));
    const terminal = JSON.parse(terminalBytes.toString("utf8"));

    expect(matrix).toMatchObject({
      schema_version: 2,
      base_commit: "95a88840d7f575e9852e89051e5b34f3f689a39f",
      deployment_state: "DEFAULT_OFF",
      required_registry_state: "INVENTORY_FROZEN",
      source_approval: {
        status: "BLOCKED",
        metadata_end_check_passed: false,
        detached_approval_status: "MISSING",
        end_metadata_artifact_status: "MISSING",
        checked_in_approval_artifact: "forbidden",
        source_evidence_file_sha256: digest(liveV2Bytes),
        source_evidence_digest: liveV2.evidence_digest.digest,
        canonical_source_tree_digest: liveV2.canonical_source_tree.digest,
        current_metadata_digest: liveV2.current_metadata_digest.digest,
        traffic_evidence_file_sha256: digest(trafficBytes),
        traffic_evidence_digest: traffic.evidence_digest.digest,
        deployment_inventory_digest: traffic.deployment_capture.normalized_digest,
        terminal_matrix_file_sha256: digest(terminalBytes),
        terminal_matrix_evidence_digest: terminal.evidence_digest,
      },
      raw_signature_contract: {
        slug: "plaid-data-webhook",
        required_header: "plaid-verification",
        detached_implementation:
          "cloud-run/hushh-tech-app-services/src/handlers/plaid-payment-batch.js#verifyPlaidWebhookSignature",
        query_secret: "forbidden",
        body_secret: "forbidden",
        raw_body_reconstruction: "forbidden",
        status: "NOT_LIVE_PROVEN",
      },
      durable_operation_ledger: {
        status: "NOT_LIVE_PROVEN",
        required_durability: "cloud_sql_serializable_fenced_operation_v1",
        transaction_durability: "cloud_sql_serializable_transaction_v1",
        result_protection: "cloud_kms_envelope_v1",
        raw_payload_storage: "forbidden",
        raw_credential_storage: "forbidden",
        blocker: "DURABLE_OPERATION_LEDGER_CLOUD_SQL_LIVE_PROOF_MISSING",
      },
    });

    expect(matrix.functions).toHaveLength(8);
    expect(matrix.functions.map(({ slug }: { slug: string }) => slug).sort()).toEqual([
      "create-link-token",
      "exchange-public-token",
      "fund-coupon-redeem",
      "fund-payment-request-create",
      "fund-payment-status",
      "plaid-data-sync-start",
      "plaid-data-webhook",
      "plaid-diagnostics-log",
    ]);

    for (const row of matrix.functions) {
      const source = await readFile(repoFile(row.source_path));
      expect(digest(source)).toBe(row.source_sha256);

      const live = liveV2.entries.find(({ slug }: { slug: string }) => slug === row.slug);
      const trafficRow = traffic.entries.find(
        ({ slug }: { slug: string }) => slug === row.slug,
      );
      const terminalRow = terminal.entries.find(
        ({ slug }: { slug: string }) => slug === row.slug,
      );
      expect(live).toMatchObject({
        function_id: row.function_id,
        manifest_version: row.manifest_version,
        current_version: row.source_version,
        verify_jwt: row.verify_jwt,
        bundle_evidence: { canonical_digest: row.live_bundle_sha256 },
      });
      expect(trafficRow).toMatchObject({
        request_count: row.traffic_30d.request_count,
        deployment_binding_sha256: row.deployment_binding_sha256,
        status_class_counts: {
          status_2xx: row.traffic_30d.status_2xx,
          status_4xx: row.traffic_30d.status_4xx,
        },
        method_counts: {
          OPTIONS: row.traffic_30d.options,
          POST: row.traffic_30d.post,
        },
        auth_marker_counts: {
          authorization_jwt_marker_present: row.traffic_30d.jwt_present,
        },
      });
      expect(terminalRow.source.deployment_binding_sha256).toBe(
        row.deployment_binding_sha256,
      );
      expect(row.blockers.slice(0, 6)).toEqual(terminalRow.blockers);
      expect(row.blockers[6].code).toBe("DETACHED_CANDIDATE_APPROVAL_MISSING");
      expect(row.blockers.at(-1).code).toBe(
        "DOMAIN_OPERATION_ADAPTER_NOT_RUNTIME_WIRED",
      );
      expect(row.method).toBe("POST");
      expect(row.media_type).toBe("application/json");
      expect(row.cache_policy).toBe("private, no-store");
      expect(row.cors_policy).toBe(
        row.slug === "plaid-data-webhook" ? "forbidden" : "same-origin allowlist",
      );
      expect(terminalRow.target.contract_digest).toBeNull();
      expect(terminalRow.target.live_evidence_digest).toBeNull();
    }

    expect(
      matrix.functions.reduce(
        (total: number, row: { traffic_30d: { request_count: number } }) =>
          total + row.traffic_30d.request_count,
        0,
      ),
    ).toBe(758);
  });

  it("locks every serving registry and runtime file byte-for-byte", async () => {
    const matrix = JSON.parse(
      await readFile(
        repoFile(
          "cloud-run/hushh-tech-app-services/registry/candidates.plaid-payment-batch.v1.json",
        ),
        "utf8",
      ),
    );
    for (const [path, expected] of Object.entries(matrix.runtime_byte_lock)) {
      expect(digest(await readFile(repoFile(path)))).toBe(expected);
    }

    const runtimeRegistry = JSON.parse(
      await readFile(
        repoFile("cloud-run/hushh-tech-app-services/registry/functions.v1.json"),
        "utf8",
      ),
    );
    for (const row of matrix.functions) {
      const runtimeRow = runtimeRegistry.find(
        ({ slug }: { slug: string }) => slug === row.slug,
      );
      expect(runtimeRow).toMatchObject({
        migration_state: "INVENTORY_FROZEN",
        final_disposition: "PORT_TO_GCP",
      });
      expect(row.target_auth).toBe(runtimeRow.auth_mode);
      expect(row.target_owner_group).toBe(runtimeRow.owner_group);
    }
  });
});
