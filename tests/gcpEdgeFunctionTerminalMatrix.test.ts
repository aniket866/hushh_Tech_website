import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildTerminalMatrix,
  readInputs,
  sha256,
  stableJson,
} from "../scripts/gcp/migration/edge-function-terminal-matrix.mjs";

function inputs() {
  return structuredClone(readInputs());
}

describe("GCP edge-function terminal matrix", () => {
  it("accounts for exactly 112 frozen slugs and fails closed on current drift", () => {
    const matrix = buildTerminalMatrix(inputs());
    expect(matrix.entries).toHaveLength(112);
    expect(new Set(matrix.entries.map(({ slug }) => slug)).size).toBe(112);
    expect(matrix.summary.desired_ported_and_verified).toBe(111);
    expect(matrix.summary.desired_retired).toBe(1);
    expect(matrix.summary.observed).toEqual({
      blocked: 112,
      ported_and_verified: 0,
      retired: 0,
    });
    expect(matrix.summary.all_terminal).toBe(false);
    expect(matrix.summary.blocker_code_counts.SOURCE_VERSION_DRIFT).toBe(96);
    expect(matrix.summary.blocker_code_counts.SOURCE_BUNDLE_UNAVAILABLE).toBe(15);
    expect(matrix.summary.blocker_code_counts.TARGET_CONTRACT_MISSING).toBe(110);
    expect(matrix.summary.blocker_code_counts.UAT_LIVE_TERMINAL_PROOF_MISSING).toBe(2);
  });

  it("binds every required contract surface before a function may be terminal", () => {
    const value = inputs();
    delete value.contracts.entries["get-secrets"].cors;
    expect(() => buildTerminalMatrix(value)).toThrow(/missing or unknown surface/);

    const unknown = inputs();
    unknown.contracts.entries["unknown-function"] = unknown.contracts.entries["get-secrets"];
    expect(() => buildTerminalMatrix(unknown)).toThrow(/unknown slug/);
  });

  it("rejects missing slugs, identity drift, and stale live proof", () => {
    const missing = inputs();
    missing.current.entries.pop();
    expect(() => buildTerminalMatrix(missing)).toThrow(/slug set/);

    const drifted = inputs();
    drifted.registry[0].auth_mode = "none_feature_retired";
    expect(() => buildTerminalMatrix(drifted)).toThrow(/registry drift/);

    const stale = inputs();
    const contract = stale.contracts.entries["get-secrets"];
    stale.live = {
      schema_version: 1,
      target: { project_id: "hushh-tech-uat" },
      entries: [
        {
          slug: "get-secrets",
          contract_digest: "0".repeat(64),
          project_id: "hushh-tech-uat",
          region: "us-central1",
          private_ingress_verified: true,
          public_invoker_absent: true,
          image_digest: `sha256:${"a".repeat(64)}`,
          revision: "revision",
          status_code: 410,
          response_code: "FEATURE_RETIRED",
        },
      ],
    };
    const matrix = buildTerminalMatrix(stale);
    expect(contract.desired_terminal_state).toBe("RETIRED");
    expect(matrix.entries.find(({ slug }) => slug === "get-secrets")?.blockers).toContainEqual({
      code: "UAT_LIVE_TERMINAL_PROOF_MISSING",
      evidence: "incomplete_or_stale",
    });
  });

  it("matches the checked deterministic machine-readable artifact", () => {
    const matrix = buildTerminalMatrix(inputs());
    const artifact = JSON.parse(
      readFileSync("migration/evidence/edge-function-terminal-matrix.v1.json", "utf8"),
    );
    expect(artifact).toEqual(matrix);
    const unsigned = structuredClone(artifact);
    delete unsigned.evidence_digest;
    expect(artifact.evidence_digest).toBe(sha256(stableJson(unsigned)));
  });
});
