import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type TerminalEntry = {
  slug: string;
  auth_mode: string;
  desired_terminal_state: string;
  observed_state: string;
  target: {
    project_id: string;
    contract_digest: string | null;
    live_evidence_digest: string | null;
  };
  blockers: Array<{ code: string; evidence: string }>;
};

const matrix = JSON.parse(
  readFileSync(
    new URL("../migration/evidence/edge-function-terminal-matrix.v1.json", import.meta.url),
    "utf8"
  )
) as {
  target: { stage: string; project_id: string };
  entries: TerminalEntry[];
};

const expected = new Map(
  [
    "fund-transfer-sandbox-start",
    "plaid-transfer-sandbox-simulate",
    "plaid-transfer-webhook",
  ].map((slug) => [slug, matrix.entries.find((entry) => entry.slug === slug)])
);

describe("Plaid transfer GCP terminal gate", () => {
  it("binds every transfer surface to the UAT project", () => {
    expect(matrix.target).toEqual({
      stage: "uat",
      project_id: "hushh-tech-uat",
      region: "us-central1",
    });
    expect([...expected.keys()]).toHaveLength(3);
    for (const [slug, entry] of expected) {
      expect(entry, `${slug} missing from the terminal matrix`).toBeDefined();
      expect(entry?.target.project_id).toBe("hushh-tech-uat");
      expect(entry?.desired_terminal_state).toBe("PORTED_AND_VERIFIED");
    }
  });

  it("fails closed until each GCP contract and live UAT proof exists", () => {
    for (const [slug, entry] of expected) {
      expect(entry?.observed_state, `${slug} must not be reported as ported`).toBe("BLOCKED");
      expect(entry?.target.contract_digest, `${slug} has no reviewed GCP contract`).toBeNull();
      expect(entry?.target.live_evidence_digest, `${slug} has no live UAT proof`).toBeNull();
      expect(entry?.blockers.length, `${slug} must retain explicit blockers`).toBeGreaterThan(0);
    }
  });

  it("requires strong caller authentication for the two mutation routes", () => {
    expect(expected.get("fund-transfer-sandbox-start")?.auth_mode).toBe(
      "firebase_bearer_recent_auth_or_google_service_identity"
    );
    expect(expected.get("plaid-transfer-sandbox-simulate")?.auth_mode).toBe(
      "firebase_bearer_recent_auth_or_google_service_identity"
    );
    expect(expected.get("plaid-transfer-webhook")?.auth_mode).toBe(
      "provider_signature_raw_body"
    );
  });
});
