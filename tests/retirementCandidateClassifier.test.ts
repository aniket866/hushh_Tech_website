import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTRACT,
  buildPinnedCallerGraph,
  classifyCandidateEntry,
  deriveGlobalEvidenceBlockers,
  loadPinnedInputs,
  runPinnedClassifier,
  verifyPinnedCallerGraph,
  verifyPinnedBytes,
} from "../scripts/gcp/migration/retirement-candidate-classifier.mjs";

const root = process.cwd();

function candidateFixture() {
  return {
    registryEntry: {
      source: { slug: "candidate-function", version: 7 },
      migration_state: "INVENTORY_FROZEN",
    },
    currentEntry: {
      slug: "candidate-function",
      capture_status: "EXTRACTED",
      current_version: 7,
      manifest_version: 7,
    },
    trafficEntry: {
      slug: "candidate-function",
      terminal_traffic_status: "ZERO_TRAFFIC_OBSERVED",
      deployment_manifest_match_status: "EXACT_MANIFEST_MATCH",
      request_count: 0,
      nonzero_utc_buckets: [],
    },
    callerEntry: {
      slug: "candidate-function",
      reachable_callers: [],
      unresolved_dynamic_callers: [],
      resolution_status: "COMPLETE",
      surface_flags: { webhook: false, schedule: false, admin: false },
      surface_analysis_status: "COMPLETE",
      side_effect_status: "NONE",
      side_effects: [],
    },
    globalBlockers: [] as string[],
  };
}

function stableCurrentEvidence() {
  return {
    cutover_assessment: {
      status: "CUTOVER_READY_EXACT",
      metadata_end_check_status: "PASSED_EXACT",
      bundle_to_metadata_version_binding_status: "PROVEN_EXACT",
      source_revision_status: "PROVEN",
      source_revision: "a".repeat(40),
    },
  };
}

function freshTrafficEvidence() {
  return {
    capture: { window_end_utc: "2026-08-21T16:00:00.000Z" },
    unattributed_traffic_status: "ZERO_UNATTRIBUTED_TRAFFIC_OBSERVED",
  };
}

