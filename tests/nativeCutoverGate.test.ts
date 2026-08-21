import { describe, expect, it } from "vitest";

import {
  assertNativeCutoverReady,
  loadNativeCutoverContract,
  validateNativeCutoverContract,
} from "../scripts/migration/check-native-cutover-gate.mjs";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readyContract() {
  const contract = clone(loadNativeCutoverContract());
  contract.overall_state = "READY_FOR_SUPABASE_DELETION";
  contract.blockers = [];
  for (const client of contract.clients) {
    client.last_supabase_capable_build = 11;
    client.last_supabase_capable_build_state = "STORE_CONSOLE_ATTESTED";
    client.replacement = {
      source_state: "GCP_ONLY_SOURCE_VERIFIED",
      identifier: client.legacy_identifier,
      minimum_supported_build: client.last_supabase_capable_build + 1,
      store_state: "PRODUCTION_AVAILABLE",
      store_rollout_percent: 100,
      artifact_sha256: "a".repeat(64),
      store_evidence_sha256: "b".repeat(64),
      minimum_version_gate_proof_sha256: "c".repeat(64),
      forced_upgrade_e2e_proof_sha256: "d".repeat(64),
      network_trace_sha256: "e".repeat(64),
      supabase_network_requests: 0,
    };
  }
  return contract;
}

describe("native Supabase cutover gate", () => {
  it("validates the checked-in fail-closed contract", () => {
    expect(validateNativeCutoverContract(loadNativeCutoverContract())).toEqual([]);
  });

  it("blocks deletion while replacement builds are absent", () => {
    expect(assertNativeCutoverReady(loadNativeCutoverContract())).toContain(
      "native cutover is not READY_FOR_SUPABASE_DELETION",
    );
  });

  it("requires both exact legacy application identities", () => {
    const contract = clone(loadNativeCutoverContract());
    contract.clients[0].replacement.identifier = "com.hushh.app";
    expect(validateNativeCutoverContract(contract)).toContain(
      "clients.ios.replacement.identifier mismatch",
    );
  });

  it("does not accept the separate Hussh One native app as a replacement", () => {
    const contract = clone(loadNativeCutoverContract());
    contract.separate_native_product.relationship = "REPLACEMENT_BUILD";
    expect(validateNativeCutoverContract(contract)).toContain(
      "separate native product must not satisfy the Hushh Tech replacement gate",
    );
  });

  it("requires a minimum build above the last Supabase-capable build", () => {
    const contract = readyContract();
    contract.clients[0].replacement.minimum_supported_build = 11;
    expect(assertNativeCutoverReady(contract)).toContain(
      "clients.ios.replacement.minimum_supported_build must exceed the last Supabase-capable build",
    );
  });

  it("requires the highest legacy store build to be attested", () => {
    const contract = readyContract();
    contract.clients[0].last_supabase_capable_build_state = "SOURCE_ONLY_BLOCKING";
    expect(assertNativeCutoverReady(contract)).toContain(
      "clients.ios.last_supabase_capable_build_state must be STORE_CONSOLE_ATTESTED",
    );
  });

  it("rejects a store-attested build below the tracked source floor", () => {
    const contract = readyContract();
    contract.clients[0].last_supabase_capable_build = 10;
    contract.clients[0].replacement.minimum_supported_build = 11;
    expect(assertNativeCutoverReady(contract)).toContain(
      "clients.ios.last_supabase_capable_build must be at least tracked source build 11",
    );
  });

  it("locks the source commits and platform build facts", () => {
    const contract = clone(loadNativeCutoverContract());
    contract.legacy_source_removal.last_source_commit = "f".repeat(40);
    contract.clients[0].last_tracked_project_build = 5;
    contract.clients[0].last_tracked_info_plist_build = 11;
    expect(validateNativeCutoverContract(contract)).toEqual(
      expect.arrayContaining([
        "legacy_source_removal.last_source_commit mismatch",
        "clients.ios.last_tracked_project_build mismatch",
        "clients.ios.last_tracked_info_plist_build mismatch",
      ]),
    );
  });

  it("requires exact store record identifiers", () => {
    const contract = clone(loadNativeCutoverContract());
    contract.clients[1].store_record_id = "com.hussh.app";
    expect(validateNativeCutoverContract(contract)).toContain(
      "clients.android.store_record_id mismatch",
    );
  });

  it("requires full store rollout and zero Supabase requests", () => {
    const contract = readyContract();
    contract.clients[1].replacement.store_rollout_percent = 99;
    contract.clients[1].replacement.supabase_network_requests = 1;
    expect(assertNativeCutoverReady(contract)).toEqual(
      expect.arrayContaining([
        "clients.android.replacement.store_rollout_percent must be 100",
        "clients.android.replacement.supabase_network_requests must be 0",
      ]),
    );
  });

  it("requires artifact, store, minimum-version, forced-upgrade, and network evidence", () => {
    const contract = readyContract();
    contract.clients[0].replacement.forced_upgrade_e2e_proof_sha256 = null;
    contract.clients[0].replacement.network_trace_sha256 = null;
    expect(assertNativeCutoverReady(contract)).toEqual(
      expect.arrayContaining([
        "clients.ios.replacement.forced_upgrade_e2e_proof_sha256 must be a lowercase SHA-256 digest",
        "clients.ios.replacement.network_trace_sha256 must be a lowercase SHA-256 digest",
      ]),
    );
  });

  it("does not accept caller-supplied proof hashes as live evidence", () => {
    expect(assertNativeCutoverReady(readyContract())).toContain(
      "live native store and network attestation executor is not implemented",
    );
  });
});
