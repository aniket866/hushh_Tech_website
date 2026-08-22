import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildTerminalMatrix,
  readInputs,
  sealEvidenceRecord,
  sha256,
  stableJson,
} from "../scripts/gcp/migration/edge-function-terminal-matrix.mjs";

function inputs() {
  return structuredClone(readInputs());
}

function leafPaths(value: unknown, prefix: Array<string | number> = []) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [prefix];
    return value.flatMap((entry, index) => leafPaths(entry, [...prefix, index]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPaths(entry, [...prefix, key]),
    );
  }
  return [prefix];
}

function mutateAt(root: any, path: Array<string | number>) {
  let parent = root;
  for (const part of path.slice(0, -1)) parent = parent[part];
  const key = path.at(-1)!;
  const value = parent[key];
  parent[key] = Array.isArray(value)
    ? [...value, "adversarial"]
    : typeof value === "boolean"
      ? !value
      : typeof value === "number"
        ? value + 1
        : value === null
          ? "adversarial"
          : `${value}-adversarial`;
}

function resealLive(value: ReturnType<typeof inputs>) {
  value.live.entries = value.live.entries.map(sealEvidenceRecord);
  value.live = sealEvidenceRecord(value.live);
}

describe("GCP edge-function terminal matrix", () => {
  it("accounts for exactly 112 frozen slugs and fails closed on current drift", () => {
    const matrix = buildTerminalMatrix(inputs());
    expect(matrix.entries).toHaveLength(112);
    expect(new Set(matrix.entries.map(({ slug }) => slug)).size).toBe(112);
    expect(matrix.summary.desired_ported_and_verified).toBe(111);
    expect(matrix.summary.desired_retired).toBe(1);
    expect(matrix.summary.observed).toEqual({
      blocked: 110,
      ported_and_verified: 1,
      retired: 1,
    });
    expect(matrix.summary.all_terminal).toBe(false);
    expect(matrix.summary.blocker_code_counts.SOURCE_BUNDLE_UNAVAILABLE).toBe(15);
    expect(matrix.summary.blocker_code_counts.SOURCE_VERSION_DRIFT).toBe(94);
    expect(matrix.summary.blocker_code_counts.TARGET_CONTRACT_MISSING).toBe(108);
    expect(matrix.summary.blocker_code_counts.TARGET_REGISTRY_NOT_ENABLED).toBe(110);
    expect(matrix.summary.blocker_code_counts.UAT_LIVE_TERMINAL_PROOF_MISSING).toBe(2);
    expect(matrix.summary.blocker_code_counts.REAL_ADMIN_FIREBASE_CLAIMS_UNPROVEN).toBe(1);
    const retired = matrix.entries.find(({ slug }) => slug === "get-secrets");
    expect(retired?.observed_state).toBe("RETIRED");
    expect(retired?.target.live_evidence_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts only stable two-boundary source captures bound to repository bytes", () => {
    const matrix = buildTerminalMatrix(inputs());
    const geocode = matrix.entries.find(
      ({ slug }) => slug === "hushh-location-geocode",
    );
    expect(geocode?.source.terminal_capture_status).toBe("PROVEN");
    expect(geocode?.observed_state).toBe("PORTED_AND_VERIFIED");
    expect(geocode?.target.live_evidence_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(geocode?.blockers).toEqual([]);

    const ndaAdmin = matrix.entries.find(
      ({ slug }) => slug === "nda-admin-fetch",
    );
    expect(ndaAdmin?.source.terminal_capture_status).toBe("PROVEN");
    expect(ndaAdmin?.target.live_evidence_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(ndaAdmin?.observed_state).toBe("BLOCKED");
    expect(ndaAdmin?.blockers).toEqual(
      expect.arrayContaining([
        {
          code: "REAL_ADMIN_FIREBASE_CLAIMS_UNPROVEN",
          evidence: "BLOCKED_REAL_ADMIN_FIREBASE_CLAIM_ABSENT",
        },
        { code: "TARGET_REGISTRY_NOT_ENABLED", evidence: "INVENTORY_FROZEN" },
        {
          code: "UAT_LIVE_TERMINAL_PROOF_MISSING",
          evidence: "REAL_ADMIN_FIREBASE_CLAIM_ABSENT",
        },
      ]),
    );

    const metadataDrift = inputs();
    metadataDrift.terminalSource.entries[0].metadata_after.version += 1;
    expect(
      buildTerminalMatrix(metadataDrift).entries.find(
        ({ slug }) => slug === "hushh-location-geocode",
      )?.blockers,
    ).toContainEqual({
      code: "TERMINAL_SOURCE_CAPTURE_INVALID",
      evidence: "incomplete_or_repository_drift",
    });

    const repositoryDrift = inputs();
    repositoryDrift.sourceRepositoryBindings["hushh-location-geocode"] = false;
    expect(
      buildTerminalMatrix(repositoryDrift).entries.find(
        ({ slug }) => slug === "hushh-location-geocode",
      )?.source.terminal_capture_status,
    ).toBe("incomplete_or_repository_drift");
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
    const contract = stale.contracts.entries["hushh-location-geocode"];
    const geocode = stale.live.entries.find(
      ({ slug }) => slug === "hushh-location-geocode",
    );
    geocode.contract_digest = "0".repeat(64);
    stale.live.entries = stale.live.entries.map(sealEvidenceRecord);
    stale.live = sealEvidenceRecord(stale.live);
    const matrix = buildTerminalMatrix(stale);
    expect(contract.desired_terminal_state).toBe("PORTED_AND_VERIFIED");
    expect(
      matrix.entries.find(({ slug }) => slug === "hushh-location-geocode")?.blockers,
    ).toContainEqual(
      expect.objectContaining({ code: "UAT_LIVE_TERMINAL_PROOF_MISSING" }),
    );

    const missingRetirementProof = inputs();
    missingRetirementProof.retirementProof = false;
    expect(
      buildTerminalMatrix(missingRetirementProof).entries.find(
        ({ slug }) => slug === "get-secrets",
      )?.blockers,
    ).toContainEqual({
      code: "RETIREMENT_410_PROOF_MISSING",
      evidence: "runtime_or_test_contract_absent",
    });
  });

  it("rejects self-rehashed semantic mutations across every live attestation leaf", () => {
    const canonical = inputs();
    const geocode = canonical.live.entries.find(
      ({ slug }) => slug === "hushh-location-geocode",
    );
    const nda = canonical.live.entries.find(({ slug }) => slug === "nda-admin-fetch");
    const cases = [
      ...leafPaths(canonical.live.builds).map((path) => ({
        root: ["builds", ...path], slug: "hushh-location-geocode", reason: "IMAGE_SOURCE_BINDING_MISMATCH",
      })),
      ...leafPaths(canonical.live.cleanup).map((path) => ({
        root: ["cleanup", ...path], slug: "hushh-location-geocode", reason: "CLEANUP_ATTESTATION_MISMATCH",
      })),
      ...leafPaths(canonical.live.capture).map((path) => ({
        root: ["capture", ...path], slug: "hushh-location-geocode", reason: "IMAGE_SOURCE_BINDING_MISMATCH",
      })),
      ...leafPaths(geocode.runtime).map((path) => ({
        entry: "hushh-location-geocode", root: ["runtime", ...path], slug: "hushh-location-geocode", reason: "RUNTIME_ATTESTATION_MISMATCH",
      })),
      ...leafPaths(geocode.proof).map((path) => ({
        entry: "hushh-location-geocode", root: ["proof", ...path], slug: "hushh-location-geocode", reason: "FUNCTION_PROOF_MISMATCH",
      })),
      ...leafPaths(nda.proof).map((path) => ({
        entry: "nda-admin-fetch", root: ["proof", ...path], slug: "nda-admin-fetch", reason: "FUNCTION_PROOF_MISMATCH",
      })),
    ];

    for (const item of cases) {
      const changed = structuredClone(canonical);
      const target = item.entry
        ? changed.live.entries.find(({ slug }) => slug === item.entry)
        : changed.live;
      mutateAt(target, item.root);
      resealLive(changed);
      const matrix = buildTerminalMatrix(changed);
      const evidence = matrix.entries
        .find(({ slug }) => slug === item.slug)
        ?.blockers.find(({ code }) => code === "UAT_LIVE_TERMINAL_PROOF_MISSING")
        ?.evidence;
      expect(evidence, JSON.stringify(item.root)).toContain(item.reason);
    }

    for (const field of [
      "contract_digest",
      "source_capture_digest",
      "registry_state",
      "build_ref",
    ]) {
      const changed = structuredClone(canonical);
      const entry = changed.live.entries.find(
        ({ slug }) => slug === "hushh-location-geocode",
      );
      mutateAt(entry, [field]);
      resealLive(changed);
      expect(
        buildTerminalMatrix(changed).entries.find(
          ({ slug }) => slug === "hushh-location-geocode",
        )?.observed_state,
      ).toBe("BLOCKED");
    }
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