describe("retirement candidate decision contract", () => {
  it("marks active traffic must-port even when other evidence is uncertain", () => {
    const fixture = candidateFixture();
    fixture.trafficEntry.request_count = 3;
    fixture.trafficEntry.terminal_traffic_status = "TRAFFIC_OBSERVED";
    fixture.globalBlockers = [
      "SOURCE_CAPTURE_NOT_STABLE",
      "CALLER_GRAPH_GLOBAL_INCOMPLETE",
    ];

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "MUST_PORT",
      reason_codes: ["ACTIVE_30_DAY_TRAFFIC"],
      retirement_authorized: false,
    });
  });

  it("marks any reachable caller must-port", () => {
    const fixture = candidateFixture();
    fixture.callerEntry.reachable_callers = [
      { path: "src/runtime.ts", line: 12, kind: "STATIC_FUNCTION_ROUTE" },
    ];
    fixture.globalBlockers = ["SOURCE_CAPTURE_NOT_STABLE"];

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "MUST_PORT",
      reason_codes: ["REACHABLE_CALLER_PRESENT"],
      retirement_authorized: false,
    });
  });

  it("blocks a hidden or dynamic caller instead of treating it as zero callers", () => {
    const fixture = candidateFixture();
    fixture.callerEntry.resolution_status = "INCOMPLETE_DYNAMIC_CALLERS";
    fixture.callerEntry.unresolved_dynamic_callers = [
      {
        path: "src/dynamic.ts",
        line: 4,
        kind: "DYNAMIC_FUNCTION_ROUTE",
        expression_sha256: "b".repeat(64),
      },
    ];

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "BLOCKED",
      reason_codes: expect.arrayContaining([
        "CALLER_GRAPH_INCOMPLETE",
        "DYNAMIC_CALLER_UNRESOLVED",
      ]),
    });
  });

  it("blocks a stale 30-day traffic window", () => {
    const trafficEvidence = freshTrafficEvidence();
    trafficEvidence.capture.window_end_utc = "2026-08-19T16:00:00.000Z";
    const blockers = deriveGlobalEvidenceBlockers({
      currentEvidence: stableCurrentEvidence(),
      trafficEvidence,
      currentValidation: { valid: true },
      trafficValidation: { valid: true },
    });
    const fixture = candidateFixture();
    fixture.globalBlockers = blockers;

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "BLOCKED",
      reason_codes: expect.arrayContaining(["TRAFFIC_WINDOW_STALE_OR_FUTURE"]),
    });
  });

  it.each([
    ["webhook", "WEBHOOK_SURFACE_PRESENT"],
    ["schedule", "SCHEDULE_SURFACE_PRESENT"],
    ["admin", "ADMIN_SURFACE_PRESENT"],
  ] as const)("blocks a %s surface", (surface, blocker) => {
    const fixture = candidateFixture();
    fixture.callerEntry.surface_flags[surface] = true;

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "BLOCKED",
      reason_codes: expect.arrayContaining([blocker]),
    });
  });

  it("blocks a function with side effects", () => {
    const fixture = candidateFixture();
    fixture.callerEntry.side_effect_status = "PRESENT";
    fixture.callerEntry.side_effects = ["database_write"];

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "BLOCKED",
      reason_codes: expect.arrayContaining([
        "SIDE_EFFECT_PRESENT",
        "SIDE_EFFECT_STATUS_NOT_NONE",
      ]),
    });
  });

  it("blocks current-v2 source version drift", () => {
    const fixture = candidateFixture();
    fixture.currentEntry.current_version = 8;

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "BLOCKED",
      reason_codes: expect.arrayContaining(["CURRENT_SOURCE_VERSION_DRIFT"]),
    });
  });

  it("rejects forged zero-traffic evidence through the exact raw input pin", () => {
    const inputBytes = loadPinnedInputs(root);
    const forged = JSON.parse(inputBytes.traffic.toString("utf8"));
    const active = forged.entries.find(
      (entry: { request_count: number }) => entry.request_count > 0,
    );
    active.request_count = 0;
    active.terminal_traffic_status = "ZERO_TRAFFIC_OBSERVED";

    expect(() =>
      verifyPinnedBytes({
        ...inputBytes,
        traffic: Buffer.from(`${JSON.stringify(forged)}\n`, "utf8"),
      }),
    ).toThrow(/traffic digest mismatch/);
  });

  it("rejects a forged caller graph even when the attacker preserves its declared digest", () => {
    const inputBytes = loadPinnedInputs(root);
    const caller = buildPinnedCallerGraph({
      root,
      policy: JSON.parse(inputBytes.runtime_policy.toString("utf8")),
      registryEntries: JSON.parse(inputBytes.manifest.toString("utf8"))
        .functions,
    });
    caller.graph.entries[0].reachable_callers.push({
      path: "src/hidden.ts",
      line: 1,
      kind: "STATIC_FUNCTION_ROUTE",
    });

    expect(() => verifyPinnedCallerGraph(caller)).toThrow(
      /caller graph digest mismatch/,
    );
  });

  it("fails closed when evidence completeness is uncertain", () => {
    const fixture = candidateFixture();
    fixture.callerEntry.surface_analysis_status =
      "INCOMPLETE_NO_NEGATIVE_PROOF";
    fixture.callerEntry.side_effect_status =
      "UNKNOWN_NO_AUTHORITATIVE_SEMANTIC_EVIDENCE";
    fixture.currentEntry.capture_status = "BUNDLE_RETRIEVAL_FAILED";
    delete (
      fixture.callerEntry.surface_flags as Partial<
        typeof fixture.callerEntry.surface_flags
      >
    ).admin;

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "BLOCKED",
      reason_codes: expect.arrayContaining([
        "CURRENT_SOURCE_CAPTURE_INCOMPLETE",
        "ADMIN_ABSENCE_NOT_PROVEN",
        "SIDE_EFFECT_STATUS_NOT_NONE",
        "SURFACE_ANALYSIS_INCOMPLETE",
      ]),
    });
  });

  it("only emits review eligibility and keeps both human approvals outstanding", () => {
    expect(classifyCandidateEntry(candidateFixture())).toEqual({
      slug: "candidate-function",
      classification: "ELIGIBLE_FOR_OWNER_AND_LEGAL_REVIEW",
      reason_codes: [],
      traffic_request_count: 0,
      reachable_callers: [],
      approvals: {
        owner: "REQUIRED_NOT_GRANTED",
        legal: "REQUIRED_NOT_GRANTED",
      },
      retirement_authorized: false,
    });
  });
});

describe("pinned default-off execution", () => {
  it("does nothing unless the machine evaluation flag is explicit", () => {
    const output = execFileSync(
      process.execPath,
      [
        path.join(
          root,
          "scripts/gcp/migration/retirement-candidate-classifier.mjs",
        ),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      schema_version: 1,
      classifier_id: CONTRACT.classifier_id,
      state: "DISABLED_BY_DEFAULT",
      required_flag: "--machine-evaluate",
      serving_registry_mutated: false,
      retirement_authorized: false,
    });
  });

  it("classifies all 112 pinned functions without making anything retirement-eligible", () => {
    const result = runPinnedClassifier(root);

    expect(result.base_commit).toBe(CONTRACT.base_commit);
    expect(result.counts.MUST_PORT + result.counts.BLOCKED).toBe(112);
    expect(result.counts.MUST_PORT).toBeGreaterThanOrEqual(18);
    expect(result.counts.ELIGIBLE_FOR_OWNER_AND_LEGAL_REVIEW).toBe(0);
    expect(result.global_blockers).toEqual(
      expect.arrayContaining([
        "CALLER_GRAPH_GLOBAL_INCOMPLETE",
        "SOURCE_CAPTURE_NOT_STABLE",
        "SOURCE_END_METADATA_CHECK_NOT_PASSED",
      ]),
    );
    expect(result).toMatchObject({
      state: "EVALUATED_NO_ACTION",
      owner_approval_required: true,
      legal_approval_required: true,
      serving_registry_mutated: false,
      retirement_authorized: false,
      provider_calls_performed: 0,
      files_written: 0,
    });
  });
});
