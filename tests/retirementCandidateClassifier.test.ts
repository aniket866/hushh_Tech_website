import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTRACT,
  SECURITY_RETIREMENT_410_CONTRACT,
  buildPinnedCallerGraph,
  classifyCandidateEntry,
  deriveGlobalEvidenceBlockers,
  digestExecutableClosureContract,
  loadPinnedInputs,
  runPinnedClassifier,
  verifyExecutableClosure,
  verifyPinnedCallerGraph,
  verifyPinnedBytes,
} from "../scripts/gcp/migration/retirement-candidate-classifier.mjs";

const root = process.cwd();
const classifierRelativePath =
  "scripts/gcp/migration/retirement-candidate-classifier.mjs";

function createClassifierClone() {
  const requestedClone = fs.mkdtempSync(
    path.join(os.tmpdir(), "retirement-classifier-adversarial-"),
  );
  execFileSync("git", [
    "clone",
    "--quiet",
    "--no-hardlinks",
    root,
    requestedClone,
  ]);
  const clone = fs.realpathSync(requestedClone);
  const destination = path.join(clone, classifierRelativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, classifierRelativePath), destination);
  return clone;
}

function runClassifierProcess(
  clone: string,
  args: string[],
  markerPath: string,
) {
  return spawnSync(
    process.execPath,
    [path.join(clone, classifierRelativePath), ...args],
    {
      cwd: clone,
      encoding: "utf8",
      env: {
        ...process.env,
        RETIREMENT_CLASSIFIER_MARKER_PATH: markerPath,
      },
    },
  );
}

function appendExecutionMarker(clone: string, modulePath: string) {
  const markerPath = path.join(clone, "unverified-module-executed.marker");
  fs.appendFileSync(
    path.join(clone, modulePath),
    `\nif (process.env.RETIREMENT_CLASSIFIER_MARKER_PATH) fs.writeFileSync(process.env.RETIREMENT_CLASSIFIER_MARKER_PATH, "executed");\n`,
  );
  return markerPath;
}

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

  it("never treats the exact get-secrets 410 security retirement contract as a generic eligible candidate", () => {
    const fixture = candidateFixture();
    fixture.registryEntry.source.slug = "get-secrets";
    fixture.currentEntry.slug = "get-secrets";
    fixture.trafficEntry.slug = "get-secrets";
    fixture.callerEntry.slug = "get-secrets";
    Object.assign(fixture.registryEntry, {
      owner_group: "security-retirement",
      final_disposition: "RETIRE_WITH_410",
      gcp_owner: "cloud-run:hushh-tech-identity-api",
      auth_mode: "none_feature_retired",
      migration_method: "do_not_port_return_410_feature_retired",
      parity_check: "always_410_feature_retired_with_no_secret_payload",
    });

    expect(classifyCandidateEntry(fixture)).toEqual({
      slug: "get-secrets",
      classification: "BLOCKED",
      reason_codes: ["SECURITY_RETIREMENT_410_TERMINAL_ONLY"],
      traffic_request_count: 0,
      reachable_callers: [],
      approvals: {
        owner: "REQUIRED_NOT_GRANTED",
        legal: "REQUIRED_NOT_GRANTED",
      },
      retirement_authorized: false,
      terminal_contract: {
        slug: "get-secrets",
        owner_group: "security-retirement",
        final_disposition: "RETIRE_WITH_410",
        response_status: 410,
        response_code: "FEATURE_RETIRED",
        secret_payload_allowed: false,
        handling: "EXPLICIT_TERMINAL_APPROVAL_ONLY",
      },
    });
  });

  it("blocks a partial or forged security-retirement marker as a 410 contract mismatch", () => {
    const fixture = candidateFixture();
    fixture.registryEntry.source.slug = "get-secrets";
    fixture.currentEntry.slug = "get-secrets";
    fixture.trafficEntry.slug = "get-secrets";
    fixture.callerEntry.slug = "get-secrets";

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "BLOCKED",
      reason_codes: ["SECURITY_RETIREMENT_410_CONTRACT_MISMATCH"],
      retirement_authorized: false,
    });
  });

  it.each(Object.entries(SECURITY_RETIREMENT_410_CONTRACT))(
    "blocks an isolated %s 410 marker",
    (key, value) => {
      const fixture = candidateFixture();
      if (key === "slug") {
        fixture.registryEntry.source.slug = String(value);
        fixture.currentEntry.slug = String(value);
        fixture.trafficEntry.slug = String(value);
        fixture.callerEntry.slug = String(value);
      } else {
        Object.assign(fixture.registryEntry, { [key]: value });
      }

      expect(classifyCandidateEntry(fixture)).toMatchObject({
        classification: "BLOCKED",
        reason_codes: ["SECURITY_RETIREMENT_410_CONTRACT_MISMATCH"],
        retirement_authorized: false,
      });
    },
  );

  it.each([
    ["response_status", "410"],
    ["response_code", "feature_retired"],
    ["secret_payload_allowed", "false"],
  ])("blocks a type-variant %s 410 marker", (key, value) => {
    const fixture = candidateFixture();
    Object.assign(fixture.registryEntry, { [key]: value });

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "BLOCKED",
      reason_codes: ["SECURITY_RETIREMENT_410_CONTRACT_MISMATCH"],
      retirement_authorized: false,
    });
  });

  it("blocks combined type-variant response-level 410 markers", () => {
    const fixture = candidateFixture();
    Object.assign(fixture.registryEntry, {
      response_status: "410",
      response_code: "feature_retired",
      secret_payload_allowed: "false",
    });

    expect(classifyCandidateEntry(fixture)).toMatchObject({
      classification: "BLOCKED",
      reason_codes: ["SECURITY_RETIREMENT_410_CONTRACT_MISMATCH"],
      retirement_authorized: false,
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

describe("verified executable dependency bootstrap", () => {
  it("has no static executable dependency outside Node built-ins", () => {
    const source = fs.readFileSync(
      path.join(root, classifierRelativePath),
      "utf8",
    );
    const staticImports = [
      ...source.matchAll(/^import .* from "([^"]+)";/gm),
    ].map((match) => match[1]);

    expect(staticImports.length).toBeGreaterThan(0);
    expect(
      staticImports.every((specifier) => specifier.startsWith("node:")),
    ).toBe(true);
    expect(source).not.toMatch(/from "\.\.\/\.\.\/ci\//);
  });

  it.each([
    ["direct", "scripts/ci/check-supabase-retirement-manifest.mjs"],
    [
      "transitive",
      "scripts/ci/generate-supabase-function-traffic-evidence.mjs",
    ],
  ])(
    "never executes a substituted %s module in default-off or machine mode",
    (_kind, modulePath) => {
      const clone = createClassifierClone();
      try {
        const markerPath = appendExecutionMarker(clone, modulePath);

        const disabled = runClassifierProcess(clone, [], markerPath);
        expect(disabled.status).toBe(0);
        expect(JSON.parse(disabled.stdout)).toMatchObject({
          state: "DISABLED_BY_DEFAULT",
          provider_calls_performed: 0,
          files_written: 0,
        });
        expect(fs.existsSync(markerPath)).toBe(false);

        const machine = runClassifierProcess(
          clone,
          ["--machine-evaluate"],
          markerPath,
        );
        expect(machine.status).toBe(1);
        expect(JSON.parse(machine.stdout)).toMatchObject({
          state: "BLOCKED",
          error_code: "PINNED_CLASSIFIER_FAILURE",
          provider_calls_performed: 0,
          files_written: 0,
        });
        expect(fs.existsSync(markerPath)).toBe(false);
      } finally {
        fs.rmSync(clone, { recursive: true, force: true });
      }
    },
  );

  it("rejects missing, extra, symlinked, and root-path-drift closure states", () => {
    const missingClosure = { ...CONTRACT.executable_closure };
    delete missingClosure[
      "scripts/ci/capture-supabase-current-function-bundles.mjs"
    ];
    expect(() =>
      verifyExecutableClosure(root, {
        closure: missingClosure,
        expectedDigest: digestExecutableClosureContract(
          CONTRACT.executable_roots,
          missingClosure,
        ),
      }),
    ).toThrow(/EXECUTABLE_CLOSURE_MODULE_MISSING/);

    const extraPath = "scripts/ci/check-env-contract.mjs";
    const extraBytes = execFileSync(
      "git",
      ["show", `${CONTRACT.base_commit}:${extraPath}`],
      { cwd: root },
    );
    const extraClosure = {
      ...CONTRACT.executable_closure,
      [extraPath]: {
        oid: execFileSync(
          "git",
          ["rev-parse", `${CONTRACT.base_commit}:${extraPath}`],
          { cwd: root, encoding: "utf8" },
        ).trim(),
        sha256: crypto.createHash("sha256").update(extraBytes).digest("hex"),
        dependencies: [],
      },
    };
    expect(() =>
      verifyExecutableClosure(root, {
        closure: extraClosure,
        expectedDigest: digestExecutableClosureContract(
          CONTRACT.executable_roots,
          extraClosure,
        ),
      }),
    ).toThrow(/EXECUTABLE_CLOSURE_MISSING_OR_EXTRA_MODULE/);

    const clone = createClassifierClone();
    const directPath = path.join(
      clone,
      "scripts/ci/check-supabase-retirement-manifest.mjs",
    );
    const directBytes = fs.readFileSync(directPath);
    const rootLink = `${clone}-path-drift`;
    try {
      fs.unlinkSync(directPath);
      expect(() => verifyExecutableClosure(clone)).toThrow(
        /EXECUTABLE_WORKTREE_MODULE_MISSING/,
      );
      fs.writeFileSync(directPath, directBytes);

      const realPath = `${directPath}.real`;
      fs.renameSync(directPath, realPath);
      fs.symlinkSync(path.basename(realPath), directPath);
      expect(() => verifyExecutableClosure(clone)).toThrow(
        /EXECUTABLE_WORKTREE_PATH_OR_SYMLINK_DRIFT/,
      );
      fs.unlinkSync(directPath);
      fs.renameSync(realPath, directPath);

      fs.symlinkSync(clone, rootLink, "dir");
      expect(() => verifyExecutableClosure(rootLink)).toThrow(
        /EXECUTABLE_ROOT_PATH_DRIFT/,
      );
    } finally {
      fs.rmSync(rootLink, { force: true });
      fs.rmSync(clone, { recursive: true, force: true });
    }
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
      provider_calls_performed: 0,
      files_written: 0,
    });
  });

  it("classifies all 112 pinned functions without making anything retirement-eligible", async () => {
    const result = await runPinnedClassifier(root);

    expect(result.base_commit).toBe(CONTRACT.base_commit);
    expect(result.counts).toEqual({
      MUST_PORT: 27,
      BLOCKED: 85,
      ELIGIBLE_FOR_OWNER_AND_LEGAL_REVIEW: 0,
    });
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
      executable_closure: {
        sha256: CONTRACT.executable_closure_sha256,
        pinned_modules: 8,
        evaluated_modules: 8,
        evaluation_source: "VERIFIED_BASE_GIT_OBJECT_DATA_URLS",
      },
    });
  });
});
